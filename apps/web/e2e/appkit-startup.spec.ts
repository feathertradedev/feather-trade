import { expect, test } from "@playwright/test";

import { installMockRpc } from "./fixtures/mock-rpc";
import { installMockWallet, openAndSelectMockWallet } from "./fixtures/mock-wallet";

test("Reown cloud requests cannot block the app shell", async ({ page }) => {
  await page.route("https://api.web3modal.org/**", () => new Promise(() => {}));
  await installMockRpc(page);

  await page.goto("/#/pools", { waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("wallet-connect-button")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("heading", { name: "Pools", exact: true })).toBeVisible();
});

test("non-blocking startup still connects an injected wallet", async ({ page }) => {
  await installMockRpc(page);
  await installMockWallet(page);
  await page.goto("/#/pools");

  await openAndSelectMockWallet(page);
  await expect(page.getByTestId("wallet-account-button")).toBeVisible();
});
