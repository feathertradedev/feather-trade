export type Hex = `0x${string}`;
export type AnalyticsStatus = "ready" | "partial" | "unavailable";
export type CandleInterval = "hour" | "day";
export type PriceSource = "chainlink-data-streams" | "fixed-test";
export type BackfillStatus = "unavailable" | "running" | "complete" | "partial" | "capped";

export interface PricePolicy {
  token: string;
  source: PriceSource;
  feedId: string;
  maxAgeSeconds: number;
  maxConfidenceBps: number;
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
}

export interface PairSnapshotEvent extends PairIdentity {
  kind: "pair-snapshot";
  reserveX: bigint;
  reserveY: bigint;
}

export interface SwapAnalyticsEvent extends PairIdentity {
  kind: "swap";
  amountInX: bigint;
  amountInY: bigint;
  feeX: bigint;
  feeY: bigint;
  reserveX: bigint;
  reserveY: bigint;
}

export interface PositionBinChange {
  binId: string;
  liquidityDelta: bigint;
  amountX: bigint;
  amountY: bigint;
}

export interface LiquidityAnalyticsEvent extends PairIdentity {
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

export interface PositionSnapshotEvent extends PairIdentity {
  kind: "position-snapshot";
  owner: string;
  bins: PositionBinValuation[];
}

export interface PositionTransferEvent extends PairIdentity {
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
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  prices: PriceSample[];
  events: AnalyticsEvent[];
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
  feesUsdE18: bigint | null;
  tvlUsdE18: bigint | null;
  swapCount: number;
  status: AnalyticsStatus;
  missingPriceTokens: string[];
  firstBlock: bigint;
  lastBlock: bigint;
}

export interface PoolMetrics {
  pair: string;
  tokenX: string;
  tokenY: string;
  tvlUsdE18: bigint | null;
  volume24hUsdE18: bigint | null;
  fees24hUsdE18: bigint | null;
  feeToTvlE18: bigint | null;
  priceUsdE18: bigint | null;
  asOfBlock: bigint;
  asOfTimestamp: number;
  status: AnalyticsStatus;
  missingPriceTokens: string[];
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
