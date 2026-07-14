import { expect, test } from "@playwright/test";

import { installMockRpc } from "./fixtures/mock-rpc";
import { installMockWallet, LOCALNET_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "./fixtures/mock-wallet";

const screenshotOptions = {
  animations: "disabled" as const,
  fullPage: true,
  maxDiffPixelRatio: 0.001
};

async function connectWallet(page: Parameters<typeof installMockRpc>[0]) {
  await page.getByTestId("wallet-connect-button").click();
  await expect(page.getByTestId("wallet-account-button")).toBeVisible();
}

test("canonical Feather landing desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Weightless liquidity." })).toBeVisible();
  await expect(page.getByLabel("Illustrative WNATIVE and USDC Liquidity Book market simulation")).toBeVisible();
  await expect(page.getByText("10 bps per bin")).toBeVisible();
  await expect(page.getByRole("link", { name: "Docs" })).toHaveCount(0);
  await expect(page).toHaveScreenshot("feather-landing-desktop.png", screenshotOptions);
});

test("canonical Feather landing mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockRpc(page, { includePairs: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Weightless liquidity." })).toBeVisible();
  await expect(page).toHaveScreenshot("feather-landing-mobile.png", screenshotOptions);
});

test("canonical Feather swap desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/swap");
  await expect(page.getByTestId("swap-submit-button")).toBeVisible();
  await expect(page).toHaveScreenshot("feather-swap-desktop.png", screenshotOptions);
});

test("canonical Feather swap mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/swap");
  await expect(page.getByTestId("swap-submit-button")).toBeVisible();
  await expect(page).toHaveScreenshot("feather-swap-mobile.png", screenshotOptions);
});

test("canonical Feather pools desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/pools");
  await expect(page.locator(".panel-heading").filter({ hasText: "Pools" })).toBeVisible();
  await expect(page).toHaveScreenshot("feather-pools-desktop.png", screenshotOptions);
});

test("canonical Feather pools mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/pools");
  await expect(page.locator(".panel-heading").filter({ hasText: "Pools" })).toBeVisible();
  await expect(page).toHaveScreenshot("feather-pools-mobile.png", screenshotOptions);
});

test("canonical Feather pool detail desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/pools");
  await page.locator(".discovery-table .pair-name").first().click();
  await expect(page.getByText("Live liquidity bins")).toBeVisible();
  await expect(page).toHaveScreenshot("feather-pool-detail-desktop.png", screenshotOptions);
});

test("canonical Feather pool detail mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/pools");
  await page.locator(".discovery-table .pair-name").first().click();
  await expect(page.getByText("Live liquidity bins")).toBeVisible();
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
});

test("canonical Feather liquidity mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await installMockRpc(page, { includePairs: true, includePositions: true, lbApproved: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connectWallet(page);
  await expect(page.getByTestId("withdraw-transaction-review")).toBeVisible();
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

test("Feather navigation exposes focus and keyboard operations states", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/swap");
  const swapLink = page.getByRole("link", { name: "Swap" });
  await expect(swapLink).toHaveAttribute("aria-current", "page");
  await swapLink.focus();
  await expect(swapLink).toBeFocused();
  expect(await swapLink.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Pools" })).toBeFocused();

  const operations = page.locator(".operations-menu");
  const summary = operations.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(operations).toHaveAttribute("open", "");
  const activityLink = operations.getByRole("link", { name: "Activity" });
  await activityLink.focus();
  await expect(activityLink).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(operations).not.toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
});

test("Feather tertiary text token keeps AA contrast on carbon surfaces", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/swap");

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

test("320px wrong-chain header keeps wallet and operations reachable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await page.setViewportSize({ width: 320, height: 800 });
  await installMockRpc(page, { includePairs: true });
  await installMockWallet(page, { chainId: ROBINHOOD_TESTNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connectWallet(page);
  await expect(page.getByTestId("wallet-switch-button")).toBeVisible();
  await expect(page.getByRole("link", { name: "Liquidity" })).toBeVisible();
  await expect(page.locator(".operations-menu summary")).toBeVisible();
  const overflow = await page.locator("body").evaluate((body) =>
    [...body.querySelectorAll("*")]
      .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 10)
      .map((element) => ({ className: element.className, right: Math.round(element.getBoundingClientRect().right), tag: element.tagName }))
  );
  expect(overflow).toEqual([]);
});
