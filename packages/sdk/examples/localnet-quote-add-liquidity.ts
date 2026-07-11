import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatUnits, isAddress, parseUnits, type Address } from "viem";

import {
  buildSeededWnativeUsdcAddLiquidityTransaction,
  createDexPublicClient,
  deadlineFromNow,
  findTokenBySymbol,
  getSwapOutQuote,
  readDeploymentManifest,
  registryFromLocalnetManifest
} from "../src/index.js";

const manifestPath = resolveManifestPath();
const manifest = readDeploymentManifest(manifestPath);

if (manifest.schemaVersion !== "lb.localnet.v1") {
  throw new Error(`Expected a localnet manifest, got ${manifest.schemaVersion}`);
}

const registry = registryFromLocalnetManifest(manifest);
const client = createDexPublicClient(registry.chain, process.env.LOCALNET_RPC_URL ?? registry.endpoints.rpcUrl);
const account = accountFromEnvOrManifest(manifest.deployer);
const wnative = findTokenBySymbol(registry.tokens, "WNATIVE");
const usdc = findTokenBySymbol(registry.tokens, "USDC");
if (wnative === null || usdc === null) throw new Error("Required localnet token identity is unavailable or ambiguous");
const quoteAmountIn = parseUnits(process.env.SDK_EXAMPLE_SWAP_AMOUNT_IN ?? "1", wnative.decimals);
const liquidityAmountX = parseUnits(process.env.SDK_EXAMPLE_LIQUIDITY_AMOUNT_X ?? "1", wnative.decimals);
const liquidityAmountY = parseUnits(process.env.SDK_EXAMPLE_LIQUIDITY_AMOUNT_Y ?? "1", usdc.decimals);
const deadline = deadlineFromNow(Number(process.env.SDK_EXAMPLE_DEADLINE_MINUTES ?? "20"));

const quote = await getSwapOutQuote(client, registry, quoteAmountIn);
const addLiquidityTx = buildSeededWnativeUsdcAddLiquidityTransaction(registry, {
  amountX: liquidityAmountX,
  amountY: liquidityAmountY,
  to: account,
  deadline
});

console.log(
  JSON.stringify(
    {
      manifestPath,
      chainId: registry.chainId,
      pair: quote.pair,
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      amountIn: quote.amountIn.toString(),
      amountInFormatted: formatUnits(quote.amountIn, wnative.decimals),
      amountOut: quote.amountOut.toString(),
      amountOutFormatted: formatUnits(quote.amountOut, usdc.decimals),
      fee: quote.fee.toString(),
      addLiquidityTx: {
        to: addLiquidityTx.to,
        data: addLiquidityTx.data,
        value: addLiquidityTx.value.toString()
      }
    },
    null,
    2
  )
);

function accountFromEnvOrManifest(fallback: Address): Address {
  const account = process.env.SDK_EXAMPLE_ACCOUNT;

  if (account === undefined || account.length === 0) {
    return fallback;
  }

  if (!isAddress(account)) {
    throw new Error(`SDK_EXAMPLE_ACCOUNT is not a valid address: ${account}`);
  }

  return account;
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
