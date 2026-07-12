import { isAddress, type Address } from "viem";

export type AnalyticsStatus = "READY" | "PARTIAL" | "UNAVAILABLE";
export type CandleInterval = "HOUR" | "DAY";
export type BackfillStatus = "unavailable" | "running" | "complete" | "partial" | "capped";

export interface AnalyticsPageInfo {
  endCursor: string | null;
  hasNextPage: boolean;
  partial: boolean;
  pagesLoaded: number;
}

export interface AnalyticsPage<T> {
  rows: T[];
  status: AnalyticsStatus;
  pageInfo: AnalyticsPageInfo;
  error: string | null;
}

export interface PoolAnalyticsMetric {
  pair: Address;
  tokenX: Address;
  tokenY: Address;
  tvlUsdE18: string | null;
  volume24hUsdE18: string | null;
  /** Existing analytics-schema fee value; LP-net only. No protocol-fee amount is inferred. */
  lpFees24hUsdE18: string | null;
  feeToTvlE18: string | null;
  priceUsdE18: string | null;
  asOfBlock: string;
  asOfTimestamp: number;
  status: AnalyticsStatus;
  missingPriceTokens: Address[];
}

export interface PairCandle {
  pair: Address;
  interval: CandleInterval;
  startTimestamp: number;
  endTimestamp: number;
  openUsdE18: string | null;
  highUsdE18: string | null;
  lowUsdE18: string | null;
  closeUsdE18: string | null;
  volumeUsdE18: string | null;
  /** Existing analytics-schema fee value; LP-net only. No protocol-fee amount is inferred. */
  lpFeesUsdE18: string | null;
  tvlUsdE18: string | null;
  swapCount: number;
  status: AnalyticsStatus;
  missingPriceTokens: Address[];
  firstBlock: string;
  lastBlock: string;
}

export interface PriceHealth {
  token: Address;
  source: string;
  feedId: string;
  status: string;
  observedAt: number | null;
  ageSeconds: number | null;
}

export interface AnalyticsHealth {
  status: AnalyticsStatus;
  headBlock: string | null;
  headHash: string | null;
  headTimestamp: number | null;
  canonicalBlockCount: number;
  reorgCount: number;
  partialEventCount: number;
  missingPriceTokens: Address[];
  fresh: boolean;
  headLagSeconds: number | null;
  maxHeadLagSeconds: number;
  backfillStatus: BackfillStatus;
  backfillCursor: string | null;
  backfillError: string | null;
  coverageStartTimestamp: string | null;
  coverageThroughTimestamp: string | null;
  prices: PriceHealth[];
}

export interface AnalyticsValue<T> {
  value: T | null;
  status: AnalyticsStatus;
  error: string | null;
}

