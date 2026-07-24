import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import {
  AnalyticsApiService,
  AnalyticsEngine,
  PostgresAnalyticsStore,
  AnalyticsWriterLeaseUnavailableError,
  USD_SCALE,
  type AnalyticsCheckpoint,
  type BlockEnvelope,
  type BlockSubmission,
  type PoolBinState,
  type PoolState,
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

test("fences PostgreSQL writers with a process-lifetime schema lease", { skip: DATABASE_URL === undefined }, async () => {
  const schema = `feather_lease_${process.pid}_${Date.now()}`;
  const otherSchema = `${schema}_other`;
  const first = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema });
  const contender = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema });
  const independent = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema: otherSchema });
  let successor: PostgresAnalyticsStore | null = null;
  const cleanup = new Pool({ connectionString: DATABASE_URL });
  try {
    await assert.rejects(() => contender.load(), AnalyticsWriterLeaseUnavailableError);
    await first.acquireWriterLease();
    await first.healthcheck();
    assert.equal(first.hasWriterLease(), true);
    await assert.rejects(
      () => contender.acquireWriterLease(),
      (error: unknown) => error instanceof AnalyticsWriterLeaseUnavailableError && /already held/.test(error.message)
    );

    await independent.acquireWriterLease();
    assert.equal(independent.hasWriterLease(), true, "a separate schema owns an independent lease");

    await first.releaseWriterLease();
    assert.equal(first.hasWriterLease(), false);
    await assert.rejects(() => first.healthcheck(), AnalyticsWriterLeaseUnavailableError);
    successor = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema });
    await successor.acquireWriterLease();
    await successor.healthcheck();
  } finally {
    await Promise.allSettled([first.close(), contender.close(), independent.close(), successor?.close()]);
    await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanup.query(`DROP SCHEMA IF EXISTS ${otherSchema} CASCADE`);
    await cleanup.end();
  }
});

