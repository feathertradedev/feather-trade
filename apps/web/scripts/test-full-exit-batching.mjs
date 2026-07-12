import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({ configFile: resolve(webRoot, "vite.config.ts"), logLevel: "error", server: { middlewareMode: true } });

try {
  const planner = await server.ssrLoadModule("/src/full-exit-batching.ts");
  const {
    FullExitBatchPlanningError,
    classifyFullExitJournalRecord,
    createFullExitStateSnapshot,
    createFullExitWorkflowKey,
    encodeFullExitBatchSettings,
    fullExitPinnedStateMatches,
    fullExitStateFingerprint,
    parseFullExitBatchSettings,
    parseFullExitStateFingerprint,
    parseFullExitWorkflowKey,
    planFullExitBatches
  } = planner;

  const ACCOUNT = "0x1111111111111111111111111111111111111111";
  const PAIR = "0x2222222222222222222222222222222222222222";
  const ROUTER = "0x3333333333333333333333333333333333333333";
  const BLOCK_A = `0x${"a".repeat(64)}`;
  const BLOCK_B = `0x${"b".repeat(64)}`;
  const workflowInput = {
    account: ACCOUNT,
    chainId: 31_337,
    deploymentEpoch: "31337|0|rpc|factory|router",
    environment: "localnet",
    pair: PAIR,
    recipient: ACCOUNT,
    router: ROUTER
  };
  const workflowKey = createFullExitWorkflowKey(workflowInput);
  assert.deepEqual(parseFullExitWorkflowKey(workflowKey), { ...workflowInput, version: 1 });
  assert.equal(createFullExitWorkflowKey({ ...workflowInput, account: ACCOUNT.toUpperCase().replace("0X", "0x"), recipient: ACCOUNT }), workflowKey);
  assert.throws(() => createFullExitWorkflowKey({ ...workflowInput, recipient: PAIR }), /recipient must equal/);
  assert.throws(() => parseFullExitWorkflowKey("[]"), /unsupported/);
  assert.throws(() => parseFullExitWorkflowKey(workflowKey.replace("localnet", "")), /non-empty|canonical/);

  const stateA = createFullExitStateSnapshot({
    bins: [
      { binId: 3, liveBalance: 30 },
      { binId: 1, liveBalance: 10 },
      { binId: 2, liveBalance: 0 }
    ],
    blockHash: BLOCK_A,
    blockNumber: 100,
    observedHeadBlockNumber: 101,
    workflowKey
  });
  assert.deepEqual(stateA.bins, [{ binId: 1n, liveBalance: 10n }, { binId: 3n, liveBalance: 30n }]);
  const fingerprintA = fullExitStateFingerprint(stateA);
  assert.deepEqual(parseFullExitStateFingerprint(fingerprintA).bins, stateA.bins);
  const headAdvanced = createFullExitStateSnapshot({ ...stateA, observedHeadBlockNumber: 999 });
  assert(fullExitPinnedStateMatches(stateA, headAdvanced), "head-only advance must not invalidate pinned state");
  assert(!fullExitPinnedStateMatches(stateA, { ...stateA, blockHash: BLOCK_B }), "block hash change must invalidate pinned state");
  assert(!fullExitPinnedStateMatches(stateA, { ...stateA, blockNumber: 101, observedHeadBlockNumber: 101 }), "state block change must invalidate pinned state");
  assert(!fullExitPinnedStateMatches(stateA, { ...stateA, bins: [...stateA.bins, { binId: 4, liveBalance: 40 }] }), "new transferred bin must invalidate pinned state");
  assert(!fullExitPinnedStateMatches(stateA, { ...stateA, bins: [{ binId: 1, liveBalance: 11 }, { binId: 3, liveBalance: 30 }] }), "live balance change must invalidate pinned state");
  assert.throws(() => createFullExitStateSnapshot({ ...stateA, bins: [{ binId: 1, liveBalance: 1 }, { binId: "1", liveBalance: 2 }] }), /Duplicate/);
  assert.throws(() => createFullExitStateSnapshot({ ...stateA, bins: [{ binId: 16_777_216, liveBalance: 1 }] }), /uint24/);
  assert.throws(() => createFullExitStateSnapshot({ ...stateA, bins: [{ binId: -1, liveBalance: 1 }] }), /non-negative/);
  assert.throws(() => createFullExitStateSnapshot({ ...stateA, observedHeadBlockNumber: 99 }), /cannot precede/);

  const settings = encodeFullExitBatchSettings({
    batchOrdinal: 1,
    bins: [{ binId: 3, liveBalance: 30 }],
    stateFingerprint: fingerprintA,
    workflowKey
  });
  assert.deepEqual(parseFullExitBatchSettings(settings).bins, [{ binId: 3n, liveBalance: 30n }]);
  assert.throws(() => encodeFullExitBatchSettings({ batchOrdinal: 1, bins: [{ binId: 3, liveBalance: 29 }], stateFingerprint: fingerprintA, workflowKey }), /exact pinned live balance/);
  assert.throws(() => encodeFullExitBatchSettings({ batchOrdinal: 0, bins: [{ binId: 3, liveBalance: 30 }], stateFingerprint: fingerprintA, workflowKey }), /at least 1/);
  const otherWorkflow = createFullExitWorkflowKey({ ...workflowInput, pair: "0x4444444444444444444444444444444444444444" });
  assert.throws(() => encodeFullExitBatchSettings({ batchOrdinal: 1, bins: [{ binId: 3, liveBalance: 30 }], stateFingerprint: fingerprintA, workflowKey: otherWorkflow }), /does not match/);
  assert.throws(() => parseFullExitBatchSettings(settings.replace("feather-full-exit-batch", "unknown")), /unsupported/);

  const bins = Array.from({ length: 4 }, (_, index) => ({ binId: index + 1, liveBalance: (index + 1) * 100 }));
  const baseLimits = {
    blockGasLimit: 1_000_000n,
    maxBlockGasBps: 8_000n,
    gasEstimateBufferBps: 12_500n,
    maxCalldataBytes: 1_000,
    maxCandidateBins: 3,
    maxProbeCount: 50
  };
  const safeProbe = async ({ bins: candidate }) => ({
    calldataBytes: 100 + candidate.length * 10,
    estimatedGas: BigInt(candidate.length) * 100_000n,
    status: "success"
  });
  for (const [count, expectedSizes] of [[2, [2]], [3, [3]], [4, [3, 1]]]) {
    const result = await planFullExitBatches({ bins: bins.slice(0, count), limits: baseLimits, probe: safeProbe });
    assert.deepEqual(result.batches.map((batch) => batch.bins.length), expectedSizes, `${count} bins must respect below/at/above cap`);
  }
  const exactPlan = await planFullExitBatches({ bins, limits: baseLimits, probe: safeProbe });
  assert.deepEqual(exactPlan.batches.flatMap((batch) => batch.bins.map((bin) => [bin.binId, bin.liveBalance])), bins.map((bin) => [BigInt(bin.binId), BigInt(bin.liveBalance)]), "planner burns exact current live amounts once");
  assert.equal(exactPlan.batches[0].bufferedGas, 375_000n);

  const recursive = await planFullExitBatches({
    bins: Array.from({ length: 6 }, (_, index) => ({ binId: index + 1, liveBalance: 1 })),
    limits: { ...baseLimits, blockGasLimit: 500_000n, maxCandidateBins: 6 },
    probe: async ({ bins: candidate }) => ({ calldataBytes: 100, estimatedGas: BigInt(candidate.length) * 150_000n, status: "success" })
  });
  assert.deepEqual(recursive.batches.map((batch) => batch.bins.length), [2, 1, 2, 1], "unsafe candidates split deterministically without skipping bins");
  assert.equal(recursive.probeCount, 7);

  const calldataSplit = await planFullExitBatches({
    bins: bins.slice(0, 3),
    limits: { ...baseLimits, maxCalldataBytes: 125 },
    probe: safeProbe
  });
  assert.deepEqual(calldataSplit.batches.map((batch) => batch.bins.length), [2, 1]);

  let semanticProbeCount = 0;
  await assert.rejects(
    () => planFullExitBatches({
      bins,
      limits: baseLimits,
      probe: async () => { semanticProbeCount += 1; return { diagnostic: "allowance revoked", status: "semantic-failure" }; }
    }),
    (error) => error instanceof FullExitBatchPlanningError && error.code === "semantic-failure" && error.binIds.length === 3
  );
  assert.equal(semanticProbeCount, 1, "semantic failure must never shrink or skip");
  await assert.rejects(
    () => planFullExitBatches({ bins: bins.slice(0, 1), limits: baseLimits, probe: async () => ({ diagnostic: "RPC down", status: "unavailable" }) }),
    (error) => error instanceof FullExitBatchPlanningError && error.code === "probe-unavailable"
  );
  for (const malformed of [
    { calldataBytes: 0, estimatedGas: 1n, status: "success" },
    { calldataBytes: -1, estimatedGas: 1n, status: "success" },
    { calldataBytes: 1.5, estimatedGas: 1n, status: "success" },
    { calldataBytes: 1, estimatedGas: 0n, status: "success" }
  ]) {
    await assert.rejects(
      () => planFullExitBatches({ bins: bins.slice(0, 1), limits: baseLimits, probe: async () => malformed }),
      (error) => error instanceof FullExitBatchPlanningError && error.code === "probe-unavailable"
    );
  }
  await assert.rejects(
    () => planFullExitBatches({ bins: bins.slice(0, 1), limits: { ...baseLimits, blockGasLimit: 100_000n }, probe: safeProbe }),
    (error) => error instanceof FullExitBatchPlanningError && error.code === "single-bin-unsafe" && error.binIds[0] === 1n && /bin 1/.test(error.message)
  );
  await assert.rejects(
    () => planFullExitBatches({ bins, limits: { ...baseLimits, blockGasLimit: 100_000n, maxProbeCount: 2 }, probe: safeProbe }),
    (error) => error instanceof FullExitBatchPlanningError && error.code === "probe-exhausted" && error.probeCount === 2
  );
  await assert.rejects(
    () => planFullExitBatches({ bins: stateA.bins, limits: baseLimits, probe: safeProbe, stateFingerprint: fullExitStateFingerprint({ ...stateA, bins: [{ binId: 1, liveBalance: 999 }] }) }),
    (error) => error instanceof FullExitBatchPlanningError && error.code === "invalid-input"
  );
  await assert.rejects(() => planFullExitBatches({ bins, limits: { ...baseLimits, maxCandidateBins: 0 }, probe: safeProbe }), /maximum candidate bins/);
  await assert.rejects(() => planFullExitBatches({ bins: [{ binId: 1, liveBalance: 1 }, { binId: "1", liveBalance: 1 }], limits: baseLimits, probe: safeProbe }), /Duplicate/);

  const transferPlan = await planFullExitBatches({ bins: [...bins, { binId: 9, liveBalance: 9 }], limits: baseLimits, probe: safeProbe });
  assert(transferPlan.batches.flatMap((batch) => batch.bins).some((bin) => bin.binId === 9n), "new positive transferred bin must be planned");
  const zeroFiltered = await planFullExitBatches({ bins: [{ binId: 1, liveBalance: 0 }, { binId: 2, liveBalance: 2 }], limits: baseLimits, probe: safeProbe });
  assert.deepEqual(zeroFiltered.batches.flatMap((batch) => batch.bins), [{ binId: 2n, liveBalance: 2n }]);

  const journalBase = {
    confirmations: 2,
    receiptStatus: "success",
    replacementCompatibility: null,
    replacementFinalized: false,
    status: "canonical"
  };
  assert.deepEqual(classifyFullExitJournalRecord(journalBase), {
    blocksNextBatch: true,
    countsCompletedBatch: false,
    finalityReached: false,
    kind: "blocking",
    shouldReplan: false
  });
  assert.deepEqual(classifyFullExitJournalRecord({ ...journalBase, confirmations: 12 }), {
    blocksNextBatch: false,
    countsCompletedBatch: true,
    finalityReached: true,
    kind: "finalized-success",
    shouldReplan: true
  });
  assert.equal(classifyFullExitJournalRecord({ ...journalBase, confirmations: 2, receiptStatus: "reverted", status: "reverted" }).kind, "blocking");
  assert.deepEqual(classifyFullExitJournalRecord({ ...journalBase, confirmations: 12, receiptStatus: "reverted", status: "reverted" }), {
    blocksNextBatch: false,
    countsCompletedBatch: false,
    finalityReached: true,
    kind: "finalized-failure",
    shouldReplan: true
  });
  assert.equal(classifyFullExitJournalRecord({ ...journalBase, receiptStatus: null, status: "rejected" }).kind, "retry");
  assert.equal(classifyFullExitJournalRecord({ ...journalBase, receiptStatus: null, status: "unknown-submission" }).kind, "blocking");
  assert.equal(classifyFullExitJournalRecord({ ...journalBase, receiptStatus: null, status: "orphaned" }).kind, "blocking");
  assert.equal(classifyFullExitJournalRecord({ ...journalBase, receiptStatus: null, status: "timed-out" }).kind, "blocking");
  assert.equal(classifyFullExitJournalRecord({ ...journalBase, confirmations: 11, receiptStatus: "success", replacementCompatibility: "incompatible", replacementFinalized: true, status: "replaced" }).kind, "blocking");
  assert.equal(classifyFullExitJournalRecord({ ...journalBase, confirmations: 12, receiptStatus: "success", replacementCompatibility: "incompatible", replacementFinalized: true, status: "replaced" }).kind, "finalized-failure");
  assert.throws(() => classifyFullExitJournalRecord({ ...journalBase, receiptStatus: null }), /successful receipt/);

  console.log("full-exit batching tests passed");
} finally {
  await server.close();
}
