import { formatUnits, type Address } from "viem";

import type {
  AnalyticsHealth,
  AnalyticsPage,
  AnalyticsStatus,
  PairCandle,
  PoolAnalyticsMetric
} from "./analytics-data";
import type { BinRow, PoolRow } from "./data";

export type PoolEconomicSort = "tvl" | "volume24h" | "lpFees24h" | "feeToTvl";

export interface PoolWorkspaceRow<T extends PoolRow = PoolRow> {
  pool: T;
  metric: PoolAnalyticsMetric | null;
  analyticsStatus: AnalyticsStatus;
  analyticsIssue: string | null;
}

export interface WorkspaceMetricTile {
  key: "tvl" | "volume24h" | "lpFees24h" | "feeToTvl" | "price";
  label: string;
  value: string;
  status: AnalyticsStatus;
}

export interface WorkspaceAnalyticsState {
  status: AnalyticsStatus;
  label: string;
  detail: string | null;
}

export interface CandleChartPoint {
  startTimestamp: number;
  endTimestamp: number;
  normalizedClose: number | null;
  status: AnalyticsStatus;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  lpFees: string;
  tvl: string;
  swapCount: number;
}

export interface CandleChartModel {
  status: AnalyticsStatus;
  points: CandleChartPoint[];
  hasGaps: boolean;
}

export interface BinDistributionPoint {
  id: string;
  binId: string;
  active: boolean;
  tokenX: string;
  tokenY: string;
  lbSupply: string;
  tokenXHeight: number;
  tokenYHeight: number;
  lbSupplyHeight: number;
}

export function joinPoolWorkspaceRows<T extends PoolRow>(
  pools: readonly T[],
  metrics: Pick<AnalyticsPage<PoolAnalyticsMetric>, "rows" | "status">
): PoolWorkspaceRow<T>[] {
  const metricByPair = new Map<string, PoolAnalyticsMetric>();
  for (const metric of metrics.rows) {
    const pair = canonical(metric.pair);
    if (metricByPair.has(pair)) throw new Error(`Duplicate pool analytics metric for ${pair}`);
    metricByPair.set(pair, metric);
  }
  return pools.map((pool) => {
    const metric = metricByPair.get(canonical(pool.address)) ?? null;
    const identityMatches = metric !== null &&
      canonical(metric.tokenX) === canonical(pool.tokenXAddress) &&
      canonical(metric.tokenY) === canonical(pool.tokenYAddress);
    if (metric !== null && !identityMatches) {
      return {
        pool,
        metric: null,
        analyticsStatus: "PARTIAL",
        analyticsIssue: "Analytics token identity does not match the indexed pool."
      };
    }
    return {
      pool,
      metric,
      analyticsStatus: metric === null
        ? metrics.status === "UNAVAILABLE" ? "UNAVAILABLE" : "PARTIAL"
        : weakestStatus(metrics.status, metric.status),
      analyticsIssue: metric === null
        ? metrics.status === "UNAVAILABLE" ? "Pool analytics are unavailable." : "Pool analytics are missing from this result."
        : null
    };
  });
}

export function sortPoolWorkspaceRows<T extends PoolRow>(
  rows: readonly PoolWorkspaceRow<T>[],
  sort: PoolEconomicSort
): PoolWorkspaceRow<T>[] {
  const field: keyof Pick<PoolAnalyticsMetric, "tvlUsdE18" | "volume24hUsdE18" | "lpFees24hUsdE18" | "feeToTvlE18"> =
    sort === "tvl"
      ? "tvlUsdE18"
      : sort === "volume24h"
        ? "volume24hUsdE18"
        : sort === "lpFees24h"
          ? "lpFees24hUsdE18"
          : "feeToTvlE18";

  return [...rows].sort((left, right) => {
    const leftValue = left.metric?.[field] ?? null;
    const rightValue = right.metric?.[field] ?? null;
    if (leftValue === null && rightValue !== null) return 1;
    if (leftValue !== null && rightValue === null) return -1;
    if (leftValue !== null && rightValue !== null) {
      const order = compareDecimalStrings(rightValue, leftValue);
      if (order !== 0) return order;
    }
    return canonical(left.pool.address).localeCompare(canonical(right.pool.address));
  });
}