test("treats PostgreSQL writer-session loss as a permanent fatal lease failure", { skip: DATABASE_URL === undefined }, async () => {
  const schema = `feather_lease_loss_${process.pid}_${Date.now()}`;
  const applicationName = `feather-lease-loss-${process.pid}-${Date.now()}`;
  const store = new PostgresAnalyticsStore({
    connectionString: DATABASE_URL!,
    schema,
    applicationName
  });
  const admin = new Pool({ connectionString: DATABASE_URL });
  let successor: PostgresAnalyticsStore | null = null;
  try {
    await store.acquireWriterLease();
    const backend = await admin.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
      [applicationName]
    );
    assert.equal(backend.rowCount, 1, "the dedicated lease session is identifiable");
    const fatalFailure = store.writerLeaseFailure();
    const terminated = await admin.query<{ terminated: boolean }>(
      "SELECT pg_terminate_backend($1) AS terminated",
      [backend.rows[0]!.pid]
    );
    assert.equal(terminated.rows[0]?.terminated, true);
    const fatal = await Promise.race([
      fatalFailure,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("writer lease failure signal timed out")), 5_000).unref();
      })
    ]);
    assert(fatal instanceof Error);
    assert.equal(store.hasWriterLease(), false);
    await assert.rejects(() => store.healthcheck(), /writer lease connection failed/);
    await store.releaseWriterLease();
    await assert.rejects(
      () => store.acquireWriterLease(),
      /failed permanently; restart the process/
    );

    successor = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema });
    await successor.acquireWriterLease();
    await successor.healthcheck();
  } finally {
    await Promise.allSettled([store.close(), successor?.close()]);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test("persists canonical blocks, candles, and replay events in PostgreSQL", { skip: DATABASE_URL === undefined }, async () => {
  const schema = `feather_test_${process.pid}_${Date.now()}`;
  const store = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema, globalReplaySize: 5, replaySize: 8 });
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
      protocolFeeX: 0n,
      protocolFeeY: 0n,
      reserveX: 10n,
      reserveY: 10n,
      marketPriceQuoteE18: USD_SCALE,
      activeId: 8_388_608,
      binStep: 10
    }]
  };
  const cleanup = new Pool({ connectionString: DATABASE_URL });
  try {
    await store.acquireWriterLease();
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
    assert.deepEqual(events.map((event) => event.cursor), ["6", "7", "8", "9", "10"]);
    assert.equal(events.at(-1)?.candle?.revision, 10);
    await assert.rejects(
      () => store.appendCandleEvents([{
        ...events.at(-1)!,
        candle: { ...events.at(-1)!.candle!, revision: 999 }
      }]),
      /conflicts with an immutable persisted event/
    );

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

test("fails closed instead of truncating a conflicting legacy stream cursor", { skip: DATABASE_URL === undefined }, async () => {
  const schema = `feather_stream_migration_${process.pid}_${Date.now()}`;
  const admin = new Pool({ connectionString: DATABASE_URL });
  let store: PostgresAnalyticsStore | null = null;
  const event = {
    cursor: "1",
    type: "candle",
    pair: PAIR,
    interval: "minute",
    candle: null,
    update: null,
    reason: null
  };
  try {
    await admin.query(`
      CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.candle_stream_events (
        cursor BIGINT PRIMARY KEY,
        pair TEXT,
        interval TEXT,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE ${schema}.stream_events (
        cursor BIGINT PRIMARY KEY,
        topic TEXT NOT NULL,
        pair TEXT,
        interval TEXT,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await admin.query(
      `INSERT INTO ${schema}.candle_stream_events (cursor, pair, interval, event_type, payload)
       VALUES (1, $1, 'minute', 'candle', $2::jsonb)`,
      [PAIR, JSON.stringify(event)]
    );
    await admin.query(
      `INSERT INTO ${schema}.stream_events (cursor, topic, pair, interval, event_type, payload)
       VALUES (1, $1, $2, 'minute', 'candle', $3::jsonb)`,
      [`candle:${PAIR}:hour`, PAIR, JSON.stringify(event)]
    );

    store = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema });
    await assert.rejects(() => store!.acquireWriterLease(), /Legacy candle stream cursor conflicts/);
    assert.equal(
      (await admin.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${schema}.candle_stream_events`)).rows[0]?.count,
      "1",
      "a rejected migration must retain the legacy outbox"
    );
    await store.close();
    store = null;

    await admin.query(
      `UPDATE ${schema}.stream_events SET topic = $1 WHERE cursor = 1`,
      [`candle:${PAIR}:minute`]
    );
    store = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema });
    await store.acquireWriterLease();
    assert.equal(await store.load(), null);
    assert.equal(
      (await admin.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${schema}.candle_stream_events`)).rows[0]?.count,
      "0",
      "an identical immutable cursor migrates before the legacy table is truncated"
    );
  } finally {
    await store?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test("atomically rolls back canonical state when outbox persistence fails across restart", { skip: DATABASE_URL === undefined }, async () => {
  const schema = `feather_atomic_${process.pid}_${Date.now()}`;
  const cleanup = new Pool({ connectionString: DATABASE_URL });
  const fixedPolicies: PricePolicy[] = policies.map((policy) => ({ ...policy, source: "fixed-test" }));
  let store: PostgresAnalyticsStore | null = new PostgresAnalyticsStore({
    connectionString: DATABASE_URL!,
    schema,
    replaySize: 32
  });
  try {
    await store.acquireWriterLease();
    const service = await AnalyticsApiService.create({
      engine: new AnalyticsEngine(fixedPolicies, { assumeCompleteHistory: true }),
      store,
      allowFixedTestPrices: true
    });
    const first = serviceSubmission(1n, hash(1), hash(0), 60, USD_SCALE);
    const second = serviceSubmission(2n, hash(2), hash(1), 120, 2n * USD_SCALE);
    assert.equal(await service.ingestBlock(first), "appended");
    const baselineCursor = service.candleStream.cursor;
    assert.notEqual(baselineCursor, "0");
    const baseline = await persistedCounts(cleanup, schema);

    await cleanup.query(`
      CREATE FUNCTION ${schema}.fail_stream_outbox() RETURNS trigger AS $body$
      BEGIN
        RAISE EXCEPTION 'injected candle outbox failure';
      END;
      $body$ LANGUAGE plpgsql
    `);
    await cleanup.query(`
      CREATE TRIGGER fail_stream_outbox
      BEFORE INSERT OR UPDATE ON ${schema}.stream_events
      FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_stream_outbox()
    `);

    await assert.rejects(() => service.ingestBlock(second), /injected candle outbox failure/);
    assert.equal(service.candleStream.cursor, baselineCursor, "failed atomic writes never become live");
    assert.deepEqual(await persistedCounts(cleanup, schema), baseline, "canonical and outbox writes roll back together");

    await store.close();
    store = null;
    store = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema, replaySize: 32 });
    await store.acquireWriterLease();
    const restarted = await AnalyticsApiService.create({
      engine: new AnalyticsEngine(fixedPolicies, { assumeCompleteHistory: true }),
      store,
      allowFixedTestPrices: true
    });
    assert.equal(restarted.getHealth(120).headBlock, 1n, "restart restores the last fully published canonical head");
    assert.equal(restarted.candleStream.cursor, baselineCursor);
    assert.deepEqual(restarted.candleStream.replay(baselineCursor, PAIR, "minute"), []);

    await cleanup.query(`DROP TRIGGER fail_stream_outbox ON ${schema}.stream_events`);
    assert.equal(await restarted.ingestBlock(second), "appended");
    const committedCursor = restarted.candleStream.cursor;
    assert(Number(committedCursor) > Number(baselineCursor));
    assert((restarted.candleStream.replay(baselineCursor, PAIR, "minute") ?? []).length > 0);

    await store.close();
    store = null;
    store = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema, replaySize: 32 });
    await store.acquireWriterLease();
    const committedRestart = await AnalyticsApiService.create({
      engine: new AnalyticsEngine(fixedPolicies, { assumeCompleteHistory: true }),
      store,
      allowFixedTestPrices: true
    });
    assert.equal(committedRestart.getHealth(120).headBlock, 2n);
    assert.equal(committedRestart.candleStream.cursor, committedCursor);
    assert((committedRestart.candleStream.replay(baselineCursor, PAIR, "minute") ?? []).length > 0,
      "an old Last-Event-ID can replay the replacement after restart");
    assert((committedRestart.candleStream.replayPool(baselineCursor, PAIR) ?? [])
      .some((event) => event.type === "pool-state" && event.update?.state.asOfBlock === 2n),
    "pool replay survives the same PostgreSQL restart and shared cursor");
    const poolQuery = await committedRestart.execute(`query($pair: ID!) {
      poolState(pair: $pair, radius: 2) { streamCursor state { asOfBlock asOfBlockHash } bins { binId } }
    }`, { pair: PAIR });
    assert.equal(poolQuery.errors, undefined);
    assert.equal((poolQuery.data?.poolState as { state: { asOfBlock: string } }).state.asOfBlock, "2");
  } finally {
    await store?.close();
    await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanup.end();
  }
});

test("atomically materializes pool state and sparse bin replacements with the shared outbox", { skip: DATABASE_URL === undefined }, async () => {
  const schema = `feather_pool_state_${process.pid}_${Date.now()}`;
  const store = new PostgresAnalyticsStore({ connectionString: DATABASE_URL!, schema, replaySize: 2 });
  const cleanup = new Pool({ connectionString: DATABASE_URL });
  const checkpoint: AnalyticsCheckpoint = {
    version: 1,
    reorgCount: 0,
    blocks: [],
    backfill: {
      status: "complete",
      cursor: null,
      error: null,
      coverageStartTimestamp: 0,
      coverageThroughTimestamp: 0
    }
  };
  const firstState = persistedPoolState(1, hash(1));
  const firstBins = [persistedPoolBin(firstState, "8388607", 1n), persistedPoolBin(firstState, "8388608", 2n)];
  try {
    await store.acquireWriterLease();
    await store.save(checkpoint, [], [{ state: firstState, bins: firstBins, replaceBinWindow: true }]);
    const secondState = { ...firstState, asOfBlock: 2n, asOfBlockHash: hash(2), asOfTimestamp: 120, revision: 2 };
    const replacement = { ...persistedPoolBin(secondState, "8388608", 9n), revision: 2 };
    const update = {
      eventId: `31337:${hash(2)}:${PAIR}:swap:2`,
      state: secondState,
      binReplacements: [replacement],
      replaceBinWindow: false,
      sourceEventIds: ["swap:2"]
    };
    const block: BlockEnvelope = {
      chainId: 31_337,
      number: 2n,
      hash: hash(2),
      parentHash: hash(1),
      timestamp: 120,
      prices: [],
      events: []
    };
    await store.appendCanonicalStateAndCandleEvents(
      checkpoint,
      block,
      [],
      [{ cursor: "1", type: "pool-state", pair: PAIR, interval: null, candle: null, update, reason: null }],
      [{ state: secondState, bins: [replacement], replaceBinWindow: false }]
    );

    const materialized = await cleanup.query<{ states: string; bins: string; reserve_x: string }>(`SELECT
      (SELECT COUNT(*)::text FROM ${schema}.pool_states) AS states,
      (SELECT COUNT(*)::text FROM ${schema}.pool_bins) AS bins,
      (SELECT payload->'reserveX'->>'$featherBigInt' FROM ${schema}.pool_bins WHERE bin_id = '8388608') AS reserve_x`);
    assert.deepEqual(materialized.rows[0], { states: "1", bins: "2", reserve_x: "9" });
    assert.deepEqual((await store.loadCandleEvents()).map((event) => event.type), ["pool-state"]);

    const reorgState = { ...secondState, asOfBlockHash: hash(3), asOfTimestamp: 121, revision: 3 };
    const reorgBin = persistedPoolBin(reorgState, "8388608", 7n);
    await store.saveCanonicalStateAndCandleEvents(
      { ...checkpoint, reorgCount: 1, blocks: [{ ...block, hash: hash(3), timestamp: 121 }] },
      [],
      [{ cursor: "2", type: "reset", pair: null, interval: null, candle: null, update: null, reason: "canonical-reorg" }],
      [{ state: reorgState, bins: [reorgBin], replaceBinWindow: true }]
    );
    const rebuilt = await cleanup.query<{ bins: string; hash: string }>(`SELECT
      (SELECT COUNT(*)::text FROM ${schema}.pool_bins) AS bins,
      (SELECT as_of_block_hash FROM ${schema}.pool_states WHERE pair = $1) AS hash`, [PAIR]);
    assert.deepEqual(rebuilt.rows[0], { bins: "1", hash: hash(3) });
    assert.deepEqual((await store.loadCandleEvents()).map((event) => event.type), ["pool-state", "reset"]);
  } finally {
    await store.close();
    await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanup.end();
  }
});

function serviceSubmission(
  number: bigint,
  blockHash: `0x${string}`,
  parentHash: `0x${string}`,
  timestamp: number,
  marketPriceQuoteE18: bigint
): BlockSubmission {
  return {
    chainId: 31_337,
    number,
    hash: blockHash,
    parentHash,
    timestamp,
    prices: [
      {
        token: TOKEN_X,
        source: "fixed-test",
        feedId: "x-usd",
        priceUsdE18: marketPriceQuoteE18,
        confidenceUsdE18: 0n,
        observedAt: timestamp,
        sequence: number,
        signedReport: null
      },
      {
        token: TOKEN_Y,
        source: "fixed-test",
        feedId: "y-usd",
        priceUsdE18: USD_SCALE,
        confidenceUsdE18: 0n,
        observedAt: timestamp,
        sequence: number,
        signedReport: null
      }
    ],
    events: [{
      pair: PAIR,
      tokenX: TOKEN_X,
      tokenY: TOKEN_Y,
      decimalsX: 18,
      decimalsY: 18,
      kind: "swap",
      amountInX: 10n ** 18n,
      amountInY: 0n,
      feeX: 10n ** 15n,
      feeY: 0n,
      reserveX: 10n * 10n ** 18n,
      reserveY: 20_000n * 10n ** 18n,
      marketPriceQuoteE18,
      activeId: 8_388_608 + Number(number),
      binStep: 10
    }, {
      pair: PAIR,
      tokenX: TOKEN_X,
      tokenY: TOKEN_Y,
      decimalsX: 18,
      decimalsY: 18,
      kind: "pair-snapshot",
      reserveX: 10n * 10n ** 18n,
      reserveY: 20_000n * 10n ** 18n,
      marketPriceQuoteE18,
      activeId: 8_388_608 + Number(number),
      binStep: 10,
      source: {
        eventId: `snapshot:${number}`,
        transactionHash: null,
        logIndex: null,
        sequence: 0,
        kind: "block-snapshot"
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
            volatilityAccumulator: number,
            volatilityReference: 0n,
            idReference: BigInt(8_388_608) + number,
            timeOfLastUpdate: BigInt(timestamp)
          }
        },
        binUpdates: [-1n, 0n, 1n].map((offset) => ({
          binId: String(BigInt(8_388_608) + number + offset),
          reserveX: 10n + number + offset,
          reserveY: 20n + number - offset,
          totalSupply: 100n
        })),
        sourceEventIds: [`snapshot:${number}`],
        replaceBinWindow: number === 1n
      }
    }]
  };
}

async function persistedCounts(pool: Pool, schema: string): Promise<{ blocks: string; candles: string; events: string }> {
  const result = await pool.query<{ blocks: string; candles: string; events: string }>(`SELECT
    (SELECT COUNT(*)::text FROM ${schema}.canonical_blocks) AS blocks,
    (SELECT COUNT(*)::text FROM ${schema}.candles) AS candles,
    (SELECT COUNT(*)::text FROM ${schema}.stream_events) AS events`);
  return result.rows[0]!;
}

function hash(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function persistedPoolState(revision: number, blockHash: `0x${string}`): PoolState {
  return {
    chainId: 31_337,
    pair: PAIR,
    tokenX: TOKEN_X,
    tokenY: TOKEN_Y,
    decimalsX: 18,
    decimalsY: 6,
    reserveX: 100n,
    reserveY: 200n,
    activeId: 8_388_608,
    binStep: 10,
    marketPriceQuoteE18: 2_000n * USD_SCALE,
    priceUsdE18: 2_000n * USD_SCALE,
    tvlUsdE18: 400_000n * USD_SCALE,
    status: "ready",
    missingPriceTokens: [],
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
        volatilityAccumulator: BigInt(revision),
        volatilityReference: 0n,
        idReference: 8_388_608n,
        timeOfLastUpdate: BigInt(revision * 60)
      }
    },
    asOfBlock: BigInt(revision),
    asOfBlockHash: blockHash,
    asOfTimestamp: revision * 60,
    revision
  };
}

function persistedPoolBin(state: PoolState, binId: string, reserveX: bigint): PoolBinState {
  return {
    chainId: state.chainId,
    pair: state.pair,
    binId,
    reserveX,
    reserveY: 1n,
    totalSupply: 10n,
    updatedAtBlock: state.asOfBlock,
    updatedAtBlockHash: state.asOfBlockHash,
    updatedAtTimestamp: state.asOfTimestamp,
    revision: state.revision
  };
}
