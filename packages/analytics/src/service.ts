import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { buildSchema, graphql, isScalarType, type ExecutionResult, type GraphQLSchema } from "graphql";

import { runBackfill, type BackfillResult } from "./backfill.js";
import {
  marketMetadataLookupKey,
  type MarketMetadataProvider,
  type ProxiedTokenImage
} from "./discovery-metadata.js";
import {
  AnalyticsEngine,
  CanonicalHeadChangedError,
  type AnalyticsCheckpoint,
  type AnalyticsCheckpointMetadata,
  type CanonicalHead
} from "./engine.js";
import type {
  AnalyticsHealth,
  BlockEnvelope,
  BlockSubmission,
  Candle,
  CandleInterval,
  PriceSample,
  PriceSubmission,
  PositionSnapshotEvent,
  PoolBinState,
  PoolDiscoveryPool,
  PoolDiscoveryRequest,
  PoolState,
  PoolStateSnapshot,
  PoolStateUpdate,
  WalletPairPosition,
  Connection
} from "./types.js";

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const STREAM_HEARTBEAT_MS = 15_000;
const MAX_STREAM_SUBSCRIBERS = 500;
const DEFAULT_STREAM_REPLAY_SIZE = 2_048;
const DEFAULT_GLOBAL_STREAM_REPLAY_SIZE = 8_192;
const POOL_STREAM_RADIUS = 40;

type GraphqlCandleInterval =
  | "ONE_MINUTE"
  | "FIVE_MINUTES"
  | "FIFTEEN_MINUTES"
  | "HOUR"
  | "FOUR_HOURS"
  | "DAY"
  | "WEEK";

export interface CandleStreamEvent {
  cursor: string;
  type: "candle" | "pool-state" | "reset";
  pair: string | null;
  interval: CandleInterval | null;
  candle: Candle | null;
  update?: PoolStateUpdate | null;
  reason: string | null;
}

export type CandleStreamEventInput = Omit<CandleStreamEvent, "cursor">;

export interface PoolStatePersistenceChange {
  state: PoolState;
  bins: readonly PoolBinState[];
  replaceBinWindow: boolean;
}

export class AnalyticsCheckpointStore {
  constructor(readonly path: string) {}

