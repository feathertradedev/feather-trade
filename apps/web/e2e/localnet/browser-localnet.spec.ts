import { readFileSync } from "node:fs";

import { expect, test, type Page, type Route } from "@playwright/test";
import { createPublicClient, decodeFunctionData, http, type Address, type Hex } from "viem";

import { erc20Abi, lbPairAbi, lbRouterAbi } from "../../../../packages/sdk/src/abi";
import { installUnlockedRpcWallet, readUnlockedRpcWallet } from "./fixtures/unlocked-rpc-wallet";

const APP_LOCALNET_RPC = /^http:\/\/127\.0\.0\.1:8545\/?$/;
const APP_LOCALNET_INDEXER = "http://127.0.0.1:8000/subgraphs/name/robinhood-lb/localnet";

interface BrowserLocalnetManifest {
  chainId: number;
  deployer: Address;
  contracts: {
    lbFactory: Address;
    lbQuoter: Address;
    lbRouter: Address;
  };
  seededPools: {
    wnativeUsdc: {
      activeId: number;
      binStep: number;
      pair: Address;
      tokenX: Address;
      tokenY: Address;
    };
  };
  tokens: {
    usdc: Address;
    wnative: Address;
  };
}

interface JsonRpcRequest {
  id: number | string | null;
  jsonrpc: string;
  method: string;
  params?: unknown[];
}

const rpcUrl = requiredEnvironment("E2E_BROWSER_RPC_URL");
const wrongRpcUrl = requiredEnvironment("E2E_BROWSER_WRONG_RPC_URL");
const browserAccount = requiredEnvironment("E2E_BROWSER_ACCOUNT") as Address;
const manifest = JSON.parse(readFileSync(requiredEnvironment("E2E_BROWSER_MANIFEST_PATH"), "utf8")) as BrowserLocalnetManifest;
const client = createPublicClient({ transport: http(rpcUrl) });
const pool = manifest.seededPools.wnativeUsdc;
const transactionSimulationAbi = [...erc20Abi, ...lbPairAbi, ...lbRouterAbi] as const;

interface RecordedSimulationTransaction {
  data: string;
  functionName: string;
  to: string;
  value: bigint;
}

interface DecodedLiquidityParameters {
  amountX: bigint;
  amountY: bigint;
  amountXMin: bigint;
  amountYMin: bigint;
  deltaIds: readonly bigint[];
  distributionX: readonly bigint[];
  distributionY: readonly bigint[];
}

interface RpcControl {
  failQuoterCalls: boolean;
  simulations: Array<{ functionName: string; to: string }>;
  simulationTransactions: RecordedSimulationTransaction[];
}

test.describe.configure({ mode: "serial" });

test("real wrong-runtime Anvil chain disables every transaction path", async ({ page }) => {
  await installBrowserStack(page, wrongRpcUrl);
  await page.goto("/#/swap");
  await connectWallet(page);

  await expect(page.locator(".status-pill").filter({ hasText: `Expected ${manifest.chainId}, RPC 46630` })).toBeVisible();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await bypassDisabledButtonAndClick(page, "swap-approve-button");
  await bypassDisabledButtonAndClick(page, "swap-submit-button");

  await page.getByRole("link", { name: "Liquidity" }).click();
  for (const testId of [
    "liquidity-approve-x-button",
    "liquidity-approve-y-button",
    "liquidity-add-button",
    "liquidity-approve-lb-button",
    "liquidity-remove-button"
  ]) {
    await expect(page.getByTestId(testId)).toBeDisabled();
  }

  expect((await readUnlockedRpcWallet(page)).sentTransactions).toEqual([]);
});

test("a real quote ages stale and remains handler-guarded when refresh fails", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const rpcControl = await installBrowserStack(page, rpcUrl);
  await page.goto("/#/swap");
  await connectWallet(page);
  await expect.poll(() => page.locator("#swap-output").inputValue()).not.toBe("0");
  await expect(page.getByTestId("swap-approve-button")).toBeEnabled();

  rpcControl.failQuoterCalls = true;
  await page.clock.fastForward(16_000);

  await expect(page.getByText("Quote is stale; refresh before swapping")).toBeVisible();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await bypassDisabledButtonAndClick(page, "swap-approve-button");
  await bypassDisabledButtonAndClick(page, "swap-submit-button");
  expect((await readUnlockedRpcWallet(page)).sentTransactions).toEqual([]);
});

