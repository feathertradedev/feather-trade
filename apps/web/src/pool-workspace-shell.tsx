import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import {
  formatExactPriceFraction,
  normalizeQ128Price,
  priceQ128FromActiveId
} from "../../../packages/sdk/src/liquidity-price";

import { formatCompactAddress, formatTokenAmount, tokenSymbol, type PoolRow } from "./data";
import { returnHrefFromAction, samePairPools } from "./pool-discovery";
import { buildCenteredBinDistribution, formatRatioPercentE18, workspaceMetricTiles } from "./pool-workspace";
import { PoolWorkspaceProvider, usePoolWorkspace } from "./pool-workspace-context";
import { parsePoolWorkspaceRoute, poolWorkspaceHref, type PoolWorkspaceTask } from "./pool-workspace-route";
import type { EnvironmentKey } from "./config";
import { useMediaQuery } from "./use-media-query";

const ACTION_TASKS: ReadonlyArray<{ key: Exclude<PoolWorkspaceTask, "market">; label: string }> = [
  { key: "swap", label: "Swap" },
  { key: "create", label: "Create position" },
  { key: "manage", label: "Manage" }
];

type MobileWorkspaceView = "market" | "trade" | "positions";

const MOBILE_WORKSPACE_VIEWS: ReadonlyArray<{ key: MobileWorkspaceView; label: string }> = [
  { key: "market", label: "Market" },
  { key: "trade", label: "Trade" },
  { key: "positions", label: "Positions" }
];

export function PoolWorkspaceShell({
  children,
  environmentKey,
  pool,
  pools
}: {
  children: ReactNode;
  environmentKey: EnvironmentKey;
  pool: PoolRow;
  pools: PoolRow[];
}) {
  return (
    <PoolWorkspaceProvider environmentKey={environmentKey} pool={pool}>
      <PoolWorkspaceScaffold pool={pool} pools={pools}>{children}</PoolWorkspaceScaffold>
    </PoolWorkspaceProvider>
  );
}

function PoolWorkspaceScaffold({ children, pool, pools }: { children: ReactNode; pool: PoolRow; pools: PoolRow[] }) {
  const returnHref = returnHrefFromAction(window.location.hash);
  const routeTask = parsePoolWorkspaceRoute(window.location.hash)?.task ?? "create";
  const tradePanelId = routeTask === "swap" ? "swap-task-panel" : routeTask === "manage" ? "liquidity-withdraw" : "liquidity-add";
  const mobileWorkspaceNavigation = useMediaQuery("(max-width: 720px)");
  const [mobileView, setMobileView] = useState<MobileWorkspaceView>(() =>
    routeTask === "market" ? "market" : "trade"
  );

  useEffect(() => {
    const handleTaskNavigation = () => {
      const task = parsePoolWorkspaceRoute(window.location.hash)?.task;
      if (task === "swap" || task === "create" || task === "manage") setMobileView("trade");
    };
    window.addEventListener("hashchange", handleTaskNavigation);
    return () => window.removeEventListener("hashchange", handleTaskNavigation);
  }, []);

  return (
    <section
      className="canonical-pool-workspace"
      data-mobile-view={mobileView}
      data-pool-id={pool.id}
      data-testid="canonical-pool-workspace"
    >
      {returnHref === null ? null : <a className="back-link action-return-link" data-testid="pool-action-back" href={returnHref}>← Back to pools</a>}
      <header className="pool-workspace-header">
        <div className="pool-workspace-identity">
          <span>Pool workspace</span>
          <strong>{tokenSymbol(pool.tokenX)} / {tokenSymbol(pool.tokenY)}</strong>
          <small>{formatCompactAddress(pool.address)} · {pool.binStep} bps/bin</small>
        </div>
        <PoolBinStepSelector pool={pool} pools={pools} />
      </header>
      {mobileWorkspaceNavigation ? <PoolMobileWorkspaceNav activeView={mobileView} onChange={setMobileView} tradePanelId={tradePanelId} /> : null}
      <div className="pool-workspace-body">
        <PoolWorkspaceRail mobileWorkspaceNavigation={mobileWorkspaceNavigation} />
        <div className="pool-workspace-task-content">{children}</div>
      </div>
    </section>
  );
}

