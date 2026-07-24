import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  root: webRoot,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true }
});

try {
  const {
    formatPoolCreationElapsed,
    poolCreationProgress
  } = await server.ssrLoadModule("/src/pool-creation-progress.ts");

  assert.deepEqual(stage(poolCreationProgress, null, null, false), [0, "Ready for wallet review", false, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("awaiting-wallet"), null, false), [0, "Waiting for your wallet", false, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("submitted"), null, false), [1, "Transaction submitted", true, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("confirming", { confirmations: 1 }), null, false), [2, "Waiting for confirmation", true, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("canonical"), null, false), [3, "Confirmed on-chain", true, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("timed-out"), null, false), [1, "Confirmation is taking longer than expected", true, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("unknown-submission", { activeHash: null }), null, false), [0, "Checking submission status", true, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("rejected"), null, false), [0, "Creation was not submitted", false, true]);
  assert.deepEqual(stage(poolCreationProgress, journal("reverted"), null, false), [3, "Creation reverted on-chain", false, true]);
  assert.deepEqual(stage(poolCreationProgress, journal("orphaned"), null, false), [1, "Confirmation changed after a chain reorganization", true, false]);

  const createdEmpty = recovery("created-empty");
  assert.deepEqual(stage(poolCreationProgress, journal("canonical"), createdEmpty, false), [5, "Empty pool confirmed · discovery catching up", true, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("canonical"), createdEmpty, true), [6, "Empty pool ready", false, true]);
  assert.deepEqual(stage(poolCreationProgress, journal("canonical"), recovery("canonical-confirmation"), false), [4, "Pool identity verified", true, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("canonical"), recovery("indexing-lag"), false), [5, "Pool verified · discovery catching up", true, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("reconciling"), recovery("ambiguous-submission", { transactionHash: null }), false), [0, "Checking whether the wallet broadcast", true, false]);
  assert.deepEqual(stage(poolCreationProgress, journal("reconciling"), recovery("ambiguous-submission"), false), [1, "Transaction found · waiting for confirmation", true, false]);

  assert.equal(formatPoolCreationElapsed(1_000, 1_000), "just now");
  assert.equal(formatPoolCreationElapsed(1_000, 31_000), "30s");
  assert.equal(formatPoolCreationElapsed(1_000, 126_000), "2m 5s");
  assert.equal(formatPoolCreationElapsed(1_000, 3_662_000), "1h 1m");

  console.log("Pool creation progress fixture passed: authoritative stages, timeout/reorg recovery, durable readiness, and elapsed-time copy.");
} finally {
  await server.close();
}

function stage(progressBuilder, journalRecord, recoveryState, discovered) {
  const progress = progressBuilder(journalRecord, recoveryState, discovered);
  return [progress.verifiedStep, progress.title, progress.canCheckStatus, progress.canStartFreshReview];
}

function journal(status, overrides = {}) {
  return {
    activeHash: `0x${"1".repeat(64)}`,
    confirmations: 0,
    status,
    ...overrides
  };
}

function recovery(kind, overrides = {}) {
  return {
    kind,
    pool: {
      activeId: 8_388_608n,
      binStep: 20n,
      pair: "0x0000000000000000000000000000000000000001",
      priceQ128: 1n,
      reserveX: 0n,
      reserveY: 0n,
      tokenX: "0x0000000000000000000000000000000000000002",
      tokenY: "0x0000000000000000000000000000000000000003"
    },
    transactionHash: `0x${"1".repeat(64)}`,
    ...overrides
  };
}