export function workspaceMetricTiles(metric: PoolAnalyticsMetric | null): WorkspaceMetricTile[] {
  return [
    metricTile("tvl", "TVL", metric?.tvlUsdE18 ?? null, metric?.status ?? "UNAVAILABLE", formatUsdE18),
    metricTile("volume24h", "24h volume", metric?.volume24hUsdE18 ?? null, metric?.status ?? "UNAVAILABLE", formatUsdE18),
    metricTile("lpFees24h", "24h LP fees", metric?.lpFees24hUsdE18 ?? null, metric?.status ?? "UNAVAILABLE", formatUsdE18),
    metricTile("feeToTvl", "24h LP fee / TVL", metric?.feeToTvlE18 ?? null, metric?.status ?? "UNAVAILABLE", formatRatioPercentE18),
    metricTile("price", "Indexed price", metric?.priceUsdE18 ?? null, metric?.status ?? "UNAVAILABLE", formatUsdE18)
  ];
}

export function workspaceAnalyticsState(
  pageStatus: AnalyticsStatus,
  health: AnalyticsHealth | null
): WorkspaceAnalyticsState {
  if (health === null) {
    return pageStatus === "UNAVAILABLE"
      ? { status: "UNAVAILABLE", label: "Analytics unavailable", detail: "No application analytics health response is available." }
      : { status: "PARTIAL", label: "Metrics loaded · health unavailable", detail: "Metric values are shown with unknown freshness." };
  }

  const status = weakestStatus(pageStatus, health.status, health.fresh ? "READY" : "PARTIAL");
  if (status === "READY") {
    return { status, label: `Current through block ${health.headBlock ?? "unknown"}`, detail: null };
  }

  const details: string[] = [];
  if (!health.fresh) details.push(health.headLagSeconds === null ? "analytics head is stale" : `analytics head is ${health.headLagSeconds}s behind`);
  if (health.backfillStatus !== "complete") details.push(`history backfill is ${health.backfillStatus}`);
  if (health.partialEventCount > 0) details.push(`${health.partialEventCount} partial event${health.partialEventCount === 1 ? "" : "s"}`);
  if (health.missingPriceTokens.length > 0) details.push(`${health.missingPriceTokens.length} token price${health.missingPriceTokens.length === 1 ? "" : "s"} unavailable`);
  return {
    status,
    label: status === "UNAVAILABLE" ? "Analytics unavailable" : "Analytics partial",
    detail: details.length > 0 ? details.join(" · ") : "Some application analytics are incomplete."
  };
}

export function buildCandleChartModel(
  candles: Pick<AnalyticsPage<PairCandle>, "rows" | "status">
): CandleChartModel {
  const ordered = [...candles.rows].sort((left, right) => left.startTimestamp - right.startTimestamp);
  const closeValues = ordered.flatMap((candle) => candle.closeUsdE18 === null ? [] : [BigInt(candle.closeUsdE18)]);
  const minimum = closeValues.length === 0 ? null : closeValues.reduce((left, right) => left < right ? left : right);
  const maximum = closeValues.length === 0 ? null : closeValues.reduce((left, right) => left > right ? left : right);
  let previousEnd: number | null = null;
  let hasGaps = false;

  const points = ordered.map((candle) => {
    if (previousEnd !== null && candle.startTimestamp !== previousEnd) hasGaps = true;
    previousEnd = candle.endTimestamp;
    if ([candle.openUsdE18, candle.highUsdE18, candle.lowUsdE18, candle.closeUsdE18].some((value) => value === null)) hasGaps = true;
    return {
      startTimestamp: candle.startTimestamp,
      endTimestamp: candle.endTimestamp,
      normalizedClose: normalizeDecimal(candle.closeUsdE18, minimum, maximum),
      status: candle.status,
      open: formatUsdE18(candle.openUsdE18),
      high: formatUsdE18(candle.highUsdE18),
      low: formatUsdE18(candle.lowUsdE18),
      close: formatUsdE18(candle.closeUsdE18),
      volume: formatUsdE18(candle.volumeUsdE18),
      lpFees: formatUsdE18(candle.lpFeesUsdE18),
      tvl: formatUsdE18(candle.tvlUsdE18),
      swapCount: candle.swapCount
    };
  });

  return {
    points,
    hasGaps,
    status: points.length === 0 ? candles.status : weakestStatus(candles.status, ...points.map((point) => point.status), hasGaps ? "PARTIAL" : "READY")
  };
}

