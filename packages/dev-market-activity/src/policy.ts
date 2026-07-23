export type TradeDirection = "weth-to-usdc" | "usdc-to-weth";
export type RandomSource = () => number;

const UINT32_MAX = 0xffff_ffff;
const RANDOM_DENOMINATOR = 0x1_0000_0000;

export interface RangePolicy {
  anchor: number;
  hardRadius: number;
  turnaroundRadius: number;
}

export interface AdaptiveAmountState {
  amount: bigint;
  baseAmount: bigint;
  cap: bigint;
  unchangedTrades: number;
}

export function createSeededRandom(seed: number): RandomSource {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > UINT32_MAX) {
    throw new Error("Random seed must be an unsigned 32-bit integer");
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / RANDOM_DENOMINATOR;
  };
}

export function assertRangePolicy(policy: RangePolicy): void {
  if (!Number.isSafeInteger(policy.anchor) || policy.anchor < 0) throw new Error("Anchor active ID is invalid");
  if (!Number.isSafeInteger(policy.hardRadius) || policy.hardRadius <= 0) throw new Error("Hard radius must be positive");
  if (!Number.isSafeInteger(policy.turnaroundRadius) || policy.turnaroundRadius <= 0 || policy.turnaroundRadius >= policy.hardRadius) {
    throw new Error("Turnaround radius must be positive and smaller than the hard radius");
  }
}

export function chooseDirection(
  activeId: number,
  preferred: TradeDirection,
  policy: RangePolicy
): TradeDirection {
  assertRangePolicy(policy);
  if (!Number.isSafeInteger(activeId) || activeId < 0) throw new Error("Observed active ID is invalid");
  if (activeId >= policy.anchor + policy.turnaroundRadius) return "weth-to-usdc";
  if (activeId <= policy.anchor - policy.turnaroundRadius) return "usdc-to-weth";
  return preferred;
}

export function chooseOrganicDirection(
  activeId: number,
  lastDirection: TradeDirection,
  policy: RangePolicy,
  roll: number
): TradeDirection {
  assertRangePolicy(policy);
  assertActiveId(activeId);
  assertRoll(roll);
  if (lastDirection !== "weth-to-usdc" && lastDirection !== "usdc-to-weth") {
    throw new Error("Last trade direction is invalid");
  }
  if (activeId >= policy.anchor + policy.turnaroundRadius) return "weth-to-usdc";
  if (activeId <= policy.anchor - policy.turnaroundRadius) return "usdc-to-weth";

  const normalizedDistance = (activeId - policy.anchor) / policy.turnaroundRadius;
  const meanReversionBias = normalizedDistance * 0.36;
  const persistenceBias = lastDirection === "weth-to-usdc" ? 0.14 : -0.14;
  const wethToUsdcProbability = clamp(0.5 + meanReversionBias + persistenceBias, 0.08, 0.92);
  return roll < wethToUsdcProbability ? "weth-to-usdc" : "usdc-to-weth";
}

export function sampleTradeAmount(
  target: bigint,
  cap: bigint,
  remainingBudget: bigint,
  rollA: number,
  rollB: number
): bigint {
  if (target <= 0n || cap <= 0n || remainingBudget <= 0n) {
    throw new Error("Trade amount target, cap, and remaining budget must be positive");
  }
  assertRoll(rollA);
  assertRoll(rollB);
  const upperBound = minimum(target, minimum(cap, remainingBudget));
  const triangularRoll = (rollA + rollB) / 2;
  const scale = 1_000_000;
  const factor = 550_000 + Math.floor(triangularRoll * 450_000);
  const sampled = (upperBound * BigInt(factor)) / BigInt(scale);
  return maximum(1n, minimum(upperBound, sampled));
}

