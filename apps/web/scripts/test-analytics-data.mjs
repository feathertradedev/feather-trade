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
const discoveryBatchSizes = [];

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
    loadPoolDiscovery,
    loadPoolDiscoveryBatches,
    loadPoolMetrics,
    loadPoolState,
    parsePoolStreamPayload,
    poolStreamUrl,
    resolveAnalyticsAssetUrl
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

  const discovery = await loadPoolDiscovery(endpoint, [{ pair: pairA, preferredQuoteToken: tokenY }]);
  assert.equal(discovery.status, "READY");
  assert.equal(discovery.rows.length, 1);
  assert.equal(discovery.rows[0].displayBaseToken, tokenX);
  assert.equal(discovery.rows[0].displayQuoteToken, tokenY);
  assert.equal(discovery.rows[0].hourlyCloses.length, 2);
  assert.equal(discovery.rows[0].priceChange24hE18, "100000000000000000");
  assert.equal(discovery.rows[0].marketMetadata?.source, "dex-screener");
  assert.equal(
    resolveAnalyticsAssetUrl(endpoint, `/token-images/${"a".repeat(64)}`),
    `https://analytics.example.test/token-images/${"a".repeat(64)}`
  );
  assert.equal(resolveAnalyticsAssetUrl(endpoint, "https://evil.test/image.png"), null);
  assert.equal(resolveAnalyticsAssetUrl(endpoint, `/not-token-images/${"a".repeat(64)}`), null);
  assert.equal(resolveAnalyticsAssetUrl(endpoint, `/token-images/${"A".repeat(64)}`), null);

  const batchedRequests = Array.from({ length: 205 }, (_, index) => ({
    pair: address(index + 1_000),
    preferredQuoteToken: tokenY
  }));
  mode = "batched-discovery";
  discoveryBatchSizes.length = 0;
  const batchedDiscovery = await loadPoolDiscoveryBatches(endpoint, batchedRequests);
  assert.equal(batchedDiscovery.status, "READY");
  assert.equal(batchedDiscovery.pageInfo.pagesLoaded, 3);
  assert.deepEqual(discoveryBatchSizes, [100, 100, 5], "each discovery transport stays within the 100-pool bound");
  assert.deepEqual(
    batchedDiscovery.rows.map((row) => row.pair),
    batchedRequests.map((request) => request.pair),
    "batched discovery results preserve global request order"
  );

  mode = "batched-tail-failure";
  discoveryBatchSizes.length = 0;
  const partialBatches = await loadPoolDiscoveryBatches(endpoint, batchedRequests.slice(0, 101));
  assert.equal(partialBatches.status, "PARTIAL");
  assert.equal(partialBatches.pageInfo.partial, true);
  assert.equal(partialBatches.pageInfo.pagesLoaded, 1);
  assert.equal(partialBatches.rows.length, 100);
  assert.deepEqual(discoveryBatchSizes, [100, 1]);
  assert.match(partialBatches.error, /1 of 2 discovery batches were unavailable/);

  const unavailableBatches = await loadPoolDiscoveryBatches(null, batchedRequests);
  assert.equal(unavailableBatches.status, "UNAVAILABLE");
  assert.equal(unavailableBatches.rows.length, 0);
  assert.equal(unavailableBatches.pageInfo.pagesLoaded, 0);
  assert.equal(unavailableBatches.error, "Analytics endpoint is not configured");
  mode = "normal";

  mode = "malformed-metadata";
  const isolatedMetadata = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(isolatedMetadata.status, "READY");
  assert.equal(isolatedMetadata.rows[0].marketMetadata, null, "provider corruption is isolated from canonical economics");
  mode = "wrong-metadata-source";
  const isolatedSource = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(isolatedSource.status, "READY");
  assert.equal(isolatedSource.rows[0].marketMetadata, null);
  mode = "null-metadata";
  const nullMetadata = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(nullMetadata.status, "READY");
  assert.equal(nullMetadata.rows[0].marketMetadata, null);
  mode = "nullable-value";
  const nullableValue = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(nullableValue.status, "READY", "one unavailable value does not become a transport-wide failure");
  assert.equal(nullableValue.rows[0].poolPriceQuotePerBaseE18, null);
  mode = "zero-price";
  const zeroPrice = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(zeroPrice.status, "READY");
  assert.equal(zeroPrice.rows[0].poolPriceQuotePerBaseE18, null, "a zero ratio degrades as unavailable rather than being inverted");
  mode = "missing-discovery";
  const missingDiscovery = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(missingDiscovery.status, "PARTIAL");
  assert.equal(missingDiscovery.rows.length, 0);
  assert.equal(missingDiscovery.error, null);
  mode = "negative-change";
  const negativeChange = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(negativeChange.rows[0].priceChange24hE18, "-100000000000000000");
  mode = "duplicate-discovery";
  const duplicateDiscovery = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(duplicateDiscovery.status, "UNAVAILABLE");
  assert.match(duplicateDiscovery.error, /Duplicate pool discovery result/);
  mode = "foreign-discovery";
  const foreignDiscovery = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(foreignDiscovery.status, "UNAVAILABLE");
  assert.match(foreignDiscovery.error, /foreign pair/);
  mode = "reversed-discovery";
  const reversedDiscovery = await loadPoolDiscovery(endpoint, [{ pair: pairA }, { pair: pairB }]);
  assert.equal(reversedDiscovery.status, "UNAVAILABLE");
  assert.match(reversedDiscovery.error, /preserve requested order/);
  mode = "too-many-closes";
  const tooManyCloses = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(tooManyCloses.status, "UNAVAILABLE");
  assert.match(tooManyCloses.error, /more than 24/);
  mode = "unaligned-close";
  const unalignedClose = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(unalignedClose.status, "UNAVAILABLE");
  assert.match(unalignedClose.error, /not aligned/);
  mode = "transport-failure";
  const transportFailure = await loadPoolDiscovery(endpoint, [{ pair: pairA }]);
  assert.equal(transportFailure.status, "UNAVAILABLE");
  assert.match(transportFailure.error, /HTTP 503/);
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
  await assert.rejects(() => loadPoolDiscovery(endpoint, []), /between 1 and 100/);
  await assert.rejects(() => loadPoolDiscovery(endpoint, Array.from({ length: 101 }, (_, index) => ({
    pair: `0x${(index + 1).toString(16).padStart(40, "0")}`
  }))), /between 1 and 100/);
  await assert.rejects(() => loadPoolDiscovery(endpoint, [{ pair: pairA }, { pair: pairA.toUpperCase().replace("0X", "0x") }]), /Duplicate requested discovery pool/);
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

  if (query.includes("WebPoolDiscovery")) {
    if (mode === "transport-failure") return new Response("unavailable", { status: 503 });
    if (mode === "batched-discovery" || mode === "batched-tail-failure") {
      discoveryBatchSizes.push(variables.pools.length);
      assert(variables.pools.length > 0 && variables.pools.length <= 100);
      if (mode === "batched-tail-failure" && variables.pools.length === 1) {
        return new Response("unavailable", { status: 503 });
      }
      return response({
        data: {
          poolDiscovery: variables.pools.map((request) => discoveryRow(request.pair))
        }
      });
    }
    assert(variables.pools.length === 1 || mode === "reversed-discovery");
    assert.equal(variables.pools[0].pair, pairA);
    if (mode === "missing-discovery") return response({ data: { poolDiscovery: [] } });
    const row = discoveryRow();
    if (mode === "malformed-metadata") row.marketMetadata.logoPath = "/docs";
    if (mode === "wrong-metadata-source") row.marketMetadata.source = "anything-else";
    if (mode === "null-metadata") row.marketMetadata = null;
    if (mode === "nullable-value") row.poolPriceQuotePerBaseE18 = null;
    if (mode === "zero-price") row.poolPriceQuotePerBaseE18 = "0";
    if (mode === "negative-change") row.priceChange24hE18 = "-100000000000000000";
    if (mode === "duplicate-discovery") return response({ data: { poolDiscovery: [row, { ...row }] } });
    if (mode === "foreign-discovery") return response({ data: { poolDiscovery: [{ ...row, pair: pairB }] } });
    if (mode === "reversed-discovery") return response({ data: { poolDiscovery: [{ ...row, pair: pairB }, row] } });
    if (mode === "too-many-closes") row.hourlyCloses = Array.from({ length: 25 }, (_, index) => ({
      ...row.hourlyCloses[0],
      startTimestamp: index * 3_600
    }));
    if (mode === "unaligned-close") row.hourlyCloses[0].startTimestamp = 3_601;
    return response({ data: { poolDiscovery: [row] } });
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

function discoveryRow(pairAddress = pairA) {
  return {
    pair: pairAddress,
    chainId: 31_337,
    tokenX,
    tokenY,
    displayBaseToken: tokenX,
    displayQuoteToken: tokenY,
    poolPriceQuotePerBaseE18: "160000000000000000000",
    hourlyCloses: [3_600, 7_200].map((startTimestamp, index) => ({
      startTimestamp,
      closeUsdE18: index === 0 ? "100000000000000000000" : "110000000000000000000",
      quoteToken: tokenY,
      finalized: true,
      revision: 1,
      priceSource: "active-bin-quote-usd",
      firstBlockHash: `0x${"4".repeat(64)}`,
      lastBlockHash: `0x${"5".repeat(64)}`
    })),
    priceChange24hE18: "100000000000000000",
    tvlUsdE18: "1000000000000000000000",
    lpNetSwapFees24hUsdE18: "1000000000000000000",
    volume24hUsdE18: "100000000000000000000",
    status: "READY",
    missingPriceTokens: [],
    asOfBlock: "99",
    asOfBlockHash: `0x${"6".repeat(64)}`,
    asOfTimestamp: 9_000,
    marketMetadata: {
      marketCapUsdE18: "10000000000000000000000",
      source: "dex-screener",
      fetchedAt: 9_000,
      logoPath: `/token-images/${"a".repeat(64)}`,
      logoSource: "dex-screener"
    }
  };
}

function address(value) {
  return `0x${value.toString(16).padStart(40, "0")}`;
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
