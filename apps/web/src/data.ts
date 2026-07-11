import { lbPairAbi } from "@robinhood-lb/sdk/abi";
import type { DexRegistry } from "@robinhood-lb/sdk/registry";
import type { TokenMetadata } from "@robinhood-lb/sdk/tokens";
import { createPublicClient, formatUnits, http, isAddressEqual, type Address } from "viem";

import { isLocalnetRegistry } from "./config";

export type LoadState = "loading" | "ready" | "partial" | "stale" | "empty" | "unavailable" | "error";
export const GRAPHQL_PAGE_SIZE = 100;
export const GRAPHQL_MAX_PAGES = 5;
export const GRAPHQL_ACTIVITY_RENDER_LIMIT = 100;
export const INDEXER_STALE_BLOCK_THRESHOLD = 20n;
export const ROBINHOOD_TESTNET_INDEXER_STALE_BLOCK_THRESHOLD = 300n;
export const GRAPHQL_REQUEST_TIMEOUT_MS = 10_000;

export interface AppDataLoadOptions {
  graphqlTimeoutMs?: number;
}

export interface PaginationInfo {
  capped: boolean;
  error?: string;
  failed: boolean;
  loadedCount: number;
  maxPages: number;
  pageSize: number;
}

export interface RuntimeState {
  chainId: number | null;
  blockNumber: string | null;
  seededActiveId: number | null;
  status: LoadState;
  message: string | null;
}

export interface PoolRow {
  id: string;
  address: Address;
  tokenXAddress: Address;
  tokenYAddress: Address;
  tokenX: TokenMetadata | null;
  tokenY: TokenMetadata | null;
  activeId: string | null;
  binStep: string;
  reserveX: string;
  reserveY: string;
  volumeX: string;
  volumeY: string;
  feesX: string;
  feesY: string;
  swapCount: string;
  depositCount: string;
  updatedAtBlock: string;
}

export interface BinRow {
  id: string;
  binId: string;
  reserveX: string;
  reserveY: string;
  totalSupply: string;
  updatedAtBlock: string;
}

export interface ActivityRow {
  id: string;
  type: string;
  transactionHash: string;
  blockNumber: string;
  timestamp: string;
  amountX: string | null;
  amountY: string | null;
  account: string | null;
  pair: string | null;
}

export interface PositionRow {
  id: string;
  owner: string;
  binId: string;
  liquidity: string;
  updatedAtBlock: string;
  pair: string;
}

export interface PortfolioBinRow {
  binId: string;
  liquidity: string;
  amountX: string | null;
  amountY: string | null;
  costBasisUsdE18: string | null;
  currentValueUsdE18: string | null;
  realizedPnlUsdE18: string | null;
  unrealizedPnlUsdE18: string | null;
  asOfBlock: string | null;
  asOfTimestamp: number | null;
  status: "READY" | "PARTIAL" | "UNAVAILABLE";
  missingPriceTokens: string[];
}

export interface PortfolioPositionRow {
  owner: string;
  pair: string;
  bins: PortfolioBinRow[];
  costBasisUsdE18: string | null;
  currentValueUsdE18: string | null;
  realizedPnlUsdE18: string | null;
  unrealizedPnlUsdE18: string | null;
  status: "READY" | "PARTIAL" | "UNAVAILABLE";
  missingPriceTokens: string[];
  asOfBlock: string | null;
  asOfTimestamp: number | null;
}

export interface WalletPortfolioPage {
  positions: PortfolioPositionRow[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean; partial: boolean };
  health: {
    fresh: boolean;
    headBlock: string | null;
    status: "READY" | "PARTIAL" | "UNAVAILABLE";
  };
}

interface WalletPortfolioGraph {
  walletPositions: {
    nodes: PortfolioPositionRow[];
    pageInfo: { endCursor: string | null; hasNextPage: boolean; partial: boolean };
  };
  analyticsHealth: WalletPortfolioPage["health"];
}

export interface PositionHistoryRow {
  id: string;
  type: string;
  transactionHash: string;
  blockNumber: string;
  timestamp: string;
  amountX: string | null;
  amountY: string | null;
  binIds: string[];
  sender: string;
  to: string;
}

interface PositionHistoryGraph {
  liquidityEvents: Array<Omit<PositionHistoryRow, "binIds"> & { ids: string[] }>;
  transferBatchEvents: Array<{
    id: string;
    transactionHash: string;
    blockNumber: string;
    timestamp: string;
    sender: string;
    from: string;
    to: string;
    ids: string[];
  }>;
}

