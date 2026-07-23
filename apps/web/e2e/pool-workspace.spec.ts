import { expect, test } from "@playwright/test";
import { decodeFunctionData, type Hex } from "viem";

import { lbRouterAbi } from "../../../packages/sdk/src/abi";
import { installMockAnalyticsStream } from "./fixtures/mock-analytics-stream";
import { installMockRpc, LOCALNET_ANALYTICS_URL, SECOND_WNATIVE_USDC_PAIR, USDC, WNATIVE, WNATIVE_USDC_PAIR } from "./fixtures/mock-rpc";
import { DEFAULT_ACCOUNT, installMockWallet, LOCALNET_CHAIN_ID, openAndSelectMockWallet, readMockWallet } from "./fixtures/mock-wallet";

const ONE_TOKEN = 10n ** 18n;
const TEST_ACTIVE_ID = 8_388_608;
const TEST_Q128 = 1n << 128n;

async function connectWallet(page: Parameters<typeof installMockRpc>[0]) {
  await openAndSelectMockWallet(page);
  await expect(page.getByTestId("wallet-account-button")).toBeVisible();
}

async function installMockDiscoveryProjection(page: Parameters<typeof installMockRpc>[0]) {
  await page.route(LOCALNET_ANALYTICS_URL, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const body = JSON.parse(request.postData() ?? "{}") as {
      query?: string;
      variables?: { pools?: { pair: string; preferredQuoteToken?: string | null }[] };
    };
    if (!body.query?.includes("WebPoolDiscovery")) return route.fallback();
    const startTimestamp = 1_720_000_800;
    const poolDiscovery = (body.variables?.pools ?? []).map((requested, index) => ({
      pair: requested.pair.toLowerCase(),
      chainId: LOCALNET_CHAIN_ID,
      tokenX: WNATIVE.toLowerCase(),
      tokenY: USDC.toLowerCase(),
      displayBaseToken: WNATIVE.toLowerCase(),
      displayQuoteToken: USDC.toLowerCase(),
      poolPriceQuotePerBaseE18: "160000000000000000000",
      hourlyCloses: [160n, 164n, 162n, 168n].map((close, closeIndex) => ({
        startTimestamp: startTimestamp + closeIndex * 3_600,
        closeUsdE18: String(close * 10n ** 18n),
        quoteToken: USDC.toLowerCase(),
        finalized: closeIndex < 3,
        revision: closeIndex + 1,
        priceSource: "active-bin-quote-usd",
        firstBlockHash: `0x${(500 + closeIndex).toString(16).padStart(64, "0")}`,
        lastBlockHash: `0x${(500 + closeIndex).toString(16).padStart(64, "0")}`
      })),
      priceChange24hE18: "50000000000000000",
      tvlUsdE18: String((500_000n - BigInt(index) * 10_000n) * 10n ** 18n),
      lpNetSwapFees24hUsdE18: String((240n - BigInt(index)) * 10n ** 18n),
      volume24hUsdE18: String((120_000n - BigInt(index) * 1_000n) * 10n ** 18n),
      status: "READY",
      missingPriceTokens: [],
      asOfBlock: "42",
      asOfBlockHash: `0x${"22".repeat(32)}`,
      asOfTimestamp: startTimestamp + 4 * 3_600,
      marketMetadata: {
        marketCapUsdE18: "12345000000000000000000000",
        source: "dex-screener",
        fetchedAt: startTimestamp + 4 * 3_600,
        logoPath: `/token-images/${"c".repeat(64)}`,
        logoSource: "dex-screener"
      }
    }));
    await route.fulfill({
      body: JSON.stringify({ data: { poolDiscovery } }),
      contentType: "application/json",
      status: 200
    });
  });
}

