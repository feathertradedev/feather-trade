export const POSITION_BURN_BPS_DENOMINATOR = 10_000n;
export const POSITION_BURN_UINT24_MAX = 16_777_215n;

export type PositionBurnIntegerInput = bigint | number | string;

export interface PositionBurnSelectedPosition {
  id: string;
  binId: PositionBurnIntegerInput;
  liquidity?: PositionBurnIntegerInput | null;
}

export interface PositionBurnLiveBalanceStatus {
  balance?: PositionBurnIntegerInput | null;
  error?: boolean | Error | string | null;
  isError?: boolean;
  isLoading?: boolean;
  loading?: boolean;
}

export interface PositionBurnLiveBalanceRow extends PositionBurnLiveBalanceStatus {
  binId: PositionBurnIntegerInput;
}

export type PositionBurnLiveBalanceValue =
  | PositionBurnIntegerInput
  | null
  | undefined
  | PositionBurnLiveBalanceStatus;

export type PositionBurnLiveBalancesByBin =
  | Readonly<Record<string, PositionBurnLiveBalanceValue>>
  | ReadonlyMap<PositionBurnIntegerInput, PositionBurnLiveBalanceValue>
  | readonly PositionBurnLiveBalanceRow[];

export interface PositionBurnFreshnessFlags {
  indexerStale?: boolean;
  liveReadError?: boolean;
  liveReadLoading?: boolean;
  positionDataCapped?: boolean;
  positionDataPartial?: boolean;
}

export interface PositionBurnPlanInput {
  burnBps: PositionBurnIntegerInput | null | undefined;
  freshness?: PositionBurnFreshnessFlags;
  liveBalancesByBin: PositionBurnLiveBalancesByBin;
  selectedPositions: readonly PositionBurnSelectedPosition[];
}

export type PositionBurnBlockerCode =
  | "bin-id-out-of-range"
  | "duplicate-bin-id"
  | "invalid-bin-id"
  | "invalid-burn-bps"
  | "invalid-live-balance"
  | "live-balance-missing"
  | "live-balance-zero"
  | "live-read-error"
  | "live-read-loading"
  | "no-selected-positions"
  | "position-data-capped"
  | "position-data-partial"
  | "requested-burn-exceeds-live-balance"
  | "stale-indexer"
  | "zero-burn-amount";

export interface PositionBurnBlocker {
  binId?: string;
  code: PositionBurnBlockerCode;
  message: string;
  positionId?: string;
}

export interface PositionBurnPlanItem {
  amount: bigint;
  binId: bigint;
  liveBalance: bigint;
  positionId: string;
}

export interface PositionBurnPlanResult {
  amounts: bigint[];
  blocked: boolean;
  blockers: PositionBurnBlocker[];
  ids: bigint[];
  items: PositionBurnPlanItem[];
  warnings: string[];
}

interface ParsedPosition {
  binId: bigint;
  indexedLiquidity: bigint | null;
  original: PositionBurnSelectedPosition;
}

interface NormalizedLiveBalance {
  balance: PositionBurnIntegerInput | null | undefined;
  error: boolean;
  loading: boolean;
}

export function buildPositionBurnPlan(input: PositionBurnPlanInput): PositionBurnPlanResult {
  const blockers: PositionBurnBlocker[] = [];
  const warnings: string[] = [];
  const burnBps = parseNonNegativeInteger(input.burnBps);
  const liveBalancesByBin = normalizeLiveBalances(input.liveBalancesByBin);
  const positions = parsePositions(input.selectedPositions, blockers);

  if (input.selectedPositions.length === 0) {
    blockers.push({
      code: "no-selected-positions",
      message: "No selected positions"
    });
  }

  if (burnBps === null || burnBps === 0n) {
    blockers.push({
      code: "invalid-burn-bps",
      message: "Burn BPS must be a positive integer"
    });
  }

  appendFreshnessBlockers(input.freshness, blockers);

  const items: PositionBurnPlanItem[] = [];
  const sortedPositions = [...positions].sort(compareParsedPositions);

  for (const position of sortedPositions) {
    const binKey = position.binId.toString();
    const liveEntry = liveBalancesByBin.get(binKey);

    if (liveEntry?.loading) {
      blockers.push({
        binId: binKey,
        code: "live-read-loading",
        message: `Live LB balance read is loading for bin ${binKey}`,
        positionId: position.original.id
      });
      continue;
    }

    if (liveEntry?.error) {
      blockers.push({
        binId: binKey,
        code: "live-read-error",
        message: `Live LB balance read failed for bin ${binKey}`,
        positionId: position.original.id
      });
      continue;
    }

    if (!liveEntry || liveEntry.balance === null || liveEntry.balance === undefined) {
      blockers.push({
        binId: binKey,
        code: "live-balance-missing",
        message: `Live LB balance is missing for bin ${binKey}`,
        positionId: position.original.id
      });
      continue;
    }

    const liveBalance = parseNonNegativeInteger(liveEntry.balance);
    if (liveBalance === null) {
      blockers.push({
        binId: binKey,
        code: "invalid-live-balance",
        message: `Live LB balance is invalid for bin ${binKey}`,
        positionId: position.original.id
      });
      continue;
    }

    if (liveBalance === 0n) {
      blockers.push({
        binId: binKey,
        code: "live-balance-zero",
        message: `Live LB balance is zero for bin ${binKey}`,
        positionId: position.original.id
      });
      continue;
    }

    if (position.indexedLiquidity !== null && liveBalance < position.indexedLiquidity) {
      warnings.push(`Live LB balance is below indexed liquidity for bin ${binKey}`);
    }

    if (burnBps === null || burnBps === 0n) {
      continue;
    }

    const amount = (liveBalance * burnBps) / POSITION_BURN_BPS_DENOMINATOR;
    if (burnBps > POSITION_BURN_BPS_DENOMINATOR || amount > liveBalance) {
      blockers.push({
        binId: binKey,
        code: "requested-burn-exceeds-live-balance",
        message: `Requested burn exceeds live LB balance for bin ${binKey}`,
        positionId: position.original.id
      });
      continue;
    }

    if (amount === 0n) {
      blockers.push({
        binId: binKey,
        code: "zero-burn-amount",
        message: `Burn amount rounds to zero for bin ${binKey}`,
        positionId: position.original.id
      });
      continue;
    }

    items.push({
      amount,
      binId: position.binId,
      liveBalance,
      positionId: position.original.id
    });
  }

  if (blockers.length > 0) {
    return {
      amounts: [],
      blocked: true,
      blockers,
      ids: [],
      items: [],
      warnings
    };
  }

  return {
    amounts: items.map((item) => item.amount),
    blocked: false,
    blockers,
    ids: items.map((item) => item.binId),
    items,
    warnings
  };
}

