import { isAddress, type Address } from "viem";

export type PoolCategory = "all" | "active" | "stables";
export type PoolSort = "swaps" | "deposits" | "updated";
export type PoolAction = "swap" | "add" | "withdraw";

export interface PoolDiscoveryState {
  query: string;
  category: PoolCategory;
  sort: PoolSort;
  /** Zero-based internally; serialized as a one-based page. */
  page: number;
  hasLiquidity: boolean;
}

export interface DiscoverableToken {
  address?: Address;
  name?: string;
  symbol?: string;
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
}

export interface OwnerPositionLike {
  pair: string;
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
  sort: "swaps",
  page: 0,
  hasLiquidity: false
});

export function parsePoolDiscoveryState(hash: string): PoolDiscoveryState {
  const { search } = parseHash(hash);
  const params = new URLSearchParams(search);
  const category = params.get("category");
  const sort = params.get("sort");
  const page = params.get("page");
  return {
    query: (params.get("q") ?? "").trim(),
    category: category === "active" || category === "stables" ? category : "all",
    sort: sort === "deposits" || sort === "updated" ? sort : "swaps",
    page: page !== null && /^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page)) ? Number(page) - 1 : 0,
    hasLiquidity: params.get("mine") === "1"
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
    ? `#/swap/${encodeRoutePart(poolId)}`
    : `#/liquidity/${action}/${encodeRoutePart(poolId)}`;
  const safeReturn = safeReturnHref(returnTo);
  if (safeReturn === null) return base;
  const params = new URLSearchParams({ returnTo: safeReturn });
  return `${base}?${params.toString()}`;
}

export function returnHrefFromAction(hash: string): string | null {
  const { search } = parseHash(hash);
  return safeReturnHref(new URLSearchParams(search).get("returnTo"));
}

export function safeReturnHref(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = parseHash(value);
  if (parsed.segments[0] !== "pools" || parsed.segments.length > 2) return null;
  const state = parsePoolDiscoveryState(value);
  if (parsed.segments.length === 1) return discoveryHref(state);
  const poolId = decodeRoutePart(parsed.segments[1]);
  if (poolId === null) return null;
  return poolDetailHref(poolId, state);
}

export function buildOwnerLiquidityIndex(
  positions: readonly OwnerPositionLike[],
  pageInfo: PaginationLike
): OwnerLiquidityIndex {
  return {
    pairs: new Set(positions.map((position) => canonicalAddress(position.pair))),
    partial: pageInfo.capped || pageInfo.failed
  };
}

export function filterPoolPage<T extends DiscoverablePool>(
  pools: readonly T[],
  state: PoolDiscoveryState,
  ownerLiquidity: OwnerLiquidityIndex | null,
  pageSize = 10
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
    .sort((left, right) => comparePools(left, right, state.sort));
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
  if (state.sort !== "swaps") params.set("sort", state.sort);
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
    if (decoded.length === 0 || decoded === "." || decoded === ".." || /[\/\u0000-\u001f]/.test(decoded)) return null;
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

function comparePools(left: DiscoverablePool, right: DiscoverablePool, sort: PoolSort): number {
  const leftMetric = sort === "deposits" ? left.depositCount : sort === "updated" ? left.updatedAtBlock : left.swapCount;
  const rightMetric = sort === "deposits" ? right.depositCount : sort === "updated" ? right.updatedAtBlock : right.swapCount;
  const metricOrder = compareDecimalStrings(rightMetric, leftMetric);
  return metricOrder !== 0 ? metricOrder : canonicalAddress(left.address).localeCompare(canonicalAddress(right.address));
}

function compareDecimalStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