async function selectPoolWorkspaceView(
  page: Parameters<typeof installMockRpc>[0],
  view: "Market" | "Trade" | "Positions"
) {
  const tab = page
    .getByRole("tablist", { name: "Pool workspace views" })
    .getByRole("tab", { exact: true, name: view });
  const mobileView = (page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 720;
  if (mobileView) {
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  return mobileView;
}

async function expandPoolMetadata(page: Parameters<typeof installMockRpc>[0]) {
  const mobileView = await selectPoolWorkspaceView(page, "Market");
  const toggle = page.locator(".pool-workspace-rail-toggle");
  if (mobileView) await expect(toggle).toBeVisible();
  if (mobileView && await toggle.getAttribute("aria-expanded") === "false") {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}

async function submitReviewedSwap(page: Parameters<typeof installMockRpc>[0]) {
  await page.getByTestId("swap-submit-button").click();
  await expect(page.getByTestId("gas-review")).toBeVisible();
  await page.getByTestId("swap-submit-button").click();
}

test("swap workspace renders all candle timeframes with Lightweight Charts", async ({ page }) => {
  const rpc = await installMockRpc(page, { includePairs: true });

  await page.goto("/#/swap");
  const chart = page.getByTestId("swap-market-chart");
  await expect(chart).toContainText("WNATIVE / USDC");
  await expect(chart.locator(".swap-chart-summary")).toContainText("Vol $");
  await expect(chart.locator(".swap-chart-footer")).toContainText("14D history · History ready");
  await expect(chart.getByRole("link", { name: "Charting by TradingView" })).toBeVisible();
  await expect.poll(() => rpc.snapshot().graphQueries.some((query) => query.includes("WebPairCandles"))).toBe(true);
  const candleRequest = rpc.snapshot().graphRequests.find((request) => request.query.includes("WebPairCandles"));
  expect(candleRequest?.variables?.interval).toBe("HOUR");
  const intervals = chart.getByRole("group", { name: "Candle interval" });
  const intervalPositions = await intervals.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { left: Math.round(bounds.left), top: Math.round(bounds.top) };
  }));
  expect(new Set(intervalPositions.map(({ top }) => top)).size).toBe(1);
  expect(intervalPositions.every(({ left }, index) => index === 0 || left > intervalPositions[index - 1]!.left)).toBe(true);
  for (const [label, value] of [["1m", "ONE_MINUTE"], ["5m", "FIVE_MINUTES"], ["15m", "FIFTEEN_MINUTES"], ["1h", "HOUR"], ["4h", "FOUR_HOURS"], ["1d", "DAY"], ["1w", "WEEK"]] as const) {
    await intervals.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(() => rpc.snapshot().graphRequests.some((request) => request.query.includes("WebPairCandles") && request.variables?.interval === value)).toBe(true);
    await expect(intervals.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("pool chart applies live candle replacements and exposes stream failure", async ({ page }) => {
  await installMockAnalyticsStream(page);
  const rpc = await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await selectPoolWorkspaceView(page, "Market");
  const chart = page.getByTestId("swap-market-chart");
  await expect(chart.locator(".swap-chart-stream")).toHaveText("Live");
  await expect.poll(() => rpc.snapshot().graphRequests.some((request) => request.query.includes("WebPairCandles"))).toBe(true);
  const candleRequest = rpc.snapshot().graphRequests.findLast((request) => request.query.includes("WebPairCandles"));
  const startTimestamp = candleRequest?.variables?.toTimestamp;
  expect(startTimestamp).toBeDefined();

  await page.evaluate((payload) => {
    (window as unknown as Window & { __testEmitCandle: (value: unknown) => void }).__testEmitCandle(payload);
  }, {
    cursor: "999",
    candle: {
      pair: WNATIVE_USDC_PAIR.toLowerCase(),
      interval: "HOUR",
      startTimestamp,
      endTimestamp: startTimestamp! + 3_600,
      openUsdE18: "2400000000000000000000",
      highUsdE18: "2700000000000000000000",
      lowUsdE18: "2300000000000000000000",
      closeUsdE18: "2600000000000000000000",
      volumeUsdE18: "123000000000000000000",
      totalSwapFeesUsdE18: "300000000000000000",
      protocolSwapFeesUsdE18: "54000000000000000",
      lpNetSwapFeesUsdE18: "246000000000000000",
      feeBreakdownComplete: true,
      tvlUsdE18: "500000000000000000000000",
      swapCount: 99,
      status: "READY",
      missingPriceTokens: [],
      firstBlock: "100",
      lastBlock: "101",
      firstBlockHash: `0x${"1".repeat(64)}`,
      lastBlockHash: `0x${"2".repeat(64)}`,
      finalized: false,
      revision: 999,
      priceSource: "active-bin-quote-usd",
      quoteToken: USDC.toLowerCase(),
      tokenX: WNATIVE.toLowerCase()
    }
  });
  await expect(chart.locator(".swap-chart-summary")).toContainText("C $2,600.00");

  const requestsBeforeReset = rpc.snapshot().graphRequests.filter((request) => request.query.includes("WebPairCandles")).length;
  await page.evaluate(() => {
    (window as unknown as Window & { __testResetCandleStream: () => void }).__testResetCandleStream();
  });
  await expect.poll(() => rpc.snapshot().graphRequests.filter((request) => request.query.includes("WebPairCandles")).length).toBeGreaterThan(requestsBeforeReset);
  await expect(chart.locator(".swap-chart-stream")).toHaveText("Live");

  await page.evaluate(() => {
    (window as unknown as Window & { __testFailCandleStream: () => void }).__testFailCandleStream();
  });
  await expect(chart.locator(".swap-chart-stream")).toHaveText("Stream stale");
});

test("pool workspace applies sparse canonical market updates without refetching the bootstrap", async ({ page }) => {
  await installMockAnalyticsStream(page);
  const rpc = await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await expandPoolMetadata(page);
  await expect.poll(() => page.getByTestId("pool-workspace-rail").evaluate((element) => ({
    error: element.getAttribute("data-pool-stream-error"),
    state: element.getAttribute("data-pool-stream-state")
  }))).toEqual({ error: null, state: "live" });
  await expect(page.locator(".pool-rail-price-block small")).toContainText("Live analytics");
  const poolRequests = () => rpc.snapshot().graphRequests.filter((request) => request.query.includes("WebPoolState"));
  await expect.poll(() => poolRequests().length).toBeGreaterThan(0);
  const bootstrapRequestCount = poolRequests().length;

  const untouchedBin = page.locator(`[data-bin-id="${TEST_ACTIVE_ID - 1}"]`);
  await expect(untouchedBin).toBeAttached();
  await untouchedBin.evaluate((element) => element.setAttribute("data-node-sentinel", "retained"));

  const blockHash = `0x${"4".repeat(64)}`;
  rpc.update({ blockHash, blockNumber: 43n });
  const state = {
    chainId: LOCALNET_CHAIN_ID,
    pair: WNATIVE_USDC_PAIR.toLowerCase(),
    tokenX: WNATIVE.toLowerCase(),
    tokenY: USDC.toLowerCase(),
    decimalsX: 18,
    decimalsY: 18,
    reserveX: "2000000000000000000",
    reserveY: "319000000000000000000",
    activeId: TEST_ACTIVE_ID,
    binStep: 10,
    marketPriceQuoteE18: "160000000000000000000",
    priceUsdE18: "160000000000000000000",
    tvlUsdE18: "321000000000000000000",
    status: "READY",
    missingPriceTokens: [],
    feeState: {
      static: {
        baseFactor: "20", filterPeriod: "30", decayPeriod: "120", reductionFactor: "5000",
        variableFeeControl: "100", protocolShare: "1000", maxVolatilityAccumulator: "100000"
      },
      variable: {
        volatilityAccumulator: "1200", volatilityReference: "500", idReference: String(TEST_ACTIVE_ID), timeOfLastUpdate: "1720000001"
      }
    },
    asOfBlock: "43",
    asOfBlockHash: blockHash,
    asOfTimestamp: 1_720_000_001,
    revision: 2
  };
  const payload = {
    cursor: "5",
    update: {
      eventId: `31337:${blockHash}:${WNATIVE_USDC_PAIR.toLowerCase()}:swap-43`,
      state,
      binReplacements: [{
        chainId: LOCALNET_CHAIN_ID,
        pair: WNATIVE_USDC_PAIR.toLowerCase(),
        binId: String(TEST_ACTIVE_ID),
        reserveX: "9000000000000000000",
        reserveY: "1000000",
        totalSupply: "10000000000000000000",
        updatedAtBlock: "43",
        updatedAtBlockHash: blockHash,
        updatedAtTimestamp: 1_720_000_001,
        revision: 2
      }],
      replaceBinWindow: false,
      sourceEventIds: ["swap-43"]
    }
  };
  await page.evaluate((value) => {
    (window as unknown as Window & { __testEmitPoolState: (payload: unknown) => void }).__testEmitPoolState(value);
  }, payload);

  await expect(page.locator(".pool-rail-reserves dd").first()).toContainText("2");
  await expect(untouchedBin).toHaveAttribute("data-node-sentinel", "retained");
  expect(poolRequests()).toHaveLength(bootstrapRequestCount);

  await page.evaluate((value) => {
    (window as unknown as Window & { __testEmitPoolState: (payload: unknown) => void }).__testEmitPoolState(value);
  }, payload);
  await page.waitForTimeout(100);
  expect(poolRequests()).toHaveLength(bootstrapRequestCount);

  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(100);
  expect(poolRequests()).toHaveLength(bootstrapRequestCount);

  const invalidFeeHash = `0x${"5".repeat(64)}`;
  rpc.update({ blockHash: invalidFeeHash, blockNumber: 44n });
  await page.evaluate((value) => {
    (window as unknown as Window & { __testEmitPoolState: (payload: unknown) => void }).__testEmitPoolState(value);
  }, {
    cursor: "6",
    update: {
      ...payload.update,
      eventId: `31337:${invalidFeeHash}:${WNATIVE_USDC_PAIR.toLowerCase()}:swap-44`,
      state: {
        ...state,
        feeState: {
          ...state.feeState,
          static: { ...state.feeState.static, protocolShare: "3000" }
        },
        asOfBlock: "44",
        asOfBlockHash: invalidFeeHash,
        asOfTimestamp: 1_720_000_002,
        revision: 3
      },
      binReplacements: [{
        ...payload.update.binReplacements[0],
        updatedAtBlock: "44",
        updatedAtBlockHash: invalidFeeHash,
        updatedAtTimestamp: 1_720_000_002,
        revision: 3
      }],
      sourceEventIds: ["swap-44"]
    }
  });
  await expect(page.locator(".pool-rail-fees-heading small")).toContainText("Pinned RPC fees");
  await expect(page.locator(".pool-rail-fees-heading small")).toContainText("live fee state unavailable");

  await page.evaluate(() => {
    (window as unknown as Window & { __testFailPoolStream: () => void }).__testFailPoolStream();
  });
  await expect(page.locator(".pool-rail-price-block small")).toContainText("Stale analytics snapshot");
  await expect(page.getByTestId("pool-workspace-rail").getByRole("status")).toContainText("updates are stale");

  await page.evaluate(() => {
    (window as unknown as Window & { __testResetPoolStream: () => void }).__testResetPoolStream();
  });
  await expect.poll(() => poolRequests().length).toBeGreaterThan(1);
});

test("pool workspace coalesces retained replay before attestation and never marks queued data live", async ({ page }) => {
  await installMockAnalyticsStream(page);
  const rpc = await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await expandPoolMetadata(page);
  const rail = page.getByTestId("pool-workspace-rail");
  await expect(rail).toHaveAttribute("data-pool-stream-state", "live");

  const blockHash = `0x${"8".repeat(64)}` as const;
  rpc.update({ blockHash, blockNumber: 43n, poolEconomicsReadDelayMs: 300 });
  const baseState = {
    chainId: LOCALNET_CHAIN_ID,
    pair: WNATIVE_USDC_PAIR.toLowerCase(),
    tokenX: WNATIVE.toLowerCase(),
    tokenY: USDC.toLowerCase(),
    decimalsX: 18,
    decimalsY: 18,
    reserveY: "319000000000000000000",
    activeId: TEST_ACTIVE_ID,
    binStep: 10,
    marketPriceQuoteE18: "160000000000000000000",
    priceUsdE18: "160000000000000000000",
    tvlUsdE18: "321000000000000000000",
    status: "READY",
    missingPriceTokens: [],
    feeState: {
      static: {
        baseFactor: "20", filterPeriod: "30", decayPeriod: "120", reductionFactor: "5000",
        variableFeeControl: "100", protocolShare: "1000", maxVolatilityAccumulator: "100000"
      },
      variable: {
        volatilityAccumulator: "1200", volatilityReference: "500", idReference: String(TEST_ACTIVE_ID), timeOfLastUpdate: "1720000001"
      }
    },
    asOfBlock: "43",
    asOfBlockHash: blockHash,
    asOfTimestamp: 1_720_000_001
  };
  const replay = Array.from({ length: 256 }, (_, index) => {
    const revision = index + 2;
    return {
      cursor: String(index + 1),
      update: {
        eventId: `31337:${blockHash}:${WNATIVE_USDC_PAIR.toLowerCase()}:replay-${revision}`,
        state: {
          ...baseState,
          reserveX: `${revision}000000000000000000`,
          revision
        },
        binReplacements: [{
          chainId: LOCALNET_CHAIN_ID,
          pair: WNATIVE_USDC_PAIR.toLowerCase(),
          binId: String(TEST_ACTIVE_ID),
          reserveX: `${revision}000000000000000000`,
          reserveY: "1000000",
          totalSupply: "10000000000000000000",
          updatedAtBlock: "43",
          updatedAtBlockHash: blockHash,
          updatedAtTimestamp: 1_720_000_001,
          revision
        }],
        replaceBinWindow: false,
        sourceEventIds: [`replay-${revision}`]
      }
    };
  });
  const activeReadsBeforeReplay = rpc.snapshot().ethCalls.filter((call) => call.functionName === "getActiveId").length;

  await page.evaluate((payloads) => {
    const controls = window as unknown as Window & {
      __testEmitPoolStateBatch: (values: unknown[]) => void;
      __testHeartbeatPoolStream: () => void;
    };
    controls.__testEmitPoolStateBatch(payloads);
    controls.__testHeartbeatPoolStream();
  }, replay);

  await expect(rail).toHaveAttribute("data-pool-stream-state", "connecting");
  await expect(page.locator(".pool-rail-reserves dd").first()).toContainText("257", { timeout: 10_000 });
  await expect(rail).toHaveAttribute("data-pool-stream-state", "live");
  const activeReadsAfterReplay = rpc.snapshot().ethCalls.filter((call) => call.functionName === "getActiveId").length;
  expect(activeReadsAfterReplay - activeReadsBeforeReplay).toBe(1);
});

test("an unavailable pool bootstrap retries only until the live handoff succeeds", async ({ page }) => {
  await installMockAnalyticsStream(page);
  const rpc = await installMockRpc(page, { analyticsMode: "error", includePairs: true });
  const poolRequests = () => rpc.snapshot().graphRequests.filter((request) => request.query.includes("WebPoolState"));

  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await expandPoolMetadata(page);
  await expect(page.getByTestId("pool-workspace-rail")).toHaveAttribute("data-pool-stream-state", "unavailable");
  await expect.poll(() => poolRequests().length).toBe(1);

  rpc.update({ analyticsMode: "ready" });
  await expect(page.getByTestId("pool-workspace-rail")).toHaveAttribute("data-pool-stream-state", "live", { timeout: 15_000 });
  const requestsAfterHandoff = poolRequests().length;
  expect(requestsAfterHandoff).toBeGreaterThan(1);

  await page.waitForTimeout(10_500);
  expect(poolRequests()).toHaveLength(requestsAfterHandoff);
});

test("same-height live pool state must match the pinned canonical hash", async ({ page }) => {
  await installMockAnalyticsStream(page);
  const pinnedHash = `0x${"6".repeat(64)}` as const;
  const liveForkHash = `0x${"7".repeat(64)}` as const;
  const rpc = await installMockRpc(page, {
    analyticsAsOfBlock: 42n,
    analyticsHeadHash: pinnedHash,
    blockHash: pinnedHash,
    includePairs: true,
    indexerBlockHash: pinnedHash,
    indexerBlockNumber: 42n
  });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await expandPoolMetadata(page);
  await expect(page.getByTestId("pool-workspace-rail")).toHaveAttribute("data-pool-stream-state", "live");

  rpc.update({ analyticsHeadHash: liveForkHash });
  await page.evaluate(() => {
    (window as unknown as Window & { __testResetPoolStream: () => void }).__testResetPoolStream();
  });
  await expect(page.getByTestId("pool-workspace-rail")).toHaveAttribute(
    "data-pool-stream-error",
    "Live pool state canonical hash differs from pinned RPC state"
  );
  await expect(page.getByTestId("pool-workspace-rail")).toHaveAttribute("data-pool-stream-state", "unavailable");
  await expect(page.locator(".pool-rail-price-block small")).not.toContainText("Live analytics");
});

test("candle intervals remain usable without page overflow on a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rpc = await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await page.getByRole("tablist", { name: "Pool workspace views" }).getByRole("tab", { name: "Market" }).click();

  const chart = page.getByTestId("swap-market-chart");
  const intervals = chart.getByRole("group", { name: "Candle interval" });
  await expect(intervals.getByRole("button")).toHaveCount(7);
  for (const [label, value] of [["1m", "ONE_MINUTE"], ["5m", "FIVE_MINUTES"], ["15m", "FIFTEEN_MINUTES"], ["1h", "HOUR"], ["4h", "FOUR_HOURS"], ["1d", "DAY"], ["1w", "WEEK"]] as const) {
    await intervals.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(() => rpc.snapshot().graphRequests.some((request) => request.query.includes("WebPairCandles") && request.variables?.interval === value)).toBe(true);
    await expect(intervals.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(chart.locator(".swap-chart-canvas")).toBeVisible();
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("an SSE candle crossing a 1m boundary appends without refetching historical GraphQL", async ({ page }) => {
  await installMockAnalyticsStream(page);
  const rpc = await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await selectPoolWorkspaceView(page, "Market");
  const chart = page.getByTestId("swap-market-chart");
  await chart.getByRole("button", { name: "1m", exact: true }).click();
  await expect(chart.locator(".swap-chart-stream")).toHaveText("Live");
  const minuteRequests = () => rpc.snapshot().graphRequests.filter((request) =>
    request.query.includes("WebPairCandles") && request.variables?.interval === "ONE_MINUTE"
  );
  await expect.poll(() => minuteRequests().length).toBe(1);
  const startTimestamp = minuteRequests()[0]?.variables?.toTimestamp;
  expect(startTimestamp).toBeDefined();

  await page.evaluate(() => {
    (window as unknown as Window & { __testAdvanceCandleClock: (milliseconds: number) => void }).__testAdvanceCandleClock(61_000);
  });
  await page.evaluate((payload) => {
    (window as unknown as Window & { __testEmitCandle: (value: unknown) => void }).__testEmitCandle(payload);
  }, {
    cursor: "1001",
    candle: {
      pair: WNATIVE_USDC_PAIR.toLowerCase(),
      interval: "ONE_MINUTE",
      startTimestamp: startTimestamp! + 60,
      endTimestamp: startTimestamp! + 120,
      openUsdE18: "2600000000000000000000",
      highUsdE18: "2750000000000000000000",
      lowUsdE18: "2550000000000000000000",
      closeUsdE18: "2700000000000000000000",
      volumeUsdE18: "10000000000000000000",
      totalSwapFeesUsdE18: "25000000000000000",
      protocolSwapFeesUsdE18: "5000000000000000",
      lpNetSwapFeesUsdE18: "20000000000000000",
      feeBreakdownComplete: true,
      tvlUsdE18: "500000000000000000000000",
      swapCount: 1,
      status: "READY",
      missingPriceTokens: [],
      firstBlock: "102",
      lastBlock: "102",
      firstBlockHash: `0x${"3".repeat(64)}`,
      lastBlockHash: `0x${"3".repeat(64)}`,
      finalized: false,
      revision: 1,
      priceSource: "active-bin-quote-usd",
      quoteToken: USDC.toLowerCase(),
      tokenX: WNATIVE.toLowerCase()
    }
  });
  await expect(chart.locator(".swap-chart-summary")).toContainText("C $2,700.00");
  await page.waitForTimeout(250);
  expect(minuteRequests()).toHaveLength(1);
});

test("canonical pool tasks keep one selected pool while reusing swap and liquidity engines", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await expandPoolMetadata(page);

  const workspace = page.getByTestId("canonical-pool-workspace");
  const rail = page.getByTestId("pool-workspace-rail");
  const tasks = workspace.getByRole("navigation", { name: "Pool tasks" });
  await expect(workspace).toHaveAttribute("data-pool-id", WNATIVE_USDC_PAIR.toLowerCase());
  await expect(rail).toContainText("$500,000");
  await expect(rail).toContainText("local fixture");
  await expect(page.getByTestId("pool-workspace-state")).toHaveCount(0);
  await expect(rail).not.toContainText("Network");
  await expect(rail).not.toContainText("Indexer");
  const distribution = page.getByTestId("pool-rail-liquidity-distribution");
  const distributionBars = distribution.locator(".pool-rail-liquidity-bars > span");
  await expect(distribution).toContainText("Liquidity distribution");
  await expect(distributionBars).toHaveCount(33);
  await expect(distributionBars.nth(16)).toHaveClass(/active/);
  await expect(distributionBars.nth(16)).toHaveAttribute("data-bin-id", "8388608");
  await distribution.getByRole("button", { name: "Zoom into liquidity distribution" }).click();
  await expect(distributionBars).toHaveCount(17);
  await expect(distributionBars.nth(8)).toHaveClass(/active/);
  const priceFlip = rail.getByRole("button", { name: "Show price as WNATIVE per USDC" });
  await priceFlip.click();
  await expect(rail.getByRole("button", { name: "Show price as USDC per WNATIVE" })).toBeVisible();
  await expect(page.getByTestId("swap-market-chart")).toContainText("WNATIVE / USDC");
  await selectPoolWorkspaceView(page, "Trade");
  await expect(tasks.getByRole("link", { name: "Swap" })).toHaveAttribute("aria-current", "page");
  await page.locator("#swap-amount").fill("2.75");
  const routeDisclosure = page.getByTestId("swap-route-disclosure");
  await expect(routeDisclosure).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("swap-route-mode-summary")).toHaveText("Exact selected pool");
  await routeDisclosure.locator("summary").click();
  await routeDisclosure.getByRole("button", { name: "Best route" }).click();
  await expect(page.getByTestId("swap-route-mode-summary")).toHaveText("Best route");

  await tasks.getByRole("link", { name: "Create position" }).click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/create$`, "i"));
  await expect(workspace).toHaveAttribute("data-pool-id", WNATIVE_USDC_PAIR.toLowerCase());
  await selectPoolWorkspaceView(page, "Market");
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
  await selectPoolWorkspaceView(page, "Trade");
  await expect(page.locator("#liquidity-pair")).toHaveCount(0);
  await expect(page.locator("#liquidity-withdraw")).toHaveCount(0);
  await page.getByTestId("liquidity-amount-x").fill("0.345");

  await tasks.getByRole("link", { name: "Manage" }).click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/manage$`, "i"));
  await expect(workspace).toHaveAttribute("data-pool-id", WNATIVE_USDC_PAIR.toLowerCase());
  await selectPoolWorkspaceView(page, "Market");
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
  await selectPoolWorkspaceView(page, "Trade");
  await expect(page.locator("#liquidity-add")).toHaveCount(0);
  await expect(page.locator("#liquidity-withdraw")).toBeVisible();

  await tasks.getByRole("link", { name: "Swap" }).click();
  await expect(page.locator("#swap-amount")).toHaveValue("2.75");
  await expect(page.getByTestId("swap-route-mode-summary")).toHaveText("Best route");
  await expect(page.getByTestId("swap-route-disclosure")).not.toHaveAttribute("open", "");
  await tasks.getByRole("link", { name: "Create position" }).click();
  await expect(page.getByTestId("liquidity-amount-x")).toHaveValue("0.345");

  await expect(workspace.getByRole("link", { name: "Market overview" })).toHaveCount(0);
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/market`);
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/create\\?returnTo=`, "i"));
  await selectPoolWorkspaceView(page, "Market");
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
  await expect(page.getByTestId("pool-workspace-state")).toHaveCount(0);
});

test("pool workspace keeps truthful owner positions and history beneath the chart", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);
  const mobileView = await selectPoolWorkspaceView(page, "Positions");

  const workspace = page.getByTestId("canonical-pool-workspace");
  const panel = page.getByTestId("pool-workspace-owner-panel");
  const chart = page.getByTestId("swap-market-chart");
  await expect(panel).toBeVisible();
  if (!mobileView) {
    const geometry = await page.evaluate(() => {
      const chartBox = document.querySelector<HTMLElement>('[data-testid="swap-market-chart"]')?.getBoundingClientRect();
      const panelBox = document.querySelector<HTMLElement>('[data-testid="pool-workspace-owner-panel"]')?.getBoundingClientRect();
      return chartBox && panelBox ? { chartBottom: chartBox.bottom, chartLeft: chartBox.left, chartRight: chartBox.right, panelLeft: panelBox.left, panelRight: panelBox.right, panelTop: panelBox.top } : null;
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.panelTop).toBeGreaterThanOrEqual(geometry!.chartBottom);
    expect(Math.abs(geometry!.panelLeft - geometry!.chartLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry!.panelRight - geometry!.chartRight)).toBeLessThanOrEqual(1);
  }

  await expect(panel.getByRole("tab", { name: "Positions" })).toHaveAttribute("aria-selected", "true");
  const position = panel.getByTestId("pool-position-summary");
  await expect(position).toContainText("WNATIVE / USDC");
  await expect(position).toContainText("1 active bin");
  await expect(position).toContainText("In range");
  await expect(position).toContainText("USDC per WNATIVE");
  await expect(position).toContainText("Indexed liquidity");
  await expect(panel).not.toContainText("Limit Orders");

  await panel.getByRole("tab", { exact: true, name: "History" }).click();
  await expect(panel.getByRole("tab", { exact: true, name: "History" })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByTestId("pool-history-row")).toHaveCount(2);
  await expect(panel).toContainText("Added liquidity");
  await expect(panel).toContainText("Removed liquidity");
  await expect(panel).not.toContainText("Transaction history");

  await selectPoolWorkspaceView(page, "Trade");
  await workspace.getByRole("link", { name: "Create position" }).first().click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/create$`, "i"));
  await selectPoolWorkspaceView(page, "Positions");
  await expect(page.getByTestId("pool-workspace-owner-panel").getByRole("tab", { exact: true, name: "History" })).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("pool-workspace-owner-panel").getByRole("tab", { name: "Positions" }).click();
  await page.getByTestId("pool-position-manage-link").click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/manage$`, "i"));
  await expect(page.locator(".position-option")).toHaveCount(1);
  await expect(page.locator(".position-option").first().locator('input[type="checkbox"]')).toBeChecked();
  await selectPoolWorkspaceView(page, "Market");
  await expect(chart).toBeVisible();

  await page.setViewportSize({ height: 900, width: 320 });
  await page.getByRole("tab", { name: "Positions" }).first().click();
  await expect(page.getByTestId("pool-workspace-owner-panel").getByRole("tab", { name: "Positions" })).toBeVisible();
  await expect(page.getByTestId("pool-workspace-owner-panel").getByRole("tab", { exact: true, name: "History" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("pool owner panel does not query before connection and exposes a real empty state", async ({ page }) => {
  const rpc = await installMockRpc(page, { includePairs: true, includePositions: false });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await expect(panel).toContainText("No wallet connected");
  expect(rpc.snapshot().graphQueries.some((query) => query.includes("walletPositions"))).toBe(false);
  expect(rpc.snapshot().graphRequests.some((request) =>
    request.query.includes("WebPoolActivity") && request.variables?.owner != null
  )).toBe(false);

  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.reload();
  await connectWallet(page);
  await selectPoolWorkspaceView(page, "Positions");
  await expect(panel).toContainText("No liquidity in this pool");
  await expect(panel.getByRole("link", { name: "Create position" })).toHaveAttribute("href", `#/pools/${WNATIVE_USDC_PAIR.toLowerCase()}/create`);
  await panel.getByRole("tab", { exact: true, name: "History" }).click();
  await expect(panel).toContainText("No position history yet");
});

test("unified owner panel shows canonical accounting and claims without a fake claim action", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);

  const panel = page.getByTestId("pool-workspace-owner-panel");
  const accounting = panel.getByTestId("pool-position-accounting");
  await expect(accounting).toContainText("Current value");
  await expect(accounting).toContainText("$120");
  await expect(accounting).toContainText("Cost basis");
  await expect(accounting).toContainText("$100");
  await expect(accounting).toContainText("Unrealized P&L");
  await expect(accounting).toContainText("$20");
  await expect(accounting).toContainText("Realized P&L");
  await expect(accounting).toContainText("$5");
  await expect(accounting).toContainText("WNATIVE claim");
  await expect(accounting).toContainText("50 WNATIVE");
  await expect(accounting).toContainText("USDC claim");
  await expect(accounting).toContainText("70 USDC");
  await expect(panel).toContainText(/Fee growth is (?:already reflected|included)/);
  await expect(panel.getByRole("button", { name: /claim/i })).toHaveCount(0);
  await expect(panel.getByRole("link", { name: /claim/i })).toHaveCount(0);
});

test("quiet pools reconcile owner accounting against the current canonical analytics head", async ({ page }) => {
  const currentHeadHash = `0x${"2".repeat(64)}` as const;
  const lastPoolEventHash = `0x${"1".repeat(64)}` as const;
  const rpc = await installMockRpc(page, {
    analyticsAsOfBlock: 42n,
    analyticsHeadHash: currentHeadHash,
    blockHash: currentHeadHash,
    blockNumber: 42n,
    includePairs: true,
    includePositions: true,
    poolStateAsOfBlock: 40n,
    poolStateAsOfBlockHash: lastPoolEventHash
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await expect(panel.getByTestId("pool-owner-accounting-notice")).toHaveCount(0);
  await expect(panel.getByTestId("pool-position-manage-link")).toHaveAttribute(
    "href",
    new RegExp(`^#/pools/${WNATIVE_USDC_PAIR.toLowerCase()}/manage\\?`)
  );
  const pinnedActiveIdCalls = rpc.snapshot().ethCalls.filter((call) => call.functionName === "getActiveId");
  expect(pinnedActiveIdCalls.some((call) => call.blockTag === "0x2a")).toBe(true);
});

test("unified owner accounting keeps partial values honest and blocks a head-reconciling manage handoff", async ({ page }) => {
  await installMockRpc(page, {
    analyticsAsOfBlock: 41n,
    analyticsPartialHistory: true,
    blockNumber: 42n,
    includePairs: true,
    includePositions: true,
    indexerBlockNumber: 42n
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);

  const panel = page.getByTestId("pool-workspace-owner-panel");
  const accounting = panel.getByTestId("pool-position-accounting");
  const notice = panel.getByTestId("pool-owner-accounting-notice");
  await expect(accounting).toContainText("Current value");
  await expect(accounting).toContainText("$120");
  await expect(accounting).toContainText("Cost basis");
  await expect(accounting).toContainText("Unavailable");
  await expect(accounting).toContainText("50 WNATIVE");
  await expect(accounting).toContainText("70 USDC");
  await expect(notice).toContainText(/partial|reconcil/i);
  await expect(panel.getByTestId("pool-position-manage-link")).toHaveCount(0);
});

test("same-height analytics from a different canonical hash cannot enable position management", async ({ page }) => {
  await installMockRpc(page, {
    analyticsHeadHash: `0x${"33".repeat(32)}`,
    blockHash: `0x${"22".repeat(32)}`,
    includePairs: true,
    includePositions: true
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await expect(panel.getByTestId("pool-owner-accounting-notice")).toContainText(/canonical head|reconcil/i);
  await expect(panel.getByTestId("pool-position-accounting")).toContainText("Range unknown");
  await expect(panel.getByTestId("pool-position-manage-link")).toHaveCount(0);
});

test("canonical out-of-range bins stay truthful and keep management pool-scoped", async ({ page }) => {
  await installMockRpc(page, {
    analyticsBinOffset: 10,
    includePairs: true,
    includePositions: true
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await expect(panel.getByTestId("pool-owner-accounting-notice")).toHaveCount(0);
  await expect(panel.getByTestId("pool-position-accounting")).toContainText("Out of range");
  await expect(panel.getByTestId("pool-position-manage-link")).toHaveAttribute(
    "href",
    `#/pools/${WNATIVE_USDC_PAIR.toLowerCase()}/manage`
  );
});

test("unified owner panel preserves a truthful transferred-position state", async ({ page }) => {
  await installMockRpc(page, {
    analyticsTransferred: true,
    includePairs: true,
    includePositions: true
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await expect(panel.getByTestId("pool-owner-accounting-notice")).toContainText(/reconcil|transferred|no remaining/i);
  await expect(panel.getByTestId("pool-position-accounting")).toContainText("Current value");
  await expect(panel).toContainText(/transferred|no remaining/i);
  await expect(panel.getByTestId("pool-position-manage-link")).toHaveCount(0);
  await expect(panel).not.toContainText("$0 P&L");
});

test("unified owner panel fails closed for a foreign owner portfolio response", async ({ page }) => {
  await installMockRpc(page, {
    includePairs: true,
    includePositions: true,
    ownerPositionResponseOwner: "0x0000000000000000000000000000000000000001"
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);
  await selectPoolWorkspaceView(page, "Positions");

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await expect(panel.getByRole("alert")).toContainText("Position bins could not load");
  await expect(panel.getByRole("alert")).toContainText(/another owner|owner/i);
  await expect(panel.getByTestId("pool-position-manage-link")).toHaveCount(0);
});

test("unified owner panel ignores canonical wallet positions from another pool", async ({ page }) => {
  await installMockRpc(page, {
    includePairs: true,
    includePositions: true,
    ownerPositionResponsePair: SECOND_WNATIVE_USDC_PAIR
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);
  await selectPoolWorkspaceView(page, "Positions");

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await expect(panel).toContainText("No liquidity in this pool");
  await expect(panel.getByRole("link", { name: "Create position" })).toHaveAttribute(
    "href",
    `#/pools/${WNATIVE_USDC_PAIR.toLowerCase()}/create`
  );
  await expect(panel.getByTestId("pool-position-manage-link")).toHaveCount(0);
});

test("owner history loads older pool rows without depending on the global activity cap", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: true, positionHistoryCount: 17 });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);
  await selectPoolWorkspaceView(page, "Positions");

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await panel.getByRole("tab", { exact: true, name: "History" }).click();
  await expect(panel.getByTestId("pool-history-row")).toHaveCount(12);
  await expect(panel.getByTestId("pool-history-row").first()).toContainText("10 WNATIVE");
  await expect(panel.getByTestId("pool-history-row").first()).toContainText("20 USDC");
  await expect(panel).not.toContainText(/history is partial|missing matching liquidity details/i);
  await expect(panel).not.toContainText("Block 984");
  await panel.getByTestId("pool-history-load-more").click();
  await expect(panel.getByTestId("pool-history-row")).toHaveCount(17);
  await expect(panel).toContainText("Block 984");
  await expect(panel.getByTestId("pool-history-load-more")).toHaveCount(0);
});

test("pool activity is pair-scoped and switches between wallet-only and all activity", async ({ page }) => {
  const rpc = await installMockRpc(page, { includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);
  await selectPoolWorkspaceView(page, "Positions");

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await panel.getByRole("tab", { exact: true, name: "History" }).click();
  await panel.getByRole("tab", { name: "Pool activity" }).click();
  const feed = panel.getByTestId("pool-activity-feed");
  const filter = panel.getByTestId("pool-activity-wallet-filter");
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(feed.getByTestId("pool-activity-row")).toHaveCount(2);
  await expect(feed).not.toContainText("Swap");
  await expect(feed).toContainText(/Added liquidity|Deposit/i);
  await expect(feed).toContainText(/Removed liquidity|Withdraw/i);
  await expect.poll(() => rpc.snapshot().graphRequests.some((request) =>
    request.query.includes("WebPoolActivity") &&
    request.variables?.owner?.toLowerCase() === DEFAULT_ACCOUNT.toLowerCase()
  )).toBe(true);
  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "false");
  await expect(feed.getByTestId("pool-activity-row")).toHaveCount(5);
  await expect(feed).toContainText("Swap");
  await expect(feed).toContainText(/Removed liquidity|Withdraw/i);
  await expect.poll(() => rpc.snapshot().graphRequests.some((request) =>
    request.query.includes("WebPoolActivity") &&
    request.variables?.pair?.toLowerCase() === WNATIVE_USDC_PAIR.toLowerCase() &&
    request.variables?.owner == null
  )).toBe(true);
});

test("wallet activity exposes partial owner-history pagination instead of presenting a complete feed", async ({ page }) => {
  await installMockRpc(page, {
    includePairs: true,
    includePositions: true,
    positionHistoryCount: 101,
    positionHistoryFailAtSkip: 100
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);
  await selectPoolWorkspaceView(page, "Positions");

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await panel.getByRole("tab", { exact: true, name: "History" }).click();
  await panel.getByRole("tab", { name: "Pool activity" }).click();
  const feed = panel.getByTestId("pool-activity-feed");
  await expect(feed).toContainText(/pagination capped at 1 page/i);
  await expect(feed.getByTestId("pool-activity-row")).toHaveCount(100);
  await expect(feed).toContainText("Latest 100 events");
});

test("mobile position selection opens a usable manage task with the exact bins preselected", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 320 });
  await installMockRpc(page, { analyticsBinCount: 2, includePairs: true, includePositions: true, lbApproved: true, ownerPositionCount: 2 });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);

  await page.getByRole("tab", { name: "Positions" }).first().click();
  const panel = page.getByTestId("pool-workspace-owner-panel");
  const manageLink = panel.getByTestId("pool-position-manage-link");
  await expect(manageLink).toHaveAttribute("href", /manageOwner=.*manageBins=8388608%2C8388609/i);
  await manageLink.click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/manage\\?.*manageBins=8388608%2C8388609`, "i"));
  const picker = page.getByRole("group", { name: "Positions" }).first();
  await expect(picker.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(picker.locator('input[type="checkbox"]:checked')).toHaveCount(2);
  await expect(page.locator("#remove-percent-slider")).toBeVisible();
  await expect(page.locator("#remove-percent-slider")).toBeEnabled();
  await page.getByRole("group", { name: "Withdrawal percentage presets" }).getByRole("button", { name: "50%" }).click();
  await expect(page.locator("#remove-percent")).toHaveValue("50");
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(4_000);
});

test("manage handoff survives fresh navigation with a new-tab-safe exact owner-scoped URL", async ({ page }) => {
  await installMockRpc(page, {
    analyticsBinCount: 2,
    includePairs: true,
    includePositions: true,
    lbApproved: true,
    ownerPositionCount: 2
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);

  const manageLink = page.getByTestId("pool-workspace-owner-panel").getByTestId("pool-position-manage-link");
  const manageHref = await manageLink.getAttribute("href");
  expect(manageHref).toMatch(/manageOwner=.*manageBins=8388608%2C8388609/i);

  await page.goto(new URL(manageHref!, page.url()).href);
  await connectWallet(page);

  const picker = page.getByRole("group", { name: "Positions" }).first();
  await expect(picker.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(picker.locator('input[type="checkbox"]:checked')).toHaveCount(2);
  await expect(page.getByTestId("manage-position-selection-notice")).toHaveCount(0);
});

test("manage handoff refreshes exact bins across create-to-manage and query-only navigation", async ({ page }) => {
  await installMockRpc(page, {
    analyticsBinCount: 2,
    includePairs: true,
    includePositions: true,
    lbApproved: true,
    ownerPositionCount: 2
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await connectWallet(page);
  await selectPoolWorkspaceView(page, "Positions");

  const manageLink = page.getByTestId("pool-workspace-owner-panel").getByTestId("pool-position-manage-link");
  await manageLink.click();
  const picker = page.getByRole("group", { name: "Positions" }).first();
  await expect(page).toHaveURL(/\/manage\?.*manageBins=8388608%2C8388609/i);
  await expect(picker.locator('input[type="checkbox"]:checked')).toHaveCount(2);

  await page.evaluate(({ owner, pair, binId }) => {
    window.location.hash = `#/pools/${pair}/manage?manageOwner=${owner}&manageBins=${binId}`;
  }, {
    binId: TEST_ACTIVE_ID + 1,
    owner: DEFAULT_ACCOUNT,
    pair: WNATIVE_USDC_PAIR
  });
  await expect(page).toHaveURL(new RegExp(`manageBins=${TEST_ACTIVE_ID + 1}$`, "i"));
  await expect(picker.locator('input[type="checkbox"]:checked')).toHaveCount(1);
  await expect(picker.locator(".position-option").filter({ hasText: `Bin ${TEST_ACTIVE_ID + 1}` }).locator('input[type="checkbox"]')).toBeChecked();
  await expect(page.getByTestId("manage-position-selection-notice")).toHaveCount(0);
});

test("manage handoff waits for fresh positions and recovers when intended bins disappeared", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    includePairs: true,
    includePositions: true,
    lbApproved: true,
    ownerPositionCount: 1
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/manage`);
  await connectWallet(page);
  await expect(page.locator(".position-option")).toContainText(`Bin ${TEST_ACTIVE_ID}`);

  await page.getByRole("link", { exact: true, name: "Swap" }).click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/swap`, "i"));
  const positionRequestCount = () => rpc.snapshot().graphRequests.filter((request) =>
    request.query.includes("OwnerPairPositions")
  ).length;
  const requestsBeforeHandoff = positionRequestCount();
  rpc.update({ activeId: TEST_ACTIVE_ID + 1, indexerDelayMs: 3_000 });
  const manageHash =
    `#/pools/${WNATIVE_USDC_PAIR}/manage?manageOwner=${DEFAULT_ACCOUNT}&manageBins=${TEST_ACTIVE_ID}`;
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, manageHash);

  await expect(page).toHaveURL(new RegExp(`manageBins=${TEST_ACTIVE_ID}$`, "i"));
  await expect.poll(positionRequestCount).toBeGreaterThan(requestsBeforeHandoff);
  expect(await page.getByTestId("liquidity-remove-button").isDisabled()).toBe(true);
  const notice = page.getByTestId("manage-position-selection-notice");
  await expect(notice).toContainText("no longer present in the refreshed index");
  await expect(page.locator(".position-option")).toContainText(`Bin ${TEST_ACTIVE_ID + 1}`);
  await expect(page.locator(".position-option").locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(page.getByTestId("liquidity-remove-button")).toBeDisabled();

  rpc.update({ activeId: TEST_ACTIVE_ID, indexerDelayMs: 0 });
  await notice.getByTestId("manage-position-selection-retry").click();
  await expect(page.locator(".position-option")).toContainText(`Bin ${TEST_ACTIVE_ID}`);
  await expect(page.locator(".position-option").locator('input[type="checkbox"]')).toBeChecked();
  await expect(notice).toHaveCount(0);
});

