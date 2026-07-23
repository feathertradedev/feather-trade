import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useAccount } from "wagmi";

import { createDexPublicClient } from "@robinhood-lb/sdk/client";
import type { DexRegistry } from "@robinhood-lb/sdk/registry";

import {
  CANDLE_LOOKBACK_SECONDS,
  candleBoundary,
  candleStreamUrl,
  applyPoolStateUpdate,
  isCandleStreamStale,
  isPoolStreamStale,
  loadAnalyticsHealth,
  loadCanonicalPoolActivity,
  loadPairCandles,
  loadPoolMetrics,
  loadPoolState,
  parseCandleStreamPayload,
  parsePoolStreamPayload,
  poolStreamUrl,
  type AnalyticsPage,
  type AnalyticsValue,
  type CandleInterval,
  type LivePoolSnapshot,
  type PairCandle,
  type PoolAnalyticsMetric
} from "./analytics-data";
import { analyticsEndpointForRegistry, registries, type EnvironmentKey } from "./config";
import {
  loadPoolBinWindow,
  loadPoolIndexerSnapshot,
  loadWalletPortfolio,
  selectWalletPortfolioPosition,
  type ActivityRow,
  type BinRow,
  type LoadState,
  type PortfolioPositionRow,
  type PoolIndexerSnapshot,
  type PoolRow,
  type PositionHistoryRow,
  type PositionRow
} from "./data";
import {
  joinPoolWorkspaceRows,
  shouldShowWorkspaceAnalyticsState,
  workspaceAnalyticsState,
  type PoolWorkspaceRow,
  type WorkspaceAnalyticsState
} from "./pool-workspace";
import {
  canonicalActivityRows,
  canonicalPositionHistoryRows,
  portfolioPositionRows
} from "./pool-workspace-activity";
import {
  loadPinnedPoolEconomics,
  type PinnedPoolEconomics,
  type PoolEconomicsAnchor
} from "./pool-economics";

const WORKSPACE_REFRESH_INTERVAL_MS = 10_000;
export type CandleStreamState = "connecting" | "live" | "stale" | "unavailable";
export type PoolStreamState = "connecting" | "live" | "stale" | "snapshot-only" | "unavailable";

