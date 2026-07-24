import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatUnits } from "viem";

import {
  formatExactPriceFraction,
  normalizeQ128Price,
  priceQ128FromActiveId
} from "../../../packages/sdk/src/liquidity-price";

import {
  formatCompactAddress,
  formatTokenAmount,
  tokenSymbol,
  type ActivityRow,
  type PortfolioPositionRow,
  type PositionHistoryRow,
  type PositionRow
} from "./data";
import { returnHrefFromAction } from "./pool-discovery";
import {
  createPoolManageSelectionIntent,
  poolManageSelectionIntentHref,
  summarizePoolPosition,
} from "./pool-workspace";
import { usePoolDraftState, usePoolWorkspace } from "./pool-workspace-context";
import { poolWorkspaceHref, type PoolWorkspaceTask } from "./pool-workspace-route";

type OwnerPanelTab = "positions" | "history";
type HistoryPanelTab = "position" | "activity";

const HISTORY_ROW_LIMIT = 12;

function handleTablistKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (currentIndex < 0 || tabs.length === 0) return;
  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  const nextTab = tabs[nextIndex]!;
  nextTab.focus();
  nextTab.click();
}

export function PoolWorkspaceOwnerPanel() {
  const workspace = usePoolWorkspace();
  const [activeTab, setActiveTab] = usePoolDraftState<OwnerPanelTab>("workspace.ownerPanelTab", "positions");
  const summary = useMemo(
    () => summarizePoolPosition(workspace.positions, null),
    [workspace.positions]
  );
  const manageSelectionIntent = useMemo(
    () => createPoolManageSelectionIntent(
      workspace.positions,
      workspace.walletAddress,
      workspace.pool.address
    ),
    [workspace.pool.address, workspace.positions, workspace.walletAddress]
  );
  const returnHref = returnHrefFromAction(window.location.hash);
  const manageHref = manageSelectionIntent === null
    ? workspaceTaskHref(workspace.pool.id, "manage", returnHref)
    : poolManageSelectionIntentHref(
        workspaceTaskHref(workspace.pool.id, "manage", returnHref),
        manageSelectionIntent
      );
  const createHref = workspaceTaskHref(workspace.pool.id, "create", returnHref);
  const canManage = canManagePoolPosition(
    workspace.positions,
    workspace.positionsState,
    workspace.portfolio.position,
    workspace.portfolio.headPinned
  );

  return (
    <section className="pool-workspace-owner-panel" data-testid="pool-workspace-owner-panel">
      <header className="pool-owner-panel-header">
        <div aria-label="Wallet liquidity" className="pool-owner-tabs" onKeyDown={handleTablistKeyDown} role="tablist">
          <button
            aria-controls="pool-owner-positions-panel"
            aria-selected={activeTab === "positions"}
            className="pool-owner-tab"
            id="pool-owner-positions-tab"
            onClick={() => setActiveTab("positions")}
            role="tab"
            tabIndex={activeTab === "positions" ? 0 : -1}
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
            tabIndex={activeTab === "history" ? 0 : -1}
            type="button"
          >
            History
          </button>
        </div>
        {activeTab === "positions" && summary !== null && canManage && manageSelectionIntent !== null ? (
          <a
            className="pool-owner-panel-action"
            data-testid="pool-position-manage-link"
            href={manageHref}
          >
            Manage position
          </a>
        ) : null}
      </header>

      <div
        aria-labelledby="pool-owner-positions-tab"
        className="pool-owner-panel-body"
        hidden={activeTab !== "positions"}
        id="pool-owner-positions-panel"
        role="tabpanel"
        tabIndex={0}
      >
        <PositionPanelContent createHref={createHref} summary={summary} />
      </div>
      <div
        aria-labelledby="pool-owner-history-tab"
        className="pool-owner-panel-body"
        hidden={activeTab !== "history"}
        id="pool-owner-history-panel"
        role="tabpanel"
        tabIndex={0}
      >
        <HistoryPanelContent />
      </div>
    </section>
  );
}

