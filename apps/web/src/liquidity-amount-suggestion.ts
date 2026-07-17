import {
  DISTRIBUTION_PRECISION,
  MAX_LIQUIDITY_BINS,
  type LiquidityDistribution
} from "@robinhood-lb/sdk/liquidity";
import { Q128, priceQ128FromActiveId } from "../../../packages/sdk/src/liquidity-price";

export type PairedFillSide = "x" | "y";

export type PairedAmountSuggestionReason =
  | "empty-paired-balance"
  | "invalid-distribution"
  | "invalid-source-amount"
  | "missing-paired-balance"
  | "missing-source-balance"
  | "one-sided-range"
  | "rounding-underflow"
  | "source-balance-exceeded";

export interface PairedAmountSuggestion {
  amountX: bigint;
  amountY: bigint;
  clamped: boolean;
  mode: LiquidityDistribution["mode"];
  pairedAmount: bigint;
  pairedSide: PairedFillSide;
  reason: PairedAmountSuggestionReason | null;
  requiredPairedAmount: bigint | null;
  sourceAmount: bigint | null;
  sourceSide: PairedFillSide;
  status: "ready" | "unavailable";
  weightedPriceQ128: bigint | null;
}

export interface PairedAmountSuggestionInput {
  balanceX: bigint | null;
  balanceY: bigint | null;
  binStep: bigint | number;
  distribution: LiquidityDistribution | null;
  sourceAmount: bigint | null;
  sourceSide: PairedFillSide;
}

/**
 * Calculates only the token opposite the user's source field.
 *
 * The source raw amount is never changed. The paired raw amount is derived
 * with exact bigint/Q128 floor arithmetic and may be clamped to the opposite
 * wallet balance. This helper performs no quote, swap, or state mutation.
 */
export function suggestPairedLiquidityAmounts(input: PairedAmountSuggestionInput): PairedAmountSuggestion {
  const mode = input.distribution?.mode ?? "balanced";
  const pairedSide = input.sourceSide === "x" ? "y" : "x";
  if (input.distribution === null || !validDistribution(input.distribution, input.binStep)) {
    return unavailable(input, mode, pairedSide, "invalid-distribution");
  }
  if (mode !== "balanced") return unavailable(input, mode, pairedSide, "one-sided-range");
  if (input.sourceAmount === null || input.sourceAmount <= 0n) {
    return unavailable(input, mode, pairedSide, "invalid-source-amount");
  }

  const sourceBalance = input.sourceSide === "x" ? input.balanceX : input.balanceY;
  const pairedBalance = input.sourceSide === "x" ? input.balanceY : input.balanceX;
  if (sourceBalance === null) return unavailable(input, mode, pairedSide, "missing-source-balance");
  if (input.sourceAmount > sourceBalance) return unavailable(input, mode, pairedSide, "source-balance-exceeded");
  if (pairedBalance === null) return unavailable(input, mode, pairedSide, "missing-paired-balance");
  if (pairedBalance <= 0n) return unavailable(input, mode, pairedSide, "empty-paired-balance");

  try {
    const weightedPriceNumerator = input.distribution.bins.reduce(
      (sum, bin) => sum + bin.distributionX * priceQ128FromActiveId(bin.binId, input.binStep),
      0n
    );
    const valueDenominator = DISTRIBUTION_PRECISION * Q128;
    if (weightedPriceNumerator <= 0n) return unavailable(input, mode, pairedSide, "invalid-distribution");

    const requiredPairedAmount = input.sourceSide === "x"
      ? input.sourceAmount * weightedPriceNumerator / valueDenominator
      : input.sourceAmount * valueDenominator / weightedPriceNumerator;
    if (requiredPairedAmount <= 0n) return unavailable(input, mode, pairedSide, "rounding-underflow");

    const pairedAmount = requiredPairedAmount > pairedBalance ? pairedBalance : requiredPairedAmount;
    if (pairedAmount <= 0n) return unavailable(input, mode, pairedSide, "rounding-underflow");
    const amountX = input.sourceSide === "x" ? input.sourceAmount : pairedAmount;
    const amountY = input.sourceSide === "y" ? input.sourceAmount : pairedAmount;

    return {
      amountX,
      amountY,
      clamped: pairedAmount < requiredPairedAmount,
      mode,
      pairedAmount,
      pairedSide,
      reason: null,
      requiredPairedAmount,
      sourceAmount: input.sourceAmount,
      sourceSide: input.sourceSide,
      status: "ready",
      weightedPriceQ128: weightedPriceNumerator / DISTRIBUTION_PRECISION
    };
  } catch {
    return unavailable(input, mode, pairedSide, "invalid-distribution");
  }
}