test("mobile workspace isolates Market, Trade, and Positions while preserving task drafts", async ({ page }) => {
  await page.setViewportSize({ height: 760, width: 320 });
  await installMockRpc(page, { includePairs: true, includePositions: true, lbApproved: true, positionHistoryCount: 48 });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await connectWallet(page);

  const workspace = page.getByTestId("canonical-pool-workspace");
  const views = page.getByRole("tablist", { name: "Pool workspace views" });
  const marketTab = views.getByRole("tab", { name: "Market" });
  const tradeTab = views.getByRole("tab", { name: "Trade" });
  const positionsTab = views.getByRole("tab", { name: "Positions" });

  await expect(tradeTab).toHaveAttribute("aria-selected", "true");
  await expect(marketTab).toHaveAttribute("aria-controls", "pool-mobile-market-panel pool-mobile-market-metadata");
  await expect(page.locator("#pool-mobile-market-panel")).toHaveAttribute("role", "tabpanel");
  await expect(page.locator("#liquidity-add")).toHaveAttribute("role", "tabpanel");
  await expect(page.locator("#pool-mobile-positions-panel")).toHaveAttribute("role", "tabpanel");
  await expect(page.getByTestId("liquidity-range-editor")).toBeVisible();
  await expect(page.getByTestId("swap-market-chart")).toBeHidden();
  await expect(page.getByTestId("pool-workspace-owner-panel")).toBeHidden();
  await page.getByTestId("liquidity-amount-x").fill("0.25");
  const createActionGeometry = await page.getByTestId("liquidity-add-button").evaluate((button) => {
    const panel = button.closest<HTMLElement>("#liquidity-add")?.getBoundingClientRect();
    const action = button.getBoundingClientRect();
    return { actionBottom: action.bottom, actionTop: action.top, panelBottom: panel?.bottom, panelTop: panel?.top };
  });
  expect(createActionGeometry.actionBottom).toBeLessThanOrEqual(760);
  expect(createActionGeometry.actionTop).toBeGreaterThanOrEqual(0);

  await marketTab.click();
  await expect(marketTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
  await expect(page.getByTestId("liquidity-range-editor")).toBeHidden();
  const metadataToggle = page.getByRole("button", { name: /Pool market/ });
  await expect(metadataToggle).toHaveAttribute("aria-expanded", "false");
  await metadataToggle.click();
  await expect(metadataToggle).toHaveAttribute("aria-expanded", "true");

  await positionsTab.click();
  await expect(page.getByTestId("pool-workspace-owner-panel")).toBeVisible();
  await expect(page.getByTestId("swap-market-chart")).toBeHidden();
  const ownerPositions = page.getByTestId("pool-workspace-owner-panel").getByRole("tab", { name: "Positions" });
  await ownerPositions.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("pool-workspace-owner-panel").getByRole("tab", { exact: true, name: "History" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(ownerPositions).toHaveAttribute("aria-selected", "true");

  await tradeTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(marketTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(positionsTab).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("pool-position-manage-link").click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/manage$`, "i"));
  await expect(tradeTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("liquidity-remove-button")).toBeInViewport();

  await page.getByRole("link", { name: "Create position" }).first().click();
  await expect(page.getByTestId("liquidity-amount-x")).toHaveValue("0.25");
  await expect.poll(() => page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth
  }))).toEqual({ height: expect.any(Number), noOverflow: true });
  expect(await workspace.evaluate((element) => element.ownerDocument.documentElement.scrollHeight)).toBeLessThan(4_000);
});

test("mobile market view keeps the chart and pool metadata reachable without document overflow", async ({ page }) => {
  await page.setViewportSize({ height: 760, width: 320 });
  await installMockRpc(page, { includePairs: true, includePositions: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);

  const views = page.getByRole("tablist", { name: "Pool workspace views" });
  const marketTab = views.getByRole("tab", { name: "Market" });
  await marketTab.click();
  await expect(marketTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();

  const metadataToggle = page.getByRole("button", { name: /Pool market/ });
  await metadataToggle.click();
  await expect(metadataToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("pool-workspace-rail")).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(4_000);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

for (const width of [820, 1000] as const) {
  test(`tablet prioritizes chart, task, and positions before collapsed metadata at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ height: 900, width });
    await installMockRpc(page, { includePairs: true });
    await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);

    const rail = page.getByTestId("pool-workspace-rail");
    const toggle = rail.getByRole("button", { name: /Pool market/ });
    await expect(page.getByRole("tablist", { name: "Pool workspace views" })).toHaveCount(0);
    await expect(page.locator("#pool-mobile-market-panel[role=tabpanel], #liquidity-add[role=tabpanel], #pool-mobile-positions-panel[role=tabpanel]")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const geometry = await page.evaluate(() => {
      const chart = document.querySelector<HTMLElement>('[data-testid="swap-market-chart"]')?.getBoundingClientRect();
      const task = document.querySelector<HTMLElement>("#liquidity-add")?.getBoundingClientRect();
      const positions = document.querySelector<HTMLElement>("#pool-mobile-positions-panel")?.getBoundingClientRect();
      const rail = document.querySelector<HTMLElement>('[data-testid="pool-workspace-rail"]')?.getBoundingClientRect();
      return chart && task && positions && rail ? {
        chartBottom: chart.bottom,
        chartTop: chart.top,
        positionsBottom: positions.bottom,
        positionsTop: positions.top,
        railTop: rail.top,
        taskBottom: task.bottom,
        taskTop: task.top
      } : null;
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.chartTop).toBeLessThan(geometry!.taskTop);
    expect(geometry!.chartBottom).toBeLessThanOrEqual(geometry!.taskTop);
    expect(geometry!.taskBottom).toBeLessThanOrEqual(geometry!.positionsTop);
    expect(geometry!.positionsBottom).toBeLessThanOrEqual(geometry!.railTop);
    await toggle.click();
    await expect(rail.getByText("Current pool price")).toBeVisible();
  });
}

test("pool task actions and invalid range fields expose announced safety state", async ({ page }) => {
  await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);

  await expect(page.getByTestId("swap-submit-button")).toHaveAttribute("aria-describedby", "swap-failure-state");
  await expect(page.locator("#swap-failure-state")).toHaveAttribute("role", /alert|status/);

  await page.getByRole("link", { name: "Create position" }).first().click();
  await expect(page.getByTestId("liquidity-add-button")).toHaveAttribute("aria-describedby", "liquidity-add-status");
  const minimumPrice = page.getByLabel("Min USDC per WNATIVE");
  await minimumPrice.fill("not-a-price");
  await minimumPrice.blur();
  await expect(minimumPrice).toHaveAttribute("aria-invalid", "true");
  await expect(minimumPrice).toHaveAttribute("aria-errormessage", "liquidity-range-error");
  await expect(page.locator("#liquidity-range-error")).toHaveAttribute("role", "alert");

  await page.getByRole("link", { name: "Manage" }).first().click();
  await expect(page.getByTestId("liquidity-remove-button")).toHaveAttribute("aria-describedby", "liquidity-remove-status");
  await expect(page.locator("#liquidity-remove-status")).toHaveAttribute("role", /alert|status/);
});

test("mobile owner history stays internally scrollable when every bounded row is revealed", async ({ page }) => {
  await page.setViewportSize({ height: 760, width: 320 });
  await installMockRpc(page, { includePairs: true, includePositions: true, positionHistoryCount: 120 });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);
  await page.getByRole("tablist", { name: "Pool workspace views" }).getByRole("tab", { name: "Positions" }).click();

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await panel.getByRole("tab", { exact: true, name: "History" }).click();
  const loadMore = panel.getByTestId("pool-history-load-more");
  for (let pageIndex = 0; pageIndex < 12 && await loadMore.count() > 0; pageIndex += 1) await loadMore.click();
  await expect(panel.getByTestId("pool-history-row")).toHaveCount(120);
  const geometry = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>("#pool-owner-history-panel");
    return body ? { clientHeight: body.clientHeight, documentHeight: document.documentElement.scrollHeight, scrollHeight: body.scrollHeight } : null;
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.scrollHeight).toBeGreaterThan(geometry!.clientHeight);
  expect(geometry!.documentHeight).toBeLessThan(4_000);
});

