export const TRANSACTION_JOURNAL_STORAGE_KEY = "feather.transaction-journal.v1";
export const TRANSACTION_JOURNAL_VERSION = 1 as const;
export const TRANSACTION_JOURNAL_CONFIRMATIONS = 2;
export const TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS = 12;
export const TRANSACTION_JOURNAL_MONITOR_BATCH_SIZE = 8;
export const TRANSACTION_JOURNAL_TIMED_OUT_POLL_MS = 5 * 60 * 1_000;
export const TRANSACTION_JOURNAL_TIMEOUT_MS = 10 * 60 * 1_000;
export const TRANSACTION_JOURNAL_MAX_RECORDS = 200;
export const TRANSACTION_WALLET_LEASE_MS = 5 * 60 * 1_000;

export type TransactionIntentClass = "approval" | "create-pool" | "add-liquidity" | "swap" | "remove-liquidity";
export type TransactionJournalStatus =
  | "awaiting-wallet"
  | "aborted"
  | "reconciling"
  | "unknown-submission"
  | "rejected"
  | "submitted"
  | "confirming"
  | "canonical"
  | "reverted"
  | "replaced"
  | "orphaned"
  | "timed-out";

export interface TransactionJournalScope {
  account: `0x${string}`;
  chainId: number;
  deploymentEpoch: string;
  environment: string;
}

export interface ReviewedTransactionIntent extends TransactionJournalScope {
  calldataFingerprint: `0x${string}`;
  contractsFingerprint: string;
  executionFingerprint: string;
  intent: TransactionIntentClass;
  poolId: string | null;
  recipient: `0x${string}` | null;
  refundRecipient: `0x${string}` | null;
  settingsFingerprint: string;
  target: `0x${string}`;
  value: string;
}

export interface TransactionHashRecord {
  hash: `0x${string}`;
  observedAt: number;
  replacedByHash: `0x${string}` | null;
  replacesHash: `0x${string}` | null;
  role: "submitted" | "replacement";
}

export interface TransactionJournalRecord {
  actualNonce: string | null;
  activeHash: `0x${string}` | null;
  canonicalReceipt: {
    blockHash: `0x${string}`;
    blockNumber: string;
    hash: `0x${string}`;
    status: "success" | "reverted";
  } | null;
  confirmations: number;
  createdAt: number;
  hashes: TransactionHashRecord[];
  id: string;
  lastCheckedAt: number | null;
  lifecycleRevision: number;
  expectedNonce: string;
  reconciliationAttempts: number;
  rejectionReason: string | null;
  replacementCompatibility: "matching" | "incompatible" | null;
  replacementFinalized: boolean;
  reviewed: Readonly<ReviewedTransactionIntent>;
  status: TransactionJournalStatus;
  scanCursor: string;
  submissionBlock: string;
  submittedAt: number | null;
  timeoutAt: number;
  updatedAt: number;
  walletLeaseUntil: number;
}

export interface TransactionJournalState {
  records: TransactionJournalRecord[];
  revision: number;
  version: typeof TRANSACTION_JOURNAL_VERSION;
}

export interface JournalTransactionObservation {
  blockHash: `0x${string}` | null;
  blockNumber: string | null;
  calldataFingerprint: `0x${string}`;
  from: `0x${string}`;
  hash: `0x${string}`;
  nonce: string;
  target: `0x${string}` | null;
  value: string;
}