function appendFreshnessBlockers(freshness: PositionBurnFreshnessFlags | undefined, blockers: PositionBurnBlocker[]): void {
  if (!freshness) return;

  if (freshness.positionDataPartial) {
    blockers.push({
      code: "position-data-partial",
      message: "Position data is partial"
    });
  }

  if (freshness.positionDataCapped) {
    blockers.push({
      code: "position-data-capped",
      message: "Position data is capped"
    });
  }

  if (freshness.indexerStale) {
    blockers.push({
      code: "stale-indexer",
      message: "Indexer is stale"
    });
  }

  if (freshness.liveReadLoading) {
    blockers.push({
      code: "live-read-loading",
      message: "Live LB balance read is loading"
    });
  }

  if (freshness.liveReadError) {
    blockers.push({
      code: "live-read-error",
      message: "Live LB balance read failed"
    });
  }
}

function parsePositions(selectedPositions: readonly PositionBurnSelectedPosition[], blockers: PositionBurnBlocker[]): ParsedPosition[] {
  const parsed: ParsedPosition[] = [];
  const seenBinIds = new Set<string>();

  for (const position of selectedPositions) {
    const binId = parseNonNegativeInteger(position.binId);
    if (binId === null) {
      blockers.push({
        code: "invalid-bin-id",
        message: `Position bin id is invalid for position ${position.id}`,
        positionId: position.id
      });
      continue;
    }

    const binKey = binId.toString();
    if (binId > POSITION_BURN_UINT24_MAX) {
      blockers.push({
        binId: binKey,
        code: "bin-id-out-of-range",
        message: `Position bin id ${binKey} exceeds uint24 max ${POSITION_BURN_UINT24_MAX.toString()}`,
        positionId: position.id
      });
      continue;
    }

    if (seenBinIds.has(binKey)) {
      blockers.push({
        binId: binKey,
        code: "duplicate-bin-id",
        message: `Duplicate selected bin id ${binKey}`,
        positionId: position.id
      });
      continue;
    }

    seenBinIds.add(binKey);

    const indexedLiquidity = position.liquidity === null || position.liquidity === undefined ? null : parseNonNegativeInteger(position.liquidity);

    parsed.push({
      binId,
      indexedLiquidity,
      original: position
    });
  }

  return parsed;
}

function normalizeLiveBalances(source: PositionBurnLiveBalancesByBin): Map<string, NormalizedLiveBalance> {
  const balances = new Map<string, NormalizedLiveBalance>();

  if (Array.isArray(source)) {
    for (const row of source) {
      const binId = parseNonNegativeInteger(row.binId);
      if (binId !== null) {
        balances.set(binId.toString(), liveBalanceEntry(row));
      }
    }

    return balances;
  }

  if (source instanceof Map) {
    for (const [binIdInput, value] of source) {
      const binId = parseNonNegativeInteger(binIdInput);
      if (binId !== null) {
        balances.set(binId.toString(), liveBalanceEntry(value));
      }
    }

    return balances;
  }

  for (const [binIdInput, value] of Object.entries(source)) {
    const binId = parseNonNegativeInteger(binIdInput);
    if (binId !== null) {
      balances.set(binId.toString(), liveBalanceEntry(value));
    }
  }

  return balances;
}

function liveBalanceEntry(value: PositionBurnLiveBalanceRow | PositionBurnLiveBalanceValue): NormalizedLiveBalance {
  if (isLiveBalanceObject(value)) {
    return {
      balance: value.balance,
      error: Boolean(value.error) || value.isError === true,
      loading: value.loading === true || value.isLoading === true
    };
  }

  return {
    balance: value,
    error: false,
    loading: false
  };
}

function isLiveBalanceObject(value: PositionBurnLiveBalanceRow | PositionBurnLiveBalanceValue): value is PositionBurnLiveBalanceStatus {
  return typeof value === "object" && value !== null;
}

function compareParsedPositions(left: ParsedPosition, right: ParsedPosition): number {
  if (left.binId < right.binId) return -1;
  if (left.binId > right.binId) return 1;
  return left.original.id.localeCompare(right.original.id);
}

function parseNonNegativeInteger(value: PositionBurnIntegerInput | null | undefined): bigint | null {
  const parsed = parseInteger(value);

  return parsed !== null && parsed >= 0n ? parsed : null;
}

function parseInteger(value: PositionBurnIntegerInput | null | undefined): bigint | null {
  if (typeof value === "bigint") return value;

  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }

  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;

  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}
