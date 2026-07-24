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
    buildCenteredBinDistribution,
    buildCandleChartModel,
    createPoolManageSelectionIntent,
    formatRatioPercentE18,
    formatUsdE18,
    joinPoolWorkspaceRows,
    parsePoolManageSelectionIntent,
    poolManageSelectionIntentHref,
    resolvePoolManageSelectionIntent,
    shouldShowWorkspaceAnalyticsState,
    sortPoolWorkspaceRows,
    summarizePoolPosition,
    workspaceAnalyticsState,
    workspaceMetricTiles
  } = await server.ssrLoadModule("/src/pool-workspace.ts");
  const { coalescePositionHistory } = await server.ssrLoadModule("/src/data.ts");

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
  assert.deepEqual(joined.map((row) => row.analyticsIssue), [null, null, "Pool analytics are missing from this result."]);
  assert.deepEqual(sortPoolWorkspaceRows(joined, "tvl").map((row) => row.pool.address), [pairA, pairB, pairC]);
  assert.deepEqual(sortPoolWorkspaceRows(joined, "volume24h").map((row) => row.pool.address), [pairB, pairA, pairC]);
  assert.throws(() => joinPoolWorkspaceRows(pools, { status: "READY", rows: [metrics.rows[0], metrics.rows[0]] }), /Duplicate pool analytics metric/);
  const mismatched = joinPoolWorkspaceRows([pool(pairA)], {
    status: "READY",
    rows: [{ ...metrics.rows[0], tokenX: tokenY }]
  });
  assert.equal(mismatched[0].metric, null);
  assert.equal(mismatched[0].analyticsStatus, "PARTIAL");
  assert.match(mismatched[0].analyticsIssue, /token identity/);
  const ready = joinPoolWorkspaceRows([pool(pairA)], { status: "READY", rows: [metrics.rows[0]] });
  assert.equal(ready[0].analyticsStatus, "READY");
  assert.equal(ready[0].analyticsIssue, null);

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

  const centeredDistribution = buildCenteredBinDistribution([
    bin("8388606", "5000000", "0", "20"),
    bin("8388608", "10000000", "2000000000000000000", "10"),
    bin("8388610", "0", "3000000000000000000", "30")
  ], "8388608", 6, 18, 2);
  assert.deepEqual(centeredDistribution.map((point) => point.binId), ["8388606", "8388607", "8388608", "8388609", "8388610"]);
  assert.equal(centeredDistribution[2].active, true);
  assert.equal(centeredDistribution[1].tokenX, "0");
  assert.equal(centeredDistribution[1].tokenY, "0");
  assert.equal(centeredDistribution[4].tokenY, "3");
  const zeroActiveDistribution = buildCenteredBinDistribution([
    bin("8388607", "1", "0", "1"),
    bin("8388609", "0", "1", "1")
  ], "8388608", 18, 18, 1);
  assert.equal(zeroActiveDistribution.length, 3);
  assert.equal(zeroActiveDistribution[1].active, true);
  assert.equal(zeroActiveDistribution[1].tokenX, "0");
  assert.equal(zeroActiveDistribution[1].tokenY, "0");
  assert.equal(zeroActiveDistribution[1].lbSupply, "0");
  assert.throws(() => buildCenteredBinDistribution([], "8388608", 18, 18, 0), /radius/);
  assert.throws(() => buildCenteredBinDistribution([bin("1", "0", "0", "0"), bin("1", "0", "0", "0")], "1", 18, 18, 1), /Duplicate pool bin/);
  assert.throws(() => buildCenteredBinDistribution([], "16777216", 18, 18, 1), /uint24/);

  const positionSummary = summarizePoolPosition([
    position("range-b", "101", "3000000000000000000", "8"),
    position("closed", "99", "0", "12"),
    position("range-a", "100", "2000000000000000000", "7")
  ], "100");
  assert.deepEqual(positionSummary, {
    binCount: 2,
    inActiveBin: true,
    latestBlock: "8",
    liquidity: "5000000000000000000",
    maxBinId: "101",
    minBinId: "100",
    positionIds: ["range-a", "range-b"]
  });
  assert.equal(summarizePoolPosition([position("closed", "99", "0", "12")], "99"), null);
  assert.equal(summarizePoolPosition([position("range-a", "100", "1", "7"), position("range-c", "102", "1", "7")], "101")?.inActiveBin, false);

  const manageIntent = createPoolManageSelectionIntent([
    position("analytics-range-b", "101", "3", "8"),
    position("analytics-range-a", "100", "2", "7")
  ], pairB, pairA);
  assert.deepEqual(manageIntent, {
    binIds: ["100", "101"],
    owner: pairB,
    pair: pairA
  });
  assert.deepEqual(resolvePoolManageSelectionIntent(manageIntent, [
    position("indexer-position-100", "100", "2", "9"),
    position("indexer-position-101", "101", "3", "9"),
    position("indexer-position-102", "102", "4", "9")
  ], pairB, pairA), {
    positionIds: ["indexer-position-100", "indexer-position-101"],
    status: "ready"
  });
  assert.equal(resolvePoolManageSelectionIntent(
    manageIntent,
    [position("indexer-position-100", "100", "2", "9")],
    pairB,
    pairA
  ).status, "incomplete");
  assert.equal(resolvePoolManageSelectionIntent(
    manageIntent,
    [position("indexer-position-100", "100", "2", "9"), position("indexer-position-101", "101", "3", "9")],
    tokenX,
    pairA
  ).status, "scope-mismatch");
  const manageHref = poolManageSelectionIntentHref(
    `#/pools/${pairA}/manage?returnTo=%23%2Fpools%3Fsort%3Dtvl`,
    manageIntent
  );
  assert.match(manageHref, /^#\/pools\/.+\/manage\?/);
  assert.equal(new URLSearchParams(manageHref.split("?")[1]).get("returnTo"), "#/pools?sort=tvl");
  assert.deepEqual(parsePoolManageSelectionIntent(manageHref, pairA), {
    intent: manageIntent,
    status: "ready"
  });
  assert.deepEqual(parsePoolManageSelectionIntent(`#/pools/${pairA}/manage`, pairA), {
    intent: null,
    status: "absent"
  });
  assert.equal(parsePoolManageSelectionIntent(
    `#/pools/${pairA}/manage?manageOwner=${pairB}&manageBins=100%2C100`,
    pairA
  ).status, "invalid");
  assert.equal(resolvePoolManageSelectionIntent(
    { binIds: [], owner: pairB, pair: pairA },
    [],
    pairB,
    pairA
  ).status, "invalid");

  const deposit = history("deposit", "DEPOSIT", "0xaaa", ["101", "100"]);
  const mintEcho = history("mint", "TRANSFER_IN", "0xaaa", ["100", "101"]);
  const transfer = history("transfer", "TRANSFER_OUT", "0xbbb", ["100"]);
  assert.deepEqual(coalescePositionHistory([deposit, mintEcho, transfer]).map((row) => row.id), ["deposit", "transfer"]);

  const staleHealth = {
    status: "READY", headBlock: "99", headHash: null, headTimestamp: 100, canonicalBlockCount: 1, reorgCount: 0,
    partialEventCount: 2, missingPriceTokens: [tokenX], fresh: false, headLagSeconds: 90, maxHeadLagSeconds: 60,
    backfillStatus: "running", backfillCursor: "10", backfillError: null, coverageStartTimestamp: "0",
    coverageThroughTimestamp: "90", prices: []
  };
  const healthState = workspaceAnalyticsState("READY", staleHealth);
  assert.equal(healthState.status, "PARTIAL");
  assert.match(healthState.detail, /90s behind/);
  assert.match(healthState.detail, /history backfill is running/);
  assert.match(healthState.detail, /2 partial events/);
  assert.match(healthState.detail, /1 token price unavailable/);
  assert.equal(workspaceAnalyticsState("UNAVAILABLE", null).status, "UNAVAILABLE");
  assert.equal(shouldShowWorkspaceAnalyticsState("READY", null), false);
  assert.equal(shouldShowWorkspaceAnalyticsState("PARTIAL", null), true);
  assert.equal(shouldShowWorkspaceAnalyticsState("READY", staleHealth), true);

  console.log("Pool workspace fixture passed: economic joins/sorts, candle and bin models, owner position summaries, deduplicated history, and freshness semantics.");
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
    pair, tokenX, tokenY, tvlUsdE18: "0", volume24hUsdE18: "0", totalSwapFees24hUsdE18: "0",
    protocolSwapFees24hUsdE18: null, lpFees24hUsdE18: null, feeToTvlE18: "0", feeBreakdownComplete: false,
    priceUsdE18: "1000000000000000000", asOfBlock: "99", asOfTimestamp: 100,
    status: "READY", missingPriceTokens: [], ...overrides
  };
}

