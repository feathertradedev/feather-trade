import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";

import { lbRouterAbi } from "./abi.js";
import type { DexRegistry, LocalnetDexRegistry } from "./registry.js";

export const DISTRIBUTION_PRECISION = 1_000_000_000_000_000_000n;
export const MAX_LIQUIDITY_BINS = 69;
export const MAX_SAFE_ID_SLIPPAGE = 2n;
export const DEFAULT_BURN_SLIPPAGE_BPS = 50n;

const BASIS_POINT_PRECISION = 10_000n;
const MAX_UINT24 = (1n << 24n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const protectedBurnMinimumsBrand = Symbol("ProtectedBurnMinimums");

export interface SwapOutQuote {
  pair: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountInLeft: bigint;
  amountOut: bigint;
  fee: bigint;
}

export interface AddLiquidityCalldataInput {
  tokenX: Address;
  tokenY: Address;
  binStep: bigint | number;
  amountX: bigint;
  amountY: bigint;
  amountXMin?: bigint;
  amountYMin?: bigint;
  activeIdDesired: bigint | number;
  idSlippage?: bigint | number;
  deltaIds?: bigint[];
  distributionX?: bigint[];
  distributionY?: bigint[];
  to: Address;
  refundTo?: Address;
  deadline: bigint;
}

export interface RemoveLiquidityCalldataInput {
  tokenX: Address;
  tokenY: Address;
  binStep: bigint | number;
  minimums: ProtectedBurnMinimums;
  ids: bigint[];
  amounts: bigint[];
  to: Address;
  deadline: bigint;
}

export interface LiveBurnBinInput {
  binId: bigint;
  amountToBurn: bigint;
  reserveX: bigint;
  reserveY: bigint;
  totalSupply: bigint;
}

export interface LiquidityBurnBinQuote extends LiveBurnBinInput {
  amountXOut: bigint;
  amountYOut: bigint;
}

export interface LiquidityBurnQuote {
  bins: LiquidityBurnBinQuote[];
  amountXOut: bigint;
  amountYOut: bigint;
}

export interface ProtectedBurnMinimums {
  expectedAmountXOut: bigint;
  expectedAmountYOut: bigint;
  amountXMin: bigint;
  amountYMin: bigint;
  slippageBps: bigint;
  readonly [protectedBurnMinimumsBrand]: true;
}

/** @deprecated Prefer the explicit ProtectedBurnMinimums name. */
export type LiquidityBurnMinimums = ProtectedBurnMinimums;

export interface LiquidityDistributionBin {
  binId: bigint;
  deltaId: bigint;
  distributionX: bigint;
  distributionY: bigint;
}

export interface LiquidityDistribution {
  strategy: LiquidityStrategy;
  mode: "balanced" | "token-x" | "token-y";
  deltaIds: bigint[];
  distributionX: bigint[];
  distributionY: bigint[];
  bins: LiquidityDistributionBin[];
}

export type LiquidityStrategy = "spot" | "curve" | "bid-ask";

export interface BuiltTransaction {
  to: Address;
  data: Hex;
  value: bigint;
}

export async function getSwapOutQuote(
  client: PublicClient,
  registry: LocalnetDexRegistry,
  amountIn: bigint
): Promise<SwapOutQuote> {
  const pool = registry.seededPools.wnativeUsdc;
  const [amountInLeft, amountOut, fee] = await client.readContract({
    address: registry.contracts.lbRouter,
    abi: lbRouterAbi,
    functionName: "getSwapOut",
    args: [pool.pair, amountIn, true]
  });

  return {
    pair: pool.pair,
    tokenIn: pool.tokenX,
    tokenOut: pool.tokenY,
    amountIn,
    amountInLeft,
    amountOut,
    fee
  };
}

export function buildAddLiquidityTransaction(
  registry: Pick<DexRegistry, "contracts">,
  input: AddLiquidityCalldataInput
): BuiltTransaction {
  const deltaIds = input.deltaIds ?? [0n];
  const distributionX = input.distributionX ?? [DISTRIBUTION_PRECISION];
  const distributionY = input.distributionY ?? [DISTRIBUTION_PRECISION];
  const idSlippage = normalizeSafeIdSlippage(input.idSlippage);

  assertMatchingArrayLengths(deltaIds, distributionX, distributionY);
  assertLiquidityAmountsMatchDistribution(
    input.amountX,
    input.amountY,
    input.amountXMin ?? 0n,
    input.amountYMin ?? 0n,
    distributionX,
    distributionY
  );

  const data = encodeFunctionData({
    abi: lbRouterAbi,
    functionName: "addLiquidity",
    args: [
      {
        tokenX: input.tokenX,
        tokenY: input.tokenY,
        binStep: BigInt(input.binStep),
        amountX: input.amountX,
        amountY: input.amountY,
        amountXMin: input.amountXMin ?? 0n,
        amountYMin: input.amountYMin ?? 0n,
        activeIdDesired: BigInt(input.activeIdDesired),
        idSlippage,
        deltaIds,
        distributionX,
        distributionY,
        to: input.to,
        refundTo: input.refundTo ?? input.to,
        deadline: input.deadline
      }
    ]
  });

  return {
    to: registry.contracts.lbRouter,
    data,
    value: 0n
  };
}

export function normalizeSafeIdSlippage(value: bigint | number | undefined): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("idSlippage must be a safe integer from 0 to 2 bins");
  }

  const normalized = BigInt(value ?? 0);
  assertSafeIdSlippage(normalized);
  return normalized;
}

