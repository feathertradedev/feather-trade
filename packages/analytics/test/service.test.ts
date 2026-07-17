import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  AnalyticsApiService,
  AnalyticsEngine,
  CandleStreamHub,
  USD_SCALE,
  startAnalyticsHttpServer,
  type AnalyticsStateStore,
  type BlockSubmission,
  type PoolStateUpdate,
  type PricePolicy
} from "../src/index.js";

const PAIR = "0x00000000000000000000000000000000000000a1";
const TOKEN_X = "0x00000000000000000000000000000000000000b1";
const TOKEN_Y = "0x00000000000000000000000000000000000000c1";
const ACTIVE_ID = 8_388_608;
const policies: PricePolicy[] = [
  { token: TOKEN_X, source: "fixed-test", feedId: "x-usd", maxAgeSeconds: 300, maxConfidenceBps: 100 },
  { token: TOKEN_Y, source: "fixed-test", feedId: "y-usd", maxAgeSeconds: 300, maxConfidenceBps: 100 }
];

test("shares one cursor while bounding candle and pool replay independently", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(verifiedBlock(1, hash(1), hash(0), 60));
  const candle = engine.listCandles().find((row) => row.interval === "minute")!;
  const update = engine.listLastChangedPoolUpdates()[0]!;
  const stream = new CandleStreamHub(2);

  const candleEvent = stream.publishCandle(candle);
  for (let revision = 1; revision <= 10; revision += 1) {
    stream.publishPoolState(withRevision(update, revision));
  }

  assert.deepEqual(
    stream.replay("0", PAIR, "minute")?.map((event) => event.cursor),
    [candleEvent.cursor],
    "pool traffic must not evict the candle topic"
  );
  assert.equal(stream.replayPool("0", PAIR), null, "the independently bounded pool topic expires old cursors");
  assert.deepEqual(stream.replayPool("9", PAIR)?.map((event) => event.cursor), ["10", "11"]);
});

