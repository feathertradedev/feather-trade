import { expect, test } from "@playwright/test";

import { installMockRpc, WNATIVE_USDC_PAIR } from "./fixtures/mock-rpc";
import { installMockWallet, LOCALNET_CHAIN_ID } from "./fixtures/mock-wallet";

async function connectWallet(page: Parameters<typeof installMockRpc>[0]) {
  await page.getByTestId("wallet-connect-button").click();
  await expect(page.getByTestId("wallet-account-button")).toBeVisible();
}

test("swap workspace renders selected-pool hourly candles with Lightweight Charts", async ({ page }) => {
  const rpc = await installMockRpc(page, { includePairs: true });

  await page.goto("/#/swap");
  const chart = page.getByTestId("swap-market-chart");
  await expect(chart).toContainText("WNATIVE / USDC");
  await expect(chart.locator(".swap-chart-summary")).toContainText("Vol $");
  await expect(chart.getByRole("link", { name: "Charting by TradingView" })).toBeVisible();
  await expect.poll(() => rpc.snapshot().graphQueries.some((query) => query.includes("WebPairCandles"))).toBe(true);
  const candleRequest = rpc.snapshot().graphRequests.find((request) => request.query.includes("WebPairCandles"));
  expect(candleRequest?.variables?.interval).toBe("HOUR");
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
  await expect(page.getByTestId("pool-workspace-state")).toContainText("Current through block 42");
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

  await tasks.getByRole("link", { name: "Create position" }).click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/create$`, "i"));
  await expect(workspace).toHaveAttribute("data-pool-id", WNATIVE_USDC_PAIR.toLowerCase());
  await expect(page.locator("#liquidity-pair")).toHaveValue(WNATIVE_USDC_PAIR.toLowerCase());
  await page.getByTestId("liquidity-amount-x").fill("0.345");

  await tasks.getByRole("link", { name: "Manage" }).click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/manage$`, "i"));
  await expect(workspace).toHaveAttribute("data-pool-id", WNATIVE_USDC_PAIR.toLowerCase());
  await expect(page.locator("#liquidity-withdraw")).toBeVisible();

  await tasks.getByRole("link", { name: "Swap" }).click();
  await expect(page.locator("#swap-amount")).toHaveValue("2.75");
  await tasks.getByRole("link", { name: "Create position" }).click();
  await expect(page.getByTestId("liquidity-amount-x")).toHaveValue("0.345");

  await tasks.getByRole("link", { name: "Market" }).click();
  await expect(page).toHaveURL(new RegExp(`#/pools/${WNATIVE_USDC_PAIR}/market$`, "i"));
  await expect(page.getByTestId("pool-detail-analytics-state")).toContainText("Current through block 42");
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
  await expect(page.getByTestId("pool-analytics-state")).toContainText("Current through block 42");
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
  await expect(poolLink).toHaveAttribute("href", /q=WNATIVE/);
  await expect(poolLink).toHaveAttribute("href", /sort=tvl/);
  await expect(poolLink).toHaveAttribute("href", /mine=1/);
  await poolLink.click();

  await expect(page.getByTestId("pool-detail-analytics-state")).toContainText("Current through block 42");
  await expect(page.getByTestId("pool-candle-table").locator("tbody tr")).toHaveCount(24);
  await expect(page.getByTestId("pool-bin-distribution-table").locator("tbody tr")).toHaveCount(5);
  await expect(page.getByTestId("pool-candle-workspace")).toContainText("Hourly OHLCV and LP-net fee data");
  await expect(page.getByTestId("same-pair-pools")).toBeVisible();
  const normalizedGeometry = await page.evaluate(() => ({
    binHeights: [...document.querySelectorAll<HTMLElement>(".pool-bin-stack i")].map((element) => Number.parseFloat(element.style.height)),
    candleYs: [...document.querySelectorAll(".candle-chart polyline")].flatMap((line) => (line.getAttribute("points") ?? "").split(" ").filter(Boolean).map((point) => Number(point.split(",")[1])))
  }));
  expect(normalizedGeometry.binHeights.every((height) => height >= 2 && height <= 100)).toBe(true);
  expect(normalizedGeometry.candleYs.every((value) => value >= 10 && value <= 94)).toBe(true);
  await expect(page.locator(".back-link").first()).toHaveAttribute("href", /q=WNATIVE/);

  await page.getByRole("link", { name: "Deposit" }).click();
  await expect(page.getByTestId("pool-action-back")).toBeVisible();
  await expect(page.locator("#liquidity-pair")).toHaveValue(WNATIVE_USDC_PAIR.toLowerCase());
  await page.getByTestId("pool-action-back").click();
  await expect(page).toHaveURL(/#\/pools\//);
  await expect(page).toHaveURL(/q=WNATIVE/);
  await expect(page).toHaveURL(/sort=tvl/);
  await expect(page).toHaveURL(/mine=1/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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

test("candle gaps keep true time spacing and token identity mismatches stay partial", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { analyticsCandleGap: true, analyticsMetricTokenMismatch: true, includePairs: true });
  await page.goto("/#/pools");
  await page.locator(".discovery-table .pair-name").first().click();
  await expect(page.getByTestId("pool-detail-analytics-state")).toContainText("Analytics token identity does not match");
  await expect(page.getByTestId("pool-detail-analytics-state")).toHaveClass(/partial/);
  await expect(page.locator(".candle-chart polyline")).toHaveCount(2);
  await expect(page.locator(".candle-volume .gap")).toHaveCount(1);
  await expect(page.getByTestId("pool-market-chart")).toContainText("partial");
});

test("unknown token decimals never fabricate bin reserve amounts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, {
    includePairs: true,
    pairTokenX: "0x000000000000000000000000000000000000bEEF"
  });
  await page.goto("/#/pools");
  await page.locator(".discovery-table .pair-name").first().click();
  await expect(page.getByText("Token decimals are unavailable; reserve amounts and distribution heights are not inferred.")).toBeVisible();
  await expect(page.getByTestId("pool-bin-distribution-table")).toHaveCount(0);
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
