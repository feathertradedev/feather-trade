import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  AnalyticsApiService,
  AnalyticsEngine,
  CandleStreamHub,
  USD_SCALE,
  encodeTaggedJson,
  type BlockEnvelope,
  type BlockSubmission,
  type Candle,
  type AnalyticsCheckpoint,
  type AnalyticsCheckpointMetadata,
  type AnalyticsStateStore,
  type CandleStreamEvent,
  type PricePolicy
} from "../src/index.js";

const PAIR = "0x00000000000000000000000000000000000000a1";
const TOKEN_X = "0x00000000000000000000000000000000000000b1";
const TOKEN_Y = "0x00000000000000000000000000000000000000c1";
const UNIT = 10n ** 18n;
const INGEST_BLOCKS = 600;
const SUBSCRIBERS = 500;
const STREAM_EVENTS = 50;

/**
 * These are deliberately release-floor targets rather than workstation
 * benchmarks. The architecture decision records the production SLOs; this
 * executable test prevents obvious O(n²)-per-block regressions and validates
 * the configured subscriber ceiling on ordinary CI hardware.
 */
const TARGETS = {
  canonicalBlocksPerSecond: 50,
  queryP95Ms: 50,
  streamDeliveriesPerSecond: 10_000,
  streamPublishP95Ms: 25,
  averageSerializedCandleBytes: 2_048
} as const;

const policies: PricePolicy[] = [
  { token: TOKEN_X, source: "chainlink-data-streams", feedId: "x-usd", maxAgeSeconds: 86_400, maxConfidenceBps: 100 },
  { token: TOKEN_Y, source: "chainlink-data-streams", feedId: "y-usd", maxAgeSeconds: 86_400, maxConfidenceBps: 100 }
];

test("meets the executable candle ingest, query, storage, and fan-out release floors", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  const ingestStarted = performance.now();
  let parentHash = hash(0);
  for (let index = 1; index <= INGEST_BLOCKS; index += 1) {
    const blockHash = hash(index);
    engine.ingestBlock(block(index, blockHash, parentHash));
    parentHash = blockHash;
  }
  const ingestElapsedMs = performance.now() - ingestStarted;
  const canonicalBlocksPerSecond = INGEST_BLOCKS / (ingestElapsedMs / 1_000);

  const queryLatencies: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    const result = engine.queryCandles({
      pair: PAIR,
      interval: "hour",
      fromTimestamp: 0,
      toTimestamp: 499 * 3_600,
      first: 100
    });
    assert(result.nodes.length > 0);
    queryLatencies.push(performance.now() - started);
  }

  const candles = engine.listCandles();
  const averageSerializedCandleBytes = candles.reduce(
    (bytes, candle) => bytes + Buffer.byteLength(encodeTaggedJson(candle)),
    0
  ) / candles.length;

  const hub = new CandleStreamHub();
  let deliveries = 0;
  const releases = Array.from({ length: SUBSCRIBERS }, () => hub.subscribe(() => {
    deliveries += 1;
  }));
  const sample = candles.find((candle) => candle.interval === "minute")!;
  const publishLatencies: number[] = [];
  const streamStarted = performance.now();
  for (let revision = 1; revision <= STREAM_EVENTS; revision += 1) {
    const started = performance.now();
    hub.publishCandle({ ...sample, revision });
    publishLatencies.push(performance.now() - started);
  }
  const streamElapsedMs = performance.now() - streamStarted;
  for (const release of releases) release();
  const streamDeliveriesPerSecond = deliveries / (streamElapsedMs / 1_000);

  const result = {
    targets: TARGETS,
    observed: {
      averageSerializedCandleBytes: round(averageSerializedCandleBytes),
      canonicalBlocksPerSecond: round(canonicalBlocksPerSecond),
      queryP95Ms: round(percentile(queryLatencies, 0.95)),
      streamDeliveriesPerSecond: round(streamDeliveriesPerSecond),
      streamPublishP95Ms: round(percentile(publishLatencies, 0.95))
    },
    workload: { canonicalBlocks: INGEST_BLOCKS, streamEvents: STREAM_EVENTS, subscribers: SUBSCRIBERS }
  };
  process.stdout.write(`candle-load ${JSON.stringify(result)}\n`);

  assert(canonicalBlocksPerSecond >= TARGETS.canonicalBlocksPerSecond, `ingest throughput ${canonicalBlocksPerSecond.toFixed(1)} blocks/s`);
  assert(percentile(queryLatencies, 0.95) <= TARGETS.queryP95Ms, `query p95 ${percentile(queryLatencies, 0.95).toFixed(2)}ms`);
  assert(streamDeliveriesPerSecond >= TARGETS.streamDeliveriesPerSecond, `stream throughput ${streamDeliveriesPerSecond.toFixed(1)} deliveries/s`);
  assert(percentile(publishLatencies, 0.95) <= TARGETS.streamPublishP95Ms, `publish p95 ${percentile(publishLatencies, 0.95).toFixed(2)}ms`);
  assert(averageSerializedCandleBytes <= TARGETS.averageSerializedCandleBytes, `average candle payload ${averageSerializedCandleBytes.toFixed(1)} bytes`);
  assert.equal(deliveries, SUBSCRIBERS * STREAM_EVENTS);
  assert.equal(hub.subscriberCount, 0);
});