function PoolMobileWorkspaceNav({
  activeView,
  onChange,
  tradePanelId
}: {
  activeView: MobileWorkspaceView;
  onChange: (view: MobileWorkspaceView) => void;
  tradePanelId: string;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const focusedIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (focusedIndex < 0) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? MOBILE_WORKSPACE_VIEWS.length - 1
        : (focusedIndex + (event.key === "ArrowRight" ? 1 : -1) + MOBILE_WORKSPACE_VIEWS.length) % MOBILE_WORKSPACE_VIEWS.length;
    const nextView = MOBILE_WORKSPACE_VIEWS[nextIndex]!;
    onChange(nextView.key);
    document.getElementById(`pool-mobile-${nextView.key}-tab`)?.focus();
  };

  return (
    <nav
      aria-label="Pool workspace views"
      className="pool-mobile-workspace-nav"
      onKeyDown={handleKeyDown}
      role="tablist"
    >
      {MOBILE_WORKSPACE_VIEWS.map((view) => (
        <button
          aria-controls={view.key === "trade"
            ? tradePanelId
            : view.key === "market"
              ? "pool-mobile-market-panel pool-mobile-market-metadata"
              : "pool-mobile-positions-panel"}
          aria-selected={activeView === view.key}
          id={`pool-mobile-${view.key}-tab`}
          key={view.key}
          onClick={() => onChange(view.key)}
          role="tab"
          tabIndex={activeView === view.key ? 0 : -1}
          type="button"
        >
          {view.label}
        </button>
      ))}
    </nav>
  );
}

