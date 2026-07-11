import type { DexRegistry, LocalnetDexRegistry } from "@robinhood-lb/sdk/registry";
import {
  findTokenMetadata,
  tokenAllowsAction,
  type TokenAction,
  type TokenMetadata,
  type TokenMetadataMap
} from "@robinhood-lb/sdk/tokens";
import { getAddress, type Address } from "viem";

import type { PoolRow } from "./data";

export type SelectedPoolSource = "localnet-seeded" | "indexed";
export type SelectedPoolTokenSide = "x" | "y";

export type SelectedPoolMessageCode =
  | "empty-pool"
  | "empty-indexed-pools"
  | "invalid-pool-address"
  | "invalid-pool-number"
  | "indexer-error"
  | "missing-pool-field"
  | "missing-indexer"
  | "missing-pool"
  | "missing-token-metadata"
  | "partial-indexer"
  | "rpc-chain-mismatch"
  | "rpc-error"
  | "rpc-loading"
  | "stale-indexer"
  | "unsupported-token-action";

export interface SelectedPoolReadinessMessage {
  action?: TokenAction;
  address?: string;
  code: SelectedPoolMessageCode;
  message: string;
  side?: SelectedPoolTokenSide;
}

export interface SelectedPoolIndexerFlags {
  empty?: boolean;
  emptyMessage?: string | null;
  error?: boolean;
  errorMessage?: string | null;
  partial?: boolean;
  partialMessage?: string | null;
  stale?: boolean;
  staleMessage?: string | null;
  unavailable?: boolean;
  unavailableMessage?: string | null;
}

export interface SelectedPoolRuntimeFlags {
  actualChainId: number | null;
  expectedChainId: number;
  message?: string | null;
  status: "loading" | "ready" | "error";
}

export type IndexedPoolSelectionRow = Pick<
  PoolRow,
  "activeId" | "address" | "binStep" | "reserveX" | "reserveY" | "tokenX" | "tokenXAddress" | "tokenY" | "tokenYAddress"
>;

export interface LocalnetSeededPoolSelectionInput {
  action?: TokenAction | null;
  indexer?: SelectedPoolIndexerFlags;
  pool?: LocalnetDexRegistry["seededPools"][keyof LocalnetDexRegistry["seededPools"]] | null;
  poolKey?: keyof LocalnetDexRegistry["seededPools"];
  registry: LocalnetDexRegistry | null | undefined;
  runtime?: SelectedPoolRuntimeFlags;
  source: "localnet-seeded";
}

export interface IndexedPoolSelectionInput {
  action?: TokenAction | null;
  indexer?: SelectedPoolIndexerFlags;
  pool: IndexedPoolSelectionRow | null | undefined;
  registry?: Pick<DexRegistry, "tokens"> | null;
  runtime?: SelectedPoolRuntimeFlags;
  source: "indexed";
}

export type SelectedPoolSelectionInput = LocalnetSeededPoolSelectionInput | IndexedPoolSelectionInput;

export interface SelectedPoolDescriptor {
  activeId: number | null;
  binStep: number | null;
  blocked: boolean;
  blockers: SelectedPoolReadinessMessage[];
  pair: Address | null;
  ready: boolean;
  reserveX: bigint | null;
  reserveY: bigint | null;
  source: SelectedPoolSource;
  tokenX: TokenMetadata | null;
  tokenXAddress: Address | null;
  tokenY: TokenMetadata | null;
  tokenYAddress: Address | null;
  warnings: SelectedPoolReadinessMessage[];
}

interface NormalizedPoolFields {
  activeId: number | null;
  binStep: number | null;
  pair: Address | null;
  reserveX: bigint | null;
  reserveY: bigint | null;
  tokenX: TokenMetadata | null;
  tokenXAddress: Address | null;
  tokenY: TokenMetadata | null;
  tokenYAddress: Address | null;
}

export function buildSelectedPoolDescriptor(input: SelectedPoolSelectionInput): SelectedPoolDescriptor {
  const blockers: SelectedPoolReadinessMessage[] = [];
  const warnings: SelectedPoolReadinessMessage[] = [];
  const pool = normalizePoolInput(input, blockers);

  appendRuntimeBlockers(input.runtime, blockers);
  appendIndexerBlockers(input.indexer, blockers);

  if (pool === null) {
    blockers.push({
      code: "missing-pool",
      message: "Selected pool is missing"
    });

    return finishDescriptor(
      {
        activeId: null,
        binStep: null,
        pair: null,
        reserveX: null,
        reserveY: null,
        tokenX: null,
        tokenXAddress: null,
        tokenY: null,
        tokenYAddress: null
      },
      input.source,
      blockers,
      warnings
    );
  }

  appendTokenMetadataReadiness(pool, input.action ?? null, blockers, warnings);
  appendRequiredFieldBlockers(pool, input.action ?? null, blockers);
  appendLiquidityBlockers(pool, input.action ?? null, blockers);
  appendUnsupportedActionBlockers(pool, input.action ?? null, blockers);

  return finishDescriptor(pool, input.source, blockers, warnings);
}