export function assertSafeIdSlippage(value: bigint): void {
  if (value > MAX_SAFE_ID_SLIPPAGE) {
    throw new Error("idSlippage above 2 bins requires release-owner approval");
  }
  if (value < 0n) {
    throw new Error("idSlippage must be from 0 to 2 bins");
  }
}

export function buildSeededWnativeUsdcAddLiquidityTransaction(
  registry: LocalnetDexRegistry,
  input: Omit<AddLiquidityCalldataInput, "tokenX" | "tokenY" | "binStep" | "activeIdDesired">
): BuiltTransaction {
  const pool = registry.seededPools.wnativeUsdc;

  return buildAddLiquidityTransaction(registry, {
    ...input,
    tokenX: pool.tokenX,
    tokenY: pool.tokenY,
    binStep: pool.binStep,
    activeIdDesired: pool.activeId
  });
}

export function buildRemoveLiquidityTransaction(
  registry: Pick<DexRegistry, "contracts">,
  input: RemoveLiquidityCalldataInput
): BuiltTransaction {
  if (input.ids.length === 0 || input.ids.length !== input.amounts.length) {
    throw new Error("Remove liquidity ids and amounts must be non-empty and have matching lengths");
  }
  assertProtectedBurnMinimums(input.minimums);

  const data = encodeFunctionData({
    abi: lbRouterAbi,
    functionName: "removeLiquidity",
    args: [
      input.tokenX,
      input.tokenY,
      Number(input.binStep),
      input.minimums.amountXMin,
      input.minimums.amountYMin,
      input.ids,
      input.amounts,
      input.to,
      input.deadline
    ]
  });

  return {
    to: registry.contracts.lbRouter,
    data,
    value: 0n
  };
}

export function assertProtectedBurnMinimums(minimums: ProtectedBurnMinimums): void {
  if (
    typeof minimums !== "object" ||
    minimums === null ||
    minimums[protectedBurnMinimumsBrand] !== true
  ) {
    throw new Error("Burn output minimums must be created by buildProtectedBurnMinimums");
  }

  const rebuilt = buildProtectedBurnMinimums(
    minimums.expectedAmountXOut,
    minimums.expectedAmountYOut,
    minimums.slippageBps
  );

  if (minimums.amountXMin !== rebuilt.amountXMin || minimums.amountYMin !== rebuilt.amountYMin) {
    throw new Error("Burn output minimums do not match their bound expected outputs and slippage");
  }
}

export function buildSeededWnativeUsdcRemoveLiquidityTransaction(
  registry: LocalnetDexRegistry,
  input: Omit<RemoveLiquidityCalldataInput, "tokenX" | "tokenY" | "binStep">
): BuiltTransaction {
  const pool = registry.seededPools.wnativeUsdc;

  return buildRemoveLiquidityTransaction(registry, {
    ...input,
    tokenX: pool.tokenX,
    tokenY: pool.tokenY,
    binStep: pool.binStep
  });
}

/**
 * Reproduces LBPair/BinHelper burn accounting from live per-bin state.
 * Each token side is rounded down independently before selected bins are aggregated.
 */
