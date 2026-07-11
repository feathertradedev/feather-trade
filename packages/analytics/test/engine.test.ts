import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AnalyticsApiService,
  AnalyticsCheckpointStore,
  AnalyticsEngine,
  FULL_HISTORY_START_TIMESTAMP,
  runBackfill,
  startAnalyticsHttpServer,
  USD_SCALE,
  type AnalyticsEvent,
  type BlockEnvelope,
  type BlockSubmission,
  type PriceSampleVerifier,
  type PricePolicy,
  type PositionSnapshotEvent
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
    assert.equal(allowed.headers.get("access-control-allow-methods"), "POST, OPTIONS");

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
  assert.equal(candle.swapCount, 1);
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
        nodes { pair tvlUsdE18 volume24hUsdE18 fees24hUsdE18 status }
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

function swap(amountInX: bigint, amountInY: bigint, feeX: bigint, feeY: bigint): AnalyticsEvent {
  return { ...identity(), kind: "swap", amountInX, amountInY, feeX, feeY, reserveX: 100n * UNIT, reserveY: 100n * UNIT };
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