function appendRuntimeBlockers(runtime: SelectedPoolRuntimeFlags | undefined, blockers: SelectedPoolReadinessMessage[]): void {
  if (runtime === undefined || runtime.status === "ready") {
    if (runtime !== undefined && runtime.actualChainId !== runtime.expectedChainId) {
      blockers.push({
        code: "rpc-chain-mismatch",
        message: `RPC chain mismatch: expected ${runtime.expectedChainId}, received ${runtime.actualChainId ?? "unknown"}`
      });
    }
    return;
  }

  if (runtime.status === "loading") {
    blockers.push({
      code: "rpc-loading",
      message: `Confirming RPC chain ${runtime.expectedChainId}`
    });
    return;
  }

  const mismatched = runtime.actualChainId !== null && runtime.actualChainId !== runtime.expectedChainId;
  blockers.push({
    code: mismatched ? "rpc-chain-mismatch" : "rpc-error",
    message:
      runtime.message ??
      (mismatched
        ? `RPC chain mismatch: expected ${runtime.expectedChainId}, received ${runtime.actualChainId}`
        : `RPC chain ${runtime.expectedChainId} is unavailable`)
  });
}

function normalizePoolInput(
  input: SelectedPoolSelectionInput,
  blockers: SelectedPoolReadinessMessage[]
): NormalizedPoolFields | null {
  if (input.source === "localnet-seeded") {
    const seededPool = input.pool ?? (input.poolKey ? input.registry?.seededPools[input.poolKey] : null) ?? null;
    if (seededPool === null) return null;

    return {
      activeId: normalizeNumber(seededPool.activeId, "activeId", blockers),
      binStep: normalizeNumber(seededPool.binStep, "binStep", blockers),
      pair: normalizeAddress(seededPool.pair, "pair", blockers),
      reserveX: null,
      reserveY: null,
      tokenX: findPoolToken(input.registry?.tokens, seededPool.tokenX),
      tokenXAddress: normalizeAddress(seededPool.tokenX, "tokenXAddress", blockers),
      tokenY: findPoolToken(input.registry?.tokens, seededPool.tokenY),
      tokenYAddress: normalizeAddress(seededPool.tokenY, "tokenYAddress", blockers)
    };
  }

  if (input.pool === null || input.pool === undefined) return null;

  const tokenXAddress = normalizeAddress(input.pool.tokenXAddress, "tokenXAddress", blockers);
  const tokenYAddress = normalizeAddress(input.pool.tokenYAddress, "tokenYAddress", blockers);

  return {
    activeId: normalizeNumber(input.pool.activeId, "activeId", blockers),
    binStep: normalizeNumber(input.pool.binStep, "binStep", blockers),
    pair: normalizeAddress(input.pool.address, "pair", blockers),
    reserveX: normalizeReserve(input.pool.reserveX),
    reserveY: normalizeReserve(input.pool.reserveY),
    tokenX: input.pool.tokenX ?? findPoolToken(input.registry?.tokens, tokenXAddress),
    tokenXAddress,
    tokenY: input.pool.tokenY ?? findPoolToken(input.registry?.tokens, tokenYAddress),
    tokenYAddress
  };
}

function appendIndexerBlockers(indexer: SelectedPoolIndexerFlags | undefined, blockers: SelectedPoolReadinessMessage[]): void {
  if (indexer?.unavailable) {
    blockers.push({
      code: "missing-indexer",
      message: indexer.unavailableMessage ?? "Indexer endpoint is not configured"
    });
  }

  if (indexer?.error) {
    blockers.push({
      code: "indexer-error",
      message: indexer.errorMessage ?? "Indexer data is unavailable"
    });
  }

  if (indexer?.stale) {
    blockers.push({
      code: "stale-indexer",
      message: indexer.staleMessage ?? "Indexer pool data is stale"
    });
  }

  if (indexer?.partial) {
    blockers.push({
      code: "partial-indexer",
      message: indexer.partialMessage ?? "Indexer returned partial pool data"
    });
  }

  if (indexer?.empty) {
    blockers.push({
      code: "empty-indexed-pools",
      message: indexer.emptyMessage ?? "No indexed pools are available yet"
    });
  }
}

function appendTokenMetadataReadiness(
  pool: NormalizedPoolFields,
  action: TokenAction | null,
  blockers: SelectedPoolReadinessMessage[],
  warnings: SelectedPoolReadinessMessage[]
): void {
  for (const token of [
    { address: pool.tokenXAddress, metadata: pool.tokenX, side: "x" as const },
    { address: pool.tokenYAddress, metadata: pool.tokenY, side: "y" as const }
  ]) {
    if (token.metadata !== null) continue;

    const message = `Token ${token.side.toUpperCase()} metadata is missing`;
    const readinessMessage: SelectedPoolReadinessMessage = {
      action: action ?? undefined,
      address: token.address ?? undefined,
      code: "missing-token-metadata",
      message: token.address === null ? message : `${message} for ${token.address}`,
      side: token.side
    };

    if (action === null) {
      warnings.push(readinessMessage);
    } else {
      blockers.push(readinessMessage);
    }
  }
}