export interface TransactionJournalObservation {
  canonicalBlockLookup: "found" | "missing" | "unavailable";
  canonicalBlockHash: `0x${string}` | null;
  headBlockNumber: string | null;
  latestNonce: string | null;
  now: number;
  pendingNonce: string | null;
  receiptLookup: "found" | "missing" | "unavailable";
  receipt: {
    blockHash: `0x${string}`;
    blockNumber: string;
    hash: `0x${string}`;
    status: "success" | "reverted";
  } | null;
  transaction: JournalTransactionObservation | null;
  transactionLookup: "found" | "missing" | "unavailable";
  scannedThroughBlock: string | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function emptyTransactionJournal(): TransactionJournalState {
  return { records: [], revision: 0, version: TRANSACTION_JOURNAL_VERSION };
}

export function transactionScopeKey(scope: TransactionJournalScope): string {
  return [scope.account.toLowerCase(), scope.chainId, scope.environment, scope.deploymentEpoch].join("|");
}

export function beginTransactionIntent(
  state: TransactionJournalState,
  reviewed: ReviewedTransactionIntent,
  preBroadcast: { expectedNonce: bigint; submissionBlock: bigint },
  now = Date.now(),
  id = createIntentId(now)
): TransactionJournalState {
  if (state.records.length >= TRANSACTION_JOURNAL_MAX_RECORDS && state.records.every((record) => !isTerminalRecord(record))) {
    throw new Error("Transaction journal is full of unresolved intents; reconciliation must complete before another submission");
  }
  const frozenReviewed = Object.freeze({ ...reviewed, account: normalizeHex(reviewed.account), target: normalizeHex(reviewed.target) });
  const record: TransactionJournalRecord = {
    actualNonce: null,
    activeHash: null,
    canonicalReceipt: null,
    confirmations: 0,
    createdAt: now,
    hashes: [],
    id,
    lastCheckedAt: null,
    lifecycleRevision: 0,
    expectedNonce: preBroadcast.expectedNonce.toString(),
    reconciliationAttempts: 0,
    rejectionReason: null,
    replacementCompatibility: null,
    replacementFinalized: false,
    reviewed: frozenReviewed,
    status: "awaiting-wallet",
    scanCursor: (preBroadcast.submissionBlock > 0n ? preBroadcast.submissionBlock - 1n : 0n).toString(),
    submissionBlock: preBroadcast.submissionBlock.toString(),
    submittedAt: null,
    timeoutAt: 0,
    updatedAt: now,
    walletLeaseUntil: now + TRANSACTION_WALLET_LEASE_MS
  };
  return withRecords(state, [...state.records, record]);
}

export function recordSubmittedHash(
  state: TransactionJournalState,
  id: string,
  expectedLifecycleRevision: number,
  hash: `0x${string}`,
  now = Date.now()
): TransactionJournalState {
  return updateTransactionRecord(state, id, (record) =>
    !authoritativeWalletResultAllowed(record, expectedLifecycleRevision) ? record : ({
    ...record,
    activeHash: normalizeHex(hash),
    hashes: appendHash(record.hashes, hash, "submitted", now),
    lifecycleRevision: record.lifecycleRevision + 1,
    rejectionReason: null,
    status: "submitted",
    submittedAt: record.submittedAt ?? now,
    timeoutAt: now + TRANSACTION_JOURNAL_TIMEOUT_MS,
    updatedAt: now
  }));
}

export function recordRejectedSubmission(
  state: TransactionJournalState,
  id: string,
  expectedLifecycleRevision: number,
  reason: string,
  now = Date.now()
): TransactionJournalState {
  return updateTransactionRecord(state, id, (record) =>
    !authoritativeWalletResultAllowed(record, expectedLifecycleRevision) ? record : ({
    ...record,
    lifecycleRevision: record.lifecycleRevision + 1,
    rejectionReason: reason,
    status: "rejected",
    updatedAt: now
  }));
}

export function recordUnknownSubmission(
  state: TransactionJournalState,
  id: string,
  expectedLifecycleRevision: number,
  reason: string,
  now = Date.now()
): TransactionJournalState {
  return updateTransactionRecord(state, id, (record) =>
    !authoritativeWalletResultAllowed(record, expectedLifecycleRevision) ? record : ({
    ...record,
    lifecycleRevision: record.lifecycleRevision + 1,
    rejectionReason: reason,
    status: "unknown-submission",
    timeoutAt: now + TRANSACTION_JOURNAL_TIMEOUT_MS,
    updatedAt: now
  }));
}

function authoritativeWalletResultAllowed(record: TransactionJournalRecord, expectedLifecycleRevision: number): boolean {
  if (record.activeHash !== null || record.actualNonce !== null || isTerminalRecord(record)) return false;
  if (record.lifecycleRevision === expectedLifecycleRevision) return record.status === "awaiting-wallet";
  return record.lifecycleRevision > expectedLifecycleRevision &&
    ["unknown-submission", "reconciling", "timed-out"].includes(record.status);
}

export function recordAbortedSubmission(
  state: TransactionJournalState,
  id: string,
  expectedLifecycleRevision: number,
  now = Date.now()
): TransactionJournalState {
  return updateTransactionRecord(state, id, (record) =>
    record.lifecycleRevision !== expectedLifecycleRevision || record.status !== "awaiting-wallet" ? record : ({
      ...record,
      lifecycleRevision: record.lifecycleRevision + 1,
      rejectionReason: "Execution context changed before wallet broadcast",
      status: "aborted",
      updatedAt: now
    }));
}

export function recoverAwaitingWalletIntents(state: TransactionJournalState, now = Date.now()): TransactionJournalState {
  let changed = false;
  const records = state.records.map((record) => {
    if (record.status !== "awaiting-wallet" || record.walletLeaseUntil > now) return record;
    changed = true;
    return {
      ...record,
      lifecycleRevision: record.lifecycleRevision + 1,
      rejectionReason: "The app reloaded before wallet submission returned; broadcast identity is unknown",
      status: "unknown-submission" as const,
      timeoutAt: now + TRANSACTION_JOURNAL_TIMEOUT_MS,
      updatedAt: now
    };
  });
  return changed ? withRecords(state, records) : state;
}

export function applyTransactionObservation(
  record: TransactionJournalRecord,
  observation: TransactionJournalObservation,
  requiredConfirmations = TRANSACTION_JOURNAL_CONFIRMATIONS
): TransactionJournalRecord {
  const transaction = observation.transaction;
  const receipt = observation.receipt;
  const nextAttempts = record.reconciliationAttempts + 1;
  const base = {
    ...record,
    lastCheckedAt: observation.now,
    lifecycleRevision: record.lifecycleRevision + 1,
    reconciliationAttempts: nextAttempts,
    scanCursor: observation.scannedThroughBlock ?? record.scanCursor,
    updatedAt: observation.now
  };

  if (
    (observation.receiptLookup === "unavailable" || observation.canonicalBlockLookup === "unavailable") &&
    ["confirming", "canonical", "reverted", "replaced", "orphaned"].includes(record.status)
  ) return base;

  if (transaction !== null && transactionMatchesIdentity(record, transaction)) {
    const semanticMatch = transactionMatchesReviewedIntent(record, transaction);
    if (record.activeHash === null && record.actualNonce === null && !semanticMatch) {
      return {
        ...base,
        rejectionReason: "An unrelated transaction used the expected nonce; the hashless submission remains ambiguous",
        status: "reconciling"
      };
    }
    const replacement = record.activeHash !== null && !sameHex(record.activeHash, transaction.hash);
    const hashes = replacement
      ? appendReplacementHash(record.hashes, record.activeHash!, transaction.hash, observation.now)
      : appendHash(record.hashes, transaction.hash, "submitted", observation.now);
    const observedRecord = {
      ...base,
      activeHash: normalizeHex(transaction.hash),
      hashes,
      actualNonce: transaction.nonce,
      replacementCompatibility: semanticMatch
        ? (replacement ? "matching" : record.replacementCompatibility)
        : "incompatible",
      status: replacement ? "replaced" as const : record.status,
      submittedAt: record.submittedAt ?? observation.now
    };
    if (!semanticMatch) {
      return applyIncompatibleReplacementReceipt(observedRecord, observation, requiredConfirmations);
    }
    return applyReceiptObservation(observedRecord, observation, requiredConfirmations);
  }

  if (
    receipt !== null &&
    record.activeHash !== null &&
    record.actualNonce !== null &&
    record.replacementCompatibility === "incompatible" &&
    sameHex(receipt.hash, record.activeHash)
  ) {
    return applyIncompatibleReplacementReceipt(base, observation, requiredConfirmations);
  }

  if (receipt !== null && record.activeHash !== null && record.actualNonce !== null && sameHex(receipt.hash, record.activeHash)) {
    return applyReceiptObservation(base, observation, requiredConfirmations);
  }

  if (observation.receiptLookup === "unavailable" || observation.transactionLookup === "unavailable") {
    return base;
  }

  if (
    observation.receiptLookup === "missing" &&
    (record.canonicalReceipt !== null || record.status === "canonical" || record.status === "confirming" || record.status === "reverted")
  ) {
    return {
      ...base,
      confirmations: 0,
      rejectionReason: "The observed receipt disappeared or its block is no longer canonical; reconciling for re-inclusion",
      scanCursor: rewindScanCursor(record.submissionBlock),
      status: "orphaned"
    };
  }

  const latestNonce = parseStoredBigInt(observation.latestNonce);
  const pendingNonce = parseStoredBigInt(observation.pendingNonce);
  const nonce = BigInt(record.actualNonce ?? record.expectedNonce);
  if (record.activeHash === null) {
    if (record.timeoutAt > 0 && observation.now >= record.timeoutAt) {
      return {
        ...base,
        rejectionReason: "Submission identity remains unknown after timeout; reconciliation will continue and retry remains blocked",
        status: "timed-out"
      };
    }
    return {
      ...base,
      status: (latestNonce !== null && latestNonce > nonce) || (pendingNonce !== null && pendingNonce > nonce)
        ? "reconciling"
        : "unknown-submission"
    };
  }

  if (record.timeoutAt > 0 && observation.now >= record.timeoutAt) {
    return {
      ...base,
      rejectionReason: "Receipt confirmation timed out; reconciliation will continue and retry remains blocked",
      status: "timed-out"
    };
  }
  if (record.status === "orphaned" || record.status === "replaced" || record.status === "timed-out") {
    return { ...base, status: "reconciling" };
  }
  return { ...base, status: "submitted" };
}

function applyReceiptObservation(
  record: TransactionJournalRecord,
  observation: TransactionJournalObservation,
  requiredConfirmations: number
): TransactionJournalRecord {
  const receipt = observation.receipt;
  if (receipt === null || record.activeHash === null || !sameHex(receipt.hash, record.activeHash)) {
    if (record.canonicalReceipt !== null || record.status === "canonical" || record.status === "confirming" || record.status === "reverted") {
      return {
        ...record,
        confirmations: 0,
        rejectionReason: "The observed receipt disappeared; reconciling for canonical re-inclusion",
        status: "orphaned"
      };
    }
    return record;
  }
  if (observation.canonicalBlockLookup !== "found") return record;
  const blockIsCanonical = observation.canonicalBlockHash !== null && sameHex(observation.canonicalBlockHash, receipt.blockHash);
  if (!blockIsCanonical) {
    return {
      ...record,
      canonicalReceipt: receipt,
      confirmations: 0,
      rejectionReason: "The receipt block hash is no longer canonical; reconciling for re-inclusion",
      scanCursor: rewindScanCursor(record.submissionBlock),
      status: "orphaned"
    };
  }
  const head = parseStoredBigInt(observation.headBlockNumber);
  const receiptBlock = BigInt(receipt.blockNumber);
  const confirmations = head === null || head < receiptBlock ? 0 : Number(head - receiptBlock + 1n);
  if (receipt.status === "reverted") {
    return { ...record, canonicalReceipt: receipt, confirmations, rejectionReason: "Transaction reverted", status: "reverted" };
  }
  return {
    ...record,
    canonicalReceipt: receipt,
    confirmations,
    rejectionReason: null,
    status: confirmations >= requiredConfirmations ? "canonical" : "confirming"
  };
}

export function updateObservedTransaction(
  state: TransactionJournalState,
  id: string,
  expectedLifecycleRevision: number,
  observation: TransactionJournalObservation,
  requiredConfirmations = TRANSACTION_JOURNAL_CONFIRMATIONS
): TransactionJournalState {
  return updateTransactionRecord(state, id, (record) =>
    record.lifecycleRevision === expectedLifecycleRevision
      ? applyTransactionObservation(record, observation, requiredConfirmations)
      : record
  );
}

export function transactionRetryBlocked(state: TransactionJournalState, reviewed: ReviewedTransactionIntent): boolean {
  const scope = transactionScopeKey(reviewed);
  const retryKey = transactionRetryKey(reviewed);
  return state.records.some((record) =>
    transactionScopeKey(record.reviewed) === scope &&
    transactionRetryKey(record.reviewed) === retryKey &&
    !["canonical", "rejected", "aborted"].includes(record.status) &&
    !(record.status === "reverted" && record.confirmations >= TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS) &&
    !(record.status === "replaced" && record.replacementCompatibility === "incompatible" && record.replacementFinalized)
  );
}

export function transactionFamilyRetryBlocked(
  state: TransactionJournalState,
  reviewed: ReviewedTransactionIntent
): boolean {
  if (reviewed.intent !== "remove-liquidity") return false;
  const scope = transactionScopeKey(reviewed);
  return state.records.some((record) =>
    record.reviewed.intent === "remove-liquidity" &&
    transactionScopeKey(record.reviewed) === scope &&
    record.reviewed.poolId?.toLowerCase() === reviewed.poolId?.toLowerCase() &&
    record.reviewed.target.toLowerCase() === reviewed.target.toLowerCase() &&
    transactionRecordBlocksIntentFamily(record)
  );
}

export function transactionRecordBlocksIntentFamily(record: TransactionJournalRecord): boolean {
  if (["rejected", "aborted"].includes(record.status)) return false;
  if (record.status === "canonical") return record.confirmations < TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS;
  if (record.status === "reverted") return record.confirmations < TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS;
  if (record.status === "replaced" && record.replacementCompatibility === "incompatible") {
    return !record.replacementFinalized || record.confirmations < TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS;
  }
  return true;
}

function transactionRetryKey(reviewed: ReviewedTransactionIntent): string {
  if (reviewed.intent === "approval") {
    return JSON.stringify([
      reviewed.intent,
      reviewed.contractsFingerprint,
      reviewed.target.toLowerCase(),
      reviewed.calldataFingerprint.toLowerCase(),
      reviewed.value
    ]);
  }
  return JSON.stringify([
    reviewed.intent,
    reviewed.contractsFingerprint,
    reviewed.poolId,
    reviewed.target.toLowerCase(),
    reviewed.recipient?.toLowerCase() ?? null,
    reviewed.refundRecipient?.toLowerCase() ?? null,
    reviewed.value,
    reviewed.settingsFingerprint
  ]);
}

export function recordsForScope(state: TransactionJournalState, scope: TransactionJournalScope): TransactionJournalRecord[] {
  const key = transactionScopeKey(scope);
  return state.records.filter((record) => transactionScopeKey(record.reviewed) === key);
}

export function transactionNeedsMonitoring(record: TransactionJournalRecord): boolean {
  if (["rejected", "aborted"].includes(record.status)) return false;
  if (record.status === "reverted" && record.confirmations >= TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS) return false;
  if (record.status === "canonical" && record.confirmations >= TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS) return false;
  if (
    record.status === "replaced" &&
    record.replacementCompatibility === "incompatible" &&
    record.replacementFinalized &&
    record.confirmations >= TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS
  ) return false;
  return true;
}

export function selectTransactionRecordsForMonitoring(
  records: TransactionJournalRecord[],
  now = Date.now()
): TransactionJournalRecord[] {
  return records
    .filter((record) =>
      record.status !== "awaiting-wallet" &&
      transactionNeedsMonitoring(record) &&
      (record.status !== "timed-out" || record.lastCheckedAt === null || now - record.lastCheckedAt >= TRANSACTION_JOURNAL_TIMED_OUT_POLL_MS))
    .sort((left, right) =>
      (left.lastCheckedAt ?? 0) - (right.lastCheckedAt ?? 0) ||
      monitoringPriority(left) - monitoringPriority(right) ||
      left.createdAt - right.createdAt)
    .slice(0, TRANSACTION_JOURNAL_MONITOR_BATCH_SIZE);
}

export function deferTransactionMonitoring(record: TransactionJournalRecord, now = Date.now()): TransactionJournalRecord {
  return {
    ...record,
    lastCheckedAt: now,
    lifecycleRevision: record.lifecycleRevision + 1,
    reconciliationAttempts: record.reconciliationAttempts + 1,
    updatedAt: now
  };
}

function monitoringPriority(record: TransactionJournalRecord): number {
  if (["submitted", "confirming", "orphaned", "replaced"].includes(record.status)) return 0;
  if (record.status === "canonical") return 1;
  if (["unknown-submission", "reconciling"].includes(record.status)) return 2;
  return 3;
}

export function persistTransactionJournal(storage: StorageLike, state: TransactionJournalState): TransactionJournalState {
  const persisted = mergeTransactionJournals(loadTransactionJournal(storage), state);
  storage.setItem(TRANSACTION_JOURNAL_STORAGE_KEY, JSON.stringify(persisted));
  return persisted;
}

export function mergeTransactionJournals(
  left: TransactionJournalState,
  right: TransactionJournalState
): TransactionJournalState {
  const byId = new Map(left.records.map((record) => [record.id, record]));
  for (const incoming of right.records) {
    const existing = byId.get(incoming.id);
    if (existing === undefined) {
      byId.set(incoming.id, incoming);
      continue;
    }
    if (transactionSemanticKey(existing.reviewed) !== transactionSemanticKey(incoming.reviewed) ||
      transactionScopeKey(existing.reviewed) !== transactionScopeKey(incoming.reviewed)) continue;
    const preferred = (
      incoming.lifecycleRevision > existing.lifecycleRevision ||
      (incoming.lifecycleRevision === existing.lifecycleRevision && incoming.updatedAt > existing.updatedAt)
    ) ? incoming : existing;
    const other = preferred === incoming ? existing : incoming;
    const hashes = mergeHashEvidence(existing.hashes, incoming.hashes);
    const activeHash = mergedActiveHash(existing.activeHash, incoming.activeHash, hashes);
    const activeHashAmbiguous = existing.activeHash !== null && incoming.activeHash !== null && activeHash === null;
    const status = mergedLifecycleStatus(preferred, activeHash, activeHashAmbiguous);
    byId.set(incoming.id, {
      ...preferred,
      actualNonce: preferred.actualNonce ?? other.actualNonce,
      activeHash,
      canonicalReceipt: preferred.canonicalReceipt ?? other.canonicalReceipt,
      hashes,
      rejectionReason: activeHashAmbiguous ? "Concurrent journal writers observed unlinked active hashes; reconciling all hash evidence" : preferred.rejectionReason,
      replacementCompatibility: preferred.replacementCompatibility ?? other.replacementCompatibility,
      replacementFinalized: preferred.replacementFinalized,
      status,
      submittedAt: minNullable(existing.submittedAt, incoming.submittedAt),
      timeoutAt: Math.max(existing.timeoutAt, incoming.timeoutAt)
    });
  }
  return {
    records: boundRecords([...byId.values()]),
    revision: Math.max(left.revision, right.revision),
    version: TRANSACTION_JOURNAL_VERSION
  };
}

function mergedLifecycleStatus(
  preferred: TransactionJournalRecord,
  activeHash: `0x${string}` | null,
  activeHashAmbiguous: boolean
): TransactionJournalStatus {
  if (activeHashAmbiguous) return "reconciling";
  if (activeHash !== null && ["awaiting-wallet", "unknown-submission", "rejected", "aborted"].includes(preferred.status)) return "submitted";
  return preferred.status;
}

export function loadTransactionJournal(storage: StorageLike): TransactionJournalState {
  try {
    const raw = storage.getItem(TRANSACTION_JOURNAL_STORAGE_KEY);
    if (raw === null) return emptyTransactionJournal();
    const parsed = JSON.parse(raw) as unknown;
    if (!isJournalEnvelope(parsed)) return emptyTransactionJournal();
    return {
      records: boundRecords(parsed.records
        .filter(isJournalRecord)
        .map((record) => ({ ...record, reviewed: Object.freeze({ ...record.reviewed }) }))
        .sort((left, right) => left.createdAt - right.createdAt)),
      revision: parsed.revision,
      version: TRANSACTION_JOURNAL_VERSION
    };
  } catch {
    return emptyTransactionJournal();
  }
}

export function isUserRejectedSubmission(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (candidate.code === 4001 || candidate.name === "UserRejectedRequestError") return true;
    current = candidate.cause;
  }
  return false;
}