export interface AnalyticsLoadOptions {
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

const POOL_METRICS_QUERY = `
  query WebPoolMetrics($first: Int!, $after: String, $asOfTimestamp: Int) {
    poolMetrics(first: $first, after: $after, asOfTimestamp: $asOfTimestamp) {
      nodes { pair tokenX tokenY tvlUsdE18 volume24hUsdE18 fees24hUsdE18 feeToTvlE18 priceUsdE18 asOfBlock asOfTimestamp status missingPriceTokens }
      pageInfo { endCursor hasNextPage partial }
    }
  }
`;

const PAIR_CANDLES_QUERY = `
  query WebPairCandles($pair: ID!, $interval: CandleInterval!, $fromTimestamp: Int!, $toTimestamp: Int!, $first: Int!, $after: String) {
    pairCandles(pair: $pair, interval: $interval, fromTimestamp: $fromTimestamp, toTimestamp: $toTimestamp, first: $first, after: $after) {
      nodes { pair interval startTimestamp endTimestamp openUsdE18 highUsdE18 lowUsdE18 closeUsdE18 volumeUsdE18 feesUsdE18 tvlUsdE18 swapCount status missingPriceTokens firstBlock lastBlock }
      pageInfo { endCursor hasNextPage partial }
    }
  }
`;

const ANALYTICS_HEALTH_QUERY = `
  query WebAnalyticsHealth {
    analyticsHealth {
      status headBlock headHash headTimestamp canonicalBlockCount reorgCount partialEventCount missingPriceTokens fresh headLagSeconds maxHeadLagSeconds
      backfillStatus backfillCursor backfillError coverageStartTimestamp coverageThroughTimestamp
      prices { token source feedId status observedAt ageSeconds }
    }
  }
`;

interface GraphConnection {
  nodes: unknown;
  pageInfo: unknown;
}

export async function loadPoolMetrics(
  endpoint: string | null,
  pairs: readonly Address[],
  asOfTimestamp?: number,
  options: AnalyticsLoadOptions = {}
): Promise<AnalyticsPage<PoolAnalyticsMetric>> {
  const requested = pairs.map(parseAddress);
  assertUnique(requested, "requested pool");
  if (asOfTimestamp !== undefined) parseSafeInteger(asOfTimestamp, "asOfTimestamp");
  if (endpoint === null) return unavailablePage("Analytics endpoint is not configured");

  const page = await loadConnection(endpoint, "poolMetrics", POOL_METRICS_QUERY, { asOfTimestamp }, parsePoolMetric, (row) => row.pair, options);
  const requestedSet = new Set(requested);
  const byPair = new Map(page.rows.filter((row) => requestedSet.has(row.pair)).map((row) => [row.pair, row]));
  const rows = requested.flatMap((pair) => {
    const row = byPair.get(pair);
    return row === undefined ? [] : [row];
  });
  const missing = requested.filter((pair) => !byPair.has(pair));
  return {
    ...page,
    rows,
    status: missing.length > 0 && page.status === "READY" ? "PARTIAL" : page.status,
    error: missing.length > 0 ? joinErrors(page.error, `Missing metrics for ${missing.join(", ")}`) : page.error
  };
}

export async function loadPairCandles(
  endpoint: string | null,
  pair: Address,
  interval: CandleInterval,
  fromTimestamp: number,
  toTimestamp: number,
  options: AnalyticsLoadOptions = {}
): Promise<AnalyticsPage<PairCandle>> {
  const canonicalPair = parseAddress(pair);
  if (interval !== "HOUR" && interval !== "DAY") throw new Error("Unsupported candle interval");
  parseSafeInteger(fromTimestamp, "fromTimestamp");
  parseSafeInteger(toTimestamp, "toTimestamp");
  if (fromTimestamp > toTimestamp) throw new Error("Candle range is reversed");
  if (endpoint === null) return unavailablePage("Analytics endpoint is not configured");

  return loadConnection(
    endpoint,
    "pairCandles",
    PAIR_CANDLES_QUERY,
    { pair: canonicalPair, interval, fromTimestamp, toTimestamp },
    (value) => parseCandle(value, canonicalPair, interval, fromTimestamp, toTimestamp),
    (row) => `${row.startTimestamp.toString().padStart(16, "0")}:${row.pair}`,
    options
  );
}

export async function loadAnalyticsHealth(
  endpoint: string | null,
  options: Pick<AnalyticsLoadOptions, "timeoutMs"> = {}
): Promise<AnalyticsValue<AnalyticsHealth>> {
  if (endpoint === null) return { value: null, status: "UNAVAILABLE", error: "Analytics endpoint is not configured" };
  try {
    const data = await fetchGraph(endpoint, ANALYTICS_HEALTH_QUERY, {}, normalizePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs"));
    const health = parseHealth(asRecord(data).analyticsHealth);
    health.status = truthfulHealthStatus(health);
    return { value: health, status: health.status, error: null };
  } catch (error) {
    return { value: null, status: "UNAVAILABLE", error: errorMessage(error) };
  }
}

async function loadConnection<T>(
  endpoint: string,
  field: string,
  query: string,
  variables: Record<string, unknown>,
  parseRow: (value: unknown) => T,
  stableKey: (row: T) => string,
  options: AnalyticsLoadOptions
): Promise<AnalyticsPage<T>> {
  const pageSize = normalizePositive(options.pageSize, DEFAULT_PAGE_SIZE, "pageSize");
  const maxPages = normalizePositive(options.maxPages, DEFAULT_MAX_PAGES, "maxPages");
  const timeoutMs = normalizePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const rows: T[] = [];
  const keys = new Set<string>();
  let after: string | null = null;
  let partial = false;
  let lastKey: string | null = null;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    try {
      const data = asRecord(await fetchGraph(endpoint, query, { ...variables, first: pageSize, after }, timeoutMs));
      const connection = parseConnection(data[field]);
      for (const raw of connection.nodes) {
        const row = parseRow(raw);
        const key = stableKey(row);
        if (keys.has(key)) throw new Error(`${field} returned duplicate key ${key}`);
        if (lastKey !== null && key <= lastKey) throw new Error(`${field} ordering is not strictly stable`);
        keys.add(key);
        lastKey = key;
        rows.push(row);
      }
      partial ||= connection.pageInfo.partial || rows.some((row) => rowStatus(row) !== "READY");
      if (!connection.pageInfo.hasNextPage) {
        return resultPage(rows, partial ? "PARTIAL" : "READY", connection.pageInfo, pageNumber + 1, null);
      }
      const next = connection.pageInfo.endCursor;
      if (next === null || next === after) {
        return resultPage(rows, "PARTIAL", connection.pageInfo, pageNumber + 1, `${field} pagination cursor did not advance`);
      }
      after = next;
    } catch (error) {
      return resultPage(rows, rows.length === 0 ? "UNAVAILABLE" : "PARTIAL", { endCursor: after, hasNextPage: true, partial: true }, pageNumber, errorMessage(error));
    }
  }

  return resultPage(rows, "PARTIAL", { endCursor: after, hasNextPage: true, partial: true }, maxPages, `${field} pagination capped at ${maxPages} pages`);
}

function parsePoolMetric(value: unknown): PoolAnalyticsMetric {
  const row = asRecord(value);
  const status = parseStatus(row.status);
  const missingPriceTokens = parseAddresses(row.missingPriceTokens, "missingPriceTokens");
  const result: PoolAnalyticsMetric = {
    pair: parseAddress(row.pair), tokenX: parseAddress(row.tokenX), tokenY: parseAddress(row.tokenY),
    tvlUsdE18: parseNullableDecimal(row.tvlUsdE18, "tvlUsdE18"),
    volume24hUsdE18: parseNullableDecimal(row.volume24hUsdE18, "volume24hUsdE18"),
    lpFees24hUsdE18: parseNullableDecimal(row.fees24hUsdE18, "fees24hUsdE18"),
    feeToTvlE18: parseNullableDecimal(row.feeToTvlE18, "feeToTvlE18"),
    priceUsdE18: parseNullableDecimal(row.priceUsdE18, "priceUsdE18"),
    asOfBlock: parseDecimal(row.asOfBlock, "asOfBlock"), asOfTimestamp: parseSafeInteger(row.asOfTimestamp, "asOfTimestamp"),
    status, missingPriceTokens
  };
  if (status === "READY" && (missingPriceTokens.length > 0 || Object.values(result).some((item) => item === null))) {
    throw new Error(`READY pool metrics are incomplete for ${result.pair}`);
  }
  return result;
}

function parseCandle(value: unknown, pair: Address, interval: CandleInterval, from: number, to: number): PairCandle {
  const row = asRecord(value);
  const rowPair = parseAddress(row.pair);
  if (rowPair !== pair) throw new Error(`pairCandles returned foreign pair ${rowPair}`);
  if (row.interval !== interval) throw new Error("pairCandles returned the wrong interval");
  const startTimestamp = parseSafeInteger(row.startTimestamp, "startTimestamp");
  const endTimestamp = parseSafeInteger(row.endTimestamp, "endTimestamp");
  const seconds = interval === "HOUR" ? 3_600 : 86_400;
  if (startTimestamp < from || startTimestamp > to || startTimestamp % seconds !== 0 || endTimestamp !== startTimestamp + seconds) {
    throw new Error(`Invalid ${interval} candle boundary at ${startTimestamp}`);
  }
  const ohlc = ["openUsdE18", "highUsdE18", "lowUsdE18", "closeUsdE18"].map((key) => parseNullableDecimal(row[key], key));
  if (ohlc.some((item) => item === null) && ohlc.some((item) => item !== null)) throw new Error("Candle OHLC values must be all present or all null");
  if (ohlc[0] !== null) {
    const [open, high, low, close] = ohlc.map((item) => BigInt(item!));
    if (high < open || high < close || low > open || low > close || high < low) throw new Error("Candle OHLC values are inconsistent");
  }
  const firstBlock = parseDecimal(row.firstBlock, "firstBlock");
  const lastBlock = parseDecimal(row.lastBlock, "lastBlock");
  if (BigInt(firstBlock) > BigInt(lastBlock)) throw new Error("Candle block range is reversed");
  const status = parseStatus(row.status);
  const missingPriceTokens = parseAddresses(row.missingPriceTokens, "missingPriceTokens");
  if (status === "READY" && (missingPriceTokens.length > 0 || ohlc[0] === null)) throw new Error("READY candle is incomplete");
  return {
    pair, interval, startTimestamp, endTimestamp, openUsdE18: ohlc[0], highUsdE18: ohlc[1], lowUsdE18: ohlc[2], closeUsdE18: ohlc[3],
    volumeUsdE18: parseNullableDecimal(row.volumeUsdE18, "volumeUsdE18"), lpFeesUsdE18: parseNullableDecimal(row.feesUsdE18, "feesUsdE18"),
    tvlUsdE18: parseNullableDecimal(row.tvlUsdE18, "tvlUsdE18"), swapCount: parseSafeInteger(row.swapCount, "swapCount"), status,
    missingPriceTokens, firstBlock, lastBlock
  };
}

function parseHealth(value: unknown): AnalyticsHealth {
  const row = asRecord(value);
  const backfillStatus = row.backfillStatus;
  if (!(["unavailable", "running", "complete", "partial", "capped"] as unknown[]).includes(backfillStatus)) throw new Error("Invalid backfillStatus");
  const prices = asArray(row.prices, "prices").map((value) => {
    const price = asRecord(value);
    return { token: parseAddress(price.token), source: parseString(price.source, "source"), feedId: parseString(price.feedId, "feedId"), status: parseString(price.status, "price status"), observedAt: parseNullableInteger(price.observedAt, "observedAt"), ageSeconds: parseNullableInteger(price.ageSeconds, "ageSeconds") };
  });
  return {
    status: parseStatus(row.status), headBlock: parseNullableDecimal(row.headBlock, "headBlock"), headHash: parseNullableString(row.headHash, "headHash"),
    headTimestamp: parseNullableInteger(row.headTimestamp, "headTimestamp"), canonicalBlockCount: parseSafeInteger(row.canonicalBlockCount, "canonicalBlockCount"),
    reorgCount: parseSafeInteger(row.reorgCount, "reorgCount"), partialEventCount: parseSafeInteger(row.partialEventCount, "partialEventCount"),
    missingPriceTokens: parseAddresses(row.missingPriceTokens, "missingPriceTokens"), fresh: parseBoolean(row.fresh, "fresh"),
    headLagSeconds: parseNullableInteger(row.headLagSeconds, "headLagSeconds"), maxHeadLagSeconds: parseSafeInteger(row.maxHeadLagSeconds, "maxHeadLagSeconds"),
    backfillStatus: backfillStatus as BackfillStatus, backfillCursor: parseNullableString(row.backfillCursor, "backfillCursor"),
    backfillError: parseNullableString(row.backfillError, "backfillError"), coverageStartTimestamp: parseNullableDecimal(row.coverageStartTimestamp, "coverageStartTimestamp"),
    coverageThroughTimestamp: parseNullableDecimal(row.coverageThroughTimestamp, "coverageThroughTimestamp"), prices
  };
}

function truthfulHealthStatus(health: AnalyticsHealth): AnalyticsStatus {
  if (health.status === "UNAVAILABLE" || health.headBlock === null) return "UNAVAILABLE";
  const ready = health.fresh && health.backfillStatus === "complete" && health.coverageStartTimestamp !== null && health.coverageThroughTimestamp !== null && health.partialEventCount === 0 && health.missingPriceTokens.length === 0 && health.prices.every((price) => price.status === "available");
  return health.status === "READY" && ready ? "READY" : "PARTIAL";
}

function parseConnection(value: unknown): { nodes: unknown[]; pageInfo: { endCursor: string | null; hasNextPage: boolean; partial: boolean } } {
  const connection = asRecord(value) as unknown as GraphConnection;
  const pageInfo = asRecord(connection.pageInfo);
  return { nodes: asArray(connection.nodes, "nodes"), pageInfo: { endCursor: parseNullableString(pageInfo.endCursor, "endCursor"), hasNextPage: parseBoolean(pageInfo.hasNextPage, "hasNextPage"), partial: parseBoolean(pageInfo.partial, "partial") } };
}

async function fetchGraph(endpoint: string, query: string, variables: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: controller.signal });
    if (!response.ok) throw new Error(`Analytics endpoint returned HTTP ${response.status}`);
    const payload = asRecord(await response.json());
    if (Array.isArray(payload.errors) && payload.errors.length > 0) throw new Error(payload.errors.map((item) => parseString(asRecord(item).message, "GraphQL error")).join("; "));
    if (payload.data === undefined || payload.data === null) throw new Error("Analytics endpoint returned no data");
    return payload.data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Analytics request timed out after ${timeoutMs}ms`);
    throw error;
  } finally { clearTimeout(timeout); }
}

function resultPage<T>(rows: T[], status: AnalyticsStatus, pageInfo: { endCursor: string | null; hasNextPage: boolean; partial: boolean }, pagesLoaded: number, error: string | null): AnalyticsPage<T> {
  return { rows, status, pageInfo: { ...pageInfo, partial: pageInfo.partial || status !== "READY", pagesLoaded }, error };
}
function unavailablePage<T>(error: string): AnalyticsPage<T> { return resultPage([], "UNAVAILABLE", { endCursor: null, hasNextPage: false, partial: true }, 0, error); }
function rowStatus(value: unknown): AnalyticsStatus { const status = asRecord(value).status; return parseStatus(status); }
function parseStatus(value: unknown): AnalyticsStatus { if (value === "READY" || value === "PARTIAL" || value === "UNAVAILABLE") return value; throw new Error("Invalid analytics status"); }
function parseAddress(value: unknown): Address { if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error(`Invalid EVM address: ${String(value)}`); return value.toLowerCase() as Address; }
function parseAddresses(value: unknown, label: string): Address[] { const rows = asArray(value, label).map(parseAddress); assertUnique(rows, label); return rows; }
function assertUnique(values: readonly string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} address`); }
function parseDecimal(value: unknown, label: string): string { if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}`); return value; }
function parseNullableDecimal(value: unknown, label: string): string | null { return value === null ? null : parseDecimal(value, label); }
function parseSafeInteger(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`); return value; }
function parseNullableInteger(value: unknown, label: string): number | null { return value === null ? null : parseSafeInteger(value, label); }
function parseString(value: unknown, label: string): string { if (typeof value !== "string") throw new Error(`Invalid ${label}`); return value; }
function parseNullableString(value: unknown, label: string): string | null { return value === null ? null : parseString(value, label); }
function parseBoolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`Invalid ${label}`); return value; }
function asRecord(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected analytics object"); return value as Record<string, unknown>; }
function asArray(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`Invalid ${label}`); return value; }
function normalizePositive(value: number | undefined, fallback: number, label: string): number { return value === undefined ? fallback : parseSafeInteger(value, label) || (() => { throw new Error(`${label} must be positive`); })(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Analytics request failed"; }
function joinErrors(left: string | null, right: string): string { return left === null ? right : `${left}; ${right}`; }
