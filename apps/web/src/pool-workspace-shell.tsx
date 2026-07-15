import { useMemo, useState, type ReactNode } from "react";

import {
  formatExactPriceFraction,
  normalizeQ128Price,
  priceQ128FromActiveId
} from "../../../packages/sdk/src/liquidity-price";

import { formatCompactAddress, formatTokenAmount, tokenSymbol, type PoolRow } from "./data";
import { returnHrefFromAction } from "./pool-discovery";
import { buildCenteredBinDistribution, workspaceMetricTiles } from "./pool-workspace";
import { PoolWorkspaceProvider, usePoolWorkspace } from "./pool-workspace-context";
import { poolWorkspaceHref, type PoolWorkspaceTask } from "./pool-workspace-route";
import type { EnvironmentKey } from "./config";

const ACTION_TASKS: ReadonlyArray<{ key: Exclude<PoolWorkspaceTask, "market">; label: string }> = [
  { key: "swap", label: "Swap" },
  { key: "create", label: "Create position" },
  { key: "manage", label: "Manage" }
];

export function PoolWorkspaceShell({
  children,
  environmentKey,
  pool
}: {
  children: ReactNode;
  environmentKey: EnvironmentKey;
  pool: PoolRow;
}) {
  return (
    <PoolWorkspaceProvider environmentKey={environmentKey} pool={pool}>
      <PoolWorkspaceScaffold pool={pool}>{children}</PoolWorkspaceScaffold>
    </PoolWorkspaceProvider>
  );
}