test("normal service ingestion persists one canonical append and only changed candle buckets", async () => {
  const store = new RecordingIncrementalStore();
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies.map((policy) => ({ ...policy, source: "fixed-test" }))),
    store,
    allowFixedTestPrices: true
  });
  let parentHash = hash(0);
  for (let index = 1; index <= 180; index += 1) {
    const blockHash = hash(index);
    await service.ingestBlock(submission(index, blockHash, parentHash));
    parentHash = blockHash;
  }

  assert.equal(store.fullSaveCalls, 0, "canonical appends must not rewrite retained history");
  assert.equal(store.appends.length, 180);
  assert(store.appends.every((append) => append.blockCount === 1));
  assert(store.appends.every((append) => append.changedCandles > 0 && append.changedCandles <= 14));
  assert(store.appends.every((append, index) => append.blockNumber === BigInt(index + 1)));
  assert(store.streamEvents > 0);
});

test("a fail-once canonical append is repaired by duplicate retry before streaming", async () => {
  const store = new FailOnceIncrementalStore();
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies.map((policy) => ({ ...policy, source: "fixed-test" }))),
    store,
    allowFixedTestPrices: true
  });
  const first = submission(1, hash(1), hash(0));

  await assert.rejects(() => service.ingestBlock(first), /injected canonical persistence failure/);
  assert.equal(service.getHealth(60).headBlock, 1n, "engine mutation remains quarantined behind pending persistence");
  assert.equal(store.persistedBlocks.length, 0);
  assert.equal(store.streamEvents, 0);
  assert.equal(service.candleStream.cursor, "0");

  assert.equal(await service.ingestBlock(first), "duplicate");
  assert.deepEqual(store.persistedBlocks, [1n]);
  assert(store.streamEvents > 0);
  assert.notEqual(service.candleStream.cursor, "0");
  const history = await service.execute(`query($pair: ID!) {
    pairCandles(pair: $pair, interval: ONE_MINUTE, fromTimestamp: 0, toTimestamp: 60, first: 100) {
      nodes { startTimestamp revision }
      streamCursor
    }
  }`, { pair: PAIR });
  assert.equal(history.errors, undefined);
  const data = history.data as { pairCandles: { nodes: unknown[]; streamCursor: string } };
  assert.equal(data.pairCandles.nodes.length, 1);
  assert.equal(data.pairCandles.streamCursor, service.candleStream.cursor);
});

