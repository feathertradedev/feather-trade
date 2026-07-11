import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  logLevel: "error",
  server: { middlewareMode: true }
});

try {
  const { buildPositionBurnPlan } = await server.ssrLoadModule("/src/position-burn-plan.ts");

  const ordered = buildPositionBurnPlan({
    burnBps: 2_500n,
    freshness: {},
    liveBalancesByBin: {
      "10": 1_000n,
      "2": 2_000n,
      "7": 3_000n
    },
    selectedPositions: [position("bin-10", "10", 9_999n), position("bin-2", "2", 9_999n), position("bin-7", "7", 9_999n)]
  });
  assert.equal(ordered.blocked, false);
  assert.deepEqual(ordered.ids, [2n, 7n, 10n]);
  assert.deepEqual(ordered.amounts, [500n, 750n, 250n]);

  const stalePartial = buildPositionBurnPlan({
    burnBps: 5_000n,
    freshness: {
      indexerStale: true,
      liveReadError: true,
      liveReadLoading: true,
      positionDataCapped: true,
      positionDataPartial: true
    },
    liveBalancesByBin: { "1": 1_000n },
    selectedPositions: [position("bin-1", 1, 1_000n)]
  });
  assertBlockers(stalePartial, ["position-data-partial", "position-data-capped", "stale-indexer", "live-read-loading", "live-read-error"]);
  assert.deepEqual(stalePartial.ids, []);
  assert.deepEqual(stalePartial.amounts, []);

  const zeroMissing = buildPositionBurnPlan({
    burnBps: 5_000n,
    freshness: {},
    liveBalancesByBin: {
      "1": 0n,
      "3": { error: true },
      "4": { loading: true }
    },
    selectedPositions: [position("bin-1", 1, 1_000n), position("bin-2", 2, 1_000n), position("bin-3", 3, 1_000n), position("bin-4", 4, 1_000n)]
  });
  assertBlockers(zeroMissing, ["live-balance-zero", "live-balance-missing", "live-read-error", "live-read-loading"]);

  const lowerLiveBalance = buildPositionBurnPlan({
    burnBps: 5_000n,
    freshness: {},
    liveBalancesByBin: new Map([[5n, 400n]]),
    selectedPositions: [position("bin-5", 5, 1_000n)]
  });
  assert.equal(lowerLiveBalance.blocked, false);
  assert.deepEqual(lowerLiveBalance.ids, [5n]);
  assert.deepEqual(lowerLiveBalance.amounts, [200n]);
  assert.match(lowerLiveBalance.warnings.join("\n"), /below indexed liquidity for bin 5/);

  const tooLarge = buildPositionBurnPlan({
    burnBps: 15_000n,
    freshness: {},
    liveBalancesByBin: { "6": 1_000n },
    selectedPositions: [position("bin-6", 6, 1_000n)]
  });
  assertBlockers(tooLarge, ["requested-burn-exceeds-live-balance"]);

  const zeroBps = buildPositionBurnPlan({
    burnBps: 0n,
    freshness: {},
    liveBalancesByBin: { "1": 1_000n },
    selectedPositions: [position("bin-1", 1, 1_000n)]
  });
  assertBlockers(zeroBps, ["invalid-burn-bps"]);

  const invalidBps = buildPositionBurnPlan({
    burnBps: "not-a-number",
    freshness: {},
    liveBalancesByBin: { "1": 1_000n },
    selectedPositions: [position("bin-1", 1, 1_000n)]
  });
  assertBlockers(invalidBps, ["invalid-burn-bps"]);

  const duplicateBin = buildPositionBurnPlan({
    burnBps: 5_000n,
    freshness: {},
    liveBalancesByBin: { "8": 1_000n },
    selectedPositions: [position("bin-8-a", "08", 1_000n), position("bin-8-b", 8, 1_000n)]
  });
  assertBlockers(duplicateBin, ["duplicate-bin-id"]);
  assert.deepEqual(duplicateBin.ids, []);
  assert.deepEqual(duplicateBin.amounts, []);

  const outOfRangeBin = buildPositionBurnPlan({
    burnBps: 5_000n,
    freshness: {},
    liveBalancesByBin: { "16777216": 1_000n },
    selectedPositions: [position("bin-16777216", 16_777_216n, 1_000n)]
  });
  assertBlockers(outOfRangeBin, ["bin-id-out-of-range"]);
  assert.deepEqual(outOfRangeBin.ids, []);
  assert.deepEqual(outOfRangeBin.amounts, []);

  const noSelection = buildPositionBurnPlan({
    burnBps: 5_000n,
    freshness: {},
    liveBalancesByBin: {},
    selectedPositions: []
  });
  assertBlockers(noSelection, ["no-selected-positions"]);

  const ready = buildPositionBurnPlan({
    burnBps: 10_000n,
    freshness: {},
    liveBalancesByBin: [
      { binId: "12", balance: 12_000n },
      { binId: "3", balance: 3_000n }
    ],
    selectedPositions: [position("bin-12", "12", 12_000n), position("bin-3", "3", 3_000n)]
  });
  assert.equal(ready.blocked, false);
  assert.deepEqual(ready.blockers, []);
  assert.deepEqual(ready.warnings, []);
  assert.deepEqual(ready.ids, [3n, 12n]);
  assert.deepEqual(ready.amounts, [3_000n, 12_000n]);
  assert.deepEqual(
    ready.items.map((item) => ({ amount: item.amount, binId: item.binId, liveBalance: item.liveBalance, positionId: item.positionId })),
    [
      { amount: 3_000n, binId: 3n, liveBalance: 3_000n, positionId: "bin-3" },
      { amount: 12_000n, binId: 12n, liveBalance: 12_000n, positionId: "bin-12" }
    ]
  );

  console.log(
    "Position burn plan fixture passed: sorted multi-bin amounts, stale/partial blockers, live read blockers, zero/missing/lower live balances, invalid BPS, duplicate/out-of-range bins, over-100% burn, no selection, and a ready plan."
  );
} finally {
  await server.close();
}

function position(id, binId, liquidity) {
  return { id, binId, liquidity };
}

function assertBlockers(result, expectedCodes) {
  for (const code of expectedCodes) {
    assert.ok(
      result.blockers.some((blocker) => blocker.code === code),
      `Expected blocker ${code}; received ${result.blockers.map((blocker) => blocker.code).join(", ")}`
    );
  }

  assert.equal(result.blocked, true);
}