test("create position range editor layers exact distribution over indexed pool reserves", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ height: 1000, width: 1600 });
  await installMockRpc(page, {
    includePairs: true,
    poolBinCount: 9,
    priceQ128ByBin: {
      [String(TEST_ACTIVE_ID - 2)]: TEST_Q128,
      [String(TEST_ACTIVE_ID - 1)]: 2n * TEST_Q128,
      [String(TEST_ACTIVE_ID)]: 3n * TEST_Q128,
      [String(TEST_ACTIVE_ID + 1)]: 4n * TEST_Q128,
      [String(TEST_ACTIVE_ID + 2)]: 5n * TEST_Q128
    }
  });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);

  const editor = page.getByTestId("liquidity-range-editor");
  const chart = editor.getByLabel("Liquidity bin distribution");
  const actionSummary = page.getByTestId("liquidity-action-summary");
  const transactionReview = page.getByTestId("liquidity-transaction-review");
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Pool WNATIVE");
  await expect(editor).toContainText("Pool USDC");
  await expect(editor).toContainText("New position");
  await expect(chart.locator(".range-editor-bin > i")).not.toHaveCount(0);
  const retainedActiveBin = chart.locator(`.range-editor-bin[data-bin-id="${TEST_ACTIVE_ID}"]`);
  await retainedActiveBin.evaluate((element) => { element.setAttribute("data-retained-test-node", "true"); });
  const motion = await chart.locator(".range-editor-bin > i").first().evaluate((element) => ({
    animationDuration: getComputedStyle(element).animationDuration,
    reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    transitionDuration: getComputedStyle(element).transitionDuration
  }));
  expect(motion.reduced).toBe(true);
  for (const duration of [motion.animationDuration, motion.transitionDuration]) {
    const milliseconds = Number.parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1_000);
    expect(milliseconds).toBeLessThanOrEqual(0.01);
  }
  await expect(chart.getByRole("img")).toHaveCount(3);
  await expect(page.getByLabel("Min USDC per WNATIVE")).toBeVisible();
  await expect(page.getByLabel("Max USDC per WNATIVE")).toBeVisible();
  await expect(editor).toContainText("3 bins selected");
  await expect(page.locator("#range-lower-bin")).toHaveCount(0);
  await expect(editor.locator(".distribution-details")).toHaveCount(0);
  await expect(transactionReview).toBeVisible();
  await expect(transactionReview).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("liquidity-token-x-identity")).not.toBeVisible();
  await expect(page.getByTestId("liquidity-add-button")).toBeVisible();
  await expect(actionSummary).toContainText("Spot · 3 bins · Two-sided");
  await expect(actionSummary).toContainText("0.01 WNATIVE + 1 USDC");
  await transactionReview.getByText("Transaction review").click();
  await expect(page.getByTestId("liquidity-token-x-identity")).toBeVisible();
  await transactionReview.getByText("Transaction review").click();

  const lowerHandle = page.getByLabel("Lower range handle");
  const upperHandle = page.getByLabel("Upper range handle");
  await expect(lowerHandle).toHaveAttribute("aria-valuemin", "-16");
  await expect(lowerHandle).toHaveAttribute("aria-valuenow", "-1");
  await expect(upperHandle).toHaveAttribute("aria-valuenow", "1");
  await lowerHandle.scrollIntoViewIfNeeded();
  const lowerHandleBox = await lowerHandle.boundingBox();
  expect(lowerHandleBox).not.toBeNull();
  await lowerHandle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(lowerHandle).toHaveAttribute("aria-valuenow", "-2");
  await expect(retainedActiveBin).toHaveAttribute("data-retained-test-node", "true");
  const lowerThumbX = lowerHandleBox!.x + lowerHandleBox!.width / 2;
  const thumbY = lowerHandleBox!.y + lowerHandleBox!.height / 2;
  await page.mouse.move(lowerThumbX, thumbY);
  await page.mouse.down();
  await page.mouse.move(lowerThumbX - 36, thumbY, { steps: 4 });
  await page.mouse.up();
  await expect(lowerHandle).not.toHaveAttribute("aria-valuenow", "-1");
  await expect(upperHandle).toHaveAttribute("aria-valuenow", "1");
  await editor.getByRole("button", { name: "Reset" }).click();
  await expect(lowerHandle).toHaveAttribute("aria-valuenow", "-1");

  await editor.getByText("Advanced range controls").click();
  await expect(page.locator("#range-lower")).toBeVisible();
  await expect(page.locator("#range-lower-bin")).toHaveCount(0);
  await expect(page.locator("#range-upper-bin")).toHaveCount(0);
  await expect(editor.getByRole("button", { name: /inverse/i })).toHaveCount(0);
  const initialMinPrice = await page.getByLabel("Min USDC per WNATIVE").inputValue();
  const initialMaxPrice = await page.getByLabel("Max USDC per WNATIVE").inputValue();
  await lowerHandle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#range-lower")).toHaveValue("-2");
  await expect(page.getByLabel("Min USDC per WNATIVE")).not.toHaveValue(initialMinPrice);
  await expect(chart.getByRole("img")).toHaveCount(4);
  await upperHandle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#range-upper")).toHaveValue("2");
  await expect(page.getByLabel("Max USDC per WNATIVE")).not.toHaveValue(initialMaxPrice);
  await expect(chart.getByRole("img")).toHaveCount(5);
  await page.getByTestId("liquidity-strategy-curve").click();
  await expect(page.getByTestId("liquidity-strategy-curve")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("liquidity-strategy-bid-ask").click();
  await expect(page.getByTestId("liquidity-strategy-bid-ask")).toHaveAttribute("aria-pressed", "true");
  await expect(actionSummary).toContainText("Bid-Ask · 5 bins · Two-sided");
  await page.getByLabel("Narrow preset bin count").fill("69");
  await page.getByTestId("liquidity-preset-narrow").click();
  await expect(editor).toContainText("69 bins selected");
  await page.getByLabel("Narrow preset bin count").fill("70");
  await page.getByTestId("liquidity-preset-narrow").click();
  await expect(editor.getByRole("alert")).toContainText("between 1 and 69 bins");
  await expect(editor).toContainText("69 bins selected");
  const railGeometry = await page.evaluate(() => {
    const chartBox = document.querySelector<HTMLElement>('[data-testid="swap-market-chart"]')?.getBoundingClientRect();
    const panelBox = document.querySelector<HTMLElement>('#liquidity-add')?.getBoundingClientRect();
    const actionBox = document.querySelector<HTMLElement>('[data-testid="liquidity-add-button"]')?.getBoundingClientRect();
    return chartBox && panelBox && actionBox
      ? { actionBottom: actionBox.bottom, chartRight: chartBox.right, panelLeft: panelBox.left }
      : null;
  });
  expect(railGeometry).not.toBeNull();
  expect(railGeometry!.panelLeft).toBeGreaterThanOrEqual(railGeometry!.chartRight);
  expect(railGeometry!.actionBottom).toBeLessThanOrEqual(1000);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("connected create position preserves the edited source and fills only its paired ERC-20", async ({ page }) => {
  const pairedActiveId = TEST_ACTIVE_ID + 2_000;
  const rpc = await installMockRpc(page, {
    activeId: pairedActiveId,
    balance: 5n * ONE_TOKEN,
    includePairs: true,
    nativeBalance: 10n * ONE_TOKEN
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await connectWallet(page);

  const amountX = page.getByTestId("liquidity-amount-x");
  const amountY = page.getByTestId("liquidity-amount-y");
  const suggestion = page.getByTestId("liquidity-paired-fill");
  const apply = page.getByTestId("liquidity-paired-fill-apply");
  await expect(page.getByTestId("liquidity-balance-x")).toContainText("5");
  await expect(page.getByTestId("liquidity-balance-y")).toContainText("5");
  await expect(page.getByTestId("liquidity-balance-x")).not.toContainText("$");
  await expect(page.getByTestId("liquidity-balance-y")).not.toContainText("$");
  await amountX.fill("1.25");
  const initialY = await amountY.inputValue();
  await expect(suggestion).toHaveAttribute("data-state", "ready");
  await expect(apply).toHaveText("Fill USDC to balance");
  await expect(page.getByTestId("liquidity-paired-fill-status")).toContainText("clamped to its wallet balance");
  await expect(amountX).toHaveValue("1.25");
  await expect(amountY).toHaveValue(initialY);
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);

  await apply.click();
  await expect(suggestion).toHaveAttribute("data-state", "applied");
  await expect(amountX).toHaveValue("1.25");
  const pairedY = await amountY.inputValue();
  expect(pairedY).not.toBe(initialY);
  expect(Number(pairedY)).toBeGreaterThan(0);
  expect(Number(pairedY)).toBeLessThanOrEqual(5);
  await expect(page.getByTestId("liquidity-paired-fill-preview")).toContainText("WNATIVE");
  await expect(page.getByTestId("liquidity-paired-fill-preview")).toContainText("USDC");
  await expect(page.getByTestId("liquidity-paired-fill-status")).toContainText("No swap or Zap was performed");
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
  expect(rpc.snapshot().ethCalls.some(({ functionName }) => functionName.toLowerCase().includes("swap"))).toBe(false);

  await amountY.fill("2.5");
  const beforeInverseFillX = await amountX.inputValue();
  await expect(suggestion).toHaveAttribute("data-state", "ready");
  await expect(apply).toHaveText("Fill WNATIVE");
  await expect(page.getByTestId("liquidity-paired-fill-status")).toContainText("Nothing changes until you apply it");
  await apply.click();
  await expect(suggestion).toHaveAttribute("data-state", "applied");
  await expect(amountY).toHaveValue("2.5");
  const pairedX = await amountX.inputValue();
  expect(pairedX).not.toBe(beforeInverseFillX);
  expect(Number(pairedX)).toBeGreaterThan(0);
  expect(Number(pairedX)).toBeLessThanOrEqual(5);

  await page.getByTestId("liquidity-strategy-curve").click();
  await expect(suggestion).toHaveAttribute("data-state", "ready");
  await page.getByTestId("liquidity-strategy-spot").click();
  await expect(suggestion).toHaveAttribute("data-state", "ready");
  await apply.click();
  await expect(suggestion).toHaveAttribute("data-state", "applied");
  await page.getByLabel("Lower range handle").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(suggestion).toHaveAttribute("data-state", "ready");
  await page.keyboard.press("ArrowRight");
  await expect(suggestion).toHaveAttribute("data-state", "ready");

  await apply.click();
  await expect(suggestion).toHaveAttribute("data-state", "applied");
  rpc.update({ activeId: pairedActiveId + 1, blockNumber: 43n, indexerBlockNumber: 43n });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".range-editor-bin.active")).toHaveAttribute("data-bin-id", String(pairedActiveId + 1), { timeout: 15_000 });
  await expect(suggestion).toHaveAttribute("data-state", "ready");
  rpc.update({ activeId: pairedActiveId, blockNumber: 44n, indexerBlockNumber: 44n });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".range-editor-bin.active")).toHaveAttribute("data-bin-id", String(pairedActiveId), { timeout: 15_000 });
  await expect(suggestion).toHaveAttribute("data-state", "ready");

  await apply.click();
  await expect(suggestion).toHaveAttribute("data-state", "applied");
  rpc.update({ balance: 4n * ONE_TOKEN });
  await page.evaluate(() => window.__mockWalletControl.setAccounts(["0x1111111111111111111111111111111111111111"]));
  await expect(page.getByTestId("liquidity-balance-x")).toContainText("4", { timeout: 15_000 });
  await expect(suggestion).toHaveAttribute("data-state", "ready");
  rpc.update({ balance: 5n * ONE_TOKEN });
  await page.evaluate((account) => window.__mockWalletControl.setAccounts([account]), DEFAULT_ACCOUNT);
  await expect(page.getByTestId("liquidity-balance-x")).toContainText("5", { timeout: 15_000 });
  await expect(suggestion).toHaveAttribute("data-state", "ready");
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
  expect(rpc.snapshot().ethCalls.some(({ functionName }) => functionName.toLowerCase().includes("swap"))).toBe(false);
});