export function quoteLiquidityBurn(bins: readonly LiveBurnBinInput[]): LiquidityBurnQuote {
  if (bins.length === 0) {
    throw new Error("At least one live bin is required to quote a liquidity burn");
  }

  const seenBinIds = new Set<bigint>();
  const quotedBins = bins.map((bin) => {
    assertUnsignedWithin(bin.binId, MAX_UINT24, "binId");
    assertUnsignedWithin(bin.reserveX, MAX_UINT128, "reserveX");
    assertUnsignedWithin(bin.reserveY, MAX_UINT128, "reserveY");
    assertUnsignedWithin(bin.totalSupply, MAX_UINT256, "totalSupply");
    assertUnsignedWithin(bin.amountToBurn, MAX_UINT256, "amountToBurn");

    if (seenBinIds.has(bin.binId)) {
      throw new Error(`Duplicate burn bin id ${bin.binId.toString()}`);
    }
    seenBinIds.add(bin.binId);

    if (bin.totalSupply === 0n) {
      throw new Error(`Burn bin ${bin.binId.toString()} has zero total supply`);
    }
    if (bin.amountToBurn === 0n || bin.amountToBurn > bin.totalSupply) {
      throw new Error(`Burn amount for bin ${bin.binId.toString()} must be nonzero and no greater than total supply`);
    }

    const amountXOut = (bin.amountToBurn * bin.reserveX) / bin.totalSupply;
    const amountYOut = (bin.amountToBurn * bin.reserveY) / bin.totalSupply;
    if (amountXOut === 0n && amountYOut === 0n) {
      throw new Error(`Burn amount for bin ${bin.binId.toString()} rounds both outputs to zero`);
    }

    return { ...bin, amountXOut, amountYOut };
  });

  const amountXOut = quotedBins.reduce((total, bin) => total + bin.amountXOut, 0n);
  const amountYOut = quotedBins.reduce((total, bin) => total + bin.amountYOut, 0n);
  assertUnsignedWithin(amountXOut, MAX_UINT128, "aggregate amountXOut");
  assertUnsignedWithin(amountYOut, MAX_UINT128, "aggregate amountYOut");

  return { bins: quotedBins, amountXOut, amountYOut };
}

/**
 * Creates an opaque minimum set bound to the expected outputs and selected slippage.
 * Every nonzero expected side is guaranteed to retain a nonzero minimum.
 */
export function buildProtectedBurnMinimums(
  expectedAmountXOut: bigint,
  expectedAmountYOut: bigint,
  slippageBps: bigint = DEFAULT_BURN_SLIPPAGE_BPS
): ProtectedBurnMinimums {
  if (slippageBps < 0n || slippageBps >= BASIS_POINT_PRECISION) {
    throw new Error("Burn slippage must be between 0 and 9999 basis points");
  }

  assertUnsignedWithin(expectedAmountXOut, MAX_UINT128, "expectedAmountXOut");
  assertUnsignedWithin(expectedAmountYOut, MAX_UINT128, "expectedAmountYOut");
  if (expectedAmountXOut === 0n && expectedAmountYOut === 0n) {
    throw new Error("At least one expected burn output must be nonzero");
  }

  const minimums = {
    expectedAmountXOut,
    expectedAmountYOut,
    amountXMin: applyNonzeroSlippageMinimum(expectedAmountXOut, slippageBps),
    amountYMin: applyNonzeroSlippageMinimum(expectedAmountYOut, slippageBps),
    slippageBps
  };

  Object.defineProperty(minimums, protectedBurnMinimumsBrand, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  });

  return Object.freeze(minimums) as ProtectedBurnMinimums;
}

/** Applies slippage while returning minimums branded to the quote's expected outputs. */
export function applyBurnQuoteSlippage(
  quote: Pick<LiquidityBurnQuote, "amountXOut" | "amountYOut">,
  slippageBps: bigint = DEFAULT_BURN_SLIPPAGE_BPS
): ProtectedBurnMinimums {
  return buildProtectedBurnMinimums(quote.amountXOut, quote.amountYOut, slippageBps);
}

export function buildLiquidityDistribution(
  activeId: bigint | number,
  lowerDelta: number,
  upperDelta: number,
  strategy: LiquidityStrategy = "spot"
): LiquidityDistribution {
  if (!Number.isInteger(lowerDelta) || !Number.isInteger(upperDelta)) {
    throw new Error("Liquidity range deltas must be integers");
  }

  if (lowerDelta > upperDelta) {
    throw new Error("Lower bin delta must be less than or equal to upper bin delta");
  }

  const count = upperDelta - lowerDelta + 1;
  if (count <= 0 || count > MAX_LIQUIDITY_BINS) {
    throw new Error(`Liquidity range must include between 1 and ${MAX_LIQUIDITY_BINS} bins`);
  }
  if (strategy !== "spot" && strategy !== "curve" && strategy !== "bid-ask") throw new Error("Unknown liquidity strategy");

  const deltas = Array.from({ length: count }, (_, index) => lowerDelta + index);
  const normalizedActiveId = BigInt(activeId);
  assertUnsignedWithin(normalizedActiveId, MAX_UINT24, "activeId");
  if (normalizedActiveId + BigInt(lowerDelta) < 0n || normalizedActiveId + BigInt(upperDelta) > MAX_UINT24) {
    throw new Error("Liquidity range exceeds uint24 bin bounds");
  }
  const xDeltas = deltas.filter((delta) => delta >= 0);
  const yDeltas = deltas.filter((delta) => delta <= 0);
  const xWeights = strategyDistribution(xDeltas, strategy);
  const yWeights = strategyDistribution(yDeltas, strategy);
  let xIndex = 0;
  let yIndex = 0;

  const bins = deltas.map((delta) => {
    const distributionX = delta >= 0 ? xWeights[xIndex++] : 0n;
    const distributionY = delta <= 0 ? yWeights[yIndex++] : 0n;
    const deltaId = BigInt(delta);

    return {
      binId: normalizedActiveId + deltaId,
      deltaId,
      distributionX,
      distributionY
    };
  });

  return {
    strategy,
    mode: lowerDelta > 0 ? "token-x" : upperDelta < 0 ? "token-y" : "balanced",
    deltaIds: bins.map((bin) => bin.deltaId),
    distributionX: bins.map((bin) => bin.distributionX),
    distributionY: bins.map((bin) => bin.distributionY),
    bins
  };
}