test("bounds replay globally across independently fair topics", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(verifiedBlock(1, hash(1), hash(0), 60));
  const candle = engine.listCandles().find((row) => row.interval === "minute")!;
  const stream = new CandleStreamHub(4, 5);
  const pairs = Array.from({ length: 7 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`);
  const published = pairs.map((pair) => stream.publishCandle({ ...candle, pair }));

  assert.equal(stream.retainedEventCount, 5);
  assert.equal(stream.retainedTopicCount, 5);
  assert.equal(stream.replay("0", pairs.at(-1)!, "minute"), null, "an evicted global cursor must reset every topic safely");
  assert.deepEqual(stream.replay("2", pairs.at(-1)!, "minute")?.map((event) => event.cursor), ["7"]);

  const restored = new CandleStreamHub(4, 5);
  restored.restore(published.slice(-5));
  assert.equal(restored.cursor, "7");
  assert.equal(restored.retainedEventCount, 5);
  assert.equal(restored.replay("0", pairs.at(-1)!, "minute"), null, "restart must preserve the global reset floor");

  const overfullRestore = new CandleStreamHub(10, 5);
  overfullRestore.restore(published.map((event) => ({
    ...event,
    cursor: String(Number(event.cursor) + 2)
  })));
  assert.equal(overfullRestore.retainedEventCount, 5);
  assert.equal(
    overfullRestore.replay("3", `0x${"f".repeat(40)}`, "minute"),
    null,
    "restoring more than the global bound must not lower the eviction floor"
  );
});

test("serves pool bootstrap and replay, closes bad cursors, and exposes stream metrics", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  const first = submission(1, hash(1), hash(0), 60);
  assert.equal(await service.ingestBlock(first), "appended");
  const cursor = service.candleStream.cursor;
  assert.notEqual(cursor, "0");
  assert.equal(await service.ingestBlock(first), "duplicate");
  assert.equal(service.candleStream.cursor, cursor, "duplicate delivery cannot allocate another cursor");

  const query = await service.execute(`query($pair: ID!) {
    poolState(pair: $pair, radius: 1) {
      streamCursor
      state { chainId pair activeId reserveX asOfBlock revision feeState { static { baseFactor } } }
      bins { binId reserveX reserveY revision }
    }
  }`, { pair: PAIR });
  assert.equal(query.errors, undefined);
  const bootstrap = query.data?.poolState as {
    streamCursor: string;
    state: { chainId: number; pair: string; activeId: number; reserveX: string; asOfBlock: string; revision: number };
    bins: Array<{ binId: string; reserveX: string; reserveY: string; revision: number }>;
  };
  assert.equal(bootstrap.streamCursor, cursor);
  assert.equal(bootstrap.state.chainId, 31_337);
  assert.equal(bootstrap.state.pair, PAIR);
  assert.equal(bootstrap.state.activeId, ACTIVE_ID);
  assert.deepEqual(bootstrap.bins.map((bin) => bin.binId), [String(ACTIVE_ID - 1), String(ACTIVE_ID), String(ACTIVE_ID + 1)]);

  const server = await startAnalyticsHttpServer({ service, host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const replay = await firstSseEvent(`${base}/events/pools?pair=${PAIR}&after=0`, "pool-state");
    assert.equal(replay.event, "pool-state");
    assert.equal((replay.data.update as { state: { pair: string } }).state.pair, PAIR);

    const invalid = await fetch(`${base}/events/pools?pair=${PAIR}`, {
      headers: { "last-event-id": String(Number(cursor) + 10) }
    });
    assert.equal(invalid.status, 200);
    const invalidBody = await invalid.text();
    assert.equal((invalidBody.match(/event: reset/g) ?? []).length, 1);
    assert.match(invalidBody, /stream-cursor-expired/);
    assert.equal(service.candleStream.subscriberCount, 0, "invalid cursors never remain subscribed");

    const slowResponse = await fetch(`${base}/events/pools?pair=${PAIR}&after=${service.candleStream.cursor}`);
    assert.equal(slowResponse.status, 200);
    await waitFor(() => service.candleStream.subscriberCount === 1);
    const baseUpdate = service.candleStream.replayPool("0", PAIR)
      ?.find((event) => event.type === "pool-state")?.update;
    assert(baseUpdate);
    for (let revision = 10; revision < 2_010; revision += 1) {
      service.candleStream.publishPoolState(withRevision(baseUpdate, revision));
    }
    await waitFor(() => service.candleStream.subscriberCount === 0);
    await slowResponse.body?.cancel();

    const metrics = await (await fetch(`${base}/metrics`)).text();
    assert.match(metrics, /feather_analytics_ingest_lag_seconds/);
    assert.match(metrics, /feather_analytics_delivery_lag_seconds/);
    assert.match(metrics, /feather_analytics_stream_reconnects_total 1/);
    assert.match(metrics, /feather_analytics_stream_drops_total\{reason="cursor-invalid-or-expired"\} 1/);
    assert.match(metrics, /feather_analytics_stream_drops_total\{reason="backpressure"\} 1/);
    assert.match(metrics, /feather_analytics_stream_subscribers 0/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("publishes a reset instead of orphaned pool replacements after a reorg", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  await service.ingestBlock(submission(1, hash(1), hash(0), 60));
  const before = service.candleStream.cursor;
  await service.ingestBlock(submission(2, hash(2), hash(1), 120));
  const orphanCursor = service.candleStream.cursor;
  assert.equal(await service.ingestBlock(submission(2, hash(3), hash(1), 121)), "reorg");

  const events = service.candleStream.replayPool(orphanCursor, PAIR);
  assert.deepEqual(events?.map((event) => event.type), ["reset"]);
  assert.equal(events?.[0]?.reason, "canonical-reorg");
  assert(Number(service.candleStream.cursor) > Number(before));
  assert.match(service.renderMetrics(121), /feather_analytics_rebuilds_total 1/);
});

test("rewinds a pure head rollback durably and publishes one reset", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  await service.ingestBlock(submission(1, hash(1), hash(0), 60));
  await service.ingestBlock(submission(2, hash(2), hash(1), 120));
  await service.ingestBlock(submission(3, hash(3), hash(2), 180));
  const orphanCursor = service.candleStream.cursor;

  assert.equal(await service.reconcileCanonicalHead({ number: 2n, hash: hash(2), timestamp: 120 }), "reorg");
  assert.deepEqual(
    service.candleStream.replayPool(orphanCursor, PAIR)?.map((event) => [event.type, event.reason]),
    [["reset", "canonical-reorg"]]
  );
  const result = await service.execute(`query($pair: ID!) {
    poolState(pair: $pair, radius: 2) { streamCursor state { activeId asOfBlock asOfBlockHash } }
  }`, { pair: PAIR });
  assert.equal(result.errors, undefined);
  const snapshot = result.data?.poolState as {
    streamCursor: string;
    state: { activeId: number; asOfBlock: string; asOfBlockHash: string };
  };
  assert.equal(snapshot.streamCursor, service.candleStream.cursor);
  assert.equal(snapshot.state.activeId, ACTIVE_ID + 1);
  assert.equal(snapshot.state.asOfBlock, "2");
  assert.equal(snapshot.state.asOfBlockHash, hash(2));
  assert.match(service.renderMetrics(120), /feather_analytics_rebuilds_total 1/);
});

test("completed source head attestation trims a persisted orphan suffix after restart", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  await service.ingestBlock(submission(1, hash(1), hash(0), 60));
  await service.ingestBlock(submission(2, hash(2), hash(1), 120));
  await service.ingestBlock(submission(3, hash(3), hash(2), 180));
  const orphanCursor = service.candleStream.cursor;

  await service.backfill(async () => ({
    blocks: [submission(1, hash(1), hash(0), 60), submission(2, hash(2), hash(1), 120)],
    canonicalHead: { number: 2n, hash: hash(2), timestamp: 120 },
    nextCursor: "3",
    hasMore: false
  }));
  assert.equal(service.getHealth(120).headBlock, 2n);
  assert.deepEqual(service.candleStream.replayPool(orphanCursor, PAIR)?.map((event) => event.type), ["reset"]);
});

test("pool bootstrap waits for its canonical state and cursor to commit", async () => {
  let entered!: () => void;
  let release!: () => void;
  const persistenceEntered = new Promise<void>((resolve) => { entered = resolve; });
  const persistenceReleased = new Promise<void>((resolve) => { release = resolve; });
  const store: AnalyticsStateStore = {
    load: async () => null,
    save: async () => undefined,
    loadCandleEvents: async () => [],
    appendCanonicalStateAndCandleEvents: async () => {
      entered();
      await persistenceReleased;
    }
  };
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true,
    store
  });
  const ingest = service.ingestBlock(submission(1, hash(1), hash(0), 60));
  await persistenceEntered;

  let querySettled = false;
  const query = service.execute(`query($pair: ID!) {
    poolState(pair: $pair, radius: 1) { streamCursor state { asOfBlock } }
  }`, { pair: PAIR }).finally(() => { querySettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(querySettled, false, "bootstrap cannot observe the engine while persistence is pending");

  release();
  await ingest;
  const result = await query;
  assert.equal(result.errors, undefined);
  const snapshot = result.data?.poolState as { streamCursor: string; state: { asOfBlock: string } };
  assert.equal(snapshot.state.asOfBlock, "1");
  assert.equal(snapshot.streamCursor, service.candleStream.cursor);
  assert.notEqual(snapshot.streamCursor, "0");
});

test("bounds full backfill pool replacements to the active display window", async () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  const service = await AnalyticsApiService.create({ engine, allowFixedTestPrices: true });
  const blocks = Array.from({ length: 120 }, (_, index) => {
    const number = index + 1;
    return submission(number, hash(number), hash(number - 1), number * 60);
  });
  await service.backfill(async () => ({ blocks, nextCursor: "121", hasMore: false }));
  assert((engine.listPoolStates()[0]?.bins.length ?? 0) > 81, "canonical persistence retains the observed bin history");

  const update = service.candleStream.replayPool("0", PAIR)
    ?.find((event) => event.type === "pool-state")?.update;
  assert(update);
  assert.equal(update.replaceBinWindow, true);
  assert(update.binReplacements.length <= 81);
  const minimum = BigInt(update.state.activeId - 40);
  const maximum = BigInt(update.state.activeId + 40);
  assert(update.binReplacements.every((bin) => BigInt(bin.binId) >= minimum && BigInt(bin.binId) <= maximum));
});

function submission(
  number: number,
  blockHash: `0x${string}`,
  parentHash: `0x${string}`,
  timestamp: number
): BlockSubmission {
  const block = verifiedBlock(number, blockHash, parentHash, timestamp);
  return {
    ...block,
    prices: block.prices.map(({ verifiedBy: _verifiedBy, ...price }) => ({
      ...price,
      source: "fixed-test" as const,
      signedReport: null
    }))
  };
}

function verifiedBlock(
  number: number,
  blockHash: `0x${string}`,
  parentHash: `0x${string}`,
  timestamp: number
) {
  const activeId = ACTIVE_ID + number - 1;
  return {
    chainId: 31_337,
    number: BigInt(number),
    hash: blockHash,
    parentHash,
    timestamp,
    prices: [
      fixedPrice(TOKEN_X, "x-usd", 2_000n * USD_SCALE, timestamp, BigInt(number)),
      fixedPrice(TOKEN_Y, "y-usd", USD_SCALE, timestamp, BigInt(number))
    ],
    events: [{
      kind: "pair-snapshot" as const,
      pair: PAIR,
      tokenX: TOKEN_X,
      tokenY: TOKEN_Y,
      decimalsX: 18,
      decimalsY: 6,
      reserveX: 100n * 10n ** 18n,
      reserveY: 200_000n * 10n ** 6n,
      activeId,
      binStep: 10,
      marketPriceQuoteE18: 2_000n * USD_SCALE,
      source: {
        eventId: `snapshot:${number}`,
        transactionHash: null,
        logIndex: null,
        sequence: 0,
        kind: "block-snapshot" as const
      },
      poolState: {
        feeState: {
          static: {
            baseFactor: 25n,
            filterPeriod: 30n,
            decayPeriod: 120n,
            reductionFactor: 5_000n,
            variableFeeControl: 40_000n,
            protocolShare: 1_000n,
            maxVolatilityAccumulator: 350_000n
          },
          variable: {
            volatilityAccumulator: BigInt(number),
            volatilityReference: 0n,
            idReference: BigInt(activeId),
            timeOfLastUpdate: BigInt(timestamp)
          }
        },
        binUpdates: [-1, 0, 1].map((offset) => ({
          binId: String(activeId + offset),
          reserveX: BigInt(10 + offset + number),
          reserveY: BigInt(20 - offset + number),
          totalSupply: 100n
        })),
        sourceEventIds: [`snapshot:${number}`],
        replaceBinWindow: number === 1
      }
    }]
  };
}

function fixedPrice(token: string, feedId: string, priceUsdE18: bigint, observedAt: number, sequence: bigint) {
  return {
    token,
    source: "fixed-test" as const,
    feedId,
    priceUsdE18,
    confidenceUsdE18: 0n,
    observedAt,
    sequence,
    verifiedBy: "service-test"
  };
}

function withRevision(update: PoolStateUpdate, revision: number): PoolStateUpdate {
  return {
    ...structuredClone(update),
    eventId: `${update.eventId}:${revision}`,
    state: { ...structuredClone(update.state), revision }
  };
}

async function firstSseEvent(url: string, eventName: string): Promise<{ event: string; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`SSE stream ended before ${eventName}`);
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (event === eventName && data !== undefined) return { event, data: JSON.parse(data) };
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    controller.abort();
  }
}

function hash(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for service test condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