export interface IndexerState {
  status: LoadState;
  message: string | null;
  blockNumber: string | null;
  blockHash: string | null;
  hasIndexingErrors: boolean;
  pairCount: string | null;
  pools: PoolRow[];
  activity: ActivityRow[];
  positions: PositionRow[];
  pagination: {
    pools: PaginationInfo;
    swaps: PaginationInfo;
    liquidityEvents: PaginationInfo;
    positions: PaginationInfo;
  };
}

export interface AppSnapshot {
  runtime: RuntimeState;
  indexer: IndexerState;
}

interface GraphResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface DashboardGraph {
  _meta?: {
    block: {
      number: number;
      hash: string | null;
    };
    hasIndexingErrors: boolean;
  };
  factory: {
    pairCount: string;
  } | null;
  pairs: Array<{
    id: string;
    address: string;
    tokenX: { address: string };
    tokenY: { address: string };
    activeId: string | null;
    binStep: string;
    reserveX: string;
    reserveY: string;
    totalVolumeX: string;
    totalVolumeY: string;
    totalFeesX: string;
    totalFeesY: string;
    swapCount: string;
    depositCount: string;
    updatedAtBlock: string;
  }>;
  swaps: Array<{
    id: string;
    transactionHash: string;
    blockNumber: string;
    timestamp: string;
    amountInX: string;
    amountInY: string;
    amountOutX: string;
    amountOutY: string;
    pair: { id: string };
    sender: string;
  }>;
  liquidityEvents: Array<{
    id: string;
    type: string;
    transactionHash: string;
    blockNumber: string;
    timestamp: string;
    amountX: string;
    amountY: string;
    pair: { id: string };
    sender: string;
  }>;
  positions: Array<{
    id: string;
    owner: string;
    liquidity: string;
    updatedAtBlock: string;
    pair: { id: string };
    bin: { binId: string };
  }>;
}

interface OwnerPairPositionsGraph {
  positions: DashboardGraph["positions"];
}

interface PairBinsGraph {
  bins: Array<{
    id: string;
    binId: string;
    reserveX: string;
    reserveY: string;
    totalSupply: string;
    updatedAtBlock: string;
  }>;
}

export interface PaginatedRows<T> {
  pageInfo: PaginationInfo;
  rows: T[];
}

const DASHBOARD_SUMMARY_QUERY = `
  query DashboardSummary($factory: ID!) {
    _meta {
      block {
        number
        hash
      }
      hasIndexingErrors
    }
    factory(id: $factory) {
      pairCount
    }
  }
`;

const PAIRS_PAGE_QUERY = `
  query PairsPage($first: Int!, $skip: Int!) {
    pairs(first: $first, skip: $skip, orderBy: updatedAtBlock, orderDirection: desc) {
      id
      address
      tokenX {
        address
      }
      tokenY {
        address
      }
      activeId
      binStep
      reserveX
      reserveY
      totalVolumeX
      totalVolumeY
      totalFeesX
      totalFeesY
      swapCount
      depositCount
      updatedAtBlock
    }
  }
`;

const PAIR_BY_ID_QUERY = `
  query PairById($id: ID!) {
    pair(id: $id) {
      id
      address
      tokenX { address }
      tokenY { address }
      activeId
      binStep
      reserveX
      reserveY
      totalVolumeX
      totalVolumeY
      totalFeesX
      totalFeesY
      swapCount
      depositCount
      updatedAtBlock
    }
  }
`;

const SWAPS_PAGE_QUERY = `
  query SwapsPage($first: Int!, $skip: Int!) {
    swaps(first: $first, skip: $skip, orderBy: blockNumber, orderDirection: desc) {
      id
      transactionHash
      blockNumber
      timestamp
      amountInX
      amountInY
      amountOutX
      amountOutY
      pair {
        id
      }
      sender
    }
  }
`;

const LIQUIDITY_EVENTS_PAGE_QUERY = `
  query LiquidityEventsPage($first: Int!, $skip: Int!) {
    liquidityEvents(first: $first, skip: $skip, orderBy: blockNumber, orderDirection: desc) {
      id
      type
      transactionHash
      blockNumber
      timestamp
      amountX
      amountY
      pair {
        id
      }
      sender
    }
  }
`;