export function applyLiquiditySlippageMin(amount: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps > 10_000n) {
    throw new Error("Slippage must be between 0 and 10000 basis points");
  }

  return (amount * (10_000n - slippageBps)) / 10_000n;
}

function applyNonzeroSlippageMinimum(amount: bigint, slippageBps: bigint): bigint {
  if (amount === 0n) return 0n;

  const minimum = (amount * (BASIS_POINT_PRECISION - slippageBps)) / BASIS_POINT_PRECISION;
  return minimum === 0n ? 1n : minimum;
}

function assertUnsignedWithin(value: bigint, maximum: bigint, field: string): void {
  if (value < 0n || value > maximum) {
    throw new Error(`${field} must be an unsigned integer no greater than ${maximum.toString()}`);
  }
}

function equalDistribution(count: number): bigint[] {
  if (count <= 0) return [];

  const base = DISTRIBUTION_PRECISION / BigInt(count);
  const remainder = DISTRIBUTION_PRECISION - base * BigInt(count);

  return Array.from({ length: count }, (_, index) => base + (index === count - 1 ? remainder : 0n));
}

function strategyDistribution(deltas: number[], strategy: LiquidityStrategy): bigint[] {
  if (strategy === "spot") return equalDistribution(deltas.length);
  const distances = deltas.map((delta) => Math.abs(delta));
  const maximumDistance = Math.max(...distances, 0);
  const rawWeights = distances.map((distance) => {
    const base = strategy === "curve" ? maximumDistance - distance + 1 : distance + 1;
    return BigInt(base * base);
  });
  return normalizeDistribution(rawWeights);
}

function normalizeDistribution(rawWeights: bigint[]): bigint[] {
  if (rawWeights.length === 0) return [];
  const total = rawWeights.reduce((sum, weight) => sum + weight, 0n);
  const weights = rawWeights.map((weight) => (DISTRIBUTION_PRECISION * weight) / total);
  const remainder = DISTRIBUTION_PRECISION - weights.reduce((sum, weight) => sum + weight, 0n);
  weights[weights.length - 1] += remainder;
  return weights;
}

function assertMatchingArrayLengths(deltaIds: bigint[], distributionX: bigint[], distributionY: bigint[]): void {
  if (deltaIds.length === 0 || deltaIds.length !== distributionX.length || deltaIds.length !== distributionY.length) {
    throw new Error("Liquidity distribution arrays must be non-empty and have matching lengths");
  }
  if (deltaIds.length > MAX_LIQUIDITY_BINS) {
    throw new Error(`Liquidity distribution must include at most ${MAX_LIQUIDITY_BINS} bins`);
  }
}

function assertLiquidityAmountsMatchDistribution(
  amountX: bigint,
  amountY: bigint,
  amountXMin: bigint,
  amountYMin: bigint,
  distributionX: bigint[],
  distributionY: bigint[]
): void {
  const totalX = distributionX.reduce((total, weight) => total + weight, 0n);
  const totalY = distributionY.reduce((total, weight) => total + weight, 0n);

  for (const weight of [...distributionX, ...distributionY]) {
    if (weight < 0n || weight > DISTRIBUTION_PRECISION) {
      throw new Error("Liquidity distribution weights must be between zero and distribution precision");
    }
  }
  if (totalX > DISTRIBUTION_PRECISION) {
    throw new Error("Token X liquidity distribution must not exceed distribution precision");
  }
  if (totalY > DISTRIBUTION_PRECISION) {
    throw new Error("Token Y liquidity distribution must not exceed distribution precision");
  }
  if (totalX === 0n && totalY === 0n) {
    throw new Error("At least one token side must have a nonzero liquidity distribution");
  }
  if (totalX === 0n && (amountX !== 0n || amountXMin !== 0n)) {
    throw new Error("Token X amount and minimum must be zero for a token Y-only liquidity range");
  }
  if (totalY === 0n && (amountY !== 0n || amountYMin !== 0n)) {
    throw new Error("Token Y amount and minimum must be zero for a token X-only liquidity range");
  }
  if ((totalX !== 0n && amountX === 0n) || (totalY !== 0n && amountY === 0n)) {
    throw new Error("Every distributed liquidity side requires a positive token amount");
  }
}