function PositionPanelContent({ createHref, summary }: { createHref: string; summary: ReturnType<typeof summarizePoolPosition> }) {
  const workspace = usePoolWorkspace();
  const portfolio = workspace.portfolio;

  if (workspace.walletAddress === null) {
    return (
      <OwnerPanelState
        detail="Connect a wallet from the header to view your liquidity in this pool."
        title="No wallet connected"
      />
    );
  }
  if (portfolio.state === "loading" && summary === null) return <OwnerPanelSkeleton label="Loading pool position accounting" />;
  if (portfolio.position === null) {
    if (summary !== null) return <RawPositionAccountingFallback positionState={portfolio.state} summary={summary} />;
    if (workspace.positionsState === "loading") return <OwnerPanelSkeleton label="Loading owner position bins" />;
    if (workspace.positionsState === "error") {
      return <OwnerPanelState detail={workspace.positionsError ?? "The owner position request failed."} title="Position bins could not load" tone="error" />;
    }
    if (workspace.positionsState === "partial" || workspace.positionsState === "stale") {
      return (
        <OwnerPanelState
          detail={workspace.positionsError ?? "Owner position bins are incomplete, so an empty result cannot be treated as proof that no position exists."}
          title={workspace.positionsState === "stale" ? "Position bins are stale" : "Position bins are partial"}
          tone={workspace.positionsState}
        />
      );
    }
    if (portfolio.state === "error") {
      return <OwnerPanelState detail={portfolio.error ?? "The owner accounting request failed."} title="Position accounting could not load" tone="error" />;
    }
    if (portfolio.state === "partial" || portfolio.state === "stale") {
      return (
        <OwnerPanelState
          detail={portfolio.error ?? "Owner accounting is incomplete, so an empty result cannot be treated as proof that no position exists."}
          title={portfolio.state === "stale" ? "Position accounting is stale" : "Position accounting is partial"}
          tone={portfolio.state}
        />
      );
    }
    if (workspace.positionsState === "unavailable") {
      return <OwnerPanelState detail="Owner-scoped position bins are not configured for this environment." title="Position bins unavailable" />;
    }
    if (portfolio.state === "unavailable") {
      if (workspace.positionsState !== "empty") {
        return <OwnerPanelState detail="Owner-scoped position accounting is not configured for this environment." title="Position accounting unavailable" />;
      }
    }
    if (workspace.positionsState !== "empty" || (portfolio.state !== "empty" && portfolio.state !== "unavailable")) {
      return <OwnerPanelState detail="Owner position sources have not reconciled to a clean empty state." title="Position state unavailable" tone="partial" />;
    }
    return (
      <OwnerPanelState
        action={<a className="pool-owner-empty-action" href={createHref}>Create position</a>}
        detail={portfolio.state === "unavailable"
          ? "The canonical indexer has no owner bins for this pool. Accounting analytics are unavailable."
          : "This wallet has no canonical position accounting for the selected pool."}
        title="No liquidity in this pool"
      />
    );
  }

  return <PoolPositionAccounting position={portfolio.position} rawSummary={summary} />;
}

