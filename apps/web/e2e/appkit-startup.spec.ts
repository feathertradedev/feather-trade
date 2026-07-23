import { expect, REOWN_API_PATTERN, test } from "./fixtures/test";

import { installMockRpc } from "./fixtures/mock-rpc";
import { installMockWallet, openAndSelectMockWallet } from "./fixtures/mock-wallet";

test("Reown cloud requests cannot block the app shell or trap wallet connection", async ({ context, page }) => {
  await context.unroute(REOWN_API_PATTERN);
  await context.route(REOWN_API_PATTERN, () => new Promise(() => {}));
  await installMockRpc(page);
  await installMockWallet(page, {
    additionalProviders: [{
      account: "0x1111111111111111111111111111111111111111",
      name: "Backup Wallet",
      rdns: "org.example.backup",
      uuid: "robinhood-lb-backup-wallet"
    }]
  });

  await page.goto("/#/pools", { waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("wallet-connect-button")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Pools", exact: true })).toBeVisible();
  const connectButton = page.getByTestId("wallet-connect-button");
  await connectButton.click();
  await connectButton.click();
  const localWalletChooser = page.getByTestId("wallet-provider-choices");
  await expect(localWalletChooser).toBeVisible({ timeout: 15_000 });
  await localWalletChooser.getByRole("button", { name: /Mock MetaMask/i }).click();
  await expect(page.getByTestId("wallet-account-button")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("wallet-status")).toHaveCount(0);
});

test("non-blocking startup still connects an injected wallet", async ({ page }) => {
  await installMockRpc(page);
  await installMockWallet(page);
  await page.goto("/#/pools");

  await openAndSelectMockWallet(page);
  await expect(page.getByTestId("wallet-account-button")).toBeVisible();
});
