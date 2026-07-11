export const QUOTE_STALE_MS = 15_000;
export const DANGEROUS_SLIPPAGE_BPS = 1_000n;
export const BLOCKING_PRICE_IMPACT_BPS = 1_500n;
export const MIN_DEADLINE_MINUTES = 1;
export const MAX_DEADLINE_MINUTES = 120;
export const MAX_SAFE_ID_SLIPPAGE = 2;

export type SafetyIntent = "approval" | "swap" | "liquidity";
export type SimulationState = "idle" | "loading" | "success" | "failed" | "unsupported";

export interface TransactionSafetyInput {
  connected: boolean;
  deadlineMinutes: number | null;
  indexerState?: "ready" | "partial" | "stale" | "empty" | "unavailable" | "error" | "loading";
  intent: SafetyIntent;
  liveBalanceMismatch?: boolean;
  needsApproval?: boolean;
  onWrongChain: boolean;
  partialPositions?: boolean;
  priceImpactBps?: bigint | null;
  quoteUpdatedAt?: number | null;
  rpcReady?: boolean;
  simulationError?: string | null;
  simulationState?: SimulationState;
  slippageBps?: bigint | null;
  unsupportedMode?: boolean;
}

export interface ApprovalDisclosureInput {
  amount: bigint | null;
  spender: string | null;
  tokenSymbol: string;
}

export interface TransactionSafetyResult {
  blocked: boolean;
  reason: string | null;
  warnings: string[];
}

export interface SwapExecutionContext {
  activeId: number | null;
  amountIn: string | null;
  binStep: number | null;
  deadlineMinutes: number | null;
  environment: string;
  pair: string | null;
  poolId: string | null;
  registryChainId: number;
  reserveX: string | null;
  reserveY: string | null;
  rpcChainId: number | null;
  slippageBps: string | null;
  tokenIn: string | null;
  tokenOut: string | null;
  updatedAtBlock: string | null;
  walletAddress: string | null;
  walletChainId: number;
}

export interface BurnExecutionContext {
  account: string | null;
  binStep: number | null;
  burnBps: string | null;
  deadlineMinutes: number | null;
  environment: string;
  mode: "remove";
  pair: string | null;
  registryChainId: number;
  router: string;
  selectedPositionsKey: string;
  slippageBps: string | null;
  tokenX: string | null;
  tokenY: string | null;
  walletChainId: number;
}

export interface BurnQuoteExecutionBinding {
  balances: ReadonlyArray<{ balance: string; binId: string }>;
  binStates: ReadonlyArray<{ binId: string; reserveX: string; reserveY: string; totalSupply: string }>;
  burnAmounts: ReadonlyArray<{ amount: string; binId: string; liveBalance: string }>;
  expectedAmountXOut: string;
  expectedAmountYOut: string;
  minimumAmountXOut: string;
  minimumAmountYOut: string;
}

export function evaluateTransactionSafety(input: TransactionSafetyInput, now = Date.now()): TransactionSafetyResult {
  const warnings: string[] = [];

  if (!input.connected) return block("Connect wallet", warnings);
  if (input.onWrongChain) return block("Switch network", warnings);
  if (input.rpcReady === false) return block("RPC chain identity is unavailable or mismatched", warnings);
  if (input.unsupportedMode) return block("Unsupported transaction path", warnings);
  if (input.deadlineMinutes === null) return block("Deadline is invalid or expired", warnings);
  if (input.indexerState === "stale") return block("Indexer is stale", warnings);
  if (input.partialPositions) return block("Position list is partial", warnings);
  if (input.liveBalanceMismatch) return block("Live balance does not match indexed position", warnings);
  if (input.slippageBps !== undefined && input.slippageBps !== null && input.slippageBps > DANGEROUS_SLIPPAGE_BPS) {
    return block("Slippage exceeds safety limit", warnings);
  }
  if (input.priceImpactBps !== undefined && input.priceImpactBps !== null && input.priceImpactBps >= BLOCKING_PRICE_IMPACT_BPS) {
    return block("Price impact exceeds safety limit", warnings);
  }
  if (input.intent === "swap" && quoteIsStale(input.quoteUpdatedAt ?? null, now)) {
    return block("Quote is stale", warnings);
  }
  if (input.simulationState === "failed") {
    return block(input.simulationError ?? "Simulation failed", warnings);
  }
  if (input.simulationState === "loading") {
    return block("Simulation pending", warnings);
  }
  if (input.simulationState === "unsupported") {
    return block("Simulation unsupported", warnings);
  }
  if (input.needsApproval) {
    warnings.push("Approval is required before submission");
  }

  return { blocked: false, reason: null, warnings };
}