test("one-sided and native position suggestions fail safe without hidden swaps", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    balance: 5n * ONE_TOKEN,
    includePairs: true,
    nativeBalance: 10n * ONE_TOKEN
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await connectWallet(page);

  const suggestion = page.getByTestId("liquidity-paired-fill");
  const apply = page.getByTestId("liquidity-paired-fill-apply");
  await expect(suggestion).toHaveAttribute("data-state", "ready");
  await page.getByText("Advanced range controls").click();
  await page.locator("#range-lower").fill("1");
  await page.locator("#range-upper").fill("2");

  await expect(page.getByTestId("liquidity-range-mode")).toContainText("One-sided WNATIVE");
  await expect(page.getByTestId("liquidity-amount-y")).toBeDisabled();
  await expect(page.getByTestId("liquidity-amount-y")).toHaveValue("0");
  await expect(suggestion).toHaveAttribute("data-state", "one-sided");
  await expect(apply).toHaveText("No pair needed");
  await expect(apply).toBeDisabled();
  await expect(page.getByTestId("liquidity-paired-fill-status")).toContainText("No paired amount or swap is needed");
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
  expect(rpc.snapshot().ethCalls.some(({ functionName }) => functionName.toLowerCase().includes("swap"))).toBe(false);

  await page.getByRole("button", { name: "ETH · native" }).click();
  await expect(suggestion).toHaveAttribute("data-state", "native-review-required");
  await expect(apply).toBeDisabled();
  await expect(page.getByTestId("liquidity-paired-fill-status")).toContainText("will not spend the full ETH balance");
  await expect(page.getByTestId("liquidity-paired-fill-status")).toContainText("gas-reserved");
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("wallet read failures show unavailable balances and block paired fill", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, walletReadMode: "error" });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await connectWallet(page);

  await expect(page.getByTestId("liquidity-balance-x")).toHaveText("unavailable");
  await expect(page.getByTestId("liquidity-balance-y")).toHaveText("unavailable");
  await expect(page.getByTestId("liquidity-paired-fill-status")).toContainText("Wallet balances are unavailable");
  await expect(page.getByTestId("liquidity-paired-fill-apply")).toBeDisabled();
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