function validDistribution(distribution: LiquidityDistribution, binStep: bigint | number): boolean {
  if (distribution.bins.length === 0 || distribution.bins.length > MAX_LIQUIDITY_BINS) return false;
  if (
    distribution.deltaIds.length !== distribution.bins.length ||
    distribution.distributionX.length !== distribution.bins.length ||
    distribution.distributionY.length !== distribution.bins.length
  ) return false;
  try {
    if (typeof binStep === "number" && !Number.isSafeInteger(binStep)) return false;
    const normalizedBinStep = BigInt(binStep);
    if (normalizedBinStep <= 0n || normalizedBinStep > 65_535n) return false;
    if (distribution.strategy !== "spot" && distribution.strategy !== "curve" && distribution.strategy !== "bid-ask") return false;
    let inferredActiveId: bigint | null = null;
    for (let index = 0; index < distribution.bins.length; index += 1) {
      const bin = distribution.bins[index]!;
      const currentActiveId = bin.binId - bin.deltaId;
      if (
        bin.binId < 0n ||
        bin.binId > 16_777_215n ||
        currentActiveId < 0n ||
        currentActiveId > 16_777_215n ||
        (inferredActiveId !== null && currentActiveId !== inferredActiveId) ||
        (index > 0 && bin.deltaId <= distribution.bins[index - 1]!.deltaId) ||
        bin.deltaId !== distribution.deltaIds[index] ||
        bin.distributionX !== distribution.distributionX[index] ||
        bin.distributionY !== distribution.distributionY[index] ||
        bin.distributionX < 0n ||
        bin.distributionY < 0n ||
        bin.distributionX > DISTRIBUTION_PRECISION ||
        bin.distributionY > DISTRIBUTION_PRECISION ||
        (bin.deltaId < 0n && bin.distributionX !== 0n) ||
        (bin.deltaId > 0n && bin.distributionY !== 0n)
      ) return false;
      inferredActiveId = currentActiveId;
      priceQ128FromActiveId(bin.binId, binStep);
    }
  } catch {
    return false;
  }

  const totalX = distribution.bins.reduce((sum, bin) => sum + bin.distributionX, 0n);
  const totalY = distribution.bins.reduce((sum, bin) => sum + bin.distributionY, 0n);
  const firstDelta = distribution.bins[0]!.deltaId;
  const lastDelta = distribution.bins.at(-1)!.deltaId;
  if (distribution.mode === "token-x") {
    return firstDelta > 0n && totalX === DISTRIBUTION_PRECISION && totalY === 0n;
  }
  if (distribution.mode === "token-y") {
    return lastDelta < 0n && totalX === 0n && totalY === DISTRIBUTION_PRECISION;
  }
  if (distribution.mode !== "balanced") return false;
  return firstDelta <= 0n && lastDelta >= 0n && totalX === DISTRIBUTION_PRECISION && totalY === DISTRIBUTION_PRECISION;
}

function unavailable(
  input: Pick<PairedAmountSuggestionInput, "sourceAmount" | "sourceSide">,
  mode: LiquidityDistribution["mode"],
  pairedSide: PairedFillSide,
  reason: PairedAmountSuggestionReason
): PairedAmountSuggestion {
  return {
    amountX: 0n,
    amountY: 0n,
    clamped: false,
    mode,
    pairedAmount: 0n,
    pairedSide,
    reason,
    requiredPairedAmount: null,
    sourceAmount: input.sourceAmount,
    sourceSide: input.sourceSide,
    status: "unavailable",
    weightedPriceQ128: null
  };
}
