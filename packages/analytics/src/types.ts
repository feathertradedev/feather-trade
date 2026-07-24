export type Hex = `0x${string}`;
export type AnalyticsStatus = "ready" | "partial" | "unavailable";
export type CandleInterval =
  | "minute"
  | "five-minutes"
  | "fifteen-minutes"
  | "hour"
  | "four-hours"
  | "day"
  | "week";
export type CandlePriceSource = "active-bin-quote-usd" | "trusted-token-usd" | "mixed";
export type PriceSource = "chainlink-data-feeds" | "chainlink-data-streams" | "fixed-test";
export type BackfillStatus = "unavailable" | "running" | "complete" | "partial" | "capped";

export interface PricePolicy {
  token: string;
  source: PriceSource;
  feedId: string;
  maxAgeSeconds: number;
  maxConfidenceBps: number;
  /** Expected on-chain feed decimals. Required for Chainlink Data Feeds. */
  feedDecimals?: number;
  /** Expected proxy description, such as "ETH / USD". Required for Chainlink Data Feeds. */
  feedDescription?: string;
}

export interface PriceSample {
  token: string;
  source: PriceSource;
  feedId: string;
  priceUsdE18: bigint;
  confidenceUsdE18: bigint;
  observedAt: number;
  sequence: bigint;
  verifiedBy: string;
}

export interface PriceSubmission extends Omit<PriceSample, "verifiedBy"> {
  signedReport: string | null;
}

export interface PairIdentity {
  pair: string;
  tokenX: string;
  tokenY: string;
  decimalsX: number;
  decimalsY: number;
  /**
   * Canonical factory provenance. Legacy checkpoints may omit these fields,
   * but live EVM adapters attach them from the factory creation log.
   */
  factoryAddress?: string | null;
  createdAtBlock?: bigint | null;
  createdAtBlockHash?: Hex | null;
  creationTransactionHash?: Hex | null;
  creationLogIndex?: number | null;
}

/**
 * Canonical source identity retained from the indexer. Log identities are
 * chain-scoped by the containing BlockEnvelope. Legacy checkpoints may omit
 * this field, but live adapters must provide it so duplicate delivery is
 * idempotent and conflicting duplicates fail closed.
 */
export interface CanonicalEventSource {
  eventId: string;
  transactionHash: Hex | null;
  logIndex: number | null;
  sequence: number;
  kind: "log" | "block-snapshot";
}

export interface CanonicalEventMetadata {
  source?: CanonicalEventSource;
}

export interface PairMarketObservation {
  /** Active-bin token-Y-per-token-X price, normalized to 18 decimals. */
  marketPriceQuoteE18?: bigint | null;
  activeId?: number | null;
  binStep?: number | null;
}

export interface PoolStaticFeeParameters {
  baseFactor: bigint;
  filterPeriod: bigint;
  decayPeriod: bigint;
  reductionFactor: bigint;
  variableFeeControl: bigint;
  protocolShare: bigint;
  maxVolatilityAccumulator: bigint;
}

export interface PoolVariableFeeParameters {
  volatilityAccumulator: bigint;
  volatilityReference: bigint;
  idReference: bigint;
  timeOfLastUpdate: bigint;
}

export interface PoolFeeState {
  static: PoolStaticFeeParameters;
  variable: PoolVariableFeeParameters;
}

/** Complete, absolute state for one bin at a canonical block. */
export interface PoolBinSnapshot {
  binId: string;
  reserveX: bigint;
  reserveY: bigint;
  totalSupply: bigint;
}

/**
 * End-of-block pool observation. The adapter consolidates all logs for the
 * pair and exact-reads only the affected bins. Arithmetic deltas are never
 * sent over the live-state path.
 */
export interface PoolStateObservation {
  feeState: PoolFeeState;
  binUpdates: PoolBinSnapshot[];
  sourceEventIds: string[];
  /** Forces clients to discard their bin window before applying replacements. */
  replaceBinWindow: boolean;
}

export interface PairSnapshotEvent extends PairIdentity, PairMarketObservation, CanonicalEventMetadata {
  kind: "pair-snapshot";
  reserveX: bigint;
  reserveY: bigint;
  poolState?: PoolStateObservation;
}

export interface SwapAnalyticsEvent extends PairIdentity, PairMarketObservation, CanonicalEventMetadata {
  kind: "swap";
  amountInX: bigint;
  amountInY: bigint;
  /** Legacy checkpoint field: the total trader-paid swap fee in token X. */
  feeX: bigint;
  /** Legacy checkpoint field: the total trader-paid swap fee in token Y. */
  feeY: bigint;
  /** Indexed protocol share of feeX. Missing on legacy checkpoints. */
  protocolFeeX?: bigint | null;
  /** Indexed protocol share of feeY. Missing on legacy checkpoints. */
  protocolFeeY?: bigint | null;
  reserveX: bigint;
  reserveY: bigint;
}

export interface PositionBinChange {
  binId: string;
  liquidityDelta: bigint;
  amountX: bigint;
  amountY: bigint;
}