function appendRequiredFieldBlockers(
  pool: NormalizedPoolFields,
  action: TokenAction | null,
  blockers: SelectedPoolReadinessMessage[]
): void {
  if (action === null) return;

  const requiredFields: Array<keyof NormalizedPoolFields> =
    action === "swap"
      ? ["pair", "tokenXAddress", "tokenYAddress", "binStep"]
      : action === "remove-liquidity"
        ? ["pair", "tokenXAddress", "tokenYAddress", "binStep"]
        : ["pair", "tokenXAddress", "tokenYAddress", "binStep", "activeId"];

  for (const field of requiredFields) {
    if (pool[field] !== null) continue;

    blockers.push({
      action,
      code: "missing-pool-field",
      message: `Selected pool is missing ${formatPoolField(field)}`
    });
  }
}

function appendLiquidityBlockers(
  pool: NormalizedPoolFields,
  action: TokenAction | null,
  blockers: SelectedPoolReadinessMessage[]
): void {
  if (action !== "swap") return;
  if (pool.reserveX === null || pool.reserveY === null) return;
  if (pool.reserveX > 0n || pool.reserveY > 0n) return;

  blockers.push({
    action,
    code: "empty-pool",
    message: "Selected pool has no swap liquidity yet"
  });
}

function appendUnsupportedActionBlockers(
  pool: NormalizedPoolFields,
  action: TokenAction | null,
  blockers: SelectedPoolReadinessMessage[]
): void {
  if (action === null) return;

  for (const token of [
    { address: pool.tokenXAddress, metadata: pool.tokenX, side: "x" as const },
    { address: pool.tokenYAddress, metadata: pool.tokenY, side: "y" as const }
  ]) {
    if (token.metadata === null || tokenAllowsAction(token.metadata, action)) continue;

    blockers.push({
      action,
      address: token.address ?? token.metadata.address,
      code: "unsupported-token-action",
      message: `${token.metadata.symbol} does not support ${action}`,
      side: token.side
    });
  }
}

function finishDescriptor(
  pool: NormalizedPoolFields,
  source: SelectedPoolSource,
  blockers: SelectedPoolReadinessMessage[],
  warnings: SelectedPoolReadinessMessage[]
): SelectedPoolDescriptor {
  const blocked = blockers.length > 0;

  return {
    ...pool,
    blocked,
    blockers,
    ready: !blocked,
    source,
    warnings
  };
}

function findPoolToken(tokens: TokenMetadataMap | undefined, address: Address | string | null): TokenMetadata | null {
  if (tokens === undefined || address === null) return null;
  return findTokenMetadata(tokens, address);
}

function normalizeAddress(
  value: Address | string | null | undefined,
  field: "pair" | "tokenXAddress" | "tokenYAddress",
  blockers: SelectedPoolReadinessMessage[]
): Address | null {
  if (value === null || value === undefined || value.length === 0) return null;

  try {
    return getAddress(value);
  } catch {
    blockers.push({
      address: value,
      code: "invalid-pool-address",
      message: `Selected pool ${field} is not a valid address`
    });
    return null;
  }
}

function normalizeNumber(
  value: number | string | null | undefined,
  field: "activeId" | "binStep",
  blockers: SelectedPoolReadinessMessage[]
): number | null {
  if (value === null || value === undefined || value === "") return null;

  const numeric = typeof value === "number" ? value : Number(value);
  const min = field === "binStep" ? 1 : 0;
  const max = field === "binStep" ? 65_535 : 16_777_215;

  if (Number.isSafeInteger(numeric) && numeric >= min && numeric <= max) {
    return numeric;
  }

  blockers.push({
    code: "invalid-pool-number",
    message: `Selected pool ${field} is not a valid integer`
  });
  return null;
}

function normalizeReserve(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === "") return null;

  try {
    const reserve = BigInt(value);
    return reserve >= 0n ? reserve : null;
  } catch {
    return null;
  }
}

function formatPoolField(field: keyof NormalizedPoolFields): string {
  switch (field) {
    case "activeId":
      return "active bin";
    case "binStep":
      return "bin step";
    case "pair":
      return "pair address";
    case "reserveX":
      return "token X reserve";
    case "reserveY":
      return "token Y reserve";
    case "tokenXAddress":
      return "token X address";
    case "tokenYAddress":
      return "token Y address";
    case "tokenX":
      return "token X metadata";
    case "tokenY":
      return "token Y metadata";
  }
}
