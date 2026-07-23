import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, type Address } from "viem";

import { lbRouterAbi } from "../../../packages/sdk/src/abi";
import { priceQ128FromActiveId, Q128 } from "../../../packages/sdk/src/liquidity-price";
import {
  CREATED_WETH_USDT_PAIR,
  installMockRpc,
  type InstalledMockRpc,
  USDT,
  WNATIVE
} from "./fixtures/mock-rpc";
import {
  installMockWallet,
  LOCALNET_CHAIN_ID,
  openAndSelectMockWallet,
  readMockWallet
} from "./fixtures/mock-wallet";

const ACTIVE_ID = 8_388_608;
const NO_CODE_TOKEN = "0x4444444444444444444444444444444444444401" as Address;

const creationRpc = {
  activeId: ACTIVE_ID,
  blockNumber: 42n,
  includePairs: false,
  indexerBlockNumber: 41n,
  poolCreationOpenBinSteps: [10n, 25n],
  poolCreationQuoteAssets: [USDT],
  priceQ128ByBin: { [String(ACTIVE_ID)]: Q128 }
} as const;

async function connectMockWallet(page: Page) {
  await openAndSelectMockWallet(page);
  await expect(page.getByTestId("wallet-account-button")).toContainText("0xf39F...2266");
}

async function openCreationWizard(page: Page) {
  await page.goto("/#/pools");
  await connectMockWallet(page);
  await page.getByTestId("pool-create-launch").click();
  await expect(page.getByTestId("pool-creation-wizard")).toBeVisible();
  await expect(page.getByTestId("pool-create-token-x")).not.toHaveValue("");
  await expect(page.getByTestId("pool-create-token-y")).not.toHaveValue("");
}

async function configureCreation(page: Page, createAndAdd = false) {
  await openCreationWizard(page);
  await page.getByTestId("pool-create-token-x").fill(WNATIVE);
  await page.getByTestId("pool-create-token-y").selectOption(USDT);
  await page.getByRole("button", { name: "Continue to configure" }).click();
  await page.getByTestId("pool-create-bin-step").selectOption("10");
  await expect(page.getByTestId("pool-create-price")).toHaveValue("");
  await page.getByTestId("pool-create-price").fill("1");
  if (createAndAdd) await page.getByLabel("After canonical creation, offer a separate fresh Create Position review").check();
  await page.getByTestId("pool-create-risk-ack").check();
  await expect(page.getByTestId("pool-create-price-preview")).toContainText(String(ACTIVE_ID));
  await page.getByRole("button", { name: "Review exact creation" }).click();
  await expect(page.getByTestId("pool-create-review")).toBeVisible();
}

async function submitReviewedCreation(page: Page) {
  await page.getByTestId("pool-create-submit").click();
  await expect(page.getByTestId("gas-review")).toBeVisible();
  await page.getByTestId("pool-create-submit").click();
}

test("wallet chooser dismissal preserves pool configuration and does not close the wizard", async ({ page }) => {
  await installMockRpc(page, creationRpc);
  await installMockWallet(page, { allowTransactions: false, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/pools");
  await page.getByTestId("pool-create-launch").click();
  await page.getByTestId("pool-create-token-x").fill(WNATIVE);
  await page.getByTestId("pool-create-token-y").selectOption(USDT);
  await page.getByRole("button", { name: "Continue to configure" }).click();
  await page.getByTestId("pool-create-price").fill("1");
  await page.getByTestId("pool-create-risk-ack").check();
  await expect(page.getByTestId("pool-create-review-action")).toHaveText("Connect wallet to review");

  await page.getByTestId("pool-create-review-action").click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await expect(page.getByTestId("pool-creation-wizard")).toBeVisible();
  await expect(page.getByTestId("pool-create-price")).toHaveValue("1");
  await expect.poll(() => page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.includes("pool-creation-open")))).toEqual([
    ["feather.pool-creation-open.v1.localnet", "true"]
  ]);

  await connectMockWallet(page);
  await expect(page.getByTestId("pool-create-price")).toHaveValue("1");
  await expect(page.getByTestId("pool-create-review-action")).toHaveText("Review exact creation");
});

