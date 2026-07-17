import { ratioE18, tokenAmountToUsd } from "./fixed.js";
import { TrustedPriceBook } from "./pricing.js";
import type {
  AnalyticsEvent,
  AnalyticsHealth,
  AnalyticsStatus,
  BackfillStatus,
  BlockEnvelope,
  Candle,
  CandleInterval,
  CandlePriceSource,
  Connection,
  Hex,
  LiquidityAnalyticsEvent,
  PairIdentity,
  PairSnapshotEvent,
  PoolBinSnapshot,
  PoolBinState,
  PoolMetrics,
  PoolState,
  PoolStateObservation,
  PoolStateSnapshot,
  PoolStateUpdate,
  PositionBinAccounting,
  PositionSnapshotEvent,
  PositionTransferEvent,
  PricePolicy,
  SwapAnalyticsEvent,
  WalletPairPosition
} from "./types.js";

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const MINUTE_SECONDS = 60;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const MONDAY_EPOCH_OFFSET_SECONDS = 4 * DAY_SECONDS;
const MAX_PAGE_SIZE = 100;
const MAX_CANDLE_POINTS = 500;
const USD_SCALE = 10n ** 18n;
export const FULL_HISTORY_START_TIMESTAMP = Number.MIN_SAFE_INTEGER;

export const CANDLE_INTERVALS: readonly CandleInterval[] = [
  "minute",
  "five-minutes",
  "fifteen-minutes",
  "hour",
  "four-hours",
  "day",
  "week"
];

interface PairState extends PairIdentity {
  reserveX: bigint;
  reserveY: bigint;
  tvlUsdE18: bigint | null;
  priceUsdE18: bigint | null;
  priceSource: CandlePriceSource;
  quoteToken: string;
  activeId: number | null;
  binStep: number | null;
  marketPriceQuoteE18: bigint | null;
  missingPriceTokens: Set<string>;
  updatedAtBlock: bigint;
  updatedAtBlockHash: Hex;
  updatedAtTimestamp: number;
}

interface FlowRow {
  pair: string;
  timestamp: number;
  volumeUsdE18: bigint | null;
  totalSwapFeesUsdE18: bigint | null;
  protocolSwapFeesUsdE18: bigint | null;
  lpNetSwapFeesUsdE18: bigint | null;
  feeBreakdownComplete: boolean;
  missingPriceTokens: Set<string>;
}

interface MutableCandle {
  pair: string;
  interval: CandleInterval;
  startTimestamp: number;
  endTimestamp: number;
  openUsdE18: bigint | null;
  highUsdE18: bigint | null;
  lowUsdE18: bigint | null;
  closeUsdE18: bigint | null;
  volumeUsdE18: bigint;
  totalSwapFeesUsdE18: bigint;
  protocolSwapFeesUsdE18: bigint;
  lpNetSwapFeesUsdE18: bigint;
  tvlUsdE18: bigint | null;
  swapCount: number;
  missingVolumeValue: boolean;
  missingTotalSwapFeeValue: boolean;
  missingProtocolSwapFeeValue: boolean;
  missingLpNetSwapFeeValue: boolean;
  missingPriceTokens: Set<string>;
  firstBlock: bigint;
  lastBlock: bigint;
  firstBlockHash: Hex;
  lastBlockHash: Hex;
  revision: number;
  priceSource: CandlePriceSource | null;
  quoteToken: string;
}

interface MutablePositionBin {
  binId: string;
  liquidity: bigint;
  costBasisUsdE18: bigint | null;
  currentValueUsdE18: bigint | null;
  realizedPnlUsdE18: bigint | null;
  historyMissingPriceTokens: Set<string>;
  currentMissingPriceTokens: Set<string>;
  amountX: bigint | null;
  amountY: bigint | null;
  snapshotBlock: bigint | null;
  snapshotTimestamp: number | null;
}

interface MutableWalletPairPosition extends PairIdentity {
  owner: string;
  bins: Map<string, MutablePositionBin>;
}

interface ValuedAmounts {
  totalUsdE18: bigint | null;
  missingPriceTokens: Set<string>;
}

interface CanonicalEventContext {
  chainId: number | null;
  sources: ReadonlyMap<string, string>;
}

export interface AnalyticsEngineOptions {
  assumeCompleteHistory?: boolean;
  maxHeadLagSeconds?: number;
  maxPositionSnapshotAgeSeconds?: number;
}

export interface BackfillStateUpdate {
  status: BackfillStatus;
  cursor: string | null;
  error: string | null;
  coverageStartTimestamp?: number | null;
  coverageThroughTimestamp?: number | null;
}

export interface AnalyticsCheckpoint {
  version: 1;
  reorgCount: number;
  blocks: BlockEnvelope[];
  backfill: BackfillStateUpdate & {
    coverageStartTimestamp: number | null;
    coverageThroughTimestamp: number | null;
  };
}

export type AnalyticsCheckpointMetadata = Omit<AnalyticsCheckpoint, "blocks">;

export interface CanonicalHead {
  number: bigint;
  hash: string;
  timestamp: number;
}

export class ReorgBeyondCanonicalHistoryError extends Error {}
export class CanonicalHeadChangedError extends Error {}

export class AnalyticsEngine {
  readonly #policies: PricePolicy[];
  readonly #blocks: BlockEnvelope[] = [];
  #priceBook: TrustedPriceBook;
  #pairs = new Map<string, PairState>();
  #pairSnapshots: PairState[] = [];
  #flows: FlowRow[] = [];
  #candles = new Map<string, MutableCandle>();
  #positions = new Map<string, MutableWalletPairPosition>();
  #poolStates = new Map<string, PoolState>();
  #poolBins = new Map<string, Map<string, PoolBinState>>();
  #lastChangedPoolUpdates: PoolStateUpdate[] = [];
  #canonicalChainId: number | null = null;
  #canonicalEventFingerprints = new Map<string, string>();
  #lastChangedCandleKeys = new Set<string>();
  #reorgCount = 0;
  #partialEventCount = 0;
  #eventIsPartial = false;
  #missingPriceTokens = new Set<string>();
  #backfillStatus: BackfillStatus;
  #backfillCursor: string | null = null;
  #backfillError: string | null = null;
  #coverageStartTimestamp: number | null;
  #coverageThroughTimestamp: number | null = null;
  readonly #maxHeadLagSeconds: number;
  readonly #maxPositionSnapshotAgeSeconds: number;

