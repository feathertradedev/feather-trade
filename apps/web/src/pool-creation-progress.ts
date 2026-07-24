import type { PoolCreationRecoveryState } from "./pool-creation";
import type { TransactionJournalRecord } from "./transaction-journal";

export const POOL_CREATION_PROGRESS_STEPS = [
  "Submitted",
  "Confirming",
  "Confirmed",
  "Identity verified",
  "Discovering",
  "Pool ready"
] as const;

export type PoolCreationProgressTone = "neutral" | "working" | "ready" | "warning" | "error";

export interface PoolCreationProgress {
  /** Zero means the wallet has not returned an authoritative transaction hash. */
  verifiedStep: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  detail: string;
  tone: PoolCreationProgressTone;
  terminal: boolean;
  canCheckStatus: boolean;
  canStartFreshReview: boolean;
}

export function poolCreationProgress(
  journal: TransactionJournalRecord | null,
  recovery: PoolCreationRecoveryState | null,
  poolDiscovered: boolean
): PoolCreationProgress {
  if (recovery?.kind === "duplicate") {
    return {
      verifiedStep: 6,
      title: recovery.source === "race-winner" ? "The pool was created first by another transaction" : "This pool already exists",
      detail: "No duplicate creation was submitted. Feather verified the exact factory, tokens, bin step, active ID, and live price.",
      tone: "ready",
      terminal: true,
      canCheckStatus: false,
      canStartFreshReview: true
    };
  }
  if (recovery?.kind === "wallet-rejection" || journal?.status === "rejected") {
    return {
      verifiedStep: 0,
      title: "Creation was not submitted",
      detail: "The wallet declined the request. No transaction hash was accepted and no pool was created.",
      tone: "warning",
      terminal: true,
      canCheckStatus: false,
      canStartFreshReview: true
    };
  }
  if (recovery?.kind === "mined-revert" || journal?.status === "reverted") {
    return {
      verifiedStep: 3,
      title: "Creation reverted on-chain",
      detail: "The transaction was mined but did not create a pool. Feather will not resubmit it automatically.",
      tone: "error",
      terminal: true,
      canCheckStatus: false,
      canStartFreshReview: true
    };
  }
  if (recovery?.kind === "reorg" || journal?.status === "orphaned") {
    return {
      verifiedStep: 1,
      title: "Confirmation changed after a chain reorganization",
      detail: "The earlier receipt is no longer canonical. Feather removed the optimistic pool result and is checking whether the transaction is re-included.",
      tone: "warning",
      terminal: false,
      canCheckStatus: true,
      canStartFreshReview: false
    };
  }
  if (recovery?.kind === "created-empty") {
    return poolDiscovered
      ? {
          verifiedStep: 6,
          title: "Empty pool ready",
          detail: "The pool is confirmed and discoverable. It has no liquidity yet, so swaps cannot quote until a separately reviewed position funds it.",
          tone: "ready",
          terminal: true,
          canCheckStatus: false,
          canStartFreshReview: true
        }
      : {
          verifiedStep: 5,
          title: "Empty pool confirmed · discovery catching up",
          detail: "The exact pool exists with zero reserves. Analytics has not published it yet; Feather is continuing to check without resubmitting.",
          tone: "working",
          terminal: false,
          canCheckStatus: true,
          canStartFreshReview: false
        };
  }
  if (recovery?.kind === "indexing-lag") {
    return {
      verifiedStep: 5,
      title: "Pool verified · discovery catching up",
      detail: "Factory identity and the empty creation state are confirmed. Analytics is still indexing the creation block; swaps remain disabled.",
      tone: "working",
      terminal: false,
      canCheckStatus: true,
      canStartFreshReview: false
    };
  }
  if (recovery?.kind === "canonical-confirmation") {
    return {
      verifiedStep: 4,
      title: "Pool identity verified",
      detail: "The canonical factory event and live pair identity match. Feather is verifying the empty state and waiting for discovery.",
      tone: "working",
      terminal: false,
      canCheckStatus: true,
      canStartFreshReview: false
    };
  }
  if (
    recovery?.kind === "add-rejected" ||
    recovery?.kind === "add-reverted" ||
    recovery?.kind === "add-ambiguous-submission"
  ) {
    return {
      verifiedStep: 6,
      title: "Pool ready · position not completed",
      detail: "Pool creation remains canonical. Creating liquidity is a separate transaction and requires a fresh review.",
      tone: recovery.kind === "add-ambiguous-submission" ? "warning" : "ready",
      terminal: true,
      canCheckStatus: recovery.kind === "add-ambiguous-submission",
      canStartFreshReview: true
    };
  }
  if (recovery?.kind === "ambiguous-submission") {
    return {
      verifiedStep: recovery.transactionHash === null ? 0 : 1,
      title: recovery.transactionHash === null ? "Checking whether the wallet broadcast" : "Transaction found · waiting for confirmation",
      detail: "Submission identity is not settled yet. Feather is reconciling the sender and nonce, and duplicate creation remains blocked.",
      tone: "warning",
      terminal: false,
      canCheckStatus: true,
      canStartFreshReview: false
    };
  }

  if (journal === null) {
    return {
      verifiedStep: 0,
      title: "Ready for wallet review",
      detail: "No pool-creation transaction has been submitted.",
      tone: "neutral",
      terminal: false,
      canCheckStatus: false,
      canStartFreshReview: false
    };
  }

  switch (journal.status) {
    case "awaiting-wallet":
      return {
        verifiedStep: 0,
        title: "Waiting for your wallet",
        detail: "Review the exact transaction in your wallet. Nothing is submitted until the wallet returns a transaction hash.",
        tone: "working",
        terminal: false,
        canCheckStatus: false,
        canStartFreshReview: false
      };
    case "submitted":
    case "replaced":
      return {
        verifiedStep: 1,
        title: journal.status === "replaced" ? "Replacement transaction submitted" : "Transaction submitted",
        detail: "The network has the transaction hash. Feather is waiting for a canonical receipt and will not submit another transaction.",
        tone: "working",
        terminal: false,
        canCheckStatus: true,
        canStartFreshReview: false
      };
    case "confirming":
      return {
        verifiedStep: 2,
        title: "Waiting for confirmation",
        detail: `${journal.confirmations} confirmation${journal.confirmations === 1 ? "" : "s"} observed. Feather requires a canonical receipt before verifying the pool.`,
        tone: "working",
        terminal: false,
        canCheckStatus: true,
        canStartFreshReview: false
      };
    case "canonical":
      return {
        verifiedStep: 3,
        title: "Confirmed on-chain",
        detail: "The receipt is canonical. Feather is now verifying the exact factory event and live pool identity.",
        tone: "working",
        terminal: false,
        canCheckStatus: true,
        canStartFreshReview: false
      };
    case "unknown-submission":
    case "reconciling":
    case "timed-out":
      return {
        verifiedStep: journal.activeHash === null ? 0 : 1,
        title: journal.status === "timed-out" ? "Confirmation is taking longer than expected" : "Checking submission status",
        detail: journal.activeHash === null
          ? "The wallet result is uncertain. Feather is searching by sender and nonce; do not submit a duplicate."
          : "The transaction hash is known, but canonical confirmation is not. Status checks will continue safely.",
        tone: "warning",
        terminal: false,
        canCheckStatus: true,
        canStartFreshReview: false
      };
    case "aborted":
      return {
        verifiedStep: 0,
        title: "Creation review expired before submission",
        detail: "The account, chain, or deployment changed before wallet broadcast. No transaction was submitted.",
        tone: "warning",
        terminal: true,
        canCheckStatus: false,
        canStartFreshReview: true
      };
  }
}

export function formatPoolCreationElapsed(startedAt: number, now: number): string {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || now <= startedAt) return "just now";
  const seconds = Math.floor((now - startedAt) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
