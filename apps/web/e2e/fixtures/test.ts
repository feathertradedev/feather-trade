import {
  expect,
  test as base,
  type BrowserContext,
  type Locator,
  type Page,
  type Route
} from "@playwright/test";

const REOWN_API_PATTERN = "https://api.web3modal.org/**";

const test = base.extend({
  context: async ({ context }, use) => {
    // Ordinary browser tests exercise Feather and injected EIP-6963 wallets,
    // not Reown Cloud availability. Fail the remote configuration calls
    // immediately and deterministically so AppKit uses its documented local
    // feature fallback without making any page in the test depend on an
    // external service.
    await context.route(REOWN_API_PATTERN, (route) => route.fulfill({
      body: JSON.stringify({ error: "Reown Cloud is disabled in browser tests" }),
      contentType: "application/json",
      status: 403
    }));
    await use(context);
  }
});

export { expect, REOWN_API_PATTERN, test };
export type { BrowserContext, Locator, Page, Route };
