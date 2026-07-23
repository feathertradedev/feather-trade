import { expect, test } from "./fixtures/test";

const screenshotOptions = {
  animations: "disabled" as const,
  fullPage: true,
  maxDiffPixelRatio: 0.001
};

const scenarios = [
  { name: "landing-dark", path: "/docs", heading: "Welcome to Feather" },
  { name: "long-article", path: "/docs/liquidity/manage", heading: "Manage a position" },
  { name: "strategy-guide", path: "/docs/liquidity/strategies", heading: "Spot, Curve, and Bid-Ask strategies" },
  { name: "troubleshooting", path: "/docs/safety/transaction-lifecycle", heading: "Transaction lifecycle" },
  { name: "contract-placeholder", path: "/docs/contracts/mainnet-deployments", heading: "Mainnet deployments" },
  { name: "landing-light", path: "/docs", heading: "Welcome to Feather", theme: "light" },
  { name: "not-found", path: "/docs/not-a-real-page", heading: "Documentation page not found" }
] as const;

for (const scenario of scenarios) {
  test(`docs visual: ${scenario.name}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    if ("theme" in scenario && scenario.theme === "light") {
      await page.addInitScript(() => window.localStorage.setItem("feather-docs-theme", "light"));
    }
    await page.goto(scenario.path);
    await expect(page.getByRole("heading", { level: 1, name: scenario.heading })).toBeVisible();
    const viewport = testInfo.project.name === "mobile-chromium" ? "mobile" : "desktop";
    await expect(page).toHaveScreenshot(`${scenario.name}-${viewport}.png`, screenshotOptions);
  });
}

test("docs visual: local search", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/docs");
  await page.getByRole("button", { name: "Search documentation" }).click();
  const search = page.getByRole("dialog", { name: "Search documentation" });
  await search.getByRole("textbox", { name: "Search documentation" }).fill("operator approval");
  await expect(search.getByText("Pair-wide LB operator approvals", { exact: true })).toBeVisible();
  const viewport = testInfo.project.name === "mobile-chromium" ? "mobile" : "desktop";
  await expect(page).toHaveScreenshot(`search-${viewport}.png`, screenshotOptions);
});