test("Discover creates an exact empty pool and preserves an RPC workspace while indexing lags", async ({ page }) => {
  await installMockRpc(page, {
    ...creationRpc,
    binReserveX: 0n,
    binReserveY: 0n,
    binTotalSupply: 0n,
    blockNumberAfterReceipt: 44n,
    createdPairAddress: CREATED_WETH_USDT_PAIR,
    includePairs: true,
    pairReserveX: 0n,
    pairReserveY: 0n,
    receiptBlockNumber: 43n
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await configureCreation(page, true);

  const review = page.getByTestId("pool-create-review");
  await expect(review).toContainText("WNATIVE (X/base) → USDT (Y/quote)");
  await expect(review).toContainText("1");
  await expect(review).toContainText("base 20 · variable 40000 · protocol 1000");
  await submitReviewedCreation(page);

  await expect(page.getByTestId("pool-create-result")).toContainText(/discovery catching up|Pool verified/i, { timeout: 15_000 });
  await expect(page.getByTestId("pool-rpc-overlay")).toContainText("empty pool cannot quote swaps");
  await expect(page.getByTestId("pool-create-position")).toContainText("fresh review");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const positionHref = await page.getByTestId("pool-create-position").getAttribute("href");
  await page.getByRole("link", { name: "Open confirmed pool" }).click();
  const mobileTradeTab = page.getByRole("tablist", { name: "Pool workspace views" }).getByRole("tab", { name: "Trade" });
  if ((page.viewportSize()?.width ?? 1_280) <= 720) {
    await expect(mobileTradeTab).toBeVisible();
    await mobileTradeTab.click();
  }
  await page.getByRole("navigation", { name: "Pool tasks" }).getByRole("link", { name: "Swap" }).click();
  await expect(page.getByTestId("swap-market-recovery")).toContainText(/empty|cannot quote|no swap liquidity/i);
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await page.evaluate((href) => { window.location.hash = href!.slice(1); }, positionHref);
  await expect(page).toHaveURL(new RegExp(`/liquidity/add/${CREATED_WETH_USDT_PAIR}`, "i"));
  await expect(page.getByTestId("liquidity-add-button")).toContainText("Review add liquidity");
  await expect(page.getByTestId("liquidity-add-review")).toHaveCount(0);

  const wallet = await readMockWallet(page);
  expect(wallet.sentTransactions).toHaveLength(1);
  const transaction = wallet.sentTransactions[0] as { data: `0x${string}`; to: string; value?: string };
  expect(transaction.value ?? "0x0").toMatch(/^0x0*$/);
  expect(decodeFunctionData({ abi: lbRouterAbi, data: transaction.data })).toEqual({
    functionName: "createLBPair",
    args: [WNATIVE, USDT, 8_388_608, 10]
  });
});

test("preexisting exact pool recovers fresh identity and reserves without a wallet send", async ({ page }) => {
  await installMockRpc(page, {
    ...creationRpc,
    activeId: ACTIVE_ID + 3,
    factoryLookupPair: CREATED_WETH_USDT_PAIR,
    pairAddress: CREATED_WETH_USDT_PAIR,
    pairBinStep: "10",
    pairReserveX: 77n,
    pairReserveY: 88n,
    pairTokenX: USDT,
    pairTokenY: WNATIVE,
    poolCreationQuoteAssets: [WNATIVE, USDT],
    priceQ128ByBin: { [String(ACTIVE_ID)]: Q128, [String(ACTIVE_ID + 3)]: priceQ128FromActiveId(BigInt(ACTIVE_ID + 3), 10n) }
  });
  await installMockWallet(page, { allowTransactions: false, chainId: LOCALNET_CHAIN_ID });
  await openCreationWizard(page);
  await page.getByTestId("pool-create-token-x").fill(WNATIVE);
  await page.getByTestId("pool-create-token-y").selectOption(USDT);
  await page.getByRole("button", { name: "Continue to configure" }).click();
  await page.getByTestId("pool-create-bin-step").selectOption("10");
  await page.getByTestId("pool-create-price").fill("1");
  await page.getByTestId("pool-create-risk-ack").check();
  await page.getByRole("button", { name: "Review exact creation" }).click();

  await expect(page.getByTestId("pool-create-result")).toContainText("This pool already exists");
  await expect(page.getByTestId("pool-create-result")).toContainText(String(ACTIVE_ID + 3));
  await expect(page.getByTestId("pool-create-result")).toContainText("USDT / WNATIVE");
  await expect(page.getByRole("status").filter({ hasText: /reserves/i })).toContainText("77 X / 88 Y");
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(0);
});

test("a final pre-wallet race recovers the winner and blocks blind create retry", async ({ page }) => {
  const rpc = await installMockRpc(page, creationRpc);
  await installMockWallet(page, { allowTransactions: false, chainId: LOCALNET_CHAIN_ID });
  await configureCreation(page, true);
  await page.getByTestId("pool-create-submit").click();
  await expect(page.getByTestId("gas-review")).toBeVisible();

  rpc.update({
    factoryLookupPair: CREATED_WETH_USDT_PAIR,
    pairAddress: CREATED_WETH_USDT_PAIR,
    pairBinStep: "10",
    pairReserveX: 5n,
    pairReserveY: 8n,
    pairTokenX: WNATIVE,
    pairTokenY: USDT
  });
  await page.getByTestId("pool-create-submit").click();
  await expect(page.getByTestId("pool-create-result")).toContainText("created first by another transaction");
  await expect(page.getByTestId("pool-create-result")).toContainText("No duplicate creation was submitted");
  await expect(page.getByTestId("pool-create-position")).toContainText("fresh review");
  await expect(page.getByTestId("pool-create-submit")).toHaveCount(0);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(0);
});

test("token, preset, and quote validation fail closed before review", async ({ page }) => {
  const rpc = await installMockRpc(page, { ...creationRpc, noCodeAddresses: [NO_CODE_TOKEN] });
  await installMockWallet(page, { allowTransactions: false, chainId: LOCALNET_CHAIN_ID });
  await openCreationWizard(page);

  await page.getByTestId("pool-create-token-x").fill(USDT);
  await page.getByTestId("pool-create-token-y").selectOption(USDT);
  await page.getByRole("button", { name: "Continue to configure" }).click();
  await expect(page.getByRole("alert").last()).toContainText(/must differ|must be distinct|same token/i);

  await page.getByTestId("pool-create-token-x").fill(NO_CODE_TOKEN);
  await page.getByRole("button", { name: "Continue to configure" }).click();
  await expect(page.getByRole("alert").last()).toContainText(/deployed code|no code/i);

  await page.getByTestId("pool-create-token-x").fill(WNATIVE);
  await page.getByRole("button", { name: "Continue to configure" }).click();
  await page.getByTestId("pool-create-bin-step").selectOption("10");
  await page.getByTestId("pool-create-price").fill("1");
  await page.getByTestId("pool-create-risk-ack").check();
  rpc.update({ poolCreationPresetOpen: false });
  await page.getByRole("button", { name: "Review exact creation" }).click();
  await expect(page.getByRole("alert").last()).toContainText(/preset.*(closed|no longer open)/i);
  rpc.update({ poolCreationPresetOpen: true, poolCreationQuoteAssets: [] });
  await page.getByRole("button", { name: "Review exact creation" }).click();
  await expect(page.getByRole("alert").last()).toContainText("no longer a factory quote asset");
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(0);
});

test("exact simulation failure and wallet rejection never produce false creation success", async ({ page }) => {
  const rpc = await installMockRpc(page, { ...creationRpc, simulationMode: "error" });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID, rejectTransactions: true });
  await configureCreation(page);
  await submitReviewedCreation(page);
  await expect(page.getByRole("alert").last()).toContainText(/Missing or invalid parameters|pool creation simulation failed/i);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(0);

  rpc.update({ simulationMode: "success" });
  await page.getByTestId("pool-create-submit").click();
  await expect(page.getByTestId("pool-create-result")).toContainText("Creation was not submitted");
  await expect(page.getByTestId("pool-rpc-overlay")).toHaveCount(0);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(1);
});