test("actual UI submits approve, swap, add, LB approval, and remove transactions to isolated Anvil", async ({ page }) => {
  const rpcControl = await installBrowserStack(page, rpcUrl);
  const lbBalanceBeforeAdd = await readLbBalance();
  expect(lbBalanceBeforeAdd).toBe(0n);
  const balanceXBeforeSwap = await readTokenBalance(pool.tokenX);
  const balanceYBeforeSwap = await readTokenBalance(pool.tokenY);

  await page.goto("/#/swap");
  await connectWallet(page);
  await expect.poll(() => page.locator("#swap-output").inputValue()).not.toBe("0");
  await expect(page.getByTestId("swap-approve-button")).toBeEnabled();
  await clickReviewedAction(page, "swap-approve-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(1);
  await expect(page.getByText("Approval confirmed")).toBeVisible();

  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();
  await clickReviewedAction(page, "swap-submit-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(2);
  await expect(page.getByText("Swap confirmed")).toBeVisible();

  const balanceXAfterSwap = await readTokenBalance(pool.tokenX);
  const balanceYAfterSwap = await readTokenBalance(pool.tokenY);
  expect(balanceXAfterSwap).toBeLessThan(balanceXBeforeSwap);
  expect(balanceYAfterSwap).toBeGreaterThan(balanceYBeforeSwap);

  await page.getByRole("link", { name: "Liquidity" }).click();
  await page.locator("#range-lower").fill("0");
  await page.locator("#range-upper").fill("0");

  await expect(page.getByTestId("liquidity-approve-x-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-approve-x-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(3);
  await expect(page.getByTestId("liquidity-approve-y-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-approve-y-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(4);

  await expect(page.getByTestId("liquidity-add-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-add-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(5);
  await expect(page.getByText("Liquidity added")).toBeVisible();
  const lbBalanceAfterAdd = await readLbBalance();
  expect(lbBalanceAfterAdd).toBeGreaterThan(lbBalanceBeforeAdd);

  await expect(page.getByTestId("liquidity-approve-lb-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-approve-lb-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(6);
  await expect(page.getByText("LB approval confirmed")).toBeVisible();
  await expect(page.getByTestId("liquidity-receipt-review")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("liquidity-receipt-review")).toContainText("Actual gas cost");

  const tokenXBeforePartial = await readTokenBalance(pool.tokenX);
  const tokenYBeforePartial = await readTokenBalance(pool.tokenY);
  await page.getByRole("group", { name: "Withdrawal percentage presets" }).getByRole("button", { name: "50%" }).click();
  await expect(page.getByTestId("withdraw-transaction-review")).toContainText("Partial withdrawal");
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-remove-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(7);
  await expect(page.getByText("Liquidity removed")).toBeVisible();
  await client.request({ method: "anvil_mine", params: ["0xb"] });
  await expect.poll(() => page.evaluate(() => {
    const raw = window.localStorage.getItem("feather.transaction-journal.v1");
    if (raw === null) return 0;
    const records = (JSON.parse(raw) as { records: Array<{ confirmations: number; reviewed: { intent: string } }> }).records;
    return records.findLast((record) => record.reviewed.intent === "remove-liquidity")?.confirmations ?? 0;
  }), { timeout: 15_000 }).toBeGreaterThanOrEqual(12);
  const lbBalanceAfterPartial = await readLbBalance();
  expect(lbBalanceAfterPartial).toBeGreaterThan(lbBalanceBeforeAdd);
  expect(lbBalanceAfterPartial).toBeLessThan(lbBalanceAfterAdd);
  const partialWallet = await readUnlockedRpcWallet(page);
  const partialRemove = decodeSubmittedTransaction(partialWallet.sentTransactions[6]!);
  const partialArgs = partialRemove.args as readonly unknown[];
  expect((await readTokenBalance(pool.tokenX)) - tokenXBeforePartial).toBeGreaterThanOrEqual(partialArgs[3] as bigint);
  expect((await readTokenBalance(pool.tokenY)) - tokenYBeforePartial).toBeGreaterThanOrEqual(partialArgs[4] as bigint);
  const journalBeforeReload = await page.evaluate(() => {
    const raw = window.localStorage.getItem("feather.transaction-journal.v1");
    return raw === null ? [] : (JSON.parse(raw) as { records: Array<{ reviewed: { intent: string } }> }).records;
  });
  expect(journalBeforeReload.map((record) => record.reviewed.intent)).toEqual([
    "approval",
    "swap",
    "approval",
    "approval",
    "add-liquidity",
    "approval",
    "remove-liquidity"
  ]);

  await page.reload();
  if (await page.getByTestId("wallet-connect-button").isVisible()) await connectWallet(page);
  else await expect(page.getByTestId("wallet-account-button")).toBeVisible();
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await page.getByRole("group", { name: "Withdrawal percentage presets" }).getByRole("button", { name: "Max" }).click();
  await expect(page.getByTestId("withdraw-transaction-review")).toContainText("Full exit");
  await clickReviewedAction(page, "liquidity-remove-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(1);
  await expect(page.getByText(/Full-exit batch mined/)).toBeVisible();
  expect(await readLbBalance()).toBe(lbBalanceBeforeAdd);
  await client.request({ method: "anvil_mine", params: ["0xb"] });
  await expect.poll(() => page.evaluate(() => {
    const raw = window.localStorage.getItem("feather.transaction-journal.v1");
    if (raw === null) return 0;
    const records = (JSON.parse(raw) as { records: Array<{ confirmations: number; reviewed: { intent: string } }> }).records;
    return records.findLast((record) => record.reviewed.intent === "remove-liquidity")?.confirmations ?? 0;
  }), { timeout: 15_000 }).toBeGreaterThanOrEqual(12);
  await page.getByTestId("resume-full-exit-button").click();
  await expect(page.getByTestId("full-exit-workflow-status")).toContainText("Full exit verified complete");

  const fullWallet = await readUnlockedRpcWallet(page);
  const wallet = {
    transactionHashes: [...partialWallet.transactionHashes, ...fullWallet.transactionHashes],
    sentTransactions: [...partialWallet.sentTransactions, ...fullWallet.sentTransactions]
  };
  for (const hash of wallet.transactionHashes) {
    expect((await client.getTransactionReceipt({ hash })).status).toBe("success");
  }

  const decoded = wallet.sentTransactions.map(decodeSubmittedTransaction);
  expect(decoded.map((transaction) => transaction.functionName)).toEqual([
    "approve",
    "swapExactTokensForTokens",
    "approve",
    "approve",
    "addLiquidity",
    "approveForAll",
    "removeLiquidity",
    "removeLiquidity"
  ]);
  expect(normalizeAddress(wallet.sentTransactions[0]?.to)).toBe(pool.tokenX.toLowerCase());
  expect(normalizeAddress(wallet.sentTransactions[1]?.to)).toBe(manifest.contracts.lbRouter.toLowerCase());
  expect(normalizeAddress(wallet.sentTransactions[4]?.to)).toBe(manifest.contracts.lbRouter.toLowerCase());
  expect(normalizeAddress(wallet.sentTransactions[5]?.to)).toBe(pool.pair.toLowerCase());
  expect(normalizeAddress(wallet.sentTransactions[6]?.to)).toBe(manifest.contracts.lbRouter.toLowerCase());
  expect(normalizeAddress(wallet.sentTransactions[7]?.to)).toBe(manifest.contracts.lbRouter.toLowerCase());
  expect(rpcControl.simulations).toEqual([
    { functionName: "approve", to: pool.tokenX.toLowerCase() },
    { functionName: "approve", to: pool.tokenX.toLowerCase() },
    { functionName: "swapExactTokensForTokens", to: manifest.contracts.lbRouter.toLowerCase() },
    { functionName: "swapExactTokensForTokens", to: manifest.contracts.lbRouter.toLowerCase() },
    { functionName: "approve", to: pool.tokenX.toLowerCase() },
    { functionName: "approve", to: pool.tokenX.toLowerCase() },
    { functionName: "approve", to: pool.tokenY.toLowerCase() },
    { functionName: "approve", to: pool.tokenY.toLowerCase() },
    { functionName: "addLiquidity", to: manifest.contracts.lbRouter.toLowerCase() },
    { functionName: "approveForAll", to: pool.pair.toLowerCase() },
    { functionName: "approveForAll", to: pool.pair.toLowerCase() },
    { functionName: "removeLiquidity", to: manifest.contracts.lbRouter.toLowerCase() },
    { functionName: "removeLiquidity", to: manifest.contracts.lbRouter.toLowerCase() },
    { functionName: "removeLiquidity", to: manifest.contracts.lbRouter.toLowerCase() },
    { functionName: "removeLiquidity", to: manifest.contracts.lbRouter.toLowerCase() },
    { functionName: "removeLiquidity", to: manifest.contracts.lbRouter.toLowerCase() }
  ]);
});

test("actual UI deposits one-sided liquidity above and below the active bin without a swap", async ({ page }, testInfo) => {
  const rpcControl = await installBrowserStack(page, rpcUrl);
  const aboveBinIds = [pool.activeId + 1, pool.activeId + 2];
  const belowBinIds = [pool.activeId - 2, pool.activeId - 1];
  const aboveBalanceBefore = await readLbBalanceAcross(aboveBinIds);
  const belowBalanceBefore = await readLbBalanceAcross(belowBinIds);

  await page.goto("/#/liquidity");
  await connectWallet(page);
  await page.locator("#range-lower").fill("1");
  await page.locator("#range-upper").fill("2");

  await expect(page.getByTestId("liquidity-range-mode")).toContainText("One-sided WNATIVE");
  await expect(page.getByTestId("one-sided-liquidity-notice")).toContainText("does not perform a swap");
  await expect(page.getByTestId("liquidity-amount-y")).toBeDisabled();
  await expect(page.getByTestId("liquidity-amount-y")).toHaveValue("0");
  await expect(page.getByTestId("liquidity-approve-x-button")).toBeEnabled();
  await expect(page.getByTestId("liquidity-approve-y-button")).toBeDisabled();
  await clickReviewedAction(page, "liquidity-approve-x-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(1);
  await expect(page.getByTestId("liquidity-add-button")).toBeEnabled();

  await clickReviewedAction(page, "liquidity-add-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(2);
  await expect(page.getByText("Liquidity added")).toBeVisible();
  expect(await readLbBalanceAcross(aboveBinIds)).toBeGreaterThan(aboveBalanceBefore);

  await page.locator("#range-lower").fill("-2");
  await page.locator("#range-upper").fill("-1");
  await expect(page.getByTestId("liquidity-range-mode")).toContainText("One-sided USDC");
  await expect(page.getByTestId("liquidity-amount-x")).toBeDisabled();
  await expect(page.getByTestId("liquidity-amount-x")).toHaveValue("0");
  await expect(page.getByTestId("liquidity-approve-x-button")).toBeDisabled();
  await expect(page.getByTestId("liquidity-approve-y-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-approve-y-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(3);
  await expect(page.getByTestId("liquidity-add-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-add-button");
  await expect.poll(async () => (await readUnlockedRpcWallet(page)).transactionHashes.length).toBe(4);
  await expect(page.getByText("Liquidity added")).toBeVisible();
  expect(await readLbBalanceAcross(belowBinIds)).toBeGreaterThan(belowBalanceBefore);

  const wallet = await readUnlockedRpcWallet(page);
  const decoded = wallet.sentTransactions.map(decodeSubmittedTransaction);
  expect(decoded.map((transaction) => transaction.functionName)).toEqual(["approve", "addLiquidity", "approve", "addLiquidity"]);
  const aboveParameters = (decoded[1]!.args as readonly [DecodedLiquidityParameters])[0];
  const belowParameters = (decoded[3]!.args as readonly [DecodedLiquidityParameters])[0];
  expect(aboveParameters.amountX).toBeGreaterThan(0n);
  expect(aboveParameters.amountY).toBe(0n);
  expect(aboveParameters.amountYMin).toBe(0n);
  expect(aboveParameters.deltaIds).toEqual([1n, 2n]);
  expect(aboveParameters.distributionX.some((weight) => weight > 0n)).toBe(true);
  expect(aboveParameters.distributionY.every((weight) => weight === 0n)).toBe(true);
  expect(belowParameters.amountX).toBe(0n);
  expect(belowParameters.amountXMin).toBe(0n);
  expect(belowParameters.amountY).toBeGreaterThan(0n);
  expect(belowParameters.deltaIds).toEqual([-2n, -1n]);
  expect(belowParameters.distributionX.every((weight) => weight === 0n)).toBe(true);
  expect(belowParameters.distributionY.some((weight) => weight > 0n)).toBe(true);
  expect(rpcControl.simulations.map((simulation) => simulation.functionName)).toEqual([
    "approve",
    "approve",
    "addLiquidity",
    "approve",
    "approve",
    "addLiquidity"
  ]);
  expect(rpcControl.simulations.map((simulation) => simulation.functionName)).not.toContain("swapExactTokensForTokens");
  const receiptStatuses: string[] = [];
  for (const [index, transaction] of wallet.sentTransactions.entries()) {
    assertTransactionMatchesRecordedSimulation(transaction, rpcControl);
    const receipt = await client.getTransactionReceipt({ hash: wallet.transactionHashes[index]! });
    receiptStatuses.push(receipt.status);
    expect(receipt.status).toBe("success");
  }
  const runtimeEvidence = {
    above: liquidityEvidence(wallet.sentTransactions[1]!, wallet.transactionHashes[1]!, aboveParameters),
    below: liquidityEvidence(wallet.sentTransactions[3]!, wallet.transactionHashes[3]!, belowParameters),
    receiptStatuses,
    simulatedFunctions: rpcControl.simulations.map((simulation) => simulation.functionName)
  };
  console.log(`ONE_SIDED_RUNTIME_EVIDENCE ${JSON.stringify(runtimeEvidence)}`);
  await testInfo.attach("one-sided-runtime-evidence", {
    body: JSON.stringify(runtimeEvidence, null, 2),
    contentType: "application/json"
  });
});

async function installBrowserStack(page: Page, runtimeRpcUrl: string): Promise<RpcControl> {
  const rpcControl: RpcControl = { failQuoterCalls: false, simulations: [], simulationTransactions: [] };
  await installRpcProxy(page, runtimeRpcUrl, rpcControl);
  await installChainBackedIndexerBridge(page);
  await installUnlockedRpcWallet(page, { account: browserAccount, chainId: manifest.chainId, rpcUrl });
  return rpcControl;
}

async function installRpcProxy(
  page: Page,
  targetRpcUrl: string,
  control: RpcControl
): Promise<void> {
  await page.route(APP_LOCALNET_RPC, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() });
      return;
    }

    const payload = JSON.parse(route.request().postData() ?? "null") as JsonRpcRequest | JsonRpcRequest[];
    const response = Array.isArray(payload)
      ? await Promise.all(payload.map((request) => forwardRpcRequest(request, targetRpcUrl, control)))
      : await forwardRpcRequest(payload, targetRpcUrl, control);
    await route.fulfill({ body: JSON.stringify(response), contentType: "application/json", headers: corsHeaders(), status: 200 });
  });
}

async function forwardRpcRequest(
  request: JsonRpcRequest,
  targetRpcUrl: string,
  control: RpcControl
): Promise<unknown> {
  recordTransactionSimulation(request, control);
  if (control.failQuoterCalls && isQuoterCall(request)) {
    return { id: request.id, jsonrpc: "2.0", error: { code: -32_000, message: "E2E intentionally paused quote refresh" } };
  }

  const response = await fetch(targetRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  if (!response.ok) throw new Error(`RPC proxy received HTTP ${response.status}`);
  return response.json();
}

function recordTransactionSimulation(request: JsonRpcRequest, control: RpcControl): void {
  if (request.method !== "eth_call") return;
  const call = request.params?.[0] as { data?: string; to?: string; value?: string } | undefined;
  if (typeof call?.data !== "string" || typeof call.to !== "string") return;

  try {
    const decoded = decodeFunctionData({ abi: transactionSimulationAbi, data: call.data as Hex });
    if (
      ![
        "approve",
        "approveForAll",
        "swapExactTokensForTokens",
        "addLiquidity",
        "removeLiquidity"
      ].includes(decoded.functionName)
    ) {
      return;
    }
    control.simulations.push({ functionName: decoded.functionName, to: call.to.toLowerCase() });
    control.simulationTransactions.push({
      data: call.data.toLowerCase(),
      functionName: decoded.functionName,
      to: call.to.toLowerCase(),
      value: normalizeTransactionValue(call.value)
    });
  } catch {
    // Non-transaction reads and quoter calls are intentionally outside this assertion ledger.
  }
}

function isQuoterCall(request: JsonRpcRequest): boolean {
  if (request.method !== "eth_call") return false;
  const call = request.params?.[0] as { to?: string } | undefined;
  return call?.to?.toLowerCase() === manifest.contracts.lbQuoter.toLowerCase();
}

async function installChainBackedIndexerBridge(page: Page): Promise<void> {
  await page.route(APP_LOCALNET_INDEXER, async (route: Route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() });
      return;
    }

    const body = JSON.parse(route.request().postData() ?? "{}") as { query?: string; variables?: { owner?: string; pair?: string } };
    const query = body.query ?? "";
    const block = await client.getBlock();
    let data: Record<string, unknown>;

    if (query.includes("DashboardSummary")) {
      data = {
        _meta: { block: { number: Number(block.number), hash: block.hash }, hasIndexingErrors: false },
        factory: { pairCount: "1" }
      };
    } else if (query.includes("PairById")) {
      const requestedPair = typeof (body.variables as { id?: string } | undefined)?.id === "string"
        ? (body.variables as { id: string }).id.toLowerCase()
        : "";
      data = { pair: requestedPair === pool.pair.toLowerCase() ? await pairGraphRow(block.number) : null };
    } else if (query.includes("OwnerPairPositions")) {
      const requestedOwner = body.variables?.owner?.toLowerCase();
      const requestedPair = body.variables?.pair?.toLowerCase();
      const balance = await readLbBalance();
      data = {
        positions:
          requestedOwner === browserAccount.toLowerCase() && requestedPair === pool.pair.toLowerCase() && balance > 0n
            ? [positionGraphRow(balance, block.number)]
            : []
      };
    } else if (query.includes("PairsPage")) {
      data = { pairs: [await pairGraphRow(block.number)] };
    } else if (query.includes("SwapsPage")) {
      data = { swaps: [] };
    } else if (query.includes("LiquidityEventsPage")) {
      data = { liquidityEvents: [] };
    } else if (query.includes("PositionsPage")) {
      data = { positions: [] };
    } else {
      await route.fulfill({ body: JSON.stringify({ errors: [{ message: "Unhandled chain-backed E2E indexer query" }] }), contentType: "application/json", headers: corsHeaders(), status: 200 });
      return;
    }

    await route.fulfill({ body: JSON.stringify({ data }), contentType: "application/json", headers: corsHeaders(), status: 200 });
  });
}

async function pairGraphRow(blockNumber: bigint): Promise<Record<string, unknown>> {
  const [activeId, hooksParameters] = await Promise.all([
    client.readContract({ address: pool.pair, abi: lbPairAbi, functionName: "getActiveId" }),
    client.readContract({ address: pool.pair, abi: lbPairAbi, functionName: "getLBHooksParameters" })
  ]);
  const reserves = await client.readContract({ address: pool.pair, abi: lbPairAbi, functionName: "getBin", args: [activeId] });
  return {
    activeId: activeId.toString(),
    address: pool.pair,
    binStep: pool.binStep.toString(),
    depositCount: "1",
    factory: { id: manifest.contracts.lbFactory.toLowerCase() },
    hooksParameters,
    id: pool.pair.toLowerCase(),
    ignoredForRouting: false,
    reserveX: reserves[0].toString(),
    reserveY: reserves[1].toString(),
    swapCount: "1",
    tokenX: { address: pool.tokenX },
    tokenY: { address: pool.tokenY },
    totalFeesX: "0",
    totalFeesY: "0",
    totalVolumeX: "0",
    totalVolumeY: "0",
    updatedAtBlock: blockNumber.toString()
  };
}

function positionGraphRow(liquidity: bigint, blockNumber: bigint): Record<string, unknown> {
  return {
    bin: { binId: pool.activeId.toString() },
    id: `${pool.pair.toLowerCase()}-${pool.activeId}`,
    liquidity: liquidity.toString(),
    owner: browserAccount,
    pair: { id: pool.pair.toLowerCase() },
    updatedAtBlock: blockNumber.toString()
  };
}

async function connectWallet(page: Page): Promise<void> {
  const connectButton = page.getByTestId("wallet-connect-button");
  const accountButton = page.getByTestId("wallet-account-button");
  if (await connectButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await page.waitForTimeout(250);
    if (!await accountButton.isVisible().catch(() => false) && await connectButton.isVisible().catch(() => false)) {
      await expect(connectButton).toBeEnabled();
      await connectButton.click();
    }
  }
  await expect(accountButton).toContainText(
    new RegExp(`${browserAccount.slice(0, 6)}\\.\\.\\.${browserAccount.slice(-4)}`, "i")
  );
}

async function clickReviewedAction(page: Page, testId: string): Promise<void> {
  const expectedAction = new Map<string, RegExp>([
    ["swap-approve-button", /gas estimate for WNATIVE approval:/],
    ["swap-submit-button", /gas estimate for swap:/],
    ["liquidity-approve-x-button", /gas estimate for WNATIVE approval:/],
    ["liquidity-approve-y-button", /gas estimate for USDC approval:/],
    ["liquidity-add-button", /gas estimate for add liquidity:/],
    ["liquidity-approve-lb-button", /gas estimate for LB operator approval:/],
    ["liquidity-remove-button", /gas estimate for (?:liquidity withdrawal|full liquidity exit):/]
  ]).get(testId);
  if (expectedAction === undefined) throw new Error(`No reviewed-action expectation is defined for ${testId}`);

  await page.getByTestId(testId).click();
  await expect(page.getByTestId("gas-review")).toContainText(expectedAction);
  if (testId === "liquidity-add-button") {
    await expect(page.getByTestId("liquidity-add-review")).toBeVisible();
    await expect(page.getByTestId("liquidity-review-exact-destination")).toContainText("Unix deadline");
    await expect(page.getByTestId("liquidity-review-limitations")).toContainText("not guarantees");
  }
  await page.getByTestId(testId).click();
}

async function bypassDisabledButtonAndClick(page: Page, testId: string): Promise<void> {
  await page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.removeAttribute("disabled"), testId);
  await page.getByTestId(testId).click();
}

async function readTokenBalance(token: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [browserAccount] });
}

async function readLbBalance(): Promise<bigint> {
  return client.readContract({ address: pool.pair, abi: lbPairAbi, functionName: "balanceOf", args: [browserAccount, BigInt(pool.activeId)] });
}

async function readLbBalanceAcross(binIds: number[]): Promise<bigint> {
  const balances = await Promise.all(
    binIds.map((binId) =>
      client.readContract({ address: pool.pair, abi: lbPairAbi, functionName: "balanceOf", args: [browserAccount, BigInt(binId)] })
    )
  );
  return balances.reduce((total, balance) => total + balance, 0n);
}

function decodeSubmittedTransaction(transaction: Record<string, unknown>) {
  if (typeof transaction.data !== "string") throw new Error("Submitted transaction is missing calldata");
  return decodeFunctionData({ abi: transactionSimulationAbi, data: transaction.data as Hex });
}

function assertTransactionMatchesRecordedSimulation(transaction: Record<string, unknown>, control: RpcControl): void {
  if (typeof transaction.data !== "string") throw new Error("Submitted transaction is missing calldata");
  const to = normalizeAddress(transaction.to);
  const simulation = control.simulationTransactions.find(
    (candidate) => candidate.to === to && candidate.data === transaction.data.toLowerCase()
  );
  expect(simulation, "submitted transaction must exactly match a prior eth_call simulation").toBeDefined();
  expect(normalizeTransactionValue(transaction.value)).toBe(simulation?.value);
}

function normalizeTransactionValue(value: unknown): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error("Transaction value is not numeric");
  }
  return BigInt(value);
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== "string") throw new Error("Submitted transaction is missing a target address");
  return value.toLowerCase();
}

function liquidityEvidence(
  transaction: Record<string, unknown>,
  hash: Hex,
  parameters: DecodedLiquidityParameters
): Record<string, unknown> {
  return {
    calldata: transaction.data,
    hash,
    amountX: parameters.amountX.toString(),
    amountY: parameters.amountY.toString(),
    amountXMin: parameters.amountXMin.toString(),
    amountYMin: parameters.amountYMin.toString(),
    deltaIds: parameters.deltaIds.map(String),
    distributionX: parameters.distributionX.map(String),
    distributionY: parameters.distributionY.map(String)
  };
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": "*"
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required. Run this spec through scripts/e2e/run-browser-localnet.cjs.`);
  return value;
}