test("a fail-once replay-event write emits no live cursor until duplicate retry converges", async () => {
  const store = new FailOnceEventStore();
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies.map((policy) => ({ ...policy, source: "fixed-test" }))),
    store,
    allowFixedTestPrices: true
  });
  const first = submission(1, hash(1), hash(0));

  await assert.rejects(() => service.ingestBlock(first), /injected replay persistence failure/);
  assert.deepEqual(store.persistedBlocks, [1n], "canonical state commits before replay delivery");
  assert.equal(store.streamEvents, 0);
  assert.equal(service.candleStream.cursor, "0", "an unpersisted cursor must never become live");

  assert.equal(await service.ingestBlock(first), "duplicate");
  assert.deepEqual(store.persistedBlocks, [1n], "canonical append is not rewritten during replay repair");
  assert(store.streamEvents > 0);
  assert.equal(service.candleStream.cursor, String(store.streamEvents));
});

test("a pending atomic append is repaired before any later persistence can bypass its outbox", async () => {
  const store = new FailOnceAtomicStore();
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies.map((policy) => ({ ...policy, source: "fixed-test" }))),
    store,
    allowFixedTestPrices: true
  });
  const first = submission(1, hash(1), hash(0));

  await assert.rejects(() => service.ingestBlock(first), /injected atomic persistence failure/);
  assert.equal(store.atomicAttempts, 1);
  assert.equal(store.atomicCommits, 0);
  assert.equal(store.fullSaveCalls, 0);
  assert.equal(service.candleStream.cursor, "0");

  await service.persist();
  assert.equal(store.atomicAttempts, 2, "persist flushes the pending state+outbox transaction first");
  assert.equal(store.atomicCommits, 1);
  assert.equal(store.fullSaveCalls, 1, "the requested checkpoint follows only after atomic repair");
  assert(store.streamEvents > 0);
  assert.notEqual(service.candleStream.cursor, "0");
});

test("backfill finalization uses the atomic full-state and outbox capability", async () => {
  const store = new RecordingAtomicFullStore();
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies.map((policy) => ({ ...policy, source: "fixed-test" }))),
    store,
    allowFixedTestPrices: true
  });
  let fetched = false;

  await service.backfill(async () => {
    if (fetched) return { blocks: [], nextCursor: null, hasMore: false };
    fetched = true;
    return { blocks: [submission(1, hash(1), hash(0))], nextCursor: null, hasMore: false };
  });

  assert.equal(store.atomicFullSaves, 1);
  assert.equal(store.fullSaveCalls, 0, "backfill must not save canonical state separately from its outbox");
  assert(store.streamEvents > 0);
  assert.equal(service.candleStream.cursor, String(store.streamEvents));
});

function block(index: number, blockHash: `0x${string}`, parentHash: `0x${string}`): BlockEnvelope {
  const timestamp = index * 60;
  const priceUsdE18 = BigInt(1_900 + index % 200) * USD_SCALE;
  return {
    number: BigInt(index),
    hash: blockHash,
    parentHash,
    timestamp,
    prices: [
      sample(TOKEN_X, "x-usd", priceUsdE18, timestamp, BigInt(index)),
      sample(TOKEN_Y, "y-usd", USD_SCALE, timestamp, BigInt(index))
    ],
    events: [{
      kind: "swap",
      pair: PAIR,
      tokenX: TOKEN_X,
      tokenY: TOKEN_Y,
      decimalsX: 18,
      decimalsY: 18,
      marketPriceQuoteE18: priceUsdE18,
      activeId: 8_388_608 + index % 5,
      binStep: 10,
      amountInX: UNIT,
      amountInY: 0n,
      feeX: UNIT / 1_000n,
      feeY: 0n,
      protocolFeeX: 0n,
      protocolFeeY: 0n,
      reserveX: 100n * UNIT,
      reserveY: 200_000n * UNIT
    }]
  };
}