  async load(): Promise<AnalyticsCheckpoint | null> {
    try {
      return decodeTaggedJson(await readFile(this.path, "utf8")) as AnalyticsCheckpoint;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(checkpoint: AnalyticsCheckpoint, _candles?: readonly Candle[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryPath, encodeTaggedJson(checkpoint), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}

export interface AnalyticsStateStore {
  load(): Promise<AnalyticsCheckpoint | null>;
  save(
    checkpoint: AnalyticsCheckpoint,
    candles: readonly Candle[],
    poolStates?: readonly PoolStatePersistenceChange[]
  ): Promise<void>;
  appendCanonicalState?(
    metadata: AnalyticsCheckpointMetadata,
    block: BlockEnvelope,
    candles: readonly Candle[],
    poolStates?: readonly PoolStatePersistenceChange[]
  ): Promise<void>;
  appendCanonicalStateAndCandleEvents?(
    metadata: AnalyticsCheckpointMetadata,
    block: BlockEnvelope,
    candles: readonly Candle[],
    events: readonly CandleStreamEvent[],
    poolStates?: readonly PoolStatePersistenceChange[]
  ): Promise<void>;
  saveCanonicalStateAndCandleEvents?(
    checkpoint: AnalyticsCheckpoint,
    candles: readonly Candle[],
    events: readonly CandleStreamEvent[],
    poolStates?: readonly PoolStatePersistenceChange[]
  ): Promise<void>;
  loadCandleEvents?(): Promise<CandleStreamEvent[]>;
  appendCandleEvents?(events: readonly CandleStreamEvent[]): Promise<void>;
  close?(): Promise<void>;
}

interface PendingCanonicalCommit {
  block: BlockEnvelope;
  fullCandles: Candle[] | null;
  fullPoolStates: PoolStateSnapshot[] | null;
  changedCandles: Candle[];
  changedPoolUpdates: PoolStateUpdate[];
  canonicalPersisted: boolean;
  result: "appended" | "reorg";
}

export interface AnalyticsApiServiceOptions {
  engine: AnalyticsEngine;
  store?: AnalyticsStateStore | null;
  allowFixedTestPrices?: boolean;
  priceVerifier?: PriceSampleVerifier | null;
  positionSnapshotProvider?: PositionSnapshotProvider | null;
  marketMetadataProvider?: MarketMetadataProvider | null;
}

export interface PriceSampleVerifier {
  verify(
    submission: PriceSubmission,
    context: { blockNumber: bigint; blockHash: string; blockTimestamp: number }
  ): Promise<PriceSample>;
}

export interface BlockSubmissionPage {
  blocks: BlockSubmission[];
  nextCursor: string | null;
  hasMore: boolean;
  canonicalHead?: CanonicalHead | null;
  rewindTo?: CanonicalHead | null;
}

export interface AnalyticsBlockSource {
  fetchPage(cursor: string | null): Promise<BlockSubmissionPage>;
  startupCursor?(checkpoint: {
    persistedCursor: string | null;
    retainedHead: CanonicalHead | null;
  }): string | null | Promise<string | null>;
  followLive?(
    ingest: (block: BlockSubmission) => Promise<unknown>,
    reconcileHead?: (head: CanonicalHead) => Promise<unknown>
  ): Promise<void>;
}

export interface PositionSnapshotProvider {
  load(owner: string, head: CanonicalHead): Promise<PositionSnapshotEvent[]>;
}

export class CandleStreamHub {
  readonly #eventsByTopic = new Map<string, CandleStreamEvent[]>();
  readonly #droppedThroughByTopic = new Map<string, number>();
  readonly #retainedEvents = new Map<number, CandleStreamEvent>();
  readonly #subscribers = new Set<(event: CandleStreamEvent) => void>();
  readonly #replaySize: number;
  readonly #globalReplaySize: number;
  #globalDroppedThrough = 0;
  #sequence = 0;
  #failedSubscriberCount = 0;

  constructor(
    replaySize = DEFAULT_STREAM_REPLAY_SIZE,
    globalReplaySize = DEFAULT_GLOBAL_STREAM_REPLAY_SIZE
  ) {
    if (!Number.isSafeInteger(replaySize) || replaySize <= 0) throw new Error("Candle stream replay size must be positive");
    if (!Number.isSafeInteger(globalReplaySize) || globalReplaySize <= 0) {
      throw new Error("Global stream replay size must be positive");
    }
    this.#replaySize = replaySize;
    this.#globalReplaySize = globalReplaySize;
  }

  get cursor(): string {
    return String(this.#sequence);
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  get failedSubscriberCount(): number {
    return this.#failedSubscriberCount;
  }

  get retainedEventCount(): number {
    return this.#retainedEvents.size;
  }

  get retainedTopicCount(): number {
    return this.#eventsByTopic.size;
  }

  restore(events: readonly CandleStreamEvent[]): void {
    if (this.#sequence !== 0 || this.#eventsByTopic.size !== 0) throw new Error("Candle stream can only be restored while empty");
    let previous = 0;
    for (const event of events) {
      const cursor = Number(event.cursor);
      if (!Number.isSafeInteger(cursor) || cursor <= previous) throw new Error("Persisted candle stream cursor is invalid");
      previous = cursor;
      this.#retain(deepFreeze(structuredClone(event)));
    }
    this.#sequence = previous;
    const oldestGlobalCursor = Number(events[0]?.cursor ?? 1);
    if (oldestGlobalCursor > 1) {
      this.#globalDroppedThrough = Math.max(this.#globalDroppedThrough, oldestGlobalCursor - 1);
    }
    for (const [topic, retained] of this.#eventsByTopic) {
      const oldest = Number(retained[0]?.cursor ?? 1);
      if (oldest > 1) {
        this.#droppedThroughByTopic.set(
          topic,
          Math.max(this.#droppedThroughByTopic.get(topic) ?? 0, oldest - 1)
        );
      }
    }
  }

  publishCandle(candle: Candle): CandleStreamEvent {
    return this.#publish({
      type: "candle",
      pair: candle.pair,
      interval: candle.interval,
      candle,
      update: null,
      reason: null
    });
  }

  publishPoolState(update: PoolStateUpdate): CandleStreamEvent {
    return this.#publish({
      type: "pool-state",
      pair: update.state.pair,
      interval: null,
      candle: null,
      update,
      reason: null
    });
  }

  publishReset(reason: string): CandleStreamEvent {
    return this.#publish({ type: "reset", pair: null, interval: null, candle: null, update: null, reason });
  }

  async publishBatch(
    inputs: readonly CandleStreamEventInput[],
    persist: (events: readonly CandleStreamEvent[]) => Promise<void>
  ): Promise<CandleStreamEvent[]> {
    const events = inputs.map((input, index) => ({
      ...input,
      cursor: String(this.#sequence + index + 1)
    }));
    await persist(events);
    for (const event of events) this.#commit(event);
    return events;
  }

  replay(after: string, pair: string, interval: CandleInterval): CandleStreamEvent[] | null {
    return this.#replayTopic(after, candleTopic(pair, interval));
  }

  replayPool(after: string, pair: string): CandleStreamEvent[] | null {
    return this.#replayTopic(after, poolTopic(pair));
  }

  #replayTopic(after: string, topic: string): CandleStreamEvent[] | null {
    if (!/^\d+$/.test(after)) return null;
    const cursor = Number(after);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.#sequence) return null;
    const droppedThrough = Math.max(
      this.#globalDroppedThrough,
      this.#droppedThroughByTopic.get(topic) ?? 0,
      this.#droppedThroughByTopic.get(RESET_TOPIC) ?? 0
    );
    if (cursor < droppedThrough) return null;
    return [
      ...(this.#eventsByTopic.get(topic) ?? []),
      ...(this.#eventsByTopic.get(RESET_TOPIC) ?? [])
    ]
      .filter((event) => Number(event.cursor) > cursor)
      .sort((left, right) => Number(left.cursor) - Number(right.cursor));
  }

  subscribe(listener: (event: CandleStreamEvent) => void): () => void {
    if (this.#subscribers.size >= MAX_STREAM_SUBSCRIBERS) throw new Error("Candle stream subscriber limit reached");
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  #publish(input: Omit<CandleStreamEvent, "cursor">): CandleStreamEvent {
    const event = { ...input, cursor: String(this.#sequence + 1) };
    this.#commit(event);
    return event;
  }

  #commit(event: CandleStreamEvent): void {
    const cursor = Number(event.cursor);
    if (cursor !== this.#sequence + 1) throw new Error("Candle stream events must commit in cursor order");
    const committed = deepFreeze(structuredClone(event));
    this.#sequence = cursor;
    this.#retain(committed);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(committed);
      } catch {
        this.#failedSubscriberCount += 1;
        this.#subscribers.delete(subscriber);
      }
    }
  }

  #retain(event: CandleStreamEvent): void {
    const topic = streamTopic(event);
    const retained = this.#eventsByTopic.get(topic) ?? [];
    retained.push(event);
    this.#retainedEvents.set(Number(event.cursor), event);
    if (retained.length > this.#replaySize) {
      const removed = retained.splice(0, retained.length - this.#replaySize);
      this.#droppedThroughByTopic.set(topic, Number(removed.at(-1)!.cursor));
      for (const candidate of removed) this.#retainedEvents.delete(Number(candidate.cursor));
    }
    this.#eventsByTopic.set(topic, retained);
    if (topic === RESET_TOPIC) {
      for (const retainedTopic of this.#eventsByTopic.keys()) {
        if (retainedTopic !== RESET_TOPIC) this.#trimCombinedTopic(retainedTopic);
      }
    } else {
      this.#trimCombinedTopic(topic);
    }
    this.#trimGlobalReplay();
  }

  #trimCombinedTopic(topic: string): void {
    const combined = [
      ...(this.#eventsByTopic.get(topic) ?? []),
      ...(this.#eventsByTopic.get(RESET_TOPIC) ?? [])
    ].sort((left, right) => Number(left.cursor) - Number(right.cursor));
    if (combined.length <= this.#replaySize) return;
    const droppedThrough = Number(combined[combined.length - this.#replaySize - 1]!.cursor);
    this.#droppedThroughByTopic.set(
      topic,
      Math.max(this.#droppedThroughByTopic.get(topic) ?? 0, droppedThrough)
    );
    const retained = this.#eventsByTopic.get(topic) ?? [];
    const kept = retained.filter((candidate) => Number(candidate.cursor) > droppedThrough);
    for (const candidate of retained) {
      if (Number(candidate.cursor) <= droppedThrough) this.#retainedEvents.delete(Number(candidate.cursor));
    }
    if (kept.length === 0) this.#eventsByTopic.delete(topic);
    else this.#eventsByTopic.set(topic, kept);
  }

  #trimGlobalReplay(): void {
    while (this.#retainedEvents.size > this.#globalReplaySize) {
      const oldest = this.#retainedEvents.entries().next().value as [number, CandleStreamEvent] | undefined;
      if (oldest === undefined) throw new Error("Global replay accounting is inconsistent");
      const [cursor, event] = oldest;
      const topic = streamTopic(event);
      const retained = this.#eventsByTopic.get(topic);
      if (retained === undefined || Number(retained[0]?.cursor) !== cursor) {
        throw new Error("Global replay order is inconsistent with its topic buffer");
      }
      retained.shift();
      this.#retainedEvents.delete(cursor);
      this.#globalDroppedThrough = cursor;
      if (retained.length === 0) {
        this.#eventsByTopic.delete(topic);
        this.#droppedThroughByTopic.delete(topic);
      }
    }
    if (this.#droppedThroughByTopic.size > this.#globalReplaySize * 2) {
      for (const [topic, cursor] of this.#droppedThroughByTopic) {
        if (cursor <= this.#globalDroppedThrough) this.#droppedThroughByTopic.delete(topic);
      }
    }
  }
}

const RESET_TOPIC = "reset";

function candleTopic(pair: string, interval: CandleInterval): string {
  return `candle:${pair.toLowerCase()}:${interval}`;
}

function poolTopic(pair: string): string {
  return `pool:${pair.toLowerCase()}`;
}

export function streamTopic(event: CandleStreamEvent): string {
  if (event.type === "reset") {
    if (event.pair !== null || event.interval !== null || event.candle !== null) {
      throw new Error("Reset stream event contains topic data");
    }
    return RESET_TOPIC;
  }
  if (event.type === "pool-state") {
    if (event.pair === null || event.interval !== null || event.candle !== null || event.update == null) {
      throw new Error("Pool-state stream event is incomplete");
    }
    if (event.update.state.pair.toLowerCase() !== event.pair.toLowerCase()) {
      throw new Error("Pool-state stream event pair does not match its update");
    }
    return poolTopic(event.pair);
  }
  if (event.pair === null || event.interval === null || event.candle === null) {
    throw new Error("Candle stream event is incomplete");
  }
  if (event.candle.pair.toLowerCase() !== event.pair.toLowerCase() || event.candle.interval !== event.interval) {
    throw new Error("Candle stream event topic does not match its candle");
  }
  return candleTopic(event.pair, event.interval);
}

export class AnalyticsApiService {
  readonly #engine: AnalyticsEngine;
  readonly #schema: GraphQLSchema;
  readonly #store: AnalyticsStateStore | null;
  readonly #allowFixedTestPrices: boolean;
  readonly #priceVerifier: PriceSampleVerifier | null;
  readonly #positionSnapshotProvider: PositionSnapshotProvider | null;
  readonly #marketMetadataProvider: MarketMetadataProvider | null;
  readonly #stream = new CandleStreamHub();
  readonly #mutations = new AsyncMutex();
  readonly #streamDrops = new Map<string, number>();
  #candleSnapshot = new Map<string, string>();
  #pendingCanonicalCommit: PendingCanonicalCommit | null = null;
  #streamReconnects = 0;
  #rebuildCount = 0;
  #rebuildDurationSeconds = 0;
  #lastDeliveryLagSeconds = 0;

  private constructor(options: AnalyticsApiServiceOptions, schema: GraphQLSchema) {
    this.#engine = options.engine;
    this.#schema = schema;
    this.#store = options.store ?? null;
    this.#allowFixedTestPrices = options.allowFixedTestPrices ?? false;
    this.#priceVerifier = options.priceVerifier ?? null;
    this.#positionSnapshotProvider = options.positionSnapshotProvider ?? null;
    this.#marketMetadataProvider = options.marketMetadataProvider ?? null;
  }

  static async create(options: AnalyticsApiServiceOptions): Promise<AnalyticsApiService> {
    const schemaSource = await readFile(new URL("../../schema.graphql", import.meta.url), "utf8");
    const schema = buildSchema(schemaSource);
    configureBigIntScalar(schema);
    const service = new AnalyticsApiService(options, schema);
    const checkpoint = await service.#store?.load();
    if (checkpoint) service.#engine.restoreCheckpoint(checkpoint);
    const persistedEvents = await service.#store?.loadCandleEvents?.();
    if (persistedEvents && persistedEvents.length > 0) service.#stream.restore(persistedEvents);
    service.#replaceCandleSnapshot();
    return service;
  }

  get candleStream(): CandleStreamHub {
    return this.#stream;
  }

  recordStreamReconnect(): void {
    this.#streamReconnects += 1;
  }

  recordStreamDrop(reason: string): void {
    this.#streamDrops.set(reason, (this.#streamDrops.get(reason) ?? 0) + 1);
  }

  renderMetrics(nowTimestamp = Math.floor(Date.now() / 1_000)): string {
    const headTimestamp = this.#engine.getCanonicalHead()?.timestamp ?? null;
    const ingestLag = headTimestamp === null ? 0 : Math.max(0, nowTimestamp - headTimestamp);
    const drops = new Map(this.#streamDrops);
    if (this.#stream.failedSubscriberCount > 0) {
      drops.set("listener-error", (drops.get("listener-error") ?? 0) + this.#stream.failedSubscriberCount);
    }
    const lines = [
      "# HELP feather_analytics_ingest_lag_seconds Seconds between wall clock and the canonical analytics head.",
      "# TYPE feather_analytics_ingest_lag_seconds gauge",
      `feather_analytics_ingest_lag_seconds ${ingestLag}`,
      "# HELP feather_analytics_delivery_lag_seconds Seconds between the latest canonical block and durable stream publication.",
      "# TYPE feather_analytics_delivery_lag_seconds gauge",
      `feather_analytics_delivery_lag_seconds ${this.#lastDeliveryLagSeconds}`,
      "# HELP feather_analytics_stream_reconnects_total Stream requests that supplied a replay cursor.",
      "# TYPE feather_analytics_stream_reconnects_total counter",
      `feather_analytics_stream_reconnects_total ${this.#streamReconnects}`,
      "# HELP feather_analytics_stream_drops_total Stream connections closed to preserve bounded memory or cursor correctness.",
      "# TYPE feather_analytics_stream_drops_total counter",
      ...[...drops].sort(([left], [right]) => left.localeCompare(right)).map(
        ([reason, count]) => `feather_analytics_stream_drops_total{reason="${prometheusLabel(reason)}"} ${count}`
      ),
      "# HELP feather_analytics_rebuilds_total Canonical reorg rebuilds.",
      "# TYPE feather_analytics_rebuilds_total counter",
      `feather_analytics_rebuilds_total ${this.#rebuildCount}`,
      "# HELP feather_analytics_rebuild_duration_seconds Total time spent rebuilding after canonical reorgs.",
      "# TYPE feather_analytics_rebuild_duration_seconds counter",
      `feather_analytics_rebuild_duration_seconds ${this.#rebuildDurationSeconds}`,
      "# HELP feather_analytics_stream_subscribers Active SSE subscribers across candle and pool topics.",
      "# TYPE feather_analytics_stream_subscribers gauge",
      `feather_analytics_stream_subscribers ${this.#stream.subscriberCount}`
    ];
    return `${lines.join("\n")}\n`;
  }

  async renderCommittedMetrics(nowTimestamp = Math.floor(Date.now() / 1_000)): Promise<string> {
    return this.#readCommitted(() => this.renderMetrics(nowTimestamp));
  }

  async ingestBlock(submission: BlockSubmission): Promise<"appended" | "duplicate" | "reorg"> {
    const block = await this.#verifyBlock(submission);
    return this.#mutations.run(async () => {
      await this.#flushPendingCanonicalCommit();
      const rebuildStarted = Date.now();
      const result = this.#engine.ingestBlock(block);
      if (result === "reorg") {
        this.#rebuildCount += 1;
        this.#rebuildDurationSeconds += (Date.now() - rebuildStarted) / 1_000;
      }
      if (result !== "duplicate") {
        const changedCandles = result === "appended"
          ? this.#engine.listLastChangedCandles()
          : this.#engine.listCandles();
        const changedPoolUpdates = result === "appended"
          ? this.#engine.listLastChangedPoolUpdates()
          : [];
        const needsFullCandles = result === "reorg" ||
          (this.#store !== null && this.#store.appendCanonicalState === undefined);
        this.#pendingCanonicalCommit = {
          block,
          fullCandles: needsFullCandles ? this.#engine.listCandles() : null,
          fullPoolStates: result === "reorg" ? this.#engine.listPoolStates() : null,
          changedCandles: this.#changedCandles(changedCandles),
          changedPoolUpdates,
          canonicalPersisted: false,
          result
        };
        await this.#flushPendingCanonicalCommit();
        this.#lastDeliveryLagSeconds = Math.max(0, Math.floor(Date.now() / 1_000) - block.timestamp);
      }
      return result;
    });
  }

  async reconcileCanonicalHead(head: CanonicalHead): Promise<"duplicate" | "reorg"> {
    return this.#mutations.run(async () => {
      await this.#flushPendingCanonicalCommit();
      const rebuildStarted = Date.now();
      const result = this.#engine.rewindCanonicalHead(head);
      if (result === "duplicate") return result;

      this.#rebuildCount += 1;
      this.#rebuildDurationSeconds += (Date.now() - rebuildStarted) / 1_000;
      const retainedHead = this.#engine.getCanonicalHeadEnvelope();
      if (retainedHead === null) throw new Error("Canonical rewind unexpectedly removed every retained block");
      const candles = this.#engine.listCandles();
      const poolStates = this.#engine.listPoolStates();
      this.#pendingCanonicalCommit = {
        block: retainedHead,
        fullCandles: candles,
        fullPoolStates: poolStates,
        changedCandles: candles,
        changedPoolUpdates: [],
        canonicalPersisted: false,
        result: "reorg"
      };
      await this.#flushPendingCanonicalCommit();
      this.#lastDeliveryLagSeconds = Math.max(0, Math.floor(Date.now() / 1_000) - retainedHead.timestamp);
      return result;
    });
  }

  async backfill(
    fetchPage: (cursor: string | null) => Promise<BlockSubmissionPage>,
    options: { startCursor?: string | null; maxPages?: number } = {}
  ): Promise<BackfillResult> {
    return this.#mutations.run(async () => {
      await this.#flushPendingCanonicalCommit();
      const reorgCountBefore = this.#engine.exportCheckpointMetadata().reorgCount;
      const rebuildStarted = Date.now();
      try {
        return await runBackfill({
          engine: this.#engine,
          startCursor: options.startCursor,
          maxPages: options.maxPages,
          fetchPage: async (cursor) => {
            const page = await fetchPage(cursor);
            return {
              ...page,
              canonicalHead: page.canonicalHead,
              rewindTo: page.rewindTo,
              blocks: await Promise.all(page.blocks.map((block) => this.#verifyBlock(block)))
            };
          }
        });
      } finally {
        const rebuilds = this.#engine.exportCheckpointMetadata().reorgCount - reorgCountBefore;
        if (rebuilds > 0) {
          this.#rebuildCount += rebuilds;
          this.#rebuildDurationSeconds += (Date.now() - rebuildStarted) / 1_000;
        }
        await this.#persistFullStateAndPublish(rebuilds > 0);
      }
    });
  }

  getHealth(nowTimestamp?: number): AnalyticsHealth {
    return this.#engine.getHealth(nowTimestamp);
  }

  async persist(): Promise<void> {
    await this.#mutations.run(async () => {
      await this.#flushPendingCanonicalCommit();
      await this.#persistUnlocked();
    });
  }

  async execute(source: string, variableValues?: Record<string, unknown>): Promise<ExecutionResult> {
    return graphql({
      schema: this.#schema,
      source,
      variableValues,
      rootValue: {
        poolMetrics: (args: { first: number; after?: string | null; asOfTimestamp?: number }) =>
          this.#readCommitted(() => mapConnection(this.#engine.queryPoolMetrics(args), mapPoolMetrics)),
        poolDiscovery: (args: { pools: PoolDiscoveryRequest[]; asOfTimestamp?: number }) =>
          this.queryPoolDiscovery(args).then((rows) => rows.map(mapPoolDiscovery)),
        pairCandles: (args: {
          pair: string;
          interval: GraphqlCandleInterval;
          fromTimestamp: number;
          toTimestamp: number;
          first: number;
          after?: string | null;
        }) => this.#readCommitted(() => ({
          ...mapConnection(
            this.#engine.queryCandles({
              ...args,
              interval: candleIntervalFromGraphql(args.interval)
            }),
            mapCandle
          ),
          streamCursor: this.#stream.cursor
        })),
        poolState: (args: { pair: string; radius: number }) => this.#readCommitted(() => {
          const snapshot = this.#engine.queryPoolState(args);
          return snapshot === null ? null : mapPoolStateSnapshot(snapshot, this.#stream.cursor);
        }),
        walletPositions: async (args: { owner: string; first: number; after?: string | null }) =>
          mapConnection(await this.queryWalletPositions(args), mapWalletPosition),
        analyticsHealth: () => this.#readCommitted(() => mapHealth(this.#engine.getHealth()))
      }
    });
  }

  async queryPoolDiscovery(args: {
    pools: readonly PoolDiscoveryRequest[];
    asOfTimestamp?: number;
  }): Promise<PoolDiscoveryPool[]> {
    const rows = await this.#readCommitted(() => this.#engine.queryPoolDiscovery(args));
    if (this.#marketMetadataProvider === null) return rows;
    const lookups = rows.flatMap((row) => row.chainId === null
      ? []
      : [{ chainId: row.chainId, address: row.displayBaseToken }]
    );
    let metadata: Map<string, PoolDiscoveryPool["marketMetadata"]>;
    try {
      metadata = await this.#marketMetadataProvider.load(lookups);
    } catch {
      return rows;
    }
    return rows.map((row) => ({
      ...row,
      marketMetadata: row.chainId === null
        ? null
        : metadata.get(marketMetadataLookupKey(row.chainId, row.displayBaseToken)) ?? null
    }));
  }

  async loadTokenImage(opaqueKey: string): Promise<ProxiedTokenImage | null> {
    try {
      return await this.#marketMetadataProvider?.loadImage(opaqueKey) ?? null;
    } catch {
      return null;
    }
  }

  async queryWalletPositions(args: {
    owner: string;
    first: number;
    after?: string | null;
  }): Promise<Connection<WalletPairPosition>> {
    if (this.#positionSnapshotProvider === null) {
      return this.#readCommitted(() => this.#engine.queryWalletPositions(args));
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = await this.#readCommitted(() => this.#engine.getCanonicalHead());
      if (head === null) return this.#readCommitted(() => this.#engine.queryWalletPositions(args));
      const snapshots = await this.#positionSnapshotProvider.load(args.owner.toLowerCase(), head);
      if (snapshots.some((snapshot) => snapshot.owner.toLowerCase() !== args.owner.toLowerCase())) {
        throw new Error("Position snapshot provider returned a different owner");
      }
      try {
        return await this.#mutations.run(async () => {
          await this.#flushPendingCanonicalCommit();
          this.#engine.augmentHeadPositionSnapshots(head, snapshots);
          await this.#persistHeadUnlocked();
          return this.#engine.queryWalletPositions(args);
        });
      } catch (error) {
        if (error instanceof CanonicalHeadChangedError) continue;
        throw error;
      }
    }
    throw new Error("Canonical head changed repeatedly while loading wallet positions");
  }

  async #readCommitted<T>(read: () => T): Promise<T> {
    return this.#mutations.run(async () => {
      await this.#flushPendingCanonicalCommit();
      return read();
    });
  }

  async #persistUnlocked(): Promise<void> {
    await this.#store?.save(
      this.#engine.exportCheckpoint(),
      this.#engine.listCandles(),
      this.#fullPoolPersistenceChanges()
    );
  }

  async #persistFullStateAndPublish(reorg: boolean): Promise<void> {
    const candles = this.#engine.listCandles();
    const poolStates = this.#engine.listPoolStates();
    const inputs = [
      ...this.#candleChangeInputs(reorg, candles),
      ...(!reorg ? poolStates.map((snapshot) => poolStreamInput(poolSnapshotUpdate(snapshot))) : [])
    ];
    if (this.#store?.saveCanonicalStateAndCandleEvents !== undefined) {
      await this.#stream.publishBatch(inputs, (events) =>
        this.#store!.saveCanonicalStateAndCandleEvents!(
          this.#engine.exportCheckpoint(),
          candles,
          events,
          poolStates.map(fullPoolPersistenceChange)
        )
      );
      this.#applyCandleSnapshot(reorg, candles);
      return;
    }
    await this.#persistUnlocked();
    await this.#publishCandleChanges(
      reorg,
      candles,
      !reorg ? poolStates.map(poolSnapshotUpdate) : []
    );
  }

  async #persistHeadUnlocked(): Promise<void> {
    if (this.#store === null) return;
    const head = this.#engine.getCanonicalHeadEnvelope();
    if (head !== null && this.#store.appendCanonicalState !== undefined) {
      await this.#store.appendCanonicalState(
        this.#engine.exportCheckpointMetadata(),
        head,
        []
      );
      return;
    }
    await this.#persistUnlocked();
  }

  #replaceCandleSnapshot(): void {
    this.#candleSnapshot = new Map(
      this.#engine.listCandles().map((candle) => [candleKey(candle), candleFingerprint(candle)])
    );
  }

  #changedCandles(candles: readonly Candle[]): Candle[] {
    return candles.filter((candle) => this.#candleSnapshot.get(candleKey(candle)) !== candleFingerprint(candle));
  }

  async #flushPendingCanonicalCommit(): Promise<void> {
    const pending = this.#pendingCanonicalCommit;
    if (pending === null) return;
    const candles = pending.result === "reorg"
      ? pending.fullCandles ?? this.#engine.listCandles()
      : pending.changedCandles;
    const poolChanges = pending.result === "reorg"
      ? (pending.fullPoolStates ?? this.#engine.listPoolStates()).map(fullPoolPersistenceChange)
      : pending.changedPoolUpdates.map(poolUpdatePersistenceChange);
    const inputs = [
      ...this.#candleChangeInputs(pending.result === "reorg", candles),
      ...(pending.result === "appended" ? pending.changedPoolUpdates.map(poolStreamInput) : [])
    ];
    if (!pending.canonicalPersisted && pending.result === "appended" &&
      this.#store?.appendCanonicalStateAndCandleEvents !== undefined) {
      await this.#stream.publishBatch(inputs, (events) =>
        this.#store!.appendCanonicalStateAndCandleEvents!(
          this.#engine.exportCheckpointMetadata(),
          pending.block,
          pending.changedCandles,
          events,
          poolChanges
        )
      );
      this.#applyCandleSnapshot(false, pending.changedCandles);
      this.#pendingCanonicalCommit = null;
      return;
    }
    if (!pending.canonicalPersisted && pending.result === "reorg" &&
      this.#store?.saveCanonicalStateAndCandleEvents !== undefined) {
      await this.#stream.publishBatch(inputs, (events) =>
        this.#store!.saveCanonicalStateAndCandleEvents!(
          this.#engine.exportCheckpoint(),
          candles,
          events,
          poolChanges
        )
      );
      this.#applyCandleSnapshot(true, candles);
      this.#pendingCanonicalCommit = null;
      return;
    }
    if (!pending.canonicalPersisted) {
      if (pending.result === "appended" && this.#store?.appendCanonicalState !== undefined) {
        await this.#store.appendCanonicalState(
          this.#engine.exportCheckpointMetadata(),
          pending.block,
          pending.changedCandles,
          poolChanges
        );
      } else {
        await this.#store?.save(
          this.#engine.exportCheckpoint(),
          pending.fullCandles ?? this.#engine.listCandles(),
          poolChanges
        );
      }
      pending.canonicalPersisted = true;
    }
    await this.#publishCandleChanges(
      pending.result === "reorg",
      candles,
      pending.result === "appended" ? pending.changedPoolUpdates : []
    );
    this.#pendingCanonicalCommit = null;
  }

  async #publishCandleChanges(
    reorg: boolean,
    candles = this.#engine.listCandles(),
    poolUpdates: readonly PoolStateUpdate[] = []
  ): Promise<void> {
    const inputs = [
      ...this.#candleChangeInputs(reorg, candles),
      ...(!reorg ? poolUpdates.map(poolStreamInput) : [])
    ];
    if (inputs.length > 0) {
      await this.#stream.publishBatch(inputs, async (events) => {
        await this.#store?.appendCandleEvents?.(events);
      });
    }
    this.#applyCandleSnapshot(reorg, candles);
  }

  #candleChangeInputs(reorg: boolean, candles: readonly Candle[]): CandleStreamEventInput[] {
    const inputs: CandleStreamEventInput[] = reorg
      ? [{ type: "reset", pair: null, interval: null, candle: null, update: null, reason: "canonical-reorg" }]
      : [];
    for (const candle of candles) {
      const key = candleKey(candle);
      const fingerprint = candleFingerprint(candle);
      if (!reorg && this.#candleSnapshot.get(key) === fingerprint) continue;
      if (!reorg) inputs.push({ type: "candle", pair: candle.pair, interval: candle.interval, candle, update: null, reason: null });
    }
    return inputs;
  }

  #applyCandleSnapshot(reorg: boolean, candles: readonly Candle[]): void {
    if (reorg) {
      this.#candleSnapshot = new Map(candles.map((candle) => [candleKey(candle), candleFingerprint(candle)]));
    } else {
      for (const candle of candles) this.#candleSnapshot.set(candleKey(candle), candleFingerprint(candle));
    }
  }

  #fullPoolPersistenceChanges(): PoolStatePersistenceChange[] {
    return this.#engine.listPoolStates().map(fullPoolPersistenceChange);
  }

  async #verifyBlock(submission: BlockSubmission): Promise<BlockEnvelope> {
    const prices: PriceSample[] = [];
    for (const price of submission.prices) {
      if (price.source === "fixed-test") {
        if (!this.#allowFixedTestPrices) throw new Error("fixed-test prices are disabled for this service");
        prices.push({ ...omitSignedReport(price), verifiedBy: "fixed-test" });
        continue;
      }
      if (price.signedReport === null || price.signedReport.trim() === "") {
        throw new Error(`Signed Chainlink report is required for ${price.token}`);
      }
      if (this.#priceVerifier === null) {
        throw new Error("Chainlink price verifier is not configured");
      }
      const verified = await this.#priceVerifier.verify(price, {
        blockNumber: submission.number,
        blockHash: submission.hash,
        blockTimestamp: submission.timestamp
      });
      assertVerifiedPriceMatches(price, verified);
      prices.push(verified);
    }
    return { ...submission, prices };
  }
}