export function quoteIsStale(updatedAt: number | null, now = Date.now()): boolean {
  return updatedAt === null || now - updatedAt > QUOTE_STALE_MS;
}

export function approvalDisclosure(input: ApprovalDisclosureInput): string {
  const amount = input.amount === null ? "unknown amount" : input.amount.toString();
  const spender = input.spender ?? "unknown spender";

  return `Approve ${amount} ${input.tokenSymbol} to ${spender}`;
}

export function parseDeadlineMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= MIN_DEADLINE_MINUTES && parsed <= MAX_DEADLINE_MINUTES
    ? parsed
    : null;
}

export function parseIdSlippage(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_SAFE_ID_SLIPPAGE ? parsed : null;
}

export function idSlippageInputError(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed) && parsed > MAX_SAFE_ID_SLIPPAGE) {
      return "ID slippage above 2 bins requires release-owner approval";
    }
  }

  return parseIdSlippage(value) === null ? "Enter an id slippage from 0 to 2 bins" : null;
}

export function swapExecutionContextFingerprint(context: SwapExecutionContext): string {
  return JSON.stringify([
    context.environment,
    context.registryChainId,
    context.rpcChainId,
    context.walletChainId,
    normalizeContextAddress(context.walletAddress),
    context.poolId,
    normalizeContextAddress(context.pair),
    context.binStep,
    context.activeId,
    context.reserveX,
    context.reserveY,
    context.updatedAtBlock,
    normalizeContextAddress(context.tokenIn),
    normalizeContextAddress(context.tokenOut),
    context.amountIn,
    context.slippageBps,
    context.deadlineMinutes
  ]);
}

export function burnExecutionContextFingerprint(context: BurnExecutionContext): string {
  return JSON.stringify([
    context.mode,
    context.environment,
    context.registryChainId,
    context.walletChainId,
    normalizeContextAddress(context.account),
    normalizeContextAddress(context.pair),
    normalizeContextAddress(context.tokenX),
    normalizeContextAddress(context.tokenY),
    context.binStep,
    context.selectedPositionsKey,
    context.burnBps,
    context.slippageBps,
    context.deadlineMinutes,
    normalizeContextAddress(context.router)
  ]);
}

export function burnQuoteExecutionFingerprint(binding: BurnQuoteExecutionBinding): string {
  return JSON.stringify([
    sortedBurnRows(binding.balances, (row) => [row.binId, row.balance]),
    sortedBurnRows(binding.binStates, (row) => [row.binId, row.reserveX, row.reserveY, row.totalSupply]),
    sortedBurnRows(binding.burnAmounts, (row) => [row.binId, row.amount, row.liveBalance]),
    binding.expectedAmountXOut,
    binding.expectedAmountYOut,
    binding.minimumAmountXOut,
    binding.minimumAmountYOut
  ]);
}

function sortedBurnRows<T extends { binId: string }>(rows: ReadonlyArray<T>, serialize: (row: T) => string[]): string[][] {
  return [...rows]
    .sort((left, right) => BigInt(left.binId) < BigInt(right.binId) ? -1 : BigInt(left.binId) > BigInt(right.binId) ? 1 : 0)
    .map(serialize);
}

function normalizeContextAddress(value: string | null): string | null {
  return value?.toLowerCase() ?? null;
}

function block(reason: string, warnings: string[]): TransactionSafetyResult {
  return { blocked: true, reason, warnings };
}
