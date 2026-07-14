import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let providerReads = 0;
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      get() {
        providerReads += 1;
        return undefined;
      }
    });
    Object.defineProperty(window, "__featherProviderReads", { get: () => providerReads });
  });
});

test("docs load without wallet or application data initialization", async ({ page }, testInfo) => {
  const forbiddenRequests: string[] = [];
  page.on("request", (request) => {
    if (/127\.0\.0\.1:(?:8545|8787)|graphql|\/internal\/blocks/i.test(request.url())) forbiddenRequests.push(request.url());
  });

  await page.goto("/docs");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome to Feather" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use light theme" })).toBeVisible();
  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("button", { name: "Open documentation navigation" }).click();
    await expect(page.getByRole("dialog", { name: "Documentation navigation" }).getByRole("link", { name: /Open app/ })).toHaveAttribute("href", "https://app.feather.markets");
  } else {
    await expect(page.getByRole("link", { name: /Open app/ })).toHaveAttribute("href", "https://app.feather.markets");
  }
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __featherProviderReads?: number }).__featherProviderReads ?? 0)).toBe(0);
  expect(forbiddenRequests).toEqual([]);
});

test("nested docs routes, history, and not-found state work", async ({ page }, testInfo) => {
  await page.goto("/docs/pools/swap/");
  await expect(page).toHaveURL(/\/docs\/pools\/swap$/);
  await expect(page.getByRole("heading", { level: 1, name: "Swap tokens" })).toBeVisible();
  const navigation = testInfo.project.name === "mobile-chromium"
    ? page.getByRole("dialog", { name: "Documentation navigation" })
    : page.locator(".docs-sidebar");
  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("button", { name: "Open documentation navigation" }).click();
  }
  await navigation
    .getByRole("link", {
      name: "Slippage, deadlines, price impact, and minimum received",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/docs\/pools\/swap-settings$/);
  await expect(page.getByRole("heading", { level: 1, name: /Slippage, deadlines/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Swap tokens" })).toBeVisible();
  await page.goto("/docs/not-a-real-page");
  await expect(page.getByRole("heading", { level: 1, name: "Documentation page not found" })).toBeVisible();
});

test("heading search results and copy-link controls create deep links", async ({ page }) => {
  await page.goto("/docs/liquidity/manage");
  await page.getByRole("button", { name: "Search documentation" }).click();
  const search = page.getByRole("dialog", { name: "Search documentation" });
  await search.getByRole("textbox", { name: "Search documentation" }).fill("Position status");
  await search.getByRole("button", { name: /Position status.*Heading in Manage a position/ }).click();
  await expect(page).toHaveURL(/\/docs\/liquidity\/manage#position-status$/);
  await page.getByRole("button", { name: "Copy link to Position status" }).click();
  await expect(page).toHaveURL(/#position-status$/);
});

test("docs remain keyboard-usable and readable at the narrow accessibility boundary", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/docs/safety/wallet-network");
  const searchButton = page.getByRole("button", { name: "Search documentation" });
  await searchButton.focus();
  await expect(searchButton).toBeFocused();
  await page.keyboard.press("Enter");
  const search = page.getByRole("dialog", { name: "Search documentation" });
  await expect(search.getByRole("textbox", { name: "Search documentation" })).toBeFocused();
  await search.getByRole("textbox", { name: "Search documentation" }).fill("no-match-9d78a3");
  await expect(search.getByText("No documentation matched that search.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const contrast = await page.locator(".docs-article > p").first().evaluate((element) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = (rgb: number[]) => rgb.reduce((sum, channel, index) => {
      const normalized = channel / 255;
      const linear = normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index];
    }, 0);
    const backgroundRgb = parse(getComputedStyle(document.body).backgroundColor);
    const foregroundRgba = parse(getComputedStyle(element).color);
    const alpha = foregroundRgba[3] ?? 1;
    const composited = foregroundRgba.slice(0, 3).map((channel, index) => channel * alpha + backgroundRgb[index] * (1 - alpha));
    const foreground = luminance(composited);
    const background = luminance(backgroundRgb);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
});

test("local search and theme preference work without remote calls", async ({ page }) => {
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") remoteRequests.push(request.url());
  });
  await page.goto("/docs");
  await page.getByRole("button", { name: /Search documentation/i }).click();
  const search = page.getByRole("dialog", { name: "Search documentation" });
  await expect(search).toBeVisible();
  await search.getByRole("textbox", { name: "Search documentation" }).fill("operator approval");
  await search.getByText("Pair-wide LB operator approvals", { exact: true }).locator("..").click();
  await expect(page).toHaveURL(/\/docs\/safety\/lb-operator-approvals$/);
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.docsTheme)).toBe("light");
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.docsTheme)).toBe("light");
  expect(remoteRequests).toEqual([]);
});

test("mobile navigation exposes the complete section structure", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await page.goto("/docs/liquidity/strategies");
  await expect(page.getByRole("heading", { level: 1, name: "Spot, Curve, and Bid-Ask strategies" })).toBeVisible();
  await page.getByRole("button", { name: "Open documentation navigation" }).click();
  const dialog = page.getByRole("dialog", { name: "Documentation navigation" });
  await expect(dialog.getByText("Contracts for builders")).toBeVisible();
  await dialog.getByRole("link", { name: "Contract integration safety checklist" }).click();
  await expect(page).toHaveURL(/\/docs\/contracts\/safety-checklist$/);
  await expect(page.getByRole("heading", { level: 1, name: "Contract integration safety checklist" })).toBeVisible();
});