const POSITIONS_PAGE_QUERY = `
  query PositionsPage($first: Int!, $skip: Int!) {
    positions(first: $first, skip: $skip, orderBy: updatedAtBlock, orderDirection: desc, where: { liquidity_gt: 0 }) {
      id
      owner
      liquidity
      updatedAtBlock
      pair {
        id
      }
      bin {
        binId
      }
    }
  }
`;

const OWNER_PAIR_POSITIONS_QUERY = `
  query OwnerPairPositions($owner: Bytes!, $pair: String!, $first: Int!, $skip: Int!) {
    positions(first: $first, skip: $skip, orderBy: updatedAtBlock, orderDirection: desc, where: { owner: $owner, pair: $pair, liquidity_gt: 0 }) {
      id
      owner
      liquidity
      updatedAtBlock
      pair {
        id
      }
      bin {
        binId
      }
    }
  }
`;

const OWNER_PAIR_POSITIONS_AT_BLOCK_QUERY = `
  query OwnerPairPositionsAtBlock($owner: Bytes!, $pair: String!, $blockNumber: Int!, $first: Int!, $skip: Int!) {
    positions(
      first: $first
      skip: $skip
      orderBy: updatedAtBlock
      orderDirection: desc
      block: { number: $blockNumber }
      where: { owner: $owner, pair: $pair, liquidity_gt: 0 }
    ) {
      id
      owner
      liquidity
      updatedAtBlock
      pair {
        id
      }
      bin {
        binId
      }
    }
  }
`;

const WALLET_PORTFOLIO_QUERY = `
  query WalletPortfolio($owner: ID!, $first: Int!, $after: String) {
    walletPositions(owner: $owner, first: $first, after: $after) {
      nodes {
        owner
        pair
        costBasisUsdE18
        currentValueUsdE18
        realizedPnlUsdE18
        unrealizedPnlUsdE18
        status
        missingPriceTokens
        asOfBlock
        asOfTimestamp
        bins {
          binId
          liquidity
          amountX
          amountY
          costBasisUsdE18
          currentValueUsdE18
          realizedPnlUsdE18
          unrealizedPnlUsdE18
          asOfBlock
          asOfTimestamp
          status
          missingPriceTokens
        }
      }
      pageInfo {
        endCursor
        hasNextPage
        partial
      }
    }
    analyticsHealth {
      status
      headBlock
      fresh
    }
  }
`;

const PAIR_BINS_QUERY = `
  query PairBins($pair: String!, $first: Int!, $skip: Int!) {
    bins(first: $first, skip: $skip, orderBy: binId, orderDirection: asc, where: { pair: $pair, totalSupply_gt: 0 }) {
      id
      binId
      reserveX
      reserveY
      totalSupply
      updatedAtBlock
    }
  }
`;

const POSITION_HISTORY_QUERY = `
  query PositionLiquidityHistory($owner: Bytes!, $pair: String!, $first: Int!, $skip: Int!) {
    liquidityEvents(
      first: $first
      skip: $skip
      orderBy: blockNumber
      orderDirection: desc
      where: { pair: $pair, or: [{ sender: $owner }, { to: $owner }] }
    ) {
      id
      type
      transactionHash
      blockNumber
      timestamp
      amountX
      amountY
      ids
      sender
      to
    }
    transferBatchEvents(
      first: $first
      skip: $skip
      orderBy: blockNumber
      orderDirection: desc
      where: { pair: $pair, or: [{ from: $owner }, { to: $owner }] }
    ) {
      id
      transactionHash
      blockNumber
      timestamp
      sender
      from
      to
      ids
    }
  }
`;

const PAIR_BIN_WINDOW_QUERY = `
  query PairBinWindow($pair: String!, $minBin: BigInt!, $maxBin: BigInt!, $first: Int!) {
    bins(first: $first, orderBy: binId, orderDirection: asc, where: { pair: $pair, binId_gte: $minBin, binId_lte: $maxBin }) {
      id
      binId
      reserveX
      reserveY
      totalSupply
      updatedAtBlock
    }
  }
`;

