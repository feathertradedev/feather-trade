import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const endpoint = "https://analytics.example.test/graphql";
const pairA = "0x00000000000000000000000000000000000000a1";
const pairB = "0x00000000000000000000000000000000000000b2";
const tokenX = "0x00000000000000000000000000000000000000c3";
const tokenY = "0x00000000000000000000000000000000000000d4";
let mode = "normal";

const server = await createServer({ configFile: resolve(webRoot, "vite.config.ts"), root: webRoot, logLevel: "error", server: { hmr: false, middlewareMode: true } });

try {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  const { normalizeAnalyticsEndpoint } = await server.ssrLoadModule("/src/analytics-endpoint.ts");
  const {
    CANDLE_STREAM_STALE_AFTER_MS,
    POOL_STREAM_STALE_AFTER_MS,
    applyPoolStateUpdate,
    isCandleStreamStale,
    isPoolStreamStale,
    loadAnalyticsHealth,
    loadPairCandles,
    loadPoolMetrics,
    loadPoolState,
    parsePoolStreamPayload,
    poolStreamUrl
  } = await server.ssrLoadModule("/src/analytics-data.ts");

  assert.equal(normalizeAnalyticsEndpoint(" https://analytics.example.test/graphql/ "), endpoint);
  assert.equal(normalizeAnalyticsEndpoint(undefined), null);
  assert.equal(normalizeAnalyticsEndpoint(""), null);
  assert.equal(normalizeAnalyticsEndpoint("analytics.example.test/graphql"), null);
  assert.equal(normalizeAnalyticsEndpoint("ws://analytics.example.test/graphql"), null);
  assert.equal(normalizeAnalyticsEndpoint("https://user:secret@analytics.example.test/graphql"), null);
  assert.equal(normalizeAnalyticsEndpoint("https://analytics.example.test/graphql#fragment"), null);
  assert.equal(CANDLE_STREAM_STALE_AFTER_MS, 45_000);
  assert.equal(isCandleStreamStale(1_000, 45_999), false);
  assert.equal(isCandleStreamStale(1_000, 46_000), true);
  assert.equal(POOL_STREAM_STALE_AFTER_MS, 45_000);
  assert.equal(isPoolStreamStale(1_000, 45_999), false);
  assert.equal(isPoolStreamStale(1_000, 46_000), true);

  const metrics = await loadPoolMetrics(endpoint, [pairB.toUpperCase().replace("0X", "0x"), pairA], undefined, { pageSize: 1 });
  assert.equal(metrics.status, "PARTIAL");
  assert.equal(metrics.pageInfo.pagesLoaded, 2);
  assert.deepEqual(metrics.rows.map((row) => row.pair), [pairB, pairA]);
  assert.equal(metrics.rows[0].lpFees24hUsdE18, null);
  assert.equal(metrics.rows[0].feeBreakdownComplete, false);
  assert.equal(metrics.rows[0].volume24hUsdE18, "0");
  assert.equal(metrics.rows[1].lpFees24hUsdE18, "0");
  assert.equal(metrics.rows[1].totalSwapFees24hUsdE18, "0");
  assert.equal(metrics.rows[1].protocolSwapFees24hUsdE18, "0");
  assert.equal(metrics.rows[1].feeBreakdownComplete, true);

  const capped = await loadPoolMetrics(endpoint, [pairA, pairB], undefined, { pageSize: 1, maxPages: 1 });
  assert.equal(capped.status, "PARTIAL");
  assert.equal(capped.pageInfo.hasNextPage, true);
  assert.match(capped.error, /capped at 1 pages/);

  mode = "duplicate";
  const duplicate = await loadPoolMetrics(endpoint, [pairA]);
  assert.equal(duplicate.status, "PARTIAL");
  assert.match(duplicate.error, /duplicate key/);
  mode = "normal";

  const candles = await loadPairCandles(endpoint, pairA, "HOUR", 3_600, 7_200, { pageSize: 1 });
  assert.equal(candles.status, "PARTIAL");
  assert.deepEqual(candles.rows.map((row) => row.startTimestamp), [3_600, 7_200]);
  assert.equal(candles.rows[0].lpFeesUsdE18, "0");
  assert.equal(candles.rows[0].totalSwapFeesUsdE18, "0");
  assert.equal(candles.rows[0].protocolSwapFeesUsdE18, "0");
  assert.equal(candles.rows[1].openUsdE18, null);
  assert.deepEqual(candles.rows[1].missingPriceTokens, [tokenX]);
  assert.equal(candles.streamCursor, "7");

  const pool = await loadPoolState(endpoint, pairA, 1);
  assert.equal(pool.status, "READY");
  assert.equal(pool.value?.streamCursor, "7");
  assert.deepEqual(pool.value?.bins.map((bin) => bin.binId), ["8388607", "8388608", "8388609"]);
  assert.equal(
    poolStreamUrl(endpoint, pairA, "7"),
    `https://analytics.example.test/events/pools?pair=${pairA}&after=7`
  );
  const update = parsePoolStreamPayload({ cursor: "9", update: poolUpdate() }, pairA);
  const untouched = pool.value.bins[2];
  const applied = applyPoolStateUpdate(pool.value, update);
  assert.equal(applied.streamCursor, "9");
  assert.equal(applied.state.activeId, 8_388_609);
  assert.equal(applied.bins.find((bin) => bin.binId === "8388608")?.reserveX, "222");
  assert.equal(applied.bins.find((bin) => bin.binId === "8388609"), untouched);
  assert.equal(applyPoolStateUpdate(applied, update), applied, "exact duplicate delivery is a no-op");
  assert.throws(
    () => applyPoolStateUpdate(applied, { ...update, eventId: "different-event" }),
    /cursor was reused/
  );
  assert.throws(
    () => parsePoolStreamPayload({ cursor: "10", update: { ...poolUpdate(), state: { ...poolState(), pair: pairB } } }, pairA),
    /foreign pair/
  );
  assert.throws(
    () => parsePoolStreamPayload({
      cursor: "10",
      update: {
        ...poolUpdate(),
        binReplacements: [poolBin(8_388_608, {
          updatedAtBlock: "100",
          updatedAtBlockHash: `0x${"c".repeat(64)}`,
          updatedAtTimestamp: 9_001,
          revision: 2
        })]
      }
    }, pairA),
    /bin canonical hash differs/
  );

  const health = await loadAnalyticsHealth(endpoint);
  assert.equal(health.value?.status, "PARTIAL");
  assert.equal(health.status, "PARTIAL");
  assert.equal(health.value?.fresh, false);
  assert.equal(health.value?.backfillStatus, "running");
  assert.equal(health.value?.coverageStartTimestamp, "-9007199254740991");
  assert.deepEqual(health.value?.missingPriceTokens, [tokenX]);

  const unavailable = await loadPoolMetrics(null, [pairA]);
  assert.equal(unavailable.status, "UNAVAILABLE");
  assert.equal(unavailable.rows.length, 0);

  await assert.rejects(() => loadPoolMetrics(endpoint, [pairA, pairA.toUpperCase().replace("0X", "0x")]), /Duplicate requested pool/);
  await assert.rejects(() => loadPoolMetrics(endpoint, [pairA], undefined, { pageSize: 101 }), /pageSize must be between 1 and 100/);
  await assert.rejects(() => loadPoolMetrics(endpoint, [pairA], undefined, { maxPages: 6 }), /maxPages must be between 1 and 5/);
  await assert.rejects(() => loadAnalyticsHealth(endpoint, { timeoutMs: 60_001 }), /timeoutMs must be between 1 and 60000/);
  globalThis.fetch = originalFetch;
  console.log("Analytics data fixture passed: full endpoint contract, canonical joins, bounded cursors, LP-net taxonomy, null/zero, candles, and health semantics.");
} finally {
  await server.close();
}

