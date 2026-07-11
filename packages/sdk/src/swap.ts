import { encodeFunctionData, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from "viem";

import { lbQuoterAbi, lbRouterAbi } from "./abi.js";
import type { DexRegistry } from "./registry.js";
import { assertTokenActionAllowed, tokenAllowsAction, type TokenMetadataMap } from "./tokens.js";

export const LB_ROUTER_VERSION_V2_2 = 3;
export const BPS_DENOMINATOR = 10_000n;
export const FEE_SCALE = 1_000_000_000_000_000_000n;
export const UINT128_MAX = (1n << 128n) - 1n;
export const MIN_DEADLINE_MINUTES = 1;
export const MAX_DEADLINE_MINUTES = 120;

export interface ExactInPath {
  pairBinSteps: bigint[];
  versions: number[];
  tokenPath: Address[];
}

export interface ExactInQuote {
  route: Address[];
  pairs: Address[];
  binSteps: bigint[];
  versions: number[];
  amounts: bigint[];
  virtualAmountsWithoutSlippage: bigint[];
  fees: bigint[];
}

export interface ExactInQuoteRequest {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}

export interface ExactInRouteStep {
  tokenIn: Address;
  tokenOut: Address;
  pair: Address;
  binStep: bigint;
  version: number;
  amountIn: bigint;
  amountOut: bigint;
  feeScaled: bigint;
}

export interface BuiltSwapTransaction {
  to: Address;
  data: Hex;
  value: bigint;
}

export async function getBestExactInQuote(
  client: PublicClient,
  registry: Pick<DexRegistry, "contracts" | "tokens">,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<ExactInQuote> {
  if (amountIn <= 0n) {
    throw new Error("Amount in must be greater than zero");
  }

  if (amountIn > UINT128_MAX) {
    throw new Error("Amount in exceeds the LBQuoter uint128 limit");
  }

  assertTokenActionAllowed(registry.tokens, [tokenIn, tokenOut], "swap");

  const paths = buildExactInCandidatePaths(registry.tokens, tokenIn, tokenOut);
  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        return { path, quote: await quoteExactInPath(client, registry, path, amountIn) } as const;
      } catch (error) {
        return { error, path } as const;
      }
    })
  );
  const usable = results.filter((result): result is { path: Address[]; quote: ExactInQuote } => "quote" in result);

  if (usable.length === 0) {
    const directError = results[0] && "error" in results[0] ? results[0].error : null;
    if (paths.length === 1 && directError instanceof Error) throw directError;

    throw new Error(`No executable V2.2 route found${directError instanceof Error ? `: ${directError.message}` : ""}`);
  }

  usable.sort((left, right) => {
    const outputComparison = compareBigints(getQuoteAmountOut(right.quote), getQuoteAmountOut(left.quote));
    if (outputComparison !== 0) return outputComparison;
    if (left.path.length !== right.path.length) return left.path.length - right.path.length;

    return left.path.join(":").localeCompare(right.path.join(":"));
  });

  return usable[0].quote;
}