export async function loadAppSnapshot(registry: DexRegistry, options: AppDataLoadOptions = {}): Promise<AppSnapshot> {
  const graphqlTimeoutMs = normalizeGraphqlTimeout(options.graphqlTimeoutMs);
  const [runtime, indexer] = await Promise.all([loadRuntimeState(registry), loadIndexerState(registry, graphqlTimeoutMs)]);
  const staleMessage = indexerStaleMessage(runtime, indexer, indexerStaleBlockThreshold(registry));

  if (staleMessage !== null) {
    return {
      runtime,
      indexer: {
        ...indexer,
        status: "stale",
        message: indexer.message === null ? staleMessage : `${indexer.message}; ${staleMessage}`
      }
    };
  }

  return { runtime, indexer };
}

export async function loadPoolById(
  registry: DexRegistry,
  poolId: string,
  options: AppDataLoadOptions = {}
): Promise<PoolRow | null> {
  if (registry.endpoints.indexerUrl === null) return null;
  const data = await fetchGraph<{ pair: DashboardGraph["pairs"][number] | null }>(
    registry.endpoints.indexerUrl,
    PAIR_BY_ID_QUERY,
    { id: poolId.toLowerCase() },
    normalizeGraphqlTimeout(options.graphqlTimeoutMs)
  );

  return data.pair === null ? null : toPoolRow(registry, data.pair);
}

export async function loadPositionsForOwnerPair(registry: DexRegistry, owner: Address, pair: Address): Promise<PositionRow[]> {
  return (await loadPaginatedPositionsForOwnerPair(registry, owner, pair)).rows;
}

export async function loadPaginatedPositionsForOwnerPair(
  registry: DexRegistry,
  owner: Address,
  pair: Address,
  options: AppDataLoadOptions = {}
): Promise<PaginatedRows<PositionRow>> {
  if (registry.endpoints.indexerUrl === null) {
    return { rows: [], pageInfo: emptyPaginationInfo() };
  }

  return loadPaginatedGraphRows<OwnerPairPositionsGraph, DashboardGraph["positions"][number], PositionRow>({
    endpoint: registry.endpoints.indexerUrl,
    query: OWNER_PAIR_POSITIONS_QUERY,
    variables: {
      owner: owner.toLowerCase(),
      pair: pair.toLowerCase()
    },
    select: (data) => data.positions,
    map: toPositionRow,
    timeoutMs: normalizeGraphqlTimeout(options.graphqlTimeoutMs)
  });
}

export async function loadPaginatedPositionsForOwnerPairAtBlock(
  registry: DexRegistry,
  owner: Address,
  pair: Address,
  blockNumber: bigint,
  options: AppDataLoadOptions = {}
): Promise<PaginatedRows<PositionRow>> {
  if (registry.endpoints.indexerUrl === null) {
    return { rows: [], pageInfo: emptyPaginationInfo() };
  }
  if (blockNumber < 0n || blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Pinned owner-position block must be a non-negative safe integer");
  }

  return loadPaginatedGraphRows<OwnerPairPositionsGraph, DashboardGraph["positions"][number], PositionRow>({
    endpoint: registry.endpoints.indexerUrl,
    query: OWNER_PAIR_POSITIONS_AT_BLOCK_QUERY,
    variables: {
      owner: owner.toLowerCase(),
      pair: pair.toLowerCase(),
      blockNumber: Number(blockNumber)
    },
    select: (data) => data.positions,
    map: toPositionRow,
    timeoutMs: normalizeGraphqlTimeout(options.graphqlTimeoutMs)
  });
}

export async function loadWalletPortfolio(endpoint: string, owner: Address): Promise<WalletPortfolioPage> {
  const positions: PortfolioPositionRow[] = [];
  let after: string | null = null;
  let health: WalletPortfolioPage["health"] | null = null;

  for (let page = 0; page < GRAPHQL_MAX_PAGES; page += 1) {
    const data: WalletPortfolioGraph = await fetchGraph<WalletPortfolioGraph>(
      endpoint,
      WALLET_PORTFOLIO_QUERY,
      { owner: owner.toLowerCase(), first: GRAPHQL_PAGE_SIZE, after },
      GRAPHQL_REQUEST_TIMEOUT_MS
    );
    health ??= data.analyticsHealth;
    positions.push(...data.walletPositions.nodes);
    if (!data.walletPositions.pageInfo.hasNextPage) {
      return { positions, pageInfo: data.walletPositions.pageInfo, health };
    }
    if (!data.walletPositions.pageInfo.endCursor || data.walletPositions.pageInfo.endCursor === after) {
      throw new Error("Analytics pagination cursor did not advance");
    }
    after = data.walletPositions.pageInfo.endCursor;
  }

  return {
    positions,
    pageInfo: { endCursor: after, hasNextPage: true, partial: true },
    health: health ?? { fresh: false, headBlock: null, status: "UNAVAILABLE" }
  };
}