function transactionMatchesIdentity(record: TransactionJournalRecord, transaction: JournalTransactionObservation): boolean {
  if (!sameHex(transaction.from, record.reviewed.account)) return false;
  if (record.activeHash !== null && sameHex(transaction.hash, record.activeHash)) return true;
  return transaction.nonce === (record.actualNonce ?? record.expectedNonce);
}

function applyIncompatibleReplacementReceipt(
  record: TransactionJournalRecord,
  observation: TransactionJournalObservation,
  requiredConfirmations: number
): TransactionJournalRecord {
  const receipt = observation.receipt;
  const blockIsCanonical = receipt !== null &&
    observation.canonicalBlockHash !== null &&
    sameHex(observation.canonicalBlockHash, receipt.blockHash) &&
    sameHex(receipt.hash, record.activeHash!);
  const head = parseStoredBigInt(observation.headBlockNumber);
  const receiptBlock = receipt === null ? null : BigInt(receipt.blockNumber);
  const confirmations = !blockIsCanonical || head === null || receiptBlock === null || head < receiptBlock
    ? 0
    : Number(head - receiptBlock + 1n);
  return {
    ...record,
    canonicalReceipt: blockIsCanonical ? receipt : (record.canonicalReceipt ?? receipt),
    confirmations,
    rejectionReason: "A different transaction replaced this nonce; the reviewed intent was not executed",
    replacementFinalized: blockIsCanonical && confirmations >= requiredConfirmations,
    status: "replaced"
  };
}