async function mockFetch(url, init) {
  assert.equal(String(url), endpoint);
  const body = JSON.parse(String(init?.body));
  const query = String(body.query);
  const variables = body.variables ?? {};

  if (query.includes("WebPoolMetrics")) {
    if (mode === "duplicate") return response({ data: { poolMetrics: connection([metric(pairA, "READY"), metric(pairA, "READY")], null, false, false) } });
    const after = variables.after ?? null;
    const nodes = after === null ? [metric(pairA, "READY")] : [metric(pairB, "PARTIAL")];
    return response({ data: { poolMetrics: connection(nodes, after === null ? "metrics-1" : "metrics-2", after === null, after !== null) } });
  }

  if (query.includes("WebPairCandles")) {
    const after = variables.after ?? null;
    const nodes = after === null ? [candle(3_600, "READY")] : [candle(7_200, "PARTIAL")];
    return response({ data: { pairCandles: { ...connection(nodes, after === null ? "candles-1" : "candles-2", after === null, after !== null), streamCursor: "7" } } });
  }

  if (query.includes("WebPoolState")) {
    return response({ data: { poolState: {
      state: poolState(),
      bins: [8_388_607, 8_388_608, 8_388_609].map((binId) => poolBin(binId)),
      streamCursor: "7"
    } } });
  }

  if (query.includes("WebAnalyticsHealth")) {
    return response({ data: { analyticsHealth: {
      status: "READY", headBlock: "99", headHash: `0x${"1".repeat(64)}`, headTimestamp: 9_000,
      canonicalBlockCount: 5, reorgCount: 0, partialEventCount: 0, missingPriceTokens: [tokenX.toUpperCase().replace("0X", "0x")],
      fresh: false, headLagSeconds: 120, maxHeadLagSeconds: 60, backfillStatus: "running", backfillCursor: "42", backfillError: null,
      coverageStartTimestamp: "-9007199254740991", coverageThroughTimestamp: null,
      prices: [{ token: tokenX, source: "chainlink", feedId: "feed-x", status: "stale", observedAt: 8_800, ageSeconds: 200 }]
    } } });
  }
  throw new Error(`Unexpected query: ${query}`);
}