export interface LiquidityAnalyticsEvent extends PairIdentity, PairMarketObservation, CanonicalEventMetadata {
  kind: "deposit" | "withdraw";
  owner: string;
  bins: PositionBinChange[];
  reserveX: bigint;
  reserveY: bigint;
}

export interface PositionBinValuation {
  binId: string;
  liquidity: bigint;
  amountX: bigint;
  amountY: bigint;
}

export interface PositionSnapshotEvent extends PairIdentity, CanonicalEventMetadata {
  kind: "position-snapshot";
  owner: string;
  bins: PositionBinValuation[];
}

export interface PositionTransferEvent extends PairIdentity, CanonicalEventMetadata {
  kind: "position-transfer";
  from: string;
  to: string;
  bins: Array<{ binId: string; liquidity: bigint }>;
}

export type AnalyticsEvent =
  | PairSnapshotEvent
  | SwapAnalyticsEvent
  | LiquidityAnalyticsEvent
  | PositionSnapshotEvent
  | PositionTransferEvent;

export interface BlockEnvelope {
  /** Required for live pool-state ingestion; omitted only by legacy checkpoints. */
  chainId?: number;
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  prices: PriceSample[];
  events: AnalyticsEvent[];
}

export interface PoolBinState extends PoolBinSnapshot {
  chainId: number;
  pair: string;
  updatedAtBlock: bigint;
  updatedAtBlockHash: Hex;
  updatedAtTimestamp: number;
  revision: number;
}

export interface PoolState {
  chainId: number;
  pair: string;
  factoryAddress?: string | null;
  tokenX: string;
  tokenY: string;
  decimalsX: number;
  decimalsY: number;
  createdAtBlock?: bigint | null;
  createdAtBlockHash?: Hex | null;
  creationTransactionHash?: Hex | null;
  creationLogIndex?: number | null;
  reserveX: bigint;
  reserveY: bigint;
  activeId: number;
  binStep: number;
  marketPriceQuoteE18: bigint;
  /** Display/candle price only; never an authoritative TVL input. */
  priceUsdE18: bigint | null;
  tvlUsdE18: bigint | null;
  status: AnalyticsStatus;
  missingPriceTokens: string[];
  feeState: PoolFeeState;
  asOfBlock: bigint;
  asOfBlockHash: Hex;
  asOfTimestamp: number;
  revision: number;
}

export interface PoolStateSnapshot {
  state: PoolState;
  bins: PoolBinState[];
}

/** Complete scalar replacement plus only the bins changed in one block. */
export interface PoolStateUpdate {
  eventId: string;
  state: PoolState;
  binReplacements: PoolBinState[];
  replaceBinWindow: boolean;
  sourceEventIds: string[];
}

export interface BlockSubmission extends Omit<BlockEnvelope, "prices"> {
  prices: PriceSubmission[];
}

export interface Candle {
  pair: string;
  interval: CandleInterval;
  startTimestamp: number;
  endTimestamp: number;
  openUsdE18: bigint | null;
  highUsdE18: bigint | null;
  lowUsdE18: bigint | null;
  closeUsdE18: bigint | null;
  volumeUsdE18: bigint | null;
  /** @deprecated Total trader-paid swap fees. Use totalSwapFeesUsdE18. */
  feesUsdE18: bigint | null;
  totalSwapFeesUsdE18: bigint | null;
  protocolSwapFeesUsdE18: bigint | null;
  lpNetSwapFeesUsdE18: bigint | null;
  feeBreakdownComplete: boolean;
  tvlUsdE18: bigint | null;
  swapCount: number;
  status: AnalyticsStatus;
  missingPriceTokens: string[];
  firstBlock: bigint;
  lastBlock: bigint;
  firstBlockHash: Hex;
  lastBlockHash: Hex;
  finalized: boolean;
  revision: number;
  priceSource: CandlePriceSource;
  quoteToken: string;
}

export interface PoolMetrics {
  pair: string;
  tokenX: string;
  tokenY: string;
  tvlUsdE18: bigint | null;
  volume24hUsdE18: bigint | null;
  /** @deprecated Total trader-paid swap fees. Use totalSwapFees24hUsdE18. */
  fees24hUsdE18: bigint | null;
  /** @deprecated Total trader-paid fee / TVL. Use lpNetSwapFeeToTvlE18 for LP economics. */
  feeToTvlE18: bigint | null;
  totalSwapFees24hUsdE18: bigint | null;
  protocolSwapFees24hUsdE18: bigint | null;
  lpNetSwapFees24hUsdE18: bigint | null;
  lpNetSwapFeeToTvlE18: bigint | null;
  feeBreakdownComplete: boolean;
  priceUsdE18: bigint | null;
  asOfBlock: bigint;
  asOfTimestamp: number;
  status: AnalyticsStatus;
  missingPriceTokens: string[];
}

export interface PoolDiscoveryRequest {
  pair: string;
  preferredQuoteToken?: string | null;
}

