import { expect, test } from "@playwright/test";

import { installMockAnalyticsStream } from "./fixtures/mock-analytics-stream";
import { installMockRpc, LOCALNET_ANALYTICS_URL, USDC, WNATIVE } from "./fixtures/mock-rpc";
import { installMockWallet, LOCALNET_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "./fixtures/mock-wallet";

const screenshotOptions = {
  animations: "disabled" as const,
  fullPage: true,
  maxDiffPixelRatio: 0.001
};

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime("2026-07-12T14:00:00Z");
});

async function connectWallet(page: Parameters<typeof installMockRpc>[0]) {
  await page.getByTestId("wallet-connect-button").click();
  await expect(page.getByTestId("wallet-account-button")).toBeVisible();
}

async function installBrandDiscoveryProjection(page: Parameters<typeof installMockRpc>[0]) {
  await page.route(LOCALNET_ANALYTICS_URL, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const body = JSON.parse(request.postData() ?? "{}") as {
      query?: string;
      variables?: { pools?: { pair: string }[] };
    };
    if (!body.query?.includes("WebPoolDiscovery")) return route.fallback();
    const startTimestamp = 1_720_000_800;
    const pattern = [160n, 164n, 161n, 168n, 166n, 172n, 169n, 176n, 174n, 181n, 178n, 184n];
    const poolDiscovery = (body.variables?.pools ?? []).map((requested) => ({
      pair: requested.pair.toLowerCase(),
      chainId: LOCALNET_CHAIN_ID,
      tokenX: WNATIVE.toLowerCase(),
      tokenY: USDC.toLowerCase(),
      displayBaseToken: WNATIVE.toLowerCase(),
      displayQuoteToken: USDC.toLowerCase(),
      poolPriceQuotePerBaseE18: "184000000000000000000",
      hourlyCloses: pattern.map((close, index) => ({
        startTimestamp: startTimestamp + index * 3_600,
        closeUsdE18: String(close * 10n ** 18n),
        quoteToken: USDC.toLowerCase(),
        finalized: index < pattern.length - 1,
        revision: index + 1,
        priceSource: "active-bin-quote-usd",
        firstBlockHash: `0x${(700 + index).toString(16).padStart(64, "0")}`,
        lastBlockHash: `0x${(700 + index).toString(16).padStart(64, "0")}`
      })),
      priceChange24hE18: "150000000000000000",
      tvlUsdE18: "500000000000000000000000",
      lpNetSwapFees24hUsdE18: "240000000000000000000",
      volume24hUsdE18: "120000000000000000000000",
      status: "READY",
      missingPriceTokens: [],
      asOfBlock: "42",
      asOfBlockHash: `0x${"22".repeat(32)}`,
      asOfTimestamp: startTimestamp + pattern.length * 3_600,
      marketMetadata: {
        marketCapUsdE18: "12345000000000000000000000",
        source: "dex-screener",
        fetchedAt: startTimestamp + pattern.length * 3_600,
        logoPath: `/token-images/${"b".repeat(64)}`,
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

test("canonical Feather landing desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Weightless liquidity." })).toBeVisible();
  await expect(page.getByLabel("Illustrative SPCX and USDC Liquidity Book market simulation")).toBeVisible();
  await expect(page.getByText("10 bps per bin")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Marketing" }).getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/docs");
  await expect(page.getByRole("navigation", { name: "Marketing" }).getByRole("link", { name: "Swap" })).toHaveCount(0);
  await expect(page.locator(".landing-launch")).toHaveAttribute("href", "#/pools");
  await expect(page.locator(".hero-launch")).toHaveAttribute("href", "#/pools");
  await expect(page).toHaveScreenshot("feather-landing-desktop.png", screenshotOptions);
});

test("canonical Feather landing mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockRpc(page, { includePairs: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Weightless liquidity." })).toBeVisible();
  await expect(page).toHaveScreenshot("feather-landing-mobile.png", screenshotOptions);
});

test("canonical Feather swap desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await expect(page.getByTestId("swap-submit-button")).toBeVisible();
  await expect(page).toHaveScreenshot("feather-swap-desktop.png", screenshotOptions);
});