function RawPositionAccountingFallback({
  positionState,
  summary
}: {
  positionState: ReturnType<typeof usePoolWorkspace>["portfolio"]["state"];
  summary: NonNullable<ReturnType<typeof summarizePoolPosition>>;
}) {
  const workspace = usePoolWorkspace();
  const pairLabel = `${tokenSymbol(workspace.pool.tokenX)} / ${tokenSymbol(workspace.pool.tokenY)}`;
  const tone = positionState === "error" ? "error" : positionState === "stale" ? "stale" : "partial";

  return (
    <>
      <OwnerPanelNotice testId="pool-owner-accounting-notice" tone={tone}>
        {workspace.portfolio.error ?? "Indexed position bins are available, but canonical owner accounting is still reconciling. Accounting values remain unavailable rather than being shown as zero."}
      </OwnerPanelNotice>
      <article className="pool-owner-position-row" data-testid="pool-position-accounting">
        <div className="pool-owner-position-summary" data-testid="pool-position-summary">
          <div className="pool-owner-position-heading">
            <div>
              <strong>{pairLabel}</strong>
              <span>{summary.binCount} active {summary.binCount === 1 ? "bin" : "bins"} · raw bins at block {summary.latestBlock}</span>
            </div>
            <span className="unknown">Range unknown</span>
          </div>
          <dl className="pool-owner-position-metrics">
            <div className="range"><dt>Position range</dt><dd>{formatPositionRange(workspace.pool, summary.minBinId, summary.maxBinId)}</dd></div>
            <div><dt>Current value</dt><dd>Unavailable</dd></div>
            <div><dt>Cost basis</dt><dd>Unavailable</dd></div>
            <div><dt>Unrealized P&amp;L</dt><dd>Unavailable</dd></div>
            <div><dt>Realized P&amp;L</dt><dd>Unavailable</dd></div>
            <div><dt>{tokenSymbol(workspace.pool.tokenX)} claim</dt><dd>Unavailable</dd></div>
            <div><dt>{tokenSymbol(workspace.pool.tokenY)} claim</dt><dd>Unavailable</dd></div>
            <div><dt>Indexed liquidity</dt><dd>{formatTokenAmount(summary.liquidity, null)}</dd></div>
          </dl>
          <p className="pool-owner-accounting-note">
            Management uses the validated owner and pair bins, then rechecks live balances. Accounting data is not used as a transaction quote.
          </p>
        </div>
      </article>
    </>
  );
}

function PoolPositionAccounting({ position, rawSummary }: { position: PortfolioPositionRow; rawSummary: ReturnType<typeof summarizePoolPosition> }) {
  const workspace = usePoolWorkspace();
  const activeBins = positivePortfolioBins(position);
  const range = portfolioBinRange(activeBins);
  const hasBalance = activeBins.length > 0;
  const rawHasBalance = rawSummary !== null;
  const rawBinsConfirmed = workspace.positionsState === "ready" || workspace.positionsState === "empty";
  const balancesReconciling = !rawBinsConfirmed || !portfolioBinsMatchRaw(workspace.positions, position);
  const rangeState = poolPositionRangeState(
    range,
    workspace.economics.value?.activeId.toString() ?? null,
    workspace.portfolio.headPinned,
    hasBalance,
    balancesReconciling
  );
  const claimX = portfolioClaim(position, "x");
  const claimY = portfolioClaim(position, "y");
  const notice = portfolioAccountingNotice(workspace, hasBalance, rawHasBalance, balancesReconciling);
  const pairLabel = `${tokenSymbol(workspace.pool.tokenX)} / ${tokenSymbol(workspace.pool.tokenY)}`;
  const asOfBlock = position.asOfBlock ?? "unavailable";

  return (
    <>
      {notice === null ? null : (
        <OwnerPanelNotice testId="pool-owner-accounting-notice" tone={notice.tone}>
          {notice.detail}
        </OwnerPanelNotice>
      )}
      <article className="pool-owner-position-row" data-testid="pool-position-accounting">
        <div className="pool-owner-position-summary" data-testid="pool-position-summary">
          <div className="pool-owner-position-heading">
            <div>
              <strong>{pairLabel}</strong>
              <span>{activeBins.length} active {activeBins.length === 1 ? "bin" : "bins"} · claims at block {asOfBlock}</span>
            </div>
            <span className={rangeState.tone}>{rangeState.label}</span>
          </div>
          <dl className="pool-owner-position-metrics">
            <div className="range">
              <dt>Position range</dt>
              <dd>{range === null ? "Unavailable" : formatPositionRange(workspace.pool, range.minBinId, range.maxBinId)}</dd>
            </div>
            <div>
              <dt>Current value</dt>
              <dd>{formatPortfolioUsd(position.currentValueUsdE18)}</dd>
            </div>
            <div>
              <dt>Cost basis</dt>
              <dd>{formatPortfolioUsd(position.costBasisUsdE18)}</dd>
            </div>
            <div>
              <dt>Unrealized P&amp;L</dt>
              <dd>{formatPortfolioUsd(position.unrealizedPnlUsdE18)}</dd>
            </div>
            <div>
              <dt>Realized P&amp;L</dt>
              <dd>{formatPortfolioUsd(position.realizedPnlUsdE18)}</dd>
            </div>
            <div>
              <dt>{tokenSymbol(workspace.pool.tokenX)} claim</dt>
              <dd>{formatPortfolioClaim(claimX, workspace.pool.tokenX)}</dd>
            </div>
            <div>
              <dt>{tokenSymbol(workspace.pool.tokenY)} claim</dt>
              <dd>{formatPortfolioClaim(claimY, workspace.pool.tokenY)}</dd>
            </div>
            <div>
              <dt>Indexed liquidity</dt>
              <dd>{formatTokenAmount(portfolioLiquidity(activeBins), null)}</dd>
            </div>
          </dl>
          <p className="pool-owner-accounting-note">
            {balancesReconciling
              ? "Position accounting and management bins are reconciling. Management remains unavailable unless validated raw bins are present."
              : hasBalance
              ? "Fee growth is included in token claims and current value. There is no separate claim action."
              : "This position has no remaining LB balance. It may have been transferred or fully exited."}
          </p>
        </div>
      </article>
    </>
  );
}

