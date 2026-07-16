import { randomInt } from "node:crypto";

import {
  buildExactInSwapTransaction,
  calculateAmountOutMin,
  deadlineFromNow,
  erc20Abi,
  getQuoteAmountOut,
  getSelectedPairExactInQuote,
  lbPairAbi
} from "@robinhood-lb/sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddressEqual,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import type { MarketActivityConfig } from "./config.js";
import {
  adaptAmount,
  assertWithinHardRange,
  chooseOrganicDirection,
  createSeededRandom,
  jitterIntervalMs,
  safeDirectionCandidates,
  sampleTradeAmount,
  type AdaptiveAmountState,
  type RandomSource,
  type RangePolicy,
  type TradeDirection
} from "./policy.js";

const MAX_BACKOFF_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 8_000;
const DEFAULT_HISTORICAL_RANDOM_SEED = 0x5eed_c0de;
const LOCAL_MOCK_MINT_ABI = [{
  type: "function",
  name: "mint",
  stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: []
}] as const;

interface RuntimeClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: PrivateKeyAccount;
}

interface SessionState {
  policy: RangePolicy;
  nextPreferred: TradeDirection;
  random: RandomSource;
  spent: { weth: bigint; usdc: bigint };
  amounts: { weth: AdaptiveAmountState; usdc: AdaptiveAmountState };
  maximumObservedMovement: Record<TradeDirection, number>;
}

export async function startMarketActivity(config: MarketActivityConfig, signal?: AbortSignal): Promise<void> {
  const clients = createClients(config);
  const randomSeed = config.randomSeed ?? randomInt(0, 0x1_0000_0000);
  const state = await prepareSession(config, clients, createSeededRandom(randomSeed));
  log({ event: "market-activity-started", environment: config.environment, pair: config.pool.pair, anchorActiveId: state.policy.anchor, intervalMs: config.intervalMs, randomSeed });

  while (!signal?.aborted) {
    const startedAt = Date.now();
    const executed = await executeNextTrade(config, clients, state);
    if (!executed) {
      log({ event: "market-activity-stopped", reason: "session-budget-exhausted", spentWeth: state.spent.weth, spentUsdc: state.spent.usdc });
      return;
    }
    const delayMs = jitterIntervalMs(config.intervalMs, state.random(), state.random());
    const nextAt = Math.max(Date.now(), startedAt + delayMs);
    log({ event: "market-activity-scheduled", delayMs, nextExecutionTime: new Date(nextAt).toISOString() });
    await abortableDelay(Math.max(0, nextAt - Date.now()), signal);
  }
  log({ event: "market-activity-stopped", reason: "signal" });
}

export async function seedMarketActivity(config: MarketActivityConfig, signal?: AbortSignal): Promise<void> {
  if (config.environment !== "localnet") throw new Error("Historical market seeding is localnet-only");
  const clients = createClients(config);
  const wallClock = Math.floor(Date.now() / 1_000);
  const randomSeed = config.randomSeed ?? DEFAULT_HISTORICAL_RANDOM_SEED;
  const state = await prepareSession(config, clients, createSeededRandom(randomSeed));
  const schedule = buildHistoricalSchedule(wallClock, (randomSeed ^ 0xa11c_e5ed) >>> 0);
  const latest = await clients.publicClient.getBlock({ blockTag: "latest" });
  const latestTimestamp = Number(latest.timestamp);
  if (latestTimestamp > wallClock - 14 * 86_400) {
    throw new Error("Seed mode requires a fresh Anvil chain started approximately 15 days in the past");
  }
  let seeded = 0;
  for (const timestamp of schedule) {
    if (signal?.aborted) break;
    const head = await clients.publicClient.getBlock({ blockTag: "latest" });
    if (timestamp <= Number(head.timestamp)) continue;
    await anvilSetNextBlockTimestamp(config.rpcUrl, timestamp);
    const executed = await executeNextTrade(config, clients, state);
    if (!executed) throw new Error("Historical seed exhausted its configured session budget");
    seeded += 1;
  }
  log({ event: "market-activity-seed-complete", transactions: seeded, throughTimestamp: wallClock, randomSeed });
}