function metric(pair, status) {
  const partial = status === "PARTIAL";
  return {
    pair: pair.toUpperCase().replace("0X", "0x"), tokenX, tokenY, tvlUsdE18: partial ? null : "100", volume24hUsdE18: "0",
    totalSwapFees24hUsdE18: "0", protocolSwapFees24hUsdE18: partial ? null : "0",
    lpNetSwapFees24hUsdE18: partial ? null : "0", lpNetSwapFeeToTvlE18: partial ? null : "0",
    feeBreakdownComplete: !partial, priceUsdE18: partial ? null : "1",
    asOfBlock: "99", asOfTimestamp: 9_000, status, missingPriceTokens: partial ? [tokenX] : []
  };
}

function candle(startTimestamp, status) {
  const partial = status === "PARTIAL";
  return {
    pair: pairA, interval: "HOUR", startTimestamp, endTimestamp: startTimestamp + 3_600,
    openUsdE18: partial ? null : "10", highUsdE18: partial ? null : "12", lowUsdE18: partial ? null : "9", closeUsdE18: partial ? null : "11",
    volumeUsdE18: partial ? null : "0", totalSwapFeesUsdE18: "0", protocolSwapFeesUsdE18: partial ? null : "0",
    lpNetSwapFeesUsdE18: partial ? null : "0", feeBreakdownComplete: !partial, tvlUsdE18: partial ? null : "100",
    swapCount: partial ? 0 : 1, status, missingPriceTokens: partial ? [tokenX] : [], firstBlock: "90", lastBlock: "99",
    firstBlockHash: `0x${"9".repeat(64)}`, lastBlockHash: `0x${"a".repeat(64)}`, finalized: true, revision: 3,
    priceSource: "active-bin-quote-usd", quoteToken: tokenY
  };
}

function poolState(overrides = {}) {
  return {
    chainId: 31_337,
    pair: pairA,
    tokenX,
    tokenY,
    decimalsX: 18,
    decimalsY: 6,
    reserveX: "1000",
    reserveY: "2000",
    activeId: 8_388_608,
    binStep: 10,
    marketPriceQuoteE18: "1000000000000000000",
    priceUsdE18: "160000000000000000000",
    tvlUsdE18: "320000000000000000000",
    status: "READY",
    missingPriceTokens: [],
    feeState: {
      static: {
        baseFactor: "20", filterPeriod: "30", decayPeriod: "120", reductionFactor: "5000",
        variableFeeControl: "100", protocolShare: "1000", maxVolatilityAccumulator: "100000"
      },
      variable: { volatilityAccumulator: "1000", volatilityReference: "500", idReference: "8388608", timeOfLastUpdate: "1000" }
    },
    asOfBlock: "99",
    asOfBlockHash: `0x${"a".repeat(64)}`,
    asOfTimestamp: 9_000,
    revision: 1,
    ...overrides
  };
}

function poolBin(binId, overrides = {}) {
  return {
    chainId: 31_337,
    pair: pairA,
    binId: String(binId),
    reserveX: "100",
    reserveY: "200",
    totalSupply: "300",
    updatedAtBlock: "99",
    updatedAtBlockHash: `0x${"a".repeat(64)}`,
    updatedAtTimestamp: 9_000,
    revision: 1,
    ...overrides
  };
}

function poolUpdate() {
  return {
    eventId: `31337:0x${"b".repeat(64)}:${pairA}:swap-1`,
    state: poolState({
      activeId: 8_388_609,
      asOfBlock: "100",
      asOfBlockHash: `0x${"b".repeat(64)}`,
      asOfTimestamp: 9_001,
      revision: 2
    }),
    binReplacements: [poolBin(8_388_608, {
      reserveX: "222",
      updatedAtBlock: "100",
      updatedAtBlockHash: `0x${"b".repeat(64)}`,
      updatedAtTimestamp: 9_001,
      revision: 2
    })],
    replaceBinWindow: false,
    sourceEventIds: ["swap-1"]
  };
}

function connection(nodes, endCursor, hasNextPage, partial) { return { nodes, pageInfo: { endCursor, hasNextPage, partial } }; }
function response(value) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status: 200 }); }