export function PoolWorkspaceTaskTabs({ task }: { task: PoolWorkspaceTask }) {
  const workspace = usePoolWorkspace();
  const returnHref = returnHrefFromAction(window.location.hash);

  return (
    <nav aria-label="Pool tasks" className="pool-workspace-tasks">
      {ACTION_TASKS.map((item) => (
        <a
          aria-current={task === item.key ? "page" : undefined}
          className={task === item.key ? "active" : undefined}
          href={taskHref(workspace.pool.id, item.key, returnHref)}
          key={item.key}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

function PoolBinStepSelector({ pool, pools }: { pool: PoolRow; pools: PoolRow[] }) {
  const alternatives = samePairPools(pools, pool);
  const choices = [pool, ...alternatives].sort((left, right) => {
    const binStepOrder = BigInt(left.binStep) < BigInt(right.binStep) ? -1 : BigInt(left.binStep) > BigInt(right.binStep) ? 1 : 0;
    return binStepOrder !== 0 ? binStepOrder : left.address.toLowerCase().localeCompare(right.address.toLowerCase());
  });
  if (choices.length <= 1) return null;
  const routeTask = parsePoolWorkspaceRoute(window.location.hash)?.task ?? "create";
  const returnHref = returnHrefFromAction(window.location.hash);

  return (
    <label className="pool-workspace-tier-selector">
      <span>Bin step</span>
      <select
        aria-label="Pool bin step"
        data-testid="pool-bin-step-selector"
        onChange={(event) => { window.location.hash = taskHref(event.target.value, routeTask, returnHref); }}
        value={pool.id}
      >
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.binStep} bps/bin · {formatCompactAddress(choice.address)}
          </option>
        ))}
      </select>
    </label>
  );
}

function PoolWorkspaceRail({ mobileWorkspaceNavigation }: { mobileWorkspaceNavigation: boolean }) {
  const workspace = usePoolWorkspace();
  const metricTiles = workspaceMetricTiles(workspace.analytics.row.metric).map((tile) => workspace.economics.value === null
    ? workspace.economics.state === "loading"
      ? { ...tile, status: "PARTIAL" as const, value: "Loading…" }
      : { ...tile, status: "UNAVAILABLE" as const, value: "Unavailable" }
    : tile);
  const tvl = metricTiles.find((tile) => tile.key === "tvl")!;
  const volume = metricTiles.find((tile) => tile.key === "volume24h")!;
  const fees = metricTiles.find((tile) => tile.key === "lpFees24h")!;
  const feeToTvl = metricTiles.find((tile) => tile.key === "feeToTvl")!;
  const [inversePrice, setInversePrice] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(() => !window.matchMedia("(max-width: 1040px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1040px)");
    const handleChange = (event: MediaQueryListEvent) => setDetailsOpen(!event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);
  const currentActiveId = workspace.economics.value?.activeId.toString() ?? null;
  const currentPrice = workspace.economics.state === "loading"
    ? "Loading…"
    : formatCurrentPoolPrice(workspace.pool, inversePrice, currentActiveId);
  const baseSymbol = tokenSymbol(inversePrice ? workspace.pool.tokenY : workspace.pool.tokenX);
  const quoteSymbol = tokenSymbol(inversePrice ? workspace.pool.tokenX : workspace.pool.tokenY);
  const positionsLabel = workspace.walletAddress === null
    ? "Connect wallet"
    : workspace.positionsState === "ready" || workspace.positionsState === "empty"
      ? `${workspace.positions.length} bins`
      : workspace.positionsState === "partial"
        ? `${workspace.positions.length} bins · partial`
        : workspace.positionsState;
  const activityLabel = workspace.activity.state === "ready" || workspace.activity.state === "empty"
    ? `${workspace.activity.rows.length} events${workspace.activity.windowed ? " · recent" : ""}`
    : workspace.activity.state;

  return (
    <aside
      aria-label="Pool market details"
      aria-labelledby={mobileWorkspaceNavigation ? "pool-mobile-market-tab" : undefined}
      className="pool-workspace-rail"
      data-testid="pool-workspace-rail"
      id="pool-mobile-market-metadata"
    >
      <button
        aria-controls="pool-workspace-rail-details"
        aria-expanded={detailsOpen}
        className="pool-workspace-rail-toggle"
        onClick={() => setDetailsOpen((current) => !current)}
        type="button"
      >
        <span>
          <strong>Pool market</strong>
          <small>{currentPrice} {quoteSymbol} per {baseSymbol} · TVL {tvl.value}</small>
        </span>
        <span aria-hidden="true">{detailsOpen ? "Hide details" : "Show details"}</span>
      </button>
      <div className="pool-workspace-rail-content" hidden={!detailsOpen} id="pool-workspace-rail-details">
      <section className="pool-rail-section pool-rail-overview">
        <div className="pool-rail-pair-row">
          <div>
            <span className="pool-rail-label">Pool market</span>
            <strong>{tokenSymbol(workspace.pool.tokenX)} / {tokenSymbol(workspace.pool.tokenY)}</strong>
          </div>
          <span className="pool-rail-bin-step">{workspace.pool.binStep} bps/bin</span>
        </div>
        <div className="pool-rail-price-block">
          <div className="pool-rail-price-label">
            <span>Current pool price</span>
            <button
              aria-label={`Show price as ${baseSymbol} per ${quoteSymbol}`}
              className="pool-rail-price-flip"
              onClick={() => setInversePrice((current) => !current)}
              type="button"
            >
              ⇄
            </button>
          </div>
          <strong>{currentPrice}</strong>
          <small>{quoteSymbol} per {baseSymbol} · {economicsSourceLabel(workspace)}</small>
        </div>
        <div className="pool-rail-tvl-row" data-analytics-status={tvl.status}>
          <span>
            TVL
            {workspace.registry.environment === "localnet" ? <em>local fixture</em> : null}
          </span>
          <strong>{tvl.value}</strong>
        </div>
        <small className="pool-rail-data-source">Analytics TVL · {metricSourceLabel(workspace.analytics.row.metric)}</small>
        <small className="pool-rail-address">{formatCompactAddress(workspace.pool.address)}</small>
      </section>

      <section className="pool-rail-reserves">
        <dl aria-label="Pool token reserves">
          <div>
            <dt><i className="pool-token-dot token-x" />{tokenSymbol(workspace.pool.tokenX)}</dt>
            <dd>{formatSnapshotReserve(workspace.indexerSnapshot.value?.reserveX, workspace.pool.tokenX, workspace.economics.value !== null, workspace.indexerSnapshot.state === "loading" || workspace.economics.state === "loading")}</dd>
          </div>
          <div>
            <dt><i className="pool-token-dot token-y" />{tokenSymbol(workspace.pool.tokenY)}</dt>
            <dd>{formatSnapshotReserve(workspace.indexerSnapshot.value?.reserveY, workspace.pool.tokenY, workspace.economics.value !== null, workspace.indexerSnapshot.state === "loading" || workspace.economics.state === "loading")}</dd>
          </div>
        </dl>
        <small className="pool-rail-data-source">{indexedReserveSourceLabel(workspace)}</small>
      </section>

      <PoolRailLiquidityDistribution />

      <section className="pool-rail-stats">
        <dl aria-label="Pool analytics">
          <div data-analytics-status={volume.status}><dt>24h volume</dt><dd>{volume.value}</dd></div>
          <div data-analytics-status={fees.status}><dt>24h LP fees</dt><dd>{fees.value}</dd></div>
          <div data-analytics-status={feeToTvl.status}><dt>24h LP fees / TVL</dt><dd>{feeToTvl.value}</dd></div>
        </dl>
        <small className="pool-rail-data-source">Analytics · {metricSourceLabel(workspace.analytics.row.metric)}</small>
      </section>

      <PoolRailFeeEconomics />

      {workspace.analytics.stateVisible ? (
        <div className={`pool-rail-state ${workspace.analytics.state.status.toLowerCase()}`} data-testid="pool-workspace-state" role="status">
          <span>{workspace.analytics.state.label}</span>
          {workspace.analytics.state.detail ? <small>{workspace.analytics.state.detail}</small> : null}
          {workspace.analytics.row.analyticsIssue ? <small>{workspace.analytics.row.analyticsIssue}</small> : null}
        </div>
      ) : null}

      <div className="pool-rail-position-state">
        <span>Your liquidity</span>
        <strong>{positionsLabel}</strong>
        <span>Pool activity</span>
        <strong>{activityLabel}</strong>
      </div>
      </div>
    </aside>
  );
}

function PoolRailFeeEconomics() {
  const workspace = usePoolWorkspace();
  const economics = workspace.economics.value;
  return (
    <section className="pool-rail-fees" data-testid="pool-fee-economics">
      <div className="pool-rail-fees-heading">
        <span className="pool-rail-label">Current active-bin fees</span>
        <small>{economicsSourceLabel(workspace)}</small>
      </div>
      {economics === null ? (
        <p>{workspace.economics.state === "loading" ? "Reading pinned fee state…" : workspace.economics.error ?? "Pinned fee state is unavailable."}</p>
      ) : (
        <dl>
          <div><dt>Base fee</dt><dd>{formatRatioPercentE18(economics.feeRates.baseFeeRate.toString())}</dd></div>
          <div><dt>Variable fee</dt><dd>{formatRatioPercentE18(economics.feeRates.variableFeeRate.toString())}</dd></div>
          <div className="total"><dt>Current active-bin total</dt><dd>{formatRatioPercentE18(economics.feeRates.totalFeeRate.toString())}</dd></div>
          <div><dt>Protocol share of fee</dt><dd>{formatFeeSharePercent(economics.feeRates.protocolShare)}</dd></div>
          <div><dt>Protocol fee rate</dt><dd>{formatRatioPercentE18(economics.feeRates.protocolFeeRate.toString())}</dd></div>
          <div><dt>LP net share of fee</dt><dd>{formatFeeSharePercent(10_000n - economics.feeRates.protocolShare)}</dd></div>
          <div><dt>LP net fee rate</dt><dd>{formatRatioPercentE18(economics.feeRates.lpNetFeeRate.toString())}</dd></div>
        </dl>
      )}
    </section>
  );
}

const DISTRIBUTION_RADII = [8, 16, 24, 40] as const;

function PoolRailLiquidityDistribution() {
  const workspace = usePoolWorkspace();
  const [radiusIndex, setRadiusIndex] = useState(1);
  const radius = DISTRIBUTION_RADII[radiusIndex]!;
  const tokenX = tokenSymbol(workspace.pool.tokenX);
  const tokenY = tokenSymbol(workspace.pool.tokenY);
  const currentActiveId = workspace.economics.value?.activeId.toString() ?? null;
  const distribution = useMemo(() => {
    if (currentActiveId === null) {
      return {
        error: workspace.economics.state === "loading"
          ? "Verifying pinned RPC market identity."
          : distributionIdentityError(workspace.economics.error),
        points: null
      };
    }
    if (workspace.pool.tokenX === null || workspace.pool.tokenY === null) {
      return { error: "Pool token decimals are unavailable.", points: null };
    }
    try {
      return {
        error: null,
        points: buildCenteredBinDistribution(
          workspace.bins,
          currentActiveId,
          workspace.pool.tokenX.decimals,
          workspace.pool.tokenY.decimals,
          radius
        )
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Liquidity distribution is unavailable.", points: null };
    }
  }, [currentActiveId, radius, workspace.bins, workspace.economics.error, workspace.economics.state, workspace.pool.tokenX, workspace.pool.tokenY]);
  const rangePercent = formatBinRangePercent(workspace.pool.binStep, radius);

  return (
    <section className="pool-rail-liquidity" data-testid="pool-rail-liquidity-distribution">
      <div className="pool-rail-liquidity-heading">
        <div>
          <span className="pool-rail-label">Liquidity distribution</span>
          <small>{distribution.points?.length ?? 0} bins around price</small>
        </div>
        <div className="pool-rail-zoom" role="group" aria-label="Liquidity distribution zoom">
          <button
            aria-label="Zoom into liquidity distribution"
            disabled={radiusIndex === 0}
            onClick={() => setRadiusIndex((current) => Math.max(0, current - 1))}
            type="button"
          >−</button>
          <button
            aria-label="Zoom out of liquidity distribution"
            disabled={radiusIndex === DISTRIBUTION_RADII.length - 1}
            onClick={() => setRadiusIndex((current) => Math.min(DISTRIBUTION_RADII.length - 1, current + 1))}
            type="button"
          >+</button>
        </div>
      </div>
      <div className="pool-rail-liquidity-legend" aria-hidden="true">
        <span><i className="pool-token-dot token-x" />{tokenX}</span>
        <span><i className="pool-token-dot token-y" />{tokenY}</span>
      </div>
      {workspace.binsState === "loading" ? (
        <div className="pool-rail-liquidity-skeleton" aria-label="Loading liquidity distribution">
          {Array.from({ length: 17 }, (_, index) => <i key={index} />)}
        </div>
      ) : distribution.points === null || workspace.binsState !== "ready" ? (
        <p className="pool-rail-liquidity-empty">{distribution.error ?? workspace.binsError ?? `Liquidity data is ${workspace.binsState}.`}</p>
      ) : (
        <>
          <div
            aria-label={`${tokenX} and ${tokenY} reserves across ${distribution.points.length} bins; active bin centered`}
            className="pool-rail-liquidity-bars"
            role="group"
          >
            {distribution.points.map((point) => (
              <span
                aria-hidden={point.active ? undefined : true}
                aria-label={point.active ? `${tokenX} ${point.tokenX}; ${tokenY} ${point.tokenY}; active bin` : undefined}
                className={point.active ? "active" : undefined}
                data-bin-id={point.binId}
                key={point.id}
                role={point.active ? "img" : undefined}
                tabIndex={point.active ? 0 : undefined}
              >
                <i className="token-x" style={{ height: `${reserveBarHeight(point.tokenX, point.tokenXHeight)}%` }} />
                <i className="token-y" style={{ height: `${reserveBarHeight(point.tokenY, point.tokenYHeight)}%` }} />
              </span>
            ))}
          </div>
          <div className="pool-rail-liquidity-axis" aria-hidden="true">
            <span>−{rangePercent}</span>
            <strong>Current</strong>
            <span>+{rangePercent}</span>
          </div>
        </>
      )}
    </section>
  );
}

function formatCurrentPoolPrice(pool: PoolRow, inverse: boolean, activeId = pool.activeId): string {
  if (activeId === null || pool.tokenX === null || pool.tokenY === null) return "Unavailable";
  try {
    const rawPrice = priceQ128FromActiveId(BigInt(activeId), BigInt(pool.binStep));
    const normalized = normalizeQ128Price(rawPrice, {
      baseDecimals: pool.tokenX.decimals,
      inverse,
      quoteDecimals: pool.tokenY.decimals
    });
    return formatExactPriceFraction(normalized, 8);
  } catch {
    return "Unavailable";
  }
}

function economicsSourceLabel(workspace: ReturnType<typeof usePoolWorkspace>): string {
  const economics = workspace.economics.value;
  if (economics !== null) {
    return `RPC block ${economics.blockNumber} · indexed snapshot · ${freshnessLabel(Number(economics.blockTimestamp))}`;
  }
  return workspace.economics.state === "loading"
    ? "RPC fee state loading"
    : "Pinned RPC state unavailable";
}

function indexedReserveSourceLabel(workspace: ReturnType<typeof usePoolWorkspace>): string {
  const snapshot = workspace.indexerSnapshot.value;
  if (snapshot === null) {
    return workspace.indexerSnapshot.state === "loading" ? "Indexed reserves · snapshot loading" : "Indexed reserves unavailable";
  }
  return `Indexed reserves · snapshot block ${snapshot.blockNumber} · last pool update block ${snapshot.updatedAtBlock}`;
}

function formatSnapshotReserve(value: string | undefined, token: PoolRow["tokenX"], decimalsVerified: boolean, loading: boolean): string {
  if (loading) return "Loading…";
  return value === undefined || token === null || !decimalsVerified ? "Unavailable" : formatTokenAmount(value, token);
}

function metricSourceLabel(metric: ReturnType<typeof usePoolWorkspace>["analytics"]["row"]["metric"]): string {
  if (metric === null) return "source unavailable";
  return `block ${metric.asOfBlock} · ${freshnessLabel(metric.asOfTimestamp)}`;
}

function freshnessLabel(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return "freshness unavailable";
  const age = Math.floor(Date.now() / 1_000) - timestamp;
  if (age < -5) return "future timestamp";
  if (age <= 5) return "just now";
  if (age < 60) return `${age}s ago`;
  if (age < 3_600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86_400) return `${Math.floor(age / 3_600)}h ago`;
  return `${Math.floor(age / 86_400)}d ago`;
}

function formatFeeSharePercent(basisPoints: bigint): string {
  return formatRatioPercentE18((basisPoints * 10n ** 14n).toString());
}

function distributionIdentityError(error: string | null): string {
  if (error === null) return "Pinned RPC market identity is unavailable.";
  return /allowlist|token [XY] decimals/i.test(error)
    ? "Pool bin identity or token decimals are unavailable."
    : error;
}

function formatBinRangePercent(binStep: string, radius: number): string {
  const step = Number(binStep);
  if (!Number.isFinite(step) || step <= 0) return "—";
  const percent = (Math.pow(1 + step / 10_000, radius) - 1) * 100;
  return percent < 0.1 ? `${percent.toFixed(2)}%` : `${percent.toFixed(1)}%`;
}

function reserveBarHeight(value: string, normalizedHeight: number): number {
  return value === "0" ? 0 : Math.max(4, normalizedHeight);
}

function taskHref(poolId: string, task: PoolWorkspaceTask, returnHref: string | null): string {
  const href = poolWorkspaceHref(poolId, task);
  return returnHref === null ? href : `${href}?${new URLSearchParams({ returnTo: returnHref }).toString()}`;
}