function transactionSemanticKey(reviewed: ReviewedTransactionIntent): string {
  return JSON.stringify([
    reviewed.intent,
    reviewed.contractsFingerprint,
    reviewed.poolId,
    reviewed.target.toLowerCase(),
    reviewed.recipient?.toLowerCase() ?? null,
    reviewed.refundRecipient?.toLowerCase() ?? null,
    reviewed.calldataFingerprint.toLowerCase(),
    reviewed.value,
    reviewed.settingsFingerprint,
    reviewed.executionFingerprint
  ]);
}

function transactionMatchesReviewedIntent(record: TransactionJournalRecord, transaction: JournalTransactionObservation): boolean {
  return transaction.target !== null &&
    sameHex(transaction.target, record.reviewed.target) &&
    transaction.calldataFingerprint.toLowerCase() === record.reviewed.calldataFingerprint.toLowerCase() &&
    BigInt(transaction.value) === BigInt(record.reviewed.value);
}

function appendHash(
  hashes: TransactionHashRecord[],
  hash: `0x${string}`,
  role: TransactionHashRecord["role"],
  observedAt: number
): TransactionHashRecord[] {
  return hashes.some((candidate) => sameHex(candidate.hash, hash))
    ? hashes
    : [...hashes, { hash: normalizeHex(hash), observedAt, replacedByHash: null, replacesHash: null, role }];
}

