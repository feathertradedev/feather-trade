import { expect, test, type Locator, type Page } from "./fixtures/test";

import { installMockRpc } from "./fixtures/mock-rpc";
import { installMockWallet, LOCALNET_CHAIN_ID, openAndSelectMockWallet, readMockWallet } from "./fixtures/mock-wallet";

async function connect(page: Page) {
  await openAndSelectMockWallet(page);
  await expect(page.getByTestId("wallet-account-button")).toBeVisible();
}

async function expectTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const label = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${element.outerHTML.slice(0, 160)} [min-block-size=${style.minBlockSize}; min-height=${style.minHeight}]`;
  });
  expect(box, "interactive target must have a computed box").not.toBeNull();
  expect(box!.height, `${label} target height`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${label} target width`).toBeGreaterThanOrEqual(44);
}

async function expectNoHorizontalOverflow(page: Page) {
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
}

test("core routes keep representative controls at least 44 by 44 CSS pixels", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: true, lbApproved: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connect(page);

  await expect(page.getByTestId("swap-failure-state")).toHaveClass(/\bready\b/);
  await expect(page.getByTestId("swap-failure-state")).toHaveCSS("background-color", "rgb(13, 14, 13)");

  for (const target of [
    page.getByTestId("swap-max-button"),
    page.getByTitle("Flip tokens"),
    page.getByTestId("swap-submit-button"),
    page.locator("#swap-slippage")
  ]) await expectTouchTarget(target);

  await page.goto("/#/pools");
  for (const target of [
    page.getByTestId("pool-create-launch"),
    page.getByRole("button", { name: "All DLMM" }),
    page.getByRole("button", { name: "Next" })
  ]) await expectTouchTarget(target);

  await page.goto("/#/liquidity");
  for (const target of [
    page.getByTestId("liquidity-max-x"),
    page.getByTestId("liquidity-preset-narrow"),
    page.getByTestId("liquidity-add-button"),
    page.getByRole("group", { name: "Withdrawal percentage presets" }).getByRole("button", { name: "Max" }),
    page.getByTestId("liquidity-remove-button")
  ]) await expectTouchTarget(target);

  await page.goto("/#/positions");
  await expectTouchTarget(page.getByRole("link", { name: "Details" }).first());
});

test("liquidity amounts and Max actions expose asset-specific accessible names", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connect(page);

  await expect(page.getByRole("textbox", { name: "WNATIVE liquidity amount" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "USDC liquidity amount" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use maximum WNATIVE balance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use maximum USDC balance" })).toBeVisible();
});

test("core financial forms support keyboard editing and labelled action traversal without wallet submission", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: true, lbApproved: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connect(page);

  const sell = page.locator("#swap-amount");
  await sell.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("2.5");
  await expect(sell).toHaveValue("2.5");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("swap-max-button")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTitle("Flip tokens")).toBeFocused();

  await page.goto("/#/liquidity");
  if (await page.getByTestId("wallet-connect-button").isVisible()) await connect(page);
  const amountX = page.getByRole("textbox", { name: "WNATIVE liquidity amount" });
  await amountX.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("1.25");
  await expect(amountX).toHaveValue("1.25");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Use maximum WNATIVE balance" })).toBeFocused();

  await page.keyboard.press("Tab");
  const amountY = page.getByRole("textbox", { name: "USDC liquidity amount" });
  await expect(amountY).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("0.75");
  await expect(amountY).toHaveValue("0.75");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Use maximum USDC balance" })).toBeFocused();

  const exactPercent = page.locator("#remove-percent");
  await exactPercent.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("37.5");
  await expect(exactPercent).toHaveValue("37.5");
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("pool creation focuses its first field and returns focus on Escape and Close", async ({ page }) => {
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/pools");
  const launch = page.getByTestId("pool-create-launch");

  await launch.click();
  await expect(page.getByTestId("pool-create-token-x")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pool-creation-wizard")).toHaveCount(0);
  await expect(launch).toBeFocused();

  await launch.click();
  await expect(page.getByTestId("pool-create-token-x")).toBeFocused();
  await page.getByRole("button", { name: "Close pool creation" }).click();
  await expect(page.getByTestId("pool-creation-wizard")).toHaveCount(0);
  await expect(launch).toBeFocused();
});

test("all core routes reflow without horizontal page overflow at 320 CSS pixels", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: true, lbApproved: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.setViewportSize({ height: 900, width: 320 });

  for (const route of ["swap", "pools", "liquidity", "positions", "activity"]) {
    await page.goto(`/#/${route}`);
    await expectNoHorizontalOverflow(page);
  }
});

test("all core routes reflow at 200 percent layout scale with a 320 CSS-pixel viewport", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: true, lbApproved: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 2,
    height: 450,
    mobile: false,
    screenHeight: 900,
    screenWidth: 640,
    width: 320
  });
  await expect.poll(() => page.evaluate(() => ({ dpr: window.devicePixelRatio, width: window.innerWidth }))).toEqual({ dpr: 2, width: 320 });

  for (const route of ["swap", "pools", "liquidity", "positions", "activity"]) {
    await page.goto(`/#/${route}`);
    await expectNoHorizontalOverflow(page);
  }
});