export async function loadPositionHistory(
  registry: DexRegistry,
  owner: Address,
  pair: Address
): Promise<PaginatedRows<PositionHistoryRow>> {
  if (registry.endpoints.indexerUrl === null) {
    return { rows: [], pageInfo: emptyPaginationInfo() };
  }
  const rows: PositionHistoryRow[] = [];
  for (let page = 0; page < GRAPHQL_MAX_PAGES; page += 1) {
    let data: PositionHistoryGraph;
    try {
      data = await fetchGraph<PositionHistoryGraph>(
        registry.endpoints.indexerUrl,
        POSITION_HISTORY_QUERY,
        { owner: owner.toLowerCase(), pair: pair.toLowerCase(), first: GRAPHQL_PAGE_SIZE, skip: page * GRAPHQL_PAGE_SIZE },
        GRAPHQL_REQUEST_TIMEOUT_MS
      );
    } catch (error) {
      if (rows.length === 0) throw error;
      return {
        rows: sortPositionHistory(rows),
        pageInfo: {
          capped: false,
          error: error instanceof Error ? error.message : "Position history request failed",
          failed: true,
          loadedCount: rows.length,
          maxPages: GRAPHQL_MAX_PAGES,
          pageSize: GRAPHQL_PAGE_SIZE
        }
      };
    }
    rows.push(
      ...data.liquidityEvents.map((event) => ({ ...event, binIds: event.ids })),
      ...data.transferBatchEvents.map((event) => ({
        id: event.id,
        type: event.from.toLowerCase() === owner.toLowerCase()
          ? event.to.toLowerCase() === owner.toLowerCase() ? "TRANSFER" : "TRANSFER_OUT"
          : "TRANSFER_IN",
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        timestamp: event.timestamp,
        amountX: null,
        amountY: null,
        binIds: event.ids,
        sender: event.sender,
        to: event.to
      }))
    );
    if (data.liquidityEvents.length < GRAPHQL_PAGE_SIZE && data.transferBatchEvents.length < GRAPHQL_PAGE_SIZE) {
      return {
        rows: sortPositionHistory(rows),
        pageInfo: {
          capped: false,
          failed: false,
          loadedCount: rows.length,
          maxPages: GRAPHQL_MAX_PAGES,
          pageSize: GRAPHQL_PAGE_SIZE
        }
      };
    }
  }
  return {
    rows: sortPositionHistory(rows),
    pageInfo: {
      capped: true,
      failed: false,
      loadedCount: rows.length,
      maxPages: GRAPHQL_MAX_PAGES,
      pageSize: GRAPHQL_PAGE_SIZE
    }
  };
}

function sortPositionHistory(rows: PositionHistoryRow[]): PositionHistoryRow[] {
  return rows.sort((left, right) => Number(BigInt(right.blockNumber) - BigInt(left.blockNumber)));
}

export async function loadPaginatedBinsForPair(
  registry: DexRegistry,
  pair: Address,
  options: AppDataLoadOptions = {}
): Promise<PaginatedRows<BinRow>> {
  if (registry.endpoints.indexerUrl === null) {
    return { rows: [], pageInfo: emptyPaginationInfo() };
  }

  return loadPaginatedGraphRows<PairBinsGraph, PairBinsGraph["bins"][number], BinRow>({
    endpoint: registry.endpoints.indexerUrl,
    query: PAIR_BINS_QUERY,
    variables: { pair: pair.toLowerCase() },
    select: (data) => data.bins,
    map: (bin) => ({ ...bin }),
    timeoutMs: normalizeGraphqlTimeout(options.graphqlTimeoutMs)
  });
}

export async function loadPoolBinWindow(
  registry: DexRegistry,
  pair: Address,
  activeId: number,
  radius = 40,
  options: AppDataLoadOptions = {}
): Promise<BinRow[]> {
  if (registry.endpoints.indexerUrl === null) return [];
  if (!Number.isSafeInteger(activeId) || activeId < 0) throw new Error("Active bin must be a non-negative safe integer");
  if (!Number.isSafeInteger(radius) || radius < 0 || radius > 100) throw new Error("Bin window radius must be between 0 and 100");

  const minBin = Math.max(0, activeId - radius);
  const maxBin = activeId + radius;
  const data = await fetchGraph<PairBinsGraph>(
    registry.endpoints.indexerUrl,
    PAIR_BIN_WINDOW_QUERY,
    {
      pair: pair.toLowerCase(),
      minBin: minBin.toString(),
      maxBin: maxBin.toString(),
      first: maxBin - minBin + 1
    },
    normalizeGraphqlTimeout(options.graphqlTimeoutMs)
  );

  return data.bins.map((bin) => ({ ...bin }));
}