export function buildExactInCandidatePaths(tokens: TokenMetadataMap, tokenIn: Address, tokenOut: Address): Address[][] {
  if (isAddressEqual(tokenIn, tokenOut)) {
    throw new Error("Swap input and output tokens must differ");
  }

  const seen = new Set<string>();
  const intermediaries = Object.values(tokens)
    .filter(
      (token) =>
        !isAddressEqual(token.address, tokenIn) &&
        !isAddressEqual(token.address, tokenOut) &&
        tokenAllowsAction(token, "swap") &&
        (token.tags.includes("quote") || token.tags.includes("wrapped-native"))
    )
    .filter((token) => {
      const key = token.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.address.toLowerCase().localeCompare(right.address.toLowerCase()))
    .map((token) => token.address);

  return [[tokenIn, tokenOut], ...intermediaries.map((intermediary) => [tokenIn, intermediary, tokenOut])];
}

async function quoteExactInPath(
  client: PublicClient,
  registry: Pick<DexRegistry, "contracts">,
  path: Address[],
  amountIn: bigint
): Promise<ExactInQuote> {
  const quote = (await client.readContract({
    address: registry.contracts.lbQuoter,
    abi: lbQuoterAbi,
    functionName: "findBestPathFromAmountIn",
    args: [path, amountIn]
  })) as ExactInQuote;

  assertQuoteMatchesExactInRequest(quote, {
    amountIn,
    tokenIn: path[0],
    tokenOut: path[path.length - 1]
  });

  if (quote.route.length !== path.length || quote.route.some((token, index) => !isAddressEqual(token, path[index]))) {
    throw new Error("Exact-in quote route does not match the requested token path");
  }

  return quote;
}

function compareBigints(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildExactInSwapPath(quote: ExactInQuote): ExactInPath {
  assertV22ExactInQuote(quote);

  return {
    pairBinSteps: [...quote.binSteps],
    versions: [...quote.versions],
    tokenPath: [...quote.route]
  };
}

export function buildExactInSwapTransaction(
  registry: Pick<DexRegistry, "contracts" | "tokens">,
  quote: ExactInQuote,
  amountIn: bigint,
  amountOutMin: bigint,
  to: Address,
  deadline: bigint
): BuiltSwapTransaction {
  assertTokenActionAllowed(registry.tokens, quote.route, "swap");
  if (quote.amounts[0] !== amountIn) {
    throw new Error("Exact-in swap amount does not match the quote input amount");
  }

  const data = encodeFunctionData({
    abi: lbRouterAbi,
    functionName: "swapExactTokensForTokens",
    args: [amountIn, amountOutMin, buildExactInSwapPath(quote), to, deadline]
  });

  return {
    to: registry.contracts.lbRouter,
    data,
    value: 0n
  };
}

export function getQuoteAmountOut(quote: ExactInQuote): bigint {
  return quote.amounts[quote.amounts.length - 1] ?? 0n;
}

export function calculateAmountOutMin(amountOut: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps > BPS_DENOMINATOR) {
    throw new Error("Slippage must be between 0 and 10000 basis points");
  }

  return (amountOut * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
}

export function estimatePriceImpactBps(quote: ExactInQuote): bigint | null {
  const amountOut = getQuoteAmountOut(quote);
  const virtualOut = quote.virtualAmountsWithoutSlippage[quote.virtualAmountsWithoutSlippage.length - 1] ?? 0n;

  if (virtualOut <= 0n || amountOut >= virtualOut) {
    return 0n;
  }

  return ((virtualOut - amountOut) * BPS_DENOMINATOR) / virtualOut;
}

export function getTotalFeeBps(quote: ExactInQuote): bigint {
  return quote.fees.reduce((total, feeScaled) => total + (feeScaled * BPS_DENOMINATOR) / FEE_SCALE, 0n);
}

export function quoteToRouteSteps(quote: ExactInQuote): ExactInRouteStep[] {
  assertV22ExactInQuote(quote);

  return quote.pairs.map((pair, index) => ({
    tokenIn: quote.route[index],
    tokenOut: quote.route[index + 1],
    pair,
    binStep: quote.binSteps[index],
    version: quote.versions[index],
    amountIn: quote.amounts[index],
    amountOut: quote.amounts[index + 1],
    feeScaled: quote.fees[index] ?? 0n
  }));
}

export function hasUsableRoute(quote: ExactInQuote): boolean {
  try {
    assertV22ExactInQuote(quote);
    return true;
  } catch {
    return false;
  }
}

export function assertV22ExactInQuote(quote: ExactInQuote): void {
  const routeLength = quote.route.length;
  const hopCount = routeLength - 1;

  if (routeLength < 2 || hopCount < 1) {
    throw new Error("V2.2 exact-in quote must contain at least one route hop");
  }

  if (
    quote.pairs.length !== hopCount ||
    quote.binSteps.length !== hopCount ||
    quote.versions.length !== hopCount ||
    quote.fees.length !== hopCount ||
    quote.amounts.length !== routeLength ||
    quote.virtualAmountsWithoutSlippage.length !== routeLength
  ) {
    throw new Error("V2.2 exact-in quote arrays do not match the route hop count");
  }

  if (quote.route.some((token) => token === zeroAddress) || quote.pairs.some((pair) => pair === zeroAddress)) {
    throw new Error("V2.2 exact-in quote contains a zero token or pair address");
  }

  if (quote.versions.some((version) => version !== LB_ROUTER_VERSION_V2_2)) {
    throw new Error("Only V2.2 swap route versions are supported");
  }

  if (quote.amounts[0] <= 0n || getQuoteAmountOut(quote) <= 0n) {
    throw new Error("V2.2 exact-in quote must contain positive input and output amounts");
  }
}

export function assertQuoteMatchesExactInRequest(quote: ExactInQuote, request: ExactInQuoteRequest): void {
  assertV22ExactInQuote(quote);

  const quotedTokenIn = quote.route[0];
  const quotedTokenOut = quote.route[quote.route.length - 1];

  if (!isAddressEqual(quotedTokenIn, request.tokenIn)) {
    throw new Error("Exact-in quote route does not start with the requested tokenIn");
  }
  if (!isAddressEqual(quotedTokenOut, request.tokenOut)) {
    throw new Error("Exact-in quote route does not end with the requested tokenOut");
  }
  if (quote.amounts[0] !== request.amountIn) {
    throw new Error("Exact-in quote input amount does not match the requested amountIn");
  }
}

export function deadlineFromNow(minutes: number, nowSeconds = Math.floor(Date.now() / 1000)): bigint {
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < MIN_DEADLINE_MINUTES || minutes > MAX_DEADLINE_MINUTES) {
    throw new Error(`Deadline must be an integer from ${MIN_DEADLINE_MINUTES} to ${MAX_DEADLINE_MINUTES} minutes`);
  }

  return BigInt(Math.floor(nowSeconds + minutes * 60));
}
