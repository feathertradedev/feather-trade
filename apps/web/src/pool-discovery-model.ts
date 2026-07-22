import { isAddress, type Address } from "viem";

import {
  resolveAnalyticsAssetUrl,
  type AnalyticsPage,
  type AnalyticsStatus,
  type PoolDiscoveryAnalytics,
  type PoolDiscoveryHourlyClose,
  type PoolDiscoveryRequest
} from "./analytics-data";
import type { DiscoverablePool, DiscoverableToken } from "./pool-discovery";

export const POOL_DISCOVERY_UNAVAILABLE_VALUE = "-";

export interface PoolDisplayOrientation {
  baseToken: Address;
  quoteToken: Address;
  /** True when tokenY is displayed as base and the canonical Y-per-X price must be inverted. */
  inverted: boolean;
}

export interface PoolDiscoveryLogo {
  kind: "curated" | "provider" | "address";
  src: string | null;
  fallbackLabel: string;
  fallbackColor: string;
}

export interface PoolDiscoveryDisplayToken {
  address: Address;
  symbol: string;
  name: string;
  logo: PoolDiscoveryLogo;
}

export interface PoolDiscoveryMetricDisplay {
  rawE18: string | null;
  display: string;
  available: boolean;
  title: string;
}

export interface PoolSparklinePoint {
  x: number;
  y: number;
  startTimestamp: number;
  valueE18: string;
}

export interface PoolSparklineModel {
  segments: PoolSparklinePoint[][];
  points: PoolSparklinePoint[];
  sourcePointCount: number;
  flat: boolean;
  available: boolean;
  title: string;
}

export interface SparklineInputPoint {
  startTimestamp: number;
  valueE18: string | null;
}

export type PoolDiscoveryDisplayRow<T extends DiscoverablePool = DiscoverablePool> = T & {
  pool: T;
  baseToken: PoolDiscoveryDisplayToken;
  quoteToken: PoolDiscoveryDisplayToken;
  analyticsStatus: AnalyticsStatus;
  analyticsIssue: string | null;
  trend: PoolSparklineModel;
  priceChange24hE18: string | null;
  priceChange24hPct: string;
  priceChangeTitle: string;
  marketCapUsdE18: string | null;
  marketCap: PoolDiscoveryMetricDisplay;
  poolPriceQuotePerBaseE18: string | null;
  poolPrice: PoolDiscoveryMetricDisplay;
  tvlUsdE18: string | null;
  tvl: PoolDiscoveryMetricDisplay;
  lpFees24hUsdE18: string | null;
  lpFees24h: PoolDiscoveryMetricDisplay;
  volume24hUsdE18: string | null;
  volume24h: PoolDiscoveryMetricDisplay;
  feeToTvlE18: string | null;
  marketMetadataSource: string | null;
  marketMetadataFetchedAt: number | null;
};

export function buildPoolDiscoveryRequests<T extends DiscoverablePool>(
  pools: readonly T[]
): PoolDiscoveryRequest[] {
  return pools.map((pool) => ({
    pair: canonicalAddress(pool.address),
    preferredQuoteToken: preferredQuoteToken(pool.tokenXAddress, pool.tokenYAddress, pool.tokenX, pool.tokenY)
  }));
}

