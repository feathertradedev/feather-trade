import type { ReactNode } from "react";

import { formatCompactAddress, formatTokenAmount, tokenSymbol, type PoolRow } from "./data";
import { returnHrefFromAction } from "./pool-discovery";
import { workspaceMetricTiles } from "./pool-workspace";
import { PoolWorkspaceProvider, usePoolWorkspace } from "./pool-workspace-context";
import { poolWorkspaceHref, type PoolWorkspaceTask } from "./pool-workspace-route";
import type { EnvironmentKey } from "./config";

const TASKS: ReadonlyArray<{ key: PoolWorkspaceTask; label: string }> = [
  { key: "market", label: "Market" },
  { key: "swap", label: "Swap" },
  { key: "create", label: "Create position" },
  { key: "manage", label: "Manage" }
];

export function PoolWorkspaceShell({
  children,
  environmentKey,
  pool,
  task
}: {
  children: ReactNode;
  environmentKey: EnvironmentKey;
  pool: PoolRow;
  task: PoolWorkspaceTask;
}) {
  return (
    <PoolWorkspaceProvider environmentKey={environmentKey} pool={pool}>
      <PoolWorkspaceScaffold pool={pool} task={task}>{children}</PoolWorkspaceScaffold>
    </PoolWorkspaceProvider>
  );
}

function PoolWorkspaceScaffold({ children, pool, task }: { children: ReactNode; pool: PoolRow; task: PoolWorkspaceTask }) {
  const returnHref = returnHrefFromAction(window.location.hash);

  return (
    <section className="canonical-pool-workspace" data-pool-id={pool.id} data-testid="canonical-pool-workspace">
      {returnHref === null ? null : <a className="back-link action-return-link" data-testid="pool-action-back" href={returnHref}>← Back to pool workspace</a>}
      <header className="pool-workspace-header">
        <div className="pool-workspace-identity">
          <span>Pool workspace</span>
          <strong>{tokenSymbol(pool.tokenX)} / {tokenSymbol(pool.tokenY)}</strong>
          <small>{formatCompactAddress(pool.address)} · {pool.binStep} bps/bin</small>
        </div>
        <nav aria-label="Pool tasks" className="pool-workspace-tasks">
          {TASKS.map((item) => (
            <a
              aria-current={task === item.key ? "page" : undefined}
              className={task === item.key ? "active" : undefined}
              href={taskHref(pool.id, item.key, returnHref)}
              key={item.key}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <div className="pool-workspace-body">
        <PoolWorkspaceRail />
        <div className="pool-workspace-task-content">{children}</div>
      </div>
    </section>
  );
}

function PoolWorkspaceRail() {
  const workspace = usePoolWorkspace();
  const metricTiles = workspaceMetricTiles(workspace.analytics.row.metric);
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
      <div className="pool-rail-section pool-rail-market">
        <span className="pool-rail-label">Market</span>
        <strong>{tokenSymbol(workspace.pool.tokenX)} / {tokenSymbol(workspace.pool.tokenY)}</strong>
        <small>{formatCompactAddress(workspace.pool.address)}</small>
      </div>
      <dl className="pool-rail-facts">
        <div><dt>Bin step</dt><dd>{workspace.pool.binStep} bps</dd></div>
        <div><dt>Current bin</dt><dd>{workspace.pool.activeId ?? "Unavailable"}</dd></div>
        <div><dt>{tokenSymbol(workspace.pool.tokenX)} reserve</dt><dd>{formatTokenAmount(workspace.pool.reserveX, workspace.pool.tokenX)}</dd></div>
        <div><dt>{tokenSymbol(workspace.pool.tokenY)} reserve</dt><dd>{formatTokenAmount(workspace.pool.reserveY, workspace.pool.tokenY)}</dd></div>
      </dl>
      <div className="pool-rail-metrics" aria-label="Pool market metrics">
        {metricTiles.slice(0, 4).map((tile) => (
          <div data-analytics-status={tile.status} key={tile.key}>
            <span>{tile.label}</span>
            <strong>{tile.value}</strong>
          </div>
        ))}
      </div>
      <div className={`pool-rail-state ${workspace.analytics.state.status.toLowerCase()}`} data-testid="pool-workspace-state" role="status">
        <span>{workspace.analytics.state.label}</span>
        {workspace.analytics.state.detail ? <small>{workspace.analytics.state.detail}</small> : null}
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

function taskHref(poolId: string, task: PoolWorkspaceTask, returnHref: string | null): string {
  const href = poolWorkspaceHref(poolId, task);
  return returnHref === null ? href : `${href}?${new URLSearchParams({ returnTo: returnHref }).toString()}`;
}