export function formatCompactAddress(value: string | null | undefined): string {
  if (!value) return "n/a";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function formatTokenAmount(value: string | bigint, token: TokenMetadata | null): string {
  const decimals = token?.decimals ?? 18;
  const raw = BigInt(value);
  const formatted = formatUnits(raw, decimals);
  const [whole, fraction = ""] = formatted.split(".");
  const displayedDecimals = whole === "0" ? Math.min(6, decimals) : Math.min(4, decimals);
  const trimmedFraction = fraction.slice(0, displayedDecimals).replace(/0+$/, "");

  if (raw > 0n && whole === "0" && trimmedFraction.length === 0 && decimals > displayedDecimals) {
    return `<0.${"0".repeat(Math.max(0, displayedDecimals - 1))}1`;
  }

  return trimmedFraction.length > 0 ? `${whole}.${trimmedFraction}` : whole;
}

export function tokenSymbol(token: TokenMetadata | null): string {
  return token?.symbol ?? "TOKEN";
}

async function loadRuntimeState(registry: DexRegistry): Promise<RuntimeState> {
  try {
    const client = createPublicClient({
      chain: registry.chain,
      transport: http(registry.endpoints.rpcUrl)
    });
    const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);

    if (chainId !== registry.chainId) {
      return {
        chainId,
        blockNumber: blockNumber.toString(),
        seededActiveId: null,
        status: "error",
        message: `RPC chain mismatch: expected ${registry.chainId}, received ${chainId}`
      };
    }

    let seededActiveId: number | null = null;

    if (isLocalnetRegistry(registry)) {
      seededActiveId = await client.readContract({
        address: registry.seededPools.wnativeUsdc.pair,
        abi: lbPairAbi,
        functionName: "getActiveId"
      });
    }

    return {
      chainId,
      blockNumber: blockNumber.toString(),
      seededActiveId,
      status: "ready",
      message: null
    };
  } catch (error) {
    return {
      chainId: null,
      blockNumber: null,
      seededActiveId: null,
      status: "error",
      message: error instanceof Error ? error.message : "RPC request failed"
    };
  }
}