export interface PoolWorkspaceContextValue {
  activity: {
    error: string | null;
    rows: ActivityRow[];
    setWalletOnly: Dispatch<SetStateAction<boolean>>;
    state: LoadState;
    walletOnly: boolean;
    windowed: boolean;
  };
  analytics: {
    candles: AnalyticsPage<PairCandle>;
    candleInterval: CandleInterval;
    candleStreamState: CandleStreamState;
    candlesLoading: boolean;
    setCandleInterval: Dispatch<SetStateAction<CandleInterval>>;
    metricPage: AnalyticsPage<PoolAnalyticsMetric>;
    row: PoolWorkspaceRow;
    state: WorkspaceAnalyticsState;
    stateVisible: boolean;
  };
  economics: {
    error: string | null;
    state: LoadState;
    value: PinnedPoolEconomics | null;
  };
  indexerSnapshot: {
    error: string | null;
    state: LoadState;
    value: PoolIndexerSnapshot | null;
  };
  liveMarket: {
    bins: BinRow[];
    error: string | null;
    state: PoolStreamState;
    value: LivePoolSnapshot | null;
  };
  bins: BinRow[];
  binsError: string | null;
  binsState: LoadState;
  environmentKey: EnvironmentKey;
  pool: PoolRow;
  portfolio: {
    error: string | null;
    headPinned: boolean;
    partial: boolean;
    position: PortfolioPositionRow | null;
    state: LoadState;
  };
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
  const publicClient = useMemo(
    () => createDexPublicClient(registry.chain, registry.endpoints.rpcUrl),
    [registry]
  );
  const queryClient = useQueryClient();
  const account = useAccount();
  const walletAddress = account.address ?? null;
  const [poolActivityWalletOnly, setPoolActivityWalletOnly] = useState(true);
  const [candleInterval, setCandleInterval] = useState<CandleInterval>("HOUR");
  const [candleStreamState, setCandleStreamState] = useState<CandleStreamState>("connecting");
  const [candleStreamGeneration, setCandleStreamGeneration] = useState(0);
  const [poolStreamState, setPoolStreamState] = useState<PoolStreamState>("connecting");
  const [poolStreamGeneration, setPoolStreamGeneration] = useState(0);
  const candleWindow = useMemo(() => {
    const end = candleBoundary(Math.floor(Date.now() / 1_000), candleInterval);
    return { end, start: end - CANDLE_LOOKBACK_SECONDS[candleInterval] };
  }, [candleInterval, candleStreamGeneration, pool.address]);
  const candleEnd = candleWindow.end;
  const candleStart = candleWindow.start;
  const candleQueryKey = useMemo(
    () => ["canonicalPoolCandles", environmentKey, analyticsEndpoint, pool.address, candleInterval, candleStart, candleEnd, candleStreamGeneration] as const,
    [analyticsEndpoint, candleEnd, candleInterval, candleStart, candleStreamGeneration, environmentKey, pool.address]
  );
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    setPoolActivityWalletOnly(true);
  }, [pool.address, walletAddress]);

  const metricsQuery = useQuery({
    queryKey: ["canonicalPoolMetrics", environmentKey, analyticsEndpoint, pool.address],
    queryFn: () => loadPoolMetrics(analyticsEndpoint, [pool.address]),
    refetchInterval: WORKSPACE_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const candlesQuery = useQuery({
    queryKey: candleQueryKey,
    queryFn: () => loadPairCandles(analyticsEndpoint, pool.address, candleInterval, candleStart, candleEnd),
    placeholderData: (previous) => previous,
    refetchInterval: false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const livePoolQueryKey = useMemo(
    () => ["canonicalLivePoolState", environmentKey, analyticsEndpoint, pool.address, poolStreamGeneration] as const,
    [analyticsEndpoint, environmentKey, pool.address, poolStreamGeneration]
  );
  const livePoolQuery = useQuery({
    queryKey: livePoolQueryKey,
    queryFn: () => loadPoolState(analyticsEndpoint, pool.address, 40),
    // Recover from an unavailable bootstrap without ever polling over a
    // completed history-to-live handoff. Once a snapshot supplies its cursor,
    // only the stream or an explicit reset may advance this cache.
    refetchInterval: (query) => query.state.data?.value == null
      ? WORKSPACE_REFRESH_INTERVAL_MS
      : false,
    // This bootstrap is the immutable history-to-live handoff. Reusing its
    // cache is safe because the SSE cursor catches up or explicitly resets;
    // an unrelated focus/reconnect refetch could otherwise overwrite newer
    // sparse replacements that already arrived on the stream.
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false
  });

  useEffect(() => {
    if (candlesQuery.isPlaceholderData) {
      setCandleStreamState("connecting");
      return;
    }
    const cursor = candlesQuery.data?.streamCursor;
    if (analyticsEndpoint === null || cursor === null || cursor === undefined || typeof EventSource === "undefined") {
      setCandleStreamState("unavailable");
      return;
    }

    let lastActivityAt = Date.now();
    setCandleStreamState("connecting");
    const source = new EventSource(candleStreamUrl(analyticsEndpoint, pool.address, candleInterval, cursor));
    const noteActivity = () => {
      lastActivityAt = Date.now();
      setCandleStreamState("live");
    };
    const onCandle = (event: MessageEvent<string>) => {
      try {
        const update = parseCandleStreamPayload(JSON.parse(event.data), pool.address, candleInterval);
        queryClient.setQueryData<AnalyticsPage<PairCandle>>(candleQueryKey, (current) => {
          if (current === undefined) return current;
          const byTimestamp = new Map(current.rows.map((candle) => [candle.startTimestamp, candle]));
          const previous = byTimestamp.get(update.candle.startTimestamp);
          if (previous === undefined || update.candle.revision >= previous.revision) {
            byTimestamp.set(update.candle.startTimestamp, update.candle);
          }
          return {
            ...current,
            rows: [...byTimestamp.values()]
              .sort((left, right) => left.startTimestamp - right.startTimestamp)
              .slice(-500)
          };
        });
        noteActivity();
      } catch {
        setCandleStreamState("stale");
      }
    };
    const onReset = () => {
      setCandleStreamState("connecting");
      source.close();
      setCandleStreamGeneration((generation) => generation + 1);
    };
    source.addEventListener("candle", onCandle as EventListener);
    source.addEventListener("heartbeat", noteActivity);
    source.addEventListener("reset", onReset);
    source.onopen = noteActivity;
    source.onerror = () => {
      setCandleStreamState(isCandleStreamStale(lastActivityAt, Date.now()) ? "stale" : "connecting");
    };
    const staleTimer = window.setInterval(() => {
      if (isCandleStreamStale(lastActivityAt, Date.now())) setCandleStreamState("stale");
    }, 5_000);

    return () => {
      window.clearInterval(staleTimer);
      source.close();
    };
  }, [analyticsEndpoint, candleInterval, candleQueryKey, candleStreamGeneration, candlesQuery.data?.streamCursor, candlesQuery.isPlaceholderData, pool.address, queryClient]);

  useEffect(() => {
    const snapshot = livePoolQuery.data?.value;
    if (snapshot === null || snapshot === undefined) {
      setPoolStreamState(livePoolQuery.isPending ? "connecting" : "unavailable");
      return;
    }
    if (analyticsEndpoint === null || typeof EventSource === "undefined") {
      setPoolStreamState("snapshot-only");
      return;
    }

    let lastActivityAt = Date.now();
    let resetRequested = false;
    setPoolStreamState("connecting");
    const source = new EventSource(poolStreamUrl(analyticsEndpoint, pool.address, snapshot.streamCursor));
    const noteActivity = () => {
      lastActivityAt = Date.now();
      setPoolStreamState("live");
    };
    const reset = () => {
      if (resetRequested) return;
      resetRequested = true;
      setPoolStreamState("connecting");
      source.close();
      setPoolStreamGeneration((generation) => generation + 1);
    };
    const onPoolState = (event: MessageEvent<string>) => {
      try {
        const update = parsePoolStreamPayload(JSON.parse(event.data), pool.address);
        let applied = false;
        queryClient.setQueryData<AnalyticsValue<LivePoolSnapshot>>(livePoolQueryKey, (current) => {
          if (current?.value === null || current?.value === undefined) return current;
          const next = applyPoolStateUpdate(current.value, update);
          applied = next !== current.value;
          return next === current.value ? current : { ...current, value: next, status: next.state.status, error: null };
        });
        if (applied) noteActivity();
      } catch {
        reset();
      }
    };
    source.addEventListener("pool-state", onPoolState as EventListener);
    source.addEventListener("heartbeat", noteActivity);
    source.addEventListener("reset", reset);
    source.onopen = noteActivity;
    source.onerror = () => {
      if (!resetRequested) {
        setPoolStreamState(isPoolStreamStale(lastActivityAt, Date.now()) ? "stale" : "connecting");
      }
    };
    const staleTimer = window.setInterval(() => {
      if (!resetRequested && isPoolStreamStale(lastActivityAt, Date.now())) setPoolStreamState("stale");
    }, 5_000);

    return () => {
      window.clearInterval(staleTimer);
      source.close();
    };
  }, [analyticsEndpoint, livePoolQuery.data?.value !== null && livePoolQuery.data?.value !== undefined, livePoolQuery.isPending, livePoolQueryKey, pool.address, poolStreamGeneration, queryClient]);
  const healthQuery = useQuery({
    queryKey: ["canonicalPoolAnalyticsHealth", environmentKey, analyticsEndpoint],
    queryFn: () => loadAnalyticsHealth(analyticsEndpoint),
    refetchInterval: WORKSPACE_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const indexerSnapshotQuery = useQuery({
    queryKey: [
      "canonicalPoolIndexerSnapshot",
      environmentKey,
      pool.address,
      pool.factoryAddress,
      pool.tokenXAddress,
      pool.tokenYAddress,
      pool.binStep,
      registry.endpoints.indexerUrl
    ],
    queryFn: () => loadPoolIndexerSnapshot(registry, pool),
    enabled: registry.endpoints.indexerUrl !== null,
    refetchInterval: registry.endpoints.indexerUrl !== null ? WORKSPACE_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const indexerSnapshot = indexerSnapshotQuery.isError ? undefined : indexerSnapshotQuery.data;
  const livePoolBootstrap = livePoolQuery.data?.value ?? null;
  const analyticsHealth = healthQuery.data?.value ?? null;
  const analyticsEconomicsAnchor: PoolEconomicsAnchor | null =
    livePoolBootstrap !== null &&
    analyticsHealth?.headBlock !== null &&
    analyticsHealth?.headBlock !== undefined &&
    analyticsHealth.headHash !== null
      ? {
          activeId: BigInt(livePoolBootstrap.state.activeId),
          binStep: BigInt(livePoolBootstrap.state.binStep),
          blockHash: analyticsHealth.headHash as `0x${string}`,
          blockNumber: BigInt(analyticsHealth.headBlock),
          factory: pool.factoryAddress,
          tokenX: livePoolBootstrap.state.tokenX,
          tokenY: livePoolBootstrap.state.tokenY
        }
      : null;
  const economicsQuery = useQuery({
    queryKey: [
      "canonicalPoolEconomics",
      environmentKey,
      pool.address,
      pool.factoryAddress,
      pool.tokenXAddress,
      pool.tokenYAddress,
      pool.binStep,
      analyticsEconomicsAnchor?.blockNumber.toString() ?? null,
      analyticsEconomicsAnchor?.blockHash ?? null,
      analyticsEconomicsAnchor?.activeId.toString() ?? null
    ],
    queryFn: () => {
      if (analyticsEconomicsAnchor === null) throw new Error("Canonical analytics market anchor is unavailable");
      return loadPinnedPoolEconomics(publicClient, registry, pool, analyticsEconomicsAnchor);
    },
    enabled: analyticsEconomicsAnchor !== null,
    refetchInterval: analyticsEconomicsAnchor !== null ? WORKSPACE_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const economicsValue = analyticsEconomicsAnchor !== null && !economicsQuery.isError && economicsQuery.data !== undefined &&
    economicsMatchesAnalyticsAnchor(economicsQuery.data, analyticsEconomicsAnchor)
    ? economicsQuery.data
    : undefined;
  const currentActiveId = economicsValue?.activeId.toString() ?? null;
  const economicsBlockNumber = economicsValue?.blockNumber.toString() ?? null;
  const economicsBlockHash = economicsValue?.blockHash ?? null;
  const binsQuery = useQuery({
    queryKey: [
      "canonicalPoolBins",
      environmentKey,
      pool.address,
      currentActiveId,
      economicsBlockNumber,
      economicsBlockHash,
      registry.endpoints.indexerUrl
    ],
    queryFn: () => {
      const economics = economicsValue;
      if (economics === undefined) throw new Error("Pinned pool economics are unavailable");
      return loadPoolBinWindow(registry, pool.address, {
        activeId: economics.activeId,
        binStep: economics.binStep,
        blockHash: economics.blockHash,
        blockNumber: economics.blockNumber,
        factory: economics.factory,
        tokenX: economics.tokenX,
        tokenY: economics.tokenY
      });
    },
    enabled: currentActiveId !== null && registry.endpoints.indexerUrl !== null,
    refetchInterval: currentActiveId !== null && registry.endpoints.indexerUrl !== null ? WORKSPACE_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const historyQuery = useQuery({
    queryKey: ["canonicalPoolHistory", environmentKey, analyticsEndpoint, walletAddress, pool.address],
    queryFn: () => {
      if (walletAddress === null || analyticsEndpoint === null) {
        throw new Error("Wallet pool history is unavailable");
      }
      return loadCanonicalPoolActivity(analyticsEndpoint, pool.address, walletAddress);
    },
    enabled: walletAddress !== null && analyticsEndpoint !== null,
    refetchInterval: walletAddress !== null && analyticsEndpoint !== null ? WORKSPACE_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const portfolioQuery = useQuery({
    queryKey: ["canonicalPoolPortfolio", environmentKey, analyticsEndpoint, walletAddress, pool.address],
    queryFn: async () => {
      if (walletAddress === null || analyticsEndpoint === null) {
        throw new Error("Wallet pool accounting is unavailable");
      }
      const page = await loadWalletPortfolio(analyticsEndpoint, walletAddress);
      return {
        page,
        position: selectWalletPortfolioPosition(page, walletAddress, pool.address)
      };
    },
    enabled: walletAddress !== null && analyticsEndpoint !== null,
    refetchInterval: walletAddress !== null && analyticsEndpoint !== null ? WORKSPACE_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const activityOwner = poolActivityWalletOnly ? walletAddress : null;
  const activityQuery = useQuery({
    queryKey: [
      "canonicalPoolActivity",
      environmentKey,
      analyticsEndpoint,
      pool.address,
      activityOwner
    ],
    queryFn: () => loadCanonicalPoolActivity(analyticsEndpoint, pool.address, activityOwner, { maxPages: 1 }),
    enabled: analyticsEndpoint !== null,
    refetchInterval: analyticsEndpoint !== null ? WORKSPACE_REFRESH_INTERVAL_MS : false,
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
  const analyticsStateVisible = !metricsQuery.isPending && shouldShowWorkspaceAnalyticsState(
    row.analyticsStatus,
    healthQuery.data?.value ?? null
  );
  const candles: AnalyticsPage<PairCandle> = candlesQuery.data ?? emptyAnalyticsPage(
    candlesQuery.isError ? "UNAVAILABLE" : "PARTIAL",
    errorMessage(candlesQuery.error)
  );
  const rawLivePoolSnapshot = livePoolQuery.data?.value ?? null;
  const livePoolAttestationError = attestLivePoolSnapshot(rawLivePoolSnapshot, registry, pool, economicsValue ?? null);
  const livePoolSnapshot = livePoolAttestationError === null ? rawLivePoolSnapshot : null;
  const livePoolBins: BinRow[] = livePoolSnapshot?.bins.map((bin) => ({
    id: `${bin.pair}-${bin.binId}`,
    binId: bin.binId,
    reserveX: bin.reserveX,
    reserveY: bin.reserveY,
    totalSupply: bin.totalSupply,
    updatedAtBlock: bin.updatedAtBlock
  })) ?? [];
  const portfolioPosition = portfolioQuery.data?.position ?? null;
  const portfolioPage = portfolioQuery.data?.page;
  const portfolioHeadPinned = portfolioPosition !== null &&
    portfolioPage?.health.status === "READY" &&
    portfolioPage.health.fresh &&
    portfolioPage.health.headBlock !== null &&
    portfolioPage.health.headHash !== null &&
    portfolioPosition.asOfBlock !== null &&
    portfolioPosition.asOfBlock === portfolioPage.health.headBlock &&
    economicsValue !== undefined &&
    portfolioPosition.asOfBlock === economicsValue.blockNumber.toString() &&
    portfolioPage.health.headHash.toLowerCase() === economicsValue.blockHash.toLowerCase();
  const portfolioPartial = Boolean(
    portfolioPage?.pageInfo.partial ||
    portfolioPage?.pageInfo.hasNextPage ||
    (portfolioPage !== undefined && (portfolioPage.health.status !== "READY" || !portfolioPage.health.fresh)) ||
    (portfolioPosition !== null && (portfolioPosition.status !== "READY" || !portfolioHeadPinned))
  );
  const positions = portfolioPositionRows(portfolioPosition, walletAddress, pool.address);
  const positionsPartial = portfolioPartial;
  const history = canonicalPositionHistoryRows(historyQuery.data?.rows ?? [], walletAddress);
  const historyPartial = Boolean(
    historyQuery.data?.status === "PARTIAL" || historyQuery.data?.pageInfo.hasNextPage
  );
  const activity = canonicalActivityRows(activityQuery.data?.rows ?? []);
  const activityPartial = Boolean(
    activityQuery.data?.status === "PARTIAL" || activityQuery.data?.pageInfo.hasNextPage
  );
  const economicsPending = livePoolQuery.isLoading || healthQuery.isLoading || economicsQuery.isLoading ||
    livePoolQuery.isFetching || healthQuery.isFetching || economicsQuery.isFetching;
  const binsState: LoadState = livePoolAttestationError !== null
    ? economicsPending ? "loading" : "error"
    : livePoolSnapshot !== null
      ? "ready"
      : livePoolQuery.isLoading
        ? "loading"
        : livePoolQuery.isError
          ? "error"
          : "unavailable";
  const positionsState: LoadState = walletAddress === null
    ? "unavailable"
    : analyticsEndpoint === null
      ? "unavailable"
      : portfolioQuery.isError
        ? "error"
        : positionsPartial
          ? "partial"
          : portfolioQuery.isLoading
            ? "loading"
            : positions.length > 0
              ? "ready"
              : "empty";
  const historyState: LoadState = walletAddress === null
    ? "unavailable"
    : analyticsEndpoint === null
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
  const portfolioState: LoadState = walletAddress === null || analyticsEndpoint === null
    ? "unavailable"
    : portfolioQuery.isError
      ? "error"
      : portfolioQuery.isLoading
        ? "loading"
        : portfolioPartial
          ? "partial"
          : portfolioPosition === null
            ? "empty"
            : "ready";
  const activityState: LoadState = analyticsEndpoint === null
    ? "unavailable"
    : activityQuery.isError
      ? "error"
      : activityPartial
        ? "partial"
        : activityQuery.isLoading
          ? "loading"
          : activity.length > 0
            ? "ready"
            : "empty";
  const economicsState: LoadState = livePoolQuery.isError || healthQuery.isError || economicsQuery.isError
    ? "error"
    : economicsValue !== undefined
      ? "ready"
      : economicsPending
      ? "loading"
      : "unavailable";
  const indexerSnapshotState: LoadState = indexerSnapshotQuery.isError
    ? "error"
    : indexerSnapshot !== undefined
      ? "ready"
      : indexerSnapshotQuery.isLoading || indexerSnapshotQuery.isFetching
        ? "loading"
        : "unavailable";
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
    activity: {
      error: errorMessage(activityQuery.error) ?? activityQuery.data?.error ?? null,
      rows: activity,
      setWalletOnly: setPoolActivityWalletOnly,
      state: activityState,
      walletOnly: walletAddress !== null && poolActivityWalletOnly,
      windowed: activityQuery.data?.pageInfo.hasNextPage === true
    },
    analytics: {
      candles,
      candleInterval,
      candleStreamState,
      candlesLoading: candlesQuery.isLoading || candlesQuery.isPlaceholderData,
      metricPage,
      row,
      setCandleInterval,
      state: analyticsState,
      stateVisible: analyticsStateVisible
    },
    bins: livePoolSnapshot !== null ? livePoolBins : binsQuery.data ?? [],
    binsError: livePoolAttestationError ?? errorMessage(livePoolQuery.error) ?? errorMessage(binsQuery.error),
    binsState,
    draftValues,
    economics: {
      error: errorMessage(livePoolQuery.error) ?? errorMessage(healthQuery.error) ?? errorMessage(economicsQuery.error),
      state: economicsState,
      value: economicsValue ?? null
    },
    environmentKey,
    history,
    historyError: errorMessage(historyQuery.error) ?? historyQuery.data?.error ?? null,
    historyPartial,
    historyState,
    indexerSnapshot: {
      error: errorMessage(indexerSnapshotQuery.error),
      state: indexerSnapshotState,
      value: indexerSnapshot ?? null
    },
    liveMarket: {
      bins: livePoolBins,
      error: livePoolAttestationError ?? livePoolQuery.data?.error ?? errorMessage(livePoolQuery.error),
      state: livePoolAttestationError === null ? poolStreamState : "unavailable",
      value: livePoolSnapshot
    },
    pool,
    portfolio: {
      error: errorMessage(portfolioQuery.error),
      headPinned: portfolioHeadPinned,
      partial: portfolioPartial,
      position: portfolioPosition,
      state: portfolioState
    },
    positions,
    positionsError: errorMessage(portfolioQuery.error),
    positionsPartial,
    positionsState,
    registry,
    setDraftValue,
    walletAddress
  }), [
    activity,
    activityQuery.data?.error,
    activityQuery.data?.pageInfo.hasNextPage,
    activityQuery.error,
    activityState,
    analyticsState,
    analyticsStateVisible,
    binsQuery.data,
    binsQuery.error,
    binsState,
    candles,
    candleInterval,
    candleStreamState,
    candlesQuery.isLoading,
    candlesQuery.isPlaceholderData,
    draftValues,
    economicsValue,
    economicsQuery.error,
    economicsState,
    environmentKey,
    history,
    historyPartial,
    historyQuery.data?.error,
    historyQuery.error,
    historyState,
    healthQuery.error,
    indexerSnapshotQuery.error,
    indexerSnapshot,
    indexerSnapshotState,
    livePoolBins,
    livePoolAttestationError,
    livePoolQuery.data?.error,
    livePoolQuery.error,
    livePoolSnapshot,
    metricPage,
    pool,
    poolActivityWalletOnly,
    poolStreamState,
    portfolioHeadPinned,
    portfolioPartial,
    portfolioPosition,
    portfolioQuery.error,
    portfolioState,
    positions,
    positionsPartial,
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

function economicsMatchesAnalyticsAnchor(economics: PinnedPoolEconomics, anchor: PoolEconomicsAnchor): boolean {
  return economics.blockNumber === anchor.blockNumber &&
    economics.blockHash.toLowerCase() === anchor.blockHash.toLowerCase() &&
    economics.activeId === anchor.activeId &&
    economics.binStep === anchor.binStep &&
    economics.factory.toLowerCase() === anchor.factory.toLowerCase() &&
    economics.tokenX.toLowerCase() === anchor.tokenX.toLowerCase() &&
    economics.tokenY.toLowerCase() === anchor.tokenY.toLowerCase();
}

function attestLivePoolSnapshot(
  snapshot: LivePoolSnapshot | null,
  registry: DexRegistry,
  pool: PoolRow,
  economics: PinnedPoolEconomics | null
): string | null {
  if (snapshot === null) return null;
  if (economics === null) return "Live pool state is waiting for pinned RPC market attestation";
  const state = snapshot.state;
  if (state.chainId !== registry.chainId) return "Live pool state chain differs from the selected environment";
  if (state.pair.toLowerCase() !== pool.address.toLowerCase()) return "Live pool state pair differs from the selected market";
  if (
    state.tokenX.toLowerCase() !== pool.tokenXAddress.toLowerCase() ||
    state.tokenY.toLowerCase() !== pool.tokenYAddress.toLowerCase() ||
    state.tokenX.toLowerCase() !== economics.tokenX.toLowerCase() ||
    state.tokenY.toLowerCase() !== economics.tokenY.toLowerCase()
  ) return "Live pool token identity differs from pinned RPC state";
  if (pool.tokenX === null || pool.tokenY === null || state.decimalsX !== pool.tokenX.decimals || state.decimalsY !== pool.tokenY.decimals) {
    return "Live pool token decimals differ from allowlisted metadata";
  }
  if (BigInt(state.binStep) !== BigInt(pool.binStep) || BigInt(state.binStep) !== economics.binStep) {
    return "Live pool bin step differs from pinned RPC state";
  }
  const liveBlock = BigInt(state.asOfBlock);
  if (liveBlock > economics.blockNumber) return "Live pool state is newer than the canonical RPC anchor";
  if (liveBlock === economics.blockNumber && state.asOfBlockHash.toLowerCase() !== economics.blockHash.toLowerCase()) {
    return "Live pool state canonical hash differs from pinned RPC state";
  }
  return null;
}

function emptyAnalyticsPage<T>(status: "PARTIAL" | "UNAVAILABLE", error: string | null): AnalyticsPage<T> {
  return {
    rows: [],
    status,
    error,
    pageInfo: { endCursor: null, hasNextPage: false, partial: true, pagesLoaded: 0 },
    streamCursor: null
  };
}


function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}