test("a mined revert exposes no pool overlay or position handoff", async ({ page }) => {
  await installMockRpc(page, { ...creationRpc, receiptStatus: "reverted", receiptBlockNumber: 43n });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await configureCreation(page, true);
  await submitReviewedCreation(page);
  await expect(page.getByTestId("pool-create-result")).toContainText("Creation reverted on-chain", { timeout: 15_000 });
  await expect(page.getByTestId("pool-rpc-overlay")).toHaveCount(0);
  await expect(page.getByTestId("pool-create-position")).toHaveCount(0);
});

test("a post-confirmation orphan removes the RPC overlay and requires a fresh review", async ({ page }) => {
  const rpc: InstalledMockRpc = await installMockRpc(page, {
    ...creationRpc,
    binReserveX: 0n,
    binReserveY: 0n,
    binTotalSupply: 0n,
    blockNumberAfterReceipt: 44n,
    createdPairAddress: CREATED_WETH_USDT_PAIR,
    pairReserveX: 0n,
    pairReserveY: 0n,
    receiptBlockNumber: 43n
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await configureCreation(page, true);
  await submitReviewedCreation(page);
  await expect(page.getByTestId("pool-rpc-overlay")).toBeVisible({ timeout: 15_000 });

  rpc.update({ blockHash: "0x4444444444444444444444444444444444444444444444444444444444444444" });
  await expect(page.getByTestId("pool-create-result")).toContainText("Confirmation changed after a chain reorganization", { timeout: 15_000 });
  await expect(page.getByTestId("pool-rpc-overlay")).toHaveCount(0);
  await expect(page.getByTestId("pool-create-position")).toHaveCount(0);
});