export interface AnalyticsHttpServerOptions {
  service: AnalyticsApiService;
  ingestToken?: string | null;
  corsOrigins?: string[];
  host?: string;
  port?: number;
}

export async function startAnalyticsHttpServer(options: AnalyticsHttpServerOptions): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const corsOrigins = new Set((options.corsOrigins ?? []).map(normalizeCorsOrigin));
  const server = createServer(async (request, response) => {
    try {
      const origin = request.headers.origin;
      const pathname = new URL(request.url ?? "/", "http://analytics.local").pathname;
      const corsRoute = pathname === "/graphql" || pathname === "/events/candles" ||
        pathname === "/events/pools" || pathname.startsWith("/token-images/");
      const corsAllowed = corsRoute && origin !== undefined && corsOrigins.has(origin);
      if (corsAllowed) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        if (!corsAllowed) {
          sendJson(response, 403, { error: "Origin is not allowed" });
          return;
        }
        response.writeHead(204, {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, last-event-id",
          "access-control-max-age": "600",
          "cache-control": "no-store"
        });
        response.end();
        return;
      }
      await routeRequest(request, response, options.service, options.ingestToken ?? null);
    } catch (error) {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Analytics request failed" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function normalizeCorsOrigin(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`CORS origin must not include a path, query, or fragment: ${value}`);
  }
  return url.origin;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: AnalyticsApiService,
  ingestToken: string | null
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://analytics.local");
  if (request.method === "GET" && url.pathname === "/events/candles") {
    await openCandleStream(request, response, service, url);
    return;
  }
  if (request.method === "GET" && url.pathname === "/events/pools") {
    await openPoolStream(request, response, service, url);
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/token-images/") && url.search === "") {
    const opaqueKey = url.pathname.slice("/token-images/".length);
    const image = await service.loadTokenImage(opaqueKey);
    if (image === null) {
      sendJson(response, 404, { error: "Token image is unavailable" });
      return;
    }
    if (request.headers["if-none-match"] === image.etag) {
      response.writeHead(304, {
        etag: image.etag,
        "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "cross-origin",
        "x-content-type-options": "nosniff"
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": image.contentType,
      "content-length": String(image.body.byteLength),
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
      etag: image.etag
    });
    response.end(image.body);
    return;
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(await service.renderCommittedMetrics());
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "POST, stream GET, or metrics GET required" });
    return;
  }

  if (url.pathname === "/graphql") {
    const payload = JSON.parse(await readBody(request)) as { query?: unknown; variables?: unknown };
    if (typeof payload.query !== "string") {
      sendJson(response, 400, { error: "query must be a string" });
      return;
    }
    const result = await service.execute(
      payload.query,
      isRecord(payload.variables) ? payload.variables : undefined
    );
    sendJson(response, result.errors ? 400 : 200, result);
    return;
  }

  if (url.pathname === "/internal/blocks") {
    if (ingestToken === null) {
      sendJson(response, 503, { error: "Block ingestion is disabled until ANALYTICS_INGEST_TOKEN is configured" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${ingestToken}`) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    const block = decodeTaggedJson(await readBody(request)) as BlockSubmission;
    const result = await service.ingestBlock(block);
    sendJson(response, 202, { result });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function openCandleStream(
  request: IncomingMessage,
  response: ServerResponse,
  service: AnalyticsApiService,
  url: URL
): Promise<void> {
  const pair = url.searchParams.get("pair")?.toLowerCase() ?? "";
  const intervalValue = url.searchParams.get("interval") ?? "";
  if (!/^0x[0-9a-f]{40}$/.test(pair)) {
    sendJson(response, 400, { error: "pair must be a canonical EVM address" });
    return;
  }
  let interval: CandleInterval;
  try {
    interval = candleIntervalFromGraphql(intervalValue as GraphqlCandleInterval);
  } catch {
    sendJson(response, 400, { error: "interval is not supported" });
    return;
  }
  await openFilteredStream(request, response, service, url, {
    replay: (after) => service.candleStream.replay(after, pair, interval),
    accepts: (event) => event.type === "reset" ||
      event.type === "candle" && event.pair === pair && event.interval === interval,
    payload: (event) => event.type === "candle" && event.candle !== null
      ? { cursor: event.cursor, candle: mapCandle(event.candle) }
      : { cursor: event.cursor, reason: event.reason ?? "history-reset-required" }
  });
}

async function openPoolStream(
  request: IncomingMessage,
  response: ServerResponse,
  service: AnalyticsApiService,
  url: URL
): Promise<void> {
  const pair = url.searchParams.get("pair")?.toLowerCase() ?? "";
  if (!/^0x[0-9a-f]{40}$/.test(pair)) {
    sendJson(response, 400, { error: "pair must be a canonical EVM address" });
    return;
  }
  await openFilteredStream(request, response, service, url, {
    replay: (after) => service.candleStream.replayPool(after, pair),
    accepts: (event) => event.type === "reset" || event.type === "pool-state" && event.pair === pair,
    payload: (event) => event.type === "pool-state" && event.update !== null && event.update !== undefined
      ? { cursor: event.cursor, update: mapPoolStateUpdate(event.update) }
      : { cursor: event.cursor, reason: event.reason ?? "history-reset-required" }
  });
}

interface FilteredStreamOptions {
  replay(after: string): CandleStreamEvent[] | null;
  accepts(event: CandleStreamEvent): boolean;
  payload(event: CandleStreamEvent): unknown;
}

async function openFilteredStream(
  request: IncomingMessage,
  response: ServerResponse,
  service: AnalyticsApiService,
  url: URL,
  options: FilteredStreamOptions
): Promise<void> {
  const stream = service.candleStream;
  const headerCursor = headerValue(request.headers["last-event-id"]);
  const queryCursor = url.searchParams.get("after");
  const after = headerCursor ?? queryCursor ?? stream.cursor;
  // The query cursor is the normal history-to-live handoff. Only the browser's
  // Last-Event-ID header represents a transport reconnect.
  if (headerCursor !== null) service.recordStreamReconnect();
  const replay = options.replay(after);

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.flushHeaders();

  if (replay === null) {
    service.recordStreamDrop("cursor-invalid-or-expired");
    writeResetAndClose(response, stream.cursor, "stream-cursor-expired");
    return;
  }

  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const close = (dropReason?: string) => {
    if (closed) return;
    closed = true;
    if (dropReason !== undefined) service.recordStreamDrop(dropReason);
    if (heartbeat !== undefined) clearInterval(heartbeat);
    unsubscribe?.();
    if (!response.writableEnded && !response.destroyed) {
      try {
        response.end();
      } catch {
        response.destroy();
      }
    }
  };
  const writeFrame = (frame: string): void => {
    try {
      if (!response.write(frame)) close("backpressure");
    } catch {
      close("transport-error");
    }
  };
  const write = (event: CandleStreamEvent) => {
    if (closed || !options.accepts(event)) return;
    try {
      const payload = JSON.stringify(options.payload(event));
      writeFrame(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${payload}\n\n`);
    } catch {
      close("serialization-error");
    }
  };

  for (const event of replay) write(event);
  if (closed) return;

  try {
    unsubscribe = stream.subscribe(write);
  } catch {
    service.recordStreamDrop("subscriber-limit");
    writeResetAndClose(response, stream.cursor, "subscriber-limit");
    return;
  }

  heartbeat = setInterval(() => {
    if (!closed) {
      writeFrame(`event: heartbeat\ndata: ${JSON.stringify({ cursor: stream.cursor, timestamp: Date.now() })}\n\n`);
    }
  }, STREAM_HEARTBEAT_MS);

  await new Promise<void>((resolve) => {
    const listeners: Array<[IncomingMessage | ServerResponse, "aborted" | "close" | "error"]> = [
      [request, "aborted"],
      [request, "close"],
      [request, "error"],
      [response, "close"],
      [response, "error"]
    ];
    const settle = () => {
      for (const [emitter, event] of listeners) emitter.off(event, settle);
      resolve();
    };
    for (const [emitter, event] of listeners) emitter.once(event, settle);
    if (request.destroyed || request.aborted || response.destroyed || response.writableEnded) settle();
  });
  close();
}

