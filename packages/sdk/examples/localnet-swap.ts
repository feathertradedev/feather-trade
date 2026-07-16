import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWalletClient, encodeFunctionData, formatUnits, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  calculateAmountOutMin,
  buildExactInSwapTransaction,
  createDexPublicClient,
  deadlineFromNow,
  erc20Abi,
  findTokenBySymbol,
  getBestExactInQuote,
  getQuoteAmountOut,
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

const weth = findTokenBySymbol(registry.tokens, "WETH");
const usdc = findTokenBySymbol(registry.tokens, "USDC");
if (weth === null || usdc === null) throw new Error("Required localnet token identity is unavailable or ambiguous");
const amountIn = parseUnits(process.env.SDK_EXAMPLE_SWAP_AMOUNT_IN ?? "0.01", weth.decimals);
const slippageBps = BigInt(process.env.SDK_EXAMPLE_SLIPPAGE_BPS ?? "50");
const deadline = deadlineFromNow(Number(process.env.SDK_EXAMPLE_DEADLINE_MINUTES ?? "20"));
const pool = registry.seededPools.wethUsdc;
const quote = await getBestExactInQuote(publicClient, registry, pool.tokenX, pool.tokenY, amountIn);
const amountOut = getQuoteAmountOut(quote);
const amountOutMin = calculateAmountOutMin(amountOut, slippageBps);
const allowance = await publicClient.readContract({
  address: pool.tokenX,
  abi: erc20Abi,
  functionName: "allowance",
  args: [account.address, registry.contracts.lbRouter]
});

let approvalHash: `0x${string}` | null = null;
if (allowance < amountIn) {
  const approvalTransaction = {
    to: pool.tokenX,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [registry.contracts.lbRouter, amountIn]
    }),
    value: 0n
  } as const;
  approvalHash = await simulateAndSendTransaction(
    account.address,
    approvalTransaction,
    (request) => publicClient.estimateGas(request),
    (request) => publicClient.call(request),
    (request) => walletClient.sendTransaction(request)
  );
  const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
  if (approvalReceipt.status !== "success") {
    throw new Error(`Swap approval ${approvalHash} finished with status ${approvalReceipt.status}`);
  }
}

const swapTransaction = buildExactInSwapTransaction(registry, quote, amountIn, amountOutMin, account.address, deadline);
const swapHash = await simulateAndSendTransaction(
  account.address,
  swapTransaction,
  (request) => publicClient.estimateGas(request),
  (request) => publicClient.call(request),
  (request) => walletClient.sendTransaction(request)
);
const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });

if (receipt.status !== "success") {
  throw new Error(`Swap transaction ${swapHash} finished with status ${receipt.status}`);
}

console.log(
  JSON.stringify(
    {
      manifestPath,
      chainId: registry.chainId,
      account: account.address,
      tokenIn: weth.symbol,
      tokenOut: usdc.symbol,
      amountIn: amountIn.toString(),
      amountInFormatted: formatUnits(amountIn, weth.decimals),
      amountOut: amountOut.toString(),
      amountOutFormatted: formatUnits(amountOut, usdc.decimals),
      amountOutMin: amountOutMin.toString(),
      approvalHash,
      swapHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString()
    },
    null,
    2
  )
);

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
