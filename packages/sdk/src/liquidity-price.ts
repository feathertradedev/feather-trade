import type { Address, PublicClient } from "viem";

import { lbPairAbi } from "./abi.js";

export const Q128 = 1n << 128n;

/** Largest token-decimal value supported by exact price normalization and its bounded decimal grammar. */
export const MAX_TOKEN_DECIMALS = 36;

const MAX_UINT24 = (1n << 24n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_DECIMAL_DIGITS = 256;

export interface ExactPriceFraction {
  numerator: bigint;
  denominator: bigint;
}

export interface LiquidityPriceOptions {
  baseDecimals: number;
  inverse?: boolean;
  quoteDecimals: number;
}

export interface LiquidityPriceReadOptions {
  blockNumber?: bigint;
}

export function normalizeQ128Price(
  priceQ128: bigint,
  options: LiquidityPriceOptions
): ExactPriceFraction {
  assertUint256(priceQ128, "priceQ128");
  if (priceQ128 === 0n) throw new Error("priceQ128 must be nonzero");
  const baseScale = decimalScale(options.baseDecimals, "baseDecimals");
  const quoteScale = decimalScale(options.quoteDecimals, "quoteDecimals");

  return options.inverse === true
    ? reduceFraction(Q128 * quoteScale, priceQ128 * baseScale)
    : reduceFraction(priceQ128 * baseScale, Q128 * quoteScale);
}

export function decimalPriceToQ128(
  value: string,
  options: LiquidityPriceOptions
): bigint {
  const displayPrice = parseDecimalFraction(value);
  const baseScale = decimalScale(options.baseDecimals, "baseDecimals");
  const quoteScale = decimalScale(options.quoteDecimals, "quoteDecimals");
  const numerator = options.inverse === true
    ? displayPrice.denominator * quoteScale * Q128
    : displayPrice.numerator * quoteScale * Q128;
  const denominator = options.inverse === true
    ? displayPrice.numerator * baseScale
    : displayPrice.denominator * baseScale;
  const priceQ128 = numerator / denominator;

  if (priceQ128 === 0n) throw new Error("decimal price is below the representable Q128 range");
  assertUint256(priceQ128, "priceQ128");
  return priceQ128;
}

export function formatExactPriceFraction(
  price: ExactPriceFraction,
  maximumFractionDigits = MAX_DECIMAL_DIGITS - 2
): string {
  if (price.numerator <= 0n || price.denominator <= 0n) {
    throw new Error("price fraction must be positive");
  }
  if (!Number.isSafeInteger(maximumFractionDigits) || maximumFractionDigits < 0 || maximumFractionDigits > MAX_DECIMAL_DIGITS - 2) {
    throw new Error(`maximumFractionDigits must be an integer from 0 to ${MAX_DECIMAL_DIGITS - 2}`);
  }

  const whole = price.numerator / price.denominator;
  const wholeString = whole.toString();
  if (wholeString.length > MAX_DECIMAL_DIGITS) {
    throw new Error("price exceeds the decimal input length limit");
  }
  let remainder = price.numerator % price.denominator;
  if (remainder === 0n) return wholeString;

  const availableFractionDigits = Math.max(0, MAX_DECIMAL_DIGITS - wholeString.length - 1);
  const fractionDigitLimit = Math.min(maximumFractionDigits, availableFractionDigits);
  if (fractionDigitLimit === 0) {
    if (whole === 0n) throw new Error("positive price is below the bounded decimal display range");
    return wholeString;
  }

  let fraction = "";
  for (let index = 0; index < fractionDigitLimit && remainder !== 0n; index += 1) {
    remainder *= 10n;
    fraction += (remainder / price.denominator).toString();
    remainder %= price.denominator;
  }

  const trimmedFraction = fraction.replace(/0+$/, "");
  if (trimmedFraction.length === 0) {
    if (whole === 0n) throw new Error("positive price is below the bounded decimal display range");
    return wholeString;
  }
  return `${wholeString}.${trimmedFraction}`;
}

export async function readPriceFromId(
  client: PublicClient,
  pair: Address,
  id: bigint | number,
  options: LiquidityPriceReadOptions = {}
): Promise<bigint> {
  const normalizedId = normalizeUint24(id, "id");
  const price = await client.readContract({
    address: pair,
    abi: lbPairAbi,
    functionName: "getPriceFromId",
    args: [Number(normalizedId)],
    ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber })
  });
  assertUint256(price, "priceQ128");
  if (price === 0n) throw new Error("priceQ128 must be nonzero");
  return price;
}

export async function readIdFromPrice(
  client: PublicClient,
  pair: Address,
  priceQ128: bigint,
  options: LiquidityPriceReadOptions = {}
): Promise<bigint> {
  assertUint256(priceQ128, "priceQ128");
  if (priceQ128 === 0n) throw new Error("priceQ128 must be nonzero");
  const id = await client.readContract({
    address: pair,
    abi: lbPairAbi,
    functionName: "getIdFromPrice",
    args: [priceQ128],
    ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber })
  });
  return normalizeUint24(id, "id");
}

function parseDecimalFraction(value: string): ExactPriceFraction {
  if (value.length === 0 || value.trim() !== value || value.length > MAX_DECIMAL_DIGITS) {
    throw new Error("decimal price must be a trimmed positive decimal string");
  }
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (match === null) throw new Error("decimal price must be a trimmed positive decimal string");
  const fractionDigits = match[2] ?? "";
  const numerator = BigInt(`${match[1]}${fractionDigits}`);
  if (numerator === 0n) throw new Error("decimal price must be greater than zero");
  return reduceFraction(numerator, 10n ** BigInt(fractionDigits.length));
}

function decimalScale(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOKEN_DECIMALS) {
    throw new Error(`${label} must be an integer from 0 to ${MAX_TOKEN_DECIMALS}`);
  }
  return 10n ** BigInt(value);
}

function normalizeUint24(value: bigint | number, label: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`${label} must fit uint24`);
  }
  const normalized = BigInt(value);
  if (normalized < 0n || normalized > MAX_UINT24) throw new Error(`${label} must fit uint24`);
  return normalized;
}

function assertUint256(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`${label} must fit uint256`);
  }
}

function reduceFraction(numerator: bigint, denominator: bigint): ExactPriceFraction {
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}