function submission(index: number, blockHash: `0x${string}`, parentHash: `0x${string}`): BlockSubmission {
  const canonical = block(index, blockHash, parentHash);
  return {
    ...canonical,
    prices: canonical.prices.map(({ verifiedBy: _verifiedBy, ...sampleValue }) => ({
      ...sampleValue,
      source: "fixed-test" as const,
      signedReport: null
    }))
  };
}

function sample(token: string, feedId: string, priceUsdE18: bigint, observedAt: number, sequence: bigint) {
  return {
    token,
    source: "chainlink-data-streams" as const,
    feedId,
    priceUsdE18,
    confidenceUsdE18: priceUsdE18 / 10_000n,
    observedAt,
    sequence,
    verifiedBy: "load-test"
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * quantile))]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function hash(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

class RecordingIncrementalStore implements AnalyticsStateStore {
  readonly appends: Array<{ blockCount: number; blockNumber: bigint; changedCandles: number }> = [];
  fullSaveCalls = 0;
  streamEvents = 0;

  async load(): Promise<AnalyticsCheckpoint | null> {
    return null;
  }

  async save(_checkpoint: AnalyticsCheckpoint, _candles: readonly Candle[]): Promise<void> {
    this.fullSaveCalls += 1;
  }

  async appendCanonicalState(
    _metadata: AnalyticsCheckpointMetadata,
    blockValue: BlockEnvelope,
    candles: readonly Candle[]
  ): Promise<void> {
    this.appends.push({ blockCount: 1, blockNumber: blockValue.number, changedCandles: candles.length });
  }

  async appendCandleEvents(events: readonly CandleStreamEvent[]): Promise<void> {
    this.streamEvents += events.length;
  }
}

class FailOnceIncrementalStore extends RecordingIncrementalStore {
  readonly persistedBlocks: bigint[] = [];
  #failed = false;

  override async appendCanonicalState(
    metadata: AnalyticsCheckpointMetadata,
    blockValue: BlockEnvelope,
    candles: readonly Candle[]
  ): Promise<void> {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("injected canonical persistence failure");
    }
    await super.appendCanonicalState(metadata, blockValue, candles);
    this.persistedBlocks.push(blockValue.number);
  }
}

class FailOnceEventStore extends RecordingIncrementalStore {
  readonly persistedBlocks: bigint[] = [];
  #failed = false;

  override async appendCanonicalState(
    metadata: AnalyticsCheckpointMetadata,
    blockValue: BlockEnvelope,
    candles: readonly Candle[]
  ): Promise<void> {
    await super.appendCanonicalState(metadata, blockValue, candles);
    this.persistedBlocks.push(blockValue.number);
  }

  override async appendCandleEvents(events: readonly CandleStreamEvent[]): Promise<void> {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("injected replay persistence failure");
    }
    await super.appendCandleEvents(events);
  }
}

class FailOnceAtomicStore extends RecordingIncrementalStore {
  atomicAttempts = 0;
  atomicCommits = 0;

  async appendCanonicalStateAndCandleEvents(
    metadata: AnalyticsCheckpointMetadata,
    blockValue: BlockEnvelope,
    candles: readonly Candle[],
    events: readonly CandleStreamEvent[]
  ): Promise<void> {
    this.atomicAttempts += 1;
    if (this.atomicAttempts === 1) throw new Error("injected atomic persistence failure");
    await super.appendCanonicalState(metadata, blockValue, candles);
    await super.appendCandleEvents(events);
    this.atomicCommits += 1;
  }
}

class RecordingAtomicFullStore extends RecordingIncrementalStore {
  atomicFullSaves = 0;

  async saveCanonicalStateAndCandleEvents(
    _checkpoint: AnalyticsCheckpoint,
    _candles: readonly Candle[],
    events: readonly CandleStreamEvent[]
  ): Promise<void> {
    this.atomicFullSaves += 1;
    await super.appendCandleEvents(events);
  }
}
