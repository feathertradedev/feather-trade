import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  logLevel: "error",
  root: webRoot,
  server: { hmr: false, middlewareMode: true }
});

try {
  const { buildLiquidityDistribution, DISTRIBUTION_PRECISION } = await server.ssrLoadModule("@robinhood-lb/sdk/liquidity");
  const liquidityPriceModule = `/@fs/${resolve(webRoot, "../../packages/sdk/src/liquidity-price.ts")}`;
  const { activeIdFromPriceQ128, priceQ128FromActiveId, Q128 } = await server.ssrLoadModule(liquidityPriceModule);
  const { suggestPairedLiquidityAmounts } = await server.ssrLoadModule("/src/liquidity-amount-suggestion.ts");
  const activeId = 8_388_608;
  const balanced = buildLiquidityDistribution(activeId, -1, 1, "spot");
  const suggest = (overrides = {}) => suggestPairedLiquidityAmounts({
    balanceX: 10_000n,
    balanceY: 10_000n,
    binStep: 10,
    distribution: balanced,
    sourceAmount: 75n,
    sourceSide: "x",
    ...overrides
  });

  const fromX = suggest({ sourceAmount: 75n, sourceSide: "x" });
  assert.equal(fromX.status, "ready");
  assert.equal(fromX.amountX, 75n, "X source must remain byte-exact");
  assert.equal(fromX.sourceAmount, 75n);
  assert.equal(fromX.pairedSide, "y");
  assert.equal(fromX.amountY, fromX.pairedAmount);
  assert.equal(fromX.clamped, false);

  const fromY = suggest({ sourceAmount: 120n, sourceSide: "y" });
  assert.equal(fromY.status, "ready");
  assert.equal(fromY.amountY, 120n, "Y source must remain byte-exact");
  assert.equal(fromY.sourceAmount, 120n);
  assert.equal(fromY.pairedSide, "x");
  assert.equal(fromY.amountX, fromY.pairedAmount);

  const xToClampedY = suggest({ balanceY: 20n, sourceAmount: 500n, sourceSide: "x" });
  assert.equal(xToClampedY.status, "ready");
  assert.equal(xToClampedY.amountX, 500n);
  assert.equal(xToClampedY.amountY, 20n);
  assert.equal(xToClampedY.clamped, true);
  assert.ok(xToClampedY.requiredPairedAmount > xToClampedY.pairedAmount);

  const yToClampedX = suggest({ balanceX: 20n, sourceAmount: 500n, sourceSide: "y" });
  assert.equal(yToClampedX.status, "ready");
  assert.equal(yToClampedX.amountX, 20n);
  assert.equal(yToClampedX.amountY, 500n);
  assert.equal(yToClampedX.clamped, true);

  const floorDistribution = buildLiquidityDistribution(activeId + 1, 0, 0, "spot");
  const floorPrice = priceQ128FromActiveId(BigInt(activeId + 1), 100);
  const xFloor = suggest({ binStep: 100, distribution: floorDistribution, sourceAmount: 101n, sourceSide: "x" });
  assert.equal(xFloor.pairedAmount, 101n * floorPrice / Q128);
  const yFloor = suggest({ binStep: 100, distribution: floorDistribution, sourceAmount: 101n, sourceSide: "y" });
  assert.equal(yFloor.pairedAmount, 101n * Q128 / floorPrice);

  const spot = suggest({
    balanceX: 10n ** 18n,
    balanceY: 10n ** 30n,
    binStep: 100,
    distribution: buildLiquidityDistribution(activeId, -2, 2, "spot"),
    sourceAmount: 10n ** 18n
  });
  const bidAsk = suggest({
    balanceX: 10n ** 18n,
    balanceY: 10n ** 30n,
    binStep: 100,
    distribution: buildLiquidityDistribution(activeId, -2, 2, "bid-ask"),
    sourceAmount: 10n ** 18n
  });
  assert.notEqual(spot.weightedPriceQ128, bidAsk.weightedPriceQ128);
  assert.notEqual(spot.pairedAmount, bidAsk.pairedAmount);

  const wethUsdcPriceQ128 = Q128 * 2_000n * 10n ** 6n / 10n ** 18n;
  const wethUsdcActiveId = Number(activeIdFromPriceQ128(wethUsdcPriceQ128, 10));
  const wethUsdcDistribution = buildLiquidityDistribution(wethUsdcActiveId, 0, 0, "spot");
  const wethToUsdc = suggest({
    balanceX: 10n ** 18n,
    balanceY: 2_500n * 10n ** 6n,
    distribution: wethUsdcDistribution,
    sourceAmount: 10n ** 18n,
    sourceSide: "x"
  });
  assert.equal(wethToUsdc.amountX, 10n ** 18n);
  assert.ok(wethToUsdc.amountY > 1_990n * 10n ** 6n && wethToUsdc.amountY < 2_010n * 10n ** 6n);
  const usdcToWeth = suggest({
    balanceX: 2n * 10n ** 18n,
    balanceY: 2_000n * 10n ** 6n,
    distribution: wethUsdcDistribution,
    sourceAmount: 2_000n * 10n ** 6n,
    sourceSide: "y"
  });
  assert.equal(usdcToWeth.amountY, 2_000n * 10n ** 6n);
  assert.ok(usdcToWeth.amountX > 99n * 10n ** 16n && usdcToWeth.amountX < 101n * 10n ** 16n);

  assert.equal(suggest({ sourceAmount: null }).reason, "invalid-source-amount");
  assert.equal(suggest({ sourceAmount: 0n }).reason, "invalid-source-amount");
  assert.equal(suggest({ balanceX: 74n, sourceAmount: 75n }).reason, "source-balance-exceeded");
  assert.equal(suggest({ balanceX: null }).reason, "missing-source-balance");
  assert.equal(suggest({ balanceY: null }).reason, "missing-paired-balance");
  assert.equal(suggest({ balanceY: 0n }).reason, "empty-paired-balance");
  assert.equal(suggest({
    balanceX: 1n,
    balanceY: 1n,
    distribution: buildLiquidityDistribution(activeId - 1_000, -1, 1, "spot"),
    sourceAmount: 1n
  }).reason, "rounding-underflow");

  const oneSidedX = suggest({ distribution: buildLiquidityDistribution(activeId, 1, 3, "curve") });
  assert.equal(oneSidedX.reason, "one-sided-range");
  assert.equal(oneSidedX.status, "unavailable");
  assert.equal(oneSidedX.amountX, 0n);
  assert.equal(oneSidedX.amountY, 0n);
  const oneSidedY = suggest({ distribution: buildLiquidityDistribution(activeId, -3, -1, "curve"), sourceSide: "y" });
  assert.equal(oneSidedY.reason, "one-sided-range");

  const clone = (value) => structuredClone(value);
  const invalid = (distribution, binStep = 10) => assert.equal(suggest({ binStep, distribution }).reason, "invalid-distribution");
  invalid(null);
  invalid(balanced, 0);
  invalid(balanced, 65_536);
  invalid(balanced, 1.5);

  const parallelWeight = clone(balanced);
  parallelWeight.distributionX[0] += 1n;
  invalid(parallelWeight);
  const parallelDelta = clone(balanced);
  parallelDelta.deltaIds[0] -= 1n;
  invalid(parallelDelta);
  const unordered = clone(balanced);
  [unordered.bins[0], unordered.bins[1]] = [unordered.bins[1], unordered.bins[0]];
  [unordered.deltaIds[0], unordered.deltaIds[1]] = [unordered.deltaIds[1], unordered.deltaIds[0]];
  [unordered.distributionX[0], unordered.distributionX[1]] = [unordered.distributionX[1], unordered.distributionX[0]];
  [unordered.distributionY[0], unordered.distributionY[1]] = [unordered.distributionY[1], unordered.distributionY[0]];
  invalid(unordered);
  const duplicate = clone(balanced);
  duplicate.bins[1].deltaId = duplicate.bins[0].deltaId;
  duplicate.deltaIds[1] = duplicate.deltaIds[0];
  duplicate.bins[1].binId = duplicate.bins[0].binId;
  invalid(duplicate);
  const mismatchedActive = clone(balanced);
  mismatchedActive.bins[1].binId += 1n;
  invalid(mismatchedActive);
  const xBelowActive = clone(balanced);
  xBelowActive.bins[0].distributionX = 1n;
  xBelowActive.distributionX[0] = 1n;
  xBelowActive.bins[1].distributionX -= 1n;
  xBelowActive.distributionX[1] -= 1n;
  invalid(xBelowActive);
  const yAboveActive = clone(balanced);
  yAboveActive.bins[2].distributionY = 1n;
  yAboveActive.distributionY[2] = 1n;
  yAboveActive.bins[1].distributionY -= 1n;
  yAboveActive.distributionY[1] -= 1n;
  invalid(yAboveActive);
  const wrongMode = clone(balanced);
  wrongMode.mode = "token-x";
  invalid(wrongMode);
  const wrongStrategy = clone(balanced);
  wrongStrategy.strategy = "invented";
  invalid(wrongStrategy);
  const negativeWeight = clone(balanced);
  negativeWeight.bins[0].distributionY = -1n;
  negativeWeight.distributionY[0] = -1n;
  invalid(negativeWeight);
  const badWeight = clone(balanced);
  badWeight.bins[0].distributionY = DISTRIBUTION_PRECISION + 1n;
  badWeight.distributionY[0] = DISTRIBUTION_PRECISION + 1n;
  invalid(badWeight);
  const invalidBin = clone(balanced);
  invalidBin.bins[0].binId = 16_777_216n;
  invalid(invalidBin);
  const seventyBins = clone(balanced);
  while (seventyBins.bins.length < 70) {
    const previous = seventyBins.bins.at(-1);
    const nextDelta = previous.deltaId + 1n;
    seventyBins.bins.push({ ...previous, binId: previous.binId + 1n, deltaId: nextDelta, distributionX: 0n, distributionY: 0n });
    seventyBins.deltaIds.push(nextDelta);
    seventyBins.distributionX.push(0n);
    seventyBins.distributionY.push(0n);
  }
  invalid(seventyBins);

  assert.equal(buildLiquidityDistribution(activeId, -34, 34, "spot").bins.length, 69);
  assert.throws(() => buildLiquidityDistribution(activeId, -34, 35, "spot"), /between 1 and 69 bins/);
  assert.deepEqual(suggest({ sourceAmount: 75n, sourceSide: "x" }), fromX);

  console.log("liquidity amount suggestion tests passed");
} finally {
  await server.close();
}
