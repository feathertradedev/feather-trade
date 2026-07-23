import { isAddress, type Address } from "viem";

export interface TrustedPoolCreationPrice {
  baseToken: Address;
  quoteToken: Address;
  quotePerBaseE18: string;
  baseSource: string;
  quoteSource: string;
  baseObservedAt: number;
  quoteObservedAt: number;
  baseAgeSeconds: number;
  quoteAgeSeconds: number;
  asOfBlock: string;
  asOfBlockHash: string;
  asOfTimestamp: number;
}

export interface TrustedPoolCreationPriceResult {
  price: TrustedPoolCreationPrice | null;
  reason: "available" | "not-configured" | "unavailable" | "stale";
  detail: string | null;
}

// A READY response is authoritative only at the moment it is returned. Keep
// the browser cache short-lived so a backgrounded creation form cannot present
// an indefinitely frozen oracle suggestion.
export const TRUSTED_POOL_CREATION_PRICE_CLIENT_TTL_MS = 30_000;

const TRUSTED_PAIR_PRICE_QUERY = `
  query PoolCreationTrustedPairPrice($baseToken: ID!, $quoteToken: ID!) {
    trustedPairPrice(baseToken: $baseToken, quoteToken: $quoteToken) {
      baseToken quoteToken quotePerBaseE18 status
      baseSource quoteSource baseObservedAt quoteObservedAt baseAgeSeconds quoteAgeSeconds
      asOfBlock asOfBlockHash asOfTimestamp
    }
  }
`;

export async function loadTrustedPoolCreationPrice(
  endpoint: string | null,
  baseToken: Address,
  quoteToken: Address,
  timeoutMs = 8_000
): Promise<TrustedPoolCreationPriceResult> {
  if (endpoint === null) {
    return { price: null, reason: "not-configured", detail: "Trusted pricing is not configured for this environment." };
  }
  if (!isAddress(baseToken, { strict: false }) || !isAddress(quoteToken, { strict: false })) {
    throw new Error("Trusted price tokens must be valid addresses");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new Error("Trusted price timeout must be between 1 and 30000 milliseconds");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: TRUSTED_PAIR_PRICE_QUERY,
        variables: { baseToken, quoteToken }
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Trusted pricing returned HTTP ${response.status}`);
    const payload = asRecord(await response.json(), "trusted pricing response");
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(payload.errors.map((error) => String(asRecord(error, "GraphQL error").message ?? "GraphQL error")).join("; "));
    }
    const data = asRecord(payload.data, "trusted pricing data");
    const row = asRecord(data.trustedPairPrice, "trusted pair price");
    const status = parseString(row.status, "status");
    if (status !== "READY") {
      return {
        price: null,
        reason: status === "PARTIAL" ? "stale" : "unavailable",
        detail: status === "PARTIAL"
          ? "Trusted price samples are stale or incomplete. Enter the initial price explicitly and verify it independently."
          : "No current trusted price is available. Enter the initial price explicitly and verify it independently."
      };
    }

    const price: TrustedPoolCreationPrice = {
      baseToken: parseAddress(row.baseToken, "baseToken"),
      quoteToken: parseAddress(row.quoteToken, "quoteToken"),
      quotePerBaseE18: parseUnsignedDecimal(row.quotePerBaseE18, "quotePerBaseE18"),
      baseSource: parseNonemptyString(row.baseSource, "baseSource"),
      quoteSource: parseNonemptyString(row.quoteSource, "quoteSource"),
      baseObservedAt: parseTimestamp(row.baseObservedAt, "baseObservedAt"),
      quoteObservedAt: parseTimestamp(row.quoteObservedAt, "quoteObservedAt"),
      baseAgeSeconds: parseAge(row.baseAgeSeconds, "baseAgeSeconds"),
      quoteAgeSeconds: parseAge(row.quoteAgeSeconds, "quoteAgeSeconds"),
      asOfBlock: parseUnsignedDecimal(row.asOfBlock, "asOfBlock"),
      asOfBlockHash: parseBlockHash(row.asOfBlockHash),
      asOfTimestamp: parseTimestamp(row.asOfTimestamp, "asOfTimestamp")
    };
    if (price.baseToken.toLowerCase() !== baseToken.toLowerCase() || price.quoteToken.toLowerCase() !== quoteToken.toLowerCase()) {
      throw new Error("Trusted pricing returned a different token pair");
    }
    if (BigInt(price.quotePerBaseE18) === 0n) throw new Error("Trusted quote/base price must be positive");
    return { price, reason: "available", detail: null };
  } catch (error) {
    return {
      price: null,
      reason: "unavailable",
      detail: controller.signal.aborted
        ? `Trusted pricing timed out after ${timeoutMs}ms. Enter the price explicitly and verify it independently.`
        : `${error instanceof Error ? error.message : String(error)}. Enter the price explicitly and verify it independently.`
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function trustedPriceDeviationBps(input: string, trustedQuotePerBaseE18: string): bigint | null {
  const typed = decimalToE18(input);
  if (typed === null) return null;
  const trusted = BigInt(trustedQuotePerBaseE18);
  if (trusted <= 0n) return null;
  return absoluteDifference(typed, trusted) * 10_000n / trusted;
}

export function trustedPoolCreationPriceIsLocallyFresh(
  fetchedAt: number,
  now = Date.now(),
  ttlMs = TRUSTED_POOL_CREATION_PRICE_CLIENT_TTL_MS
): boolean {
  if (
    !Number.isSafeInteger(fetchedAt) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(ttlMs) ||
    fetchedAt <= 0 ||
    ttlMs <= 0
  ) return false;
  const elapsed = now - fetchedAt;
  return elapsed >= 0 && elapsed <= ttlMs;
}

export function trustedPoolCreationPriceLocalAgeSeconds(
  price: TrustedPoolCreationPrice,
  fetchedAt: number,
  now = Date.now()
): number {
  const serverAge = Math.max(price.baseAgeSeconds, price.quoteAgeSeconds);
  if (!Number.isSafeInteger(fetchedAt) || !Number.isSafeInteger(now) || fetchedAt <= 0 || now < fetchedAt) {
    return serverAge;
  }
  return serverAge + Math.floor((now - fetchedAt) / 1_000);
}

function decimalToE18(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (fraction.length > 18) {
    const discarded = fraction.slice(18);
    if (!/^0*$/.test(discarded)) return null;
  }
  const normalizedFraction = fraction.slice(0, 18).padEnd(18, "0");
  const scaled = BigInt(whole) * 10n ** 18n + BigInt(normalizedFraction || "0");
  return scaled > 0n ? scaled : null;
}

function absoluteDifference(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error(`Invalid ${label}`);
  return value.toLowerCase() as Address;
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return value;
}

function parseNonemptyString(value: unknown, label: string): string {
  const parsed = parseString(value, label).trim();
  if (parsed.length === 0 || parsed.length > 128) throw new Error(`Invalid ${label}`);
  return parsed;
}

function parseUnsignedDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function parseTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
  return value as number;
}

function parseAge(value: unknown, label: string): number {
  const age = parseTimestamp(value, label);
  if (age > 86_400) throw new Error(`Invalid ${label}`);
  return age;
}

function parseBlockHash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Invalid asOfBlockHash");
  return value.toLowerCase();
}
