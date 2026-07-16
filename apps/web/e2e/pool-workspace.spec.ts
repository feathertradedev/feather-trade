import { expect, test } from "@playwright/test";
import { decodeFunctionData, type Hex } from "viem";

import { lbRouterAbi } from "../../../packages/sdk/src/abi";
import { installMockRpc, SECOND_WNATIVE_USDC_PAIR, USDC, WNATIVE, WNATIVE_USDC_PAIR } from "./fixtures/mock-rpc";
import { installMockWallet, LOCALNET_CHAIN_ID, readMockWallet } from "./fixtures/mock-wallet";

const ONE_TOKEN = 10n ** 18n;

async function connectWallet(page: Parameters<typeof installMockRpc>[0]) {
  await page.getByTestId("wallet-connect-button").click();
  await expect(page.getByTestId("wallet-account-button")).toBeVisible();
}

async function submitReviewedSwap(page: Parameters<typeof installMockRpc>[0]) {
  await page.getByTestId("swap-submit-button").click();
  await expect(page.getByTestId("gas-review")).toBeVisible();
  await page.getByTestId("swap-submit-button").click();
}

async function installMockCandleStream(page: Parameters<typeof installMockRpc>[0]) {
  await page.addInitScript(() => {
    type TestWindow = Window & {
      __testEmitCandle: (payload: unknown) => void;
      __testAdvanceCandleClock: (milliseconds: number) => void;
      __testFailCandleStream: () => void;
      __testResetCandleStream: () => void;
    };
    let latest: TestEventSource | null = null;
    class TestEventSource extends EventTarget {
      onerror: ((event: Event) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      readyState = 0;
      readonly url: string;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        latest = this;
        window.setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        }, 0);
      }

      close() {
        this.readyState = 2;
      }
    }

    Object.defineProperty(window, "EventSource", { configurable: true, value: TestEventSource });
    const testWindow = window as unknown as TestWindow;
    testWindow.__testEmitCandle = (payload) => latest?.dispatchEvent(new MessageEvent("candle", { data: JSON.stringify(payload) }));
    const originalNow = Date.now;
    testWindow.__testAdvanceCandleClock = (milliseconds) => {
      Date.now = () => originalNow() + milliseconds;
    };
    testWindow.__testFailCandleStream = () => {
      const originalNow = Date.now;
      Date.now = () => originalNow() + 46_000;
      latest?.onerror?.(new Event("error"));
      Date.now = originalNow;
    };
    testWindow.__testResetCandleStream = () => {
      latest?.dispatchEvent(new MessageEvent("reset", { data: JSON.stringify({ cursor: "1000", reason: "canonical-reorg" }) }));
    };
  });
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
  await installMockCandleStream(page);
  const rpc = await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
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