  constructor(policies: readonly PricePolicy[], options: AnalyticsEngineOptions = {}) {
    this.#policies = policies.map((policy) => ({ ...policy, token: normalize(policy.token) }));
    this.#priceBook = new TrustedPriceBook(this.#policies);
    this.#maxHeadLagSeconds = positiveInteger(options.maxHeadLagSeconds ?? 120, "maxHeadLagSeconds");
    this.#maxPositionSnapshotAgeSeconds = positiveInteger(
      options.maxPositionSnapshotAgeSeconds ?? 300,
      "maxPositionSnapshotAgeSeconds"
    );
    this.#backfillStatus = options.assumeCompleteHistory ? "complete" : "unavailable";
    this.#coverageStartTimestamp = options.assumeCompleteHistory ? FULL_HISTORY_START_TIMESTAMP : null;
  }

  ingestBlock(block: BlockEnvelope): "appended" | "duplicate" | "reorg" {
    validateBlock(block);
    const existingIndex = this.#blocks.findIndex((candidate) => sameHash(candidate.hash, block.hash));
    if (existingIndex >= 0) {
      const existing = this.#blocks[existingIndex]!;
      if (existing.number !== block.number) throw new Error(`Block hash ${block.hash} changed number`);
      const incoming = canonicalizeBlock(block, canonicalEventContext(this.#blocks.slice(0, existingIndex)));
      if (!sameBlockPayload(existing, withMissingPositionSnapshots(incoming, existing))) {
        throw new Error(`Block hash ${block.hash} changed payload`);
      }
      this.#lastChangedCandleKeys = new Set();
      this.#lastChangedPoolUpdates = [];
      return "duplicate";
    }

    const head = this.#blocks.at(-1);
    if (!head) {
      const incoming = canonicalizeBlock(block, { chainId: null, sources: new Map() });
      this.#blocks.push(cloneBlock(incoming));
      this.#lastChangedCandleKeys = this.#applyCanonicalAppend(incoming, null);
      this.#recordCanonicalEventIdentities(incoming);
      this.#advanceCoverage(incoming.timestamp);
      return "appended";
    }

    if (block.number === head.number + 1n && sameHash(block.parentHash, head.hash)) {
      const incoming = canonicalizeBlock(block, {
        chainId: this.#canonicalChainId,
        sources: this.#canonicalEventFingerprints
      });
      this.#blocks.push(cloneBlock(incoming));
      this.#lastChangedCandleKeys = this.#applyCanonicalAppend(incoming, head.timestamp);
      this.#recordCanonicalEventIdentities(incoming);
      this.#advanceCoverage(incoming.timestamp);
      return "appended";
    }

    const parentIndex = this.#blocks.findIndex((candidate) => sameHash(candidate.hash, block.parentHash));
    if (parentIndex < 0) {
      throw new ReorgBeyondCanonicalHistoryError(`Parent ${block.parentHash} is outside retained canonical history`);
    }

    const parent = this.#blocks[parentIndex];
    if (block.number !== parent.number + 1n) {
      throw new Error(`Block ${block.number} does not follow parent ${parent.number}`);
    }

    const incoming = canonicalizeBlock(block, canonicalEventContext(this.#blocks.slice(0, parentIndex + 1)));
    this.#blocks.splice(parentIndex + 1, this.#blocks.length, cloneBlock(incoming));
    this.#replaceCanonicalEventIdentityIndex();
    this.#reorgCount += 1;
    this.#rebuild();
    this.#lastChangedCandleKeys = new Set(this.#candles.keys());
    this.#advanceCoverage(incoming.timestamp);
    return "reorg";
  }

  /**
   * Reconciles a canonical head that moved strictly backwards without a
   * replacement child block yet. This is required for local snapshot/revert
   * workflows: keeping the orphan suffix query-visible until the chain grows
   * again would make pool state and replay cursors non-canonical.
   */
  rewindCanonicalHead(expectedHead: CanonicalHead): "duplicate" | "reorg" {
    if (expectedHead.number < 0n || !Number.isSafeInteger(expectedHead.timestamp) || expectedHead.timestamp < 0) {
      throw new Error("Canonical rewind head is invalid");
    }
    if (!/^0x[0-9a-fA-F]+$/.test(expectedHead.hash)) throw new Error("Canonical rewind hash must be hex");
    const index = this.#blocks.findIndex((block) => block.number === expectedHead.number);
    if (index < 0) {
      throw new ReorgBeyondCanonicalHistoryError(
        `Canonical rewind head ${expectedHead.number}:${expectedHead.hash} is outside retained history`
      );
    }
    const retained = this.#blocks[index]!;
    if (!sameHash(retained.hash, expectedHead.hash) || retained.timestamp !== expectedHead.timestamp) {
      throw new CanonicalHeadChangedError(
        `Canonical rewind head ${expectedHead.number}:${expectedHead.hash} does not match retained ${retained.hash}`
      );
    }
    if (index === this.#blocks.length - 1) {
      this.#lastChangedCandleKeys = new Set();
      this.#lastChangedPoolUpdates = [];
      return "duplicate";
    }

    this.#blocks.splice(index + 1);
    this.#replaceCanonicalEventIdentityIndex();
    this.#reorgCount += 1;
    this.#rebuild();
    this.#lastChangedCandleKeys = new Set(this.#candles.keys());
    this.#lastChangedPoolUpdates = [];
    if (this.#coverageThroughTimestamp !== null) {
      this.#coverageThroughTimestamp = Math.min(this.#coverageThroughTimestamp, retained.timestamp);
    }
    return "reorg";
  }

  updateBackfillState(update: BackfillStateUpdate): void {
    this.#backfillStatus = update.status;
    this.#backfillCursor = update.cursor;
    this.#backfillError = update.error;
    if (update.coverageStartTimestamp !== undefined) this.#coverageStartTimestamp = update.coverageStartTimestamp;
    if (update.coverageThroughTimestamp !== undefined) this.#coverageThroughTimestamp = update.coverageThroughTimestamp;
  }

  exportCheckpoint(): AnalyticsCheckpoint {
    return {
      ...this.exportCheckpointMetadata(),
      blocks: structuredClone(this.#blocks),
    };
  }

  exportCheckpointMetadata(): AnalyticsCheckpointMetadata {
    return {
      version: 1,
      reorgCount: this.#reorgCount,
      backfill: {
        status: this.#backfillStatus,
        cursor: this.#backfillCursor,
        error: this.#backfillError,
        coverageStartTimestamp: this.#coverageStartTimestamp,
        coverageThroughTimestamp: this.#coverageThroughTimestamp
      }
    };
  }

  getCanonicalHead(): CanonicalHead | null {
    const head = this.#blocks.at(-1);
    return head ? { number: head.number, hash: head.hash, timestamp: head.timestamp } : null;
  }

  getCanonicalHeadEnvelope(): BlockEnvelope | null {
    const head = this.#blocks.at(-1);
    return head === undefined ? null : cloneBlock(head);
  }

  augmentHeadPositionSnapshots(expectedHead: CanonicalHead, snapshots: readonly PositionSnapshotEvent[]): void {
    const head = this.#blocks.at(-1);
    if (!head) throw new Error("Cannot attach position snapshots before the canonical head exists");
    if (head.number !== expectedHead.number || !sameHash(head.hash, expectedHead.hash)) {
      throw new CanonicalHeadChangedError(
        `Canonical head changed from ${expectedHead.number}:${expectedHead.hash} to ${head.number}:${head.hash}`
      );
    }
    const replacementKeys = new Set(
      snapshots.map((snapshot) => `${normalize(snapshot.owner)}:${normalize(snapshot.pair)}`)
    );
    const candidate: BlockEnvelope = { ...head, events: [
      ...head.events.filter(
        (event) =>
          event.kind !== "position-snapshot" ||
          !replacementKeys.has(`${normalize(event.owner)}:${normalize(event.pair)}`)
      ),
      ...structuredClone(snapshots)
    ] };
    validateBlock(candidate);
    head.events = canonicalizeBlock(candidate, canonicalEventContext(this.#blocks.slice(0, -1))).events;
    this.#replaceCanonicalEventIdentityIndex();
    this.#rebuild();
  }

  restoreCheckpoint(checkpoint: AnalyticsCheckpoint): void {
    if (this.#blocks.length > 0) throw new Error("Cannot restore over non-empty analytics state");
    if (checkpoint.version !== 1) throw new Error("Unsupported analytics checkpoint version");
    if (!Number.isSafeInteger(checkpoint.reorgCount) || checkpoint.reorgCount < 0) {
      throw new Error("Analytics checkpoint reorgCount is invalid");
    }
    if (!Array.isArray(checkpoint.blocks)) throw new Error("Analytics checkpoint blocks are invalid");
    if (!isBackfillStatus(checkpoint.backfill?.status)) throw new Error("Analytics checkpoint backfill status is invalid");
    for (const block of checkpoint.blocks) this.ingestBlock(block);
    this.#reorgCount = checkpoint.reorgCount;
    this.updateBackfillState(checkpoint.backfill);
  }

  getHealth(nowTimestamp = Math.floor(Date.now() / 1_000)): AnalyticsHealth {
    const head = this.#blocks.at(-1) ?? null;
    const headLagSeconds = head === null ? null : Math.max(0, nowTimestamp - head.timestamp);
    const fresh = headLagSeconds !== null && headLagSeconds <= this.#maxHeadLagSeconds;
    const backfillReady =
      this.#backfillStatus === "complete" &&
      this.#coverageStartTimestamp !== null &&
      this.#coverageThroughTimestamp !== null &&
      (head === null || this.#coverageThroughTimestamp >= head.timestamp);
    const prices = this.#policies.map((policy) => {
      const result = this.#priceBook.inspect(policy.token, nowTimestamp);
      return {
        token: policy.token,
        source: policy.source,
        feedId: policy.feedId,
        status: result.reason,
        observedAt: result.sample?.observedAt ?? null,
        ageSeconds: result.sample === null ? null : Math.max(0, nowTimestamp - result.sample.observedAt)
      };
    });
    const pricingReady = prices.every((price) => price.status === "available");
    const status: AnalyticsStatus =
      head === null
        ? "unavailable"
        : this.#partialEventCount > 0 || !fresh || !backfillReady || !pricingReady
          ? "partial"
          : "ready";
    return {
      status,
      headBlock: head?.number ?? null,
      headHash: head?.hash ?? null,
      headTimestamp: head?.timestamp ?? null,
      canonicalBlockCount: this.#blocks.length,
      reorgCount: this.#reorgCount,
      partialEventCount: this.#partialEventCount,
      missingPriceTokens: [...this.#missingPriceTokens].sort(),
      fresh,
      headLagSeconds,
      maxHeadLagSeconds: this.#maxHeadLagSeconds,
      backfillStatus: this.#backfillStatus,
      backfillCursor: this.#backfillCursor,
      backfillError: this.#backfillError,
      coverageStartTimestamp: this.#coverageStartTimestamp,
      coverageThroughTimestamp: this.#coverageThroughTimestamp,
      prices
    };
  }

  queryPoolMetrics(input: { first: number; after?: string | null; asOfTimestamp?: number }): Connection<PoolMetrics> {
    const head = this.#blocks.at(-1);
    const asOfTimestamp = input.asOfTimestamp ?? head?.timestamp ?? 0;
    const rows = [...this.#pairs.keys()]
      .map((pairId) => this.#pairStateAt(pairId, asOfTimestamp))
      .filter((pair): pair is PairState => pair !== null)
      .sort((a, b) => a.pair.localeCompare(b.pair))
      .map((pair) => this.#poolMetrics(pair, asOfTimestamp));
    return paginate(rows, input.first, input.after, head?.hash ?? "empty", !this.#historyCovers(asOfTimestamp - DAY_SECONDS, asOfTimestamp));
  }

  queryCandles(input: {
    pair: string;
    interval: CandleInterval;
    fromTimestamp: number;
    toTimestamp: number;
    first: number;
    after?: string | null;
  }): Connection<Candle> {
    const pair = normalize(input.pair);
    const intervalSeconds = candleIntervalSeconds(input.interval);
    if (!Number.isSafeInteger(input.fromTimestamp) || !Number.isSafeInteger(input.toTimestamp) || input.fromTimestamp > input.toTimestamp) {
      throw new Error("Candle timestamp range is invalid");
    }
    if (Math.floor(input.toTimestamp / intervalSeconds) - Math.floor(input.fromTimestamp / intervalSeconds) + 1 > MAX_CANDLE_POINTS) {
      throw new Error(`Candle query cannot span more than ${MAX_CANDLE_POINTS} ${input.interval} buckets`);
    }
    const headTimestamp = this.#blocks.at(-1)?.timestamp ?? null;
    const rows: Candle[] = [];
    let startTimestamp = candleBoundary(input.fromTimestamp, input.interval);
    if (startTimestamp < input.fromTimestamp) startTimestamp += intervalSeconds;
    for (let timestamp = startTimestamp; timestamp <= input.toTimestamp; timestamp += intervalSeconds) {
      const candle = this.#candles.get(`${pair}:${input.interval}:${timestamp}`);
      if (candle !== undefined) rows.push(finalizeCandle(candle, headTimestamp));
    }
    return paginate(
      rows,
      input.first,
      input.after,
      this.#blocks.at(-1)?.hash ?? "empty",
      !this.#historyCovers(input.fromTimestamp, input.toTimestamp)
    );
  }

  listCandles(): Candle[] {
    const headTimestamp = this.#blocks.at(-1)?.timestamp ?? null;
    return [...this.#candles.values()]
      .sort((left, right) =>
        left.pair.localeCompare(right.pair) ||
        left.interval.localeCompare(right.interval) ||
        left.startTimestamp - right.startTimestamp
      )
      .map((candle) => finalizeCandle(candle, headTimestamp));
  }

  listLastChangedCandles(): Candle[] {
    const headTimestamp = this.#blocks.at(-1)?.timestamp ?? null;
    return [...this.#lastChangedCandleKeys]
      .flatMap((key) => {
        const candle = this.#candles.get(key);
        return candle === undefined ? [] : [finalizeCandle(candle, headTimestamp)];
      })
      .sort((left, right) =>
        left.pair.localeCompare(right.pair) ||
        left.interval.localeCompare(right.interval) ||
        left.startTimestamp - right.startTimestamp
      );
  }

  queryPoolState(input: { pair: string; radius: number }): PoolStateSnapshot | null {
    if (!Number.isSafeInteger(input.radius) || input.radius < 0 || input.radius > 100) {
      throw new Error("Pool-state radius must be an integer between 0 and 100");
    }
    const pair = normalize(input.pair);
    const state = this.#poolStates.get(pair);
    if (state === undefined) return null;
    const minimumBinId = BigInt(state.activeId - input.radius);
    const maximumBinId = BigInt(state.activeId + input.radius);
    return structuredClone({
      state,
      bins: sortedPoolBins(this.#poolBins.get(pair)).filter((bin) => {
        const binId = BigInt(bin.binId);
        return binId >= minimumBinId && binId <= maximumBinId;
      })
    });
  }

  listPoolStates(): PoolStateSnapshot[] {
    return [...this.#poolStates.values()]
      .sort((left, right) => left.chainId - right.chainId || left.pair.localeCompare(right.pair))
      .map((state) => structuredClone({ state, bins: sortedPoolBins(this.#poolBins.get(state.pair)) }));
  }

  listLastChangedPoolUpdates(): PoolStateUpdate[] {
    return structuredClone(
      [...this.#lastChangedPoolUpdates].sort((left, right) =>
        left.state.chainId - right.state.chainId ||
        left.state.pair.localeCompare(right.state.pair) ||
        left.eventId.localeCompare(right.eventId)
      )
    );
  }

  queryWalletPositions(input: { owner: string; first: number; after?: string | null }): Connection<WalletPairPosition> {
    const owner = normalize(input.owner);
    const head = this.#blocks.at(-1) ?? null;
    const rows = [...this.#positions.values()]
      .filter((position) => position.owner === owner)
      .sort((a, b) => a.pair.localeCompare(b.pair))
      .map((position) =>
        finalizePosition(
          position,
          this.#priceBook,
          head?.number ?? null,
          head?.timestamp ?? null,
          this.#maxPositionSnapshotAgeSeconds
        )
      );
    return paginate(rows, input.first, input.after, head?.hash ?? "empty", this.#backfillStatus !== "complete");
  }

  #rebuild(): void {
    this.#priceBook = new TrustedPriceBook(this.#policies);
    this.#pairs = new Map();
    this.#pairSnapshots = [];
    this.#flows = [];
    this.#candles = new Map();
    this.#positions = new Map();
    this.#poolStates = new Map();
    this.#poolBins = new Map();
    this.#lastChangedPoolUpdates = [];
    this.#partialEventCount = 0;
    this.#missingPriceTokens = new Set();

    for (const block of this.#blocks) this.#applyCanonicalBlock(block);
    this.#buildCandleRollups();
  }

  /**
   * Canonical appends are applied once. Replaying the complete retained chain on
   * every new block made ingestion quadratic and obscured the idempotency model.
   * Reorgs still take the intentionally conservative full-rebuild path above.
   */
  #applyCanonicalAppend(block: BlockEnvelope, previousHeadTimestamp: number | null): Set<string> {
    const changedKeys = this.#newlyFinalizedCandleKeys(previousHeadTimestamp, block.timestamp);
    this.#applyCanonicalBlock(block);
    const changedPairs = new Set(
      block.events.flatMap((event) =>
        event.kind === "position-snapshot" || event.kind === "position-transfer"
          ? []
          : [normalize(event.pair)]
      )
    );
    for (const pair of changedPairs) {
      changedKeys.add(`${pair}:minute:${candleBoundary(block.timestamp, "minute")}`);
      this.#rebuildRollupBucket(pair, "five-minutes", "minute", block.timestamp);
      changedKeys.add(`${pair}:five-minutes:${candleBoundary(block.timestamp, "five-minutes")}`);
      this.#rebuildRollupBucket(pair, "fifteen-minutes", "minute", block.timestamp);
      changedKeys.add(`${pair}:fifteen-minutes:${candleBoundary(block.timestamp, "fifteen-minutes")}`);
      this.#rebuildRollupBucket(pair, "hour", "minute", block.timestamp);
      changedKeys.add(`${pair}:hour:${candleBoundary(block.timestamp, "hour")}`);
      this.#rebuildRollupBucket(pair, "four-hours", "hour", block.timestamp);
      changedKeys.add(`${pair}:four-hours:${candleBoundary(block.timestamp, "four-hours")}`);
      this.#rebuildRollupBucket(pair, "day", "hour", block.timestamp);
      changedKeys.add(`${pair}:day:${candleBoundary(block.timestamp, "day")}`);
      this.#rebuildRollupBucket(pair, "week", "day", block.timestamp);
      changedKeys.add(`${pair}:week:${candleBoundary(block.timestamp, "week")}`);
    }
    return changedKeys;
  }

  #newlyFinalizedCandleKeys(previousHeadTimestamp: number | null, nextHeadTimestamp: number): Set<string> {
    const keys = new Set<string>();
    if (previousHeadTimestamp === null || nextHeadTimestamp <= previousHeadTimestamp) return keys;
    for (const pair of this.#pairs.keys()) {
      for (const interval of CANDLE_INTERVALS) {
        const startTimestamp = candleBoundary(previousHeadTimestamp, interval);
        const key = `${pair}:${interval}:${startTimestamp}`;
        const candle = this.#candles.get(key);
        if (
          candle !== undefined &&
          previousHeadTimestamp < candle.endTimestamp &&
          nextHeadTimestamp >= candle.endTimestamp
        ) {
          keys.add(key);
        }
      }
    }
    return keys;
  }

  #applyCanonicalBlock(block: BlockEnvelope): void {
    this.#lastChangedPoolUpdates = [];
    for (const sample of block.prices) this.#priceBook.apply(sample, block.timestamp);
    for (const event of block.events) {
      this.#applyEvent(event, block.chainId ?? null, block.number, block.hash, block.timestamp);
    }
  }

  #applyEvent(
    event: AnalyticsEvent,
    chainId: number | null,
    blockNumber: bigint,
    blockHash: Hex,
    timestamp: number
  ): void {
    this.#eventIsPartial = false;
    if (event.kind === "position-snapshot") {
      this.#applyPositionSnapshot(event, blockNumber, timestamp);
    } else if (event.kind === "position-transfer") {
      this.#applyPositionTransfer(event);
    } else {
      const pair = this.#updatePair(event, blockNumber, blockHash, timestamp);
      this.#updateCandlesForSnapshot(pair, blockNumber, blockHash, timestamp);

      if (event.kind === "swap") this.#applySwap(event, pair, blockNumber, blockHash, timestamp);
      if (event.kind === "deposit" || event.kind === "withdraw") this.#applyLiquidity(event, timestamp);
      if (event.kind === "pair-snapshot" && event.poolState !== undefined) {
        this.#applyPoolStateObservation(event, pair, chainId!, blockNumber, blockHash, timestamp);
      }
    }
    if (this.#eventIsPartial) this.#partialEventCount += 1;
  }

  #updatePair(
    event: Exclude<AnalyticsEvent, PositionSnapshotEvent | PositionTransferEvent>,
    blockNumber: bigint,
    blockHash: Hex,
    timestamp: number
  ): PairState {
    const identity = normalizePair(event);
    const current = this.#pairs.get(identity.pair);
    if (current && !samePairIdentity(current, identity)) throw new Error(`Pair identity changed for ${identity.pair}`);

    const reserves = valueAmounts(identity, event.reserveX, event.reserveY, this.#priceBook, timestamp);
    const tokenXPrice = this.#priceBook.get(identity.tokenX, timestamp);
    const tokenYPrice = this.#priceBook.get(identity.tokenY, timestamp);
    const observedQuotePrice = event.marketPriceQuoteE18 ?? current?.marketPriceQuoteE18 ?? null;
    const activeBinPrice = observedQuotePrice === null || tokenYPrice.priceUsdE18 === null
      ? null
      : (observedQuotePrice * tokenYPrice.priceUsdE18) / USD_SCALE;
    const priceUsdE18 = activeBinPrice ?? tokenXPrice.priceUsdE18;
    const priceSource: CandlePriceSource = activeBinPrice === null ? "trusted-token-usd" : "active-bin-quote-usd";
    const priceMissing = priceUsdE18 !== null
      ? new Set<string>()
      : new Set([observedQuotePrice === null ? identity.tokenX : identity.tokenY]);
    const pair: PairState = {
      ...identity,
      reserveX: event.reserveX,
      reserveY: event.reserveY,
      tvlUsdE18: reserves.totalUsdE18,
      priceUsdE18,
      priceSource,
      quoteToken: identity.tokenY,
      activeId: event.activeId ?? current?.activeId ?? null,
      binStep: event.binStep ?? current?.binStep ?? null,
      marketPriceQuoteE18: observedQuotePrice,
      missingPriceTokens: union(reserves.missingPriceTokens, priceMissing),
      updatedAtBlock: blockNumber,
      updatedAtBlockHash: blockHash,
      updatedAtTimestamp: timestamp
    };
    this.#pairs.set(identity.pair, pair);
    this.#pairSnapshots.push(pair);
    this.#recordPartial(pair.missingPriceTokens);
    return pair;
  }

  #applyPoolStateObservation(
    event: PairSnapshotEvent,
    pair: PairState,
    chainId: number,
    blockNumber: bigint,
    blockHash: Hex,
    timestamp: number
  ): void {
    const observation = event.poolState!;
    const currentState = this.#poolStates.get(pair.pair);
    if (currentState !== undefined && currentState.chainId !== chainId) {
      throw new Error(`Pool ${pair.pair} changed chain identity`);
    }
    if (pair.activeId === null || pair.binStep === null || pair.marketPriceQuoteE18 === null) {
      throw new Error("Pool-state observations require active ID, bin step, and market price");
    }

    const state: PoolState = {
      chainId,
      pair: pair.pair,
      tokenX: pair.tokenX,
      tokenY: pair.tokenY,
      decimalsX: pair.decimalsX,
      decimalsY: pair.decimalsY,
      reserveX: pair.reserveX,
      reserveY: pair.reserveY,
      activeId: pair.activeId,
      binStep: pair.binStep,
      marketPriceQuoteE18: pair.marketPriceQuoteE18,
      priceUsdE18: pair.priceUsdE18,
      tvlUsdE18: pair.tvlUsdE18,
      status: pair.priceUsdE18 === null || pair.tvlUsdE18 === null ? "partial" : "ready",
      missingPriceTokens: [...pair.missingPriceTokens].sort(),
      feeState: structuredClone(observation.feeState),
      asOfBlock: blockNumber,
      asOfBlockHash: blockHash,
      asOfTimestamp: timestamp,
      revision: (currentState?.revision ?? 0) + 1
    };
    this.#poolStates.set(pair.pair, state);

    const previousBins = this.#poolBins.get(pair.pair) ?? new Map<string, PoolBinState>();
    const bins = observation.replaceBinWindow ? new Map<string, PoolBinState>() : previousBins;
    this.#poolBins.set(pair.pair, bins);
    const binReplacements: PoolBinState[] = [];
    for (const snapshot of observation.binUpdates) {
      const current = previousBins.get(snapshot.binId);
      if (current !== undefined && samePoolBinSnapshot(current, snapshot)) {
        if (observation.replaceBinWindow) {
          bins.set(current.binId, current);
          binReplacements.push(current);
        }
        continue;
      }
      const replacement: PoolBinState = {
        ...structuredClone(snapshot),
        chainId,
        pair: pair.pair,
        updatedAtBlock: blockNumber,
        updatedAtBlockHash: blockHash,
        updatedAtTimestamp: timestamp,
        revision: (current?.revision ?? 0) + 1
      };
      bins.set(replacement.binId, replacement);
      binReplacements.push(replacement);
    }

    const sourceEventIds = [...observation.sourceEventIds].sort();
    this.#lastChangedPoolUpdates.push({
      eventId: `${chainId}:${blockHash.toLowerCase()}:${pair.pair}:${sourceEventIds.join(",")}`,
      state,
      binReplacements: binReplacements.sort(comparePoolBins),
      replaceBinWindow: observation.replaceBinWindow,
      sourceEventIds
    });
  }

  #applySwap(event: SwapAnalyticsEvent, pair: PairState, blockNumber: bigint, blockHash: Hex, timestamp: number): void {
    const volume = valueAmounts(pair, event.amountInX, event.amountInY, this.#priceBook, timestamp);
    const totalSwapFees = valueAmounts(pair, event.feeX, event.feeY, this.#priceBook, timestamp);
    const feeBreakdownComplete = event.protocolFeeX !== undefined && event.protocolFeeX !== null &&
      event.protocolFeeY !== undefined && event.protocolFeeY !== null;
    const protocolSwapFees = feeBreakdownComplete
      ? valueAmounts(pair, event.protocolFeeX!, event.protocolFeeY!, this.#priceBook, timestamp)
      : null;
    const lpNetSwapFees = feeBreakdownComplete
      ? valueAmounts(
          pair,
          event.feeX - event.protocolFeeX!,
          event.feeY - event.protocolFeeY!,
          this.#priceBook,
          timestamp
        )
      : null;
    const missing = union(
      volume.missingPriceTokens,
      totalSwapFees.missingPriceTokens,
      protocolSwapFees?.missingPriceTokens ?? new Set(),
      lpNetSwapFees?.missingPriceTokens ?? new Set(),
      pair.missingPriceTokens
    );
    this.#flows.push({
      pair: pair.pair,
      timestamp,
      volumeUsdE18: volume.totalUsdE18,
      totalSwapFeesUsdE18: totalSwapFees.totalUsdE18,
      protocolSwapFeesUsdE18: protocolSwapFees?.totalUsdE18 ?? null,
      lpNetSwapFeesUsdE18: lpNetSwapFees?.totalUsdE18 ?? null,
      feeBreakdownComplete,
      missingPriceTokens: missing
    });
    this.#recordPartial(missing, !feeBreakdownComplete);

    const candle = this.#getCandle(pair, "minute", blockNumber, blockHash, timestamp);
    candle.swapCount += 1;
    candle.revision += 1;
    if (volume.totalUsdE18 === null) candle.missingVolumeValue = true;
    else candle.volumeUsdE18 += volume.totalUsdE18;
    if (totalSwapFees.totalUsdE18 === null) candle.missingTotalSwapFeeValue = true;
    else candle.totalSwapFeesUsdE18 += totalSwapFees.totalUsdE18;
    if (protocolSwapFees?.totalUsdE18 === null || protocolSwapFees === null) candle.missingProtocolSwapFeeValue = true;
    else candle.protocolSwapFeesUsdE18 += protocolSwapFees.totalUsdE18;
    if (lpNetSwapFees?.totalUsdE18 === null || lpNetSwapFees === null) candle.missingLpNetSwapFeeValue = true;
    else candle.lpNetSwapFeesUsdE18 += lpNetSwapFees.totalUsdE18;
    addAll(candle.missingPriceTokens, missing);
  }

  #updateCandlesForSnapshot(pair: PairState, blockNumber: bigint, blockHash: Hex, timestamp: number): void {
    const candle = this.#getCandle(pair, "minute", blockNumber, blockHash, timestamp);
    candle.tvlUsdE18 = pair.tvlUsdE18;
    candle.lastBlock = blockNumber;
    candle.lastBlockHash = blockHash;
    candle.revision += 1;
    candle.priceSource = mergePriceSource(candle.priceSource, pair.priceSource);
    addAll(candle.missingPriceTokens, pair.missingPriceTokens);
    if (pair.priceUsdE18 !== null) {
      candle.openUsdE18 ??= pair.priceUsdE18;
      candle.highUsdE18 = candle.highUsdE18 === null || pair.priceUsdE18 > candle.highUsdE18 ? pair.priceUsdE18 : candle.highUsdE18;
      candle.lowUsdE18 = candle.lowUsdE18 === null || pair.priceUsdE18 < candle.lowUsdE18 ? pair.priceUsdE18 : candle.lowUsdE18;
      candle.closeUsdE18 = pair.priceUsdE18;
    }
  }

  #getCandle(pair: PairState, interval: CandleInterval, blockNumber: bigint, blockHash: Hex, timestamp: number): MutableCandle {
    const seconds = candleIntervalSeconds(interval);
    const startTimestamp = candleBoundary(timestamp, interval);
    const key = `${pair.pair}:${interval}:${startTimestamp}`;
    let candle = this.#candles.get(key);
    if (!candle) {
      candle = {
        pair: pair.pair,
        interval,
        startTimestamp,
        endTimestamp: startTimestamp + seconds,
        openUsdE18: null,
        highUsdE18: null,
        lowUsdE18: null,
        closeUsdE18: null,
        volumeUsdE18: 0n,
        totalSwapFeesUsdE18: 0n,
        protocolSwapFeesUsdE18: 0n,
        lpNetSwapFeesUsdE18: 0n,
        tvlUsdE18: null,
        swapCount: 0,
        missingVolumeValue: false,
        missingTotalSwapFeeValue: false,
        missingProtocolSwapFeeValue: false,
        missingLpNetSwapFeeValue: false,
        missingPriceTokens: new Set(),
        firstBlock: blockNumber,
        lastBlock: blockNumber,
        firstBlockHash: blockHash,
        lastBlockHash: blockHash,
        revision: 0,
        priceSource: null,
        quoteToken: pair.quoteToken
      };
      this.#candles.set(key, candle);
    }
    return candle;
  }

  #buildCandleRollups(): void {
    // Rollups are derived views of the canonical one-minute base. Recreate them
    // deterministically after every append/reorg so a source revision can never
    // be counted twice and every dependent interval receives the same result.
    for (const [key, candle] of this.#candles) {
      if (candle.interval !== "minute") this.#candles.delete(key);
    }
    const minutes = [...this.#candles.values()]
      .filter((candle) => candle.interval === "minute")
      .sort((left, right) => left.startTimestamp - right.startTimestamp);

    const rollup = (sources: readonly MutableCandle[], intervals: readonly CandleInterval[]) => {
      for (const interval of intervals) for (const source of sources) {
        const startTimestamp = candleBoundary(source.startTimestamp, interval);
        const key = `${source.pair}:${interval}:${startTimestamp}`;
        let rollup = this.#candles.get(key);
        if (!rollup) {
          rollup = createRollupCandle(source, interval, startTimestamp);
          this.#candles.set(key, rollup);
        }
        mergeCandleIntoRollup(rollup, source);
      }
    };
    rollup(minutes, ["five-minutes", "fifteen-minutes", "hour"]);
    const hours = [...this.#candles.values()]
      .filter((candle) => candle.interval === "hour")
      .sort((left, right) => left.startTimestamp - right.startTimestamp);
    rollup(hours, ["four-hours", "day"]);
    const days = [...this.#candles.values()]
      .filter((candle) => candle.interval === "day")
      .sort((left, right) => left.startTimestamp - right.startTimestamp);
    rollup(days, ["week"]);
  }

  #rebuildRollupBucket(
    pair: string,
    interval: CandleInterval,
    sourceInterval: CandleInterval,
    timestamp: number
  ): void {
    const startTimestamp = candleBoundary(timestamp, interval);
    const endTimestamp = startTimestamp + candleIntervalSeconds(interval);
    const key = `${pair}:${interval}:${startTimestamp}`;
    const sourceSeconds = candleIntervalSeconds(sourceInterval);
    const sources: MutableCandle[] = [];
    for (let sourceTimestamp = startTimestamp; sourceTimestamp < endTimestamp; sourceTimestamp += sourceSeconds) {
      const source = this.#candles.get(`${pair}:${sourceInterval}:${sourceTimestamp}`);
      if (source !== undefined) sources.push(source);
    }
    this.#candles.delete(key);
    const first = sources[0];
    if (first === undefined) return;
    const rollup = createRollupCandle(first, interval, startTimestamp);
    for (const source of sources) mergeCandleIntoRollup(rollup, source);
    this.#candles.set(key, rollup);
  }

  #applyLiquidity(event: LiquidityAnalyticsEvent, timestamp: number): void {
    const owner = normalize(event.owner);
    const pair = normalize(event.pair);
    const key = `${owner}:${pair}`;
    let position = this.#positions.get(key);
    if (!position) {
      position = { owner, ...normalizePair(event), bins: new Map() };
      this.#positions.set(key, position);
    }

    for (const change of event.bins) {
      const bin = getOrCreatePositionBin(position, change.binId, 0n);
      const value = valueAmounts(event, change.amountX, change.amountY, this.#priceBook, timestamp);
      this.#recordPartial(value.missingPriceTokens);
      addAll(bin.historyMissingPriceTokens, value.missingPriceTokens);
      bin.currentValueUsdE18 = null;
      bin.currentMissingPriceTokens = new Set();
      bin.amountX = null;
      bin.amountY = null;
      bin.snapshotBlock = null;
      bin.snapshotTimestamp = null;

      if (event.kind === "deposit") {
        if (change.liquidityDelta < 0n) throw new Error("Deposit liquidityDelta must be non-negative");
        bin.liquidity += change.liquidityDelta;
        bin.costBasisUsdE18 = addNullable(bin.costBasisUsdE18, value.totalUsdE18);
        continue;
      }

      const removed = absolute(change.liquidityDelta);
      if (removed > bin.liquidity) throw new Error(`Withdraw exceeds indexed liquidity for bin ${change.binId}`);
      const allocatedBasis = bin.costBasisUsdE18 === null || bin.liquidity === 0n
        ? null
        : (bin.costBasisUsdE18 * removed) / bin.liquidity;
      bin.liquidity -= removed;
      bin.costBasisUsdE18 = subtractNullable(bin.costBasisUsdE18, allocatedBasis);
      const realized = value.totalUsdE18 === null || allocatedBasis === null ? null : value.totalUsdE18 - allocatedBasis;
      bin.realizedPnlUsdE18 = addNullable(bin.realizedPnlUsdE18, realized);
      if (bin.liquidity === 0n) bin.currentValueUsdE18 = 0n;
    }
  }

  #applyPositionSnapshot(event: PositionSnapshotEvent, blockNumber: bigint, timestamp: number): void {
    const owner = normalize(event.owner);
    const pair = normalize(event.pair);
    const key = `${owner}:${pair}`;
    let position = this.#positions.get(key);
    if (!position) {
      position = { owner, ...normalizePair(event), bins: new Map() };
      this.#positions.set(key, position);
    }

    const seen = new Set<string>();
    for (const snapshot of event.bins) {
      seen.add(snapshot.binId);
      const hasIndexedHistory = position.bins.has(snapshot.binId);
      const bin = getOrCreatePositionBin(position, snapshot.binId, null);
      const value = valueAmounts(event, snapshot.amountX, snapshot.amountY, this.#priceBook, timestamp);
      if (hasIndexedHistory && bin.liquidity !== snapshot.liquidity) {
        bin.costBasisUsdE18 = null;
        this.#recordPartial(new Set(), true);
      }
      bin.liquidity = snapshot.liquidity;
      bin.currentValueUsdE18 = value.totalUsdE18;
      bin.currentMissingPriceTokens = new Set(value.missingPriceTokens);
      bin.amountX = snapshot.amountX;
      bin.amountY = snapshot.amountY;
      bin.snapshotBlock = blockNumber;
      bin.snapshotTimestamp = timestamp;
      this.#recordPartial(value.missingPriceTokens);
      if (!hasIndexedHistory) this.#recordPartial(new Set(), true);
    }

    for (const bin of position.bins.values()) {
      if (!seen.has(bin.binId)) {
        if (bin.liquidity > 0n) {
          bin.costBasisUsdE18 = null;
          this.#recordPartial(new Set(), true);
        }
        bin.liquidity = 0n;
        bin.currentValueUsdE18 = 0n;
        bin.amountX = 0n;
        bin.amountY = 0n;
        bin.snapshotBlock = blockNumber;
        bin.snapshotTimestamp = timestamp;
      }
    }
  }

  #applyPositionTransfer(event: PositionTransferEvent): void {
    const from = normalize(event.from);
    const to = normalize(event.to);
    const identity = normalizePair(event);
    const fromPosition = getOrCreateWalletPairPosition(this.#positions, from, identity);
    const toPosition = getOrCreateWalletPairPosition(this.#positions, to, identity);

    for (const transfer of event.bins) {
      if (transfer.liquidity < 0n) throw new Error("Transferred liquidity must be non-negative");
      const fromBin = getOrCreatePositionBin(fromPosition, transfer.binId, null);
      const toBin = getOrCreatePositionBin(toPosition, transfer.binId, 0n);
      if (transfer.liquidity > fromBin.liquidity) throw new Error(`Transfer exceeds indexed liquidity for bin ${transfer.binId}`);
      const transferredBasis = fromBin.costBasisUsdE18 === null || fromBin.liquidity === 0n
        ? null
        : (fromBin.costBasisUsdE18 * transfer.liquidity) / fromBin.liquidity;
      fromBin.liquidity -= transfer.liquidity;
      fromBin.costBasisUsdE18 = subtractNullable(fromBin.costBasisUsdE18, transferredBasis);
      fromBin.currentValueUsdE18 = null;
      fromBin.currentMissingPriceTokens = new Set();
      fromBin.amountX = null;
      fromBin.amountY = null;
      fromBin.snapshotBlock = null;
      fromBin.snapshotTimestamp = null;
      toBin.liquidity += transfer.liquidity;
      toBin.costBasisUsdE18 = addNullable(toBin.costBasisUsdE18, transferredBasis);
      toBin.currentValueUsdE18 = null;
      toBin.currentMissingPriceTokens = new Set();
      toBin.amountX = null;
      toBin.amountY = null;
      toBin.snapshotBlock = null;
      toBin.snapshotTimestamp = null;
      addAll(toBin.historyMissingPriceTokens, fromBin.historyMissingPriceTokens);
      if (transferredBasis === null) this.#recordPartial(new Set(), true);
    }
  }

  #poolMetrics(pair: PairState, asOfTimestamp: number): PoolMetrics {
    const cutoff = asOfTimestamp - DAY_SECONDS;
    const flows = this.#flows.filter((flow) => flow.pair === pair.pair && flow.timestamp > cutoff && flow.timestamp <= asOfTimestamp);
    const valuation = valueAmounts(pair, pair.reserveX, pair.reserveY, this.#priceBook, asOfTimestamp);
    const price = this.#priceBook.get(pair.tokenX, asOfTimestamp);
    const missing = union(
      valuation.missingPriceTokens,
      price.priceUsdE18 === null ? new Set([pair.tokenX]) : new Set()
    );
    let volume = 0n;
    let totalSwapFees = 0n;
    let protocolSwapFees = 0n;
    let lpNetSwapFees = 0n;
    let volumePartial = false;
    let totalSwapFeesPartial = false;
    let protocolSwapFeesPartial = false;
    let lpNetSwapFeesPartial = false;
    let feeBreakdownComplete = true;
    for (const flow of flows) {
      addAll(missing, flow.missingPriceTokens);
      if (flow.volumeUsdE18 === null) volumePartial = true;
      else volume += flow.volumeUsdE18;
      if (flow.totalSwapFeesUsdE18 === null) totalSwapFeesPartial = true;
      else totalSwapFees += flow.totalSwapFeesUsdE18;
      if (flow.protocolSwapFeesUsdE18 === null) protocolSwapFeesPartial = true;
      else protocolSwapFees += flow.protocolSwapFeesUsdE18;
      if (flow.lpNetSwapFeesUsdE18 === null) lpNetSwapFeesPartial = true;
      else lpNetSwapFees += flow.lpNetSwapFeesUsdE18;
      feeBreakdownComplete &&= flow.feeBreakdownComplete;
    }
    const coveragePartial = !this.#historyCovers(cutoff, asOfTimestamp);
    feeBreakdownComplete &&= !coveragePartial && !protocolSwapFeesPartial && !lpNetSwapFeesPartial;
    const partial = valuation.totalUsdE18 === null || price.priceUsdE18 === null || volumePartial ||
      totalSwapFeesPartial || !feeBreakdownComplete || coveragePartial;
    const legacyFeeToTvl = totalSwapFeesPartial || coveragePartial || valuation.totalUsdE18 === null
      ? null
      : ratioE18(totalSwapFees, valuation.totalUsdE18);
    const lpNetFeeToTvl = !feeBreakdownComplete || valuation.totalUsdE18 === null
      ? null
      : ratioE18(lpNetSwapFees, valuation.totalUsdE18);

    return {
      pair: pair.pair,
      tokenX: pair.tokenX,
      tokenY: pair.tokenY,
      tvlUsdE18: valuation.totalUsdE18,
      volume24hUsdE18: volumePartial || coveragePartial ? null : volume,
      fees24hUsdE18: totalSwapFeesPartial || coveragePartial ? null : totalSwapFees,
      feeToTvlE18: legacyFeeToTvl,
      totalSwapFees24hUsdE18: totalSwapFeesPartial || coveragePartial ? null : totalSwapFees,
      protocolSwapFees24hUsdE18: feeBreakdownComplete ? protocolSwapFees : null,
      lpNetSwapFees24hUsdE18: feeBreakdownComplete ? lpNetSwapFees : null,
      lpNetSwapFeeToTvlE18: lpNetFeeToTvl,
      feeBreakdownComplete,
      priceUsdE18: price.priceUsdE18,
      asOfBlock: pair.updatedAtBlock,
      asOfTimestamp,
      status: partial ? "partial" : "ready",
      missingPriceTokens: [...missing].sort()
    };
  }

  #pairStateAt(pairId: string, timestamp: number): PairState | null {
    for (let index = this.#pairSnapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = this.#pairSnapshots[index];
      if (snapshot.pair === pairId && snapshot.updatedAtTimestamp <= timestamp) return snapshot;
    }
    return null;
  }

  #recordPartial(tokens: Set<string>, force = false): void {
    if (tokens.size === 0 && !force) return;
    this.#eventIsPartial = true;
    addAll(this.#missingPriceTokens, tokens);
  }

  #historyCovers(fromTimestamp: number, throughTimestamp: number): boolean {
    return (
      this.#backfillStatus === "complete" &&
      this.#coverageStartTimestamp !== null &&
      this.#coverageStartTimestamp <= fromTimestamp &&
      this.#coverageThroughTimestamp !== null &&
      this.#coverageThroughTimestamp >= throughTimestamp
    );
  }

  #advanceCoverage(timestamp: number): void {
    if (this.#backfillStatus === "complete") this.#coverageThroughTimestamp = timestamp;
  }

  #recordCanonicalEventIdentities(block: BlockEnvelope): void {
    if (block.chainId !== undefined) this.#canonicalChainId ??= block.chainId;
    if (block.chainId === undefined) return;
    for (const event of block.events) {
      if (event.source === undefined) continue;
      this.#canonicalEventFingerprints.set(
        `${block.chainId}:${event.source.eventId}`,
        canonicalFingerprint(event)
      );
    }
  }

  #replaceCanonicalEventIdentityIndex(): void {
    const context = canonicalEventContext(this.#blocks);
    this.#canonicalChainId = context.chainId;
    this.#canonicalEventFingerprints = new Map(context.sources);
  }
}

function valueAmounts(
  pair: PairIdentity,
  amountX: bigint,
  amountY: bigint,
  prices: TrustedPriceBook,
  timestamp: number
): ValuedAmounts {
  const missing = new Set<string>();
  const priceX = prices.get(pair.tokenX, timestamp).priceUsdE18;
  const priceY = prices.get(pair.tokenY, timestamp).priceUsdE18;
  if (priceX === null && amountX !== 0n) missing.add(normalize(pair.tokenX));
  if (priceY === null && amountY !== 0n) missing.add(normalize(pair.tokenY));
  if (missing.size > 0) return { totalUsdE18: null, missingPriceTokens: missing };

  return {
    totalUsdE18:
      tokenAmountToUsd(amountX, pair.decimalsX, priceX ?? 0n) +
      tokenAmountToUsd(amountY, pair.decimalsY, priceY ?? 0n),
    missingPriceTokens: missing
  };
}

function sortedPoolBins(bins: Map<string, PoolBinState> | undefined): PoolBinState[] {
  return bins === undefined ? [] : [...bins.values()].sort(comparePoolBins);
}

function comparePoolBins(left: PoolBinSnapshot, right: PoolBinSnapshot): number {
  const leftId = BigInt(left.binId);
  const rightId = BigInt(right.binId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function samePoolBinSnapshot(left: PoolBinSnapshot, right: PoolBinSnapshot): boolean {
  return left.binId === right.binId &&
    left.reserveX === right.reserveX &&
    left.reserveY === right.reserveY &&
    left.totalSupply === right.totalSupply;
}

function normalizePair(pair: PairIdentity): PairIdentity {
  return {
    pair: normalize(pair.pair),
    tokenX: normalize(pair.tokenX),
    tokenY: normalize(pair.tokenY),
    decimalsX: pair.decimalsX,
    decimalsY: pair.decimalsY
  };
}

function samePairIdentity(a: PairIdentity, b: PairIdentity): boolean {
  return a.pair === b.pair && a.tokenX === b.tokenX && a.tokenY === b.tokenY && a.decimalsX === b.decimalsX && a.decimalsY === b.decimalsY;
}

function getOrCreateWalletPairPosition(
  positions: Map<string, MutableWalletPairPosition>,
  owner: string,
  identity: PairIdentity
): MutableWalletPairPosition {
  const key = `${owner}:${identity.pair}`;
  let position = positions.get(key);
  if (!position) {
    position = { owner, ...identity, bins: new Map() };
    positions.set(key, position);
  }
  return position;
}

function getOrCreatePositionBin(
  position: MutableWalletPairPosition,
  binId: string,
  initialCostBasisUsdE18: bigint | null
): MutablePositionBin {
  let bin = position.bins.get(binId);
  if (!bin) {
    bin = {
      binId,
      liquidity: 0n,
      costBasisUsdE18: initialCostBasisUsdE18,
      currentValueUsdE18: null,
      realizedPnlUsdE18: 0n,
      historyMissingPriceTokens: new Set(),
      currentMissingPriceTokens: new Set(),
      amountX: null,
      amountY: null,
      snapshotBlock: null,
      snapshotTimestamp: null
    };
    position.bins.set(binId, bin);
  }
  return bin;
}

function finalizeCandle(candle: MutableCandle, headTimestamp: number | null): Candle {
  const partial =
    candle.missingVolumeValue ||
    candle.missingTotalSwapFeeValue ||
    candle.missingProtocolSwapFeeValue ||
    candle.missingLpNetSwapFeeValue ||
    candle.missingPriceTokens.size > 0 ||
    candle.tvlUsdE18 === null ||
    candle.closeUsdE18 === null;
  return {
    pair: candle.pair,
    interval: candle.interval,
    startTimestamp: candle.startTimestamp,
    endTimestamp: candle.endTimestamp,
    openUsdE18: candle.openUsdE18,
    highUsdE18: candle.highUsdE18,
    lowUsdE18: candle.lowUsdE18,
    closeUsdE18: candle.closeUsdE18,
    volumeUsdE18: candle.missingVolumeValue ? null : candle.volumeUsdE18,
    feesUsdE18: candle.missingTotalSwapFeeValue ? null : candle.totalSwapFeesUsdE18,
    totalSwapFeesUsdE18: candle.missingTotalSwapFeeValue ? null : candle.totalSwapFeesUsdE18,
    protocolSwapFeesUsdE18: candle.missingProtocolSwapFeeValue ? null : candle.protocolSwapFeesUsdE18,
    lpNetSwapFeesUsdE18: candle.missingLpNetSwapFeeValue ? null : candle.lpNetSwapFeesUsdE18,
    feeBreakdownComplete: !candle.missingProtocolSwapFeeValue && !candle.missingLpNetSwapFeeValue,
    tvlUsdE18: candle.tvlUsdE18,
    swapCount: candle.swapCount,
    status: partial ? "partial" : "ready",
    missingPriceTokens: [...candle.missingPriceTokens].sort(),
    firstBlock: candle.firstBlock,
    lastBlock: candle.lastBlock,
    firstBlockHash: candle.firstBlockHash,
    lastBlockHash: candle.lastBlockHash,
    finalized: headTimestamp !== null && headTimestamp >= candle.endTimestamp,
    revision: candle.revision,
    priceSource: candle.priceSource ?? "trusted-token-usd",
    quoteToken: candle.quoteToken
  };
}

function mergeCandleIntoRollup(rollup: MutableCandle, source: MutableCandle): void {
  rollup.openUsdE18 ??= source.openUsdE18;
  if (source.highUsdE18 !== null) {
    rollup.highUsdE18 = rollup.highUsdE18 === null || source.highUsdE18 > rollup.highUsdE18
      ? source.highUsdE18
      : rollup.highUsdE18;
  }
  if (source.lowUsdE18 !== null) {
    rollup.lowUsdE18 = rollup.lowUsdE18 === null || source.lowUsdE18 < rollup.lowUsdE18
      ? source.lowUsdE18
      : rollup.lowUsdE18;
  }
  if (source.closeUsdE18 !== null) rollup.closeUsdE18 = source.closeUsdE18;
  rollup.volumeUsdE18 += source.volumeUsdE18;
  rollup.totalSwapFeesUsdE18 += source.totalSwapFeesUsdE18;
  rollup.protocolSwapFeesUsdE18 += source.protocolSwapFeesUsdE18;
  rollup.lpNetSwapFeesUsdE18 += source.lpNetSwapFeesUsdE18;
  rollup.swapCount += source.swapCount;
  rollup.tvlUsdE18 = source.tvlUsdE18;
  rollup.missingVolumeValue ||= source.missingVolumeValue;
  rollup.missingTotalSwapFeeValue ||= source.missingTotalSwapFeeValue;
  rollup.missingProtocolSwapFeeValue ||= source.missingProtocolSwapFeeValue;
  rollup.missingLpNetSwapFeeValue ||= source.missingLpNetSwapFeeValue;
  addAll(rollup.missingPriceTokens, source.missingPriceTokens);
  rollup.lastBlock = source.lastBlock;
  rollup.lastBlockHash = source.lastBlockHash;
  rollup.revision += source.revision;
  rollup.priceSource = mergePriceSource(rollup.priceSource, source.priceSource ?? "trusted-token-usd");
}

function createRollupCandle(
  source: MutableCandle,
  interval: CandleInterval,
  startTimestamp: number
): MutableCandle {
  return {
    pair: source.pair,
    interval,
    startTimestamp,
    endTimestamp: startTimestamp + candleIntervalSeconds(interval),
    openUsdE18: null,
    highUsdE18: null,
    lowUsdE18: null,
    closeUsdE18: null,
    volumeUsdE18: 0n,
    totalSwapFeesUsdE18: 0n,
    protocolSwapFeesUsdE18: 0n,
    lpNetSwapFeesUsdE18: 0n,
    tvlUsdE18: null,
    swapCount: 0,
    missingVolumeValue: false,
    missingTotalSwapFeeValue: false,
    missingProtocolSwapFeeValue: false,
    missingLpNetSwapFeeValue: false,
    missingPriceTokens: new Set(),
    firstBlock: source.firstBlock,
    lastBlock: source.lastBlock,
    firstBlockHash: source.firstBlockHash,
    lastBlockHash: source.lastBlockHash,
    revision: 0,
    priceSource: null,
    quoteToken: source.quoteToken
  };
}

function mergePriceSource(
  current: CandlePriceSource | null,
  next: CandlePriceSource
): CandlePriceSource {
  if (current === null || current === next) return next;
  return "mixed";
}

export function candleIntervalSeconds(interval: CandleInterval): number {
  switch (interval) {
    case "minute": return MINUTE_SECONDS;
    case "five-minutes": return 5 * MINUTE_SECONDS;
    case "fifteen-minutes": return 15 * MINUTE_SECONDS;
    case "hour": return HOUR_SECONDS;
    case "four-hours": return 4 * HOUR_SECONDS;
    case "day": return DAY_SECONDS;
    case "week": return WEEK_SECONDS;
  }
}

export function candleBoundary(timestamp: number, interval: CandleInterval): number {
  const seconds = candleIntervalSeconds(interval);
  if (interval !== "week") return Math.floor(timestamp / seconds) * seconds;
  return Math.floor((timestamp - MONDAY_EPOCH_OFFSET_SECONDS) / seconds) * seconds + MONDAY_EPOCH_OFFSET_SECONDS;
}

function finalizePosition(
  position: MutableWalletPairPosition,
  prices: TrustedPriceBook,
  headBlock: bigint | null,
  headTimestamp: number | null,
  maxSnapshotAgeSeconds: number
): WalletPairPosition {
  const bins = [...position.bins.values()]
    .filter(
      (bin) =>
        bin.liquidity > 0n ||
        bin.realizedPnlUsdE18 === null ||
        bin.realizedPnlUsdE18 !== 0n ||
        bin.costBasisUsdE18 === null ||
        bin.historyMissingPriceTokens.size > 0
    )
    .sort((a, b) => BigInt(a.binId) < BigInt(b.binId) ? -1 : BigInt(a.binId) > BigInt(b.binId) ? 1 : 0)
    .map((bin) => finalizePositionBin(bin, position, prices, headBlock, headTimestamp, maxSnapshotAgeSeconds));
  const partial = bins.some((bin) => bin.status === "partial");
  const snapshotBlocks = bins.flatMap((bin) => (bin.asOfBlock === null ? [] : [bin.asOfBlock]));
  const snapshotTimestamps = bins.flatMap((bin) => (bin.asOfTimestamp === null ? [] : [bin.asOfTimestamp]));
  const missing = new Set<string>();
  for (const bin of bins) for (const token of bin.missingPriceTokens) missing.add(token);

  return {
    owner: position.owner,
    pair: position.pair,
    bins,
    costBasisUsdE18: sumNullableField(bins, "costBasisUsdE18"),
    currentValueUsdE18: sumNullableField(bins, "currentValueUsdE18"),
    realizedPnlUsdE18: sumNullableField(bins, "realizedPnlUsdE18"),
    unrealizedPnlUsdE18: sumNullableField(bins, "unrealizedPnlUsdE18"),
    status: partial ? "partial" : "ready",
    missingPriceTokens: [...missing].sort(),
    asOfBlock: snapshotBlocks.length === 0 ? headBlock : snapshotBlocks.reduce((oldest, block) => (block < oldest ? block : oldest)),
    asOfTimestamp:
      snapshotTimestamps.length === 0 ? headTimestamp : snapshotTimestamps.reduce((oldest, timestamp) => Math.min(oldest, timestamp))
  };
}

function finalizePositionBin(
  bin: MutablePositionBin,
  position: PairIdentity,
  prices: TrustedPriceBook,
  headBlock: bigint | null,
  headTimestamp: number | null,
  maxSnapshotAgeSeconds: number
): PositionBinAccounting {
  const snapshotFresh =
    headTimestamp !== null &&
    headBlock !== null &&
    bin.snapshotBlock === headBlock &&
    bin.snapshotTimestamp !== null &&
    headTimestamp >= bin.snapshotTimestamp &&
    headTimestamp - bin.snapshotTimestamp <= maxSnapshotAgeSeconds;
  const current =
    snapshotFresh && bin.amountX !== null && bin.amountY !== null
      ? valueAmounts(position, bin.amountX, bin.amountY, prices, headTimestamp)
      : { totalUsdE18: null, missingPriceTokens: new Set<string>() };
  const currentMissing = union(bin.currentMissingPriceTokens, current.missingPriceTokens);
  const partial =
    bin.costBasisUsdE18 === null ||
    current.totalUsdE18 === null ||
    bin.realizedPnlUsdE18 === null ||
    bin.historyMissingPriceTokens.size > 0 ||
    currentMissing.size > 0 ||
    !snapshotFresh;
  return {
    binId: bin.binId,
    liquidity: bin.liquidity,
    costBasisUsdE18: bin.costBasisUsdE18,
    currentValueUsdE18: current.totalUsdE18,
    realizedPnlUsdE18: bin.realizedPnlUsdE18,
    unrealizedPnlUsdE18:
      current.totalUsdE18 === null || bin.costBasisUsdE18 === null ? null : current.totalUsdE18 - bin.costBasisUsdE18,
    amountX: bin.amountX,
    amountY: bin.amountY,
    asOfBlock: bin.snapshotBlock,
    asOfTimestamp: bin.snapshotTimestamp,
    status: partial ? "partial" : "ready",
    missingPriceTokens: [...union(bin.historyMissingPriceTokens, currentMissing)].sort()
  };
}

function sumNullableField(
  bins: PositionBinAccounting[],
  field: "costBasisUsdE18" | "currentValueUsdE18" | "realizedPnlUsdE18" | "unrealizedPnlUsdE18"
): bigint | null {
  let total = 0n;
  for (const bin of bins) {
    const value = bin[field];
    if (value === null) return null;
    total += value;
  }
  return total;
}

function paginate<T>(
  rows: T[],
  first: number,
  after: string | null | undefined,
  snapshotId: string,
  partial: boolean
): Connection<T> {
  if (!Number.isSafeInteger(first) || first <= 0 || first > MAX_PAGE_SIZE) {
    throw new Error(`first must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  const offset = decodeCursor(after, snapshotId);
  const nodes = rows.slice(offset, offset + first);
  const endOffset = offset + nodes.length;
  return {
    nodes,
    pageInfo: {
      endCursor: nodes.length === 0 ? null : encodeCursor(endOffset, snapshotId),
      hasNextPage: endOffset < rows.length,
      partial
    }
  };
}

function encodeCursor(offset: number, snapshotId: string): string {
  return Buffer.from(JSON.stringify({ version: 1, offset, snapshotId }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined, snapshotId: string): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      version?: unknown;
      offset?: unknown;
      snapshotId?: unknown;
    };
    if (decoded.version !== 1 || !Number.isSafeInteger(decoded.offset) || decoded.snapshotId !== snapshotId) {
      throw new Error("Cursor expired or invalid");
    }
    return decoded.offset as number;
  } catch (error) {
    if (error instanceof Error && error.message === "Cursor expired or invalid") throw error;
    throw new Error("Cursor expired or invalid");
  }
}

function cloneBlock(block: BlockEnvelope): BlockEnvelope {
  return structuredClone(block);
}

function canonicalEventContext(blocks: readonly BlockEnvelope[]): CanonicalEventContext {
  let chainId: number | null = null;
  const sources = new Map<string, string>();
  for (const block of blocks) {
    if (block.chainId !== undefined) {
      if (chainId !== null && chainId !== block.chainId) {
        throw new Error("Canonical history contains multiple chain IDs");
      }
      chainId = block.chainId;
    }
    if (block.chainId === undefined) continue;
    for (const event of block.events) {
      if (event.source === undefined) continue;
      const key = `${block.chainId}:${event.source.eventId}`;
      const fingerprint = canonicalFingerprint(event);
      const previous = sources.get(key);
      if (previous !== undefined && previous !== fingerprint) {
        throw new Error(`Canonical event source ${event.source.eventId} changed payload`);
      }
      sources.set(key, fingerprint);
    }
  }
  return { chainId, sources };
}

function canonicalizeBlock(block: BlockEnvelope, context: CanonicalEventContext): BlockEnvelope {
  if (block.chainId !== undefined && context.chainId !== null && block.chainId !== context.chainId) {
    throw new Error(`Block chain ID ${block.chainId} does not match canonical chain ${context.chainId}`);
  }

  const seen = new Map<string, string>();

  const events: AnalyticsEvent[] = [];
  for (const event of block.events) {
    if (event.source === undefined) {
      events.push(structuredClone(event));
      continue;
    }
    const key = `${block.chainId!}:${event.source.eventId}`;
    const fingerprint = canonicalFingerprint(event);
    const previous = seen.get(key) ?? context.sources.get(key);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error(`Canonical event source ${event.source.eventId} changed payload`);
      continue;
    }
    seen.set(key, fingerprint);
    events.push(structuredClone(event));
  }
  const observedPoolPairs = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.kind !== "pair-snapshot" || event.poolState === undefined) continue;
    const pair = normalize(event.pair);
    if (observedPoolPairs.has(pair)) throw new Error(`Pool ${pair} has multiple end-of-block observations`);
    observedPoolPairs.add(pair);
    const laterMarketEvent = events.slice(index + 1).find((candidate) =>
      candidate.kind !== "position-snapshot" &&
      candidate.kind !== "position-transfer" &&
      normalize(candidate.pair) === pair
    );
    if (laterMarketEvent !== undefined) {
      throw new Error(`Pool ${pair} observation must be the final market event in its block`);
    }
  }
  return { ...structuredClone(block), events };
}

function sameBlockPayload(left: BlockEnvelope, right: BlockEnvelope): boolean {
  return canonicalFingerprint(comparableBlockPayload(left)) === canonicalFingerprint(comparableBlockPayload(right));
}

function comparableBlockPayload(block: BlockEnvelope): BlockEnvelope {
  const snapshots = block.events
    .filter((event): event is PositionSnapshotEvent => event.kind === "position-snapshot")
    .sort((left, right) =>
      normalize(left.owner).localeCompare(normalize(right.owner)) ||
      normalize(left.pair).localeCompare(normalize(right.pair))
    );
  return {
    ...block,
    hash: block.hash.toLowerCase() as Hex,
    parentHash: block.parentHash.toLowerCase() as Hex,
    events: [...block.events.filter((event) => event.kind !== "position-snapshot"), ...snapshots]
  };
}

function withMissingPositionSnapshots(incoming: BlockEnvelope, existing: BlockEnvelope): BlockEnvelope {
  const incomingKeys = new Set(
    incoming.events.flatMap((event) => event.kind === "position-snapshot"
      ? [`${normalize(event.owner)}:${normalize(event.pair)}`]
      : [])
  );
  const retainedSnapshots = existing.events.filter((event) =>
    event.kind === "position-snapshot" &&
    !incomingKeys.has(`${normalize(event.owner)}:${normalize(event.pair)}`)
  );
  return retainedSnapshots.length === 0
    ? incoming
    : { ...incoming, events: [...incoming.events, ...structuredClone(retainedSnapshots)] };
}

function canonicalFingerprint(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)])
    );
  }
  return value;
}

function validateBlock(block: BlockEnvelope): void {
  if (block.number < 0n) throw new Error("Block number must be non-negative");
  if (!Number.isSafeInteger(block.timestamp) || block.timestamp < 0) throw new Error("Block timestamp must be a non-negative integer");
  if (block.chainId !== undefined && (!Number.isSafeInteger(block.chainId) || block.chainId <= 0)) {
    throw new Error("Block chain ID must be a positive safe integer when present");
  }
  if (!/^0x[0-9a-fA-F]+$/.test(block.hash) || !/^0x[0-9a-fA-F]+$/.test(block.parentHash)) {
    throw new Error("Block hashes must be hex strings");
  }
  for (const event of block.events) {
    if (event.source !== undefined) {
      if (block.chainId === undefined) throw new Error("Canonical event sources require a block chain ID");
      validateCanonicalEventSource(event.source);
    }
    if (event.kind === "swap") {
      if (event.feeX < 0n || event.feeY < 0n) throw new Error("Total swap fees must be non-negative");
      if (event.protocolFeeX !== undefined && event.protocolFeeX !== null && event.protocolFeeX < 0n ||
        event.protocolFeeY !== undefined && event.protocolFeeY !== null && event.protocolFeeY < 0n) {
        throw new Error("Protocol swap fees must be non-negative");
      }
      if (event.protocolFeeX !== undefined && event.protocolFeeX !== null && event.protocolFeeX > event.feeX ||
        event.protocolFeeY !== undefined && event.protocolFeeY !== null && event.protocolFeeY > event.feeY) {
        throw new Error("Protocol swap fees cannot exceed total swap fees");
      }
    }
    if ("marketPriceQuoteE18" in event && event.marketPriceQuoteE18 !== undefined && event.marketPriceQuoteE18 !== null && event.marketPriceQuoteE18 <= 0n) {
      throw new Error("Active-bin market price must be positive when present");
    }
    if ("activeId" in event && event.activeId !== undefined && event.activeId !== null &&
      (!Number.isSafeInteger(event.activeId) || event.activeId < 0 || event.activeId > 0xff_ff_ff)) {
      throw new Error("Active ID must fit uint24 when present");
    }
    if ("binStep" in event && event.binStep !== undefined && event.binStep !== null &&
      (!Number.isSafeInteger(event.binStep) || event.binStep <= 0 || event.binStep > 0xff_ff)) {
      throw new Error("Bin step must fit a nonzero uint16 when present");
    }
    if (event.kind === "pair-snapshot" && event.poolState !== undefined) {
      if (block.chainId === undefined || event.source === undefined || event.source.kind !== "block-snapshot") {
        throw new Error("Pool-state observations require a chain ID and block-snapshot source");
      }
      if (event.activeId === undefined || event.activeId === null ||
        event.binStep === undefined || event.binStep === null ||
        event.marketPriceQuoteE18 === undefined || event.marketPriceQuoteE18 === null) {
        throw new Error("Pool-state observations require active ID, bin step, and market price");
      }
      validatePoolStateObservation(event.poolState);
    }
  }
}

function validateCanonicalEventSource(source: NonNullable<AnalyticsEvent["source"]>): void {
  if (typeof source.eventId !== "string" || source.eventId.length === 0 || source.eventId.trim() !== source.eventId) {
    throw new Error("Canonical event source ID must be a non-empty trimmed string");
  }
  if (!Number.isSafeInteger(source.sequence) || source.sequence < 0) {
    throw new Error("Canonical event source sequence must be a non-negative safe integer");
  }
  if (source.kind === "log") {
    if (source.transactionHash === null || !/^0x[0-9a-fA-F]+$/.test(source.transactionHash)) {
      throw new Error("Canonical log sources require a transaction hash");
    }
    if (source.logIndex === null || !Number.isSafeInteger(source.logIndex) || source.logIndex < 0) {
      throw new Error("Canonical log sources require a non-negative log index");
    }
    return;
  }
  if (source.kind !== "block-snapshot" || source.transactionHash !== null || source.logIndex !== null) {
    throw new Error("Canonical block-snapshot sources cannot include transaction log identity");
  }
}

function validatePoolStateObservation(observation: PairSnapshotEvent["poolState"]): void {
  if (observation === undefined) return;
  if (!Array.isArray(observation.sourceEventIds) || observation.sourceEventIds.length === 0) {
    throw new Error("Pool-state observations require at least one source event ID");
  }
  const sourceIds = new Set<string>();
  for (const sourceId of observation.sourceEventIds) {
    if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.trim() !== sourceId) {
      throw new Error("Pool-state source event IDs must be non-empty trimmed strings");
    }
    if (sourceIds.has(sourceId)) throw new Error(`Duplicate pool-state source event ID ${sourceId}`);
    sourceIds.add(sourceId);
  }
  if (typeof observation.replaceBinWindow !== "boolean") {
    throw new Error("Pool-state replaceBinWindow must be a boolean");
  }
  validatePoolFeeState(observation.feeState);
  const bins = new Set<string>();
  for (const bin of observation.binUpdates) {
    if (!/^[0-9]+$/.test(bin.binId) || BigInt(bin.binId) > 0xff_ffffn) {
      throw new Error(`Pool bin ID ${bin.binId} must fit uint24`);
    }
    if (bins.has(bin.binId)) throw new Error(`Duplicate pool bin replacement ${bin.binId}`);
    bins.add(bin.binId);
    if (bin.reserveX < 0n || bin.reserveY < 0n || bin.totalSupply < 0n) {
      throw new Error(`Pool bin ${bin.binId} values must be non-negative`);
    }
  }
}

function validatePoolFeeState(fees: PoolStateObservation["feeState"]): void {
  const staticFees = fees.static;
  const variableFees = fees.variable;
  validateUint(staticFees.baseFactor, 0xffffn, "Pool base factor");
  validateUint(staticFees.filterPeriod, 0xfffn, "Pool fee filter period");
  validateUint(staticFees.decayPeriod, 0xfffn, "Pool fee decay period");
  validateUint(staticFees.reductionFactor, 10_000n, "Pool fee reduction factor");
  validateUint(staticFees.variableFeeControl, 0xff_ffffn, "Pool variable fee control");
  validateUint(staticFees.protocolShare, 2_500n, "Pool protocol fee share");
  validateUint(staticFees.maxVolatilityAccumulator, 0xf_ffffn, "Pool maximum volatility accumulator");
  validateUint(variableFees.volatilityAccumulator, 0xf_ffffn, "Pool volatility accumulator");
  validateUint(variableFees.volatilityReference, 0xf_ffffn, "Pool volatility reference");
  validateUint(variableFees.idReference, 0xff_ffffn, "Pool fee ID reference");
  validateUint(variableFees.timeOfLastUpdate, 0xff_ffff_ffffn, "Pool fee update time");
  if (staticFees.filterPeriod > staticFees.decayPeriod) {
    throw new Error("Pool fee filter period cannot exceed decay period");
  }
  if (
    variableFees.volatilityAccumulator > staticFees.maxVolatilityAccumulator ||
    variableFees.volatilityReference > staticFees.maxVolatilityAccumulator
  ) {
    throw new Error("Pool variable fee state exceeds its configured volatility maximum");
  }
}

function validateUint(value: bigint, maximum: bigint, label: string): void {
  if (typeof value !== "bigint" || value < 0n || value > maximum) {
    throw new Error(`${label} is outside its canonical unsigned range`);
  }
}

function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function normalize(value: string): string {
  return value.toLowerCase();
}

function addAll(target: Set<string>, source: Set<string>): void {
  for (const value of source) target.add(value);
}

function union(...sets: Set<string>[]): Set<string> {
  const result = new Set<string>();
  for (const set of sets) addAll(result, set);
  return result;
}

function addNullable(a: bigint | null, b: bigint | null): bigint | null {
  return a === null || b === null ? null : a + b;
}

function subtractNullable(a: bigint | null, b: bigint | null): bigint | null {
  return a === null || b === null ? null : a - b;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function isBackfillStatus(value: unknown): value is BackfillStatus {
  return value === "unavailable" || value === "running" || value === "complete" || value === "partial" || value === "capped";
}