function writeResetAndClose(response: ServerResponse, cursor: string, reason: string): void {
  if (!response.writableEnded && !response.destroyed) {
    try {
      response.write(`id: ${cursor}\nevent: reset\ndata: ${JSON.stringify({ cursor, reason })}\n\n`);
    } catch {
      response.destroy();
    } finally {
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Request body exceeds 5 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(encodeTaggedJson(value));
}

export function encodeTaggedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? { $featherBigInt: item.toString() } : item
  );
}

export function decodeTaggedJson(value: string): unknown {
  return JSON.parse(value, (_key, item: unknown) => {
    if (isRecord(item) && Object.keys(item).length === 1 && typeof item.$featherBigInt === "string") {
      return BigInt(item.$featherBigInt);
    }
    return item;
  });
}

function configureBigIntScalar(schema: GraphQLSchema): void {
  const scalar = schema.getType("BigInt");
  if (!isScalarType(scalar)) throw new Error("Analytics schema is missing BigInt scalar");
  scalar.serialize = (value: unknown) => {
    if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") return String(value);
    throw new Error("BigInt fields must be bigint, number, or decimal string");
  };
}

function mapConnection<T, U>(connection: { nodes: T[]; pageInfo: unknown }, map: (node: T) => U) {
  return { nodes: connection.nodes.map(map), pageInfo: connection.pageInfo };
}