test("canonical Feather swap mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockRpc(page, { includePairs: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await expect(page.getByTestId("swap-submit-button")).toBeVisible();
  await expect(page).toHaveScreenshot("feather-swap-mobile.png", screenshotOptions);
});

test("canonical Feather pools desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await installBrandDiscoveryProjection(page);
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/pools");
  await expect(page.getByRole("heading", { name: "Pools" })).toBeVisible();
  await expect(page).toHaveScreenshot("feather-pools-desktop.png", screenshotOptions);
});

test("canonical Feather pools mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockRpc(page, { includePairs: true });
  await installBrandDiscoveryProjection(page);
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/pools");
  await expect(page.getByRole("heading", { name: "Pools" })).toBeVisible();
  await expect(page).toHaveScreenshot("feather-pools-mobile.png", screenshotOptions);
});

test("canonical Feather pool workspace desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockAnalyticsStream(page);
  await installMockRpc(page, { includePairs: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/pools");
  await page.locator(".pool-pair-link").first().click();
  await expect(page).toHaveURL(/#\/pools\/.+$/);
  await expect(page.getByRole("tablist", { name: "Pool workspace views" })).toBeHidden();
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
  await expect(page.getByTestId("pool-workspace-rail")).toBeVisible();
  await expect(page.getByTestId("liquidity-range-editor")).toBeVisible();
  await expect(page.getByTestId("pool-workspace-owner-panel")).toBeVisible();
  await expect(page.getByRole("link", { name: "Market overview" })).toHaveCount(0);
  await expect(page).toHaveScreenshot("feather-pool-detail-desktop.png", screenshotOptions);
});

test("canonical Feather pool workspace mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockAnalyticsStream(page);
  await installMockRpc(page, { includePairs: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/pools");
  await page.locator(".pool-pair-link").first().click();
  await expect(page).toHaveURL(/#\/pools\/.+$/);
  const views = page.getByRole("tablist", { name: "Pool workspace views" });
  await expect(views.getByRole("tab", { name: "Trade" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("swap-market-chart")).toBeHidden();
  await expect(page.getByTestId("liquidity-range-editor")).toBeVisible();
  await views.getByRole("tab", { name: "Market" }).click();
  await expect(page.getByTestId("swap-market-chart")).toBeVisible();
  await expect(page.getByTestId("pool-workspace-rail")).toBeVisible();
  await expect(page.getByTestId("liquidity-range-editor")).toBeHidden();
  await views.getByRole("tab", { name: "Positions" }).click();
  await expect(page.getByTestId("pool-workspace-owner-panel")).toBeVisible();
  await expect(page.getByRole("link", { name: "Market overview" })).toHaveCount(0);
  await views.getByRole("tab", { name: "Trade" }).click();
  await expect(page).toHaveScreenshot("feather-pool-detail-mobile.png", screenshotOptions);
});

test("canonical Feather liquidity desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true, includePositions: true, lbApproved: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connectWallet(page);
  await expect(page.getByTestId("withdraw-transaction-review")).toBeVisible();
  await expect(page).toHaveScreenshot("feather-liquidity-desktop.png", screenshotOptions);
  await page.setViewportSize({ height: 900, width: 640 });
  await expect(page.getByTestId("liquidity-range-fields")).toBeVisible();
  await expect(page.getByTestId("liquidity-range-risk")).toBeVisible();
  for (const id of ["range-lower", "range-lower-bin", "range-min-price", "range-upper", "range-upper-bin", "range-max-price"]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("canonical Feather liquidity mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockRpc(page, { includePairs: true, includePositions: true, lbApproved: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connectWallet(page);
  await expect(page.getByTestId("withdraw-transaction-review")).toBeVisible();
  await expect(page.getByTestId("liquidity-range-fields")).toBeVisible();
  await expect(page.getByTestId("liquidity-range-risk")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page).toHaveScreenshot("feather-liquidity-mobile.png", screenshotOptions);
});

test("canonical Feather portfolio and position desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/positions");
  await connectWallet(page);
  await expect(page.getByTestId("portfolio-position-card")).toBeVisible();
  await expect(page).toHaveScreenshot("feather-portfolio-desktop.png", screenshotOptions);
  await page.getByRole("link", { name: "Details" }).click();
  await expect(page.getByText("Position detail")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page).toHaveScreenshot("feather-position-desktop.png", screenshotOptions);
});

test("canonical Feather portfolio and position mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockRpc(page, { includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/positions");
  await connectWallet(page);
  await expect(page.getByTestId("portfolio-position-card")).toBeVisible();
  await expect(page).toHaveScreenshot("feather-portfolio-mobile.png", screenshotOptions);
  await page.getByRole("link", { name: "Details" }).click();
  await expect(page.getByText("Position detail")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(() => page.locator(".app-header").evaluate((element) => getComputedStyle(element).position)).toBe("relative");
  await expect(page).toHaveScreenshot("feather-position-mobile.png", screenshotOptions);
});

test("Feather navigation exposes focused core links without legacy operations controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/swap");
  await expect(page.getByTestId("swap-submit-button")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Swap" })).toHaveCount(0);
  const poolsLink = page.getByRole("link", { name: "Pools" });
  await poolsLink.focus();
  await expect(poolsLink).toBeFocused();
  expect(await poolsLink.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Portfolio" })).toBeFocused();
  await page.keyboard.press("Tab");
  const docsLink = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Docs" });
  await expect(docsLink).toBeFocused();
  await expect(docsLink).toHaveAttribute("href", "/docs");
  await expect(page.getByRole("link", { name: "Liquidity" })).toHaveCount(0);
  await expect(page.getByText("Operations", { exact: true })).toHaveCount(0);
});

test("Feather tertiary text token keeps AA contrast on carbon surfaces", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/swap");
  await expect(page.locator(".app-shell")).toBeVisible();

  const contrastRatios = await page.evaluate(() => {
    const parseColor = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return { red: channels[0] ?? 0, green: channels[1] ?? 0, blue: channels[2] ?? 0, alpha: channels[3] ?? 1 };
    };
    const channelLuminance = (channel: number) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: { red: number; green: number; blue: number }) =>
      0.2126 * channelLuminance(color.red) +
      0.7152 * channelLuminance(color.green) +
      0.0722 * channelLuminance(color.blue);

    return ["var(--carbon)", "var(--panel)", "var(--card)"].map((background) => {
      const probe = document.createElement("span");
      probe.style.background = background;
      probe.style.color = "var(--ink-45)";
      document.body.append(probe);
      const computed = getComputedStyle(probe);
      const foreground = parseColor(computed.color);
      const backdrop = parseColor(computed.backgroundColor);
      probe.remove();
      const composited = {
        red: foreground.red * foreground.alpha + backdrop.red * (1 - foreground.alpha),
        green: foreground.green * foreground.alpha + backdrop.green * (1 - foreground.alpha),
        blue: foreground.blue * foreground.alpha + backdrop.blue * (1 - foreground.alpha)
      };
      const lighter = Math.max(luminance(composited), luminance(backdrop));
      const darker = Math.min(luminance(composited), luminance(backdrop));
      return (lighter + 0.05) / (darker + 0.05);
    });
  });

  for (const ratio of contrastRatios) expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test("320px wrong-chain header keeps wallet and docs reachable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await page.setViewportSize({ width: 320, height: 800 });
  await installMockRpc(page, { includePairs: true });
  await installMockWallet(page, { chainId: ROBINHOOD_TESTNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connectWallet(page);
  await expect(page.getByTestId("wallet-switch-button")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Docs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Liquidity" })).toHaveCount(0);
  await expect(page.getByText("Operations", { exact: true })).toHaveCount(0);
  const overflow = await page.locator("body").evaluate((body) =>
    [...body.querySelectorAll("*")]
      .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 10)
      .map((element) => ({ className: element.className, right: Math.round(element.getBoundingClientRect().right), tag: element.tagName }))
  );
  expect(overflow).toEqual([]);
});
