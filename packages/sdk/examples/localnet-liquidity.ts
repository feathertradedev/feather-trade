import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWalletClient, encodeFunctionData, formatUnits, http, parseUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  applyBurnQuoteSlippage,
  applyLiquiditySlippageMin,
  buildAddLiquidityTransaction,
  buildLiquidityDistribution,
  buildRemoveLiquidityTransaction,
  createDexPublicClient,
  deadlineFromNow,
  erc20Abi,
  findTokenBySymbol,
  lbPairAbi,
  quoteLiquidityBurn,
  readDeploymentManifest,
  registryFromLocalnetManifest
} from "../src/index.js";
import { simulateAndSendTransaction } from "./preflight-transaction.js";

const DEFAULT_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const manifestPath = resolveManifestPath();
const manifest = readDeploymentManifest(manifestPath);

if (manifest.schemaVersion !== "lb.localnet.v1") {
  throw new Error(`Expected a localnet manifest, got ${manifest.schemaVersion}`);
}

const registry = registryFromLocalnetManifest(manifest);
const rpcUrl = process.env.LOCALNET_RPC_URL ?? registry.endpoints.rpcUrl;
const publicClient = createDexPublicClient(registry.chain, rpcUrl);
const account = privateKeyToAccount((process.env.LOCALNET_PRIVATE_KEY ?? DEFAULT_PRIVATE_KEY) as `0x${string}`);
const walletClient = createWalletClient({
  account,
  chain: registry.chain,
  transport: http(rpcUrl)
});
const pool = registry.seededPools.wnativeUsdc;
const wnative = findTokenBySymbol(registry.tokens, "WNATIVE");
const usdc = findTokenBySymbol(registry.tokens, "USDC");
if (wnative === null || usdc === null) throw new Error("Required localnet token identity is unavailable or ambiguous");
const amountX = parseUnits(process.env.SDK_EXAMPLE_LIQUIDITY_AMOUNT_X ?? "0.01", wnative.decimals);
const amountY = parseUnits(process.env.SDK_EXAMPLE_LIQUIDITY_AMOUNT_Y ?? "1", usdc.decimals);
const lowerDelta = Number(process.env.SDK_EXAMPLE_LIQUIDITY_LOWER_DELTA ?? "-1");
const upperDelta = Number(process.env.SDK_EXAMPLE_LIQUIDITY_UPPER_DELTA ?? "1");
const slippageBps = BigInt(process.env.SDK_EXAMPLE_SLIPPAGE_BPS ?? "50");
const idSlippage = BigInt(process.env.SDK_EXAMPLE_ID_SLIPPAGE ?? "2");
const distribution = buildLiquidityDistribution(pool.activeId, lowerDelta, upperDelta);
const deadline = deadlineFromNow(Number(process.env.SDK_EXAMPLE_DEADLINE_MINUTES ?? "20"));

await approveIfNeeded(pool.tokenX, amountX);
await approveIfNeeded(pool.tokenY, amountY);

const ids = distribution.bins.map((bin) => bin.binId);
const balancesBefore = await readLbBalances(ids);
const addTransaction = buildAddLiquidityTransaction(registry, {
  tokenX: pool.tokenX,
  tokenY: pool.tokenY,
  binStep: BigInt(pool.binStep),
  amountX,
  amountY,
  amountXMin: applyLiquiditySlippageMin(amountX, slippageBps),
  amountYMin: applyLiquiditySlippageMin(amountY, slippageBps),
  activeIdDesired: BigInt(pool.activeId),
  idSlippage,
  deltaIds: distribution.deltaIds,
  distributionX: distribution.distributionX,
  distributionY: distribution.distributionY,
  to: account.address,
  refundTo: account.address,
  deadline
});
const addHash = await simulateAndSendTransaction(
  account.address,
  addTransaction,
  (request) => publicClient.estimateGas(request),
  (request) => publicClient.call(request),
  (request) => walletClient.sendTransaction(request)
);
const addReceipt = await publicClient.waitForTransactionReceipt({ hash: addHash });

if (addReceipt.status !== "success") {
  throw new Error(`Add liquidity transaction ${addHash} finished with status ${addReceipt.status}`);
}

const balancesAfter = await readLbBalances(ids);
const mintedAmounts = balancesAfter.map((balance, index) => balance - balancesBefore[index]);

if (mintedAmounts.every((amount) => amount === 0n)) {
  throw new Error("Add liquidity succeeded but no LB token balance increased");
}

const burnEntries = ids.map((binId, index) => ({ binId, amount: mintedAmounts[index] })).filter((entry) => entry.amount > 0n);
const removeIds = burnEntries.map((entry) => entry.binId);
const removeAmounts = burnEntries.map((entry) => entry.amount);

const lbApproved = await publicClient.readContract({
  address: pool.pair,
  abi: lbPairAbi,
  functionName: "isApprovedForAll",
  args: [account.address, registry.contracts.lbRouter]
});