function mapPoolMetrics<T extends { status: string }>(value: T) {
  return { ...value, status: value.status.toUpperCase() };
}

function mapPoolDiscovery(value: PoolDiscoveryPool) {
  return { ...value, status: value.status.toUpperCase() };
}

function mapCandle(value: Candle) {
  return {
    ...value,
    interval: candleIntervalToGraphql(value.interval),
    status: value.status.toUpperCase(),
    openUsdE18: nullableBigIntString(value.openUsdE18),
    highUsdE18: nullableBigIntString(value.highUsdE18),
    lowUsdE18: nullableBigIntString(value.lowUsdE18),
    closeUsdE18: nullableBigIntString(value.closeUsdE18),
    volumeUsdE18: nullableBigIntString(value.volumeUsdE18),
    feesUsdE18: nullableBigIntString(value.feesUsdE18),
    totalSwapFeesUsdE18: nullableBigIntString(value.totalSwapFeesUsdE18),
    protocolSwapFeesUsdE18: nullableBigIntString(value.protocolSwapFeesUsdE18),
    lpNetSwapFeesUsdE18: nullableBigIntString(value.lpNetSwapFeesUsdE18),
    tvlUsdE18: nullableBigIntString(value.tvlUsdE18),
    firstBlock: value.firstBlock.toString(),
    lastBlock: value.lastBlock.toString()
  };
}