function PoolWorkspaceScaffold({ children, pool }: { children: ReactNode; pool: PoolRow }) {
  const returnHref = returnHrefFromAction(window.location.hash);

  return (
    <section className="canonical-pool-workspace" data-pool-id={pool.id} data-testid="canonical-pool-workspace">
      {returnHref === null ? null : <a className="back-link action-return-link" data-testid="pool-action-back" href={returnHref}>← Back to pools</a>}
      <header className="pool-workspace-header">
        <div className="pool-workspace-identity">
          <span>Pool workspace</span>
          <strong>{tokenSymbol(pool.tokenX)} / {tokenSymbol(pool.tokenY)}</strong>
          <small>{formatCompactAddress(pool.address)} · {pool.binStep} bps/bin</small>
        </div>
      </header>
      <div className="pool-workspace-body">
        <PoolWorkspaceRail />
        <div className="pool-workspace-task-content">{children}</div>
      </div>
    </section>
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

function PoolWorkspaceRail() {
  const workspace = usePoolWorkspace();
  const metricTiles = workspaceMetricTiles(workspace.analytics.row.metric);
  const tvl = metricTiles.find((tile) => tile.key === "tvl")!;
  const volume = metricTiles.find((tile) => tile.key === "volume24h")!;
  const fees = metricTiles.find((tile) => tile.key === "lpFees24h")!;
  const feeToTvl = metricTiles.find((tile) => tile.key === "feeToTvl")!;
  const [inversePrice, setInversePrice] = useState(false);
  const currentPrice = formatCurrentPoolPrice(workspace.pool, inversePrice);
  const baseSymbol = tokenSymbol(inversePrice ? workspace.pool.tokenY : workspace.pool.tokenX);
  const quoteSymbol = tokenSymbol(inversePrice ? workspace.pool.tokenX : workspace.pool.tokenY);
  const positionsLabel = workspace.walletAddress === null
    ? "Connect wallet"
    : workspace.positionsState === "ready" || workspace.positionsState === "empty"
      ? `${workspace.positions.length} bins`
      : workspace.positionsState === "partial"
        ? `${workspace.positions.length} bins · partial`
        : workspace.positionsState;
  const historyLabel = workspace.walletAddress === null
    ? "Connect wallet"
    : workspace.historyState === "ready" || workspace.historyState === "empty"
      ? `${workspace.history.length} events`
      : workspace.historyState === "partial"
        ? `${workspace.history.length} events · partial`
        : workspace.historyState;

  return (
    <aside className="pool-workspace-rail" data-testid="pool-workspace-rail">
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
          <small>{quoteSymbol} per {baseSymbol} · bin {workspace.pool.activeId ?? "unavailable"}</small>
        </div>
        <div className="pool-rail-tvl-row" data-analytics-status={tvl.status}>
          <span>
            TVL
            {workspace.registry.environment === "localnet" ? <em>local fixture</em> : null}
          </span>
          <strong>{tvl.value}</strong>
        </div>
        <small className="pool-rail-address">{formatCompactAddress(workspace.pool.address)}</small>
      </section>

      <dl className="pool-rail-reserves" aria-label="Pool token reserves">
        <div>
          <dt><i className="pool-token-dot token-x" />{tokenSymbol(workspace.pool.tokenX)}</dt>
          <dd>{formatTokenAmount(workspace.pool.reserveX, workspace.pool.tokenX)}</dd>
        </div>
        <div>
          <dt><i className="pool-token-dot token-y" />{tokenSymbol(workspace.pool.tokenY)}</dt>
          <dd>{formatTokenAmount(workspace.pool.reserveY, workspace.pool.tokenY)}</dd>
        </div>
      </dl>

      <PoolRailLiquidityDistribution />

      <dl className="pool-rail-stats">
        <div data-analytics-status={volume.status}><dt>24h volume</dt><dd>{volume.value}</dd></div>
        <div data-analytics-status={fees.status}><dt>24h LP fees</dt><dd>{fees.value}</dd></div>
        <div data-analytics-status={feeToTvl.status}><dt>24h Fees / TVL</dt><dd>{feeToTvl.value}</dd></div>
        <div><dt>Current bin</dt><dd>{workspace.pool.activeId ?? "Unavailable"}</dd></div>
      </dl>

      <div className={`pool-rail-state ${workspace.analytics.state.status.toLowerCase()}`} data-testid="pool-workspace-state" role="status">
        <span>{workspace.analytics.state.label}</span>
        {workspace.analytics.state.detail ? <small>{workspace.analytics.state.detail}</small> : null}
        {workspace.analytics.row.analyticsIssue ? <small>{workspace.analytics.row.analyticsIssue}</small> : null}
      </div>

      <div className="pool-rail-position-state">
        <span>Your liquidity</span>
        <strong>{positionsLabel}</strong>
        <span>Recent activity</span>
        <strong>{historyLabel}</strong>
      </div>
    </aside>
  );
}

const DISTRIBUTION_RADII = [8, 16, 24, 40] as const;

function PoolRailLiquidityDistribution() {
  const workspace = usePoolWorkspace();
  const [radiusIndex, setRadiusIndex] = useState(1);
  const radius = DISTRIBUTION_RADII[radiusIndex]!;
  const tokenX = tokenSymbol(workspace.pool.tokenX);
  const tokenY = tokenSymbol(workspace.pool.tokenY);
  const distribution = useMemo(() => {
    if (workspace.pool.activeId === null || workspace.pool.tokenX === null || workspace.pool.tokenY === null) {
      return { error: "Pool bin identity or token decimals are unavailable.", points: null };
    }
    try {
      return {
        error: null,
        points: buildCenteredBinDistribution(
          workspace.bins,
          workspace.pool.activeId,
          workspace.pool.tokenX.decimals,
          workspace.pool.tokenY.decimals,
          radius
        )
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Liquidity distribution is unavailable.", points: null };
    }
  }, [radius, workspace.bins, workspace.pool.activeId, workspace.pool.tokenX, workspace.pool.tokenY]);
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
            role="img"
          >
            {distribution.points.map((point) => (
              <span
                aria-label={`Bin ${point.binId}; ${tokenX} ${point.tokenX}; ${tokenY} ${point.tokenY}${point.active ? "; active bin" : ""}`}
                className={point.active ? "active" : undefined}
                data-bin-id={point.binId}
                key={point.id}
                role="img"
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

function formatCurrentPoolPrice(pool: PoolRow, inverse: boolean): string {
  if (pool.activeId === null || pool.tokenX === null || pool.tokenY === null) return "Unavailable";
  try {
    const rawPrice = priceQ128FromActiveId(BigInt(pool.activeId), BigInt(pool.binStep));
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