let lbApprovalHash: `0x${string}` | null = null;
if (!lbApproved) {
  const lbApprovalTransaction = {
    to: pool.pair,
    data: encodeFunctionData({
      abi: lbPairAbi,
      functionName: "approveForAll",
      args: [registry.contracts.lbRouter, true]
    }),
    value: 0n
  } as const;
  lbApprovalHash = await simulateAndSendTransaction(
    account.address,
    lbApprovalTransaction,
    (request) => publicClient.estimateGas(request),
    (request) => publicClient.call(request),
    (request) => walletClient.sendTransaction(request)
  );
  const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: lbApprovalHash });

  if (approvalReceipt.status !== "success") {
    throw new Error(`LB token approval ${lbApprovalHash} finished with status ${approvalReceipt.status}`);
  }
}

const burnSnapshotBlockNumber = await publicClient.getBlockNumber();
const burnQuote = quoteLiquidityBurn(
  await Promise.all(
    removeIds.map(async (binId, index) => {
      const [liveBalance, [reserveX, reserveY], totalSupply] = await Promise.all([
        publicClient.readContract({
          address: pool.pair,
          abi: lbPairAbi,
          functionName: "balanceOf",
          args: [account.address, binId],
          blockNumber: burnSnapshotBlockNumber
        }),
        publicClient.readContract({
          address: pool.pair,
          abi: lbPairAbi,
          functionName: "getBin",
          args: [Number(binId)],
          blockNumber: burnSnapshotBlockNumber
        }),
        publicClient.readContract({
          address: pool.pair,
          abi: lbPairAbi,
          functionName: "totalSupply",
          args: [binId],
          blockNumber: burnSnapshotBlockNumber
        })
      ]);
      const amountToBurn = removeAmounts[index];
      if (amountToBurn > liveBalance) throw new Error(`Burn amount exceeds the pinned live balance for bin ${binId}`);
      return { binId, amountToBurn, reserveX, reserveY, totalSupply };
    })
  )
);
const burnMinimums = applyBurnQuoteSlippage(burnQuote, slippageBps);

const removeTransaction = buildRemoveLiquidityTransaction(registry, {
  tokenX: pool.tokenX,
  tokenY: pool.tokenY,
  binStep: pool.binStep,
  minimums: burnMinimums,
  ids: removeIds,
  amounts: removeAmounts,
  to: account.address,
  deadline: deadlineFromNow(Number(process.env.SDK_EXAMPLE_DEADLINE_MINUTES ?? "20"))
});
const removeHash = await simulateAndSendTransaction(
  account.address,
  removeTransaction,
  (request) => publicClient.estimateGas(request),
  (request) => publicClient.call(request),
  (request) => walletClient.sendTransaction(request)
);
const removeReceipt = await publicClient.waitForTransactionReceipt({ hash: removeHash });

if (removeReceipt.status !== "success") {
  throw new Error(`Remove liquidity transaction ${removeHash} finished with status ${removeReceipt.status}`);
}

console.log(
  JSON.stringify(
    {
      manifestPath,
      chainId: registry.chainId,
      account: account.address,
      pair: pool.pair,
      binStep: pool.binStep.toString(),
      activeId: pool.activeId.toString(),
      range: { lowerDelta, upperDelta },
      amountX: amountX.toString(),
      amountXFormatted: formatUnits(amountX, wnative.decimals),
      amountY: amountY.toString(),
      amountYFormatted: formatUnits(amountY, usdc.decimals),
      ids: ids.map((id) => id.toString()),
      mintedAmounts: mintedAmounts.map((amount) => amount.toString()),
      addHash,
      lbApprovalHash,
      burnSnapshotBlockNumber: burnSnapshotBlockNumber.toString(),
      removeHash,
      addBlockNumber: addReceipt.blockNumber.toString(),
      removeBlockNumber: removeReceipt.blockNumber.toString()
    },
    null,
    2
  )
);

async function approveIfNeeded(token: Address, amount: bigint): Promise<void> {
  if (amount === 0n) return;

  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, registry.contracts.lbRouter]
  });

  if (allowance >= amount) return;

  const approvalTransaction = {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [registry.contracts.lbRouter, amount]
    }),
    value: 0n
  } as const;
  const hash = await simulateAndSendTransaction(
    account.address,
    approvalTransaction,
    (request) => publicClient.estimateGas(request),
    (request) => publicClient.call(request),
    (request) => walletClient.sendTransaction(request)
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== "success") {
    throw new Error(`ERC20 approval ${hash} finished with status ${receipt.status}`);
  }
}

async function readLbBalances(idsToRead: bigint[]): Promise<bigint[]> {
  return Promise.all(
    idsToRead.map((id) =>
      publicClient.readContract({
        address: pool.pair,
        abi: lbPairAbi,
        functionName: "balanceOf",
        args: [account.address, id]
      })
    )
  );
}

function resolveManifestPath(): string {
  if (process.env.LOCALNET_MANIFEST_PATH !== undefined && process.env.LOCALNET_MANIFEST_PATH.length > 0) {
    return process.env.LOCALNET_MANIFEST_PATH;
  }

  const candidates = [
    resolve(process.cwd(), "deployments/localnet/latest.json"),
    resolve(process.cwd(), "../../deployments/localnet/latest.json"),
    fileURLToPath(new URL("../../../deployments/localnet/latest.json", import.meta.url)),
    fileURLToPath(new URL("../../../../deployments/localnet/latest.json", import.meta.url))
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
