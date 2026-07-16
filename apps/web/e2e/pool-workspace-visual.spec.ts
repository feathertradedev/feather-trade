import { expect, test } from "@playwright/test";

import { installMockRpc, WNATIVE_USDC_PAIR, type MockRpcOptions } from "./fixtures/mock-rpc";
import { installMockWallet, LOCALNET_CHAIN_ID } from "./fixtures/mock-wallet";

type WorkspaceVisualCase = {
  name: "market" | "swap" | "create-position" | "manage-position" | "empty-wallet" | "partial-data";
  options: MockRpcOptions;
  route: "create" | "manage" | "swap";
  mobileView?: "Market" | "Positions" | "Trade";
  wallet?: boolean;
  expandMetadata?: boolean;
  target?: "market" | "owner" | "viewport";
};

const CASES: readonly WorkspaceVisualCase[] = [
  { name: "market", options: { includePairs: true }, route: "create", mobileView: "Market", target: "market" },
  { name: "swap", options: { includePairs: true }, route: "swap", mobileView: "Trade", target: "viewport" },
  { name: "create-position", options: { includePairs: true }, route: "create", mobileView: "Trade", target: "viewport" },
  { name: "manage-position", options: { includePairs: true, includePositions: true, lbApproved: true }, route: "manage", mobileView: "Trade", wallet: true, target: "viewport" },
  { name: "empty-wallet", options: { includePairs: true }, route: "create", mobileView: "Positions", target: "owner" },
  { name: "partial-data", options: { analyticsPartialHistory: true, includePairs: true }, route: "create", mobileView: "Market", expandMetadata: true, target: "viewport" }
];

const screenshotOptions = {
  animations: "disabled" as const,
  maxDiffPixelRatio: 0.001
};

for (const visualCase of CASES) {
  test(`canonical pool workspace ${visualCase.name}`, async ({ page }, testInfo) => {
    await page.clock.setFixedTime("2026-07-12T14:00:00Z");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installMockRpc(page, visualCase.options);
    await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });

    await page.goto(`/#/pools/${WNATIVE_USDC_PAIR}/${visualCase.route}`);
    if (visualCase.wallet) {
      await page.getByTestId("wallet-connect-button").click();
      await expect(page.getByTestId("wallet-account-button")).toBeVisible();
    }

    const workspace = page.getByTestId("canonical-pool-workspace");
    await expect(workspace).toBeVisible();
    await expect(page.getByTestId("swap-market-chart")).toContainText(visualCase.options.analyticsPartialHistory ? "Partial history" : "History ready");

    if (testInfo.project.name === "mobile-chromium" && visualCase.mobileView) {
      await page.getByRole("tablist", { name: "Pool workspace views" }).getByRole("tab", { name: visualCase.mobileView }).click();
    }
    if (visualCase.expandMetadata) {
      const toggle = page.getByRole("button", { name: /Pool market/ });
      if (await toggle.isVisible()) await toggle.click();
      await expect(page.getByTestId("pool-workspace-state")).toBeVisible();
    }

    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const viewport = testInfo.project.name === "mobile-chromium" ? "mobile" : "desktop";
    const snapshotName = `feather-workspace-${visualCase.name}-${viewport}.png`;
    if (visualCase.target === "market") {
      await expect(page.getByTestId("swap-market-chart")).toHaveScreenshot(snapshotName, screenshotOptions);
    } else if (visualCase.target === "owner") {
      await expect(page.getByTestId("pool-workspace-owner-panel")).toHaveScreenshot(snapshotName, screenshotOptions);
    } else {
      if (visualCase.expandMetadata) {
        await page.getByTestId("pool-workspace-state").evaluate((state) => {
          const rail = state.closest<HTMLElement>(".pool-workspace-rail");
          if (rail && rail.scrollHeight > rail.clientHeight + 1) {
            rail.scrollTop = Math.max(0, (state as HTMLElement).offsetTop - 16);
          } else {
            state.scrollIntoView({ behavior: "auto", block: "center" });
          }
        });
      } else {
        await page.evaluate(() => window.scrollTo({ behavior: "auto", left: 0, top: 0 }));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      }
      await expect(page).toHaveScreenshot(snapshotName, { ...screenshotOptions, fullPage: false });
    }
  });
}