for (const viewport of [
  { label: "desktop", width: 1440, height: 900 },
  { label: "tablet", width: 820, height: 900 },
  { label: "mobile", width: 390, height: 844 }
] as const) {
  test(`create position keeps the range and guarded action reachable on ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await installMockRpc(page, { includePairs: true });
    await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);

    const editor = page.getByTestId("liquidity-range-editor");
    const apply = page.getByTestId("liquidity-paired-fill-apply");
    const add = page.getByTestId("liquidity-add-button");
    await expect(editor).toBeVisible();
    await expect(page.getByLabel("Lower range handle")).toBeVisible();
    await expect(page.getByLabel("Upper range handle")).toBeVisible();
    await expect(apply).toBeVisible();
    await add.scrollIntoViewIfNeeded();
    await expect(add).toBeVisible();
    const actionBox = await add.boundingBox();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(4_000);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("create position remains operable at 200 percent layout scale", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 640 });
  await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });

  const lowerHandle = page.getByLabel("Lower range handle");
  const upperHandle = page.getByLabel("Upper range handle");
  await lowerHandle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(lowerHandle).toHaveAttribute("aria-valuenow", "-2");
  await upperHandle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(upperHandle).toHaveAttribute("aria-valuenow", "2");
  const add = page.getByTestId("liquidity-add-button");
  await add.scrollIntoViewIfNeeded();
  await expect(add).toBeVisible();
  const actionBox = await add.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(900);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("manage position remains operable at 200 percent layout scale", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 640 });
  await installMockRpc(page, { includePairs: true, includePositions: true, lbApproved: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/manage`);
  await connectWallet(page);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });

  const percentage = page.locator("#remove-percent-slider");
  await percentage.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#remove-percent")).toHaveValue("99.99");
  await page.locator("#remove-percent").fill("50");
  await expect(percentage).toHaveValue("50");
  const remove = page.getByTestId("liquidity-remove-button");
  await remove.scrollIntoViewIfNeeded();
  await expect(remove).toBeVisible();
  const actionBox = await remove.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(900);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("pool-scoped swap presents a compact market task rail with its guarded action in view", async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1600 });
  await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);

  const chart = page.getByTestId("swap-market-chart");
  const panel = page.getByTestId("swap-task-panel");
  const market = page.getByTestId("swap-market-lock");
  const routeDisclosure = page.getByTestId("swap-route-disclosure");
  const action = page.getByTestId("swap-submit-button");

  await expect(chart).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(market).toContainText("WNATIVE / USDC");
  await expect(market).toContainText("10 bps/bin");
  await expect(page.getByTestId("swap-pool-search")).toHaveCount(0);
  await expect(panel.locator(".swap-asset-card")).toHaveCount(2);
  await expect(routeDisclosure).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("swap-route-mode-summary")).toHaveText("Exact selected pool");
  await expect(panel.getByRole("group", { name: "Swap routing choice" })).not.toBeVisible();
  const routeSummary = routeDisclosure.locator("summary");
  await routeSummary.focus();
  await page.keyboard.press("Enter");
  await expect(routeDisclosure).toHaveAttribute("open", "");
  await expect(panel.getByRole("group", { name: "Swap routing choice" })).toBeVisible();
  await routeSummary.focus();
  await page.keyboard.press("Enter");
  await expect(routeDisclosure).not.toHaveAttribute("open", "");
  await expect(panel.getByRole("region", { name: "Trade quote" })).toBeVisible();
  await expect(page.getByTestId("swap-review-details")).toContainText("Market and approval review");
  await expect(action).toBeVisible();

  const geometry = await page.evaluate(() => {
    const chartBox = document.querySelector<HTMLElement>('[data-testid="swap-market-chart"]')?.getBoundingClientRect();
    const panelBox = document.querySelector<HTMLElement>('[data-testid="swap-task-panel"]')?.getBoundingClientRect();
    const actionBox = document.querySelector<HTMLElement>('[data-testid="swap-submit-button"]')?.getBoundingClientRect();
    return chartBox && panelBox && actionBox
      ? { actionBottom: actionBox.bottom, chartRight: chartBox.right, panelLeft: panelBox.left }
      : null;
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.panelLeft).toBeGreaterThanOrEqual(geometry!.chartRight);
  expect(geometry!.actionBottom).toBeLessThanOrEqual(1000);
});