async function loadIndexerState(registry: DexRegistry, timeoutMs: number): Promise<IndexerState> {
  if (registry.endpoints.indexerUrl === null) {
    return {
      status: "unavailable",
      message: "Indexer endpoint is not configured for this environment yet.",
      blockNumber: null,
      blockHash: null,
      hasIndexingErrors: false,
      pairCount: null,
      pools: [],
      activity: [],
      positions: [],
      pagination: emptyIndexerPagination()
    };
  }

  try {
    const [summary, poolsPage, swapsPage, liquidityPage, positionsPage] = await Promise.all([
      fetchGraph<Pick<DashboardGraph, "_meta" | "factory">>(
        registry.endpoints.indexerUrl,
        DASHBOARD_SUMMARY_QUERY,
        { factory: registry.contracts.lbFactory.toLowerCase() },
        timeoutMs
      ),
      loadPaginatedGraphRows<Pick<DashboardGraph, "pairs">, DashboardGraph["pairs"][number], PoolRow>({
        endpoint: registry.endpoints.indexerUrl,
        query: PAIRS_PAGE_QUERY,
        select: (data) => data.pairs,
        map: (pair) => toPoolRow(registry, pair),
        timeoutMs
      }),
      loadPaginatedGraphRows<Pick<DashboardGraph, "swaps">, DashboardGraph["swaps"][number], ActivityRow>({
        endpoint: registry.endpoints.indexerUrl,
        query: SWAPS_PAGE_QUERY,
        select: (data) => data.swaps,
        map: (swap) => ({
          id: swap.id,
          type: "Swap",
          transactionHash: swap.transactionHash,
          blockNumber: swap.blockNumber,
          timestamp: swap.timestamp,
          amountX: BigInt(swap.amountInX) > 0n ? swap.amountInX : swap.amountOutX,
          amountY: BigInt(swap.amountInY) > 0n ? swap.amountInY : swap.amountOutY,
          account: swap.sender,
          pair: swap.pair.id
        }),
        timeoutMs
      }),
      loadPaginatedGraphRows<Pick<DashboardGraph, "liquidityEvents">, DashboardGraph["liquidityEvents"][number], ActivityRow>({
        endpoint: registry.endpoints.indexerUrl,
        query: LIQUIDITY_EVENTS_PAGE_QUERY,
        select: (data) => data.liquidityEvents,
        map: (event) => ({
          id: event.id,
          type: event.type,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          timestamp: event.timestamp,
          amountX: event.amountX,
          amountY: event.amountY,
          account: event.sender,
          pair: event.pair.id
        }),
        timeoutMs
      }),
      loadPaginatedGraphRows<Pick<DashboardGraph, "positions">, DashboardGraph["positions"][number], PositionRow>({
        endpoint: registry.endpoints.indexerUrl,
        query: POSITIONS_PAGE_QUERY,
        select: (data) => data.positions,
        map: toPositionRow,
        timeoutMs
      })
    ]);

    const pagination = {
      pools: poolsPage.pageInfo,
      swaps: swapsPage.pageInfo,
      liquidityEvents: liquidityPage.pageInfo,
      positions: positionsPage.pageInfo
    };
    const pageMessage = paginationMessage(pagination);
    const hasIndexingErrors = summary._meta?.hasIndexingErrors ?? false;
    const status: LoadState = hasIndexingErrors
      ? "error"
      : hasPartialPagination(pagination)
        ? "partial"
        : poolsPage.rows.length > 0
          ? "ready"
          : "empty";
    const message = hasIndexingErrors
      ? ["Indexer reports indexing errors", pageMessage].filter((value) => value !== null).join("; ")
      : pageMessage;

    return {
      status,
      message,
      blockNumber: summary._meta?.block.number.toString() ?? null,
      blockHash: summary._meta?.block.hash ?? null,
      hasIndexingErrors,
      pairCount: summary.factory?.pairCount ?? "0",
      pools: poolsPage.rows,
      activity: [...swapsPage.rows, ...liquidityPage.rows]
        .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)))
        .slice(0, GRAPHQL_ACTIVITY_RENDER_LIMIT),
      positions: positionsPage.rows,
      pagination
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Indexer request failed",
      blockNumber: null,
      blockHash: null,
      hasIndexingErrors: false,
      pairCount: null,
      pools: [],
      activity: [],
      positions: [],
      pagination: emptyIndexerPagination()
    };
  }
}

async function fetchGraph<T>(
  endpoint: string,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Indexer returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as GraphResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(payload.errors.map((error) => error.message).join("; "));
    }

    if (!payload.data) {
      throw new Error("Indexer returned no data");
    }

    return payload.data;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Indexer request timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadPaginatedGraphRows<TData, TGraphRow, TRow>({
  endpoint,
  map,
  query,
  select,
  timeoutMs,
  variables = {}
}: {
  endpoint: string;
  map: (row: TGraphRow) => TRow;
  query: string;
  select: (data: TData) => TGraphRow[];
  timeoutMs: number;
  variables?: Record<string, unknown>;
}): Promise<PaginatedRows<TRow>> {
  const rows: TRow[] = [];

  for (let page = 0; page < GRAPHQL_MAX_PAGES; page += 1) {
    let data: TData;

    try {
      data = await fetchGraph<TData>(
        endpoint,
        query,
        {
          ...variables,
          first: GRAPHQL_PAGE_SIZE,
          skip: page * GRAPHQL_PAGE_SIZE
        },
        timeoutMs
      );
    } catch (error) {
      if (rows.length === 0) {
        throw error;
      }

      return {
        rows,
        pageInfo: {
          capped: false,
          error: error instanceof Error ? error.message : "Indexer page request failed",
          failed: true,
          loadedCount: rows.length,
          maxPages: GRAPHQL_MAX_PAGES,
          pageSize: GRAPHQL_PAGE_SIZE
        }
      };
    }

    const pageRows = select(data);
    rows.push(...pageRows.map(map));

    if (pageRows.length < GRAPHQL_PAGE_SIZE) {
      return {
        rows,
        pageInfo: {
          capped: false,
          failed: false,
          loadedCount: rows.length,
          maxPages: GRAPHQL_MAX_PAGES,
          pageSize: GRAPHQL_PAGE_SIZE
        }
      };
    }
  }

  return {
    rows,
    pageInfo: {
      capped: true,
      failed: false,
      loadedCount: rows.length,
      maxPages: GRAPHQL_MAX_PAGES,
      pageSize: GRAPHQL_PAGE_SIZE
    }
  };
}

