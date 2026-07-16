import {
  DISTRIBUTION_PRECISION,
  MAX_LIQUIDITY_BINS,
  type LiquidityDistribution
} from "@robinhood-lb/sdk/liquidity";
import { Q128, priceQ128FromActiveId } from "../../../packages/sdk/src/liquidity-price";

export type PairedAmountSuggestionReason =
  | "empty-balance"
  | "invalid-distribution"
  | "missing-balance"
  | "rounding-underflow";

export interface PairedAmountSuggestion {
  amountX: bigint;
  amountY: bigint;
  limitingSide: "both" | "x" | "y" | null;
  mode: LiquidityDistribution["mode"];
  reason: PairedAmountSuggestionReason | null;
  status: "ready" | "unavailable";
  weightedPriceQ128: bigint | null;
}

export interface PairedAmountSuggestionInput {
  balanceX: bigint | null;
  balanceY: bigint | null;
  binStep: bigint | number;
  distribution: LiquidityDistribution | null;
}

/**
 * Suggests deposit amounts without quoting or mutating execution state.
 *
 * Balanced suggestions equalize the quote-token value of the X and Y sides
 * using exact PriceHelper Q128 prices weighted by the selected X
 * distribution. The largest pair that fits both current balances is returned.
 * One-sided ranges use only the required balance and always zero the unused
 * side. Every result is clamped to the supplied balances.
 */
export function suggestPairedLiquidityAmounts(input: PairedAmountSuggestionInput): PairedAmountSuggestion {
  const mode = input.distribution?.mode ?? "balanced";
  if (input.distribution === null || !validDistribution(input.distribution, input.binStep)) {
    return unavailable(mode, "invalid-distribution");
  }

  if (mode === "token-x") {
    if (input.balanceX === null) return unavailable(mode, "missing-balance");
    if (input.balanceX <= 0n) return unavailable(mode, "empty-balance");
    return ready(mode, input.balanceX, 0n, "x", null);
  }

  if (mode === "token-y") {
    if (input.balanceY === null) return unavailable(mode, "missing-balance");
    if (input.balanceY <= 0n) return unavailable(mode, "empty-balance");
    return ready(mode, 0n, input.balanceY, "y", null);
  }

  if (input.balanceX === null || input.balanceY === null) return unavailable(mode, "missing-balance");
  if (input.balanceX <= 0n || input.balanceY <= 0n) return unavailable(mode, "empty-balance");

  try {
    const weightedPriceNumerator = input.distribution.bins.reduce(
      (sum, bin) => sum + bin.distributionX * priceQ128FromActiveId(bin.binId, input.binStep),
      0n
    );
    const valueDenominator = DISTRIBUTION_PRECISION * Q128;
    if (weightedPriceNumerator <= 0n) return unavailable(mode, "invalid-distribution");

    const xCapacityFromY = input.balanceY * valueDenominator / weightedPriceNumerator;
    const amountX = input.balanceX < xCapacityFromY ? input.balanceX : xCapacityFromY;
    const amountY = amountX * weightedPriceNumerator / valueDenominator;
    if (amountX <= 0n || amountY <= 0n) return unavailable(mode, "rounding-underflow");
    if (amountX > input.balanceX || amountY > input.balanceY) return unavailable(mode, "invalid-distribution");

    const limitingSide = amountX === input.balanceX && amountY === input.balanceY
      ? "both"
      : amountX === input.balanceX
        ? "x"
        : "y";
    return ready(
      mode,
      amountX,
      amountY,
      limitingSide,
      weightedPriceNumerator / DISTRIBUTION_PRECISION
    );
  } catch {
    return unavailable(mode, "invalid-distribution");
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
    for (let index = 0; index < distribution.bins.length; index += 1) {
      const bin = distribution.bins[index]!;
      if (
        bin.binId < 0n ||
        bin.binId > 16_777_215n ||
        bin.deltaId !== distribution.deltaIds[index] ||
        bin.distributionX !== distribution.distributionX[index] ||
        bin.distributionY !== distribution.distributionY[index] ||
        bin.distributionX < 0n ||
        bin.distributionY < 0n ||
        bin.distributionX > DISTRIBUTION_PRECISION ||
        bin.distributionY > DISTRIBUTION_PRECISION
      ) return false;
      priceQ128FromActiveId(bin.binId, binStep);
    }
  } catch {
    return false;
  }

  const totalX = distribution.bins.reduce((sum, bin) => sum + bin.distributionX, 0n);
  const totalY = distribution.bins.reduce((sum, bin) => sum + bin.distributionY, 0n);
  if (distribution.mode === "token-x") return totalX === DISTRIBUTION_PRECISION && totalY === 0n;
  if (distribution.mode === "token-y") return totalX === 0n && totalY === DISTRIBUTION_PRECISION;
  return totalX === DISTRIBUTION_PRECISION && totalY === DISTRIBUTION_PRECISION;
}

function ready(
  mode: LiquidityDistribution["mode"],
  amountX: bigint,
  amountY: bigint,
  limitingSide: "both" | "x" | "y",
  weightedPriceQ128: bigint | null
): PairedAmountSuggestion {
  return { amountX, amountY, limitingSide, mode, reason: null, status: "ready", weightedPriceQ128 };
}

function unavailable(
  mode: LiquidityDistribution["mode"],
  reason: PairedAmountSuggestionReason
): PairedAmountSuggestion {
  return {
    amountX: 0n,
    amountY: 0n,
    limitingSide: null,
    mode,
    reason,
    status: "unavailable",
    weightedPriceQ128: null
  };
}
