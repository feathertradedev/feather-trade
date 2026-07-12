import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pairA = "0x00000000000000000000000000000000000000a1";
const pairB = "0x00000000000000000000000000000000000000b2";
const pairC = "0x00000000000000000000000000000000000000c3";
const tokenX = "0x00000000000000000000000000000000000000d4";
const tokenY = "0x00000000000000000000000000000000000000e5";

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  root: webRoot,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true }
});

try {
  const {
    buildBinDistribution,
    buildCandleChartModel,
    formatRatioPercentE18,
    formatUsdE18,
    joinPoolWorkspaceRows,
    sortPoolWorkspaceRows,
    workspaceAnalyticsState,
    workspaceMetricTiles
  } = await server.ssrLoadModule("/src/pool-workspace.ts");

  const pools = [pool(pairA), pool(pairB), pool(pairC)];
  const metrics = {
    status: "PARTIAL",
    rows: [
      metric(pairA, { tvlUsdE18: "100000000000000000000", volume24hUsdE18: "0", status: "READY" }),
      metric(pairB, { tvlUsdE18: null, volume24hUsdE18: "50000000000000000000", status: "PARTIAL" })
    ]
  };
  const joined = joinPoolWorkspaceRows(pools, metrics);
  assert.deepEqual(joined.map((row) => row.analyticsStatus), ["PARTIAL", "PARTIAL", "PARTIAL"]);
  assert.deepEqual(sortPoolWorkspaceRows(joined, "tvl").map((row) => row.pool.address), [pairA, pairB, pairC]);
  assert.deepEqual(sortPoolWorkspaceRows(joined, "volume24h").map((row) => row.pool.address), [pairB, pairA, pairC]);

  const tiles = workspaceMetricTiles(metrics.rows[0]);
  assert.deepEqual(tiles.map((tile) => tile.label), ["TVL", "24h volume", "24h LP fees", "24h LP fee / TVL", "Indexed price"]);
  assert.equal(tiles[0].value, "$100");
  assert.equal(tiles[1].value, "$0");
  assert.equal(tiles[2].value, "Unavailable");
  assert.equal(tiles[2].status, "UNAVAILABLE");
  assert.equal(formatUsdE18("123456789123456789123456789"), "$123,456,789.12");
  assert.equal(formatUsdE18("1"), "<$0.01");
  assert.equal(formatRatioPercentE18("12500000000000000"), "1.25%");
  assert.equal(formatRatioPercentE18("1"), "<0.01%");

  const candles = buildCandleChartModel({
    status: "PARTIAL",
    rows: [
      candle(7_200, "2000000000000000000", "READY"),
      candle(3_600, "1000000000000000000", "READY"),
      candle(14_400, null, "PARTIAL")
    ]
  });
  assert.deepEqual(candles.points.map((point) => point.startTimestamp), [3_600, 7_200, 14_400]);
  assert.deepEqual(candles.points.map((point) => point.normalizedClose), [0, 100, null]);
  assert.equal(candles.points[0].volume, "$0");
  assert.equal(candles.points[2].close, "Unavailable");
  assert.equal(candles.hasGaps, true);
  assert.equal(candles.status, "PARTIAL");

  const distribution = buildBinDistribution([
    bin("8388609", "5000000", "0", "20"),
    bin("8388608", "10000000", "2000000000000000000", "10")
  ], "8388608", 6, 18);
  assert.deepEqual(distribution.map((point) => point.binId), ["8388608", "8388609"]);
  assert.equal(distribution[0].active, true);
  assert.equal(distribution[0].tokenX, "10");
  assert.equal(distribution[0].tokenY, "2");
  assert.equal(distribution[0].tokenXHeight, 100);
  assert.equal(distribution[0].tokenYHeight, 100);
  assert.equal(distribution[1].lbSupplyHeight, 100);
  assert.throws(() => buildBinDistribution([bin("1", "0", "0", "0"), bin("1", "0", "0", "0")], "1", 18, 18), /Duplicate pool bin/);

  const healthState = workspaceAnalyticsState("READY", {
    status: "READY", headBlock: "99", headHash: null, headTimestamp: 100, canonicalBlockCount: 1, reorgCount: 0,
    partialEventCount: 2, missingPriceTokens: [tokenX], fresh: false, headLagSeconds: 90, maxHeadLagSeconds: 60,
    backfillStatus: "running", backfillCursor: "10", backfillError: null, coverageStartTimestamp: "0",
    coverageThroughTimestamp: "90", prices: []
  });
  assert.equal(healthState.status, "PARTIAL");
  assert.match(healthState.detail, /90s behind/);
  assert.match(healthState.detail, /history backfill is running/);
  assert.match(healthState.detail, /2 partial events/);
  assert.match(healthState.detail, /1 token price unavailable/);
  assert.equal(workspaceAnalyticsState("UNAVAILABLE", null).status, "UNAVAILABLE");

  console.log("Pool workspace fixture passed: economic joins/sorts, null-zero truth, candle gaps/table data, bin distribution, and freshness semantics.");
} finally {
  await server.close();
}

function pool(address) {
  return {
    id: address, address, tokenXAddress: tokenX, tokenYAddress: tokenY, tokenX: null, tokenY: null,
    activeId: "8388608", binStep: "25", reserveX: "1", reserveY: "1", volumeX: "0", volumeY: "0",
    feesX: "0", feesY: "0", factoryAddress: pairC, hooksParameters: null, ignoredForRouting: false,
    swapCount: "1", depositCount: "1", updatedAtBlock: "1"
  };
}

function metric(pair, overrides) {
  return {
    pair, tokenX, tokenY, tvlUsdE18: "0", volume24hUsdE18: "0", lpFees24hUsdE18: null,
    feeToTvlE18: "0", priceUsdE18: "1000000000000000000", asOfBlock: "99", asOfTimestamp: 100,
    status: "READY", missingPriceTokens: [], ...overrides
  };
}

function candle(startTimestamp, closeUsdE18, status) {
  return {
    pair: pairA, interval: "HOUR", startTimestamp, endTimestamp: startTimestamp + 3_600,
    openUsdE18: closeUsdE18, highUsdE18: closeUsdE18, lowUsdE18: closeUsdE18, closeUsdE18,
    volumeUsdE18: closeUsdE18 === null ? null : "0", lpFeesUsdE18: closeUsdE18 === null ? null : "0",
    tvlUsdE18: closeUsdE18, swapCount: closeUsdE18 === null ? 0 : 1, status,
    missingPriceTokens: closeUsdE18 === null ? [tokenX] : [], firstBlock: "1", lastBlock: "2"
  };
}

function bin(binId, reserveX, reserveY, totalSupply) {
  return { id: `bin-${binId}`, binId, reserveX, reserveY, totalSupply, updatedAtBlock: "1" };
}