function mapPoolStateSnapshot(value: PoolStateSnapshot, streamCursor: string) {
  return {
    state: mapPoolState(value.state),
    bins: value.bins.map(mapPoolBinState),
    streamCursor
  };
}

function mapPoolState(value: PoolState) {
  return {
    ...value,
    reserveX: value.reserveX.toString(),
    reserveY: value.reserveY.toString(),
    marketPriceQuoteE18: value.marketPriceQuoteE18.toString(),
    priceUsdE18: nullableBigIntString(value.priceUsdE18),
    tvlUsdE18: nullableBigIntString(value.tvlUsdE18),
    status: value.status.toUpperCase(),
    feeState: {
      static: {
        baseFactor: value.feeState.static.baseFactor.toString(),
        filterPeriod: value.feeState.static.filterPeriod.toString(),
        decayPeriod: value.feeState.static.decayPeriod.toString(),
        reductionFactor: value.feeState.static.reductionFactor.toString(),
        variableFeeControl: value.feeState.static.variableFeeControl.toString(),
        protocolShare: value.feeState.static.protocolShare.toString(),
        maxVolatilityAccumulator: value.feeState.static.maxVolatilityAccumulator.toString()
      },
      variable: {
        volatilityAccumulator: value.feeState.variable.volatilityAccumulator.toString(),
        volatilityReference: value.feeState.variable.volatilityReference.toString(),
        idReference: value.feeState.variable.idReference.toString(),
        timeOfLastUpdate: value.feeState.variable.timeOfLastUpdate.toString()
      }
    },
    asOfBlock: value.asOfBlock.toString()
  };
}