export interface PoolDiscoveryHourlyClose {
  startTimestamp: number;
  closeUsdE18: bigint;
  quoteToken: string;
  finalized: boolean;
  revision: number;
  priceSource: CandlePriceSource;
  firstBlockHash: Hex;
  lastBlockHash: Hex;
}

/**
 * Presentation-only provider data. This is deliberately separate from the
 * canonical analytics values and must never participate in pricing, TVL,
 * allowlisting, routing, or transaction construction.
 */
export interface PoolDiscoveryMarketMetadata {
  marketCapUsdE18: bigint | null;
  source: "dex-screener";
  fetchedAt: number;
  /** Relative, opaque analytics proxy path. Never a provider URL. */
  logoPath: string | null;
  logoSource: "dex-screener" | null;
}

export interface PoolDiscoveryPool {
  pair: string;
  chainId: number | null;
  tokenX: string;
  tokenY: string;
  displayBaseToken: string;
  displayQuoteToken: string;
  /** Display quote tokens per display base token, normalized to 18 decimals. */
  poolPriceQuotePerBaseE18: bigint | null;
  hourlyCloses: PoolDiscoveryHourlyClose[];
  /** Signed percentage change, where 1e18 is 100%. */
  priceChange24hE18: bigint | null;
  tvlUsdE18: bigint | null;
  lpNetSwapFees24hUsdE18: bigint | null;
  volume24hUsdE18: bigint | null;
  status: AnalyticsStatus;
  missingPriceTokens: string[];
  asOfBlock: bigint;
  asOfBlockHash: Hex;
  asOfTimestamp: number;
  marketMetadata: PoolDiscoveryMarketMetadata | null;
}

export interface PositionBinAccounting {
  binId: string;
  liquidity: bigint;
  costBasisUsdE18: bigint | null;
  currentValueUsdE18: bigint | null;
  realizedPnlUsdE18: bigint | null;
  unrealizedPnlUsdE18: bigint | null;
  amountX: bigint | null;
  amountY: bigint | null;
  asOfBlock: bigint | null;
  asOfTimestamp: number | null;
  status: AnalyticsStatus;
  missingPriceTokens: string[];
}

export interface WalletPairPosition {
  owner: string;
  pair: string;
  bins: PositionBinAccounting[];
  costBasisUsdE18: bigint | null;
  currentValueUsdE18: bigint | null;
  realizedPnlUsdE18: bigint | null;
  unrealizedPnlUsdE18: bigint | null;
  status: AnalyticsStatus;
  missingPriceTokens: string[];
  asOfBlock: bigint | null;
  asOfTimestamp: number | null;
}

export type PoolActivityKind = "swap" | "deposit" | "withdraw" | "position-transfer";

/**
 * One immutable event from the retained canonical chain. The canonical block
 * hash is part of the row identity, so a reorg replaces orphaned rows instead
 * of silently reusing their identifiers.
 */
export interface PoolActivityEvent {
  id: string;
  pair: string;
  kind: PoolActivityKind;
  owner: string | null;
  from: string | null;
  to: string | null;
  amountX: bigint | null;
  amountY: bigint | null;
  binIds: string[];
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex | null;
  logIndex: number | null;
  sequence: number;
  timestamp: number;
  revision: number;
}

export interface PoolActivityConnection extends Connection<PoolActivityEvent> {
  asOfBlock: bigint | null;
  asOfBlockHash: Hex | null;
}

export interface PageInfo {
  endCursor: string | null;
  hasNextPage: boolean;
  partial: boolean;
}

export interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
}

export interface AnalyticsHealth {
  status: AnalyticsStatus;
  headBlock: bigint | null;
  headHash: Hex | null;
  headTimestamp: number | null;
  canonicalBlockCount: number;
  reorgCount: number;
  partialEventCount: number;
  missingPriceTokens: string[];
  fresh: boolean;
  headLagSeconds: number | null;
  maxHeadLagSeconds: number;
  backfillStatus: BackfillStatus;
  backfillCursor: string | null;
  backfillError: string | null;
  coverageStartTimestamp: number | null;
  coverageThroughTimestamp: number | null;
  prices: PriceHealth[];
}

export interface PriceHealth {
  token: string;
  source: PriceSource;
  feedId: string;
  status: "available" | "missing-policy" | "missing-sample" | "stale" | "invalid-confidence";
  observedAt: number | null;
  ageSeconds: number | null;
}

export interface TrustedPairPrice {
  baseToken: string;
  quoteToken: string;
  quotePerBaseE18: bigint | null;
  status: AnalyticsStatus;
  baseSource: PriceSource | null;
  quoteSource: PriceSource | null;
  baseObservedAt: number | null;
  quoteObservedAt: number | null;
  baseAgeSeconds: number | null;
  quoteAgeSeconds: number | null;
  asOfBlock: bigint | null;
  asOfBlockHash: Hex | null;
  asOfTimestamp: number | null;
}