export function jitterIntervalMs(base: number, rollA: number, rollB: number): number {
  if (!Number.isSafeInteger(base) || base <= 0) throw new Error("Base interval must be a positive integer");
  assertRoll(rollA);
  assertRoll(rollB);
  const triangularRoll = (rollA + rollB) / 2;
  const jittered = Math.round(base * (0.5 + triangularRoll));
  if (!Number.isSafeInteger(jittered) || jittered <= 0) throw new Error("Jittered interval is outside the safe integer range");
  return jittered;
}

export function chooseGuardedDirection(
  activeId: number,
  preferred: TradeDirection,
  policy: RangePolicy,
  maximumObservedMovement: Readonly<Record<TradeDirection, number>>
): TradeDirection {
  const candidate = chooseDirection(activeId, preferred, policy);
  const observed = maximumObservedMovement[candidate];
  if (!Number.isSafeInteger(observed) || observed < 0) throw new Error("Observed direction movement is invalid");
  const safetyMargin = observed + 1;
  if (candidate === "weth-to-usdc" && activeId - (policy.anchor - policy.hardRadius) <= safetyMargin) return "usdc-to-weth";
  if (candidate === "usdc-to-weth" && policy.anchor + policy.hardRadius - activeId <= safetyMargin) return "weth-to-usdc";
  return candidate;
}

export function safeDirectionCandidates(
  activeId: number,
  preferred: TradeDirection,
  policy: RangePolicy,
  maximumObservedMovement: Readonly<Record<TradeDirection, number>>
): TradeDirection[] {
  const primary = chooseGuardedDirection(activeId, preferred, policy, maximumObservedMovement);
  const oppositePreferred = primary === "weth-to-usdc" ? "usdc-to-weth" : "weth-to-usdc";
  const secondary = chooseGuardedDirection(activeId, oppositePreferred, policy, maximumObservedMovement);
  return secondary === primary ? [primary] : [primary, secondary];
}

export function assertWithinHardRange(activeId: number, policy: RangePolicy): void {
  assertRangePolicy(policy);
  if (activeId < policy.anchor - policy.hardRadius || activeId > policy.anchor + policy.hardRadius) {
    throw new Error(`Active ID ${activeId} left hard range ${policy.anchor - policy.hardRadius}..${policy.anchor + policy.hardRadius}`);
  }
}

export function adaptAmount(state: AdaptiveAmountState, binsMoved: number): AdaptiveAmountState {
  if (!Number.isSafeInteger(binsMoved) || binsMoved < 0) throw new Error("Bin movement must be a non-negative integer");
  if (state.baseAmount <= 0n || state.amount <= 0n || state.cap < state.baseAmount || state.amount > state.cap) {
    throw new Error("Adaptive amount state is invalid");
  }
  if (binsMoved > 1) {
    return {
      ...state,
      amount: maximum(state.baseAmount, (state.amount * 2n) / 3n),
      unchangedTrades: 0
    };
  }
  if (binsMoved === 1) {
    return {
      ...state,
      amount: maximum(state.baseAmount, (state.amount * 95n) / 100n),
      unchangedTrades: 0
    };
  }
  const unchangedTrades = state.unchangedTrades + 1;
  return {
    ...state,
    amount: unchangedTrades >= 2 ? minimum(state.cap, (state.amount * 5n) / 4n) : state.amount,
    unchangedTrades
  };
}

export function assertNonMainnetEnvironment(environment: string): asserts environment is "localnet" | "testnet" | "robinhoodTestnet" | "sepolia" {
  if (environment === "mainnet" || environment === "robinhood") {
    throw new Error("Development market activity rejects mainnet unconditionally");
  }
  if (
    environment !== "localnet" &&
    environment !== "testnet" &&
    environment !== "robinhoodTestnet" &&
    environment !== "sepolia"
  ) {
    throw new Error(`Unsupported market activity environment ${environment}`);
  }
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function assertActiveId(activeId: number): void {
  if (!Number.isSafeInteger(activeId) || activeId < 0) throw new Error("Observed active ID is invalid");
}

function assertRoll(roll: number): void {
  if (!Number.isFinite(roll) || roll < 0 || roll > 1) throw new Error("Random roll must be between zero and one");
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}