export function buildHistoricalSchedule(nowTimestamp: number, randomSeed = DEFAULT_HISTORICAL_RANDOM_SEED): number[] {
  if (!Number.isSafeInteger(nowTimestamp) || nowTimestamp <= 0) throw new Error("Seed wall-clock timestamp is invalid");
  const random = createSeededRandom(randomSeed);
  const timestamps = new Set<number>();
  const historyStart = nowTimestamp - 15 * 86_400;
  const recentStart = nowTimestamp - 86_400;
  const denseStart = nowTimestamp - 6 * 3_600;
  timestamps.add(historyStart);

  for (let nominal = historyStart + 12 * 3_600; nominal < recentStart; nominal += 12 * 3_600) {
    timestamps.add(clampTimestamp(nominal + symmetricJitter(random, 3 * 3_600), historyStart + 1, recentStart - 1));
  }
  for (let hourStart = recentStart; hourStart < denseStart; hourStart += 3_600) {
    const trades = 1 + Math.floor(random() * 3);
    for (let index = 0; index < trades; index += 1) timestamps.add(hourStart + Math.floor(random() * 3_600));
  }

  const firstDenseMinute = Math.floor(denseStart / 60) * 60;
  const currentMinute = Math.floor(nowTimestamp / 60) * 60;
  for (let minuteStart = firstDenseMinute; minuteStart < currentMinute; minuteStart += 60) {
    timestamps.add(minuteStart + Math.floor(random() * 60));
    if (random() < 0.25) timestamps.add(minuteStart + Math.floor(random() * 60));
  }
  timestamps.add(nowTimestamp);
  return [...timestamps]
    .filter((timestamp) => timestamp >= historyStart && timestamp <= nowTimestamp)
    .sort((left, right) => left - right);
}

async function prepareSession(config: MarketActivityConfig, clients: RuntimeClients, random: RandomSource): Promise<SessionState> {
  const chainId = await clients.publicClient.getChainId();
  if (chainId !== config.registry.chainId) throw new Error(`RPC chain ID ${chainId} does not match manifest ${config.registry.chainId}`);
  await verifyPoolIdentity(config, clients.publicClient);
  const activeId = await readActiveId(config, clients.publicClient);
  let [wethBalance, usdcBalance] = await Promise.all([
    tokenBalance(clients.publicClient, config.weth.address, clients.account.address),
    tokenBalance(clients.publicClient, config.usdc.address, clients.account.address)
  ]);
  if (config.environment === "localnet") {
    await ensureLocalMockBalance(clients, config.weth.address, wethBalance, config.budgets.weth);
    await ensureLocalMockBalance(clients, config.usdc.address, usdcBalance, config.budgets.usdc);
    [wethBalance, usdcBalance] = await Promise.all([
      tokenBalance(clients.publicClient, config.weth.address, clients.account.address),
      tokenBalance(clients.publicClient, config.usdc.address, clients.account.address)
    ]);
  }
  if (wethBalance < config.caps.weth) throw new Error("Market activity account cannot fund the configured maximum WETH input");
  if (usdcBalance < config.caps.usdc) throw new Error("Market activity account cannot fund the configured maximum USDC input");
  await ensureBoundedAllowance(config, clients, config.weth.address, config.budgets.weth);
  await ensureBoundedAllowance(config, clients, config.usdc.address, config.budgets.usdc);
  const policy = { anchor: activeId, hardRadius: config.hardRadius, turnaroundRadius: config.turnaroundRadius };
  assertWithinHardRange(activeId, policy);
  return {
    policy,
    nextPreferred: random() < 0.5 ? "weth-to-usdc" : "usdc-to-weth",
    random,
    spent: { weth: 0n, usdc: 0n },
    maximumObservedMovement: { "weth-to-usdc": 1, "usdc-to-weth": 1 },
    amounts: {
      weth: { amount: config.baseAmounts.weth, baseAmount: config.baseAmounts.weth, cap: config.caps.weth, unchangedTrades: 0 },
      usdc: { amount: config.baseAmounts.usdc, baseAmount: config.baseAmounts.usdc, cap: config.caps.usdc, unchangedTrades: 0 }
    }
  };
}