function candle(startTimestamp, closeUsdE18, status) {
  return {
    pair: pairA, interval: "HOUR", startTimestamp, endTimestamp: startTimestamp + 3_600,
    openUsdE18: closeUsdE18, highUsdE18: closeUsdE18, lowUsdE18: closeUsdE18, closeUsdE18,
    volumeUsdE18: closeUsdE18 === null ? null : "0", totalSwapFeesUsdE18: "0",
    protocolSwapFeesUsdE18: closeUsdE18 === null ? null : "0", lpFeesUsdE18: closeUsdE18 === null ? null : "0",
    feeBreakdownComplete: closeUsdE18 !== null,
    tvlUsdE18: closeUsdE18, swapCount: closeUsdE18 === null ? 0 : 1, status,
    missingPriceTokens: closeUsdE18 === null ? [tokenX] : [], firstBlock: "1", lastBlock: "2"
  };
}

function bin(binId, reserveX, reserveY, totalSupply) {
  return { id: `bin-${binId}`, binId, reserveX, reserveY, totalSupply, updatedAtBlock: "1" };
}

function position(id, binId, liquidity, updatedAtBlock) {
  return { id, owner: pairB, pair: pairA, binId, liquidity, updatedAtBlock };
}

function history(id, type, transactionHash, binIds) {
  return {
    id, type, transactionHash, blockNumber: "9", timestamp: "1720000000", amountX: null, amountY: null,
    binIds, sender: pairB, to: pairB
  };
}