function appendReplacementHash(
  hashes: TransactionHashRecord[],
  replacedHash: `0x${string}`,
  replacementHash: `0x${string}`,
  observedAt: number
): TransactionHashRecord[] {
  const linked = hashes.map((item) => sameHex(item.hash, replacedHash)
    ? { ...item, replacedByHash: normalizeHex(replacementHash) }
    : item);
  return linked.some((item) => sameHex(item.hash, replacementHash))
    ? linked
    : [...linked, {
        hash: normalizeHex(replacementHash),
        observedAt,
        replacedByHash: null,
        replacesHash: normalizeHex(replacedHash),
        role: "replacement"
      }];
}

function mergeHashEvidence(left: TransactionHashRecord[], right: TransactionHashRecord[]): TransactionHashRecord[] {
  const merged = new Map<string, TransactionHashRecord>();
  for (const item of [...left, ...right]) {
    const key = item.hash.toLowerCase();
    const existing = merged.get(key);
    merged.set(key, existing === undefined ? item : {
      ...existing,
      observedAt: Math.min(existing.observedAt, item.observedAt),
      replacedByHash: existing.replacedByHash ?? item.replacedByHash,
      replacesHash: existing.replacesHash ?? item.replacesHash,
      role: existing.role === "replacement" || item.role === "replacement" ? "replacement" : "submitted"
    });
  }
  return [...merged.values()].sort((a, b) => a.observedAt - b.observedAt);
}

