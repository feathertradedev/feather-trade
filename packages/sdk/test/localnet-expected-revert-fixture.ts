import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  createDexPublicClient,
  findTokenBySymbol,
  getBestExactInQuote,
  getQuoteAmountOut,
  lbRouterAbi,
  readDeploymentManifest,
  registryFromLocalnetManifest
} from "../src/index.js";

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

const wnative = findTokenBySymbol(registry.tokens, "WNATIVE");
const usdc = findTokenBySymbol(registry.tokens, "USDC");
if (wnative === null || usdc === null) throw new Error("Required localnet token identity is unavailable or ambiguous");
const amountIn = parseUnits(process.env.SDK_EXAMPLE_EXPECTED_REVERT_AMOUNT_IN ?? "0.001", wnative.decimals);
const expiredDeadline = BigInt(process.env.SDK_EXAMPLE_EXPECTED_REVERT_DEADLINE ?? "1");
const pool = registry.seededPools.wnativeUsdc;
const quote = await getBestExactInQuote(publicClient, registry, pool.tokenX, pool.tokenY, amountIn);
const amountOut = getQuoteAmountOut(quote);
const args = [
  amountIn,
  0n,
  {
    pairBinSteps: quote.binSteps,
    versions: quote.versions,
    tokenPath: quote.route
  },
  account.address,
  expiredDeadline
] as const;

const nonceBefore = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
const simulationError = await assertExpiredDeadlineSimulation();
const nonceAfter = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });

if (nonceAfter !== nonceBefore) {
  throw new Error(`Expected failed simulation to preserve account nonce ${nonceBefore}, got ${nonceAfter}`);
}

console.log(
  JSON.stringify(
    {
      manifestPath,
      chainId: registry.chainId,
      account: account.address,
      tokenIn: wnative.symbol,
      tokenOut: usdc.symbol,
      amountIn: amountIn.toString(),
      amountInFormatted: formatUnits(amountIn, wnative.decimals),
      quotedAmountOut: amountOut.toString(),
      expectedError: "LBRouter__DeadlineExceeded",
      simulationError,
      broadcastAttempted: false,
      nonceBefore: nonceBefore.toString(),
      nonceAfter: nonceAfter.toString(),
      expiredDeadline: expiredDeadline.toString(),
      outcome: "failed-simulation-blocked-broadcast"
    },
    null,
    2
  )
);

// This negative fixture must fail closed. The E2E orchestrator recognizes this
// intentional nonzero exit only after checking the decoded error and unchanged
// pending account nonce above.
process.exitCode = 1;

async function assertExpiredDeadlineSimulation(): Promise<{ name: string; message: string }> {
  try {
    await publicClient.simulateContract({
      address: registry.contracts.lbRouter,
      abi: lbRouterAbi,
      functionName: "swapExactTokensForTokens",
      account: account.address,
      args
    });
  } catch (error) {
    const details = describeError(error);
    if (details.name !== "LBRouter__DeadlineExceeded" && !details.message.includes("LBRouter__DeadlineExceeded")) {
      throw new Error(`Expected LBRouter__DeadlineExceeded simulation revert, got ${details.name}: ${details.message}`);
    }
    return details;
  }

  throw new Error("Expected expired-deadline swap simulation to revert, but it succeeded");
}

function describeError(error: unknown): { name: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  let name = "unknown";

  if (error instanceof BaseError) {
    const revertError = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revertError instanceof ContractFunctionRevertedError) {
      name = revertError.data?.errorName ?? name;
    }
  }

  return {
    name,
    message: message.split("\n").slice(0, 8).join("\n")
  };
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