function HistoryPanelContent() {
  const [activeTab, setActiveTab] = usePoolDraftState<HistoryPanelTab>("workspace.ownerHistoryTab", "position");

  return (
    <>
      <div className="pool-owner-history-toolbar">
        <div aria-label="History view" className="pool-owner-history-tabs" onKeyDown={handleTablistKeyDown} role="tablist">
          <button
            aria-controls="pool-position-history-view"
            aria-selected={activeTab === "position"}
            className="pool-owner-history-tab"
            id="pool-position-history-tab"
            onClick={() => setActiveTab("position")}
            role="tab"
            tabIndex={activeTab === "position" ? 0 : -1}
            type="button"
          >
            Position history
          </button>
          <button
            aria-controls="pool-activity-view"
            aria-selected={activeTab === "activity"}
            className="pool-owner-history-tab"
            id="pool-activity-tab"
            onClick={() => setActiveTab("activity")}
            role="tab"
            tabIndex={activeTab === "activity" ? 0 : -1}
            type="button"
          >
            Pool activity
          </button>
        </div>
      </div>
      <div aria-labelledby="pool-position-history-tab" hidden={activeTab !== "position"} id="pool-position-history-view" role="tabpanel" tabIndex={0}>
        <PositionHistoryContent />
      </div>
      <div aria-labelledby="pool-activity-tab" hidden={activeTab !== "activity"} id="pool-activity-view" role="tabpanel" tabIndex={0}>
        <PoolActivityContent />
      </div>
    </>
  );
}

