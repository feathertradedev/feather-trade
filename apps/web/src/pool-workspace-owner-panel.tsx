import { useMemo, type ReactNode } from "react";

import {
  formatExactPriceFraction,
  normalizeQ128Price,
  priceQ128FromActiveId
} from "../../../packages/sdk/src/liquidity-price";

import { formatCompactAddress, formatTokenAmount, tokenSymbol, type PositionHistoryRow } from "./data";
import { returnHrefFromAction } from "./pool-discovery";
import { summarizePoolPosition, type PoolPositionSummary } from "./pool-workspace";
import { usePoolDraftState, usePoolWorkspace } from "./pool-workspace-context";
import { poolWorkspaceHref, type PoolWorkspaceTask } from "./pool-workspace-route";

type OwnerPanelTab = "positions" | "history";

const HISTORY_ROW_LIMIT = 12;

export function PoolWorkspaceOwnerPanel() {
  const workspace = usePoolWorkspace();
  const [activeTab, setActiveTab] = usePoolDraftState<OwnerPanelTab>("workspace.ownerPanelTab", "positions");
  const summary = useMemo(
    () => summarizePoolPosition(workspace.positions, workspace.pool.activeId),
    [workspace.pool.activeId, workspace.positions]
  );
  const returnHref = returnHrefFromAction(window.location.hash);
  const manageHref = workspaceTaskHref(workspace.pool.id, "manage", returnHref);
  const createHref = workspaceTaskHref(workspace.pool.id, "create", returnHref);

  return (
    <section className="pool-workspace-owner-panel" data-testid="pool-workspace-owner-panel">
      <header className="pool-owner-panel-header">
        <div aria-label="Wallet liquidity" className="pool-owner-tabs" role="tablist">
          <button
            aria-controls="pool-owner-positions-panel"
            aria-selected={activeTab === "positions"}
            className="pool-owner-tab"
            id="pool-owner-positions-tab"
            onClick={() => setActiveTab("positions")}
            role="tab"
            type="button"
          >
            Positions
          </button>
          <button
            aria-controls="pool-owner-history-panel"
            aria-selected={activeTab === "history"}
            className="pool-owner-tab"
            id="pool-owner-history-tab"
            onClick={() => setActiveTab("history")}
            role="tab"
            type="button"
          >
            History
          </button>
        </div>
        {activeTab === "positions" && summary !== null ? (
          <a
            className="pool-owner-panel-action"
            data-testid="pool-position-manage-link"
            href={manageHref}
            onClick={() => workspace.setDraftValue<string[]>("liquidity.selectedPositionIds", summary.positionIds, [])}
          >
            Manage position
          </a>
        ) : null}
      </header>

      {activeTab === "positions" ? (
        <div
          aria-labelledby="pool-owner-positions-tab"
          className="pool-owner-panel-body"
          id="pool-owner-positions-panel"
          role="tabpanel"
        >
          <PositionPanelContent createHref={createHref} summary={summary} />
        </div>
      ) : (
        <div
          aria-labelledby="pool-owner-history-tab"
          className="pool-owner-panel-body"
          id="pool-owner-history-panel"
          role="tabpanel"
        >
          <HistoryPanelContent />
        </div>
      )}
    </section>
  );
}

function PositionPanelContent({ createHref, summary }: { createHref: string; summary: PoolPositionSummary | null }) {
  const workspace = usePoolWorkspace();

  if (workspace.walletAddress === null) {
    return (
      <OwnerPanelState
        detail="Connect a wallet from the header to view your liquidity in this pool."
        title="No wallet connected"
      />
    );
  }
  if (workspace.positionsState === "loading") return <OwnerPanelSkeleton label="Loading pool position" />;
  if (workspace.positionsState === "unavailable") {
    return <OwnerPanelState detail="Owner-scoped position data is not configured for this environment." title="Positions unavailable" />;
  }
  if (summary === null) {
    if (workspace.positionsState === "error") {
      return <OwnerPanelState detail={workspace.positionsError ?? "The position request failed."} title="Positions could not load" tone="error" />;
    }
    return (
      <OwnerPanelState
        action={<a className="pool-owner-empty-action" href={createHref}>Create position</a>}
        detail="This wallet has no indexed liquidity in the selected pool."
        title="No liquidity in this pool"
      />
    );
  }

  const positionRange = formatPositionRange(workspace.pool, summary);
  const pairLabel = `${tokenSymbol(workspace.pool.tokenX)} / ${tokenSymbol(workspace.pool.tokenY)}`;
  return (
    <>
      {workspace.positionsState === "partial" || workspace.positionsState === "error" ? (
        <OwnerPanelNotice tone={workspace.positionsState === "error" ? "error" : "partial"}>
          {workspace.positionsError ?? "Some owner balances could not be loaded. Known liquidity remains visible."}
        </OwnerPanelNotice>
      ) : null}
      <article className="pool-owner-position-row" data-testid="pool-position-summary">
        <div className="pool-owner-position-heading">
          <div>
            <strong>{pairLabel}</strong>
            <span>{summary.binCount} active {summary.binCount === 1 ? "bin" : "bins"} · updated block {summary.latestBlock}</span>
          </div>
          <span className={summary.inActiveBin ? "active" : "inactive"}>{summary.inActiveBin ? "In range" : "Out of range"}</span>
        </div>
        <dl className="pool-owner-position-metrics">
          <div>
            <dt>Position range</dt>
            <dd>{positionRange}</dd>
          </div>
          <div>
            <dt>Indexed liquidity</dt>
            <dd>{formatTokenAmount(summary.liquidity, null)}</dd>
          </div>
        </dl>
      </article>
    </>
  );
}