export function buildBinDistribution(
  bins: readonly BinRow[],
  activeId: string | null,
  tokenXDecimals: number,
  tokenYDecimals: number
): BinDistributionPoint[] {
  assertDecimals(tokenXDecimals, "tokenXDecimals");
  assertDecimals(tokenYDecimals, "tokenYDecimals");
  const ordered = [...bins].sort((left, right) => compareDecimalStrings(left.binId, right.binId));
  const seen = new Set<string>();
  const maximumX = maximumDecimal(ordered.map((bin) => bin.reserveX));
  const maximumY = maximumDecimal(ordered.map((bin) => bin.reserveY));
  const maximumSupply = maximumDecimal(ordered.map((bin) => bin.totalSupply));
  return ordered.map((bin) => {
    if (seen.has(bin.binId)) throw new Error(`Duplicate pool bin ${bin.binId}`);
    seen.add(bin.binId);
    return {
      id: bin.id,
      binId: bin.binId,
      active: bin.binId === activeId,
      tokenX: formatUnits(BigInt(bin.reserveX), tokenXDecimals),
      tokenY: formatUnits(BigInt(bin.reserveY), tokenYDecimals),
      lbSupply: bin.totalSupply,
      tokenXHeight: normalizeAgainstMaximum(bin.reserveX, maximumX),
      tokenYHeight: normalizeAgainstMaximum(bin.reserveY, maximumY),
      lbSupplyHeight: normalizeAgainstMaximum(bin.totalSupply, maximumSupply)
    };
  });
}

export function formatUsdE18(value: string | null): string {
  if (value === null) return "Unavailable";
  if (BigInt(value) > 0n && BigInt(value) < 10n ** 16n) return "<$0.01";
  return `$${formatE18(value, 2)}`;
}

export function formatRatioPercentE18(value: string | null): string {
  if (value === null) return "Unavailable";
  const percentE18 = BigInt(value) * 100n;
  if (percentE18 > 0n && percentE18 < 10n ** 16n) return "<0.01%";
  return `${formatE18(percentE18.toString(), 2)}%`;
}

function metricTile(
  key: WorkspaceMetricTile["key"],
  label: string,
  raw: string | null,
  parentStatus: AnalyticsStatus,
  format: (value: string | null) => string
): WorkspaceMetricTile {
  return { key, label, value: format(raw), status: raw === null ? "UNAVAILABLE" : parentStatus };
}

function formatE18(value: string, maximumFractionDigits: number): string {
  const raw = BigInt(value);
  const whole = raw / 10n ** 18n;
  const remainder = raw % 10n ** 18n;
  const fractionScale = 10n ** BigInt(18 - maximumFractionDigits);
  const fraction = remainder / fractionScale;
  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fraction === 0n) return groupedWhole;
  return `${groupedWhole}.${fraction.toString().padStart(maximumFractionDigits, "0").replace(/0+$/, "")}`;
}

function normalizeDecimal(value: string | null, minimum: bigint | null, maximum: bigint | null): number | null {
  if (value === null || minimum === null || maximum === null) return null;
  if (minimum === maximum) return 50;
  return Number(((BigInt(value) - minimum) * 1_000n) / (maximum - minimum)) / 10;
}

function maximumDecimal(values: readonly string[]): bigint {
  return values.reduce((maximum, value) => BigInt(value) > maximum ? BigInt(value) : maximum, 0n);
}

function normalizeAgainstMaximum(value: string, maximum: bigint): number {
  if (maximum === 0n) return 0;
  return Number((BigInt(value) * 1_000n) / maximum) / 10;
}

function assertDecimals(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw new Error(`${label} must be an integer from 0 to 255`);
}

function weakestStatus(...statuses: AnalyticsStatus[]): AnalyticsStatus {
  if (statuses.includes("UNAVAILABLE")) return "UNAVAILABLE";
  return statuses.includes("PARTIAL") ? "PARTIAL" : "READY";
}

function compareDecimalStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function canonical(address: Address): string {
  return address.toLowerCase();
}