function emptyPaginationInfo(): PaginationInfo {
  return {
    capped: false,
    failed: false,
    loadedCount: 0,
    maxPages: GRAPHQL_MAX_PAGES,
    pageSize: GRAPHQL_PAGE_SIZE
  };
}

function emptyIndexerPagination(): IndexerState["pagination"] {
  return {
    pools: emptyPaginationInfo(),
    swaps: emptyPaginationInfo(),
    liquidityEvents: emptyPaginationInfo(),
    positions: emptyPaginationInfo()
  };
}

function paginationMessage(pagination: IndexerState["pagination"]): string | null {
  const cappedCollections = Object.entries(pagination)
    .filter(([, pageInfo]) => pageInfo.capped || pageInfo.failed)
    .map(([name, pageInfo]) => {
      const summary = `${name} ${pageInfo.failed ? "failed after" : "capped at"} ${pageInfo.loadedCount}`;
      return pageInfo.error ? `${summary} (${pageInfo.error})` : summary;
    });

  return cappedCollections.length > 0 ? `Partial indexer data: ${cappedCollections.join(", ")}` : null;
}

function hasPartialPagination(pagination: IndexerState["pagination"]): boolean {
  return Object.values(pagination).some((pageInfo) => pageInfo.capped || pageInfo.failed);
}

function indexerStaleBlockThreshold(registry: DexRegistry): bigint {
  return registry.environment === "robinhoodTestnet"
    ? ROBINHOOD_TESTNET_INDEXER_STALE_BLOCK_THRESHOLD
    : INDEXER_STALE_BLOCK_THRESHOLD;
}

function indexerStaleMessage(runtime: RuntimeState, indexer: IndexerState, staleBlockThreshold: bigint): string | null {
  if (
    runtime.status !== "ready" ||
    runtime.blockNumber === null ||
    indexer.blockNumber === null ||
    indexer.status === "unavailable" ||
    (indexer.status === "error" && !indexer.hasIndexingErrors)
  ) {
    return null;
  }

  const lag = BigInt(runtime.blockNumber) - BigInt(indexer.blockNumber);
  if (lag <= staleBlockThreshold) {
    return null;
  }

  return `Indexer stale by ${lag.toString()} blocks`;
}

function normalizeGraphqlTimeout(value: number | undefined): number {
  if (value === undefined) return GRAPHQL_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("GraphQL timeout must be a positive integer of milliseconds");
  }

  return value;
}

function toPositionRow(position: DashboardGraph["positions"][number]): PositionRow {
  return {
    id: position.id,
    owner: position.owner,
    liquidity: position.liquidity,
    updatedAtBlock: position.updatedAtBlock,
    pair: position.pair.id,
    binId: position.bin.binId
  };
}

function toPoolRow(registry: DexRegistry, pair: DashboardGraph["pairs"][number]): PoolRow {
  const tokenX = findToken(registry, pair.tokenX.address);
  const tokenY = findToken(registry, pair.tokenY.address);

  return {
    id: pair.id,
    address: pair.address as Address,
    tokenXAddress: pair.tokenX.address as Address,
    tokenYAddress: pair.tokenY.address as Address,
    tokenX,
    tokenY,
    activeId: pair.activeId,
    binStep: pair.binStep,
    reserveX: pair.reserveX,
    reserveY: pair.reserveY,
    volumeX: pair.totalVolumeX,
    volumeY: pair.totalVolumeY,
    feesX: pair.totalFeesX,
    feesY: pair.totalFeesY,
    swapCount: pair.swapCount,
    depositCount: pair.depositCount,
    updatedAtBlock: pair.updatedAtBlock
  };
}

function findToken(registry: DexRegistry, address: string): TokenMetadata | null {
  const normalizedAddress = address as Address;

  return (
    Object.values(registry.tokens).find((token) => {
      try {
        return isAddressEqual(token.address, normalizedAddress);
      } catch {
        return token.address.toLowerCase() === address.toLowerCase();
      }
    }) ?? null
  );
}
