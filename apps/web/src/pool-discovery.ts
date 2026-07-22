import { isAddress, type Address } from "viem";

import { parsePoolWorkspaceRoute, poolWorkspaceHref } from "./pool-workspace-route";

export type PoolCategory = "all" | "active" | "stables";
export type PoolSort =
  | "marketCap"
  | "priceChange"
  | "tvl"
  | "volume24h"
  | "lpFees24h"
  // Retained so old bookmarked discovery URLs remain useful.
  | "swaps"
  | "deposits"
  | "updated"
  | "feeToTvl";
export type PoolSortDirection = "asc" | "desc";
export type PoolAction = "swap" | "add" | "withdraw";

export interface PoolDiscoveryState {
  query: string;
  category: PoolCategory;
  sort: PoolSort;
  direction: PoolSortDirection;
  /** Canonical, human-readable USD decimal. Null means no minimum. */
  minTvlUsd: string | null;
  /** Canonical, human-readable USD decimal. Null means no minimum. */
  minVolume24hUsd: string | null;
  /** Canonical, human-readable USD decimal. Null means no minimum. */
  minLpFees24hUsd: string | null;
  /** Zero-based internally; serialized as a one-based page. */
  page: number;
  hasLiquidity: boolean;
}

export interface DiscoverableToken {
  address?: Address;
  chainId?: number;
  name?: string;
  symbol?: string;
  logoURI?: string;
  tags?: readonly string[];
}

export interface DiscoverablePool {
  id: string;
  address: Address;
  tokenXAddress: Address;
  tokenYAddress: Address;
  tokenX: DiscoverableToken | null;
  tokenY: DiscoverableToken | null;
  activeId: string | null;
  binStep: string;
  reserveX: string;
  reserveY: string;
  swapCount: string;
  depositCount: string;
  updatedAtBlock: string;
  marketCapUsdE18?: string | null;
  priceChange24hE18?: string | null;
  tvlUsdE18?: string | null;
  volume24hUsdE18?: string | null;
  lpFees24hUsdE18?: string | null;
  feeToTvlE18?: string | null;
}

export interface OwnerPositionLike {
  pair: string;
  bins?: readonly { liquidity: string }[];
}

export interface PaginationLike {
  capped: boolean;
  failed: boolean;
}

export interface OwnerLiquidityIndex {
  pairs: ReadonlySet<string>;
  partial: boolean;
}

export interface FilteredPoolPage<T> {
  rows: T[];
  filteredCount: number;
  page: number;
  pageCount: number;
  ownerStatus: "not-requested" | "unavailable" | "partial" | "ready";
}

export const DEFAULT_POOL_DISCOVERY_STATE: Readonly<PoolDiscoveryState> = Object.freeze({
  query: "",
  category: "all",
  sort: "volume24h",
  direction: "desc",
  minTvlUsd: null,
  minVolume24hUsd: null,
  minLpFees24hUsd: null,
  page: 0,
  hasLiquidity: false
});

export function parsePoolDiscoveryState(hash: string): PoolDiscoveryState {
  const { search } = parseHash(hash);
  const params = new URLSearchParams(search);
  const category = params.get("category");
  const sort = params.get("sort");
  const direction = params.get("direction");
  const page = params.get("page");
  return {
    query: (params.get("q") ?? "").trim(),
    category: category === "active" || category === "stables" ? category : "all",
    sort: isPoolSort(sort) ? sort : DEFAULT_POOL_DISCOVERY_STATE.sort,
    direction: direction === "asc" ? "asc" : "desc",
    minTvlUsd: parseUsdMinimum(params.get("minTvl")),
    minVolume24hUsd: parseUsdMinimum(params.get("minVolume")),
    minLpFees24hUsd: parseUsdMinimum(params.get("minFees")),
    page: page !== null && /^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page)) ? Number(page) - 1 : 0,
    hasLiquidity: params.get("mine") === "1"
  };
}

