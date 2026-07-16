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
  PoolMetrics,
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
  missingPriceTokens: Set<string>;
  updatedAtBlock: bigint;
  updatedAtTimestamp: number;
}

interface FlowRow {
  pair: string;
  timestamp: number;
  volumeUsdE18: bigint | null;
  feesUsdE18: bigint | null;
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
  feesUsdE18: bigint;
  tvlUsdE18: bigint | null;
  swapCount: number;
  missingVolumeValue: boolean;
  missingFeeValue: boolean;
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
    const existing = this.#blocks.find((candidate) => candidate.hash.toLowerCase() === block.hash.toLowerCase());
    if (existing) {
      if (existing.number !== block.number) throw new Error(`Block hash ${block.hash} changed number`);
      return "duplicate";
    }

    const head = this.#blocks.at(-1);
    if (!head) {
      this.#blocks.push(cloneBlock(block));
      this.#rebuild();
      this.#advanceCoverage(block.timestamp);
      return "appended";
    }

    if (block.number === head.number + 1n && sameHash(block.parentHash, head.hash)) {
      this.#blocks.push(cloneBlock(block));
      this.#rebuild();
      this.#advanceCoverage(block.timestamp);
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

    this.#blocks.splice(parentIndex + 1, this.#blocks.length, cloneBlock(block));
    this.#reorgCount += 1;
    this.#rebuild();
    this.#advanceCoverage(block.timestamp);
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
      version: 1,
      reorgCount: this.#reorgCount,
      blocks: structuredClone(this.#blocks),
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
    head.events = [
      ...head.events.filter(
        (event) =>
          event.kind !== "position-snapshot" ||
          !replacementKeys.has(`${normalize(event.owner)}:${normalize(event.pair)}`)
      ),
      ...structuredClone(snapshots)
    ];
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
    const rows = [...this.#candles.values()]
      .filter(
        (candle) =>
          candle.pair === pair &&
          candle.interval === input.interval &&
          candle.startTimestamp >= input.fromTimestamp &&
          candle.startTimestamp <= input.toTimestamp
      )
      .sort((a, b) => a.startTimestamp - b.startTimestamp)
      .map((candle) => finalizeCandle(candle, headTimestamp));
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
    this.#partialEventCount = 0;
    this.#missingPriceTokens = new Set();

    for (const block of this.#blocks) {
      for (const sample of block.prices) this.#priceBook.apply(sample, block.timestamp);
      for (const event of block.events) this.#applyEvent(event, block.number, block.hash, block.timestamp);
    }
    this.#buildCandleRollups();
  }

  #applyEvent(event: AnalyticsEvent, blockNumber: bigint, blockHash: Hex, timestamp: number): void {
    this.#eventIsPartial = false;
    if (event.kind === "position-snapshot") {
      this.#applyPositionSnapshot(event, blockNumber, timestamp);
    } else if (event.kind === "position-transfer") {
      this.#applyPositionTransfer(event);
    } else {
      const pair = this.#updatePair(event, blockNumber, timestamp);
      this.#updateCandlesForSnapshot(pair, blockNumber, blockHash, timestamp);

      if (event.kind === "swap") this.#applySwap(event, pair, blockNumber, blockHash, timestamp);
      if (event.kind === "deposit" || event.kind === "withdraw") this.#applyLiquidity(event, timestamp);
    }
    if (this.#eventIsPartial) this.#partialEventCount += 1;
  }

  #updatePair(event: Exclude<AnalyticsEvent, PositionSnapshotEvent | PositionTransferEvent>, blockNumber: bigint, timestamp: number): PairState {
    const identity = normalizePair(event);
    const current = this.#pairs.get(identity.pair);
    if (current && !samePairIdentity(current, identity)) throw new Error(`Pair identity changed for ${identity.pair}`);

    const reserves = valueAmounts(identity, event.reserveX, event.reserveY, this.#priceBook, timestamp);
    const tokenXPrice = this.#priceBook.get(identity.tokenX, timestamp);
    const tokenYPrice = this.#priceBook.get(identity.tokenY, timestamp);
    const observedQuotePrice = event.marketPriceQuoteE18 ?? null;
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
      missingPriceTokens: union(reserves.missingPriceTokens, priceMissing),
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: timestamp
    };
    this.#pairs.set(identity.pair, pair);
    this.#pairSnapshots.push(pair);
    this.#recordPartial(pair.missingPriceTokens);
    return pair;
  }

  #applySwap(event: SwapAnalyticsEvent, pair: PairState, blockNumber: bigint, blockHash: Hex, timestamp: number): void {
    const volume = valueAmounts(pair, event.amountInX, event.amountInY, this.#priceBook, timestamp);
    const fees = valueAmounts(pair, event.feeX, event.feeY, this.#priceBook, timestamp);
    const missing = union(volume.missingPriceTokens, fees.missingPriceTokens, pair.missingPriceTokens);
    this.#flows.push({
      pair: pair.pair,
      timestamp,
      volumeUsdE18: volume.totalUsdE18,
      feesUsdE18: fees.totalUsdE18,
      missingPriceTokens: missing
    });
    this.#recordPartial(missing);

    const candle = this.#getCandle(pair, "minute", blockNumber, blockHash, timestamp);
    candle.swapCount += 1;
    candle.revision += 1;
    if (volume.totalUsdE18 === null) candle.missingVolumeValue = true;
    else candle.volumeUsdE18 += volume.totalUsdE18;
    if (fees.totalUsdE18 === null) candle.missingFeeValue = true;
    else candle.feesUsdE18 += fees.totalUsdE18;
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
        feesUsdE18: 0n,
        tvlUsdE18: null,
        swapCount: 0,
        missingVolumeValue: false,
        missingFeeValue: false,
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
    const minutes = [...this.#candles.values()]
      .filter((candle) => candle.interval === "minute")
      .sort((left, right) => left.startTimestamp - right.startTimestamp);

    const rollup = (sources: readonly MutableCandle[], intervals: readonly CandleInterval[]) => {
      for (const interval of intervals) for (const source of sources) {
        const startTimestamp = candleBoundary(source.startTimestamp, interval);
        const key = `${source.pair}:${interval}:${startTimestamp}`;
        let rollup = this.#candles.get(key);
        if (!rollup) {
          rollup = {
            pair: source.pair,
            interval,
            startTimestamp,
            endTimestamp: startTimestamp + candleIntervalSeconds(interval),
            openUsdE18: null,
            highUsdE18: null,
            lowUsdE18: null,
            closeUsdE18: null,
            volumeUsdE18: 0n,
            feesUsdE18: 0n,
            tvlUsdE18: null,
            swapCount: 0,
            missingVolumeValue: false,
            missingFeeValue: false,
            missingPriceTokens: new Set(),
            firstBlock: source.firstBlock,
            lastBlock: source.lastBlock,
            firstBlockHash: source.firstBlockHash,
            lastBlockHash: source.lastBlockHash,
            revision: 0,
            priceSource: null,
            quoteToken: source.quoteToken
          };
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
    let fees = 0n;
    let volumePartial = false;
    let feesPartial = false;
    for (const flow of flows) {
      addAll(missing, flow.missingPriceTokens);
      if (flow.volumeUsdE18 === null) volumePartial = true;
      else volume += flow.volumeUsdE18;
      if (flow.feesUsdE18 === null) feesPartial = true;
      else fees += flow.feesUsdE18;
    }
    const coveragePartial = !this.#historyCovers(cutoff, asOfTimestamp);
    const partial = valuation.totalUsdE18 === null || price.priceUsdE18 === null || volumePartial || feesPartial || coveragePartial;

    return {
      pair: pair.pair,
      tokenX: pair.tokenX,
      tokenY: pair.tokenY,
      tvlUsdE18: valuation.totalUsdE18,
      volume24hUsdE18: volumePartial || coveragePartial ? null : volume,
      fees24hUsdE18: feesPartial || coveragePartial ? null : fees,
      feeToTvlE18: feesPartial || coveragePartial || valuation.totalUsdE18 === null ? null : ratioE18(fees, valuation.totalUsdE18),
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
    candle.missingFeeValue ||
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
    feesUsdE18: candle.missingFeeValue ? null : candle.feesUsdE18,
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
  rollup.feesUsdE18 += source.feesUsdE18;
  rollup.swapCount += source.swapCount;
  rollup.tvlUsdE18 = source.tvlUsdE18;
  rollup.missingVolumeValue ||= source.missingVolumeValue;
  rollup.missingFeeValue ||= source.missingFeeValue;
  addAll(rollup.missingPriceTokens, source.missingPriceTokens);
  rollup.lastBlock = source.lastBlock;
  rollup.lastBlockHash = source.lastBlockHash;
  rollup.revision += source.revision;
  rollup.priceSource = mergePriceSource(rollup.priceSource, source.priceSource ?? "trusted-token-usd");
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

function validateBlock(block: BlockEnvelope): void {
  if (block.number < 0n) throw new Error("Block number must be non-negative");
  if (!Number.isSafeInteger(block.timestamp) || block.timestamp < 0) throw new Error("Block timestamp must be a non-negative integer");
  if (!/^0x[0-9a-fA-F]+$/.test(block.hash) || !/^0x[0-9a-fA-F]+$/.test(block.parentHash)) {
    throw new Error("Block hashes must be hex strings");
  }
  for (const event of block.events) {
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