test("canonical pool swap submits through only its selected pair and bin step", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    includePairs: true
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);

  const routeDisclosure = page.getByTestId("swap-route-disclosure");
  await expect(routeDisclosure).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("swap-route-mode-summary")).toHaveText("Exact selected pool");
  await routeDisclosure.locator("summary").click();
  await expect(routeDisclosure.getByRole("button", { name: "Exact selected pool" })).toHaveAttribute("aria-pressed", "true");
  await routeDisclosure.locator("summary").click();

  const technicalReview = page.getByTestId("swap-review-details");
  await technicalReview.locator("summary").click();
  await expect(page.getByTestId("swap-selected-market-identity")).toContainText(`${WNATIVE_USDC_PAIR} · bin step 10`);
  await expect(page.getByTestId("swap-route-steps").locator(".route-step")).toHaveCount(1);
  expect(rpc.snapshot().ethCalls.some((call) => call.functionName === "getSwapOut")).toBe(true);
  expect(rpc.snapshot().ethCalls.some((call) => call.functionName === "findBestPathFromAmountIn")).toBe(false);

  await submitReviewedSwap(page);
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  const transaction = (await readMockWallet(page)).sentTransactions[0] as { data: Hex };
  const decoded = decodeFunctionData({ abi: lbRouterAbi, data: transaction.data });
  expect(decoded.functionName).toBe("swapExactTokensForTokens");
  if (decoded.functionName !== "swapExactTokensForTokens") throw new Error("Unexpected canonical pool swap function");
  expect(decoded.args[2].tokenPath).toEqual([WNATIVE, USDC]);
  expect(decoded.args[2].pairBinSteps).toEqual([10n]);
  expect(decoded.args[2].versions).toEqual([3]);
});

test("canonical best-route disclosure invalidates an in-flight exact-pool review", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    includePairs: true,
    quotePreferMultiHop: true,
    simulationDelayMs: 500
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();

  await page.getByTestId("swap-submit-button").click();
  await expect.poll(() => rpc.snapshot().ethCalls.filter((call) => call.functionName === "swapExactTokensForTokens").length).toBeGreaterThan(0);
  const routeDisclosure = page.getByTestId("swap-route-disclosure");
  await routeDisclosure.locator("summary").click();
  await routeDisclosure.getByRole("button", { name: "Best route" }).click();

  await expect(page.getByTestId("swap-route-mode-summary")).toHaveText("Best route");
  await expect(page.getByTestId("swap-failure-state")).toContainText("Execution context changed during simulation; refresh the quote and try again");
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

for (const viewport of [
  { height: 1000, label: "desktop", width: 1600 },
  { height: 900, label: "tablet", width: 900 },
  { height: 760, label: "mobile", width: 320 }
] as const) {
  test(`canonical swap keeps its action and blocker reachable on ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await installMockRpc(page, { includePairs: true });
    await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);

    const routeDisclosure = page.getByTestId("swap-route-disclosure");
    const actionDock = page.locator(".swap-action-dock");
    const action = page.getByTestId("swap-submit-button");
    const blocker = page.getByTestId("swap-failure-state");
    await expect(routeDisclosure).not.toHaveAttribute("open", "");
    await actionDock.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
    await expect(action).toContainText("Connect wallet");
    await expect(blocker).toBeVisible();
    await expect(action).toBeInViewport();
    await expect(blocker).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(4_000);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("canonical swap route disclosure and action remain keyboard-usable at 200 percent layout zoom", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 640 });
  await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect.poll(() => page.evaluate(() => ({ width: window.innerWidth, zoom: document.documentElement.style.zoom }))).toEqual({ width: 640, zoom: "2" });

  const routeDisclosure = page.getByTestId("swap-route-disclosure");
  const routeSummary = routeDisclosure.locator("summary");
  await routeSummary.scrollIntoViewIfNeeded();
  await routeSummary.focus();
  await page.keyboard.press("Enter");
  await expect(routeDisclosure).toHaveAttribute("open", "");
  await page.keyboard.press("Tab");
  await expect(routeDisclosure.getByRole("button", { name: "Exact selected pool" })).toBeFocused();
  await page.keyboard.press("Tab");
  const bestRoute = routeDisclosure.getByRole("button", { name: "Best route" });
  await expect(bestRoute).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("swap-route-mode-summary")).toHaveText("Best route");
  await routeSummary.focus();
  await page.keyboard.press("Enter");
  await expect(routeDisclosure).not.toHaveAttribute("open", "");

  const actionDock = page.locator(".swap-action-dock");
  await actionDock.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("swap-submit-button")).toBeInViewport();
  await expect(page.getByTestId("swap-failure-state")).toBeInViewport();
  await expect.poll(() => page.evaluate(() => {
    const root = document.documentElement;
    if (root.scrollWidth <= root.clientWidth) return [];
    return [...document.body.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.right > root.clientWidth + 1 || rect.left < -1 || element.scrollWidth > element.clientWidth + 1;
      })
      .slice(0, 12)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${element.tagName.toLowerCase()}.${element.className || "-"} rect=${rect.left.toFixed(0)}..${rect.right.toFixed(0)} own=${element.clientWidth}/${element.scrollWidth}`;
      });
  })).toEqual([]);
});