function PositionHistoryContent() {
  const workspace = usePoolWorkspace();
  const [visibleCount, setVisibleCount] = useState(HISTORY_ROW_LIMIT);

  if (workspace.walletAddress === null) {
    return (
      <OwnerPanelState
        detail="Connect a wallet to view deposits, withdrawals, and transfers for this pool. Pool activity remains available in the adjacent view."
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
    if (workspace.historyState === "partial" || workspace.historyState === "stale") {
      return (
        <OwnerPanelState
          detail={workspace.historyError ?? "Canonical owner history is incomplete, so no events can be confirmed yet."}
          title={workspace.historyState === "stale" ? "Position history is stale" : "Position history is partial"}
          tone={workspace.historyState}
        />
      );
    }
    return <OwnerPanelState detail="No canonical liquidity or position-transfer events were found for this wallet and pool." title="No position history yet" />;
  }

  const visibleHistory = workspace.history.slice(0, visibleCount);
  const remaining = workspace.history.length - visibleHistory.length;
  return (
    <>
      {workspace.historyState === "partial" || workspace.historyState === "stale" || workspace.historyState === "error" ? (
        <OwnerPanelNotice tone={workspace.historyState === "error" ? "error" : workspace.historyState}>
          {workspace.historyError ?? "Some history pages could not be loaded. Known events remain visible."}
        </OwnerPanelNotice>
      ) : null}
      <div className="pool-owner-history-list">
        {visibleHistory.map((event) => <PoolPositionHistoryRow event={event} key={event.id} />)}
      </div>
      <div className="pool-owner-history-limit">
        <span>Showing {visibleHistory.length} of {workspace.history.length} events</span>
        {remaining > 0 ? (
          <button
            data-testid="pool-history-load-more"
            onClick={() => setVisibleCount((current) => current + HISTORY_ROW_LIMIT)}
            type="button"
          >
            Load {Math.min(HISTORY_ROW_LIMIT, remaining)} more
          </button>
        ) : null}
      </div>
    </>
  );
}

function PoolActivityContent() {
  const workspace = usePoolWorkspace();
  const activity = workspace.activity;

  return (
    <div data-testid="pool-activity-feed">
      <div className="pool-owner-activity-heading">
        <span>{activity.windowed ? "Latest canonical pool events" : "Canonical pool events"}</span>
        {workspace.walletAddress === null ? (
          <small>Connect to filter by wallet</small>
        ) : (
          <button
            aria-pressed={activity.walletOnly}
            data-testid="pool-activity-wallet-filter"
            onClick={() => activity.setWalletOnly(!activity.walletOnly)}
            type="button"
          >
            My wallet
          </button>
        )}
      </div>
      {activity.state === "loading" ? <OwnerPanelSkeleton label="Loading pool activity" /> : null}
      {activity.state === "unavailable" ? (
        <OwnerPanelState detail="Canonical pair activity is not configured for this environment." title="Pool activity unavailable" />
      ) : null}
      {activity.state === "error" && activity.rows.length === 0 ? (
        <OwnerPanelState detail={activity.error ?? "The pool activity request failed."} title="Pool activity could not load" tone="error" />
      ) : null}
      {(activity.state === "partial" || activity.state === "stale" || (activity.state === "error" && activity.rows.length > 0)) ? (
        <OwnerPanelNotice tone={activity.state === "error" ? "error" : activity.state}>
          {activity.error ?? "Pool activity is incomplete. Known canonical events remain visible."}
        </OwnerPanelNotice>
      ) : null}
      {activity.state !== "loading" && activity.state !== "unavailable" && !(activity.state === "error" && activity.rows.length === 0) ? (
        activity.rows.length === 0 ? (
          <OwnerPanelState
            detail={activity.walletOnly
              ? "No canonical liquidity or position events from this wallet were found in the current pool window."
              : "No canonical swaps, liquidity changes, or position transfers were found in the current pool window."}
            title={activity.walletOnly ? "No wallet activity" : "No pool activity yet"}
          />
        ) : (
          <>
            <div className="pool-owner-history-list">
              {activity.rows.map((event) => <PoolActivityRow event={event} key={event.id} />)}
            </div>
            <div className="pool-owner-history-limit">
              <span>{activity.windowed ? `Latest ${activity.rows.length} events` : `${activity.rows.length} events`}</span>
            </div>
          </>
        )
      ) : null}
    </div>
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
      ].filter((value): value is string => value !== null).join(" / ");

  return (
    <article className="pool-owner-history-row" data-testid="pool-history-row">
      <div>
        <strong>{formatHistoryType(event.type)}</strong>
        <span>{formatHistoryTime(event.timestamp)}</span>
      </div>
      <span>{eventAmounts}</span>
      <span>Block {event.blockNumber}</span>
      {explorerUrl && event.transactionHash !== "" ? (
        <a href={`${explorerUrl}/tx/${encodeURIComponent(event.transactionHash)}`} rel="noreferrer" target="_blank">{transactionLabel} ↗</a>
      ) : (
        <span>{event.transactionHash === "" ? "Canonical event" : transactionLabel}</span>
      )}
    </article>
  );
}

function PoolActivityRow({ event }: { event: ActivityRow }) {
  const workspace = usePoolWorkspace();
  const explorerUrl = workspace.registry.chain.blockExplorers?.default?.url;
  const eventAmounts = [
    event.amountX === null ? null : `${formatTokenAmount(event.amountX, workspace.pool.tokenX)} ${tokenSymbol(workspace.pool.tokenX)}`,
    event.amountY === null ? null : `${formatTokenAmount(event.amountY, workspace.pool.tokenY)} ${tokenSymbol(workspace.pool.tokenY)}`
  ].filter((value): value is string => value !== null).join(" / ") || "Amounts unavailable";
  const transactionLabel = formatCompactAddress(event.transactionHash);

  return (
    <article className="pool-owner-history-row pool-owner-activity-row" data-testid="pool-activity-row">
      <div>
        <strong>{formatHistoryType(event.type)}</strong>
        <span>{formatHistoryTime(event.timestamp)}</span>
      </div>
      <span>{eventAmounts}</span>
      <span>{formatCompactAddress(event.account)}</span>
      {explorerUrl && event.transactionHash !== "" ? (
        <a href={`${explorerUrl}/tx/${encodeURIComponent(event.transactionHash)}`} rel="noreferrer" target="_blank">{transactionLabel} ↗</a>
      ) : (
        <span>{event.transactionHash === "" ? "Canonical event" : transactionLabel}</span>
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
  tone?: "neutral" | "partial" | "stale" | "error";
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

function OwnerPanelNotice({ children, testId, tone }: { children: ReactNode; testId?: string; tone: "neutral" | "partial" | "stale" | "error" }) {
  return <p className={`pool-owner-notice ${tone}`} data-testid={testId} role={tone === "error" ? "alert" : "status"}>{children}</p>;
}

function positivePortfolioBins(position: PortfolioPositionRow): PortfolioPositionRow["bins"] {
  return position.bins.filter((bin) => {
    try {
      return BigInt(bin.liquidity) > 0n;
    } catch {
      return false;
    }
  });
}

function canManagePoolPosition(
  rawPositions: readonly PositionRow[],
  rawState: ReturnType<typeof usePoolWorkspace>["positionsState"],
  position: PortfolioPositionRow | null,
  headPinned: boolean
): boolean {
  if (rawState !== "ready" || position === null || !headPinned) return false;
  const rawBins = positiveRawBinIds(rawPositions);
  return rawBins.size > 0 && portfolioBinsMatchRaw(rawPositions, position);
}

function portfolioBinsMatchRaw(
  rawPositions: readonly PositionRow[],
  position: PortfolioPositionRow
): boolean {
  const rawBins = positiveRawBinIds(rawPositions);
  const accountingBins = new Set<string>();
  for (const bin of positivePortfolioBins(position)) {
    try {
      accountingBins.add(BigInt(bin.binId).toString());
    } catch {
      return false;
    }
  }
  if (rawBins.size !== accountingBins.size) return false;
  return [...rawBins].every((binId) => accountingBins.has(binId));
}

function positiveRawBinIds(positions: readonly PositionRow[]): Set<string> {
  const bins = new Set<string>();
  for (const position of positions) {
    try {
      if (BigInt(position.liquidity) > 0n) bins.add(BigInt(position.binId).toString());
    } catch {
      return new Set();
    }
  }
  return bins;
}

function portfolioBinRange(bins: PortfolioPositionRow["bins"]): { minBinId: string; maxBinId: string } | null {
  if (bins.length === 0) return null;
  try {
    const sorted = bins.map((bin) => BigInt(bin.binId)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return { minBinId: sorted[0]!.toString(), maxBinId: sorted.at(-1)!.toString() };
  } catch {
    return null;
  }
}

function poolPositionRangeState(
  range: { minBinId: string; maxBinId: string } | null,
  activeId: string | null,
  headPinned: boolean,
  hasBalance: boolean,
  balancesReconciling: boolean
): { label: string; tone: "active" | "inactive" | "unknown" | "closed" } {
  if (balancesReconciling) return { label: "Range unknown", tone: "unknown" };
  if (!hasBalance) return { label: "Transferred / exited", tone: "closed" };
  if (!headPinned || activeId === null || range === null) return { label: "Range unknown", tone: "unknown" };
  try {
    const active = BigInt(activeId);
    const inRange = active >= BigInt(range.minBinId) && active <= BigInt(range.maxBinId);
    return inRange ? { label: "In range", tone: "active" } : { label: "Out of range", tone: "inactive" };
  } catch {
    return { label: "Range unknown", tone: "unknown" };
  }
}

function portfolioClaim(position: PortfolioPositionRow, side: "x" | "y"): string | null {
  const values = position.bins.map((bin) => side === "x" ? bin.amountX : bin.amountY);
  if (values.some((value) => value === null)) return null;
  if (values.length === 0 && position.status !== "READY") return null;
  try {
    return values.reduce((total, value) => total + BigInt(value ?? "0"), 0n).toString();
  } catch {
    return null;
  }
}

function portfolioLiquidity(bins: PortfolioPositionRow["bins"]): string {
  try {
    return bins.reduce((total, bin) => total + BigInt(bin.liquidity), 0n).toString();
  } catch {
    return "0";
  }
}

function formatPortfolioClaim(value: string | null, token: ReturnType<typeof usePoolWorkspace>["pool"]["tokenX"]): string {
  if (value === null) return "Unavailable";
  try {
    return `${formatTokenAmount(value, token)} ${tokenSymbol(token)}`;
  } catch {
    return "Unavailable";
  }
}

function formatPortfolioUsd(value: string | null): string {
  if (value === null) return "Unavailable";
  try {
    const exact = formatUnits(BigInt(value), 18);
    const numeric = Number(exact);
    if (Number.isFinite(numeric)) {
      return new Intl.NumberFormat(undefined, {
        currency: "USD",
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
        style: "currency"
      }).format(numeric);
    }
    return exact.startsWith("-") ? `-$${exact.slice(1)}` : `$${exact}`;
  } catch {
    return "Unavailable";
  }
}

function portfolioAccountingNotice(
  workspace: ReturnType<typeof usePoolWorkspace>,
  hasBalance: boolean,
  rawHasBalance: boolean,
  balancesReconciling: boolean
): { detail: string; tone: "neutral" | "partial" | "stale" | "error" } | null {
  if (balancesReconciling) {
    return {
      detail: hasBalance && !rawHasBalance
        ? "Canonical accounting shows a balance, but validated management bins are still reconciling. Values remain visible; management is unavailable until raw bins agree."
        : !hasBalance && rawHasBalance
          ? "Canonical accounting reports no remaining LB balance, but validated management bins are still reconciling. Values remain visible without treating either source as final."
          : "Canonical accounting and validated management bins disagree. Range is unknown and management remains unavailable until the exact positive-bin sets reconcile.",
      tone: "partial"
    };
  }
  if (workspace.portfolio.state === "error") {
    return { detail: workspace.portfolio.error ?? "Some owner accounting could not be loaded. Known values remain visible.", tone: "error" };
  }
  if (workspace.portfolio.state === "stale" || !workspace.portfolio.headPinned) {
    return {
      detail: workspace.portfolio.error ?? "Position accounting is reconciling with the current canonical head. Range is unknown and unavailable values are not treated as zero.",
      tone: "stale"
    };
  }
  if (workspace.portfolio.state === "partial" || workspace.portfolio.partial) {
    return {
      detail: workspace.portfolio.error ?? "Some position history or pricing is incomplete. Known claims remain visible and unavailable values are not treated as zero.",
      tone: "partial"
    };
  }
  if (workspace.economics.value === null) {
    return {
      detail: "The current active-bin state is unavailable. Position accounting remains visible, but range status is unknown.",
      tone: "partial"
    };
  }
  if (!hasBalance) {
    return {
      detail: "No remaining LB balance is indexed for this position. It may have been transferred or fully exited.",
      tone: "neutral"
    };
  }
  return null;
}

function formatPositionRange(pool: ReturnType<typeof usePoolWorkspace>["pool"], minBinId: string, maxBinId: string): string {
  if (pool.tokenX === null || pool.tokenY === null) return "Unavailable";
  try {
    const min = formatPositionPrice(pool, minBinId);
    const max = formatPositionPrice(pool, maxBinId);
    return `${min} to ${max} ${tokenSymbol(pool.tokenY)} per ${tokenSymbol(pool.tokenX)}`;
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
  if (type.toUpperCase() === "SWAP") return "Swap";
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
