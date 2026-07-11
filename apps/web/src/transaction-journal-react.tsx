import { createDexPublicClient } from "@robinhood-lb/sdk/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keccak256, type Address, type Hex } from "viem";

import {
  TRANSACTION_JOURNAL_CONFIRMATIONS,
  TRANSACTION_JOURNAL_STORAGE_KEY,
  applyTransactionObservation,
  beginTransactionIntent,
  emptyTransactionJournal,
  isUserRejectedSubmission,
  loadTransactionJournal,
  mergeTransactionJournals,
  persistTransactionJournal,
  recordAbortedSubmission,
  recordRejectedSubmission,
  recordSubmittedHash,
  recordUnknownSubmission,
  recoverAwaitingWalletIntents,
  deferTransactionMonitoring,
  selectTransactionRecordsForMonitoring,
  transactionRetryBlocked,
  type ReviewedTransactionIntent,
  type TransactionJournalObservation,
  type TransactionJournalRecord,
  type TransactionJournalState
} from "./transaction-journal";
import { registries, type EnvironmentKey } from "./config";

export interface TransactionIntentHandle {
  id: string;
  lifecycleRevision: number;
}

export interface TransactionJournalApi {
  abort(handle: TransactionIntentHandle): Promise<void>;
  begin(reviewed: ReviewedTransactionIntent): Promise<TransactionIntentHandle>;
  fail(handle: TransactionIntentHandle, error: unknown): Promise<void>;
  records: TransactionJournalRecord[];
  retryBlocked(reviewed: ReviewedTransactionIntent): boolean;
  submitted(handle: TransactionIntentHandle, hash: Address): Promise<void>;
}

const TransactionJournalContext = createContext<TransactionJournalApi | null>(null);
const RECONCILE_INTERVAL_MS = 3_000;

