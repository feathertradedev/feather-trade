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
  const { activeIdFromPriceQ128, Q128 } = await server.ssrLoadModule(liquidityPriceModule);
  const { suggestPairedLiquidityAmounts } = await server.ssrLoadModule("/src/liquidity-amount-suggestion.ts");
  const activeId = 8_388_608;

  const balanced = buildLiquidityDistribution(activeId, -1, 1, "spot");
  const bounded = suggestPairedLiquidityAmounts({
    balanceX: 500n,
    balanceY: 120n,
    binStep: 10,
    distribution: balanced
  });
  assert.equal(bounded.status, "ready");
  assert.equal(bounded.mode, "balanced");
  assert.equal(bounded.limitingSide, "y");
  assert.ok(bounded.amountX > 0n && bounded.amountX <= 500n);
  assert.ok(bounded.amountY > 0n && bounded.amountY <= 120n);

  const xLimited = suggestPairedLiquidityAmounts({
    balanceX: 75n,
    balanceY: 10_000n,
    binStep: 10,
    distribution: balanced
  });
  assert.equal(xLimited.status, "ready");
  assert.equal(xLimited.amountX, 75n);
  assert.equal(xLimited.limitingSide, "x");

  const spot = suggestPairedLiquidityAmounts({
    balanceX: 10n ** 18n,
    balanceY: 10n ** 30n,
    binStep: 100,
    distribution: buildLiquidityDistribution(activeId, -2, 2, "spot")
  });
  const bidAsk = suggestPairedLiquidityAmounts({
    balanceX: 10n ** 18n,
    balanceY: 10n ** 30n,
    binStep: 100,
    distribution: buildLiquidityDistribution(activeId, -2, 2, "bid-ask")
  });
  assert.equal(spot.status, "ready");
  assert.equal(bidAsk.status, "ready");
  assert.notEqual(spot.weightedPriceQ128, bidAsk.weightedPriceQ128);
  assert.notEqual(spot.amountY, bidAsk.amountY);

  const wethUsdcPriceQ128 = Q128 * 2_000n * 10n ** 6n / 10n ** 18n;
  const wethUsdcActiveId = Number(activeIdFromPriceQ128(wethUsdcPriceQ128, 10));
  const wethUsdc = suggestPairedLiquidityAmounts({
    balanceX: 10n ** 18n,
    balanceY: 2_000n * 10n ** 6n,
    binStep: 10,
    distribution: buildLiquidityDistribution(wethUsdcActiveId, 0, 0, "spot")
  });
  assert.equal(wethUsdc.status, "ready");
  assert.ok(wethUsdc.amountX > 99n * 10n ** 16n);
  assert.ok(wethUsdc.amountX <= 10n ** 18n);
  assert.ok(wethUsdc.amountY > 1_990n * 10n ** 6n);
  assert.ok(wethUsdc.amountY <= 2_000n * 10n ** 6n);

  const dusty = suggestPairedLiquidityAmounts({
    balanceX: 101n,
    balanceY: 100n,
    binStep: 10,
    distribution: balanced
  });
  assert.equal(dusty.status, "ready");
  assert.ok(dusty.amountX <= 101n);
  assert.ok(dusty.amountY <= 100n);
  assert.equal(
    suggestPairedLiquidityAmounts({
      balanceX: 1n,
      balanceY: 1n,
      binStep: 10,
      distribution: buildLiquidityDistribution(activeId - 1_000, -1, 1, "spot")
    }).reason,
    "rounding-underflow"
  );

  assert.deepEqual(
    suggestPairedLiquidityAmounts({
      balanceX: 321n,
      balanceY: null,
      binStep: 10,
      distribution: buildLiquidityDistribution(activeId, 1, 3, "curve")
    }),
    {
      amountX: 321n,
      amountY: 0n,
      limitingSide: "x",
      mode: "token-x",
      reason: null,
      status: "ready",
      weightedPriceQ128: null
    }
  );
  assert.deepEqual(
    suggestPairedLiquidityAmounts({
      balanceX: null,
      balanceY: 654n,
      binStep: 10,
      distribution: buildLiquidityDistribution(activeId, -3, -1, "curve")
    }),
    {
      amountX: 0n,
      amountY: 654n,
      limitingSide: "y",
      mode: "token-y",
      reason: null,
      status: "ready",
      weightedPriceQ128: null
    }
  );

  assert.equal(suggestPairedLiquidityAmounts({ balanceX: null, balanceY: 1n, binStep: 10, distribution: balanced }).reason, "missing-balance");
  assert.equal(suggestPairedLiquidityAmounts({ balanceX: 0n, balanceY: 1n, binStep: 10, distribution: balanced }).reason, "empty-balance");
  assert.equal(suggestPairedLiquidityAmounts({ balanceX: 1n, balanceY: 1n, binStep: 10, distribution: null }).reason, "invalid-distribution");
  assert.equal(buildLiquidityDistribution(activeId, -34, 34, "spot").bins.length, 69);
  assert.throws(() => buildLiquidityDistribution(activeId, -34, 35, "spot"), /between 1 and 69 bins/);

  const clone = (value) => structuredClone(value);
  const malformedParallelWeight = clone(balanced);
  malformedParallelWeight.distributionX[0] += 1n;
  assert.equal(suggestPairedLiquidityAmounts({ balanceX: 1n, balanceY: 1n, binStep: 10, distribution: malformedParallelWeight }).reason, "invalid-distribution");
  const malformedParallelDelta = clone(balanced);
  malformedParallelDelta.deltaIds[0] -= 1n;
  assert.equal(suggestPairedLiquidityAmounts({ balanceX: 1n, balanceY: 1n, binStep: 10, distribution: malformedParallelDelta }).reason, "invalid-distribution");
  const negativeWeight = clone(balanced);
  negativeWeight.bins[0].distributionY = -1n;
  negativeWeight.distributionY[0] = -1n;
  assert.equal(suggestPairedLiquidityAmounts({ balanceX: 1n, balanceY: 1n, binStep: 10, distribution: negativeWeight }).reason, "invalid-distribution");
  const excessiveWeight = clone(balanced);
  excessiveWeight.bins[0].distributionX = DISTRIBUTION_PRECISION + 1n;
  excessiveWeight.distributionX[0] = DISTRIBUTION_PRECISION + 1n;
  assert.equal(suggestPairedLiquidityAmounts({ balanceX: 1n, balanceY: 1n, binStep: 10, distribution: excessiveWeight }).reason, "invalid-distribution");
  const seventyBins = clone(balanced);
  while (seventyBins.bins.length < 70) {
    seventyBins.bins.push(clone(seventyBins.bins.at(-1)));
    seventyBins.deltaIds.push(seventyBins.deltaIds.at(-1));
    seventyBins.distributionX.push(0n);
    seventyBins.distributionY.push(0n);
  }
  assert.equal(suggestPairedLiquidityAmounts({ balanceX: 1n, balanceY: 1n, binStep: 10, distribution: seventyBins }).reason, "invalid-distribution");
  assert.equal(suggestPairedLiquidityAmounts({ balanceX: 1n, balanceY: 1n, binStep: -1, distribution: balanced }).reason, "invalid-distribution");
  const invalidBin = clone(balanced);
  invalidBin.bins[0].binId = 16_777_216n;
  assert.equal(suggestPairedLiquidityAmounts({ balanceX: 1n, balanceY: 1n, binStep: 10, distribution: invalidBin }).reason, "invalid-distribution");
  assert.deepEqual(
    suggestPairedLiquidityAmounts({ balanceX: 500n, balanceY: 120n, binStep: 10, distribution: balanced }),
    bounded
  );

  console.log("liquidity amount suggestion tests passed");
} finally {
  await server.close();
}