test("candle intervals remain usable without page overflow on a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rpc = await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);

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
  await installMockCandleStream(page);
  const rpc = await installMockRpc(page, { includePairs: true });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
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
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
  await expect(page.locator("#liquidity-pair")).toHaveCount(0);
  await expect(page.locator("#liquidity-withdraw")).toHaveCount(0);
  await page.getByTestId("liquidity-amount-x").fill("0.345");

  await tasks.getByRole("link", { name: "Manage" }).click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/manage$`, "i"));
  await expect(workspace).toHaveAttribute("data-pool-id", WNATIVE_USDC_PAIR.toLowerCase());
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
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
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
  await expect(page.getByTestId("pool-workspace-state")).toHaveCount(0);
});

test("pool workspace keeps truthful owner positions and history beneath the chart", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);
  await connectWallet(page);

  const workspace = page.getByTestId("canonical-pool-workspace");
  const panel = page.getByTestId("pool-workspace-owner-panel");
  const chart = page.getByTestId("swap-market-chart");
  await expect(panel).toBeVisible();
  const geometry = await page.evaluate(() => {
    const chartBox = document.querySelector<HTMLElement>('[data-testid="swap-market-chart"]')?.getBoundingClientRect();
    const panelBox = document.querySelector<HTMLElement>('[data-testid="pool-workspace-owner-panel"]')?.getBoundingClientRect();
    return chartBox && panelBox ? { chartBottom: chartBox.bottom, chartLeft: chartBox.left, chartRight: chartBox.right, panelLeft: panelBox.left, panelRight: panelBox.right, panelTop: panelBox.top } : null;
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.panelTop).toBeGreaterThanOrEqual(geometry!.chartBottom);
  expect(Math.abs(geometry!.panelLeft - geometry!.chartLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry!.panelRight - geometry!.chartRight)).toBeLessThanOrEqual(1);

  await expect(panel.getByRole("tab", { name: "Positions" })).toHaveAttribute("aria-selected", "true");
  const position = panel.getByTestId("pool-position-summary");
  await expect(position).toContainText("WNATIVE / USDC");
  await expect(position).toContainText("1 active bin");
  await expect(position).toContainText("In range");
  await expect(position).toContainText("USDC per WNATIVE");
  await expect(position).toContainText("Indexed liquidity");
  await expect(panel).not.toContainText("Limit Orders");

  await panel.getByRole("tab", { name: "History" }).click();
  await expect(panel.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByTestId("pool-history-row")).toHaveCount(2);
  await expect(panel).toContainText("Added liquidity");
  await expect(panel).toContainText("Removed liquidity");
  await expect(panel).not.toContainText("Transaction history");

  await workspace.getByRole("link", { name: "Create position" }).first().click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/create$`, "i"));
  await expect(page.getByTestId("pool-workspace-owner-panel").getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("pool-workspace-owner-panel").getByRole("tab", { name: "Positions" }).click();
  await page.getByTestId("pool-position-manage-link").click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/manage$`, "i"));
  await expect(page.locator(".position-option")).toHaveCount(1);
  await expect(page.locator(".position-option").first().locator('input[type="checkbox"]')).toBeChecked();
  await expect(chart).toBeVisible();

  await page.setViewportSize({ height: 900, width: 320 });
  await expect(page.getByTestId("pool-workspace-owner-panel").getByRole("tab", { name: "Positions" })).toBeVisible();
  await expect(page.getByTestId("pool-workspace-owner-panel").getByRole("tab", { name: "History" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("pool owner panel does not query before connection and exposes a real empty state", async ({ page }) => {
  const rpc = await installMockRpc(page, { includePairs: true, includePositions: false });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/swap`);

  const panel = page.getByTestId("pool-workspace-owner-panel");
  await expect(panel).toContainText("No wallet connected");
  expect(rpc.snapshot().graphQueries.some((query) => query.includes("OwnerPairPositions"))).toBe(false);
  expect(rpc.snapshot().graphQueries.some((query) => query.includes("PositionLiquidityHistory"))).toBe(false);

  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.reload();
  await connectWallet(page);
  await expect(panel).toContainText("No liquidity in this pool");
  await expect(panel.getByRole("link", { name: "Create position" })).toHaveAttribute("href", `#/pools/${WNATIVE_USDC_PAIR.toLowerCase()}/create`);
  await panel.getByRole("tab", { name: "History" }).click();
  await expect(panel).toContainText("No position history yet");
});

test("create position range editor layers exact distribution over indexed pool reserves", async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1600 });
  await installMockRpc(page, { includePairs: true, poolBinCount: 9 });
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
  await lowerHandle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#range-lower")).toHaveValue("-2");
  await expect(chart.getByRole("img")).toHaveCount(4);
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
  await expect(page.locator(".workspace-table-metric").filter({ hasText: "$500,000" })).toBeVisible();
  const discoveryMetrics = page.locator(".discovery-table .table-row:not(.header)").first().locator(".workspace-table-metric");
  for (const [index, label, value] of [
    [0, "TVL", "$500,000"],
    [1, "24h volume", "$120,000"],
    [2, "24h LP fees", "$240"],
    [3, "24h LP fee / TVL", "0.04%"]
  ] as const) {
    await expect(discoveryMetrics.nth(index)).toContainText(label);
    await expect(discoveryMetrics.nth(index)).toContainText(value);
  }

  const poolLink = page.locator(".discovery-table .pair-name").first();
  const poolHref = await poolLink.getAttribute("href");
  expect(poolHref).not.toBeNull();
  const returnHref = new URLSearchParams(poolHref!.split("?", 2)[1]).get("returnTo");
  expect(returnHref).toContain("q=WNATIVE");
  expect(returnHref).toContain("sort=tvl");
  expect(returnHref).toContain("mine=1");
  await poolLink.click();

  await expect(page).toHaveURL(/#\/pools\/.+\/create\?returnTo=/);
  await expect(page.getByTestId("pool-workspace-state")).toHaveCount(0);
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars > span")).toHaveCount(33);
  await expect(page.getByTestId("pool-detail-analytics-state")).toHaveCount(0);
  await expect(page.getByTestId("pool-candle-workspace")).toHaveCount(0);
  await expect(page.getByTestId("pool-bin-distribution-table")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Market overview" })).toHaveCount(0);
  await expect(page.getByTestId("pool-action-back")).toBeVisible();
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
  await expect(activeBar).toHaveAttribute("aria-label", /WNATIVE 0; USDC 0; active bin/);
  await expect(activeBar.locator("i.token-x")).toHaveCSS("height", "0px");
  await expect(activeBar.locator("i.token-y")).toHaveCSS("height", "0px");
});

