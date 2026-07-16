import { expect, test, type Locator, type Page } from "@playwright/test";

import { installMockRpc } from "./fixtures/mock-rpc";
import { installMockWallet, LOCALNET_CHAIN_ID } from "./fixtures/mock-wallet";

const ONE_TOKEN = 1_000_000_000_000_000_000n;

test("populated transaction journal keeps dark-theme AA contrast when collapsed and expanded", async ({ page }) => {
  const journal = await openPopulatedJournal(page);
  const summary = journal.locator("summary");

  await expect(journal).not.toHaveAttribute("open", "");
  await expect(summary).toBeVisible();
  await assertJournalSurface(journal, summary, "rgb(20, 22, 20)", "rgb(240, 243, 238)");

  await summary.click();
  await expect(journal).toHaveAttribute("open", "");
  const record = journal.locator("[data-transaction-hash], div > span").first();
  await expect(record).toBeVisible();
  await assertJournalSurface(journal, record, "rgb(20, 22, 20)", "rgba(233, 236, 231, 0.6)");
  await expectNoHorizontalOverflow(page);
});

test("populated transaction journal stays readable and contained at 200 percent layout scale", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 2,
    height: 450,
    mobile: false,
    screenHeight: 900,
    screenWidth: 640,
    width: 320
  });

  const journal = await openPopulatedJournal(page);
  await expect.poll(() => page.evaluate(() => ({ dpr: window.devicePixelRatio, width: window.innerWidth }))).toEqual({ dpr: 2, width: 320 });
  await assertJournalSurface(journal, journal.locator("summary"), "rgb(20, 22, 20)", "rgb(240, 243, 238)");

  await journal.locator("summary").click();
  const record = journal.locator("[data-transaction-hash], div > span").first();
  await expect(record).toBeVisible();
  await assertJournalSurface(journal, record, "rgb(20, 22, 20)", "rgba(233, 236, 231, 0.6)");
  await expectNoHorizontalOverflow(page);
});

async function openPopulatedJournal(page: Page): Promise<Locator> {
  await installMockRpc(page, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN, includePairs: true });
  await installMockWallet(page, {
    allowTransactions: true,
    chainId: LOCALNET_CHAIN_ID,
    transactionMode: "ambiguous"
  });
  await page.goto("/#/swap");
  await page.getByTestId("wallet-connect-button").click();
  await expect(page.getByTestId("wallet-account-button")).toContainText("0xf39F...2266");
  await page.getByTestId("swap-submit-button").click();
  await expect(page.getByTestId("gas-review")).toBeVisible();
  await page.getByTestId("swap-submit-button").click();

  const journal = page.getByTestId("submitted-transaction-journal");
  await expect(journal).toContainText(/unknown-submission|reconciling/);
  await page.locator(".operations-menu > summary").click();
  await expect(journal).toBeVisible();
  return journal;
}

async function assertJournalSurface(
  journal: Locator,
  text: Locator,
  expectedBackground: string,
  expectedForeground: string
): Promise<void> {
  const presentation = await journal.evaluate((element, textElement) => {
    const parseColor = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return {
        red: channels[0] ?? 0,
        green: channels[1] ?? 0,
        blue: channels[2] ?? 0,
        alpha: channels[3] ?? 1
      };
    };
    const channelLuminance = (channel: number) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: { red: number; green: number; blue: number }) =>
      0.2126 * channelLuminance(color.red) +
      0.7152 * channelLuminance(color.green) +
      0.0722 * channelLuminance(color.blue);
    const journalStyle = getComputedStyle(element);
    const textStyle = getComputedStyle(textElement as Element);
    const background = parseColor(journalStyle.backgroundColor);
    const foreground = parseColor(textStyle.color);
    const composited = {
      red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
      green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha),
      blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha)
    };
    const lighter = Math.max(luminance(composited), luminance(background));
    const darker = Math.min(luminance(composited), luminance(background));
    return {
      background: journalStyle.backgroundColor,
      border: journalStyle.borderTopColor,
      contrast: (lighter + 0.05) / (darker + 0.05),
      foreground: textStyle.color
    };
  }, await text.elementHandle());

  expect(presentation.background).toBe(expectedBackground);
  expect(presentation.border).toBe("rgba(233, 236, 231, 0.12)");
  expect(presentation.foreground).toBe(expectedForeground);
  expect(presentation.contrast).toBeGreaterThanOrEqual(4.5);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}
