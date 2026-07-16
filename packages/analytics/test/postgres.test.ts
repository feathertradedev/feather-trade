import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import {
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
  engine.ingestBlock(block);
  const candles = engine.listCandles();
  await store.save(engine.exportCheckpoint(), candles);
  await store.appendCandleEvents([{ cursor: "1", type: "candle", pair: PAIR, interval: "minute", candle: candles.find((candle) => candle.interval === "minute")!, reason: null }]);

  const restored = await store.load();
  assert.equal(restored?.blocks[0]?.hash, block.hash);
  assert.equal(restored?.blocks[0]?.events[0]?.kind, "swap");
  const events = await store.loadCandleEvents();
  assert.equal(events[0]?.candle?.revision, 2);
  await store.close();

  const cleanup = new Pool({ connectionString: DATABASE_URL });
  try {
    await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await cleanup.end();
  }
});