test("liquidity distribution rejects an indexed active ID that lags the pinned RPC snapshot", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, pairRuntimeActiveId: 8_388_609, poolBinCount: 5 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);

  await expect(page.getByTestId("pool-fee-economics")).toContainText("active ID differs from the indexer snapshot");
  await expect(page.locator(".pool-rail-price-block > strong")).toHaveText("Unavailable");
  const distribution = page.getByTestId("pool-rail-liquidity-distribution");
  await expect(distribution).toContainText("active ID differs from the indexer snapshot");
  await expect(distribution.locator(".pool-rail-liquidity-bars")).toHaveCount(0);
  await expect(distribution.locator("span.active")).toHaveCount(0);
});

test("normal indexer lag uses the indexed common block instead of failing against RPC latest", async ({ page }) => {
  await installMockRpc(page, { blockNumber: 50n, includePairs: true, indexerBlockNumber: 42n, poolBinCount: 5 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);

  await expect(page.locator(".pool-rail-price-block")).toContainText("RPC block 42");
  await expect(page.locator(".pool-rail-price-block > strong")).not.toHaveText("Unavailable");
  await expect(page.getByTestId("pool-fee-economics")).toContainText("RPC block 42");
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars > span")).toHaveCount(33);
});

test("a background snapshot failure hides previously cached market economics", async ({ page }) => {
  const rpc = await installMockRpc(page, { includePairs: true, poolBinCount: 5 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);

  await expect(page.locator(".pool-rail-price-block > strong")).not.toHaveText("Unavailable");
  await expect(page.getByTestId("pool-fee-economics")).toContainText("RPC block 42");
  rpc.update({ poolIndexerSnapshotMode: "error" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(page.getByTestId("pool-fee-economics")).toContainText("Mock pool indexer snapshot failed", { timeout: 15_000 });
  await expect(page.locator(".pool-rail-price-block > strong")).toHaveText("Unavailable");
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars")).toHaveCount(0);
});

test("pool market fails closed when pinned RPC identity differs from the indexed pool", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, pairRuntimeBinStep: 11 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);

  await expect(page.getByTestId("pool-fee-economics")).toContainText("differs from indexed bin step");
  await expect(page.locator(".pool-rail-price-block > strong")).toHaveText("Unavailable");
  await expect(page.locator(".pool-rail-tvl-row strong")).toHaveText("Unavailable");
  await expect(page.locator(".pool-rail-stats dd")).toHaveText(["Unavailable", "Unavailable", "Unavailable"]);
  await expect(page.getByTestId("pool-rail-liquidity-distribution")).toContainText("differs from indexed bin step");
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars")).toHaveCount(0);
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator("span.active")).toHaveCount(0);
});

test("pool market fails closed when pinned token decimals differ from allowlisted metadata", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, pairRuntimeTokenXDecimals: 17 });
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/create`);

  await expect(page.getByTestId("pool-fee-economics")).toContainText("token X decimals");
  await expect(page.locator(".pool-rail-price-block > strong")).toHaveText("Unavailable");
  await expect(page.locator(".pool-rail-tvl-row strong")).toHaveText("Unavailable");
  await expect(page.locator(".pool-rail-stats dd")).toHaveText(["Unavailable", "Unavailable", "Unavailable"]);
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
  await expect(page.locator(".discovery-table .table-row:not(.header)")).toHaveCount(0);
});

test("stale owner analytics remains partial while verified current liquidity stays visible", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { analyticsPartialHistory: true, includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/pools?mine=1");
  await connectWallet(page);
  await expect(page.getByTestId("owner-pool-filter-status")).toContainText("partial");
  await expect(page.locator(".discovery-table .table-row:not(.header)")).toHaveCount(1);
});

test("analytics token identity mismatches remain partial in the unified workspace", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { analyticsCandleGap: true, analyticsMetricTokenMismatch: true, includePairs: true });
  await page.goto("/#/pools");
  await page.locator(".discovery-table .pair-name").first().click();
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
  await page.locator(".discovery-table .pair-name").first().click();
  await expect(page.getByTestId("pool-rail-liquidity-distribution")).toContainText("Pool bin identity or token decimals are unavailable.");
  await expect(page.getByTestId("pool-rail-liquidity-distribution").locator(".pool-rail-liquidity-bars")).toHaveCount(0);
});

test("historical zero-only positions are excluded from My liquidity", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { analyticsZeroLiquidity: true, includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/pools?mine=1");
  await connectWallet(page);
  await expect(page.locator(".discovery-table .table-row:not(.header)")).toHaveCount(0);
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