export function buildPoolDiscoveryRows<T extends DiscoverablePool>(
  pools: readonly T[],
  analytics: Pick<AnalyticsPage<PoolDiscoveryAnalytics>, "rows" | "status" | "error">,
  analyticsEndpoint: string | null
): PoolDiscoveryDisplayRow<T>[] {
  const byPair = new Map(analytics.rows.map((row) => [row.pair, row]));
  if (byPair.size !== analytics.rows.length) throw new Error("Duplicate pool discovery analytics row");

  return pools.map((pool) => {
    const tokenXAddress = canonicalAddress(pool.tokenXAddress);
    const tokenYAddress = canonicalAddress(pool.tokenYAddress);
    const candidate = byPair.get(canonicalAddress(pool.address)) ?? null;
    const tokenXChainId = pool.tokenX?.chainId ?? null;
    const tokenYChainId = pool.tokenY?.chainId ?? null;
    const poolChainIsConsistent = tokenXChainId === null || tokenYChainId === null || tokenXChainId === tokenYChainId;
    const expectedChainId = tokenXChainId ?? tokenYChainId;
    const identityMatches = candidate !== null &&
      poolChainIsConsistent &&
      candidate.tokenX === tokenXAddress && candidate.tokenY === tokenYAddress &&
      (expectedChainId === null || candidate.chainId === expectedChainId);
    const data = identityMatches ? candidate : null;
    const fallbackOrientation = resolveDisplayOrientation(
      tokenXAddress,
      tokenYAddress,
      pool.tokenX,
      pool.tokenY
    );
    const orientation = data === null
      ? fallbackOrientation
      : {
          baseToken: data.displayBaseToken,
          quoteToken: data.displayQuoteToken,
          inverted: data.displayBaseToken === tokenYAddress
        };
    const baseMetadata = tokenForAddress(pool, orientation.baseToken);
    const quoteMetadata = tokenForAddress(pool, orientation.quoteToken);
    const providerLogo = data?.marketMetadata?.logoPath === null || data?.marketMetadata === null || data === null
      ? null
      : resolveAnalyticsAssetUrl(analyticsEndpoint, data.marketMetadata.logoPath);
    const baseToken = displayToken(
      orientation.baseToken,
      baseMetadata,
      resolveTokenLogo(baseMetadata?.logoURI ?? null, providerLogo, orientation.baseToken)
    );
    const quoteToken = displayToken(
      orientation.quoteToken,
      quoteMetadata,
      resolveTokenLogo(quoteMetadata?.logoURI ?? null, null, orientation.quoteToken)
    );
    const hourlyCloses = data?.hourlyCloses ?? [];
    const trend = normalizeSparkline(hourlyCloses.map((close) => ({
      startTimestamp: close.startTimestamp,
      valueE18: close.closeUsdE18
    })));
    const priceChange24hE18 = data?.priceChange24hE18 ?? null;
    const marketCapUsdE18 = data?.marketMetadata?.marketCapUsdE18 ?? null;
    const poolPriceQuotePerBaseE18 = data?.poolPriceQuotePerBaseE18 ?? null;
    const tvlUsdE18 = data?.tvlUsdE18 ?? null;
    const lpFees24hUsdE18 = data?.lpFees24hUsdE18 ?? null;
    const volume24hUsdE18 = data?.volume24hUsdE18 ?? null;
    const feeToTvlE18 = ratioE18(lpFees24hUsdE18, tvlUsdE18);
    const analyticsIssue = candidate !== null && !identityMatches
      ? "Analytics token identity does not match this pool."
      : candidate === null
        ? analytics.status === "UNAVAILABLE" ? analytics.error ?? "Discovery analytics are unavailable." : null
        : null;

    return {
      ...pool,
      pool,
      baseToken,
      quoteToken,
      analyticsStatus: data?.status ?? (analytics.status === "UNAVAILABLE" ? "UNAVAILABLE" : "PARTIAL"),
      analyticsIssue,
      trend,
      priceChange24hE18,
      priceChange24hPct: formatSignedPercentE18(priceChange24hE18),
      priceChangeTitle: priceChange24hE18 === null
        ? "24h price change is unavailable because there is not enough canonical hourly history."
        : "Change between the oldest and newest canonical hourly close in this 24h window.",
      marketCapUsdE18,
      marketCap: metricDisplay(
        marketCapUsdE18,
        formatCompactUsdE18,
        "Market cap is unavailable from the exact token metadata match."
      ),
      poolPriceQuotePerBaseE18,
      poolPrice: metricDisplay(
        poolPriceQuotePerBaseE18,
        formatPoolPriceE18,
        `Current ${quoteToken.symbol} per ${baseToken.symbol} pool price is unavailable.`
      ),
      tvlUsdE18,
      tvl: metricDisplay(tvlUsdE18, formatCompactUsdE18, "Canonical pool TVL is unavailable."),
      lpFees24hUsdE18,
      lpFees24h: metricDisplay(lpFees24hUsdE18, formatCompactUsdE18, "Canonical 24h LP-net fees are unavailable."),
      volume24hUsdE18,
      volume24h: metricDisplay(volume24hUsdE18, formatCompactUsdE18, "Canonical 24h volume is unavailable."),
      feeToTvlE18,
      marketMetadataSource: data?.marketMetadata?.source ?? null,
      marketMetadataFetchedAt: data?.marketMetadata?.fetchedAt ?? null
    };
  });
}

