import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useAccount } from "wagmi";

import type { DexRegistry } from "@robinhood-lb/sdk/registry";

import {
  loadAnalyticsHealth,
  loadPairCandles,
  loadPoolMetrics,
  type AnalyticsPage,
  type PairCandle,
  type PoolAnalyticsMetric
} from "./analytics-data";
import { analyticsEndpointForRegistry, registries, type EnvironmentKey } from "./config";
import {
  loadPaginatedPositionsForOwnerPair,
  loadPositionHistory,
  loadPoolBinWindow,
  type BinRow,
  type LoadState,
  type PoolRow,
  type PositionHistoryRow,
  type PositionRow
} from "./data";
import {
  joinPoolWorkspaceRows,
  workspaceAnalyticsState,
  type PoolWorkspaceRow,
  type WorkspaceAnalyticsState
} from "./pool-workspace";

const WORKSPACE_REFRESH_INTERVAL_MS = 10_000;

export interface PoolWorkspaceContextValue {
  analytics: {
    candles: AnalyticsPage<PairCandle>;
    candlesLoading: boolean;
    metricPage: AnalyticsPage<PoolAnalyticsMetric>;
    row: PoolWorkspaceRow;
    state: WorkspaceAnalyticsState;
  };
  bins: BinRow[];
  binsError: string | null;
  binsState: LoadState;
  environmentKey: EnvironmentKey;
  pool: PoolRow;
  positions: PositionRow[];
  positionsError: string | null;
  positionsPartial: boolean;
  positionsState: LoadState;
  history: PositionHistoryRow[];
  historyError: string | null;
  historyPartial: boolean;
  historyState: LoadState;
  registry: DexRegistry;
  walletAddress: string | null;
  draftValues: Readonly<Record<string, unknown>>;
  setDraftValue: <T>(key: string, next: SetStateAction<T>, fallback: T) => void;
}

const PoolWorkspaceContext = createContext<PoolWorkspaceContextValue | null>(null);