function mapPoolBinState(value: PoolBinState) {
  return {
    ...value,
    reserveX: value.reserveX.toString(),
    reserveY: value.reserveY.toString(),
    totalSupply: value.totalSupply.toString(),
    updatedAtBlock: value.updatedAtBlock.toString()
  };
}

function mapPoolStateUpdate(value: PoolStateUpdate) {
  return {
    ...value,
    state: mapPoolState(value.state),
    binReplacements: value.binReplacements.map(mapPoolBinState)
  };
}

function mapWalletPosition<T extends { status: string; bins: Array<{ status: string }> }>(value: T) {
  return {
    ...value,
    status: value.status.toUpperCase(),
    bins: value.bins.map((bin) => ({ ...bin, status: bin.status.toUpperCase() }))
  };
}

function mapHealth<T extends { status: string }>(value: T) {
  return { ...value, status: value.status.toUpperCase() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function candleIntervalFromGraphql(interval: GraphqlCandleInterval): CandleInterval {
  switch (interval) {
    case "ONE_MINUTE": return "minute";
    case "FIVE_MINUTES": return "five-minutes";
    case "FIFTEEN_MINUTES": return "fifteen-minutes";
    case "HOUR": return "hour";
    case "FOUR_HOURS": return "four-hours";
    case "DAY": return "day";
    case "WEEK": return "week";
    default: throw new Error(`Unsupported candle interval ${String(interval)}`);
  }
}

function candleIntervalToGraphql(interval: CandleInterval): GraphqlCandleInterval {
  switch (interval) {
    case "minute": return "ONE_MINUTE";
    case "five-minutes": return "FIVE_MINUTES";
    case "fifteen-minutes": return "FIFTEEN_MINUTES";
    case "hour": return "HOUR";
    case "four-hours": return "FOUR_HOURS";
    case "day": return "DAY";
    case "week": return "WEEK";
  }
}

function candleKey(candle: Candle): string {
  return `${candle.pair}:${candle.interval}:${candle.startTimestamp}`;
}

function candleFingerprint(candle: Candle): string {
  return encodeTaggedJson(candle);
}

function poolStreamInput(update: PoolStateUpdate): CandleStreamEventInput {
  return {
    type: "pool-state",
    pair: update.state.pair,
    interval: null,
    candle: null,
    update,
    reason: null
  };
}

function poolUpdatePersistenceChange(update: PoolStateUpdate): PoolStatePersistenceChange {
  return {
    state: update.state,
    bins: update.binReplacements,
    replaceBinWindow: update.replaceBinWindow
  };
}

function fullPoolPersistenceChange(snapshot: PoolStateSnapshot): PoolStatePersistenceChange {
  return { state: snapshot.state, bins: snapshot.bins, replaceBinWindow: true };
}

function poolSnapshotUpdate(snapshot: PoolStateSnapshot): PoolStateUpdate {
  const activeId = BigInt(snapshot.state.activeId);
  const radius = BigInt(POOL_STREAM_RADIUS);
  const minimum = activeId > radius ? activeId - radius : 0n;
  const maximum = activeId + radius > 0xff_ffffn ? 0xff_ffffn : activeId + radius;
  const boundedBins = snapshot.bins.filter((bin) => {
    const binId = BigInt(bin.binId);
    return binId >= minimum && binId <= maximum;
  });
  if (boundedBins.length > POOL_STREAM_RADIUS * 2 + 1) {
    throw new Error("Pool snapshot stream replacement exceeded its bounded window");
  }
  return {
    eventId: `snapshot:${snapshot.state.chainId}:${snapshot.state.pair}:${snapshot.state.asOfBlockHash}:${snapshot.state.revision}`,
    state: snapshot.state,
    binReplacements: boundedBins,
    replaceBinWindow: true,
    sourceEventIds: []
  };
}

function prometheusLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.[0] ?? null;
}

function nullableBigIntString(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function omitSignedReport(submission: PriceSubmission): Omit<PriceSample, "verifiedBy"> {
  const { signedReport: _signedReport, ...sample } = submission;
  return sample;
}

function assertVerifiedPriceMatches(submission: PriceSubmission, verified: PriceSample): void {
  const expected = omitSignedReport(submission);
  const fields: Array<keyof typeof expected> = [
    "token",
    "source",
    "feedId",
    "priceUsdE18",
    "confidenceUsdE18",
    "observedAt",
    "sequence"
  ];
  for (const field of fields) {
    if (verified[field] !== expected[field]) throw new Error(`Verified Chainlink report does not match submitted ${field}`);
  }
  if (verified.verifiedBy.trim() === "") throw new Error("Price verifier returned an empty verification identity");
}

class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
