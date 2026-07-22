import { isAddress, type Address } from "viem";

export type AnalyticsStatus = "READY" | "PARTIAL" | "UNAVAILABLE";
export type CandleInterval =
  | "ONE_MINUTE"
  | "FIVE_MINUTES"
  | "FIFTEEN_MINUTES"
  | "HOUR"
  | "FOUR_HOURS"
  | "DAY"
  | "WEEK";
export type BackfillStatus = "unavailable" | "running" | "complete" | "partial" | "capped";
export const CANDLE_STREAM_STALE_AFTER_MS = 45_000;
export const POOL_STREAM_STALE_AFTER_MS = 45_000;

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
  streamCursor: string | null;
}

export interface PoolAnalyticsMetric {
  pair: Address;
  tokenX: Address;
  tokenY: Address;
  tvlUsdE18: string | null;
  volume24hUsdE18: string | null;
  totalSwapFees24hUsdE18: string | null;
  protocolSwapFees24hUsdE18: string | null;
  lpFees24hUsdE18: string | null;
  feeToTvlE18: string | null;
  feeBreakdownComplete: boolean;
  priceUsdE18: string | null;
  asOfBlock: string;
  asOfTimestamp: number;
  status: AnalyticsStatus;
  missingPriceTokens: Address[];
}

export interface PoolDiscoveryRequest {
  pair: Address;
  preferredQuoteToken?: Address | null;
}

export interface PoolDiscoveryHourlyClose {
  startTimestamp: number;
  closeUsdE18: string;
  quoteToken: Address;
  finalized: boolean;
  revision: number;
  priceSource: string;
  firstBlockHash: string;
  lastBlockHash: string;
}

/** Presentation-only metadata. It must never participate in protocol decisions. */
export interface PoolDiscoveryMarketMetadata {
  marketCapUsdE18: string | null;
  source: string;
  fetchedAt: number;
  /** Same-origin relative path exposed by the analytics service image proxy. */
  logoPath: string | null;
  logoSource: string | null;
}

export interface PoolDiscoveryAnalytics {
  pair: Address;
  chainId: number | null;
  tokenX: Address;
  tokenY: Address;
  displayBaseToken: Address;
  displayQuoteToken: Address;
  poolPriceQuotePerBaseE18: string | null;
  hourlyCloses: PoolDiscoveryHourlyClose[];
  priceChange24hE18: string | null;
  tvlUsdE18: string | null;
  lpFees24hUsdE18: string | null;
  volume24hUsdE18: string | null;
  status: AnalyticsStatus;
  missingPriceTokens: Address[];
  asOfBlock: string;
  asOfBlockHash: string;
  asOfTimestamp: number;
  marketMetadata: PoolDiscoveryMarketMetadata | null;
}

export interface PoolStaticFeeParameters {
  baseFactor: string;
  filterPeriod: string;
  decayPeriod: string;
  reductionFactor: string;
  variableFeeControl: string;
  protocolShare: string;
  maxVolatilityAccumulator: string;
}

export interface PoolVariableFeeParameters {
  volatilityAccumulator: string;
  volatilityReference: string;
  idReference: string;
  timeOfLastUpdate: string;
}

export interface PoolFeeState {
  static: PoolStaticFeeParameters;
  variable: PoolVariableFeeParameters;
}

export interface LivePoolBin {
  chainId: number;
  pair: Address;
  binId: string;
  reserveX: string;
  reserveY: string;
  totalSupply: string;
  updatedAtBlock: string;
  updatedAtBlockHash: string;
  updatedAtTimestamp: number;
  revision: number;
}

export interface LivePoolState {
  chainId: number;
  pair: Address;
  tokenX: Address;
  tokenY: Address;
  decimalsX: number;
  decimalsY: number;
  reserveX: string;
  reserveY: string;
  activeId: number;
  binStep: number;
  marketPriceQuoteE18: string;
  priceUsdE18: string | null;
  tvlUsdE18: string | null;
  status: AnalyticsStatus;
  missingPriceTokens: Address[];
  feeState: PoolFeeState;
  asOfBlock: string;
  asOfBlockHash: string;
  asOfTimestamp: number;
  revision: number;
}

export interface LivePoolSnapshot {
  state: LivePoolState;
  bins: LivePoolBin[];
  streamCursor: string;
  radius: number;
  lastEventId: string | null;
}