export function resolveDisplayOrientation(
  tokenXAddress: Address,
  tokenYAddress: Address,
  tokenX: Pick<DiscoverableToken, "tags"> | null,
  tokenY: Pick<DiscoverableToken, "tags"> | null,
  analyticsQuoteToken?: Address | null
): PoolDisplayOrientation {
  const tokenXCanonical = canonicalAddress(tokenXAddress);
  const tokenYCanonical = canonicalAddress(tokenYAddress);
  if (tokenXCanonical === tokenYCanonical) throw new Error("Pool tokens must be distinct");
  let quoteToken: Address;
  if (analyticsQuoteToken !== undefined && analyticsQuoteToken !== null) {
    const analyticsQuote = canonicalAddress(analyticsQuoteToken);
    if (analyticsQuote !== tokenXCanonical && analyticsQuote !== tokenYCanonical) {
      throw new Error("Analytics quote token does not belong to the pool");
    }
    quoteToken = analyticsQuote;
  } else {
    quoteToken = preferredQuoteToken(tokenXCanonical, tokenYCanonical, tokenX, tokenY);
  }
  return quoteToken === tokenYCanonical
    ? { baseToken: tokenXCanonical, quoteToken: tokenYCanonical, inverted: false }
    : { baseToken: tokenYCanonical, quoteToken: tokenXCanonical, inverted: true };
}

/** Converts canonical tokenY-per-tokenX E18 into the chosen quote-per-base orientation. */
export function orientPoolPriceE18(
  canonicalTokenYPerTokenXE18: string | null,
  tokenXAddress: Address,
  tokenYAddress: Address,
  displayQuoteToken: Address
): string | null {
  if (canonicalTokenYPerTokenXE18 === null) return null;
  assertUnsignedDecimal(canonicalTokenYPerTokenXE18, "pool price");
  const tokenX = canonicalAddress(tokenXAddress);
  const tokenY = canonicalAddress(tokenYAddress);
  const quote = canonicalAddress(displayQuoteToken);
  if (quote === tokenY) return BigInt(canonicalTokenYPerTokenXE18) === 0n ? null : canonicalTokenYPerTokenXE18;
  if (quote === tokenX) return invertPriceE18(canonicalTokenYPerTokenXE18);
  throw new Error("Display quote token does not belong to the pool");
}

export function invertPriceE18(valueE18: string | null): string | null {
  if (valueE18 === null) return null;
  assertUnsignedDecimal(valueE18, "pool price");
  const value = BigInt(valueE18);
  if (value === 0n) return null;
  return ((10n ** 18n) ** 2n / value).toString();
}