export function TransactionJournalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TransactionJournalState>(emptyTransactionJournal);
  const [ready, setReady] = useState(false);
  const stateRef = useRef(state);
  const initializationRef = useRef<Promise<void> | null>(null);
  stateRef.current = state;

  const commit = useCallback(async (update: (current: TransactionJournalState) => TransactionJournalState) => {
    await withJournalLock(async () => {
      const current = mergeTransactionJournals(stateRef.current, loadTransactionJournal(window.localStorage));
      const next = update(current);
      if (next === current) {
        stateRef.current = current;
        setState(current);
        return;
      }
      const persisted = persistTransactionJournal(window.localStorage, next);
      stateRef.current = persisted;
      setState(persisted);
    });
  }, []);

  const ensureInitialized = useCallback(() => {
    initializationRef.current ??= withJournalLock(async () => {
      const recovered = recoverAwaitingWalletIntents(loadTransactionJournal(window.localStorage));
      const persisted = persistTransactionJournal(window.localStorage, recovered);
      stateRef.current = persisted;
      setState(persisted);
      setReady(true);
    });
    return initializationRef.current;
  }, []);

  useEffect(() => {
    void ensureInitialized();
  }, [ensureInitialized]);

  const begin = useCallback(async (reviewed: ReviewedTransactionIntent): Promise<TransactionIntentHandle> => {
    await ensureInitialized();
    const registry = registries[reviewed.environment as EnvironmentKey];
    if (!registry) throw new Error("Transaction journal cannot resolve the reviewed deployment environment");
    if (reviewed.chainId !== registry.chainId || reviewed.deploymentEpoch !== registryDeploymentEpoch(registry)) {
      throw new Error("Transaction journal blocked a reviewed intent whose chain or deployment identity is stale");
    }
    const client = createDexPublicClient(registry.chain, registry.endpoints.rpcUrl);
    const [expectedNonce, submissionBlock] = await Promise.all([
      client.getTransactionCount({ address: reviewed.account, blockTag: "pending" }),
      client.getBlockNumber()
    ]);
    return withJournalLock(async () => {
      const current = mergeTransactionJournals(stateRef.current, loadTransactionJournal(window.localStorage));
      if (transactionRetryBlocked(current, reviewed)) {
        throw new Error("A matching transaction intent is still unresolved; retry is blocked until reconciliation completes");
      }
      const next = beginTransactionIntent(current, reviewed, { expectedNonce: BigInt(expectedNonce), submissionBlock });
      const record = next.records[next.records.length - 1];
      if (!record) throw new Error("Transaction intent was not retained by the durable journal");
      const persisted = persistTransactionJournal(window.localStorage, next);
      const durable = loadTransactionJournal(window.localStorage).records.find((candidate) => candidate.id === record.id);
      if (!durable || durable.lifecycleRevision !== record.lifecycleRevision) {
        throw new Error("Transaction intent could not be verified in durable storage; wallet submission was blocked");
      }
      stateRef.current = persisted;
      setState(persisted);
      return { id: record.id, lifecycleRevision: record.lifecycleRevision };
    });
  }, [ensureInitialized]);

  const submitted = useCallback(async (handle: TransactionIntentHandle, hash: Address) => {
    await withJournalLock(async () => {
      const current = mergeTransactionJournals(stateRef.current, loadTransactionJournal(window.localStorage));
      const next = recordSubmittedHash(current, handle.id, handle.lifecycleRevision, hash);
      const persisted = persistTransactionJournal(window.localStorage, next);
      stateRef.current = persisted;
      setState(persisted);
    });
  }, []);

  const fail = useCallback(async (handle: TransactionIntentHandle, error: unknown) => {
    await commit((current) => isUserRejectedSubmission(error)
      ? recordRejectedSubmission(current, handle.id, handle.lifecycleRevision, journalErrorMessage(error))
      : recordUnknownSubmission(current, handle.id, handle.lifecycleRevision, journalErrorMessage(error)));
  }, [commit]);

  const abort = useCallback(async (handle: TransactionIntentHandle) => {
    await commit((current) => recordAbortedSubmission(current, handle.id, handle.lifecycleRevision));
  }, [commit]);

  const retryBlocked = useCallback((reviewed: ReviewedTransactionIntent) =>
    !ready || transactionRetryBlocked(stateRef.current, reviewed), [ready]);

  useEffect(() => {
    const mergeFromStorage = (event: StorageEvent) => {
      if (event.key !== TRANSACTION_JOURNAL_STORAGE_KEY) return;
      const persisted = loadTransactionJournal(window.localStorage);
      const merged = mergeTransactionJournals(stateRef.current, persisted);
      stateRef.current = merged;
      setState(merged);
    };
    window.addEventListener("storage", mergeFromStorage);
    return () => window.removeEventListener("storage", mergeFromStorage);
  }, []);

  useEffect(() => {
    let disposed = false;
    let running = false;
    const reconcile = async () => {
      if (running || disposed) return;
      running = true;
      try {
        await ensureInitialized();
        await commit((current) => recoverAwaitingWalletIntents(current));
        const snapshot = stateRef.current;
        const candidates = selectTransactionRecordsForMonitoring(snapshot.records);
        if (candidates.length === 0) return;
        for (const record of candidates) {
          if (disposed) return;
          try {
            const registry = registries[record.reviewed.environment as EnvironmentKey];
            if (!registry || record.reviewed.chainId !== registry.chainId || record.reviewed.deploymentEpoch !== registryDeploymentEpoch(registry)) {
              await commit((current) => {
                const currentRecord = current.records.find((candidate) => candidate.id === record.id);
                if (!currentRecord || currentRecord.lifecycleRevision !== record.lifecycleRevision) return current;
                return {
                  ...current,
                  records: current.records.map((candidate) => candidate.id === record.id ? deferTransactionMonitoring(candidate) : candidate),
                  revision: current.revision + 1
                };
              });
              continue;
            }
            const client = createDexPublicClient(registry.chain, registry.endpoints.rpcUrl);
            const headBlockNumber = await client.getBlockNumber();
            const observation = await observeRecord(client, record, headBlockNumber);
            if (disposed) return;
            await commit((current) => {
              const currentRecord = current.records.find((candidate) => candidate.id === record.id);
              if (!currentRecord || currentRecord.lifecycleRevision !== record.lifecycleRevision) return current;
              return {
                ...current,
                records: current.records.map((candidate) => candidate.id === record.id
                  ? applyTransactionObservation(candidate, observation, TRANSACTION_JOURNAL_CONFIRMATIONS)
                  : candidate),
                revision: current.revision + 1
              };
            });
          } catch {
            // A failed deployment RPC cannot starve reconciliation for other records.
            await commit((current) => {
              const currentRecord = current.records.find((candidate) => candidate.id === record.id);
              if (!currentRecord || currentRecord.lifecycleRevision !== record.lifecycleRevision) return current;
              return {
                ...current,
                records: current.records.map((candidate) => candidate.id === record.id ? deferTransactionMonitoring(candidate) : candidate),
                revision: current.revision + 1
              };
            });
          }
        }
      } catch {
        // Transport errors leave durable records untouched and retry-locked for the next reconciliation pass.
      } finally {
        running = false;
      }
    };
    void reconcile();
    const interval = window.setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [commit, ensureInitialized]);

  const api = useMemo<TransactionJournalApi>(() => ({ abort, begin, fail, records: state.records, retryBlocked, submitted }), [abort, begin, fail, retryBlocked, state.records, submitted]);
  return <TransactionJournalContext.Provider value={api}>{children}</TransactionJournalContext.Provider>;
}