function mergedActiveHash(
  left: `0x${string}` | null,
  right: `0x${string}` | null,
  hashes: TransactionHashRecord[]
): `0x${string}` | null {
  if (left === null) return right;
  if (right === null || sameHex(left, right)) return left;
  const leftEvidence = hashes.find((item) => sameHex(item.hash, left));
  const rightEvidence = hashes.find((item) => sameHex(item.hash, right));
  if (leftEvidence?.replacedByHash && sameHex(leftEvidence.replacedByHash, right)) return right;
  if (rightEvidence?.replacedByHash && sameHex(rightEvidence.replacedByHash, left)) return left;
  return null;
}

function minNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function updateTransactionRecord(
  state: TransactionJournalState,
  id: string,
  update: (record: TransactionJournalRecord) => TransactionJournalRecord
): TransactionJournalState {
  const nextRecords = state.records.map((record) => record.id === id ? update(record) : record);
  return nextRecords.every((record, index) => record === state.records[index]) ? state : withRecords(state, nextRecords);
}

function withRecords(state: TransactionJournalState, records: TransactionJournalRecord[]): TransactionJournalState {
  return {
    records: boundRecords(records),
    revision: state.revision + 1,
    version: TRANSACTION_JOURNAL_VERSION
  };
}

function boundRecords(records: TransactionJournalRecord[]): TransactionJournalRecord[] {
  const unresolved = records.filter((record) => !isTerminalRecord(record));
  if (unresolved.length > TRANSACTION_JOURNAL_MAX_RECORDS) {
    throw new Error("Transaction journal contains more unresolved intents than its safe persistence bound");
  }
  const terminal = records.filter(isTerminalRecord);
  const terminalSlots = TRANSACTION_JOURNAL_MAX_RECORDS - unresolved.length;
  return [...unresolved, ...(terminalSlots === 0 ? [] : terminal.slice(-terminalSlots))]
    .sort((left, right) => left.createdAt - right.createdAt);
}