export function PoolWorkspaceProvider({
  children,
  environmentKey,
  pool
}: {
  children: ReactNode;
  environmentKey: EnvironmentKey;
  pool: PoolRow;
}) {
  const registry = registries[environmentKey];
  const analyticsEndpoint = analyticsEndpointForRegistry(registry);
  const account = useAccount();
  const walletAddress = account.address ?? null;
  const currentHourBoundary = Math.floor(Date.now() / 3_600_000) * 3_600;
  const candleEnd = currentHourBoundary - 3_600;
  const candleStart = candleEnd - 7 * 24 * 3_600;
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({});

  const metricsQuery = useQuery({
    queryKey: ["canonicalPoolMetrics", environmentKey, analyticsEndpoint, pool.address],
    queryFn: () => loadPoolMetrics(analyticsEndpoint, [pool.address]),
    refetchInterval: WORKSPACE_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const candlesQuery = useQuery({
    queryKey: ["canonicalPoolCandles", environmentKey, analyticsEndpoint, pool.address, candleStart, candleEnd],
    queryFn: () => loadPairCandles(analyticsEndpoint, pool.address, "HOUR", candleStart, candleEnd),
    refetchInterval: WORKSPACE_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const healthQuery = useQuery({
    queryKey: ["canonicalPoolAnalyticsHealth", environmentKey, analyticsEndpoint],
    queryFn: () => loadAnalyticsHealth(analyticsEndpoint),
    refetchInterval: WORKSPACE_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const binsQuery = useQuery({
    queryKey: ["canonicalPoolBins", environmentKey, pool.address, pool.activeId, registry.endpoints.indexerUrl],
    queryFn: () => {
      if (pool.activeId === null) throw new Error("Pool active bin is unavailable");
      return loadPoolBinWindow(registry, pool.address, Number(pool.activeId));
    },
    enabled: pool.activeId !== null && registry.endpoints.indexerUrl !== null,
    refetchInterval: pool.activeId !== null && registry.endpoints.indexerUrl !== null ? WORKSPACE_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const positionsQuery = useQuery({
    queryKey: ["canonicalPoolPositions", environmentKey, walletAddress, pool.address, registry.endpoints.indexerUrl],
    queryFn: () => {
      if (walletAddress === null) throw new Error("Wallet pool positions are unavailable");
      return loadPaginatedPositionsForOwnerPair(registry, walletAddress, pool.address);
    },
    enabled: walletAddress !== null && registry.endpoints.indexerUrl !== null,
    refetchInterval: walletAddress !== null && registry.endpoints.indexerUrl !== null ? WORKSPACE_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const historyQuery = useQuery({
    queryKey: ["canonicalPoolHistory", environmentKey, walletAddress, pool.address, registry.endpoints.indexerUrl],
    queryFn: () => {
      if (walletAddress === null) throw new Error("Wallet pool history is unavailable");
      return loadPositionHistory(registry, walletAddress, pool.address);
    },
    enabled: walletAddress !== null && registry.endpoints.indexerUrl !== null,
    refetchInterval: walletAddress !== null && registry.endpoints.indexerUrl !== null ? WORKSPACE_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });

  const metricPage: AnalyticsPage<PoolAnalyticsMetric> = metricsQuery.data ?? emptyAnalyticsPage(
    metricsQuery.isError ? "UNAVAILABLE" : "PARTIAL",
    errorMessage(metricsQuery.error)
  );
  const row = joinPoolWorkspaceRows([pool], metricPage)[0]!;
  const analyticsState = metricsQuery.isPending || healthQuery.isPending
    ? { status: "PARTIAL" as const, label: "Loading application analytics", detail: "Pool metrics and freshness are being resolved." }
    : workspaceAnalyticsState(row.analyticsStatus, healthQuery.data?.value ?? null);
  const candles: AnalyticsPage<PairCandle> = candlesQuery.data ?? emptyAnalyticsPage(
    candlesQuery.isError ? "UNAVAILABLE" : "PARTIAL",
    errorMessage(candlesQuery.error)
  );
  const positions = positionsQuery.data?.rows ?? [];
  const positionsPartial = Boolean(positionsQuery.data?.pageInfo.capped || positionsQuery.data?.pageInfo.failed);
  const history = historyQuery.data?.rows ?? [];
  const historyPartial = Boolean(historyQuery.data?.pageInfo.capped || historyQuery.data?.pageInfo.failed);
  const binsState: LoadState = registry.endpoints.indexerUrl === null || pool.activeId === null
    ? "unavailable"
    : binsQuery.isError
      ? "error"
      : binsQuery.isLoading
        ? "loading"
        : binsQuery.data
          ? "ready"
          : "empty";
  const positionsState: LoadState = walletAddress === null
    ? "unavailable"
    : registry.endpoints.indexerUrl === null
      ? "unavailable"
      : positionsQuery.isError
        ? "error"
        : positionsPartial
          ? "partial"
          : positionsQuery.isLoading
            ? "loading"
            : positions.length > 0
              ? "ready"
              : "empty";
  const historyState: LoadState = walletAddress === null
    ? "unavailable"
    : registry.endpoints.indexerUrl === null
      ? "unavailable"
      : historyQuery.isError
        ? "error"
        : historyPartial
          ? "partial"
          : historyQuery.isLoading
            ? "loading"
            : history.length > 0
              ? "ready"
              : "empty";
  const setDraftValue = useCallback(<T,>(key: string, next: SetStateAction<T>, fallback: T) => {
    setDraftValues((current) => {
      const previous = Object.prototype.hasOwnProperty.call(current, key) ? current[key] as T : fallback;
      const value = typeof next === "function" ? (next as (current: T) => T)(previous) : next;
      return Object.is(previous, value) && Object.prototype.hasOwnProperty.call(current, key)
        ? current
        : { ...current, [key]: value };
    });
  }, []);

  const value = useMemo<PoolWorkspaceContextValue>(() => ({
    analytics: {
      candles,
      candlesLoading: candlesQuery.isLoading,
      metricPage,
      row,
      state: analyticsState
    },
    bins: binsQuery.data ?? [],
    binsError: errorMessage(binsQuery.error),
    binsState,
    draftValues,
    environmentKey,
    history,
    historyError: errorMessage(historyQuery.error),
    historyPartial,
    historyState,
    pool,
    positions,
    positionsError: errorMessage(positionsQuery.error),
    positionsPartial,
    positionsState,
    registry,
    setDraftValue,
    walletAddress
  }), [
    analyticsState,
    binsQuery.data,
    binsQuery.error,
    binsState,
    candles,
    candlesQuery.isLoading,
    draftValues,
    environmentKey,
    history,
    historyPartial,
    historyQuery.error,
    historyState,
    metricPage,
    pool,
    positions,
    positionsPartial,
    positionsQuery.error,
    positionsState,
    registry,
    row,
    setDraftValue,
    walletAddress
  ]);

  return <PoolWorkspaceContext.Provider value={value}>{children}</PoolWorkspaceContext.Provider>;
}

export function usePoolWorkspace(): PoolWorkspaceContextValue {
  const value = useContext(PoolWorkspaceContext);
  if (value === null) throw new Error("Pool workspace context is unavailable");
  return value;
}

export function useOptionalPoolWorkspace(): PoolWorkspaceContextValue | null {
  return useContext(PoolWorkspaceContext);
}

export function usePoolDraftState<T>(key: string, initialValue: T): [T, Dispatch<SetStateAction<T>>] {
  const workspace = useOptionalPoolWorkspace();
  const [localValue, setLocalValue] = useState(initialValue);
  const workspaceValue = workspace && Object.prototype.hasOwnProperty.call(workspace.draftValues, key)
    ? workspace.draftValues[key] as T
    : localValue;
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    if (workspace === null) {
      setLocalValue(next);
      return;
    }
    workspace.setDraftValue(key, next, localValue);
  }, [key, localValue, workspace]);
  return [workspace === null ? localValue : workspaceValue, setValue];
}

function emptyAnalyticsPage<T>(status: "PARTIAL" | "UNAVAILABLE", error: string | null): AnalyticsPage<T> {
  return {
    rows: [],
    status,
    error,
    pageInfo: { endCursor: null, hasNextPage: false, partial: true, pagesLoaded: 0 }
  };
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}