export function useTransactionJournal(): TransactionJournalApi {
  const context = useContext(TransactionJournalContext);
  if (context === null) throw new Error("Transaction journal provider is missing");
  return context;
}

async function observeRecord(
  client: ReturnType<typeof createDexPublicClient>,
  record: TransactionJournalRecord,
  headBlockNumber: bigint
): Promise<TransactionJournalObservation> {
  let transaction = null;
  let receipt = null;
  let transactionLookup: TransactionJournalObservation["transactionLookup"] = "missing";
  let receiptLookup: TransactionJournalObservation["receiptLookup"] = "missing";
  let canonicalBlockLookup: TransactionJournalObservation["canonicalBlockLookup"] = "missing";
  let scannedThroughBlock: string | null = null;
  if (record.activeHash !== null) {
    try {
      const fetched = await client.getTransaction({ hash: record.activeHash });
      transaction = {
        blockHash: fetched.blockHash,
        blockNumber: fetched.blockNumber?.toString() ?? null,
        calldataFingerprint: keccak256(fetched.input),
        from: fetched.from,
        hash: fetched.hash,
        nonce: fetched.nonce.toString(),
        target: fetched.to,
        value: fetched.value.toString()
      };
      transactionLookup = "found";
    } catch (error) {
      transactionLookup = rpcLookupFailure(error);
    }
    const receiptHash = transaction?.hash ?? record.activeHash;
    try {
      const fetchedReceipt = await client.getTransactionReceipt({ hash: receiptHash });
      receipt = {
        blockHash: fetchedReceipt.blockHash,
        blockNumber: fetchedReceipt.blockNumber.toString(),
        hash: fetchedReceipt.transactionHash,
        status: fetchedReceipt.status
      };
      receiptLookup = "found";
    } catch (error) {
      receiptLookup = rpcLookupFailure(error);
    }
    if (receiptLookup === "missing" && record.actualNonce !== null) {
      const scan = await scanCanonicalTransaction(client, record, headBlockNumber, false);
      scannedThroughBlock = scan.scannedThroughBlock;
      if (scan.transaction !== null) {
        transaction = scan.transaction;
        transactionLookup = "found";
        if (transaction.hash.toLowerCase() !== receiptHash.toLowerCase()) {
          try {
            const replacementReceipt = await client.getTransactionReceipt({ hash: transaction.hash });
            receipt = {
              blockHash: replacementReceipt.blockHash,
              blockNumber: replacementReceipt.blockNumber.toString(),
              hash: replacementReceipt.transactionHash,
              status: replacementReceipt.status
            };
            receiptLookup = "found";
          } catch (error) {
            receiptLookup = rpcLookupFailure(error);
          }
        }
      }
    }
  } else {
    const scan = await scanCanonicalTransaction(client, record, headBlockNumber, true);
    transaction = scan.transaction;
    scannedThroughBlock = scan.scannedThroughBlock;
    transactionLookup = transaction === null ? "missing" : "found";
    if (transaction !== null) {
      try {
        const fetchedReceipt = await client.getTransactionReceipt({ hash: transaction.hash });
        receipt = {
          blockHash: fetchedReceipt.blockHash,
          blockNumber: fetchedReceipt.blockNumber.toString(),
          hash: fetchedReceipt.transactionHash,
          status: fetchedReceipt.status
        };
        receiptLookup = "found";
      } catch (error) {
        receiptLookup = rpcLookupFailure(error);
      }
    }
  }

  let canonicalBlockHash: Hex | null = null;
  if (receipt !== null) {
    try {
      canonicalBlockHash = (await client.getBlock({ blockNumber: BigInt(receipt.blockNumber) })).hash;
      canonicalBlockLookup = "found";
    } catch (error) {
      canonicalBlockHash = null;
      canonicalBlockLookup = rpcLookupFailure(error);
    }
  }
  const [latestNonce, pendingNonce] = await Promise.all([
    client.getTransactionCount({ address: record.reviewed.account, blockTag: "latest" }).catch(() => null),
    client.getTransactionCount({ address: record.reviewed.account, blockTag: "pending" }).catch(() => null)
  ]);
  return {
    canonicalBlockHash,
    canonicalBlockLookup,
    headBlockNumber: headBlockNumber.toString(),
    latestNonce: latestNonce?.toString() ?? null,
    now: Date.now(),
    pendingNonce: pendingNonce?.toString() ?? null,
    receipt,
    receiptLookup,
    scannedThroughBlock,
    transaction,
    transactionLookup
  };
}

