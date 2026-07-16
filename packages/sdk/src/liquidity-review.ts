export const LB_FEE_PRECISION = 1_000_000_000_000_000_000n;
export const LB_BASIS_POINT_MAX = 10_000n;
export const LB_Q128 = 1n << 128n;
export const LB_MAX_FEE = 100_000_000_000_000_000n;
export const LB_MAX_LIQUIDITY_PER_BIN =
  65_251_743_116_719_673_010_965_625_540_244_653_191_619_923_014_385_985_379_600_384_103_134_737n;

const MAX_UINT24 = (1n << 24n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

export interface AddLiquiditySimulationResult {
  amountXAdded: bigint;
  amountYAdded: bigint;
  amountXLeft: bigint;
  amountYLeft: bigint;
  depositIds: bigint[];
  liquidityMinted: bigint[];
}

export interface StaticFeeParameters {
  baseFactor: bigint;
  filterPeriod: bigint;
  decayPeriod: bigint;
  reductionFactor: bigint;
  variableFeeControl: bigint;
  protocolShare: bigint;
  maxVolatilityAccumulator: bigint;
}

export interface VariableFeeParameters {
  volatilityAccumulator: bigint;
  volatilityReference: bigint;
  idReference: bigint;
  timeOfLastUpdate: bigint;
}

export interface CurrentFeeRateInput {
  activeId: bigint;
  binStep: bigint;
  blockTimestamp: bigint;
  staticFees: StaticFeeParameters;
  variableFees: VariableFeeParameters;
}

export interface CurrentFeeRates {
  baseFeeRate: bigint;
  variableFeeRate: bigint;
  totalFeeRate: bigint;
  protocolFeeRate: bigint;
  lpNetFeeRate: bigint;
  protocolShare: bigint;
}

export interface LiquidityReviewBinState {
  binId: bigint;
  priceQ128: bigint;
  reserveX: bigint;
  reserveY: bigint;
  totalSupply: bigint;
}

export interface AddLiquidityReviewInput {
  activeId: bigint;
  /** Actual amount received by the pair, derived from simulation added + left. */
  amountXReceived: bigint;
  /** Actual amount received by the pair, derived from simulation added + left. */
  amountYReceived: bigint;
  binStep: bigint;
  blockTimestamp: bigint;
  deltaIds: readonly bigint[];
  distributionX: readonly bigint[];
  distributionY: readonly bigint[];
  bins: readonly LiquidityReviewBinState[];
  staticFees: StaticFeeParameters;
  variableFees: VariableFeeParameters;
}

export interface LiquidityReviewBinQuote extends LiquidityReviewBinState {
  compositionFeeX: bigint;
  compositionFeeY: bigint;
  depositedX: bigint;
  depositedY: bigint;
  effectiveAmountX: bigint;
  effectiveAmountY: bigint;
  mintedShares: bigint;
  protocolFeeX: bigint;
  protocolFeeY: bigint;
  requestedAmountX: bigint;
  requestedAmountY: bigint;
  totalFeeRate: bigint;
}

export interface AddLiquidityMathQuote {
  amountXAdded: bigint;
  amountYAdded: bigint;
  amountXLeft: bigint;
  amountYLeft: bigint;
  compositionFeeX: bigint;
  compositionFeeY: bigint;
  protocolFeeX: bigint;
  protocolFeeY: bigint;
  bins: LiquidityReviewBinQuote[];
}

export type AddLiquidityPinnedStateInput = Omit<
  AddLiquidityReviewInput,
  "amountXReceived" | "amountYReceived"
>;

export function normalizeAddLiquiditySimulationResult(
  result: readonly [bigint, bigint, bigint, bigint, readonly bigint[], readonly bigint[]]
): AddLiquiditySimulationResult {
  const [amountXAdded, amountYAdded, amountXLeft, amountYLeft, depositIds, liquidityMinted] = result;
  for (const [label, value] of [
    ["amountXAdded", amountXAdded],
    ["amountYAdded", amountYAdded],
    ["amountXLeft", amountXLeft],
    ["amountYLeft", amountYLeft]
  ] as const) {
    assertUint(value, MAX_UINT256, label);
  }
  if (depositIds.length === 0 || depositIds.length !== liquidityMinted.length) {
    throw new Error("Simulated deposit ids and minted shares must be non-empty and have matching lengths");
  }
  depositIds.forEach((id) => assertUint(id, MAX_UINT24, "simulated deposit id"));
  liquidityMinted.forEach((shares) => assertUint(shares, MAX_UINT256, "simulated minted shares"));
  return {
    amountXAdded,
    amountYAdded,
    amountXLeft,
    amountYLeft,
    depositIds: [...depositIds],
    liquidityMinted: [...liquidityMinted]
  };
}

/**
 * Uses the router's successful pinned simulation to recover what the pair
 * actually received. This remains correct for ERC-20 transfer-tax behavior;
 * using the calldata maximums here would overstate deposits and fee estimates.
 */
export function quoteAddLiquidityMathFromSimulation(
  input: AddLiquidityPinnedStateInput,
  simulationResult: readonly [bigint, bigint, bigint, bigint, readonly bigint[], readonly bigint[]]
): AddLiquidityMathQuote {
  const simulation = normalizeAddLiquiditySimulationResult(simulationResult);
  const amountXReceived = checkedAdd(simulation.amountXAdded, simulation.amountXLeft, MAX_UINT128, "simulated X received");
  const amountYReceived = checkedAdd(simulation.amountYAdded, simulation.amountYLeft, MAX_UINT128, "simulated Y received");
  const quote = quoteAddLiquidityMath({ ...input, amountXReceived, amountYReceived });
  assertLiquidityReviewMatchesSimulation(quote, simulation);
  return quote;
}

/** Fails closed if the independent rounding model diverges from eth_call. */
export function assertLiquidityReviewMatchesSimulation(
  quote: AddLiquidityMathQuote,
  simulation: AddLiquiditySimulationResult
): void {
  assertEqual("amountXAdded", quote.amountXAdded, simulation.amountXAdded);
  assertEqual("amountYAdded", quote.amountYAdded, simulation.amountYAdded);
  assertEqual("amountXLeft", quote.amountXLeft, simulation.amountXLeft);
  assertEqual("amountYLeft", quote.amountYLeft, simulation.amountYLeft);
  if (quote.bins.length !== simulation.depositIds.length) {
    throw new Error("Liquidity review bin count does not match the pinned simulation");
  }
  quote.bins.forEach((bin, index) => {
    assertEqual(`depositIds[${index}]`, bin.binId, simulation.depositIds[index]!);
    assertEqual(`liquidityMinted[${index}]`, bin.mintedShares, simulation.liquidityMinted[index]!);
  });
}

/**
 * Mirrors LBPair._mintBins/BinHelper integer rounding for an already-pinned state.
 * Router `amount*Added` includes composition fees; fee fields below are estimates
 * that must be reconciled against canonical CompositionFees receipt logs.
 */
export function quoteAddLiquidityMath(input: AddLiquidityReviewInput): AddLiquidityMathQuote {
  assertUint(input.activeId, MAX_UINT24, "activeId");
  assertUint(input.amountXReceived, MAX_UINT128, "amountXReceived");
  assertUint(input.amountYReceived, MAX_UINT128, "amountYReceived");
  assertUint(input.binStep, 65_535n, "binStep");
  assertUint(input.blockTimestamp, (1n << 40n) - 1n, "blockTimestamp");
  if (input.deltaIds.length === 0 || input.deltaIds.length !== input.distributionX.length || input.deltaIds.length !== input.distributionY.length) {
    throw new Error("Liquidity review distributions must be non-empty and have matching lengths");
  }

  const totalDistributionX = input.distributionX.reduce((total, distribution) => total + distribution, 0n);
  const totalDistributionY = input.distributionY.reduce((total, distribution) => total + distribution, 0n);
  if (totalDistributionX > LB_FEE_PRECISION || totalDistributionY > LB_FEE_PRECISION) {
    throw new Error("Liquidity review distributions must not exceed distribution precision");
  }
  if (totalDistributionX === 0n && totalDistributionY === 0n) {
    throw new Error("Liquidity review requires a nonzero token distribution");
  }
  if ((totalDistributionX === 0n && input.amountXReceived !== 0n) || (totalDistributionY === 0n && input.amountYReceived !== 0n)) {
    throw new Error("Received token amounts must be zero when their distribution side is zero");
  }

  if (input.bins.length !== input.deltaIds.length) {
    throw new Error("Pinned liquidity review bin states must match the distribution length");
  }
  const binById = new Map<bigint, LiquidityReviewBinState>();
  for (const bin of input.bins) {
    if (binById.has(bin.binId)) throw new Error(`Duplicate pinned state for liquidity review bin ${bin.binId.toString()}`);
    binById.set(bin.binId, { ...bin });
  }
  const seen = new Set<bigint>();
  const quotes = input.deltaIds.map((deltaId, index) => {
    assertInt256(deltaId, "deltaId");
    const binId = input.activeId + deltaId;
    assertUint(binId, MAX_UINT24, "review bin id");
    if (seen.has(binId)) throw new Error(`Duplicate liquidity review bin ${binId.toString()}`);
    seen.add(binId);
    const bin = binById.get(binId);
    if (!bin) throw new Error(`Missing pinned state for liquidity review bin ${binId.toString()}`);
    assertBinState(bin);
    const distributionX = input.distributionX[index];
    const distributionY = input.distributionY[index];
    assertUint(distributionX, LB_FEE_PRECISION, "distributionX");
    assertUint(distributionY, LB_FEE_PRECISION, "distributionY");
    const requestedAmountX = input.amountXReceived * distributionX / LB_FEE_PRECISION;
    const requestedAmountY = input.amountYReceived * distributionY / LB_FEE_PRECISION;
    return quoteBin({
      bin,
      requestedAmountX,
      requestedAmountY,
      activeId: input.activeId,
      binStep: input.binStep,
      blockTimestamp: input.blockTimestamp,
      staticFees: input.staticFees,
      variableFees: input.variableFees
    });
  });

  const amountXAdded = sum(quotes, "effectiveAmountX");
  const amountYAdded = sum(quotes, "effectiveAmountY");
  if (amountXAdded > input.amountXReceived || amountYAdded > input.amountYReceived) {
    throw new Error("Quoted effective liquidity exceeds the submitted token amounts");
  }
  return {
    amountXAdded,
    amountYAdded,
    amountXLeft: input.amountXReceived - amountXAdded,
    amountYLeft: input.amountYReceived - amountYAdded,
    compositionFeeX: sum(quotes, "compositionFeeX"),
    compositionFeeY: sum(quotes, "compositionFeeY"),
    protocolFeeX: sum(quotes, "protocolFeeX"),
    protocolFeeY: sum(quotes, "protocolFeeY"),
    bins: quotes
  };
}

function quoteBin(input: {
  activeId: bigint;
  bin: LiquidityReviewBinState;
  binStep: bigint;
  blockTimestamp: bigint;
  requestedAmountX: bigint;
  requestedAmountY: bigint;
  staticFees: StaticFeeParameters;
  variableFees: VariableFeeParameters;
}): LiquidityReviewBinQuote {
  const { bin } = input;
  let effectiveAmountX = input.requestedAmountX;
  let effectiveAmountY = input.requestedAmountY;
  const userLiquidity = liquidity(effectiveAmountX, effectiveAmountY, bin.priceQ128);
  const binLiquidity = liquidity(bin.reserveX, bin.reserveY, bin.priceQ128);
  let mintedShares: bigint;
  if (userLiquidity === 0n) {
    mintedShares = 0n;
    effectiveAmountX = 0n;
    effectiveAmountY = 0n;
  } else if (binLiquidity === 0n || bin.totalSupply === 0n) {
    mintedShares = sqrt(userLiquidity);
  } else {
    mintedShares = userLiquidity * bin.totalSupply / binLiquidity;
    assertUint(mintedShares, MAX_UINT256, "initial minted shares");
    const effectiveLiquidity = divRoundUp(mintedShares * binLiquidity, bin.totalSupply);
    assertUint(effectiveLiquidity, MAX_UINT256, "effective liquidity");
    if (userLiquidity > effectiveLiquidity) {
      let deltaLiquidity = userLiquidity - effectiveLiquidity;
      if (deltaLiquidity >= LB_Q128) {
        const deltaY = min(deltaLiquidity >> 128n, effectiveAmountY);
        effectiveAmountY -= deltaY;
        deltaLiquidity -= deltaY << 128n;
      }
      if (deltaLiquidity >= bin.priceQ128) {
        const deltaX = min(deltaLiquidity / bin.priceQ128, effectiveAmountX);
        effectiveAmountX -= deltaX;
      }
    }
  }

  assertUint(mintedShares, MAX_UINT256, "minted shares");
  const reserveXAfterEffective = checkedAdd(bin.reserveX, effectiveAmountX, MAX_UINT128, "bin X reserve after effective deposit");
  const reserveYAfterEffective = checkedAdd(bin.reserveY, effectiveAmountY, MAX_UINT128, "bin Y reserve after effective deposit");
  if (liquidity(reserveXAfterEffective, reserveYAfterEffective, bin.priceQ128) > LB_MAX_LIQUIDITY_PER_BIN) {
    throw new Error(`Liquidity review bin ${bin.binId.toString()} exceeds the LB maximum liquidity`);
  }

  let compositionFeeX = 0n;
  let compositionFeeY = 0n;
  let protocolFeeX = 0n;
  let protocolFeeY = 0n;
  let totalFeeRate = 0n;
  if (bin.binId === input.activeId && mintedShares > 0n) {
    totalFeeRate = totalFee(input.staticFees, input.variableFees, input.activeId, input.binStep, input.blockTimestamp);
    const denominator = checkedAdd(bin.totalSupply, mintedShares, MAX_UINT256, "bin supply after mint");
    const receivedX = denominator === 0n ? 0n : mintedShares * reserveXAfterEffective / denominator;
    const receivedY = denominator === 0n ? 0n : mintedShares * reserveYAfterEffective / denominator;
    if (receivedX > effectiveAmountX) {
      compositionFeeY = compositionFee(effectiveAmountY - receivedY, totalFeeRate);
    } else if (receivedY > effectiveAmountY) {
      compositionFeeX = compositionFee(effectiveAmountX - receivedX, totalFeeRate);
    }
    protocolFeeX = compositionFeeX * input.staticFees.protocolShare / LB_BASIS_POINT_MAX;
    protocolFeeY = compositionFeeY * input.staticFees.protocolShare / LB_BASIS_POINT_MAX;
    if (compositionFeeX !== 0n || compositionFeeY !== 0n) {
      const feeAdjustedUserLiquidity = liquidity(
        effectiveAmountX - compositionFeeX,
        effectiveAmountY - compositionFeeY,
        bin.priceQ128
      );
      const feeAdjustedBinLiquidity = liquidity(
        checkedAdd(bin.reserveX, compositionFeeX - protocolFeeX, MAX_UINT128, "bin X reserve after composition fee"),
        checkedAdd(bin.reserveY, compositionFeeY - protocolFeeY, MAX_UINT128, "bin Y reserve after composition fee"),
        bin.priceQ128
      );
      if (feeAdjustedBinLiquidity === 0n) throw new Error("Composition fee share denominator is zero");
      mintedShares = feeAdjustedUserLiquidity * bin.totalSupply / feeAdjustedBinLiquidity;
      assertUint(mintedShares, MAX_UINT256, "composition-adjusted minted shares");
    }
  }

  if (mintedShares === 0n || (effectiveAmountX === 0n && effectiveAmountY === 0n)) {
    throw new Error(`Liquidity review bin ${bin.binId.toString()} would mint zero shares`);
  }
  checkedAdd(bin.totalSupply, mintedShares, MAX_UINT256, "final bin supply");
  if ((bin.binId < input.activeId && effectiveAmountX > 0n) || (bin.binId > input.activeId && effectiveAmountY > 0n)) {
    throw new Error(`Liquidity review bin ${bin.binId.toString()} has an invalid side composition`);
  }
  return {
    ...bin,
    requestedAmountX: input.requestedAmountX,
    requestedAmountY: input.requestedAmountY,
    effectiveAmountX,
    effectiveAmountY,
    depositedX: effectiveAmountX - protocolFeeX,
    depositedY: effectiveAmountY - protocolFeeY,
    compositionFeeX,
    compositionFeeY,
    protocolFeeX,
    protocolFeeY,
    mintedShares,
    totalFeeRate
  };
}

function totalFee(
  staticFees: StaticFeeParameters,
  variableFees: VariableFeeParameters,
  activeId: bigint,
  binStep: bigint,
  blockTimestamp: bigint
): bigint {
  validateFeeParameters(staticFees, variableFees);
  const maximumProduct = staticFees.maxVolatilityAccumulator * binStep;
  const configuredMaximumFee = staticFees.baseFactor * binStep * 10_000_000_000n +
    (staticFees.variableFeeControl === 0n ? 0n : (maximumProduct * maximumProduct * staticFees.variableFeeControl + 99n) / 100n);
  if (configuredMaximumFee > LB_MAX_FEE) throw new Error("Configured LB maximum fee exceeds the protocol limit");
  if (blockTimestamp < variableFees.timeOfLastUpdate) throw new Error("Pinned block timestamp predates the pair fee state");
  const dt = blockTimestamp - variableFees.timeOfLastUpdate;
  let idReference = variableFees.idReference;
  let volatilityReference = variableFees.volatilityReference;
  if (dt >= staticFees.filterPeriod) {
    idReference = activeId;
    volatilityReference = dt < staticFees.decayPeriod
      ? variableFees.volatilityAccumulator * staticFees.reductionFactor / LB_BASIS_POINT_MAX
      : 0n;
  }
  const deltaId = activeId > idReference ? activeId - idReference : idReference - activeId;
  const volatilityAccumulator = min(
    volatilityReference + deltaId * LB_BASIS_POINT_MAX,
    staticFees.maxVolatilityAccumulator
  );
  const baseFee = staticFees.baseFactor * binStep * 10_000_000_000n;
  const product = volatilityAccumulator * binStep;
  const variableFee = staticFees.variableFeeControl === 0n
    ? 0n
    : (product * product * staticFees.variableFeeControl + 99n) / 100n;
  const result = baseFee + variableFee;
  if (result > LB_MAX_FEE) throw new Error("Pinned LB total fee exceeds the protocol maximum");
  return result;
}

/** Mirrors the pair's read-only current active-bin fee calculation at a pinned block. */
export function quoteCurrentFeeRates(input: CurrentFeeRateInput): CurrentFeeRates {
  const { activeId, binStep, blockTimestamp, staticFees, variableFees } = input;
  assertUint(activeId, MAX_UINT24, "activeId");
  assertUint(binStep, 65_535n, "binStep");
  if (binStep === 0n) throw new Error("binStep must be greater than zero");
  assertUint(blockTimestamp, (1n << 40n) - 1n, "blockTimestamp");
  validateFeeParameters(staticFees, variableFees);
  const maximumProduct = staticFees.maxVolatilityAccumulator * binStep;
  const configuredMaximumFee = staticFees.baseFactor * binStep * 10_000_000_000n +
    (staticFees.variableFeeControl === 0n ? 0n : (maximumProduct * maximumProduct * staticFees.variableFeeControl + 99n) / 100n);
  if (configuredMaximumFee > LB_MAX_FEE) throw new Error("Configured LB maximum fee exceeds the protocol limit");
  if (blockTimestamp < variableFees.timeOfLastUpdate) throw new Error("Pinned block timestamp predates the pair fee state");
  const dt = blockTimestamp - variableFees.timeOfLastUpdate;
  let idReference = variableFees.idReference;
  let volatilityReference = variableFees.volatilityReference;
  if (dt >= staticFees.filterPeriod) {
    idReference = activeId;
    volatilityReference = dt < staticFees.decayPeriod
      ? variableFees.volatilityAccumulator * staticFees.reductionFactor / LB_BASIS_POINT_MAX
      : 0n;
  }
  const deltaId = activeId > idReference ? activeId - idReference : idReference - activeId;
  const volatilityAccumulator = min(
    volatilityReference + deltaId * LB_BASIS_POINT_MAX,
    staticFees.maxVolatilityAccumulator
  );
  const baseFee = staticFees.baseFactor * binStep * 10_000_000_000n;
  const product = volatilityAccumulator * binStep;
  const variableFee = staticFees.variableFeeControl === 0n
    ? 0n
    : (product * product * staticFees.variableFeeControl + 99n) / 100n;
  const totalFeeRate = baseFee + variableFee;
  if (totalFeeRate > LB_MAX_FEE) throw new Error("Pinned LB total fee exceeds the protocol maximum");
  const protocolFeeRate = totalFeeRate * staticFees.protocolShare / LB_BASIS_POINT_MAX;
  return {
    baseFeeRate: baseFee,
    variableFeeRate: variableFee,
    totalFeeRate,
    protocolFeeRate,
    lpNetFeeRate: totalFeeRate - protocolFeeRate,
    protocolShare: staticFees.protocolShare
  };
}

function compositionFee(amountWithFees: bigint, fee: bigint): bigint {
  return amountWithFees * fee * (fee + LB_FEE_PRECISION) / (LB_FEE_PRECISION * LB_FEE_PRECISION);
}

function validateFeeParameters(staticFees: StaticFeeParameters, variableFees: VariableFeeParameters): void {
  assertUint(staticFees.baseFactor, 65_535n, "baseFactor");
  assertUint(staticFees.filterPeriod, 4_095n, "filterPeriod");
  assertUint(staticFees.decayPeriod, 4_095n, "decayPeriod");
  assertUint(staticFees.reductionFactor, LB_BASIS_POINT_MAX, "reductionFactor");
  assertUint(staticFees.variableFeeControl, MAX_UINT24, "variableFeeControl");
  assertUint(staticFees.protocolShare, 2_500n, "protocolShare");
  assertUint(staticFees.maxVolatilityAccumulator, (1n << 20n) - 1n, "maxVolatilityAccumulator");
  assertUint(variableFees.volatilityAccumulator, (1n << 20n) - 1n, "volatilityAccumulator");
  assertUint(variableFees.volatilityReference, (1n << 20n) - 1n, "volatilityReference");
  assertUint(variableFees.idReference, MAX_UINT24, "idReference");
  assertUint(variableFees.timeOfLastUpdate, (1n << 40n) - 1n, "timeOfLastUpdate");
  if (staticFees.filterPeriod > staticFees.decayPeriod) {
    throw new Error("filterPeriod must not exceed decayPeriod");
  }
  if (variableFees.volatilityAccumulator > staticFees.maxVolatilityAccumulator || variableFees.volatilityReference > staticFees.maxVolatilityAccumulator) {
    throw new Error("Pinned volatility state exceeds the configured maximum");
  }
}

function assertBinState(bin: LiquidityReviewBinState): void {
  assertUint(bin.binId, MAX_UINT24, "binId");
  assertUint(bin.priceQ128, MAX_UINT256, "priceQ128");
  if (bin.priceQ128 === 0n) throw new Error("priceQ128 must be nonzero");
  assertUint(bin.reserveX, MAX_UINT128, "reserveX");
  assertUint(bin.reserveY, MAX_UINT128, "reserveY");
  assertUint(bin.totalSupply, MAX_UINT256, "totalSupply");
}

function liquidity(x: bigint, y: bigint, priceQ128: bigint): bigint {
  const result = priceQ128 * x + (y << 128n);
  if (result > MAX_UINT256) throw new Error("Liquidity calculation exceeds uint256");
  return result;
}

function divRoundUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Cannot divide by zero");
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

function sqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x0 = 1n << ((BigInt(value.toString(2).length) + 1n) / 2n);
  let x1 = (x0 + value / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

function checkedAdd(left: bigint, right: bigint, max: bigint, label: string): bigint {
  const result = left + right;
  if (result > max) throw new Error(`${label} overflows its packed integer lane`);
  return result;
}

function assertEqual(label: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) {
    throw new Error(`Liquidity review ${label} diverged from pinned simulation: expected ${expected.toString()}, got ${actual.toString()}`);
  }
}

function assertInt256(value: bigint, label: string): void {
  if (value < -(1n << 255n) || value > (1n << 255n) - 1n) {
    throw new Error(`${label} is outside the signed 256-bit range`);
  }
}

function sum<K extends keyof LiquidityReviewBinQuote>(quotes: readonly LiquidityReviewBinQuote[], key: K): bigint {
  return quotes.reduce((total, quote) => total + (quote[key] as bigint), 0n);
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function assertUint(value: bigint, max: bigint, label: string): void {
  if (value < 0n || value > max) throw new Error(`${label} is outside its unsigned integer range`);
}
