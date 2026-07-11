import assert from "node:assert/strict";
import test from "node:test";

import {
  LB_FEE_PRECISION,
  LB_Q128,
  assertLiquidityReviewMatchesSimulation,
  normalizeAddLiquiditySimulationResult,
  quoteAddLiquidityMath,
  quoteAddLiquidityMathFromSimulation,
  type AddLiquidityReviewInput
} from "../src/liquidity-review.js";

const activeId = 100n;
const zeroFees = {
  baseFactor: 1n,
  filterPeriod: 10n,
  decayPeriod: 20n,
  reductionFactor: 5_000n,
  variableFeeControl: 0n,
  protocolShare: 0n,
  maxVolatilityAccumulator: 100_000n
};
const zeroVariable = {
  volatilityAccumulator: 0n,
  volatilityReference: 0n,
  idReference: activeId,
  timeOfLastUpdate: 1_000n
};

test("normalizes exact router output without retaining mutable arrays", () => {
  const ids = [100n];
  const shares = [55n];
  const result = normalizeAddLiquiditySimulationResult([10n, 20n, 1n, 2n, ids, shares]);
  ids[0] = 101n;
  shares[0] = 66n;
  assert.deepEqual(result, {
    amountXAdded: 10n,
    amountYAdded: 20n,
    amountXLeft: 1n,
    amountYLeft: 2n,
    depositIds: [100n],
    liquidityMinted: [55n]
  });
  assert.throws(() => normalizeAddLiquiditySimulationResult([0n, 0n, 0n, 0n, [], []]), /non-empty/);
  assert.throws(() => normalizeAddLiquiditySimulationResult([0n, 0n, 0n, 0n, [1n], []]), /matching lengths/);
});

test("quotes an empty balanced active bin with exact LB sqrt rounding and no composition fee", () => {
  const quote = quoteAddLiquidityMath(fixture({ amountXReceived: 9n, amountYReceived: 7n, distributionY: [LB_FEE_PRECISION] }));
  assert.equal(quote.amountXAdded, 9n);
  assert.equal(quote.amountYAdded, 7n);
  assert.equal(quote.amountXLeft, 0n);
  assert.equal(quote.amountYLeft, 0n);
  assert.equal(quote.compositionFeeX, 0n);
  assert.equal(quote.compositionFeeY, 0n);
  assert.equal(quote.bins[0]?.mintedShares, 73_786_976_294_838_206_464n);
});

test("quotes one-sided distribution floor as an explicit refund", () => {
  const quote = quoteAddLiquidityMath(fixture({
    amountXReceived: 10n,
    amountYReceived: 0n,
    distributionX: [333_333_333_333_333_333n],
    distributionY: [0n]
  }));
  assert.equal(quote.amountXAdded, 3n);
  assert.equal(quote.amountXLeft, 7n);
  assert.equal(quote.bins[0]?.requestedAmountX, 3n);
  assert.equal(quote.bins[0]?.mintedShares, 31_950_697_969_885_030_203n);
});

test("matches active-bin imbalance composition and protocol fee integer rounding", () => {
  const one = 1_000_000_000_000_000_000n;
  const quote = quoteAddLiquidityMath(fixture({
    amountXReceived: one,
    amountYReceived: 0n,
    binStep: 100n,
    bins: [{ binId: activeId, priceQ128: LB_Q128, reserveX: one, reserveY: one, totalSupply: one }],
    distributionY: [0n],
    staticFees: { ...zeroFees, baseFactor: 10_000n, protocolShare: 2_500n }
  }));
  assert.equal(quote.compositionFeeX, 3_366_666_666_666_666n);
  assert.equal(quote.protocolFeeX, 841_666_666_666_666n);
  assert.equal(quote.bins[0]?.depositedX, 999_158_333_333_333_334n);
  assert.equal(quote.bins[0]?.mintedShares, 497_688_335_143_547_937n);
  assert.equal(quote.bins[0]?.totalFeeRate, 10_000_000_000_000_000n);
});

test("rejects the wrong token side outside the active bin", () => {
  assert.throws(() => quoteAddLiquidityMath(fixture({
    activeId,
    amountXReceived: 10n,
    amountYReceived: 0n,
    bins: [{ binId: activeId - 1n, priceQ128: LB_Q128, reserveX: 0n, reserveY: 0n, totalSupply: 0n }],
    deltaIds: [-1n],
    distributionY: [0n]
  })), /invalid side composition/);
});