async function executeNextTrade(config: MarketActivityConfig, clients: RuntimeClients, state: SessionState): Promise<boolean> {
  await withBackoff(() => verifyPoolIdentity(config, clients.publicClient));
  const activeIdBefore = await withBackoff(() => readActiveId(config, clients.publicClient));
  assertWithinHardRange(activeIdBefore, state.policy);
  const candidates = safeDirectionCandidates(activeIdBefore, state.nextPreferred, state.policy, state.maximumObservedMovement);
  let selected: {
    direction: TradeDirection;
    inputKey: "weth" | "usdc";
    amount: bigint;
    quote: Awaited<ReturnType<typeof getSelectedPairExactInQuote>>;
  } | null = null;
  let hasBudget = false;
  for (const direction of candidates) {
    const inputKey = direction === "weth-to-usdc" ? "weth" : "usdc";
    const remainingBudget = config.budgets[inputKey] - state.spent[inputKey];
    if (remainingBudget <= 0n) continue;
    const amount = sampleTradeAmount(
      state.amounts[inputKey].amount,
      config.caps[inputKey],
      remainingBudget,
      state.random(),
      state.random()
    );
    hasBudget = true;
    const tokenIn = direction === "weth-to-usdc" ? config.weth.address : config.usdc.address;
    const tokenOut = direction === "weth-to-usdc" ? config.usdc.address : config.weth.address;
    const available = await withBackoff(() => tokenBalance(clients.publicClient, tokenIn, clients.account.address));
    if (available < amount) throw new Error(`Market activity account cannot fund ${direction} input ${amount}`);
    try {
      const quote = await withBackoff(() => getSelectedPairExactInQuote(clients.publicClient, config.registry, {
        pair: config.pool.pair,
        binStep: BigInt(config.pool.binStep),
        tokenX: config.pool.tokenX,
        tokenY: config.pool.tokenY,
        tokenIn,
        tokenOut,
        amountIn: amount
      }), (error) => !isSelectedPairCapacityError(error));
      selected = { direction, inputKey, amount, quote };
      break;
    } catch (error) {
      if (!isSelectedPairCapacityError(error)) throw error;
      log({ event: "market-activity-direction-fallback", direction, amount, activeId: activeIdBefore, reason: "selected-pair-input-capacity" });
    }
  }
  if (selected === null) {
    if (!hasBudget) return false;
    throw new Error("Selected WETH/USDC pool cannot consume the bounded input in either policy-safe direction");
  }
  const { amount, direction, inputKey, quote } = selected;
  const transaction = buildExactInSwapTransaction(
    config.registry,
    quote,
    amount,
    calculateAmountOutMin(getQuoteAmountOut(quote), config.slippageBps),
    clients.account.address,
    deadlineFromNow(20)
  );
  const hash = await sendPreparedTransaction(clients, transaction);
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Market activity transaction ${hash} failed`);
  const activeIdAfter = await withBackoff(() => readActiveId(config, clients.publicClient));
  assertWithinHardRange(activeIdAfter, state.policy);
  state.spent[inputKey] += amount;
  const binsMoved = Math.abs(activeIdAfter - activeIdBefore);
  state.maximumObservedMovement[direction] = Math.max(state.maximumObservedMovement[direction], binsMoved);
  state.amounts[inputKey] = adaptAmount(state.amounts[inputKey], binsMoved);
  state.nextPreferred = chooseOrganicDirection(activeIdAfter, direction, state.policy, state.random());
  log({
    event: "market-activity-transaction",
    transactionHash: hash,
    direction,
    amount,
    amountOut: getQuoteAmountOut(quote),
    activeIdBefore,
    activeIdAfter,
    nextPreferredDirection: state.nextPreferred,
    hardRange: [state.policy.anchor - state.policy.hardRadius, state.policy.anchor + state.policy.hardRadius],
    receiptStatus: receipt.status,
    blockNumber: receipt.blockNumber
  });
  return true;
}

function symmetricJitter(random: RandomSource, radiusSeconds: number): number {
  return Math.round((random() * 2 - 1) * radiusSeconds);
}

function clampTimestamp(timestamp: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, timestamp));
}

async function verifyPoolIdentity(config: MarketActivityConfig, client: PublicClient): Promise<void> {
  const [factory, tokenX, tokenY, binStep] = await Promise.all([
    client.readContract({ address: config.pool.pair, abi: lbPairAbi, functionName: "getFactory" }),
    client.readContract({ address: config.pool.pair, abi: lbPairAbi, functionName: "getTokenX" }),
    client.readContract({ address: config.pool.pair, abi: lbPairAbi, functionName: "getTokenY" }),
    client.readContract({ address: config.pool.pair, abi: lbPairAbi, functionName: "getBinStep" })
  ]);
  if (!isAddressEqual(factory, config.registry.contracts.lbFactory)) throw new Error("Selected pool factory changed");
  if (!isAddressEqual(tokenX, config.pool.tokenX) || !isAddressEqual(tokenY, config.pool.tokenY)) throw new Error("Selected pool token identity changed");
  if (Number(binStep) !== config.pool.binStep) throw new Error("Selected pool bin step changed");
  if (!isAddressEqual(config.pool.tokenX, config.weth.address) || !isAddressEqual(config.pool.tokenY, config.usdc.address)) {
    throw new Error("Selected pool is not the configured WETH/USDC pool");
  }
}

async function readActiveId(config: MarketActivityConfig, client: PublicClient): Promise<number> {
  return Number(await client.readContract({ address: config.pool.pair, abi: lbPairAbi, functionName: "getActiveId" }));
}

async function tokenBalance(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

async function ensureBoundedAllowance(config: MarketActivityConfig, clients: RuntimeClients, token: Address, allowanceTarget: bigint): Promise<void> {
  const allowance = await clients.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [clients.account.address, config.registry.contracts.lbRouter]
  });
  if (allowance === allowanceTarget) return;
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [config.registry.contracts.lbRouter, allowanceTarget]
  });
  const hash = await sendPreparedTransaction(clients, { to: token, data, value: 0n });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Bounded allowance transaction ${hash} failed`);
  log({ event: "market-activity-allowance", token, allowance: allowanceTarget, transactionHash: hash, receiptStatus: receipt.status });
}