test("unified pool workspace preserves URL filters, analytics, actions, and accessible charts", async ({ page }) => {
  const analyticsUrls: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("http://127.0.0.1:8787")) analyticsUrls.push(request.url());
  });
  await installMockRpc(page, { includePairs: true, includePositions: true, poolBinCount: 5, poolCount: 2 });
  await installMockDiscoveryProjection(page);
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });

  await page.goto("/#/pools?q=WNATIVE&sort=tvl&page=1&mine=1");
  const mine = page.getByRole("button", { name: "My liquidity" });
  await expect(mine).toBeEnabled();
  await expect(mine).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("owner-pool-filter-status")).toContainText("Connect a wallet");
  await mine.click();
  await expect(page).not.toHaveURL(/mine=1/);

  await connectWallet(page);
  await mine.click();
  await expect(page).toHaveURL(/q=WNATIVE/);
  await expect(page).toHaveURL(/sort=tvl/);
  await expect(page).toHaveURL(/mine=1/);
  await expect(page.getByTestId("pool-analytics-state")).toHaveCount(0);
  expect(analyticsUrls.length).toBeGreaterThan(0);
  expect(analyticsUrls.every((url) => url === "http://127.0.0.1:8787/graphql")).toBe(true);
  const firstDiscoveryRow = page.getByTestId("pool-discovery-row").first();
  await expect(firstDiscoveryRow).toContainText("$490K");
  await expect(firstDiscoveryRow).toContainText("$119K");
  await expect(firstDiscoveryRow).toContainText("$239");
  await expect(firstDiscoveryRow).toContainText("$12.35M");
  await expect(firstDiscoveryRow).toContainText("160");

  const poolLink = page.locator(".pool-pair-link").first();
  const poolHref = await poolLink.getAttribute("href");
  expect(poolHref).not.toBeNull();
  expect(poolHref).toContain("q=WNATIVE");
  expect(poolHref).toContain("sort=tvl");
  expect(poolHref).toContain("mine=1");
  await poolLink.click();

  await expect(page).toHaveURL(/#\/pools\/.+\?q=WNATIVE/);
  await expect(page.getByTestId("pool-workspace-state")).toHaveCount(0);
  await expandPoolMetadata(page);
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars > span")).toHaveCount(33);
  await expect(page.getByTestId("pool-detail-analytics-state")).toHaveCount(0);
  await expect(page.getByTestId("pool-candle-workspace")).toHaveCount(0);
  await expect(page.getByTestId("pool-bin-distribution-table")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Market overview" })).toHaveCount(0);
  await expect(page.getByTestId("pool-action-back")).toHaveAttribute("href", /#\/pools\?q=WNATIVE/);
  await expect(page.locator("#liquidity-pair")).toHaveCount(0);
  await page.getByTestId("pool-action-back").click();
  await expect(page).toHaveURL(/#\/pools\?/);
  await expect(page).toHaveURL(/q=WNATIVE/);
  await expect(page).toHaveURL(/sort=tvl/);
  await expect(page).toHaveURL(/mine=1/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("pool economics uses one pinned active ID and labels every market data source", async ({ page }) => {
  const pinnedActiveId = 8_388_611;
  await installMockRpc(page, {
    activeId: pinnedActiveId,
    includePairs: true,
    omitActivePoolBin: true,
    pairRuntimeActiveId: pinnedActiveId,
    poolBinCount: 5
  });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await expandPoolMetadata(page);

  const fees = page.getByTestId("pool-fee-economics");
  await expect(fees).toContainText("Current active-bin fees");
  await expect(fees).toContainText("RPC block 42");
  await expect(fees).toContainText("Base fee");
  await expect(fees).toContainText("Variable fee");
  await expect(fees).toContainText("Current active-bin total");
  await expect(fees).toContainText("Protocol share of fee");
  await expect(fees).toContainText("LP net fee rate");
  await expect(page.getByTestId("pool-workspace-rail")).toContainText("Indexed reserves · snapshot block 42 · last pool update block 42");
  await expect(page.getByTestId("pool-workspace-rail")).toContainText("Analytics · block 42");
  const priceBlock = page.locator(".pool-rail-price-block");
  await expect(priceBlock).toContainText("USDC per WNATIVE");
  const forwardPrice = await priceBlock.locator("> strong").textContent();
  await priceBlock.getByRole("button", { name: "Show price as WNATIVE per USDC" }).click();
  await expect(priceBlock).toContainText("WNATIVE per USDC");
  await expect(priceBlock.locator("> strong")).not.toHaveText(forwardPrice ?? "");
  await expect(priceBlock).toContainText("RPC block 42");
  const activeBar = page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars > span.active");
  await expect(activeBar).toHaveAttribute("data-bin-id", String(pinnedActiveId));
  await expect(activeBar).toHaveAttribute("aria-label", /WNATIVE (?!0(?:;|$)).+; USDC (?!0(?:;|$)).+; active bin/);
  await expect(activeBar.locator("i.token-x")).not.toHaveCSS("height", "0px");
  await expect(activeBar.locator("i.token-y")).not.toHaveCSS("height", "0px");
});

test("liquidity distribution rejects an active ID that differs from the canonical analytics anchor", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, pairRuntimeActiveId: 8_388_609, poolBinCount: 5 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await expandPoolMetadata(page);

  await expect(page.getByTestId("pool-fee-economics")).toContainText("active ID differs from the canonical analytics anchor");
  await expect(page.locator(".pool-rail-price-block > strong")).toHaveText("Unavailable");
  const distribution = page.getByTestId("pool-rail-liquidity-distribution");
  await expect(distribution).toContainText("active ID differs from the canonical analytics anchor");
  await expect(distribution.locator(".pool-rail-liquidity-bars")).toHaveCount(0);
  await expect(distribution.locator("span.active")).toHaveCount(0);
});

test("normal legacy indexer lag uses the canonical analytics and RPC anchor", async ({ page }) => {
  await installMockRpc(page, { blockNumber: 50n, includePairs: true, indexerBlockNumber: 42n, poolBinCount: 5 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await expandPoolMetadata(page);

  await expect(page.locator(".pool-rail-price-block")).toContainText("pinned RPC block 50");
  await expect(page.locator(".pool-rail-price-block > strong")).not.toHaveText("Unavailable");
  await expect(page.getByTestId("pool-fee-economics")).toContainText("pinned RPC block 50");
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars > span")).toHaveCount(33);
});

test("a legacy indexer snapshot failure does not hide canonical analytics economics", async ({ page }) => {
  const rpc = await installMockRpc(page, { includePairs: true, poolBinCount: 5 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await expandPoolMetadata(page);

  await expect(page.locator(".pool-rail-price-block > strong")).not.toHaveText("Unavailable");
  await expect(page.getByTestId("pool-fee-economics")).toContainText("RPC block 42");
  rpc.update({ poolIndexerSnapshotMode: "error" });
  await page.reload();
  await expandPoolMetadata(page);

  expect(rpc.snapshot().graphRequests.filter((request) =>
    request.query.includes("PoolIndexerSnapshot")
  ).length).toBeGreaterThan(1);
  await expect(page.getByTestId("pool-fee-economics")).toContainText("RPC block 42");
  await expect(page.locator(".pool-rail-price-block > strong")).not.toHaveText("Unavailable");
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars > span")).toHaveCount(33);
});

test("pool market fails closed when pinned RPC identity differs from the indexed pool", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, pairRuntimeBinStep: 11 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await expandPoolMetadata(page);

  await expect(page.getByTestId("pool-fee-economics")).toContainText("differs from indexed bin step");
  await expect(page.locator(".pool-rail-price-block > strong")).toHaveText("Unavailable");
  await expect(page.locator(".pool-rail-tvl-row strong")).toHaveText("$500,000");
  await expect(page.locator(".pool-rail-stats dd")).toHaveText(["$120,000", "$240", "0.04%"]);
  await expect(page.getByTestId("pool-rail-liquidity-distribution")).toContainText("differs from indexed bin step");
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars")).toHaveCount(0);
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator("span.active")).toHaveCount(0);
});

test("pool market fails closed when pinned token decimals differ from allowlisted metadata", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, pairRuntimeTokenXDecimals: 17 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);
  await expandPoolMetadata(page);

  await expect(page.getByTestId("pool-fee-economics")).toContainText("token X decimals");
  await expect(page.locator(".pool-rail-price-block > strong")).toHaveText("Unavailable");
  await expect(page.locator(".pool-rail-tvl-row strong")).toHaveText("$500,000");
  await expect(page.locator(".pool-rail-stats dd")).toHaveText(["$120,000", "$240", "0.04%"]);
  await expect(page.locator(".pool-rail-reserves dd")).toHaveText(["Unavailable", "Unavailable"]);
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars")).toHaveCount(0);
});

test("same-pair bin-step selector preserves the pool task and safe return context", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, poolCount: 2 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap?returnTo=%23%2Fpools%3Fq%3DWNATIVE%26sort%3Dtvl`);

  const selector = page.getByTestId("pool-bin-step-selector");
  await expect(selector).toBeVisible();
  await expect(selector.locator("option")).toHaveCount(2);
  await expect(selector.locator("option").nth(0)).toContainText("10 bps/bin");
  await expect(selector.locator("option").nth(1)).toContainText("11 bps/bin");
  await selector.selectOption(SECOND_WNATIVE_USDC_PAIR.toLowerCase());
  await expect(page).toHaveURL(new RegExp(`#/pools/${SECOND_WNATIVE_USDC_PAIR}/swap\\?returnTo=`, "i"));
  await expect(page.getByTestId("canonical-pool-workspace")).toHaveAttribute("data-pool-id", SECOND_WNATIVE_USDC_PAIR.toLowerCase());
  await expect(page.getByTestId("pool-action-back")).toHaveAttribute("href", /q=WNATIVE/);
  await expect(page.getByTestId("pool-action-back")).toHaveAttribute("href", /sort=tvl/);
});

test("pool workspace fails closed for foreign-owner and stale owner analytics", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, {
    analyticsIncludeOtherOwner: true,
    analyticsPartialHistory: true,
    includePairs: true,
    includePositions: true
  });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/pools?mine=1");
  await connectWallet(page);
  await expect(page.getByTestId("owner-pool-filter-status")).toContainText("unavailable");
  await expect(page.getByTestId("pool-discovery-row")).toHaveCount(0);
});

test("stale owner analytics remains partial while verified current liquidity stays visible", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { analyticsPartialHistory: true, includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/pools?mine=1");
  await connectWallet(page);
  await expect(page.getByTestId("owner-pool-filter-status")).toContainText("partial");
  await expect(page.getByTestId("pool-discovery-row")).toHaveCount(1);
});

test("analytics token identity mismatches remain partial in the unified workspace", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { analyticsCandleGap: true, analyticsMetricTokenMismatch: true, includePairs: true });
  await page.goto("/#/pools");
  await page.locator(".pool-pair-link").first().click();
  await expect(page.getByTestId("pool-workspace-state")).toContainText("Analytics token identity does not match");
  await expect(page.getByTestId("pool-workspace-state")).toHaveClass(/partial/);
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
});

test("unknown token decimals never fabricate bin reserve amounts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, {
    includePairs: true,
    pairTokenX: "0x000000000000000000000000000000000000bEEF"
  });
  await page.goto("/#/pools");
  await page.locator(".pool-pair-link").first().click();
  await expect(page.getByTestId("pool-rail-liquidity-distribution")).toContainText("Pool bin identity or token decimals are unavailable.");
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars")).toHaveCount(0);
});

test("historical zero-only positions are excluded from My liquidity", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { analyticsZeroLiquidity: true, includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/pools?mine=1");
  await connectWallet(page);
  await expect(page.getByTestId("pool-discovery-row")).toHaveCount(0);
  await expect(page.getByText("No pools match these filters.")).toBeVisible();
  await expect(page.getByTestId("owner-pool-filter-status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "My liquidity" })).toHaveAttribute("aria-pressed", "true");
});

test("double-encoded malformed return routes fail closed without crashing actions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/swap/${WNATIVE_USDC_PAIR.toLowerCase()}?returnTo=%23%2Fpools%2F%25252e%25252e`);
  await expect(page.getByTestId("swap-submit-button")).toBeVisible();
  await expect(page.getByTestId("pool-action-back")).toHaveCount(0);
});