/** Applies discovery controls and resets pagination whenever a filter or sort changes. */
export function updatePoolDiscoveryState(
  current: PoolDiscoveryState,
  patch: Partial<PoolDiscoveryState>
): PoolDiscoveryState {
  const next = { ...current, ...patch };
  const onlyPageChanged = Object.keys(patch).every((key) => key === "page");
  return {
    ...next,
    minTvlUsd: canonicalUsdMinimum(next.minTvlUsd),
    minVolume24hUsd: canonicalUsdMinimum(next.minVolume24hUsd),
    minLpFees24hUsd: canonicalUsdMinimum(next.minLpFees24hUsd),
    page: onlyPageChanged ? Math.max(0, next.page) : 0
  };
}

export function discoveryHref(state: PoolDiscoveryState): string {
  return withDiscoverySearch("#/pools", state);
}

export function poolDetailHref(poolId: string, state: PoolDiscoveryState): string {
  return withDiscoverySearch(`#/pools/${encodeRoutePart(poolId)}`, state);
}

export function actionHref(action: PoolAction, poolId: string, returnTo: string): string {
  const base = action === "swap"
    ? poolWorkspaceHref(poolId, "swap")
    : poolWorkspaceHref(poolId, action === "add" ? "create" : "manage");
  const safeReturn = safeReturnHref(returnTo);
  if (safeReturn === null) return base;
  const params = new URLSearchParams({ returnTo: safeReturn });
  return `${base}?${params.toString()}`;
}

export function returnHrefFromAction(hash: string): string | null {
  const { search } = parseHash(hash);
  return safeReturnHref(new URLSearchParams(search).get("returnTo"));
}

/**
 * Keeps discovery context attached to canonical pool market routes while
 * preserving the explicit, validated return target carried by action routes.
 */
export function returnHrefForPoolWorkspace(hash: string): string | null {
  const explicitReturn = returnHrefFromAction(hash);
  if (explicitReturn !== null) return explicitReturn;
  const route = parsePoolWorkspaceRoute(hash);
  if (route?.source !== "canonical" || route.task !== "market") return null;
  return discoveryHref(parsePoolDiscoveryState(hash));
}

export function safeReturnHref(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = parseHash(value);
  if (parsed.segments[0] !== "pools" || parsed.segments.length > 2) return null;
  const state = parsePoolDiscoveryState(value);
  if (parsed.segments.length === 1) return discoveryHref(state);
  const poolId = decodeRoutePart(parsed.segments[1]);
  if (poolId === null) return null;
  try {
    return poolDetailHref(poolId, state);
  } catch {
    return null;
  }
}

export function buildOwnerLiquidityIndex(
  positions: readonly OwnerPositionLike[],
  pageInfo: PaginationLike
): OwnerLiquidityIndex {
  return {
    pairs: new Set(positions.flatMap((position) => {
      const hasCurrentLiquidity = position.bins === undefined || position.bins.some((bin) => {
        if (!/^\d+$/.test(bin.liquidity)) throw new Error(`Invalid owner liquidity: ${bin.liquidity}`);
        return BigInt(bin.liquidity) > 0n;
      });
      return hasCurrentLiquidity ? [canonicalAddress(position.pair)] : [];
    })),
    partial: pageInfo.capped || pageInfo.failed
  };
}

