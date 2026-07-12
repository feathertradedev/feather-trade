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
  const journal = await server.ssrLoadModule("/src/transaction-journal.ts");
  const {
    TRANSACTION_JOURNAL_CONFIRMATIONS,
    TRANSACTION_JOURNAL_MAX_RECORDS,
    TRANSACTION_JOURNAL_MONITOR_BATCH_SIZE,
    TRANSACTION_JOURNAL_STORAGE_KEY,
    TRANSACTION_JOURNAL_TIMEOUT_MS,
    TRANSACTION_JOURNAL_TIMED_OUT_POLL_MS,
    TRANSACTION_WALLET_LEASE_MS,
    applyTransactionObservation,
    beginTransactionIntent,
    emptyTransactionJournal,
    deferTransactionMonitoring,
    isUserRejectedSubmission,
    loadTransactionJournal,
    mergeTransactionJournals,
    persistTransactionJournal,
    recordAbortedSubmission,
    recordRejectedSubmission,
    recordSubmittedHash,
    recordUnknownSubmission,
    recoverAwaitingWalletIntents,
    recordsForScope,
    selectTransactionRecordsForMonitoring,
    transactionFamilyRetryBlocked,
    transactionRecordBlocksIntentFamily,
    transactionRetryBlocked,
    transactionNeedsMonitoring,
    updateObservedTransaction
  } = journal;

  const ADDRESS = "0x1111111111111111111111111111111111111111";
  const TARGET = "0x2222222222222222222222222222222222222222";
  const RECIPIENT = "0x3333333333333333333333333333333333333333";
  const HASH_A = `0x${"a".repeat(64)}`;
  const HASH_B = `0x${"b".repeat(64)}`;
  const BLOCK_A = `0x${"c".repeat(64)}`;
  const BLOCK_B = `0x${"d".repeat(64)}`;
  const CALLDATA = `0x${"e".repeat(64)}`;
  const now = 1_800_000_000_000;

  function reviewed(intent = "swap", overrides = {}) {
    return {
      account: ADDRESS,
      calldataFingerprint: CALLDATA,
      chainId: 31_337,
      contractsFingerprint: "factory|router|pair-implementation",
      deploymentEpoch: "31337|0|rpc|factory|router",
      environment: "localnet",
      executionFingerprint: `${intent}-execution-v1`,
      intent,
      poolId: "pool-1",
      recipient: RECIPIENT,
      refundRecipient: RECIPIENT,
      settingsFingerprint: `${intent}|amount|slippage|deadline|range|strategy`,
      target: TARGET,
      value: "0",
      ...overrides
    };
  }

  function begin(intent = "swap", overrides = {}) {
    return beginTransactionIntent(emptyTransactionJournal(), reviewed(intent, overrides), { expectedNonce: 7n, submissionBlock: 99n }, now, `${intent}-intent`);
  }

  function tx(overrides = {}) {
    return {
      blockHash: null,
      blockNumber: null,
      calldataFingerprint: CALLDATA,
      from: ADDRESS,
      hash: HASH_A,
      nonce: "7",
      target: TARGET,
      value: "0",
      ...overrides
    };
  }

  function observation(overrides = {}) {
    return {
      canonicalBlockHash: null,
      canonicalBlockLookup: overrides.canonicalBlockHash ? "found" : "missing",
      headBlockNumber: "100",
      latestNonce: "7",
      now: now + 1_000,
      pendingNonce: "8",
      receiptLookup: "missing",
      receipt: null,
      scannedThroughBlock: "100",
      transaction: tx(),
      transactionLookup: "found",
      ...overrides
    };
  }

  for (const intent of ["approval", "create-pool", "add-liquidity", "swap", "remove-liquidity"]) {
    const state = begin(intent);
    const record = state.records[0];
    assert.equal(record.reviewed.intent, intent, `${intent} must be a durable write class`);
    assert.equal(record.status, "awaiting-wallet");
    assert.equal(record.expectedNonce, "7");
    assert.equal(record.actualNonce, null);
    assert.equal(record.submissionBlock, "99");
    assert.equal(record.reviewed.account, ADDRESS);
    assert.equal(record.reviewed.recipient, RECIPIENT);
    assert.equal(record.reviewed.refundRecipient, RECIPIENT);
    assert.equal(record.reviewed.value, "0");
    assert(Object.isFrozen(record.reviewed));
    assert(transactionRetryBlocked(state, record.reviewed));
  }

  let state = begin();
  state = recordSubmittedHash(state, "swap-intent", 0, HASH_A, now + 100);
  assert.equal(state.records[0].status, "submitted");
  assert.equal(state.records[0].hashes[0].hash, HASH_A);
  const initialRevision = state.records[0].lifecycleRevision;
  state = updateObservedTransaction(state, "swap-intent", initialRevision - 1, observation());
  assert.equal(state.records[0].status, "submitted", "stale reconciliation result must not overwrite a newer revision");

  state = updateObservedTransaction(state, "swap-intent", initialRevision, observation());
  assert.equal(state.records[0].status, "submitted");
  assert.equal(state.records[0].actualNonce, "7");

  let confirming = applyTransactionObservation(
    state.records[0],
    observation({
      canonicalBlockHash: BLOCK_A,
      headBlockNumber: "100",
      receipt: { blockHash: BLOCK_A, blockNumber: "100", hash: HASH_A, status: "success" },
      transaction: tx({ blockHash: BLOCK_A, blockNumber: "100" })
    }),
    TRANSACTION_JOURNAL_CONFIRMATIONS
  );
  assert.equal(confirming.status, "confirming");
  assert.equal(confirming.confirmations, 1);

  const canonical = applyTransactionObservation(
    confirming,
    observation({
      canonicalBlockHash: BLOCK_A,
      headBlockNumber: "101",
      receipt: { blockHash: BLOCK_A, blockNumber: "100", hash: HASH_A, status: "success" },
      transaction: tx({ blockHash: BLOCK_A, blockNumber: "100" })
    }),
    TRANSACTION_JOURNAL_CONFIRMATIONS
  );
  assert.equal(canonical.status, "canonical");
  assert.equal(canonical.confirmations, 2);
  assert(transactionNeedsMonitoring(canonical), "recent canonical receipt remains reorg-monitored");
  assert(!transactionNeedsMonitoring({ ...canonical, confirmations: 12 }), "deep canonical receipt leaves the hot monitor loop");
  assert(!transactionRetryBlocked({ ...state, records: [canonical] }, canonical.reviewed));

  const orphaned = applyTransactionObservation(
    canonical,
    observation({ canonicalBlockHash: BLOCK_B, receipt: null, transaction: null })
  );
  assert.equal(orphaned.status, "orphaned", "receipt disappearance must demote canonical success");
  assert(transactionRetryBlocked({ ...state, records: [orphaned] }, orphaned.reviewed));

  const reincluded = applyTransactionObservation(
    orphaned,
    observation({
      canonicalBlockHash: BLOCK_B,
      headBlockNumber: "104",
      receipt: { blockHash: BLOCK_B, blockNumber: "102", hash: HASH_A, status: "success" },
      transaction: tx({ blockHash: BLOCK_B, blockNumber: "102" })
    })
  );
  assert.equal(reincluded.status, "canonical", "canonical re-inclusion must recover an orphaned record");

  const reverted = applyTransactionObservation(
    state.records[0],
    observation({
      canonicalBlockHash: BLOCK_A,
      receipt: { blockHash: BLOCK_A, blockNumber: "100", hash: HASH_A, status: "reverted" }
    })
  );
  assert.equal(reverted.status, "reverted");
  assert.equal(reverted.confirmations, 1);
  assert(transactionNeedsMonitoring(reverted), "a shallow reverted receipt remains reorg-monitored");
  assert(transactionRetryBlocked({ ...state, records: [reverted] }, reverted.reviewed), "a shallow revert must remain retry-blocking");
  assert(transactionRecordBlocksIntentFamily(reverted));
  assert.notEqual(reverted.status, "canonical");
  const finalizedRevert = applyTransactionObservation(
    reverted,
    observation({
      canonicalBlockHash: BLOCK_A,
      headBlockNumber: "111",
      receipt: { blockHash: BLOCK_A, blockNumber: "100", hash: HASH_A, status: "reverted" }
    })
  );
  assert.equal(finalizedRevert.confirmations, 12);
  assert(!transactionNeedsMonitoring(finalizedRevert));
  assert(!transactionRetryBlocked({ ...state, records: [finalizedRevert] }, finalizedRevert.reviewed));
  assert(!transactionRecordBlocksIntentFamily(finalizedRevert));
  const orphanedRevert = applyTransactionObservation(
    reverted,
    observation({ canonicalBlockHash: null, receipt: null, transaction: null })
  );
  assert.equal(orphanedRevert.status, "orphaned", "a reverted receipt must be demoted when its canonical evidence disappears");
  assert(transactionRecordBlocksIntentFamily(orphanedRevert));
  const noncanonicalRevert = applyTransactionObservation(
    reverted,
    observation({
      canonicalBlockHash: BLOCK_B,
      receipt: { blockHash: BLOCK_A, blockNumber: "100", hash: HASH_A, status: "reverted" }
    })
  );
  assert.equal(noncanonicalRevert.status, "orphaned", "a reverted receipt must be demoted when its block hash is no longer canonical");
  const unavailableRevert = applyTransactionObservation(
    reverted,
    observation({ canonicalBlockHash: null, canonicalBlockLookup: "unavailable", receiptLookup: "unavailable", transactionLookup: "unavailable" })
  );
  assert.equal(unavailableRevert.status, "reverted", "unavailable lookups preserve prior reverted evidence");
  assert.equal(unavailableRevert.canonicalReceipt?.hash, HASH_A);
  const successfulReinclusion = applyTransactionObservation(
    orphanedRevert,
    observation({
      canonicalBlockHash: BLOCK_B,
      headBlockNumber: "113",
      receipt: { blockHash: BLOCK_B, blockNumber: "102", hash: HASH_A, status: "success" },
      transaction: tx({ blockHash: BLOCK_B, blockNumber: "102" })
    })
  );
  assert.equal(successfulReinclusion.status, "canonical", "a reorged revert may re-enter canon as a successful matching transaction");

  const replacement = applyTransactionObservation(
    state.records[0],
    observation({ transaction: tx({ hash: HASH_B }) })
  );
  assert.equal(replacement.status, "replaced");
  assert.equal(replacement.replacementCompatibility, "matching");
  assert.deepEqual(replacement.hashes.map((item) => item.hash), [HASH_A, HASH_B]);
  assert.equal(replacement.hashes[0].replacedByHash, HASH_B);
  assert.equal(replacement.hashes[1].replacesHash, HASH_A);

  const incompatibleReplacement = applyTransactionObservation(
    state.records[0],
    observation({ transaction: tx({ calldataFingerprint: `0x${"f".repeat(64)}`, hash: HASH_B }) })
  );
  assert.equal(incompatibleReplacement.status, "replaced");
  assert.equal(incompatibleReplacement.replacementCompatibility, "incompatible");
  assert.match(incompatibleReplacement.rejectionReason, /not executed/);
  assert.notEqual(incompatibleReplacement.status, "canonical");
  assert(transactionRetryBlocked({ ...state, records: [incompatibleReplacement] }, incompatibleReplacement.reviewed));

  const removeReviewed = reviewed("remove-liquidity", { poolId: "pool-1" });
  const otherRemoveReviewed = reviewed("remove-liquidity", {
    executionFingerprint: "different-batch",
    poolId: "pool-1",
    settingsFingerprint: "full-exit-batch:v1:{different}"
  });
  const removePending = beginTransactionIntent(emptyTransactionJournal(), removeReviewed, { expectedNonce: 8n, submissionBlock: 100n }, now, "remove-pending");
  assert(transactionFamilyRetryBlocked(removePending, otherRemoveReviewed), "volatile settings must not permit a sibling remove for the same owner and pair");
  assert(!transactionFamilyRetryBlocked(removePending, { ...otherRemoveReviewed, poolId: "pool-2" }), "a different pair is an independent intent family");
  const rejectedRemove = recordRejectedSubmission(removePending, "remove-pending", 0, "rejected", now + 1);
  assert(!transactionFamilyRetryBlocked(rejectedRemove, otherRemoveReviewed));
  const finalizedCancellation = applyTransactionObservation(
    state.records[0],
    observation({
      canonicalBlockHash: BLOCK_A,
      headBlockNumber: "101",
      receipt: { blockHash: BLOCK_A, blockNumber: "100", hash: HASH_B, status: "success" },
      transaction: tx({ calldataFingerprint: `0x${"f".repeat(64)}`, hash: HASH_B })
    })
  );
  assert.equal(finalizedCancellation.status, "replaced");
  assert(finalizedCancellation.replacementFinalized);
  assert(transactionNeedsMonitoring(finalizedCancellation), "recent finalized replacement remains reorg-monitored");
  assert(!transactionNeedsMonitoring({ ...finalizedCancellation, confirmations: 12 }), "deep finalized replacement leaves the hot monitor loop");
  assert(!transactionRetryBlocked({ ...state, records: [finalizedCancellation] }, finalizedCancellation.reviewed));
  const pendingCancellation = applyTransactionObservation(
    state.records[0],
    observation({ transaction: tx({ calldataFingerprint: `0x${"f".repeat(64)}`, hash: HASH_B }) })
  );
  const finalizedByReceiptOnly = applyTransactionObservation(
    pendingCancellation,
    observation({
      canonicalBlockHash: BLOCK_A,
      headBlockNumber: "101",
      receipt: { blockHash: BLOCK_A, blockNumber: "100", hash: HASH_B, status: "success" },
      transaction: null
    })
  );
  assert.equal(finalizedByReceiptOnly.status, "replaced", "receipt-only polling must never mark an incompatible replacement successful");
  assert(finalizedByReceiptOnly.replacementFinalized);
  const cancellationReorg = applyTransactionObservation(
    finalizedByReceiptOnly,
    observation({ canonicalBlockHash: BLOCK_B, receipt: { blockHash: BLOCK_A, blockNumber: "100", hash: HASH_B, status: "success" }, transaction: null })
  );
  assert.equal(cancellationReorg.status, "replaced");
  assert(!cancellationReorg.replacementFinalized);
  assert.equal(cancellationReorg.canonicalReceipt.hash, HASH_B, "reorg demotion preserves prior receipt evidence");
  assert(transactionRetryBlocked({ ...state, records: [cancellationReorg] }, cancellationReorg.reviewed));
  const cancellationReincluded = applyTransactionObservation(
    cancellationReorg,
    observation({
      canonicalBlockHash: BLOCK_B,
      headBlockNumber: "104",
      receipt: { blockHash: BLOCK_B, blockNumber: "102", hash: HASH_B, status: "success" },
      transaction: null
    })
  );
  assert(cancellationReincluded.replacementFinalized);

  const hashlessIncompatible = applyTransactionObservation(
    begin().records[0],
    observation({ transaction: tx({ calldataFingerprint: `0x${"f".repeat(64)}`, hash: HASH_B }) })
  );
  assert.equal(hashlessIncompatible.activeHash, null);
  assert.equal(hashlessIncompatible.status, "reconciling");
  assert(transactionRetryBlocked({ ...state, records: [hashlessIncompatible] }, hashlessIncompatible.reviewed));

  const timedOut = applyTransactionObservation(
    state.records[0],
    observation({ now: now + TRANSACTION_JOURNAL_TIMEOUT_MS + 200, pendingNonce: "8", transaction: null })
  );
  assert.equal(timedOut.status, "timed-out");
  assert(transactionRetryBlocked({ ...state, records: [timedOut] }, timedOut.reviewed), "timeout must remain retry-unsafe");
  const resumed = applyTransactionObservation(timedOut, observation({ now: timedOut.updatedAt + 1, transaction: null }));
  assert.equal(resumed.status, "timed-out", "timeout remains fail-closed while reconciliation continues");
  const recentlyCheckedTimeout = { ...timedOut, lastCheckedAt: now };
  assert.equal(selectTransactionRecordsForMonitoring([recentlyCheckedTimeout], now + TRANSACTION_JOURNAL_TIMED_OUT_POLL_MS - 1).length, 0);
  assert.equal(selectTransactionRecordsForMonitoring([recentlyCheckedTimeout], now + TRANSACTION_JOURNAL_TIMED_OUT_POLL_MS).length, 1);
  const dueTimeouts = Array.from({ length: 200 }, (_, index) => ({
    ...timedOut,
    createdAt: now + index,
    id: `timeout-${index}`,
    lastCheckedAt: now - TRANSACTION_JOURNAL_TIMED_OUT_POLL_MS - 1
  }));
  const firstTimeoutBatch = selectTransactionRecordsForMonitoring(dueTimeouts, now);
  assert.equal(firstTimeoutBatch.length, TRANSACTION_JOURNAL_MONITOR_BATCH_SIZE);
  const firstIds = new Set(firstTimeoutBatch.map((record) => record.id));
  const rotatedTimeouts = dueTimeouts.map((record) => firstIds.has(record.id) ? deferTransactionMonitoring(record, now) : record);
  const secondTimeoutBatch = selectTransactionRecordsForMonitoring(rotatedTimeouts, now);
  assert.equal(secondTimeoutBatch.length, TRANSACTION_JOURNAL_MONITOR_BATCH_SIZE);
  assert(secondTimeoutBatch.every((record) => !firstIds.has(record.id)), "bounded timed-out batches rotate instead of hot-looping the same records");
  const submittedCandidates = Array.from({ length: TRANSACTION_JOURNAL_MONITOR_BATCH_SIZE + 1 }, (_, index) => ({
    ...state.records[0],
    createdAt: now + index,
    id: `submitted-${index}`,
    lastCheckedAt: null
  }));
  const firstSubmittedBatch = selectTransactionRecordsForMonitoring(submittedCandidates, now);
  const deferredSubmittedIds = new Set(firstSubmittedBatch.map((record) => record.id));
  const rotatedSubmittedCandidates = submittedCandidates.map((record) => deferredSubmittedIds.has(record.id) ? deferTransactionMonitoring(record, now) : record);
  const nextSubmittedBatch = selectTransactionRecordsForMonitoring(rotatedSubmittedCandidates, now + 1);
  assert(nextSubmittedBatch.some((record) => record.id === `submitted-${TRANSACTION_JOURNAL_MONITOR_BATCH_SIZE}`), "deferred deployment mismatches cannot monopolize the monitoring batch");
  const deferredHighPriority = submittedCandidates.slice(0, TRANSACTION_JOURNAL_MONITOR_BATCH_SIZE).map((record) => deferTransactionMonitoring(record, now));
  const unknownForFairness = recordUnknownSubmission(begin(), "swap-intent", 0, "transport closed", now + 1).records[0];
  const neverCheckedUnknown = {
    ...unknownForFairness,
    createdAt: now + 100,
    id: "never-checked-unknown",
    lastCheckedAt: null
  };
  const fairMixedBatch = selectTransactionRecordsForMonitoring([...deferredHighPriority, neverCheckedUnknown], now + 1);
  assert(fairMixedBatch.some((record) => record.id === neverCheckedUnknown.id), "deferred high-priority submissions cannot starve a never-checked unknown intent");

  let unknown = begin();
  unknown = recordUnknownSubmission(unknown, "swap-intent", 0, "transport closed", now + 1);
  assert.equal(unknown.records[0].status, "unknown-submission");
  assert(transactionRetryBlocked(unknown, unknown.records[0].reviewed));
  let unknownRecord = applyTransactionObservation(
    unknown.records[0],
    observation({ latestNonce: "7", pendingNonce: "7", transaction: null })
  );
  assert.equal(unknownRecord.status, "unknown-submission");
  unknownRecord = applyTransactionObservation(
    unknownRecord,
    observation({ latestNonce: "7", now: now + 2_000, pendingNonce: "7", transaction: null })
  );
  assert.equal(unknownRecord.status, "unknown-submission", "portable RPC cannot prove that a hashless broadcast was dropped");
  assert(transactionRetryBlocked({ ...unknown, records: [unknownRecord] }, unknownRecord.reviewed));

  const recoveredUnknown = applyTransactionObservation(
    unknown.records[0],
    observation({ transaction: tx({ hash: HASH_B }) })
  );
  assert.equal(recoveredUnknown.activeHash, HASH_B);
  assert.notEqual(recoveredUnknown.status, "rejected");

  let rejected = begin();
  rejected = recordRejectedSubmission(rejected, "swap-intent", 0, "User rejected", now + 1);
  assert.equal(rejected.records[0].status, "rejected");
  assert(!transactionRetryBlocked(rejected, rejected.records[0].reviewed));
  assert(isUserRejectedSubmission({ code: 4001 }));
  assert(isUserRejectedSubmission({ cause: { name: "UserRejectedRequestError" } }));
  assert(!isUserRejectedSubmission(new Error("network disconnected after send")));
  const cyclic = { code: 0 };
  cyclic.cause = cyclic;
  assert(!isUserRejectedSubmission(cyclic));

  const aborted = recordAbortedSubmission(begin(), "swap-intent", 0, now + 1);
  assert.equal(aborted.records[0].status, "aborted");
  assert(!transactionRetryBlocked(aborted, aborted.records[0].reviewed));
  const recoveredReload = recoverAwaitingWalletIntents(begin(), now + TRANSACTION_WALLET_LEASE_MS + 1);
  assert.equal(recoveredReload.records[0].status, "unknown-submission");
  assert(transactionRetryBlocked(recoveredReload, recoveredReload.records[0].reviewed));

  const memory = new Map();
  const storage = {
    getItem(key) { return memory.get(key) ?? null; },
    setItem(key, value) { memory.set(key, value); }
  };
  persistTransactionJournal(storage, state);
  const hydrated = loadTransactionJournal(storage);
  assert.deepEqual(hydrated.records, state.records, "reload must preserve pending hashes, nonce, reviewed intent, and lifecycle");
  assert.equal(hydrated.revision, state.revision, "hydration must not invent a journal revision");
  assert(Object.isFrozen(hydrated.records[0].reviewed));
  const legacyReverted = { ...reverted, confirmations: 0 };
  memory.set(TRANSACTION_JOURNAL_STORAGE_KEY, JSON.stringify({ version: 1, revision: 1, records: [legacyReverted] }));
  const hydratedLegacyRevert = loadTransactionJournal(storage).records[0];
  assert.equal(hydratedLegacyRevert?.status, "reverted", "v1 reverted records with zero confirmations remain hydratable");
  assert(transactionNeedsMonitoring(hydratedLegacyRevert));
  assert(transactionRecordBlocksIntentFamily(hydratedLegacyRevert));
  memory.set(TRANSACTION_JOURNAL_STORAGE_KEY, "{broken");
  assert.deepEqual(loadTransactionJournal(storage).records, []);
  memory.set(TRANSACTION_JOURNAL_STORAGE_KEY, JSON.stringify({ version: 999, revision: 0, records: [] }));
  assert.deepEqual(loadTransactionJournal(storage).records, []);

  const secondTab = begin("approval");
  const merged = mergeTransactionJournals(state, secondTab);
  assert.deepEqual(merged.records.map((record) => record.id), ["swap-intent", "approval-intent"]);
  memory.delete(TRANSACTION_JOURNAL_STORAGE_KEY);
  persistTransactionJournal(storage, state);
  persistTransactionJournal(storage, secondTab);
  assert.deepEqual(loadTransactionJournal(storage).records.map((record) => record.id), ["swap-intent", "approval-intent"]);

  const partiallyCorrupt = JSON.parse(JSON.stringify(merged));
  partiallyCorrupt.records.push({ id: "broken" });
  memory.set(TRANSACTION_JOURNAL_STORAGE_KEY, JSON.stringify(partiallyCorrupt));
  assert.equal(loadTransactionJournal(storage).records.length, 2, "valid history survives a corrupt sibling record");

  assert.throws(
    () => persistTransactionJournal({ getItem: () => null, setItem: () => { throw new Error("quota unavailable"); } }, state),
    /quota unavailable/,
    "pre-broadcast durability failure must fail closed"
  );

  for (const forged of [
    { ...canonical, confirmations: 0 },
    { ...aborted.records[0], activeHash: HASH_A, hashes: [{ hash: HASH_A, observedAt: now, replacedByHash: null, replacesHash: null, role: "submitted" }] },
    { ...rejected.records[0], actualNonce: "7" }
  ]) {
    memory.set(TRANSACTION_JOURNAL_STORAGE_KEY, JSON.stringify({ records: [forged], revision: 1, version: 1 }));
    assert.equal(loadTransactionJournal(storage).records.length, 0, "forged terminal lifecycle evidence must be discarded");
  }

  const concurrentBase = begin();
  const concurrentHash = recordSubmittedHash(concurrentBase, "swap-intent", 0, HASH_A, now + 10);
  const concurrentUnknown = recordUnknownSubmission(concurrentBase, "swap-intent", 0, "transport closed", now + 20);
  const concurrentMerged = mergeTransactionJournals(concurrentHash, concurrentUnknown);
  assert.equal(concurrentMerged.records[0].activeHash, HASH_A, "equal-revision merge cannot lose a returned hash");
  assert.equal(concurrentMerged.records[0].hashes[0].hash, HASH_A);
  memory.delete(TRANSACTION_JOURNAL_STORAGE_KEY);
  persistTransactionJournal(storage, concurrentMerged);
  assert.equal(loadTransactionJournal(storage).records[0].status, "submitted", "strong hash evidence survives merge persistence and hydration");
  for (const prebroadcastTerminal of [
    recordRejectedSubmission(concurrentBase, "swap-intent", 0, "rejected", now + 30),
    recordAbortedSubmission(concurrentBase, "swap-intent", 0, now + 30)
  ]) {
    const evidenceMerge = mergeTransactionJournals(concurrentHash, prebroadcastTerminal);
    memory.delete(TRANSACTION_JOURNAL_STORAGE_KEY);
    persistTransactionJournal(storage, evidenceMerge);
    assert.equal(loadTransactionJournal(storage).records[0].status, "submitted", "returned hash evidence dominates a concurrent prebroadcast terminal callback");
  }

  const canonicalState = { ...state, records: [canonical] };
  const orphanedState = { ...state, records: [orphaned] };
  const canonicalOrphanMerge = mergeTransactionJournals(canonicalState, orphanedState);
  assert.equal(canonicalOrphanMerge.records[0].canonicalReceipt.hash, HASH_A, "canonical receipt evidence survives conservative merge");
  const finalizedCancellationState = { ...state, records: [finalizedCancellation] };
  const cancellationReorgState = { ...state, records: [cancellationReorg] };
  const mergedCancellationReorg = mergeTransactionJournals(finalizedCancellationState, cancellationReorgState);
  assert.equal(mergedCancellationReorg.records[0].replacementFinalized, false, "newer reorg demotion wins over older replacement finality");
  assert(transactionRetryBlocked(mergedCancellationReorg, mergedCancellationReorg.records[0].reviewed));

  const otherScope = reviewed("swap", { account: "0x4444444444444444444444444444444444444444", executionFingerprint: "swap-execution-v1" });
  assert(!transactionRetryBlocked(state, otherScope), "another owner must not inherit a pending block");
  assert(!transactionRetryBlocked(state, reviewed("swap", { settingsFingerprint: "different-settings" })), "retry lock must use full reviewed semantics");
  assert(transactionRetryBlocked(state, reviewed("swap", { calldataFingerprint: `0x${"9".repeat(64)}` })), "dynamic deadline calldata cannot bypass an unresolved reviewed intent");
  const pendingApproval = begin("approval");
  for (const drift of [
    { settingsFingerprint: "different-form" },
    { poolId: "different-pool" },
    { executionFingerprint: "different-execution" }
  ]) {
    assert(transactionRetryBlocked(pendingApproval, reviewed("approval", drift)), "irrelevant form drift cannot bypass the same approval call");
  }
  assert(!transactionRetryBlocked(pendingApproval, reviewed("approval", { calldataFingerprint: `0x${"9".repeat(64)}` })), "a genuinely different approval calldata may form a new intent");
  assert.equal(recordsForScope(state, otherScope).length, 0);
  assert.equal(recordsForScope(state, state.records[0].reviewed).length, 1);

  let bounded = emptyTransactionJournal();
  for (let index = 0; index < TRANSACTION_JOURNAL_MAX_RECORDS; index += 1) {
    bounded = beginTransactionIntent(bounded, reviewed("approval", { executionFingerprint: `approval-${index}` }), { expectedNonce: BigInt(index), submissionBlock: 99n }, now + index, `id-${index}`);
  }
  assert.equal(bounded.records.length, TRANSACTION_JOURNAL_MAX_RECORDS);
  assert.equal(bounded.records[0].id, "id-0");
  assert.throws(
    () => beginTransactionIntent(bounded, reviewed("approval", { executionFingerprint: "overflow" }), { expectedNonce: 999n, submissionBlock: 99n }),
    /full of unresolved intents/
  );

  let nearCapacity = emptyTransactionJournal();
  for (let index = 0; index < TRANSACTION_JOURNAL_MAX_RECORDS - 1; index += 1) {
    nearCapacity = beginTransactionIntent(nearCapacity, reviewed("approval", { executionFingerprint: `capacity-${index}` }), { expectedNonce: BigInt(index), submissionBlock: 99n }, now + index, `capacity-${index}`);
  }
  const recentCanonicalCapacity = { ...nearCapacity, records: [...nearCapacity.records, canonical] };
  assert.throws(
    () => beginTransactionIntent(recentCanonicalCapacity, reviewed("swap", { executionFingerprint: "capacity-new" }), { expectedNonce: 999n, submissionBlock: 99n }),
    /full of unresolved intents/,
    "recent canonical evidence cannot be evicted before reorg monitoring finality"
  );
  const deepCanonical = { ...canonical, confirmations: 12 };
  const deepCanonicalCapacity = { ...nearCapacity, records: [...nearCapacity.records, deepCanonical] };
  const prunedDeepCanonical = beginTransactionIntent(deepCanonicalCapacity, reviewed("swap", { executionFingerprint: "capacity-new" }), { expectedNonce: 999n, submissionBlock: 99n }, now + 1_000, "capacity-new");
  assert.equal(prunedDeepCanonical.records.length, TRANSACTION_JOURNAL_MAX_RECORDS);
  assert(!prunedDeepCanonical.records.some((record) => record.id === deepCanonical.id), "deep canonical history is prunable at capacity");

  console.log("transaction journal unit tests passed");
} finally {
  await server.close();
}