async function ensureLocalMockBalance(clients: RuntimeClients, token: Address, current: bigint, target: bigint): Promise<void> {
  if (current >= target) return;
  const amount = target - current;
  const data = encodeFunctionData({ abi: LOCAL_MOCK_MINT_ABI, functionName: "mint", args: [clients.account.address, amount] });
  const hash = await sendPreparedTransaction(clients, { to: token, data, value: 0n });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Local mock funding transaction ${hash} failed`);
  log({ event: "market-activity-local-funding", token, amount, transactionHash: hash, receiptStatus: receipt.status });
}

async function sendPreparedTransaction(
  clients: RuntimeClients,
  transaction: { to: Address; data: Hex; value: bigint }
): Promise<Hash> {
  const request = { account: clients.account.address, to: transaction.to, data: transaction.data, value: transaction.value } as const;
  const estimate = await clients.publicClient.estimateGas(request);
  const gas = estimate + (estimate * 2_000n + 9_999n) / 10_000n;
  await clients.publicClient.call({ ...request, gas });
  return clients.walletClient.sendTransaction({ ...request, gas, chain: clients.walletClient.chain });
}

function createClients(config: MarketActivityConfig): RuntimeClients {
  const account = privateKeyToAccount(config.privateKey);
  return {
    account,
    publicClient: createPublicClient({ chain: config.registry.chain, transport: http(config.rpcUrl) }),
    walletClient: createWalletClient({ account, chain: config.registry.chain, transport: http(config.rpcUrl) })
  };
}

async function anvilSetNextBlockTimestamp(rpcUrl: string, timestamp: number): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_setNextBlockTimestamp", params: [timestamp] })
  });
  if (!response.ok) throw new Error(`Anvil timestamp RPC returned HTTP ${response.status}`);
  const payload = await response.json() as { error?: { message?: string }; result?: unknown };
  if (payload.error) throw new Error(`Anvil timestamp RPC failed: ${payload.error.message ?? "unknown error"}`);
}

async function withBackoff<T>(operation: () => Promise<T>, shouldRetry: (error: unknown) => boolean = () => true): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_BACKOFF_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === MAX_BACKOFF_ATTEMPTS - 1) break;
      await abortableDelay(Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}

function isSelectedPairCapacityError(error: unknown): boolean {
  return error instanceof Error && /cannot consume the full input amount/i.test(error.message);
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function log(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)}\n`);
}