export function filterPoolPage<T extends DiscoverablePool>(
  pools: readonly T[],
  state: PoolDiscoveryState,
  ownerLiquidity: OwnerLiquidityIndex | null,
  pageSize = 10,
  sorter?: (left: T, right: T, sort: PoolSort, direction: PoolSortDirection) => number | null
): FilteredPoolPage<T> {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error("pageSize must be a positive safe integer");
  const normalizedQuery = state.query.trim().toLowerCase();
  const ownerStatus = !state.hasLiquidity
    ? "not-requested"
    : ownerLiquidity === null
      ? "unavailable"
      : ownerLiquidity.partial
        ? "partial"
        : "ready";
  const ownerPairs = ownerLiquidity?.pairs ?? new Set<string>();
  const filtered = (state.hasLiquidity && ownerLiquidity === null ? [] : pools)
    .filter((pool) => {
      if (state.hasLiquidity && !ownerPairs.has(canonicalAddress(pool.address))) return false;
      if (state.category === "active" && !poolHasSwapLiquidity(pool)) return false;
      if (state.category === "stables" && !(pool.tokenX?.tags?.includes("stablecoin") && pool.tokenY?.tags?.includes("stablecoin"))) return false;
      if (!meetsUsdMinimum(pool.tvlUsdE18, state.minTvlUsd)) return false;
      if (!meetsUsdMinimum(pool.volume24hUsdE18, state.minVolume24hUsd)) return false;
      if (!meetsUsdMinimum(pool.lpFees24hUsdE18, state.minLpFees24hUsd)) return false;
      if (normalizedQuery.length === 0) return true;
      return [
        pool.tokenX?.symbol,
        pool.tokenX?.name,
        pool.tokenXAddress,
        pool.tokenY?.symbol,
        pool.tokenY?.name,
        pool.tokenYAddress,
        pool.address,
        pool.id
      ].join(" ").toLowerCase().includes(normalizedQuery);
    })
    .sort((left, right) => sorter?.(left, right, state.sort, state.direction) ?? comparePools(left, right, state.sort, state.direction));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(0, state.page), pageCount - 1);
  return {
    rows: filtered.slice(page * pageSize, (page + 1) * pageSize),
    filteredCount: filtered.length,
    page,
    pageCount,
    ownerStatus
  };
}

export function samePairPools<T extends DiscoverablePool>(pools: readonly T[], current: T): T[] {
  const key = samePairKey(current);
  return pools
    .filter((pool) => canonicalAddress(pool.address) !== canonicalAddress(current.address) && samePairKey(pool) === key)
    .sort((left, right) => {
      const binOrder = compareDecimalStrings(left.binStep, right.binStep);
      return binOrder !== 0 ? binOrder : canonicalAddress(left.address).localeCompare(canonicalAddress(right.address));
    });
}

export function samePairKey(pool: Pick<DiscoverablePool, "tokenXAddress" | "tokenYAddress">): string {
  return [canonicalAddress(pool.tokenXAddress), canonicalAddress(pool.tokenYAddress)].sort().join(":");
}

function withDiscoverySearch(base: string, state: PoolDiscoveryState): string {
  const params = new URLSearchParams();
  const query = state.query.trim();
  if (query.length > 0) params.set("q", query);
  if (state.category !== "all") params.set("category", state.category);
  if (state.sort !== DEFAULT_POOL_DISCOVERY_STATE.sort) params.set("sort", state.sort);
  if (state.direction !== DEFAULT_POOL_DISCOVERY_STATE.direction) params.set("direction", state.direction);
  const minTvl = canonicalUsdMinimum(state.minTvlUsd);
  const minVolume = canonicalUsdMinimum(state.minVolume24hUsd);
  const minFees = canonicalUsdMinimum(state.minLpFees24hUsd);
  if (minTvl !== null) params.set("minTvl", minTvl);
  if (minVolume !== null) params.set("minVolume", minVolume);
  if (minFees !== null) params.set("minFees", minFees);
  if (Number.isSafeInteger(state.page) && state.page > 0) params.set("page", String(state.page + 1));
  if (state.hasLiquidity) params.set("mine", "1");
  const search = params.toString();
  return search.length === 0 ? base : `${base}?${search}`;
}

function parseHash(hash: string): { segments: string[]; search: string } {
  const payload = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!payload.startsWith("/")) return { segments: [], search: "" };
  const queryIndex = payload.indexOf("?");
  const pathname = queryIndex === -1 ? payload : payload.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : payload.slice(queryIndex + 1);
  return { segments: pathname.split("/").filter(Boolean), search };
}

function encodeRoutePart(value: string): string {
  const decoded = decodeRoutePart(value);
  if (decoded === null) throw new Error("Invalid route identifier");
  return encodeURIComponent(decoded);
}

