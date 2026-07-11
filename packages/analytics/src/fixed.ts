export const USD_SCALE = 10n ** 18n;
export const BPS_SCALE = 10_000n;

export function pow10(decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }

  return 10n ** BigInt(decimals);
}

export function mulDiv(value: bigint, multiplier: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  return (value * multiplier) / denominator;
}

export function tokenAmountToUsd(amount: bigint, decimals: number, priceUsdE18: bigint): bigint {
  return mulDiv(amount, priceUsdE18, pow10(decimals));
}

export function ratioE18(numerator: bigint, denominator: bigint): bigint | null {
  return denominator === 0n ? null : mulDiv(numerator, USD_SCALE, denominator);
}
