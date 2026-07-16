import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import {
  AnalyticsApiService,
  AnalyticsEngine,
  PostgresAnalyticsStore,
  USD_SCALE,
  type BlockEnvelope,
  type PricePolicy
} from "../src/index.js";

const DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL;
const PAIR = "0x00000000000000000000000000000000000000a1";
const TOKEN_X = "0x00000000000000000000000000000000000000b1";
const TOKEN_Y = "0x00000000000000000000000000000000000000c1";
const policies: PricePolicy[] = [
  { token: TOKEN_X, source: "chainlink-data-streams", feedId: "x-usd", maxAgeSeconds: 300, maxConfidenceBps: 100 },
  { token: TOKEN_Y, source: "chainlink-data-streams", feedId: "y-usd", maxAgeSeconds: 300, maxConfidenceBps: 100 }
];

test("persists canonical blocks, candles, and replay events in PostgreSQL", { skip: DATABASE_URL === undefined }, async () => {
  const schema = `feather_test_${process.pid}_${Date.now()}`;
  const store = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema, replaySize: 8 });
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  const block: BlockEnvelope = {
    number: 1n,
    hash: `0x${"1".repeat(64)}`,
    parentHash: `0x${"0".repeat(64)}`,
    timestamp: 60,
    prices: [
      { token: TOKEN_X, source: "chainlink-data-streams", feedId: "x-usd", priceUsdE18: USD_SCALE, confidenceUsdE18: 0n, observedAt: 60, sequence: 1n, verifiedBy: "test" },
      { token: TOKEN_Y, source: "chainlink-data-streams", feedId: "y-usd", priceUsdE18: USD_SCALE, confidenceUsdE18: 0n, observedAt: 60, sequence: 1n, verifiedBy: "test" }
    ],
    events: [{
      pair: PAIR,
      tokenX: TOKEN_X,
      tokenY: TOKEN_Y,
      decimalsX: 18,
      decimalsY: 18,
      kind: "swap",
      amountInX: 1n,
      amountInY: 0n,
      feeX: 0n,
      feeY: 0n,
      reserveX: 10n,
      reserveY: 10n,
      marketPriceQuoteE18: USD_SCALE,
      activeId: 8_388_608,
      binStep: 10
    }]
  };
  const cleanup = new Pool({ connectionString: DATABASE_URL });
  try {
    engine.ingestBlock(block);
    await store.save(engine.exportCheckpoint(), engine.listCandles());
    const firstMinute = engine.listCandles().find((candle) => candle.interval === "minute")!;
    await store.appendCandleEvents(Array.from({ length: 10 }, (_, index) => ({
      cursor: String(index + 1),
      type: "candle" as const,
      pair: PAIR,
      interval: "minute" as const,
      candle: { ...firstMinute, revision: index + 1 },
      reason: null
    })));

    const appended: BlockEnvelope = {
      ...block,
      number: 2n,
      hash: `0x${"2".repeat(64)}`,
      parentHash: block.hash,
      timestamp: 120,
      prices: block.prices.map((sample) => ({ ...sample, observedAt: 120, sequence: 2n })),
      events: block.events.map((event) => event.kind === "swap"
        ? { ...event, marketPriceQuoteE18: 2n * USD_SCALE }
        : event)
    };
    const beforeAppend = new Map(engine.listCandles().map((candle) => [
      `${candle.pair}:${candle.interval}:${candle.startTimestamp}`,
      JSON.stringify(candle, (_key, value) => typeof value === "bigint" ? value.toString() : value)
    ]));
    engine.ingestBlock(appended);
    const appendChanges = engine.listLastChangedCandles().filter((candle) =>
      beforeAppend.get(`${candle.pair}:${candle.interval}:${candle.startTimestamp}`) !==
      JSON.stringify(candle, (_key, value) => typeof value === "bigint" ? value.toString() : value)
    );
    assert(appendChanges.length > 0 && appendChanges.length <= 14);
    await store.appendCanonicalState(engine.exportCheckpointMetadata(), appended, appendChanges);
    const appendedPersistence = await cleanup.query<{ blocks: string; candles: string }>(`SELECT
      (SELECT COUNT(*)::text FROM ${schema}.canonical_blocks) AS blocks,
      (SELECT COUNT(*)::text FROM ${schema}.candles) AS candles`);
    assert.equal(appendedPersistence.rows[0]?.blocks, "2");
    assert.equal(appendedPersistence.rows[0]?.candles, String(engine.listCandles().length));

    const replacement: BlockEnvelope = {
      ...appended,
      hash: `0x${"3".repeat(64)}`,
      timestamp: 121,
      prices: appended.prices.map((sample) => ({ ...sample, observedAt: 121 }))
    };
    assert.equal(engine.ingestBlock(replacement), "reorg");
    await store.save(engine.exportCheckpoint(), engine.listCandles());
    const expectedCandleCount = String(engine.listCandles().length);

    const restored = await store.load();
    assert.deepEqual(restored?.blocks.map((entry) => entry.hash), [block.hash, replacement.hash]);
    assert.equal(restored?.blocks[0]?.events[0]?.kind, "swap");
    assert.equal(restored?.reorgCount, 1);

    const events = await store.loadCandleEvents();
    assert.deepEqual(events.map((event) => event.cursor), ["3", "4", "5", "6", "7", "8", "9", "10"]);
    assert.equal(events.at(-1)?.candle?.revision, 10);

    const persisted = await cleanup.query<{
      blocks: string;
      candles: string;
      orphaned: string;
    }>(`SELECT
      (SELECT COUNT(*)::text FROM ${schema}.canonical_blocks) AS blocks,
      (SELECT COUNT(*)::text FROM ${schema}.candles) AS candles,
      (SELECT COUNT(*)::text FROM ${schema}.canonical_blocks WHERE hash = $1) AS orphaned`, [appended.hash]);
    assert.equal(persisted.rows[0]?.blocks, "2");
    assert.equal(persisted.rows[0]?.candles, expectedCandleCount);
    assert.equal(persisted.rows[0]?.orphaned, "0");

    const restoredService = await AnalyticsApiService.create({
      engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
      store
    });
    assert.equal(restoredService.getHealth(121).headHash, replacement.hash);
    assert.equal(restoredService.candleStream.cursor, "10");
    const result = await restoredService.execute(`query($pair: ID!) {
      pairCandles(pair: $pair, interval: ONE_MINUTE, fromTimestamp: 0, toTimestamp: 180, first: 100) {
        nodes { startTimestamp lastBlockHash revision }
        streamCursor
      }
    }`, { pair: PAIR });
    assert.equal(result.errors, undefined);
    const data = result.data as { pairCandles: { nodes: Array<{ lastBlockHash: string }>; streamCursor: string } };
    assert.equal(data.pairCandles.streamCursor, "10");
    assert(data.pairCandles.nodes.some((candle) => candle.lastBlockHash === replacement.hash));
  } finally {
    await store.close();
    await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanup.end();
  }
});