async function scanCanonicalTransaction(
  client: ReturnType<typeof createDexPublicClient>,
  record: TransactionJournalRecord,
  headBlockNumber: bigint,
  requireSemanticMatch: boolean
) {
  const start = BigInt(record.scanCursor) + 1n;
  const end = start + 31n < headBlockNumber ? start + 31n : headBlockNumber;
  if (start > headBlockNumber) return { scannedThroughBlock: record.scanCursor, transaction: null };
  let scannedThroughBlock = BigInt(record.scanCursor);
  for (let blockNumber = start; blockNumber <= end; blockNumber += 1n) {
    const block = await client.getBlock({ blockNumber, includeTransactions: true }).catch(() => null);
    if (block === null) break;
    scannedThroughBlock = blockNumber;
    for (const transaction of block.transactions) {
      if (typeof transaction === "string") continue;
      const nonce = record.actualNonce ?? record.expectedNonce;
      const identityMatch =
        transaction.from.toLowerCase() === record.reviewed.account.toLowerCase() &&
        transaction.nonce.toString() === nonce;
      const semanticMatch =
        transaction.to?.toLowerCase() === record.reviewed.target.toLowerCase() &&
        keccak256(transaction.input).toLowerCase() === record.reviewed.calldataFingerprint.toLowerCase() &&
        transaction.value.toString() === record.reviewed.value;
      if (identityMatch && (!requireSemanticMatch || semanticMatch)) {
        return { scannedThroughBlock: blockNumber.toString(), transaction: {
          blockHash: transaction.blockHash,
          blockNumber: transaction.blockNumber?.toString() ?? null,
          calldataFingerprint: keccak256(transaction.input),
          from: transaction.from,
          hash: transaction.hash,
          nonce: transaction.nonce.toString(),
          target: transaction.to,
          value: transaction.value.toString()
        } };
      }
    }
  }
  return { scannedThroughBlock: scannedThroughBlock.toString(), transaction: null };
}

function registryDeploymentEpoch(registry: (typeof registries)[EnvironmentKey]): string {
  return [
    registry.chainId,
    registry.startBlock,
    registry.endpoints.rpcUrl,
    registry.contracts.lbFactory,
    registry.contracts.lbPairImplementation,
    registry.contracts.lbQuoter,
    registry.contracts.lbRouter
  ].join("|");
}

function journalErrorMessage(error: unknown): string {
  return isUserRejectedSubmission(error)
    ? "User rejected the wallet request"
    : "Wallet transport ended without returning a transaction hash";
}

function rpcLookupFailure(error: unknown): "missing" | "unavailable" {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  return /NotFound/i.test(name) ? "missing" : "unavailable";
}

async function withJournalLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) {
    throw new Error("This browser cannot provide the exclusive storage lock required for safe transaction journaling");
  }
  return navigator.locks.request(TRANSACTION_JOURNAL_STORAGE_KEY, { mode: "exclusive" }, operation);
}