export function normalizeSparkline(
  input: readonly SparklineInputPoint[],
  expectedStepSeconds = 3_600
): PoolSparklineModel {
  if (!Number.isSafeInteger(expectedStepSeconds) || expectedStepSeconds <= 0) throw new Error("Sparkline step must be positive");
  const ordered = [...input].sort((left, right) => left.startTimestamp - right.startTimestamp);
  const seen = new Set<number>();
  for (const point of ordered) {
    if (!Number.isSafeInteger(point.startTimestamp) || point.startTimestamp < 0) throw new Error("Invalid sparkline timestamp");
    if (seen.has(point.startTimestamp)) throw new Error("Duplicate sparkline timestamp");
    seen.add(point.startTimestamp);
    if (point.valueE18 !== null) assertUnsignedDecimal(point.valueE18, "sparkline value");
  }
  const present = ordered.filter((point): point is { startTimestamp: number; valueE18: string } => point.valueE18 !== null);
  const values = present.map((point) => BigInt(point.valueE18));
  const minimum = values.length === 0 ? null : values.reduce((left, right) => left < right ? left : right);
  const maximum = values.length === 0 ? null : values.reduce((left, right) => left > right ? left : right);
  const firstTimestamp = present[0]?.startTimestamp ?? null;
  const lastTimestamp = present.at(-1)?.startTimestamp ?? null;
  const points = present.map((point) => ({
    x: firstTimestamp === null || lastTimestamp === null || firstTimestamp === lastTimestamp
      ? 50
      : ((point.startTimestamp - firstTimestamp) / (lastTimestamp - firstTimestamp)) * 100,
    y: minimum === null || maximum === null || minimum === maximum
      ? 50
      : Number(((maximum - BigInt(point.valueE18)) * 1_000n) / (maximum - minimum)) / 10,
    startTimestamp: point.startTimestamp,
    valueE18: point.valueE18
  }));
  const byTimestamp = new Map(points.map((point) => [point.startTimestamp, point]));
  const segments: PoolSparklinePoint[][] = [];
  let segment: PoolSparklinePoint[] = [];
  let previousTimestamp: number | null = null;
  for (const source of ordered) {
    const point = byTimestamp.get(source.startTimestamp);
    const gap = source.valueE18 === null ||
      (previousTimestamp !== null && source.startTimestamp - previousTimestamp > expectedStepSeconds);
    if (gap && segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
    if (point !== undefined) {
      segment.push(point);
      previousTimestamp = source.startTimestamp;
    } else {
      previousTimestamp = null;
    }
  }
  if (segment.length > 0) segments.push(segment);
  return {
    segments,
    points,
    sourcePointCount: input.length,
    flat: values.length > 0 && minimum === maximum,
    available: points.length > 0,
    title: points.length === 0
      ? "No canonical hourly price history is available."
      : points.length === 1
        ? "One canonical hourly close is available; more history is needed for a trend."
        : "Canonical hourly USD closes; gaps are left unconnected."
  };
}

export function calculatePriceChange24hE18(points: readonly SparklineInputPoint[]): string | null {
  const present = [...points]
    .filter((point): point is { startTimestamp: number; valueE18: string } => point.valueE18 !== null)
    .sort((left, right) => left.startTimestamp - right.startTimestamp);
  if (present.length < 2) return null;
  const first = BigInt(present[0]!.valueE18);
  const last = BigInt(present.at(-1)!.valueE18);
  if (first === 0n) return null;
  return ((last - first) * 10n ** 18n / first).toString();
}

export function resolveTokenLogo(
  curatedLogoUri: string | null,
  providerProxyUrl: string | null,
  tokenAddress: Address
): PoolDiscoveryLogo {
  const address = canonicalAddress(tokenAddress);
  const curated = curatedLogoUri?.trim() ?? "";
  if (curated.length > 0) return { kind: "curated", src: curated, ...addressFallback(address) };
  if (providerProxyUrl !== null && providerProxyUrl.trim().length > 0) {
    return { kind: "provider", src: providerProxyUrl, ...addressFallback(address) };
  }
  return { kind: "address", src: null, ...addressFallback(address) };
}

export function formatCompactUsdE18(valueE18: string | null): string {
  if (valueE18 === null) return POOL_DISCOVERY_UNAVAILABLE_VALUE;
  return `$${formatCompactE18(valueE18)}`;
}

export function formatPoolPriceE18(valueE18: string | null): string {
  if (valueE18 === null) return POOL_DISCOVERY_UNAVAILABLE_VALUE;
  assertUnsignedDecimal(valueE18, "pool price");
  const value = BigInt(valueE18);
  if (value === 0n) return "0";
  if (value < 10n ** 12n) return "<0.000001";
  if (value >= 1_000n * 10n ** 18n) return formatCompactE18(valueE18);
  const fractionDigits = value < 10n ** 18n ? 6 : value < 100n * 10n ** 18n ? 4 : 2;
  return formatFixedE18(value, fractionDigits);
}

export function formatSignedPercentE18(valueE18: string | null): string {
  if (valueE18 === null) return POOL_DISCOVERY_UNAVAILABLE_VALUE;
  assertSignedDecimal(valueE18, "price change");
  const value = BigInt(valueE18);
  const sign = value > 0n ? "+" : value < 0n ? "-" : "";
  return `${sign}${formatFixedE18(value < 0n ? -value * 100n : value * 100n, 2)}%`;
}

function preferredQuoteToken(
  tokenXAddress: Address,
  tokenYAddress: Address,
  tokenX: Pick<DiscoverableToken, "tags"> | null,
  tokenY: Pick<DiscoverableToken, "tags"> | null
): Address {
  const xScore = quoteScore(tokenX?.tags);
  const yScore = quoteScore(tokenY?.tags);
  return xScore > yScore ? canonicalAddress(tokenXAddress) : canonicalAddress(tokenYAddress);
}

function quoteScore(tags: readonly string[] | undefined): number {
  if (tags?.includes("quote")) return 2;
  return tags?.includes("stablecoin") ? 1 : 0;
}

function tokenForAddress<T extends DiscoverablePool>(pool: T, address: Address): DiscoverableToken | null {
  if (canonicalAddress(pool.tokenXAddress) === address) return pool.tokenX;
  if (canonicalAddress(pool.tokenYAddress) === address) return pool.tokenY;
  return null;
}

function displayToken(address: Address, token: DiscoverableToken | null, logo: PoolDiscoveryLogo): PoolDiscoveryDisplayToken {
  const compact = `${address.slice(0, 6)}...${address.slice(-4)}`;
  return {
    address,
    symbol: token?.symbol?.trim() || compact,
    name: token?.name?.trim() || compact,
    logo
  };
}

function metricDisplay(
  rawE18: string | null,
  formatter: (value: string | null) => string,
  unavailableTitle: string
): PoolDiscoveryMetricDisplay {
  return {
    rawE18,
    display: formatter(rawE18),
    available: rawE18 !== null,
    title: rawE18 === null ? unavailableTitle : "Canonical analytics value."
  };
}

function formatCompactE18(valueE18: string): string {
  assertUnsignedDecimal(valueE18, "compact value");
  const value = BigInt(valueE18);
  if (value > 0n && value < 10n ** 16n) return "<0.01";
  const units = [
    { threshold: 10n ** 30n, suffix: "T" },
    { threshold: 10n ** 27n, suffix: "B" },
    { threshold: 10n ** 24n, suffix: "M" },
    { threshold: 10n ** 21n, suffix: "K" }
  ] as const;
  const unit = units.find((candidate) => value >= candidate.threshold);
  if (unit === undefined) return formatFixedE18(value, 2);
  const hundredths = (value * 100n + unit.threshold / 2n) / unit.threshold;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${fraction.length > 0 ? `.${fraction}` : ""}${unit.suffix}`;
}

function formatFixedE18(value: bigint, fractionDigits: number): string {
  const scale = 10n ** 18n;
  const whole = value / scale;
  if (fractionDigits === 0) return whole.toString();
  const divisor = 10n ** BigInt(18 - fractionDigits);
  const fraction = (value % scale) / divisor;
  const text = fraction.toString().padStart(fractionDigits, "0").replace(/0+$/, "");
  return text.length === 0 ? whole.toString() : `${whole}.${text}`;
}

function addressFallback(address: Address): Pick<PoolDiscoveryLogo, "fallbackLabel" | "fallbackColor"> {
  let hash = 0;
  for (const character of address.slice(2)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return {
    fallbackLabel: address.slice(2, 4).toUpperCase(),
    fallbackColor: `hsl(${hash % 360} 42% 42%)`
  };
}

function ratioE18(numeratorE18: string | null, denominatorE18: string | null): string | null {
  if (numeratorE18 === null || denominatorE18 === null || BigInt(denominatorE18) === 0n) return null;
  return (BigInt(numeratorE18) * 10n ** 18n / BigInt(denominatorE18)).toString();
}

function canonicalAddress(value: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`Invalid EVM address: ${value}`);
  return value.toLowerCase() as Address;
}

function assertUnsignedDecimal(value: string, label: string): void {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}`);
}

function assertSignedDecimal(value: string, label: string): void {
  if (!/^(?:0|-?[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}`);
}

export function hourlyClosesToSparkline(closes: readonly PoolDiscoveryHourlyClose[]): PoolSparklineModel {
  return normalizeSparkline(closes.map((close) => ({ startTimestamp: close.startTimestamp, valueE18: close.closeUsdE18 })));
}
