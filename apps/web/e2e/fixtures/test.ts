import {
  expect,
  test as base,
  type Locator,
  type Page,
  type Route
} from "@playwright/test";

const REOWN_API_PATTERN = "https://api.web3modal.org/**";

const test = base.extend({
  page: async ({ page }, use) => {
    // Ordinary browser tests exercise Feather and injected EIP-6963 wallets,
    // not Reown Cloud availability. Fail the remote configuration calls
    // immediately and deterministically so AppKit uses its documented local
    // feature fallback without making the suite depend on an external service.
    await page.route(REOWN_API_PATTERN, (route) => route.fulfill({
      body: JSON.stringify({ error: "Reown Cloud is disabled in browser tests" }),
      contentType: "application/json",
      status: 403
    }));
    await use(page);
  }
});

export { expect, REOWN_API_PATTERN, test };
export type { Locator, Page, Route };