function isTerminalRecord(record: TransactionJournalRecord): boolean {
  return !transactionNeedsMonitoring(record);
}

function rewindScanCursor(submissionBlock: string): string {
  const block = BigInt(submissionBlock);
  return (block > 0n ? block - 1n : 0n).toString();
}

function createIntentId(now: number): string {
  return globalThis.crypto?.randomUUID?.() ?? `${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeHex<T extends `0x${string}`>(value: T): T {
  return value.toLowerCase() as T;
}

function sameHex(left: `0x${string}`, right: `0x${string}`): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseStoredBigInt(value: string | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function isJournalEnvelope(value: unknown): value is { records: unknown[]; revision: number; version: number } {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TransactionJournalState>;
  return state.version === TRANSACTION_JOURNAL_VERSION &&
    typeof state.revision === "number" &&
    Array.isArray(state.records);
}

function isJournalRecord(value: unknown): value is TransactionJournalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TransactionJournalRecord>;
  const structurallyValid = typeof record.id === "string" && record.id.length > 0 && record.id.length <= 200 &&
    isFiniteNonNegative(record.createdAt) &&
    isFiniteNonNegative(record.updatedAt) &&
    isFiniteNonNegative(record.timeoutAt) &&
    isIntegerNonNegative(record.lifecycleRevision) &&
    isIntegerNonNegative(record.reconciliationAttempts) &&
    isIntegerNonNegative(record.confirmations) &&
    typeof record.expectedNonce === "string" && /^\d+$/.test(record.expectedNonce) &&
    (record.actualNonce === null || (typeof record.actualNonce === "string" && /^\d+$/.test(record.actualNonce))) &&
    typeof record.submissionBlock === "string" && /^\d+$/.test(record.submissionBlock) &&
    (record.activeHash === null || isHash(record.activeHash)) &&
    (record.lastCheckedAt === null || isFiniteNonNegative(record.lastCheckedAt)) &&
    (record.submittedAt === null || isFiniteNonNegative(record.submittedAt)) &&
    (record.rejectionReason === null || typeof record.rejectionReason === "string") &&
    (record.replacementCompatibility === null || record.replacementCompatibility === "matching" || record.replacementCompatibility === "incompatible") &&
    typeof record.status === "string" &&
    JOURNAL_STATUSES.has(record.status as TransactionJournalStatus) &&
    typeof record.replacementFinalized === "boolean" &&
    typeof record.walletLeaseUntil === "number" && Number.isFinite(record.walletLeaseUntil) &&
    typeof record.scanCursor === "string" && /^\d+$/.test(record.scanCursor) &&
    Array.isArray(record.hashes) &&
    record.hashes.every((hash) =>
      isHash(hash?.hash) &&
      isFiniteNonNegative(hash.observedAt) &&
      (hash.role === "submitted" || hash.role === "replacement") &&
      (hash.replacesHash === null || isHash(hash.replacesHash)) &&
      (hash.replacedByHash === null || isHash(hash.replacedByHash))
    ) &&
    (record.canonicalReceipt === null || isReceipt(record.canonicalReceipt)) &&
    isReviewedIntent(record.reviewed);
  if (!structurallyValid) return false;
  const valid = record as TransactionJournalRecord;
  if (valid.activeHash !== null && !valid.hashes.some((item) => sameHex(item.hash, valid.activeHash!))) return false;
  if (["confirming", "canonical"].includes(valid.status)) {
    if (valid.actualNonce === null || valid.activeHash === null || valid.canonicalReceipt?.status !== "success" || !sameHex(valid.canonicalReceipt.hash, valid.activeHash)) return false;
  }
  if (valid.status === "canonical" && valid.confirmations < TRANSACTION_JOURNAL_CONFIRMATIONS) return false;
  if (valid.status === "confirming" && (valid.confirmations <= 0 || valid.confirmations >= TRANSACTION_JOURNAL_CONFIRMATIONS)) return false;
  if (valid.status === "reverted") {
    if (
      valid.activeHash === null ||
      valid.canonicalReceipt?.status !== "reverted" ||
      !sameHex(valid.canonicalReceipt.hash, valid.activeHash)
    ) return false;
  }
  if (valid.status === "submitted" && valid.activeHash === null) return false;
  if (["awaiting-wallet", "unknown-submission"].includes(valid.status) && valid.activeHash !== null) return false;
  if (["awaiting-wallet", "rejected", "aborted"].includes(valid.status) &&
    (valid.activeHash !== null || valid.actualNonce !== null || valid.hashes.length > 0 || valid.canonicalReceipt !== null || valid.submittedAt !== null)) return false;
  if (valid.replacementFinalized &&
    (valid.status !== "replaced" || valid.replacementCompatibility !== "incompatible" || valid.canonicalReceipt === null || valid.confirmations < TRANSACTION_JOURNAL_CONFIRMATIONS)) return false;
  return true;
}

function isReviewedIntent(value: unknown): value is ReviewedTransactionIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<ReviewedTransactionIntent>;
  return isAddress(intent.account) &&
    isIntegerNonNegative(intent.chainId) &&
    typeof intent.environment === "string" &&
    typeof intent.deploymentEpoch === "string" &&
    typeof intent.contractsFingerprint === "string" &&
    typeof intent.executionFingerprint === "string" &&
    isHash(intent.calldataFingerprint) &&
    typeof intent.intent === "string" && JOURNAL_INTENTS.has(intent.intent as TransactionIntentClass) &&
    (intent.poolId === null || typeof intent.poolId === "string") &&
    (intent.recipient === null || isAddress(intent.recipient)) &&
    (intent.refundRecipient === null || isAddress(intent.refundRecipient)) &&
    typeof intent.settingsFingerprint === "string" &&
    isAddress(intent.target) &&
    typeof intent.value === "string" && /^\d+$/.test(intent.value);
}

function isReceipt(value: unknown): value is NonNullable<TransactionJournalRecord["canonicalReceipt"]> {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<NonNullable<TransactionJournalRecord["canonicalReceipt"]>>;
  return isHash(receipt.hash) && isHash(receipt.blockHash) &&
    typeof receipt.blockNumber === "string" && /^\d+$/.test(receipt.blockNumber) &&
    (receipt.status === "success" || receipt.status === "reverted");
}

function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIntegerNonNegative(value: unknown): value is number {
  return isFiniteNonNegative(value) && Number.isInteger(value);
}

const JOURNAL_INTENTS = new Set<TransactionIntentClass>(["approval", "create-pool", "add-liquidity", "swap", "remove-liquidity"]);

const JOURNAL_STATUSES = new Set<TransactionJournalStatus>([
  "awaiting-wallet",
  "aborted",
  "reconciling",
  "unknown-submission",
  "rejected",
  "submitted",
  "confirming",
  "canonical",
  "reverted",
  "replaced",
  "orphaned",
  "timed-out"
]);
