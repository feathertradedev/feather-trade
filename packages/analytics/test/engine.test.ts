import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AnalyticsApiService,
  AnalyticsCheckpointStore,
  AnalyticsEngine,
  CANDLE_INTERVALS,
  CandleStreamHub,
  FULL_HISTORY_START_TIMESTAMP,
  candleBoundary,
  runBackfill,
  startAnalyticsHttpServer,
  USD_SCALE,
  type AnalyticsEvent,
  type BlockEnvelope,
  type BlockSubmission,
  type PriceSampleVerifier,
  type PricePolicy,
  type PositionSnapshotEvent,
  type SwapAnalyticsEvent
} from "../src/index.js";

test("serves GraphQL CORS only to exact configured browser origins", async () => {
  const service = await AnalyticsApiService.create({ engine: new AnalyticsEngine(policies) });
  const server = await startAnalyticsHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    corsOrigins: ["https://app.testnet.example.com"]
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/graphql`;
    const allowed = await fetch(endpoint, {
      method: "OPTIONS",
      headers: { origin: "https://app.testnet.example.com", "access-control-request-method": "POST" }
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.testnet.example.com");
    assert.equal(allowed.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");

    const disallowed = await fetch(endpoint, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" }
    });
    assert.equal(disallowed.status, 403);
    assert.equal(disallowed.headers.get("access-control-allow-origin"), null);

    const query = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.testnet.example.com" },
      body: JSON.stringify({ query: "{ analyticsHealth { status } }" })
    });
    assert.equal(query.status, 200);
    assert.equal(query.headers.get("access-control-allow-origin"), "https://app.testnet.example.com");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("GraphQL/SSE emits multiple open 1m revisions then finalizes and opens across the minute boundary", async () => {
  const streamPair = "0x00000000000000000000000000000000000000a1";
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    priceVerifier: testPriceVerifier()
  });
  const server = await startAnalyticsHttpServer({ service, host: "127.0.0.1", port: 0 });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const historyResponse = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "query($pair: ID!) { pairCandles(pair: $pair, interval: ONE_MINUTE, fromTimestamp: 600, toTimestamp: 660, first: 100) { streamCursor nodes { startTimestamp revision } } }",
        variables: { pair: streamPair }
      })
    });
    const history = await historyResponse.json() as { data: { pairCandles: { streamCursor: string; nodes: unknown[] } } };
    assert.equal(history.data.pairCandles.streamCursor, "0");
    assert.deepEqual(history.data.pairCandles.nodes, []);

    await service.ingestBlock(submitBlock(block(1n, "0xb1", "0x00", 610, [{ ...marketSwap(USD_SCALE, UNIT), pair: streamPair }], [
      price(TOKEN_X, "x-usd", USD_SCALE, 610, 1n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 610, 1n)
    ])));
    const first = await nextCandleEvent(base, streamPair, "0");
    assert.equal(first.candle.startTimestamp, 600);
    assert.equal(first.candle.finalized, false);
    assert.equal(first.candle.swapCount, 1);

    await service.ingestBlock(submitBlock(block(2n, "0xb2", "0xb1", 640, [{ ...marketSwap(2n * USD_SCALE, UNIT), pair: streamPair }], [
      price(TOKEN_X, "x-usd", 2n * USD_SCALE, 640, 2n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 640, 2n)
    ])));
    const replacement = await nextCandleEvent(base, streamPair, first.cursor);
    assert.equal(replacement.candle.startTimestamp, first.candle.startTimestamp);
    assert(replacement.candle.revision > first.candle.revision);
    assert.equal(replacement.candle.closeUsdE18, "2000000000000000000");
    assert.equal(replacement.candle.swapCount, 2);

    await service.ingestBlock(submitBlock(block(3n, "0xb3", "0xb2", 665, [{ ...marketSwap(3n * USD_SCALE, UNIT), pair: streamPair }], [
      price(TOKEN_X, "x-usd", 3n * USD_SCALE, 665, 3n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 665, 3n)
    ])));
    const boundaryEvents = await nextCandleEvents(base, streamPair, replacement.cursor, 2);
    assert.deepEqual(boundaryEvents.map((event) => [event.candle.startTimestamp, event.candle.finalized]), [[600, true], [660, false]]);
    assert.deepEqual(boundaryEvents.map((event) => event.candle.swapCount), [2, 1]);

    const replay = await nextCandleEvent(base, streamPair, boundaryEvents[0].cursor, { lastEventId: replacement.cursor });
    assert.equal(replay.cursor, boundaryEvents[0].cursor);

    const canonicalHistory = await service.execute(`query($pair: ID!) {
      pairCandles(pair: $pair, interval: ONE_MINUTE, fromTimestamp: 600, toTimestamp: 660, first: 100) {
        nodes { startTimestamp finalized revision swapCount }
        streamCursor
      }
    }`, { pair: streamPair });
    assert.equal(canonicalHistory.errors, undefined);
    const canonicalData = canonicalHistory.data as {
      pairCandles: { nodes: Array<{ finalized: boolean; revision: number; startTimestamp: number; swapCount: number }>; streamCursor: string };
    };
    assert.deepEqual(
      canonicalData.pairCandles.nodes.map((candle) => [candle.startTimestamp, candle.finalized, candle.swapCount]),
      [[600, true, 2], [660, false, 1]]
    );
    assert.equal(canonicalData.pairCandles.streamCursor, service.candleStream.cursor);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

const PAIR = "0xpair";
const TOKEN_X = "0xtokenx";
const TOKEN_Y = "0xtokeny";
const OWNER = "0xowner";
const UNIT = 10n ** 18n;

const policies: PricePolicy[] = [
  { token: TOKEN_X, source: "chainlink-data-streams", feedId: "x-usd", maxAgeSeconds: 300, maxConfidenceBps: 100 },
  { token: TOKEN_Y, source: "chainlink-data-streams", feedId: "y-usd", maxAgeSeconds: 300, maxConfidenceBps: 100 }
];

test("builds exact 24h USD metrics and bounded OHLC candles", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(
    block(1n, "0x01", "0x00", 3_600, [pairSnapshot(100n * UNIT, 100n * UNIT), swap(10n * UNIT, 0n, 1n * UNIT, 0n)], [
      price(TOKEN_X, "x-usd", 2n * USD_SCALE, 3_600, 1n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 3_600, 1n)
    ])
  );
  engine.ingestBlock(
    block(2n, "0x02", "0x01", 3_900, [pairSnapshot(90n * UNIT, 120n * UNIT)], [
      price(TOKEN_X, "x-usd", 3n * USD_SCALE, 3_900, 2n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 3_900, 2n)
    ])
  );

  const metrics = engine.queryPoolMetrics({ first: 10 }).nodes[0];
  assert.equal(metrics.status, "ready");
  assert.equal(metrics.tvlUsdE18, 390n * USD_SCALE);
  assert.equal(metrics.volume24hUsdE18, 20n * USD_SCALE);
  assert.equal(metrics.fees24hUsdE18, 2n * USD_SCALE);
  assert.equal(metrics.feeToTvlE18, (2n * USD_SCALE * USD_SCALE) / (390n * USD_SCALE));
  assert.equal(metrics.totalSwapFees24hUsdE18, 2n * USD_SCALE);
  assert.equal(metrics.protocolSwapFees24hUsdE18, 0n);
  assert.equal(metrics.lpNetSwapFees24hUsdE18, 2n * USD_SCALE);
  assert.equal(metrics.lpNetSwapFeeToTvlE18, (2n * USD_SCALE * USD_SCALE) / (390n * USD_SCALE));
  assert.equal(metrics.feeBreakdownComplete, true);
  assert.equal(metrics.priceUsdE18, 3n * USD_SCALE);

  const historical = engine.queryPoolMetrics({ first: 10, asOfTimestamp: 3_600 }).nodes[0];
  assert.equal(historical.tvlUsdE18, 300n * USD_SCALE);
  assert.equal(historical.priceUsdE18, 2n * USD_SCALE);
  assert.equal(historical.asOfTimestamp, 3_600);

  const candle = engine.queryCandles({ pair: PAIR, interval: "hour", fromTimestamp: 0, toTimestamp: 10_000, first: 10 }).nodes[0];
  assert.equal(candle.status, "ready");
  assert.equal(candle.openUsdE18, 2n * USD_SCALE);
  assert.equal(candle.highUsdE18, 3n * USD_SCALE);
  assert.equal(candle.lowUsdE18, 2n * USD_SCALE);
  assert.equal(candle.closeUsdE18, 3n * USD_SCALE);
  assert.equal(candle.volumeUsdE18, 20n * USD_SCALE);
  assert.equal(candle.feesUsdE18, 2n * USD_SCALE);
  assert.equal(candle.totalSwapFeesUsdE18, 2n * USD_SCALE);
  assert.equal(candle.protocolSwapFeesUsdE18, 0n);
  assert.equal(candle.lpNetSwapFeesUsdE18, 2n * USD_SCALE);
  assert.equal(candle.feeBreakdownComplete, true);
  assert.equal(candle.swapCount, 1);
});

test("attributes indexed total, protocol, and LP-net swap fees without guessing legacy protocol shares", () => {
  const complete = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  complete.ingestBlock(block(1n, "0xf1", "0x00", 3_600, [{
    ...swap(10n * UNIT, 0n, UNIT, 0n),
    protocolFeeX: UNIT / 4n,
    protocolFeeY: 0n
  }], [
    price(TOKEN_X, "x-usd", 2n * USD_SCALE, 3_600, 1n),
    price(TOKEN_Y, "y-usd", USD_SCALE, 3_600, 1n)
  ]));

  const metrics = complete.queryPoolMetrics({ first: 10 }).nodes[0];
  assert.equal(metrics.totalSwapFees24hUsdE18, 2n * USD_SCALE);
  assert.equal(metrics.protocolSwapFees24hUsdE18, USD_SCALE / 2n);
  assert.equal(metrics.lpNetSwapFees24hUsdE18, 3n * USD_SCALE / 2n);
  assert.equal(metrics.feeBreakdownComplete, true);
  const candle = complete.queryCandles({ pair: PAIR, interval: "hour", fromTimestamp: 3_600, toTimestamp: 3_600, first: 10 }).nodes[0];
  assert.equal(candle.feesUsdE18, candle.totalSwapFeesUsdE18);
  assert.equal(candle.protocolSwapFeesUsdE18, USD_SCALE / 2n);
  assert.equal(candle.lpNetSwapFeesUsdE18, 3n * USD_SCALE / 2n);
  assert.equal(candle.feeBreakdownComplete, true);

  const legacy = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  const { protocolFeeX: _protocolFeeX, protocolFeeY: _protocolFeeY, ...legacySwap } =
    swap(10n * UNIT, 0n, UNIT, 0n) as Extract<AnalyticsEvent, { kind: "swap" }>;
  legacy.ingestBlock(block(1n, "0xf2", "0x00", 3_600, [legacySwap], [
    price(TOKEN_X, "x-usd", 2n * USD_SCALE, 3_600, 1n),
    price(TOKEN_Y, "y-usd", USD_SCALE, 3_600, 1n)
  ]));
  const legacyMetrics = legacy.queryPoolMetrics({ first: 10 }).nodes[0];
  assert.equal(legacyMetrics.fees24hUsdE18, 2n * USD_SCALE);
  assert.equal(legacyMetrics.totalSwapFees24hUsdE18, 2n * USD_SCALE);
  assert.equal(legacyMetrics.protocolSwapFees24hUsdE18, null);
  assert.equal(legacyMetrics.lpNetSwapFees24hUsdE18, null);
  assert.equal(legacyMetrics.lpNetSwapFeeToTvlE18, null);
  assert.equal(legacyMetrics.feeBreakdownComplete, false);
  assert.equal(legacyMetrics.status, "partial");
  const legacyCandle = legacy.queryCandles({ pair: PAIR, interval: "hour", fromTimestamp: 3_600, toTimestamp: 3_600, first: 10 }).nodes[0];
  assert.equal(legacyCandle.totalSwapFeesUsdE18, 2n * USD_SCALE);
  assert.equal(legacyCandle.protocolSwapFeesUsdE18, null);
  assert.equal(legacyCandle.lpNetSwapFeesUsdE18, null);
  assert.equal(legacyCandle.feeBreakdownComplete, false);
  assert.equal(legacyCandle.status, "partial");

  const noSwap = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  noSwap.ingestBlock(block(1n, "0xf3", "0x00", 3_600, [pairSnapshot(UNIT, UNIT)], [
    price(TOKEN_X, "x-usd", USD_SCALE, 3_600, 1n),
    price(TOKEN_Y, "y-usd", USD_SCALE, 3_600, 1n)
  ]));
  const zeroMetrics = noSwap.queryPoolMetrics({ first: 10 }).nodes[0];
  assert.equal(zeroMetrics.totalSwapFees24hUsdE18, 0n);
  assert.equal(zeroMetrics.protocolSwapFees24hUsdE18, 0n);
  assert.equal(zeroMetrics.lpNetSwapFees24hUsdE18, 0n);
  assert.equal(zeroMetrics.feeBreakdownComplete, true);
  const zeroCandle = noSwap.queryCandles({ pair: PAIR, interval: "hour", fromTimestamp: 3_600, toTimestamp: 3_600, first: 10 }).nodes[0];
  assert.equal(zeroCandle.totalSwapFeesUsdE18, 0n);
  assert.equal(zeroCandle.protocolSwapFeesUsdE18, 0n);
  assert.equal(zeroCandle.lpNetSwapFeesUsdE18, 0n);
  assert.equal(zeroCandle.feeBreakdownComplete, true);
});

test("rejects invalid fee attribution at the canonical engine boundary", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  assert.throws(
    () => engine.ingestBlock(block(1n, "0xfa", "0x00", 3_600, [{ ...swap(UNIT, 0n, -1n, 0n) }], [])),
    /non-negative/
  );
  assert.throws(
    () => engine.ingestBlock(block(1n, "0xfb", "0x00", 3_600, [{ ...swap(UNIT, 0n, 1n, 0n), protocolFeeX: 2n }], [])),
    /cannot exceed/
  );
});

test("materializes minute candles, hierarchical rollups, revisions, finalization, and Monday weeks", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  const monday = 4 * 86_400;
  engine.ingestBlock(block(1n, "0x91", "0x00", monday + 10, [marketSwap(2n * USD_SCALE, UNIT)], [
    price(TOKEN_X, "x-usd", 2n * USD_SCALE, monday + 10, 1n),
    price(TOKEN_Y, "y-usd", USD_SCALE, monday + 10, 1n)
  ]));
  engine.ingestBlock(block(2n, "0x92", "0x91", monday + 40, [marketSwap(3n * USD_SCALE, 2n * UNIT)], [
    price(TOKEN_X, "x-usd", 3n * USD_SCALE, monday + 40, 2n),
    price(TOKEN_Y, "y-usd", USD_SCALE, monday + 40, 2n)
  ]));
  engine.ingestBlock(block(3n, "0x93", "0x92", monday + 70, [marketSwap(USD_SCALE, UNIT)], [
    price(TOKEN_X, "x-usd", USD_SCALE, monday + 70, 3n),
    price(TOKEN_Y, "y-usd", USD_SCALE, monday + 70, 3n)
  ]));
  engine.ingestBlock(block(4n, "0x94", "0x93", monday + 121, [], []));

  const minutes = engine.queryCandles({ pair: PAIR, interval: "minute", fromTimestamp: monday, toTimestamp: monday + 120, first: 10 }).nodes;
  assert.equal(minutes.length, 2);
  assert.deepEqual(
    [minutes[0].openUsdE18, minutes[0].highUsdE18, minutes[0].lowUsdE18, minutes[0].closeUsdE18],
    [2n * USD_SCALE, 3n * USD_SCALE, 2n * USD_SCALE, 3n * USD_SCALE]
  );
  assert.equal(minutes[0].swapCount, 2);
  assert.equal(minutes[0].revision, 4);
  assert.equal(minutes[0].finalized, true);
  assert.equal(minutes[0].firstBlockHash, "0x91");
  assert.equal(minutes[0].lastBlockHash, "0x92");
  assert.equal(minutes[1].finalized, true);
  assert.equal(minutes[1].priceSource, "active-bin-quote-usd");
  assert.equal(minutes[1].quoteToken, TOKEN_Y);

  for (const interval of CANDLE_INTERVALS.filter((value) => value !== "minute")) {
    const rows = engine.queryCandles({ pair: PAIR, interval, fromTimestamp: candleBoundary(monday, interval), toTimestamp: monday + 120, first: 10 }).nodes;
    assert.equal(rows.length, 1, `${interval} rollup is present`);
    assert.equal(rows[0].openUsdE18, 2n * USD_SCALE);
    assert.equal(rows[0].highUsdE18, 3n * USD_SCALE);
    assert.equal(rows[0].lowUsdE18, USD_SCALE);
    assert.equal(rows[0].closeUsdE18, USD_SCALE);
    assert.equal(rows[0].swapCount, 3);
  }
  assert.equal(candleBoundary(monday + 6 * 86_400, "week"), monday);
  assert.equal(candleBoundary(monday + 7 * 86_400, "week"), monday + 7 * 86_400);
  assert.throws(
    () => engine.queryCandles({ pair: PAIR, interval: "minute", fromTimestamp: 0, toTimestamp: 500 * 60, first: 100 }),
    /cannot span more than 500/
  );

  assert.equal(engine.ingestBlock(block(3n, "0x95", "0x92", monday + 70, [marketSwap(4n * USD_SCALE, UNIT)], [
    price(TOKEN_X, "x-usd", 4n * USD_SCALE, monday + 70, 3n),
    price(TOKEN_Y, "y-usd", USD_SCALE, monday + 70, 3n)
  ])), "reorg");
  const rebuiltHour = engine.queryCandles({ pair: PAIR, interval: "hour", fromTimestamp: monday, toTimestamp: monday, first: 10 }).nodes[0];
  assert.equal(rebuiltHour.highUsdE18, 4n * USD_SCALE);
  assert.equal(rebuiltHour.closeUsdE18, 4n * USD_SCALE);
  assert.equal(rebuiltHour.lastBlockHash, "0x95");
});

test("replays bounded candle replacements and resets expired stream cursors", () => {
  const stream = new CandleStreamHub(2);
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(block(1n, "0xa1", "0x00", 60, [marketSwap(USD_SCALE, UNIT)], [
    price(TOKEN_X, "x-usd", USD_SCALE, 60, 1n),
    price(TOKEN_Y, "y-usd", USD_SCALE, 60, 1n)
  ]));
  const candle = engine.queryCandles({ pair: PAIR, interval: "minute", fromTimestamp: 60, toTimestamp: 60, first: 1 }).nodes[0];
  const first = stream.publishCandle(candle);
  const second = stream.publishCandle({ ...candle, revision: candle.revision + 1 });
  assert.deepEqual(stream.replay(first.cursor, PAIR, "minute")?.map((event) => event.cursor), [second.cursor]);
  stream.publishReset("canonical-reorg");
  assert.equal(stream.replay("0", PAIR, "minute"), null);
  assert.deepEqual(stream.replay(second.cursor, PAIR, "minute")?.map((event) => event.type), ["reset"]);
});

test("bounds candle stream subscribers and releases capacity on disconnect", () => {
  const stream = new CandleStreamHub();
  const unsubscribes = Array.from({ length: 500 }, () => stream.subscribe(() => undefined));
  assert.equal(stream.subscriberCount, 500);
  assert.throws(() => stream.subscribe(() => undefined), /subscriber limit/);
  unsubscribes[0]!();
  assert.equal(stream.subscriberCount, 499);
  const unsubscribe = stream.subscribe(() => undefined);
  assert.equal(stream.subscriberCount, 500);
  unsubscribe();
  for (const release of unsubscribes.slice(1)) release();
  assert.equal(stream.subscriberCount, 0);
});

test("isolates failed candle subscribers after a durable batch commit", async () => {
  const stream = new CandleStreamHub();
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(block(1n, "0xa2", "0x00", 60, [marketSwap(USD_SCALE, UNIT)], [
    price(TOKEN_X, "x-usd", USD_SCALE, 60, 1n),
    price(TOKEN_Y, "y-usd", USD_SCALE, 60, 1n)
  ]));
  const candle = engine.queryCandles({ pair: PAIR, interval: "minute", fromTimestamp: 60, toTimestamp: 60, first: 1 }).nodes[0];
  stream.subscribe(() => {
    throw new Error("disconnected subscriber");
  });
  const delivered: number[] = [];
  stream.subscribe((event) => delivered.push(event.candle?.revision ?? 0));
  let persisted = 0;

  await stream.publishBatch([
    { type: "candle", pair: PAIR, interval: "minute", candle, reason: null },
    { type: "candle", pair: PAIR, interval: "minute", candle: { ...candle, revision: candle.revision + 1 }, reason: null }
  ], async (events) => {
    persisted = events.length;
  });

  assert.equal(persisted, 2);
  assert.equal(stream.cursor, "2");
  assert.deepEqual(delivered, [candle.revision, candle.revision + 1]);
  assert.equal(stream.subscriberCount, 1, "the failed subscriber is removed without aborting delivery");
});

test("fails USD values partial when pricing is missing, stale, or outside confidence policy", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(
    block(1n, "0x11", "0x00", 1_000, [pairSnapshot(10n * UNIT, 10n * UNIT), swap(0n, UNIT, 0n, UNIT / 100n)], [
      price(TOKEN_X, "x-usd", 2n * USD_SCALE, 1_000, 1n),
      { ...price(TOKEN_Y, "y-usd", USD_SCALE, 1_000, 1n), confidenceUsdE18: USD_SCALE }
    ])
  );

  const metrics = engine.queryPoolMetrics({ first: 10 }).nodes[0];
  assert.equal(metrics.status, "partial");
  assert.equal(metrics.tvlUsdE18, null);
  assert.equal(metrics.volume24hUsdE18, null);
  assert.equal(metrics.fees24hUsdE18, null);
  assert.deepEqual(metrics.missingPriceTokens, [TOKEN_Y]);
  assert.equal(engine.getHealth().status, "partial");

  const staleEngine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  staleEngine.ingestBlock(
    block(1n, "0x12", "0x00", 1_000, [pairSnapshot(UNIT, UNIT)], [
      price(TOKEN_X, "x-usd", USD_SCALE, 1_000, 1n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 1_000, 1n)
    ])
  );
  staleEngine.ingestBlock(block(2n, "0x13", "0x12", 1_301, [pairSnapshot(UNIT, UNIT)]));
  assert.equal(staleEngine.queryPoolMetrics({ first: 10 }).nodes[0].status, "partial");
  assert.deepEqual(staleEngine.queryPoolMetrics({ first: 10 }).nodes[0].missingPriceTokens, [TOKEN_X, TOKEN_Y]);
});

test("revalues inactive pools and positions against head-time freshness", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true, maxPositionSnapshotAgeSeconds: 300 });
  engine.ingestBlock(
    block(
      1n,
      "0x14",
      "0x00",
      1_000,
      [
        pairSnapshot(10n * UNIT, 10n * UNIT),
        liquidity("deposit", [{ binId: "1", liquidityDelta: 1n, amountX: UNIT, amountY: 0n }]),
        { ...identity(), kind: "position-snapshot", owner: OWNER, bins: [{ binId: "1", liquidity: 1n, amountX: UNIT, amountY: 0n }] }
      ],
      [price(TOKEN_X, "x-usd", USD_SCALE, 1_000, 1n), price(TOKEN_Y, "y-usd", USD_SCALE, 1_000, 1n)]
    )
  );
  engine.ingestBlock(block(2n, "0x15", "0x14", 1_001, [swap(UNIT, 0n, 0n, 0n)]));

  const freshPool = engine.queryPoolMetrics({ first: 10 }).nodes[0];
  assert.equal(freshPool.status, "ready");
  const position = engine.queryWalletPositions({ owner: OWNER, first: 10 }).nodes[0];
  assert.equal(position.status, "partial");
  assert.equal(position.currentValueUsdE18, null);
  assert.equal(position.asOfBlock, 1n);
  assert.equal(position.asOfTimestamp, 1_000);

  engine.ingestBlock(block(3n, "0x16", "0x15", 1_301, []));

  const metrics = engine.queryPoolMetrics({ first: 10 }).nodes[0];
  assert.equal(metrics.status, "partial");
  assert.equal(metrics.tvlUsdE18, null);
  assert.equal(metrics.priceUsdE18, null);
  const health = engine.getHealth(1_301);
  assert.equal(health.status, "partial");
  assert.equal(health.fresh, true);
  assert.equal(health.backfillStatus, "complete");
  assert.deepEqual(health.prices.map((entry) => entry.status), ["stale", "stale"]);
});

test("rolls back orphaned aggregates and position state on a reorg", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(
    block(1n, "0x21", "0x00", 1_000, [pairSnapshot(100n * UNIT, 100n * UNIT)], [
      price(TOKEN_X, "x-usd", 2n * USD_SCALE, 1_000, 1n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 1_000, 1n)
    ])
  );
  engine.ingestBlock(
    block(2n, "0x22", "0x21", 1_010, [
      swap(10n * UNIT, 0n, 0n, 0n),
      liquidity("deposit", [{ binId: "1", liquidityDelta: 1n, amountX: UNIT, amountY: 0n }])
    ])
  );
  assert.equal(engine.queryPoolMetrics({ first: 10 }).nodes[0].volume24hUsdE18, 20n * USD_SCALE);
  assert.equal(engine.queryWalletPositions({ owner: OWNER, first: 10 }).nodes.length, 1);

  assert.equal(engine.ingestBlock(block(2n, "0x23", "0x21", 1_011, [swap(2n * UNIT, 0n, 0n, 0n)])), "reorg");
  assert.equal(engine.queryPoolMetrics({ first: 10 }).nodes[0].volume24hUsdE18, 4n * USD_SCALE);
  assert.equal(engine.queryWalletPositions({ owner: OWNER, first: 10 }).nodes.length, 0);
  assert.equal(engine.getHealth().reorgCount, 1);
  assert.equal(engine.getHealth().headHash, "0x23");
});

test("groups per-bin balances and computes proportional realized and unrealized P&L", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(
    block(
      1n,
      "0x31",
      "0x00",
      2_000,
      [
        liquidity("deposit", [{ binId: "1", liquidityDelta: 10n, amountX: 100n * UNIT, amountY: 0n }]),
        liquidity("withdraw", [{ binId: "1", liquidityDelta: -4n, amountX: 50n * UNIT, amountY: 0n }]),
        {
          ...identity(),
          kind: "position-snapshot",
          owner: OWNER,
          bins: [{ binId: "1", liquidity: 6n, amountX: 90n * UNIT, amountY: 0n }]
        }
      ],
      [price(TOKEN_X, "x-usd", USD_SCALE, 2_000, 1n), price(TOKEN_Y, "y-usd", USD_SCALE, 2_000, 1n)]
    )
  );

  const position = engine.queryWalletPositions({ owner: OWNER, first: 10 }).nodes[0];
  assert.equal(position.status, "ready");
  assert.equal(position.bins.length, 1);
  assert.equal(position.bins[0].liquidity, 6n);
  assert.equal(position.costBasisUsdE18, 60n * USD_SCALE);
  assert.equal(position.currentValueUsdE18, 90n * USD_SCALE);
  assert.equal(position.realizedPnlUsdE18, 10n * USD_SCALE);
  assert.equal(position.unrealizedPnlUsdE18, 30n * USD_SCALE);
});

test("marks snapshot-only cost basis partial and carries basis across ERC-1155 transfers", () => {
  const snapshotOnly = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  snapshotOnly.ingestBlock(
    block(
      1n,
      "0x32",
      "0x00",
      2_000,
      [{ ...identity(), kind: "position-snapshot", owner: OWNER, bins: [{ binId: "1", liquidity: 2n, amountX: 10n * UNIT, amountY: 0n }] }],
      [price(TOKEN_X, "x-usd", USD_SCALE, 2_000, 1n), price(TOKEN_Y, "y-usd", USD_SCALE, 2_000, 1n)]
    )
  );
  const incomplete = snapshotOnly.queryWalletPositions({ owner: OWNER, first: 10 }).nodes[0];
  assert.equal(incomplete.status, "partial");
  assert.equal(incomplete.costBasisUsdE18, null);
  assert.equal(incomplete.currentValueUsdE18, 10n * USD_SCALE);
  assert.equal(snapshotOnly.getHealth().status, "partial");

  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  const recipient = "0xrecipient";
  engine.ingestBlock(
    block(
      1n,
      "0x33",
      "0x00",
      2_000,
      [
        liquidity("deposit", [{ binId: "1", liquidityDelta: 10n, amountX: 100n * UNIT, amountY: 0n }]),
        { ...identity(), kind: "position-transfer", from: OWNER, to: recipient, bins: [{ binId: "1", liquidity: 4n }] },
        { ...identity(), kind: "position-snapshot", owner: OWNER, bins: [{ binId: "1", liquidity: 6n, amountX: 60n * UNIT, amountY: 0n }] },
        { ...identity(), kind: "position-snapshot", owner: recipient, bins: [{ binId: "1", liquidity: 4n, amountX: 40n * UNIT, amountY: 0n }] }
      ],
      [price(TOKEN_X, "x-usd", USD_SCALE, 2_000, 1n), price(TOKEN_Y, "y-usd", USD_SCALE, 2_000, 1n)]
    )
  );
  assert.equal(engine.queryWalletPositions({ owner: OWNER, first: 10 }).nodes[0].costBasisUsdE18, 60n * USD_SCALE);
  assert.equal(engine.queryWalletPositions({ owner: recipient, first: 10 }).nodes[0].costBasisUsdE18, 40n * USD_SCALE);
});

test("keeps unknown closed-position P&L visible after withdrawal pricing loss", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(
    block(1n, "0x34", "0x00", 1_000, [
      liquidity("deposit", [{ binId: "1", liquidityDelta: 10n, amountX: 100n * UNIT, amountY: 0n }])
    ], [price(TOKEN_X, "x-usd", USD_SCALE, 1_000, 1n), price(TOKEN_Y, "y-usd", USD_SCALE, 1_000, 1n)])
  );
  engine.ingestBlock(
    block(2n, "0x35", "0x34", 1_301, [
      liquidity("withdraw", [{ binId: "1", liquidityDelta: -10n, amountX: 120n * UNIT, amountY: 0n }])
    ])
  );

  const position = engine.queryWalletPositions({ owner: OWNER, first: 10 }).nodes[0];
  assert.equal(position.status, "partial");
  assert.equal(position.bins.length, 1);
  assert.equal(position.bins[0].liquidity, 0n);
  assert.equal(position.bins[0].realizedPnlUsdE18, null);
  assert.deepEqual(position.missingPriceTokens, [TOKEN_X]);
});

test("invalidates basis when live snapshots reveal added or omitted liquidity", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(
    block(
      1n,
      "0x36",
      "0x00",
      2_000,
      [
        liquidity("deposit", [
          { binId: "1", liquidityDelta: 1n, amountX: 10n * UNIT, amountY: 0n },
          { binId: "2", liquidityDelta: 1n, amountX: 20n * UNIT, amountY: 0n }
        ]),
        { ...identity(), kind: "position-snapshot", owner: OWNER, bins: [{ binId: "1", liquidity: 2n, amountX: 20n * UNIT, amountY: 0n }] }
      ],
      [price(TOKEN_X, "x-usd", USD_SCALE, 2_000, 1n), price(TOKEN_Y, "y-usd", USD_SCALE, 2_000, 1n)]
    )
  );

  const position = engine.queryWalletPositions({ owner: OWNER, first: 10 }).nodes[0];
  assert.equal(position.status, "partial");
  assert.equal(position.bins.length, 2);
  assert.equal(position.bins.find((bin) => bin.binId === "1")?.costBasisUsdE18, null);
  assert.equal(position.bins.find((bin) => bin.binId === "2")?.costBasisUsdE18, null);
  assert.equal(engine.getHealth(2_000).partialEventCount, 1);
});

test("preserves known swap fields when independent TVL pricing is unavailable", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(
    block(1n, "0x37", "0x00", 2_000, [swap(2n * UNIT, 0n, UNIT / 100n, 0n)], [
      price(TOKEN_X, "x-usd", 2n * USD_SCALE, 2_000, 1n)
    ])
  );
  const metrics = engine.queryPoolMetrics({ first: 10 }).nodes[0];
  assert.equal(metrics.status, "partial");
  assert.equal(metrics.tvlUsdE18, null);
  assert.equal(metrics.volume24hUsdE18, 4n * USD_SCALE);
  assert.equal(metrics.fees24hUsdE18, 20n * 10n ** 15n);
  const candle = engine.queryCandles({ pair: PAIR, interval: "hour", fromTimestamp: 0, toTimestamp: 3_000, first: 10 }).nodes[0];
  assert.equal(candle.status, "partial");
  assert.equal(candle.volumeUsdE18, 4n * USD_SCALE);
  assert.equal(candle.feesUsdE18, 20n * 10n ** 15n);
});

test("uses stable cursors and enforces the 100-row query limit", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  const events = Array.from({ length: 101 }, (_, index) => ({
    ...pairSnapshot(UNIT, UNIT),
    pair: `0xpair${index.toString().padStart(3, "0")}`
  }));
  engine.ingestBlock(
    block(1n, "0x41", "0x00", 3_000, events, [
      price(TOKEN_X, "x-usd", USD_SCALE, 3_000, 1n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 3_000, 1n)
    ])
  );

  const first = engine.queryPoolMetrics({ first: 100 });
  assert.equal(first.nodes.length, 100);
  assert.equal(first.pageInfo.hasNextPage, true);
  const second = engine.queryPoolMetrics({ first: 100, after: first.pageInfo.endCursor });
  assert.equal(second.nodes.length, 1);
  assert.equal(second.pageInfo.hasNextPage, false);
  assert.throws(() => engine.queryPoolMetrics({ first: 101 }), /between 1 and 100/);

  engine.ingestBlock(
    block(2n, "0x42", "0x41", 3_001, [{ ...pairSnapshot(UNIT, UNIT), pair: "0x000" }], [
      price(TOKEN_X, "x-usd", USD_SCALE, 3_001, 2n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 3_001, 2n)
    ])
  );
  assert.throws(
    () => engine.queryPoolMetrics({ first: 100, after: first.pageInfo.endCursor }),
    /Cursor expired or invalid/
  );
});

test("reports partial and capped backfills with resumable cursors", async () => {
  const partialEngine = new AnalyticsEngine(policies);
  const partial = await runBackfill({
    engine: partialEngine,
    fetchPage: async (cursor) => {
      if (cursor === null) {
        return {
          blocks: [
            block(1n, "0x51", "0x00", 1_000, [pairSnapshot(UNIT, UNIT)], [
              price(TOKEN_X, "x-usd", USD_SCALE, 1_000, 1n),
              price(TOKEN_Y, "y-usd", USD_SCALE, 1_000, 1n)
            ])
          ],
          nextCursor: "page-2",
          hasMore: true
        };
      }
      throw new Error("archive timeout");
    }
  });
  assert.deepEqual(partial, {
    status: "partial",
    pagesLoaded: 1,
    blocksLoaded: 1,
    cursor: "page-2",
    error: "archive timeout"
  });
  assert.equal(partialEngine.getHealth(1_000).backfillStatus, "partial");
  const incompleteMetrics = partialEngine.queryPoolMetrics({ first: 10 }).nodes[0];
  assert.equal(incompleteMetrics.status, "partial");
  assert.equal(incompleteMetrics.volume24hUsdE18, null);
  assert.equal(incompleteMetrics.fees24hUsdE18, null);

  const cappedEngine = new AnalyticsEngine(policies);
  const capped = await runBackfill({
    engine: cappedEngine,
    maxPages: 1,
    fetchPage: async () => ({ blocks: [block(1n, "0x61", "0x00", 1, [])], nextCursor: "page-2", hasMore: true })
  });
  assert.equal(capped.status, "capped");
  assert.equal(capped.cursor, "page-2");
  assert.equal(cappedEngine.getHealth(1).backfillStatus, "capped");

  const malformedEngine = new AnalyticsEngine(policies);
  await assert.rejects(
    () =>
      runBackfill({
        engine: malformedEngine,
        fetchPage: async () => ({ blocks: [], nextCursor: "stuck", hasMore: true })
      }),
    /cannot be empty/
  );
  assert.equal(malformedEngine.getHealth(1).backfillStatus, "partial");
  assert.match(malformedEngine.getHealth(1).backfillError ?? "", /cannot be empty/);

  const invalidBlockEngine = new AnalyticsEngine(policies);
  let pageNumber = 0;
  const invalidBlock = await runBackfill({
    engine: invalidBlockEngine,
    fetchPage: async () => {
      pageNumber += 1;
      return pageNumber === 1
        ? { blocks: [block(1n, "0x62", "0x00", 1, [])], nextCursor: "page-2", hasMore: true }
        : { blocks: [block(3n, "0x63", "0xdead", 2, [])], nextCursor: "page-3", hasMore: true };
    }
  });
  assert.equal(invalidBlock.status, "partial");
  assert.equal(invalidBlock.cursor, "page-2");
  assert.match(invalidBlock.error ?? "", /outside retained canonical history/);
  assert.equal(invalidBlockEngine.getHealth(2).backfillStatus, "partial");

  const missingCoverageEngine = new AnalyticsEngine(policies);
  await assert.rejects(
    () =>
      runBackfill({
        engine: missingCoverageEngine,
        startCursor: "resume",
        fetchPage: async () => ({ blocks: [], nextCursor: null, hasMore: false })
      }),
    /without prior coverage/
  );

  const resumedEngine = new AnalyticsEngine(policies);
  resumedEngine.updateBackfillState({
    status: "partial",
    cursor: "resume",
    error: "temporary",
    coverageStartTimestamp: FULL_HISTORY_START_TIMESTAMP,
    coverageThroughTimestamp: 100
  });
  const resumed = await runBackfill({
    engine: resumedEngine,
    startCursor: "resume",
    fetchPage: async () => ({ blocks: [], nextCursor: "done", hasMore: false })
  });
  assert.equal(resumed.status, "complete");
  assert.equal(resumedEngine.exportCheckpoint().backfill.coverageThroughTimestamp, 100);
});

test("serves and restores the bounded GraphQL query surface", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feather-analytics-"));
  try {
    const store = new AnalyticsCheckpointStore(join(directory, "checkpoint.json"));
    const verifier = testPriceVerifier();
    const positionSnapshotProvider = {
      load: async (owner: string, head: { number: bigint }) => [
        {
          ...identity(),
          kind: "position-snapshot" as const,
          owner,
          bins: [{ binId: "1", liquidity: 1n, amountX: 11n * UNIT, amountY: 0n }]
        }
      ]
    };
    const engine = new AnalyticsEngine(policies);
    const service = await AnalyticsApiService.create({ engine, store, priceVerifier: verifier, positionSnapshotProvider });
    const firstBlock = block(1n, "0x71", "0x00", 4_000, [
      pairSnapshot(2n * UNIT, 3n * UNIT),
      swap(UNIT, 0n, UNIT / 100n, 0n),
      liquidity("deposit", [{ binId: "1", liquidityDelta: 1n, amountX: 10n * UNIT, amountY: 0n }]),
      { ...identity(), kind: "position-snapshot", owner: OWNER, bins: [{ binId: "1", liquidity: 1n, amountX: 10n * UNIT, amountY: 0n }] }
    ], [
        price(TOKEN_X, "x-usd", 2n * USD_SCALE, 4_000, 1n),
        price(TOKEN_Y, "y-usd", USD_SCALE, 4_000, 1n)
      ]);
    await assert.rejects(() => service.ingestBlock(submitBlock(firstBlock, "forged")), /forged report/);
    const backfill = await service.backfill(async () => ({
      blocks: [submitBlock(firstBlock)],
      nextCursor: "complete",
      hasMore: false
    }));
    assert.equal(backfill.status, "complete");
    await service.ingestBlock(submitBlock(block(2n, "0x72", "0x71", 4_001, [], [
      price(TOKEN_X, "x-usd", 2n * USD_SCALE, 4_001, 2n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 4_001, 2n)
    ])));
    await service.ingestBlock(submitBlock(block(2n, "0x73", "0x71", 4_002, [], [
      price(TOKEN_X, "x-usd", 2n * USD_SCALE, 4_002, 2n),
      price(TOKEN_Y, "y-usd", USD_SCALE, 4_002, 2n)
    ])));
    assert.equal(service.getHealth(4_002).reorgCount, 1);
    const livePosition = (await service.queryWalletPositions({ owner: OWNER, first: 10 })).nodes[0];
    assert.equal(livePosition.status, "ready");
    assert.equal(livePosition.currentValueUsdE18, 22n * USD_SCALE);
    assert.equal(livePosition.asOfBlock, 2n);

    const query = `query Metrics($first: Int!) {
      poolMetrics(first: $first) {
        nodes {
          pair tvlUsdE18 volume24hUsdE18 fees24hUsdE18
          totalSwapFees24hUsdE18 protocolSwapFees24hUsdE18 lpNetSwapFees24hUsdE18
          lpNetSwapFeeToTvlE18 feeBreakdownComplete status
        }
        pageInfo { hasNextPage partial }
      }
    }`;
    const first = await service.execute(query, { first: 10 });
    assert.equal(first.errors, undefined);
    const firstData = JSON.parse(JSON.stringify(first.data)) as Record<string, unknown>;
    assert.deepEqual(firstData.poolMetrics, {
      nodes: [
        {
          pair: PAIR,
          tvlUsdE18: "300000000000000000000",
          volume24hUsdE18: "2000000000000000000",
          fees24hUsdE18: "20000000000000000",
          totalSwapFees24hUsdE18: "20000000000000000",
          protocolSwapFees24hUsdE18: "0",
          lpNetSwapFees24hUsdE18: "20000000000000000",
          lpNetSwapFeeToTvlE18: "66666666666666",
          feeBreakdownComplete: true,
          status: "READY"
        }
      ],
      pageInfo: { hasNextPage: false, partial: false }
    });

    const restored = await AnalyticsApiService.create({
      engine: new AnalyticsEngine(policies),
      store,
      priceVerifier: verifier,
      positionSnapshotProvider
    });
    const second = await restored.execute(query, { first: 10 });
    assert.deepEqual(JSON.parse(JSON.stringify(second.data)), firstData);
    assert.equal(restored.getHealth(4_002).reorgCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries deferred position snapshots at the new head and serializes checkpoint writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feather-analytics-race-"));
  try {
    const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
    engine.ingestBlock(
      block(
        1n,
        "0x81",
        "0x00",
        5_000,
        [
          liquidity("deposit", [{ binId: "1", liquidityDelta: 1n, amountX: 10n * UNIT, amountY: 0n }]),
          { ...identity(), kind: "position-snapshot", owner: OWNER, bins: [{ binId: "1", liquidity: 1n, amountX: 10n * UNIT, amountY: 0n }] }
        ],
        [price(TOKEN_X, "x-usd", 2n * USD_SCALE, 5_000, 1n), price(TOKEN_Y, "y-usd", USD_SCALE, 5_000, 1n)]
      )
    );

    let resolveFirst!: (snapshots: PositionSnapshotEvent[]) => void;
    const requestedHeads: bigint[] = [];
    const positionSnapshotProvider = {
      load: async (_owner: string, head: { number: bigint }) => {
        requestedHeads.push(head.number);
        if (head.number === 1n) {
          return new Promise<PositionSnapshotEvent[]>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return [
          {
            ...identity(),
            kind: "position-snapshot" as const,
            owner: OWNER,
            bins: [{ binId: "1", liquidity: 1n, amountX: 12n * UNIT, amountY: 0n }]
          }
        ];
      }
    };
    const store = new AnalyticsCheckpointStore(join(directory, "checkpoint.json"));
    const verifier = testPriceVerifier();
    const service = await AnalyticsApiService.create({ engine, store, priceVerifier: verifier, positionSnapshotProvider });

    const pendingQuery = service.queryWalletPositions({ owner: OWNER, first: 10 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await service.ingestBlock(
      submitBlock(
        block(2n, "0x82", "0x81", 5_001, [], [
          price(TOKEN_X, "x-usd", 2n * USD_SCALE, 5_001, 2n),
          price(TOKEN_Y, "y-usd", USD_SCALE, 5_001, 2n)
        ])
      )
    );
    resolveFirst([
      {
        ...identity(),
        kind: "position-snapshot",
        owner: OWNER,
        bins: [{ binId: "1", liquidity: 1n, amountX: 11n * UNIT, amountY: 0n }]
      }
    ]);

    const result = await pendingQuery;
    assert.deepEqual(requestedHeads, [1n, 2n]);
    assert.equal(result.nodes[0].asOfBlock, 2n);
    assert.equal(result.nodes[0].currentValueUsdE18, 24n * USD_SCALE);

    const restored = await AnalyticsApiService.create({ engine: new AnalyticsEngine(policies), store, priceVerifier: verifier });
    const restoredPosition = (await restored.queryWalletPositions({ owner: OWNER, first: 10 })).nodes[0];
    assert.equal(restored.getHealth(5_001).headBlock, 2n);
    assert.equal(restoredPosition.asOfBlock, 2n);
    assert.equal(restoredPosition.currentValueUsdE18, 24n * USD_SCALE);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function identity() {
  return { pair: PAIR, tokenX: TOKEN_X, tokenY: TOKEN_Y, decimalsX: 18, decimalsY: 18 } as const;
}

function pairSnapshot(reserveX: bigint, reserveY: bigint): AnalyticsEvent {
  return { ...identity(), kind: "pair-snapshot", reserveX, reserveY };
}

function swap(amountInX: bigint, amountInY: bigint, feeX: bigint, feeY: bigint): SwapAnalyticsEvent {
  return { ...identity(), kind: "swap", amountInX, amountInY, feeX, feeY, protocolFeeX: 0n, protocolFeeY: 0n, reserveX: 100n * UNIT, reserveY: 100n * UNIT };
}

function marketSwap(marketPriceQuoteE18: bigint, amountInX: bigint): SwapAnalyticsEvent {
  return {
    ...identity(),
    kind: "swap",
    amountInX,
    amountInY: 0n,
    feeX: amountInX / 100n,
    feeY: 0n,
    protocolFeeX: 0n,
    protocolFeeY: 0n,
    reserveX: 100n * UNIT,
    reserveY: 100n * UNIT,
    marketPriceQuoteE18,
    activeId: 8_388_608,
    binStep: 10
  };
}

function liquidity(kind: "deposit" | "withdraw", bins: Array<{ binId: string; liquidityDelta: bigint; amountX: bigint; amountY: bigint }>): AnalyticsEvent {
  return { ...identity(), kind, owner: OWNER, bins, reserveX: 100n * UNIT, reserveY: 100n * UNIT };
}

function price(token: string, feedId: string, priceUsdE18: bigint, observedAt: number, sequence: bigint) {
  return {
    token,
    source: "chainlink-data-streams" as const,
    feedId,
    priceUsdE18,
    confidenceUsdE18: priceUsdE18 / 1_000n,
    observedAt,
    sequence,
    verifiedBy: "test-verifier"
  };
}

function block(
  number: bigint,
  hash: `0x${string}`,
  parentHash: `0x${string}`,
  timestamp: number,
  events: AnalyticsEvent[],
  prices: BlockEnvelope["prices"] = []
): BlockEnvelope {
  return { number, hash, parentHash, timestamp, events, prices };
}

function submitBlock(blockValue: BlockEnvelope, signedReport = "valid-report"): BlockSubmission {
  return {
    ...blockValue,
    prices: blockValue.prices.map(({ verifiedBy: _verifiedBy, ...sample }) => ({ ...sample, signedReport }))
  };
}

function testPriceVerifier(): PriceSampleVerifier {
  return {
    verify: async (submission) => {
      if (submission.signedReport !== "valid-report") throw new Error("forged report");
      const { signedReport: _signedReport, ...sample } = submission;
      return { ...sample, verifiedBy: "test-signature-verifier" };
    }
  };
}

async function nextCandleEvent(
  base: string,
  pair: string,
  after: string,
  options: { lastEventId?: string } = {}
): Promise<{ cursor: string; candle: { startTimestamp: number; finalized: boolean; revision: number; closeUsdE18: string | null; swapCount: number } }> {
  return (await nextCandleEvents(base, pair, after, 1, options))[0]!;
}

async function nextCandleEvents(
  base: string,
  pair: string,
  after: string,
  count: number,
  options: { lastEventId?: string } = {}
): Promise<Array<{ cursor: string; candle: { startTimestamp: number; finalized: boolean; revision: number; closeUsdE18: string | null; swapCount: number } }>> {
  const controller = new AbortController();
  const response = await fetch(`${base}/events/candles?pair=${pair}&interval=ONE_MINUTE&after=${after}`, {
    headers: options.lastEventId ? { "last-event-id": options.lastEventId } : undefined,
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ cursor: string; candle: { startTimestamp: number; finalized: boolean; revision: number; closeUsdE18: string | null; swapCount: number } }> = [];
  try {
    while (events.length < count) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Candle stream closed before the expected event arrived");
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.includes("event: candle")) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (data) events.push(JSON.parse(data));
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return events;
  } finally {
    controller.abort();
  }
}