test("changes the fee estimate at filter and decay timestamp boundaries", () => {
  const one = 1_000_000_000_000_000_000n;
  const input = fixture({
    amountXReceived: one,
    amountYReceived: 0n,
    binStep: 100n,
    bins: [{ binId: activeId, priceQ128: LB_Q128, reserveX: one, reserveY: one, totalSupply: one }],
    distributionY: [0n],
    staticFees: { ...zeroFees, baseFactor: 1_000n, variableFeeControl: 100n },
    variableFees: { volatilityAccumulator: 1_000n, volatilityReference: 500n, idReference: activeId - 1n, timeOfLastUpdate: 1_000n }
  });
  const filtered = quoteAddLiquidityMath({ ...input, blockTimestamp: 1_005n });
  const reduced = quoteAddLiquidityMath({ ...input, blockTimestamp: 1_010n });
  const decayed = quoteAddLiquidityMath({ ...input, blockTimestamp: 1_020n });
  assert.ok(filtered.bins[0]!.totalFeeRate > reduced.bins[0]!.totalFeeRate);
  assert.ok(reduced.bins[0]!.totalFeeRate > decayed.bins[0]!.totalFeeRate);
  assert.ok(filtered.compositionFeeX > reduced.compositionFeeX);
});

test("derives transfer-tax-safe received amounts from the pinned simulation", () => {
  const minted = 30n * (1n << 64n);
  const quote = quoteAddLiquidityMathFromSimulation(pinnedFixture({ distributionY: [0n] }), [
    900n,
    0n,
    0n,
    0n,
    [activeId],
    [minted]
  ]);
  assert.equal(quote.amountXAdded, 900n);
  assert.equal(quote.bins[0]?.mintedShares, minted);
});

test("fails closed when independent math differs from simulation", () => {
  const quote = quoteAddLiquidityMath(fixture({ amountXReceived: 9n, amountYReceived: 7n, distributionY: [LB_FEE_PRECISION] }));
  assert.throws(() => assertLiquidityReviewMatchesSimulation(quote, {
    amountXAdded: 9n,
    amountYAdded: 7n,
    amountXLeft: 0n,
    amountYLeft: 0n,
    depositIds: [activeId],
    liquidityMinted: [1n]
  }), /liquidityMinted\[0\].*diverged/);
});

test("rejects malformed distributions, fee fields, duplicate state, and packed reserve overflow", () => {
  assert.throws(() => quoteAddLiquidityMath(fixture({ distributionX: [LB_FEE_PRECISION + 1n] })), /distribution precision|unsigned integer range/);
  assert.throws(() => quoteAddLiquidityMath(fixture({
    bins: [emptyBin(), emptyBin()]
  })), /bin states must match|Duplicate pinned state/);
  assert.throws(() => quoteAddLiquidityMath(fixture({
    staticFees: { ...zeroFees, filterPeriod: 21n, decayPeriod: 20n }
  })), /filterPeriod/);
  assert.throws(() => quoteAddLiquidityMath(fixture({
    staticFees: { ...zeroFees, reductionFactor: 10_001n }
  })), /reductionFactor/);
  assert.throws(() => quoteAddLiquidityMath(fixture({
    amountXReceived: 1n,
    amountYReceived: 0n,
    bins: [{ ...emptyBin(), reserveX: (1n << 128n) - 1n }],
    distributionY: [0n]
  })), /overflows its packed integer lane/);
  assert.throws(() => quoteAddLiquidityMath(fixture({
    amountXReceived: 1n,
    amountYReceived: 0n,
    bins: [{ binId: activeId + 1n, priceQ128: LB_Q128, reserveX: 0n, reserveY: 1n, totalSupply: (1n << 256n) - 1n }],
    deltaIds: [1n],
    distributionY: [0n]
  })), /final bin supply.*overflows/);
});

function fixture(overrides: Partial<AddLiquidityReviewInput> = {}): AddLiquidityReviewInput {
  return {
    activeId,
    amountXReceived: 16n,
    amountYReceived: 0n,
    binStep: 10n,
    blockTimestamp: 1_000n,
    deltaIds: [0n],
    distributionX: [LB_FEE_PRECISION],
    distributionY: [0n],
    bins: [emptyBin()],
    staticFees: zeroFees,
    variableFees: zeroVariable,
    ...overrides
  };
}

function pinnedFixture(overrides: Record<string, unknown> = {}) {
  const { amountXReceived: _x, amountYReceived: _y, ...pinned } = fixture(overrides as Partial<AddLiquidityReviewInput>);
  return pinned;
}

function emptyBin() {
  return { binId: activeId, priceQ128: LB_Q128, reserveX: 0n, reserveY: 0n, totalSupply: 0n };
}