export interface LivePoolUpdate {
  cursor: string;
  eventId: string;
  state: LivePoolState;
  binReplacements: LivePoolBin[];
  replaceBinWindow: boolean;
  sourceEventIds: string[];
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
  totalSwapFeesUsdE18: string | null;
  protocolSwapFeesUsdE18: string | null;
  lpFeesUsdE18: string | null;
  feeBreakdownComplete: boolean;
  tvlUsdE18: string | null;
  swapCount: number;
  status: AnalyticsStatus;
  missingPriceTokens: Address[];
  firstBlock: string;
  lastBlock: string;
  firstBlockHash: string;
  lastBlockHash: string;
  finalized: boolean;
  revision: number;
  priceSource: string;
  quoteToken: Address;
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
const MAX_TIMEOUT_MS = 60_000;
export const POOL_DISCOVERY_BATCH_SIZE = 100;
const MONDAY_EPOCH_OFFSET_SECONDS = 4 * 86_400;

export const CANDLE_INTERVAL_SECONDS: Readonly<Record<CandleInterval, number>> = {
  ONE_MINUTE: 60,
  FIVE_MINUTES: 5 * 60,
  FIFTEEN_MINUTES: 15 * 60,
  HOUR: 3_600,
  FOUR_HOURS: 4 * 3_600,
  DAY: 86_400,
  WEEK: 7 * 86_400
};

export const CANDLE_INTERVAL_LABELS: Readonly<Record<CandleInterval, string>> = {
  ONE_MINUTE: "1m",
  FIVE_MINUTES: "5m",
  FIFTEEN_MINUTES: "15m",
  HOUR: "1h",
  FOUR_HOURS: "4h",
  DAY: "1d",
  WEEK: "1w"
};

export const CANDLE_LOOKBACK_SECONDS: Readonly<Record<CandleInterval, number>> = {
  ONE_MINUTE: 6 * 3_600,
  FIVE_MINUTES: 24 * 3_600,
  FIFTEEN_MINUTES: 3 * 86_400,
  HOUR: 14 * 86_400,
  FOUR_HOURS: 60 * 86_400,
  DAY: 365 * 86_400,
  WEEK: 3 * 365 * 86_400
};

export const CANDLE_LOOKBACK_LABELS: Readonly<Record<CandleInterval, string>> = {
  ONE_MINUTE: "6H history",
  FIVE_MINUTES: "24H history",
  FIFTEEN_MINUTES: "3D history",
  HOUR: "14D history",
  FOUR_HOURS: "60D history",
  DAY: "1Y history",
  WEEK: "3Y history"
};

export function candleBoundary(timestamp: number, interval: CandleInterval): number {
  const seconds = CANDLE_INTERVAL_SECONDS[interval];
  if (interval !== "WEEK") return Math.floor(timestamp / seconds) * seconds;
  return Math.floor((timestamp - MONDAY_EPOCH_OFFSET_SECONDS) / seconds) * seconds + MONDAY_EPOCH_OFFSET_SECONDS;
}

export function isCandleStreamStale(lastActivityAt: number, now: number): boolean {
  if (!Number.isFinite(lastActivityAt) || !Number.isFinite(now)) throw new Error("Candle stream timestamps must be finite");
  return now - lastActivityAt >= CANDLE_STREAM_STALE_AFTER_MS;
}

export function isPoolStreamStale(lastActivityAt: number, now: number): boolean {
  if (!Number.isFinite(lastActivityAt) || !Number.isFinite(now)) throw new Error("Pool stream timestamps must be finite");
  return now - lastActivityAt >= POOL_STREAM_STALE_AFTER_MS;
}

const POOL_METRICS_QUERY = `
  query WebPoolMetrics($first: Int!, $after: String, $asOfTimestamp: Int) {
    poolMetrics(first: $first, after: $after, asOfTimestamp: $asOfTimestamp) {
      nodes {
        pair tokenX tokenY tvlUsdE18 volume24hUsdE18
        totalSwapFees24hUsdE18 protocolSwapFees24hUsdE18 lpNetSwapFees24hUsdE18 lpNetSwapFeeToTvlE18 feeBreakdownComplete
        priceUsdE18 asOfBlock asOfTimestamp status missingPriceTokens
      }
      pageInfo { endCursor hasNextPage partial }
    }
  }
`;

const POOL_DISCOVERY_QUERY = `
  query WebPoolDiscovery($pools: [PoolDiscoveryRequest!]!, $asOfTimestamp: Int) {
    poolDiscovery(pools: $pools, asOfTimestamp: $asOfTimestamp) {
      pair chainId tokenX tokenY displayBaseToken displayQuoteToken poolPriceQuotePerBaseE18
      priceChange24hE18 tvlUsdE18 lpNetSwapFees24hUsdE18 volume24hUsdE18
      status missingPriceTokens asOfBlock asOfBlockHash asOfTimestamp
      hourlyCloses {
        startTimestamp closeUsdE18 quoteToken finalized revision priceSource firstBlockHash lastBlockHash
      }
      marketMetadata { marketCapUsdE18 source fetchedAt logoPath logoSource }
    }
  }
`;

const PAIR_CANDLES_QUERY = `
  query WebPairCandles($pair: ID!, $interval: CandleInterval!, $fromTimestamp: Int!, $toTimestamp: Int!, $first: Int!, $after: String) {
    pairCandles(pair: $pair, interval: $interval, fromTimestamp: $fromTimestamp, toTimestamp: $toTimestamp, first: $first, after: $after) {
      nodes {
        pair interval startTimestamp endTimestamp openUsdE18 highUsdE18 lowUsdE18 closeUsdE18 volumeUsdE18
        totalSwapFeesUsdE18 protocolSwapFeesUsdE18 lpNetSwapFeesUsdE18 feeBreakdownComplete
        tvlUsdE18 swapCount status missingPriceTokens firstBlock lastBlock firstBlockHash lastBlockHash finalized revision priceSource quoteToken
      }
      pageInfo { endCursor hasNextPage partial }
      streamCursor
    }
  }
`;

const POOL_STATE_QUERY = `
  query WebPoolState($pair: ID!, $radius: Int!) {
    poolState(pair: $pair, radius: $radius) {
      state {
        chainId pair tokenX tokenY decimalsX decimalsY reserveX reserveY activeId binStep marketPriceQuoteE18
        priceUsdE18 tvlUsdE18 status missingPriceTokens asOfBlock asOfBlockHash asOfTimestamp revision
        feeState {
          static { baseFactor filterPeriod decayPeriod reductionFactor variableFeeControl protocolShare maxVolatilityAccumulator }
          variable { volatilityAccumulator volatilityReference idReference timeOfLastUpdate }
        }
      }
      bins {
        chainId pair binId reserveX reserveY totalSupply updatedAtBlock updatedAtBlockHash updatedAtTimestamp revision
      }
      streamCursor
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
  streamCursor?: unknown;
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

/**
 * Loads one bounded discovery projection for the exact visible pool set. This
 * deliberately does not replace loadPoolMetrics, which remains the detail-view
 * API. Unknown pools are represented by omitted rows and a PARTIAL page.
 */
export async function loadPoolDiscovery(
  endpoint: string | null,
  pools: readonly PoolDiscoveryRequest[],
  asOfTimestamp?: number,
  options: Pick<AnalyticsLoadOptions, "timeoutMs"> = {}
): Promise<AnalyticsPage<PoolDiscoveryAnalytics>> {
  if (pools.length === 0 || pools.length > 100) throw new Error("Pool discovery requires between 1 and 100 pools");
  const requested = pools.map((request) => ({
    pair: parseAddress(request.pair),
    preferredQuoteToken: request.preferredQuoteToken === undefined || request.preferredQuoteToken === null
      ? null
      : parseAddress(request.preferredQuoteToken)
  }));
  assertUnique(requested.map((request) => request.pair), "requested discovery pool");
  if (asOfTimestamp !== undefined) parseSafeInteger(asOfTimestamp, "asOfTimestamp");
  if (endpoint === null) return unavailablePage("Analytics endpoint is not configured");
  const timeoutMs = normalizeBoundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs");

  try {
    const data = asRecord(await fetchGraph(endpoint, POOL_DISCOVERY_QUERY, {
      pools: requested,
      asOfTimestamp
    }, timeoutMs));
    const rawRows = asArray(data.poolDiscovery, "poolDiscovery");
    const requestedPairs = new Set(requested.map((request) => request.pair));
    const rows = rawRows.map(parsePoolDiscoveryRow);
    assertUnique(rows.map((row) => row.pair), "pool discovery result");
    for (const row of rows) {
      if (!requestedPairs.has(row.pair)) throw new Error(`poolDiscovery returned foreign pair ${row.pair}`);
    }
    const returnedOrder = rows.map((row) => requested.findIndex((request) => request.pair === row.pair));
    if (returnedOrder.some((index, position) => position > 0 && index <= returnedOrder[position - 1]!)) {
      throw new Error("poolDiscovery did not preserve requested order");
    }
    const partial = rows.length !== requested.length || rows.some((row) => row.status !== "READY");
    return resultPage(
      rows,
      partial ? "PARTIAL" : "READY",
      { endCursor: null, hasNextPage: false, partial },
      1,
      null
    );
  } catch (error) {
    return unavailablePage(errorMessage(error));
  }
}

/**
 * Loads discovery analytics for an arbitrary indexed pool set while keeping
 * every individual GraphQL request within the server's 100-pool bound.
 * Successful rows are always returned in the caller's original request order.
 */
export async function loadPoolDiscoveryBatches(
  endpoint: string | null,
  pools: readonly PoolDiscoveryRequest[],
  asOfTimestamp?: number,
  options: Pick<AnalyticsLoadOptions, "timeoutMs"> = {}
): Promise<AnalyticsPage<PoolDiscoveryAnalytics>> {
  if (pools.length === 0) throw new Error("Pool discovery requires at least one pool");
  const requested = pools.map((request) => ({
    pair: parseAddress(request.pair),
    preferredQuoteToken: request.preferredQuoteToken === undefined || request.preferredQuoteToken === null
      ? null
      : parseAddress(request.preferredQuoteToken)
  }));
  assertUnique(requested.map((request) => request.pair), "requested discovery pool");

  const batches: PoolDiscoveryRequest[][] = [];
  for (let start = 0; start < requested.length; start += POOL_DISCOVERY_BATCH_SIZE) {
    batches.push(requested.slice(start, start + POOL_DISCOVERY_BATCH_SIZE));
  }
  const pages = await Promise.all(
    batches.map((batch) => loadPoolDiscovery(endpoint, batch, asOfTimestamp, options))
  );
  const byPair = new Map<Address, PoolDiscoveryAnalytics>();
  for (const page of pages) {
    for (const row of page.rows) {
      if (byPair.has(row.pair)) throw new Error(`Duplicate batched pool discovery result for ${row.pair}`);
      byPair.set(row.pair, row);
    }
  }
  const rows = requested.flatMap(({ pair }) => {
    const row = byPair.get(pair);
    return row === undefined ? [] : [row];
  });
  const allUnavailable = pages.every((page) => page.status === "UNAVAILABLE");
  const partial = rows.length !== requested.length || pages.some((page) => page.status !== "READY");
  const status: AnalyticsStatus = allUnavailable ? "UNAVAILABLE" : partial ? "PARTIAL" : "READY";
  const failedBatchCount = pages.filter((page) => page.status === "UNAVAILABLE").length;
  const uniqueErrors = [...new Set(pages.flatMap((page) => page.error === null ? [] : [page.error]))];
  const errorParts = [
    ...(failedBatchCount > 0 && failedBatchCount < pages.length
      ? [`${failedBatchCount} of ${pages.length} discovery batches were unavailable`]
      : []),
    ...uniqueErrors
  ];
  return resultPage(
    rows,
    status,
    { endCursor: null, hasNextPage: false, partial },
    pages.reduce((total, page) => total + page.pageInfo.pagesLoaded, 0),
    errorParts.length === 0 ? null : errorParts.join("; ")
  );
}

/** Resolves only analytics-owned relative proxy paths against its own origin. */
export function resolveAnalyticsAssetUrl(endpoint: string | null, logoPath: string | null): string | null {
  if (endpoint === null || logoPath === null || !/^\/token-images\/[0-9a-f]{64}$/.test(logoPath)) return null;
  try {
    const analyticsUrl = new URL(endpoint);
    if ((analyticsUrl.protocol !== "http:" && analyticsUrl.protocol !== "https:") || analyticsUrl.username !== "" || analyticsUrl.password !== "") return null;
    const assetUrl = new URL(logoPath, analyticsUrl.origin);
    if (assetUrl.origin !== analyticsUrl.origin || assetUrl.username !== "" || assetUrl.password !== "") return null;
    return assetUrl.toString();
  } catch {
    return null;
  }
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
  if (!CANDLE_INTERVAL_SECONDS[interval]) throw new Error("Unsupported candle interval");
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

export async function loadPoolState(
  endpoint: string | null,
  pair: Address,
  radius = 40,
  options: Pick<AnalyticsLoadOptions, "timeoutMs"> = {}
): Promise<AnalyticsValue<LivePoolSnapshot>> {
  const canonicalPair = parseAddress(pair);
  if (!Number.isSafeInteger(radius) || radius < 0 || radius > 100) {
    throw new Error("Pool-state radius must be between 0 and 100");
  }
  if (endpoint === null) return { value: null, status: "UNAVAILABLE", error: "Analytics endpoint is not configured" };
  const timeoutMs = normalizeBoundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs");
  try {
    const data = asRecord(await fetchGraph(endpoint, POOL_STATE_QUERY, { pair: canonicalPair, radius }, timeoutMs));
    if (data.poolState === null) return { value: null, status: "UNAVAILABLE", error: "Canonical pool state is not available yet" };
    const snapshot = parsePoolSnapshot(data.poolState, canonicalPair, radius);
    return { value: snapshot, status: snapshot.state.status, error: null };
  } catch (error) {
    return { value: null, status: "UNAVAILABLE", error: errorMessage(error) };
  }
}

export function candleStreamUrl(
  endpoint: string,
  pair: Address,
  interval: CandleInterval,
  after: string
): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.endsWith("/graphql")
    ? `${url.pathname.slice(0, -"/graphql".length)}/events/candles`
    : `${url.pathname.replace(/\/+$/, "")}/events/candles`;
  url.search = "";
  url.searchParams.set("pair", parseAddress(pair));
  url.searchParams.set("interval", interval);
  url.searchParams.set("after", after);
  return url.toString();
}

export function poolStreamUrl(endpoint: string, pair: Address, after: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.endsWith("/graphql")
    ? `${url.pathname.slice(0, -"/graphql".length)}/events/pools`
    : `${url.pathname.replace(/\/+$/, "")}/events/pools`;
  url.search = "";
  url.searchParams.set("pair", parseAddress(pair));
  url.searchParams.set("after", parseCursor(after));
  return url.toString();
}

export function parseCandleStreamPayload(
  value: unknown,
  pair: Address,
  interval: CandleInterval
): { cursor: string; candle: PairCandle } {
  const payload = asRecord(value);
  return {
    cursor: parseString(payload.cursor, "stream cursor"),
    candle: parseCandle(payload.candle, parseAddress(pair), interval, 0, Number.MAX_SAFE_INTEGER)
  };
}

export function parsePoolStreamPayload(value: unknown, pair: Address): LivePoolUpdate {
  const payload = asRecord(value);
  const update = asRecord(payload.update);
  const expectedPair = parseAddress(pair);
  const state = parseLivePoolState(update.state, expectedPair);
  const binReplacements = asArray(update.binReplacements, "binReplacements")
    .map((bin) => parseLivePoolBin(bin, state.chainId, expectedPair, state.asOfBlock, state.asOfBlockHash));
  assertUnique(binReplacements.map((bin) => bin.binId), "pool-state replacement bin");
  const sourceEventIds = asArray(update.sourceEventIds, "sourceEventIds")
    .map((entry) => parseNonEmptyString(entry, "source event ID"));
  assertUnique(sourceEventIds, "source event ID");
  return {
    cursor: parseCursor(payload.cursor),
    eventId: parseNonEmptyString(update.eventId, "pool update event ID"),
    state,
    binReplacements,
    replaceBinWindow: parseBoolean(update.replaceBinWindow, "replaceBinWindow"),
    sourceEventIds
  };
}

/**
 * Applies an idempotent absolute replacement. A thrown error means the caller
 * must discard the cache and refetch the canonical bootstrap.
 */
export function applyPoolStateUpdate(current: LivePoolSnapshot, update: LivePoolUpdate): LivePoolSnapshot {
  if (update.state.pair !== current.state.pair || update.state.chainId !== current.state.chainId) {
    throw new Error("Pool stream update identity differs from the bootstrap");
  }
  if (
    update.state.tokenX !== current.state.tokenX ||
    update.state.tokenY !== current.state.tokenY ||
    update.state.decimalsX !== current.state.decimalsX ||
    update.state.decimalsY !== current.state.decimalsY ||
    update.state.binStep !== current.state.binStep
  ) {
    throw new Error("Pool stream changed immutable market identity");
  }
  const currentCursor = BigInt(parseCursor(current.streamCursor));
  const nextCursor = BigInt(parseCursor(update.cursor));
  if (nextCursor < currentCursor) throw new Error("Pool stream cursor moved backwards");
  if (nextCursor === currentCursor) {
    if (current.lastEventId === update.eventId) return current;
    throw new Error("Pool stream cursor was reused with different content");
  }
  const currentBlock = BigInt(current.state.asOfBlock);
  const nextBlock = BigInt(update.state.asOfBlock);
  if (nextBlock < currentBlock) throw new Error("Pool stream block moved backwards");
  if (nextBlock === currentBlock && update.state.asOfBlockHash !== current.state.asOfBlockHash) {
    throw new Error("Pool stream changed the canonical hash without a reset");
  }
  if (update.state.revision < current.state.revision) throw new Error("Pool stream revision moved backwards");
  if (update.state.revision === current.state.revision && update.eventId !== current.lastEventId) {
    throw new Error("Pool stream reused a revision with different content");
  }

  const bins = update.replaceBinWindow
    ? new Map<string, LivePoolBin>()
    : new Map(current.bins.map((bin) => [bin.binId, bin]));
  for (const bin of update.binReplacements) {
    const previous = bins.get(bin.binId);
    if (previous !== undefined && bin.revision < previous.revision) {
      throw new Error(`Pool bin ${bin.binId} revision moved backwards`);
    }
    bins.set(bin.binId, bin);
  }

  const active = BigInt(update.state.activeId);
  const radius = BigInt(current.radius);
  const minimum = active > radius ? active - radius : 0n;
  const maximum = active + radius > 16_777_215n ? 16_777_215n : active + radius;
  const bounded = [...bins.values()]
    .filter((bin) => BigInt(bin.binId) >= minimum && BigInt(bin.binId) <= maximum)
    .sort((left, right) => compareDecimal(left.binId, right.binId));
  if (bounded.length > current.radius * 2 + 1) throw new Error("Pool stream exceeded the bounded bin window");

  return {
    ...current,
    state: update.state,
    bins: bounded,
    streamCursor: update.cursor,
    lastEventId: update.eventId
  };
}

export async function loadAnalyticsHealth(
  endpoint: string | null,
  options: Pick<AnalyticsLoadOptions, "timeoutMs"> = {}
): Promise<AnalyticsValue<AnalyticsHealth>> {
  if (endpoint === null) return { value: null, status: "UNAVAILABLE", error: "Analytics endpoint is not configured" };
  const timeoutMs = normalizeBoundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs");
  try {
    const data = await fetchGraph(endpoint, ANALYTICS_HEALTH_QUERY, {}, timeoutMs);
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
  const pageSize = normalizeBoundedPositive(options.pageSize, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE, "pageSize");
  const maxPages = normalizeBoundedPositive(options.maxPages, DEFAULT_MAX_PAGES, DEFAULT_MAX_PAGES, "maxPages");
  const timeoutMs = normalizeBoundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs");
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
        return resultPage(rows, partial ? "PARTIAL" : "READY", connection.pageInfo, pageNumber + 1, null, connection.streamCursor);
      }
      const next = connection.pageInfo.endCursor;
      if (next === null || next === after) {
        return resultPage(rows, "PARTIAL", connection.pageInfo, pageNumber + 1, `${field} pagination cursor did not advance`, connection.streamCursor);
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
    totalSwapFees24hUsdE18: parseNullableDecimal(row.totalSwapFees24hUsdE18, "totalSwapFees24hUsdE18"),
    protocolSwapFees24hUsdE18: parseNullableDecimal(row.protocolSwapFees24hUsdE18, "protocolSwapFees24hUsdE18"),
    lpFees24hUsdE18: parseNullableDecimal(row.lpNetSwapFees24hUsdE18, "lpNetSwapFees24hUsdE18"),
    feeToTvlE18: parseNullableDecimal(row.lpNetSwapFeeToTvlE18, "lpNetSwapFeeToTvlE18"),
    feeBreakdownComplete: parseBoolean(row.feeBreakdownComplete, "feeBreakdownComplete"),
    priceUsdE18: parseNullableDecimal(row.priceUsdE18, "priceUsdE18"),
    asOfBlock: parseDecimal(row.asOfBlock, "asOfBlock"), asOfTimestamp: parseSafeInteger(row.asOfTimestamp, "asOfTimestamp"),
    status, missingPriceTokens
  };
  if (status === "READY" && (!result.feeBreakdownComplete || missingPriceTokens.length > 0 || Object.values(result).some((item) => item === null))) {
    throw new Error(`READY pool metrics are incomplete for ${result.pair}`);
  }
  return result;
}

function parsePoolDiscoveryRow(value: unknown): PoolDiscoveryAnalytics {
  const row = asRecord(value);
  const pair = parseAddress(row.pair);
  const tokenX = parseAddress(row.tokenX);
  const tokenY = parseAddress(row.tokenY);
  if (tokenX === tokenY) throw new Error(`poolDiscovery returned an identical token pair for ${pair}`);
  const displayBaseToken = parseAddress(row.displayBaseToken);
  const displayQuoteToken = parseAddress(row.displayQuoteToken);
  const canonicalTokens = new Set([tokenX, tokenY]);
  if (
    displayBaseToken === displayQuoteToken ||
    !canonicalTokens.has(displayBaseToken) ||
    !canonicalTokens.has(displayQuoteToken)
  ) throw new Error(`poolDiscovery returned an invalid display orientation for ${pair}`);

  const rawCloses = asArray(row.hourlyCloses, "hourlyCloses");
  if (rawCloses.length > 24) throw new Error(`poolDiscovery returned more than 24 hourly closes for ${pair}`);
  let previousTimestamp: number | null = null;
  const hourlyCloses = rawCloses.map((value) => {
    const close = asRecord(value);
    const startTimestamp = parseSafeInteger(close.startTimestamp, "hourly close startTimestamp");
    if (startTimestamp % CANDLE_INTERVAL_SECONDS.HOUR !== 0) throw new Error("Hourly close is not aligned to an hour boundary");
    if (previousTimestamp !== null && startTimestamp <= previousTimestamp) throw new Error("Hourly closes are not strictly ordered");
    previousTimestamp = startTimestamp;
    const quoteToken = parseAddress(close.quoteToken);
    if (quoteToken !== displayQuoteToken) throw new Error("Hourly close quote token differs from the display quote token");
    const closeUsdE18 = parseDecimal(close.closeUsdE18, "hourly closeUsdE18");
    if (BigInt(closeUsdE18) === 0n) throw new Error("Hourly close price must be positive");
    return {
      startTimestamp,
      closeUsdE18,
      quoteToken,
      finalized: parseBoolean(close.finalized, "hourly close finalized"),
      revision: parseSafeInteger(close.revision, "hourly close revision"),
      priceSource: parseNonEmptyString(close.priceSource, "hourly close priceSource"),
      firstBlockHash: parseBlockHash(close.firstBlockHash, "hourly close firstBlockHash"),
      lastBlockHash: parseBlockHash(close.lastBlockHash, "hourly close lastBlockHash")
    };
  });
  const status = parseStatus(row.status);
  const missingPriceTokens = parseAddresses(row.missingPriceTokens, "pool discovery missingPriceTokens");
  if (missingPriceTokens.some((token) => !canonicalTokens.has(token))) {
    throw new Error(`poolDiscovery returned a foreign missing-price token for ${pair}`);
  }
  let marketMetadata: PoolDiscoveryMarketMetadata | null = null;
  if (row.marketMetadata !== null) {
    // Provider enrichment is presentation-only and failure-isolated. A malformed
    // provider payload must not discard otherwise canonical pool economics.
    try { marketMetadata = parsePoolDiscoveryMarketMetadata(row.marketMetadata); } catch { marketMetadata = null; }
  }
  const parsedPoolPrice = parseNullableDecimal(row.poolPriceQuotePerBaseE18, "poolPriceQuotePerBaseE18");
  const result: PoolDiscoveryAnalytics = {
    pair,
    chainId: parseNullablePositiveInteger(row.chainId, "pool discovery chainId"),
    tokenX,
    tokenY,
    displayBaseToken,
    displayQuoteToken,
    poolPriceQuotePerBaseE18: parsedPoolPrice === "0" ? null : parsedPoolPrice,
    hourlyCloses,
    priceChange24hE18: parseNullableSignedDecimal(row.priceChange24hE18, "priceChange24hE18"),
    tvlUsdE18: parseNullableDecimal(row.tvlUsdE18, "pool discovery tvlUsdE18"),
    lpFees24hUsdE18: parseNullableDecimal(row.lpNetSwapFees24hUsdE18, "pool discovery lpNetSwapFees24hUsdE18"),
    volume24hUsdE18: parseNullableDecimal(row.volume24hUsdE18, "pool discovery volume24hUsdE18"),
    status,
    missingPriceTokens,
    asOfBlock: parseDecimal(row.asOfBlock, "pool discovery asOfBlock"),
    asOfBlockHash: parseBlockHash(row.asOfBlockHash, "pool discovery asOfBlockHash"),
    asOfTimestamp: parseSafeInteger(row.asOfTimestamp, "pool discovery asOfTimestamp"),
    marketMetadata
  };
  return result;
}

function parsePoolDiscoveryMarketMetadata(value: unknown): PoolDiscoveryMarketMetadata {
  const row = asRecord(value);
  const logoPath = parseNullableRelativeAssetPath(row.logoPath, "market metadata logoPath");
  const logoSource = parseNullableString(row.logoSource, "market metadata logoSource");
  if ((logoPath === null) !== (logoSource === null)) throw new Error("Market metadata logo path and source must be present together");
  const source = parseNonEmptyString(row.source, "market metadata source");
  if (source !== "dex-screener" || (logoSource !== null && logoSource !== "dex-screener")) {
    throw new Error("Unsupported market metadata source");
  }
  return {
    marketCapUsdE18: parseNullableDecimal(row.marketCapUsdE18, "market metadata marketCapUsdE18"),
    source,
    fetchedAt: parseSafeInteger(row.fetchedAt, "market metadata fetchedAt"),
    logoPath,
    logoSource
  };
}

function parseCandle(value: unknown, pair: Address, interval: CandleInterval, from: number, to: number): PairCandle {
  const row = asRecord(value);
  const rowPair = parseAddress(row.pair);
  if (rowPair !== pair) throw new Error(`pairCandles returned foreign pair ${rowPair}`);
  if (row.interval !== interval) throw new Error("pairCandles returned the wrong interval");
  const startTimestamp = parseSafeInteger(row.startTimestamp, "startTimestamp");
  const endTimestamp = parseSafeInteger(row.endTimestamp, "endTimestamp");
  const seconds = CANDLE_INTERVAL_SECONDS[interval];
  if (startTimestamp < from || startTimestamp > to || !isCandleBoundary(startTimestamp, interval) || endTimestamp !== startTimestamp + seconds) {
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
  const result: PairCandle = {
    pair, interval, startTimestamp, endTimestamp, openUsdE18: ohlc[0], highUsdE18: ohlc[1], lowUsdE18: ohlc[2], closeUsdE18: ohlc[3],
    volumeUsdE18: parseNullableDecimal(row.volumeUsdE18, "volumeUsdE18"),
    totalSwapFeesUsdE18: parseNullableDecimal(row.totalSwapFeesUsdE18, "totalSwapFeesUsdE18"),
    protocolSwapFeesUsdE18: parseNullableDecimal(row.protocolSwapFeesUsdE18, "protocolSwapFeesUsdE18"),
    lpFeesUsdE18: parseNullableDecimal(row.lpNetSwapFeesUsdE18, "lpNetSwapFeesUsdE18"),
    feeBreakdownComplete: parseBoolean(row.feeBreakdownComplete, "feeBreakdownComplete"),
    tvlUsdE18: parseNullableDecimal(row.tvlUsdE18, "tvlUsdE18"), swapCount: parseSafeInteger(row.swapCount, "swapCount"), status,
    missingPriceTokens,
    firstBlock,
    lastBlock,
    firstBlockHash: parseHash(row.firstBlockHash, "firstBlockHash"),
    lastBlockHash: parseHash(row.lastBlockHash, "lastBlockHash"),
    finalized: parseBoolean(row.finalized, "finalized"),
    revision: parseSafeInteger(row.revision, "revision"),
    priceSource: parseString(row.priceSource, "priceSource"),
    quoteToken: parseAddress(row.quoteToken)
  };
  if (status === "READY" && (
    missingPriceTokens.length > 0 || ohlc[0] === null || !result.feeBreakdownComplete ||
    result.volumeUsdE18 === null || result.totalSwapFeesUsdE18 === null ||
    result.protocolSwapFeesUsdE18 === null || result.lpFeesUsdE18 === null || result.tvlUsdE18 === null
  )) throw new Error("READY candle is incomplete");
  return result;
}

function parsePoolSnapshot(value: unknown, pair: Address, radius: number): LivePoolSnapshot {
  const row = asRecord(value);
  const state = parseLivePoolState(row.state, pair);
  const bins = asArray(row.bins, "pool bins")
    .map((bin) => parseLivePoolBin(bin, state.chainId, pair, state.asOfBlock, state.asOfBlockHash))
    .sort((left, right) => compareDecimal(left.binId, right.binId));
  assertUnique(bins.map((bin) => bin.binId), "pool-state bin");
  if (bins.length > radius * 2 + 1) throw new Error("Pool-state bootstrap exceeded its bounded bin window");
  const active = BigInt(state.activeId);
  for (const bin of bins) {
    const distance = BigInt(bin.binId) > active ? BigInt(bin.binId) - active : active - BigInt(bin.binId);
    if (distance > BigInt(radius)) throw new Error(`Pool-state bin ${bin.binId} is outside the requested radius`);
  }
  return {
    state,
    bins,
    streamCursor: parseCursor(row.streamCursor),
    radius,
    lastEventId: null
  };
}

function parseLivePoolState(value: unknown, pair: Address): LivePoolState {
  const row = asRecord(value);
  const rowPair = parseAddress(row.pair);
  if (rowPair !== pair) throw new Error(`poolState returned foreign pair ${rowPair}`);
  const chainId = parseSafeInteger(row.chainId, "chainId");
  if (chainId === 0) throw new Error("Pool-state chainId must be positive");
  const activeId = parseSafeInteger(row.activeId, "activeId");
  if (activeId > 16_777_215) throw new Error("Pool-state activeId is outside uint24");
  const binStep = parseSafeInteger(row.binStep, "binStep");
  if (binStep === 0 || binStep > 65_535) throw new Error("Pool-state binStep is outside uint16");
  const decimalsX = parseSafeInteger(row.decimalsX, "decimalsX");
  const decimalsY = parseSafeInteger(row.decimalsY, "decimalsY");
  if (decimalsX > 255 || decimalsY > 255) throw new Error("Pool-state token decimals are outside uint8");
  const status = parseStatus(row.status);
  const missingPriceTokens = parseAddresses(row.missingPriceTokens, "pool-state missingPriceTokens");
  const state: LivePoolState = {
    chainId,
    pair,
    tokenX: parseAddress(row.tokenX),
    tokenY: parseAddress(row.tokenY),
    decimalsX,
    decimalsY,
    reserveX: parseDecimal(row.reserveX, "reserveX"),
    reserveY: parseDecimal(row.reserveY, "reserveY"),
    activeId,
    binStep,
    marketPriceQuoteE18: parseDecimal(row.marketPriceQuoteE18, "marketPriceQuoteE18"),
    priceUsdE18: parseNullableDecimal(row.priceUsdE18, "priceUsdE18"),
    tvlUsdE18: parseNullableDecimal(row.tvlUsdE18, "tvlUsdE18"),
    status,
    missingPriceTokens,
    feeState: parsePoolFeeState(row.feeState),
    asOfBlock: parseDecimal(row.asOfBlock, "asOfBlock"),
    asOfBlockHash: parseBlockHash(row.asOfBlockHash, "asOfBlockHash"),
    asOfTimestamp: parseSafeInteger(row.asOfTimestamp, "asOfTimestamp"),
    revision: parseSafeInteger(row.revision, "revision")
  };
  if (status === "READY" && (state.priceUsdE18 === null || state.tvlUsdE18 === null || missingPriceTokens.length > 0)) {
    throw new Error("READY pool state is incomplete");
  }
  return state;
}

function parseLivePoolBin(
  value: unknown,
  chainId: number,
  pair: Address,
  maximumBlock: string,
  maximumBlockHash: string
): LivePoolBin {
  const row = asRecord(value);
  const rowChainId = parseSafeInteger(row.chainId, "bin chainId");
  const rowPair = parseAddress(row.pair);
  if (rowChainId !== chainId || rowPair !== pair) throw new Error("Pool bin identity differs from pool state");
  const binId = parseDecimal(row.binId, "binId");
  if (BigInt(binId) > 16_777_215n) throw new Error("Pool bin ID is outside uint24");
  const updatedAtBlock = parseDecimal(row.updatedAtBlock, "bin updatedAtBlock");
  if (BigInt(updatedAtBlock) > BigInt(maximumBlock)) throw new Error("Pool bin is newer than the pool snapshot");
  const updatedAtBlockHash = parseBlockHash(row.updatedAtBlockHash, "bin updatedAtBlockHash");
  if (updatedAtBlock === maximumBlock && updatedAtBlockHash !== maximumBlockHash) {
    throw new Error("Pool bin canonical hash differs from its pool snapshot");
  }
  return {
    chainId,
    pair,
    binId,
    reserveX: parseDecimal(row.reserveX, "bin reserveX"),
    reserveY: parseDecimal(row.reserveY, "bin reserveY"),
    totalSupply: parseDecimal(row.totalSupply, "bin totalSupply"),
    updatedAtBlock,
    updatedAtBlockHash,
    updatedAtTimestamp: parseSafeInteger(row.updatedAtTimestamp, "bin updatedAtTimestamp"),
    revision: parseSafeInteger(row.revision, "bin revision")
  };
}

function parsePoolFeeState(value: unknown): PoolFeeState {
  const row = asRecord(value);
  const staticFees = asRecord(row.static);
  const variableFees = asRecord(row.variable);
  return {
    static: {
      baseFactor: parseDecimal(staticFees.baseFactor, "baseFactor"),
      filterPeriod: parseDecimal(staticFees.filterPeriod, "filterPeriod"),
      decayPeriod: parseDecimal(staticFees.decayPeriod, "decayPeriod"),
      reductionFactor: parseDecimal(staticFees.reductionFactor, "reductionFactor"),
      variableFeeControl: parseDecimal(staticFees.variableFeeControl, "variableFeeControl"),
      protocolShare: parseDecimal(staticFees.protocolShare, "protocolShare"),
      maxVolatilityAccumulator: parseDecimal(staticFees.maxVolatilityAccumulator, "maxVolatilityAccumulator")
    },
    variable: {
      volatilityAccumulator: parseDecimal(variableFees.volatilityAccumulator, "volatilityAccumulator"),
      volatilityReference: parseDecimal(variableFees.volatilityReference, "volatilityReference"),
      idReference: parseDecimal(variableFees.idReference, "idReference"),
      timeOfLastUpdate: parseDecimal(variableFees.timeOfLastUpdate, "timeOfLastUpdate")
    }
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
    backfillError: parseNullableString(row.backfillError, "backfillError"), coverageStartTimestamp: parseNullableSignedDecimal(row.coverageStartTimestamp, "coverageStartTimestamp"),
    coverageThroughTimestamp: parseNullableSignedDecimal(row.coverageThroughTimestamp, "coverageThroughTimestamp"), prices
  };
}

function truthfulHealthStatus(health: AnalyticsHealth): AnalyticsStatus {
  if (health.status === "UNAVAILABLE" || health.headBlock === null) return "UNAVAILABLE";
  const ready = health.fresh && health.backfillStatus === "complete" && health.coverageStartTimestamp !== null && health.coverageThroughTimestamp !== null && health.partialEventCount === 0 && health.missingPriceTokens.length === 0 && health.prices.every((price) => price.status === "available");
  return health.status === "READY" && ready ? "READY" : "PARTIAL";
}

function parseConnection(value: unknown): { nodes: unknown[]; pageInfo: { endCursor: string | null; hasNextPage: boolean; partial: boolean }; streamCursor: string | null } {
  const connection = asRecord(value) as unknown as GraphConnection;
  const pageInfo = asRecord(connection.pageInfo);
  return { nodes: asArray(connection.nodes, "nodes"), pageInfo: { endCursor: parseNullableString(pageInfo.endCursor, "endCursor"), hasNextPage: parseBoolean(pageInfo.hasNextPage, "hasNextPage"), partial: parseBoolean(pageInfo.partial, "partial") }, streamCursor: connection.streamCursor === undefined ? null : parseNullableString(connection.streamCursor, "streamCursor") };
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

function resultPage<T>(rows: T[], status: AnalyticsStatus, pageInfo: { endCursor: string | null; hasNextPage: boolean; partial: boolean }, pagesLoaded: number, error: string | null, streamCursor: string | null = null): AnalyticsPage<T> {
  return { rows, status, pageInfo: { ...pageInfo, partial: pageInfo.partial || status !== "READY", pagesLoaded }, error, streamCursor };
}
function unavailablePage<T>(error: string): AnalyticsPage<T> { return resultPage([], "UNAVAILABLE", { endCursor: null, hasNextPage: false, partial: true }, 0, error); }
function rowStatus(value: unknown): AnalyticsStatus { const status = asRecord(value).status; return parseStatus(status); }
function parseStatus(value: unknown): AnalyticsStatus { if (value === "READY" || value === "PARTIAL" || value === "UNAVAILABLE") return value; throw new Error("Invalid analytics status"); }
function parseAddress(value: unknown): Address { if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error(`Invalid EVM address: ${String(value)}`); return value.toLowerCase() as Address; }
function parseAddresses(value: unknown, label: string): Address[] { const rows = asArray(value, label).map(parseAddress); assertUnique(rows, label); return rows; }
function assertUnique(values: readonly string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} address`); }
function parseDecimal(value: unknown, label: string): string { if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}`); return value; }
function parseNullableDecimal(value: unknown, label: string): string | null { return value === null ? null : parseDecimal(value, label); }
function parseSignedDecimal(value: unknown, label: string): string { if (typeof value !== "string" || !/^(0|-?[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}`); return value; }
function parseNullableSignedDecimal(value: unknown, label: string): string | null { return value === null ? null : parseSignedDecimal(value, label); }
function parseSafeInteger(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`); return value; }
function parseNullableInteger(value: unknown, label: string): number | null { return value === null ? null : parseSafeInteger(value, label); }
function parseNullablePositiveInteger(value: unknown, label: string): number | null { const parsed = parseNullableInteger(value, label); if (parsed === 0) throw new Error(`Invalid ${label}`); return parsed; }
function parseString(value: unknown, label: string): string { if (typeof value !== "string") throw new Error(`Invalid ${label}`); return value; }
function parseNullableString(value: unknown, label: string): string | null { return value === null ? null : parseString(value, label); }
function parseNullableRelativeAssetPath(value: unknown, label: string): string | null { if (value === null) return null; const path = parseString(value, label); if (!/^\/token-images\/[0-9a-f]{64}$/.test(path)) throw new Error(`Invalid ${label}`); return path; }
function parseHash(value: unknown, label: string): string { if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`Invalid ${label}`); return value.toLowerCase(); }
function parseBlockHash(value: unknown, label: string): string { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid ${label}`); return value.toLowerCase(); }
function parseBoolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`Invalid ${label}`); return value; }
function parseCursor(value: unknown): string { return parseDecimal(value, "stream cursor"); }
function parseNonEmptyString(value: unknown, label: string): string { const parsed = parseString(value, label); if (parsed.trim() === "") throw new Error(`Invalid ${label}`); return parsed; }
function asRecord(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected analytics object"); return value as Record<string, unknown>; }
function asArray(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`Invalid ${label}`); return value; }
function normalizeBoundedPositive(value: number | undefined, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = parseSafeInteger(value, label);
  if (parsed === 0 || parsed > maximum) throw new Error(`${label} must be between 1 and ${maximum}`);
  return parsed;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Analytics request failed"; }
function joinErrors(left: string | null, right: string): string { return left === null ? right : `${left}; ${right}`; }
function compareDecimal(left: string, right: string): number { const a = BigInt(left); const b = BigInt(right); return a < b ? -1 : a > b ? 1 : 0; }

function isCandleBoundary(timestamp: number, interval: CandleInterval): boolean {
  const seconds = CANDLE_INTERVAL_SECONDS[interval];
  if (interval !== "WEEK") return timestamp % seconds === 0;
  return (timestamp - MONDAY_EPOCH_OFFSET_SECONDS) % seconds === 0;
}