function decodeRoutePart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0 || decoded === "." || decoded === ".." || /[%\/\u0000-\u001f]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function canonicalAddress(value: string): string {
  if (!isAddress(value, { strict: false })) throw new Error(`Invalid EVM address: ${value}`);
  return value.toLowerCase();
}

function poolHasSwapLiquidity(pool: DiscoverablePool): boolean {
  return pool.activeId !== null && BigInt(pool.reserveX) > 0n && BigInt(pool.reserveY) > 0n;
}

function comparePools(
  left: DiscoverablePool,
  right: DiscoverablePool,
  sort: PoolSort,
  direction: PoolSortDirection
): number {
  const field = sortableField(sort);
  const leftMetric = field === null
    ? sort === "deposits" ? left.depositCount : sort === "updated" ? left.updatedAtBlock : left.swapCount
    : left[field] ?? null;
  const rightMetric = field === null
    ? sort === "deposits" ? right.depositCount : sort === "updated" ? right.updatedAtBlock : right.swapCount
    : right[field] ?? null;
  const metricOrder = compareNullableDecimalUnknownLast(leftMetric, rightMetric, direction);
  return metricOrder !== 0 ? metricOrder : canonicalAddress(left.address).localeCompare(canonicalAddress(right.address));
}

export function compareNullableDecimalUnknownLast(
  left: string | null | undefined,
  right: string | null | undefined,
  direction: PoolSortDirection
): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  const leftValue = parseSortableDecimal(left);
  const rightValue = parseSortableDecimal(right);
  const order = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  return direction === "asc" ? order : -order;
}

export function usdDecimalToE18(value: string): string {
  const canonical = canonicalUsdMinimum(value);
  if (canonical === null) return "0";
  const [whole, fraction = ""] = canonical.split(".");
  return (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0") || "0")).toString();
}

function sortableField(sort: PoolSort): keyof Pick<DiscoverablePool, "marketCapUsdE18" | "priceChange24hE18" | "tvlUsdE18" | "volume24hUsdE18" | "lpFees24hUsdE18" | "feeToTvlE18"> | null {
  if (sort === "marketCap") return "marketCapUsdE18";
  if (sort === "priceChange") return "priceChange24hE18";
  if (sort === "tvl") return "tvlUsdE18";
  if (sort === "volume24h") return "volume24hUsdE18";
  if (sort === "lpFees24h") return "lpFees24hUsdE18";
  if (sort === "feeToTvl") return "feeToTvlE18";
  return null;
}

function isPoolSort(value: string | null): value is PoolSort {
  return value === "marketCap" || value === "priceChange" || value === "tvl" || value === "volume24h" ||
    value === "lpFees24h" || value === "swaps" || value === "deposits" || value === "updated" || value === "feeToTvl";
}

function parseUsdMinimum(value: string | null): string | null {
  if (value === null || !/^(?:0|[1-9]\d{0,39})(?:\.\d{1,18})?$/.test(value)) return null;
  return canonicalUsdMinimum(value);
}

function canonicalUsdMinimum(value: string | null): string | null {
  if (value === null || !/^(?:0|[1-9]\d{0,39})(?:\.\d{1,18})?$/.test(value)) return null;
  const [whole, rawFraction = ""] = value.split(".");
  const fraction = rawFraction.replace(/0+$/, "");
  if (whole === "0" && fraction.length === 0) return null;
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function meetsUsdMinimum(valueE18: string | null | undefined, minimumUsd: string | null): boolean {
  const minimum = canonicalUsdMinimum(minimumUsd);
  if (minimum === null) return true;
  if (valueE18 === null || valueE18 === undefined || !/^\d+$/.test(valueE18)) return false;
  return BigInt(valueE18) >= BigInt(usdDecimalToE18(minimum));
}

function parseSortableDecimal(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid sortable decimal: ${value}`);
  return BigInt(value);
}

function compareDecimalStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