function HistoryPanelContent() {
  const workspace = usePoolWorkspace();

  if (workspace.walletAddress === null) {
    return (
      <OwnerPanelState
        detail="Connect a wallet from the header to view deposits, withdrawals, and transfers for this pool."
        title="No wallet connected"
      />
    );
  }
  if (workspace.historyState === "loading") return <OwnerPanelSkeleton label="Loading position history" />;
  if (workspace.historyState === "unavailable") {
    return <OwnerPanelState detail="Owner-scoped position history is not configured for this environment." title="History unavailable" />;
  }
  if (workspace.history.length === 0) {
    if (workspace.historyState === "error") {
      return <OwnerPanelState detail={workspace.historyError ?? "The history request failed."} title="History could not load" tone="error" />;
    }
    return <OwnerPanelState detail="No indexed liquidity events were found for this wallet and pool." title="No position history yet" />;
  }

  const visibleHistory = workspace.history.slice(0, HISTORY_ROW_LIMIT);
  return (
    <>
      {workspace.historyState === "partial" || workspace.historyState === "error" ? (
        <OwnerPanelNotice tone={workspace.historyState === "error" ? "error" : "partial"}>
          {workspace.historyError ?? "Some history pages could not be loaded. Known events remain visible."}
        </OwnerPanelNotice>
      ) : null}
      <div className="pool-owner-history-list">
        {visibleHistory.map((event) => <PoolPositionHistoryRow event={event} key={event.id} />)}
      </div>
      {workspace.history.length > HISTORY_ROW_LIMIT ? (
        <p className="pool-owner-history-limit">Showing the latest {HISTORY_ROW_LIMIT} of {workspace.history.length} events.</p>
      ) : null}
    </>
  );
}

function PoolPositionHistoryRow({ event }: { event: PositionHistoryRow }) {
  const workspace = usePoolWorkspace();
  const explorerUrl = workspace.registry.chain.blockExplorers?.default?.url;
  const transactionLabel = formatCompactAddress(event.transactionHash);
  const eventAmounts = event.amountX === null && event.amountY === null
    ? `${event.binIds.length} ${event.binIds.length === 1 ? "bin" : "bins"}`
    : [
        event.amountX === null ? null : `${formatTokenAmount(event.amountX, workspace.pool.tokenX)} ${tokenSymbol(workspace.pool.tokenX)}`,
        event.amountY === null ? null : `${formatTokenAmount(event.amountY, workspace.pool.tokenY)} ${tokenSymbol(workspace.pool.tokenY)}`
      ].filter((value): value is string => value !== null).join(" · ");

  return (
    <article className="pool-owner-history-row" data-testid="pool-history-row">
      <div>
        <strong>{formatHistoryType(event.type)}</strong>
        <span>{formatHistoryTime(event.timestamp)}</span>
      </div>
      <span>{eventAmounts}</span>
      <span>Block {event.blockNumber}</span>
      {explorerUrl ? (
        <a href={`${explorerUrl}/tx/${encodeURIComponent(event.transactionHash)}`} rel="noreferrer" target="_blank">{transactionLabel} ↗</a>
      ) : (
        <span>{transactionLabel}</span>
      )}
    </article>
  );
}

function OwnerPanelState({
  action,
  detail,
  title,
  tone = "neutral"
}: {
  action?: ReactNode;
  detail: string;
  title: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div className={`pool-owner-empty ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <strong>{title}</strong>
      <span>{detail}</span>
      {action}
    </div>
  );
}

function OwnerPanelSkeleton({ label }: { label: string }) {
  return (
    <div aria-label={label} className="pool-owner-skeleton" role="status">
      <span />
      <span />
      <span />
    </div>
  );
}

function OwnerPanelNotice({ children, tone }: { children: ReactNode; tone: "partial" | "error" }) {
  return <p className={`pool-owner-notice ${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</p>;
}

function formatPositionRange(pool: ReturnType<typeof usePoolWorkspace>["pool"], summary: PoolPositionSummary): string {
  if (pool.tokenX === null || pool.tokenY === null) return "Unavailable";
  try {
    const min = formatPositionPrice(pool, summary.minBinId);
    const max = formatPositionPrice(pool, summary.maxBinId);
    return `${min} – ${max} ${tokenSymbol(pool.tokenY)} per ${tokenSymbol(pool.tokenX)}`;
  } catch {
    return "Unavailable";
  }
}

function formatPositionPrice(pool: ReturnType<typeof usePoolWorkspace>["pool"], binId: string): string {
  if (pool.tokenX === null || pool.tokenY === null) throw new Error("Pool token metadata is unavailable");
  const rawPrice = priceQ128FromActiveId(BigInt(binId), BigInt(pool.binStep));
  const normalized = normalizeQ128Price(rawPrice, {
    baseDecimals: pool.tokenX.decimals,
    inverse: false,
    quoteDecimals: pool.tokenY.decimals
  });
  return formatExactPriceFraction(normalized, 6);
}

function formatHistoryType(type: string): string {
  if (type === "DEPOSIT") return "Added liquidity";
  if (type === "WITHDRAW") return "Removed liquidity";
  if (type === "TRANSFER_IN") return "Received position";
  if (type === "TRANSFER_OUT") return "Sent position";
  if (type === "TRANSFER") return "Transferred position";
  return type.toLowerCase().replaceAll("_", " ");
}

function formatHistoryTime(timestamp: string): string {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(value * 1_000));
}

function workspaceTaskHref(poolId: string, task: PoolWorkspaceTask, returnHref: string | null): string {
  const href = poolWorkspaceHref(poolId, task);
  return returnHref === null ? href : `${href}?${new URLSearchParams({ returnTo: returnHref }).toString()}`;
}
