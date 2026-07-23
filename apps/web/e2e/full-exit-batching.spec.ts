import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, type Hex } from "viem";

import { lbRouterAbi } from "../../../packages/sdk/src/abi";
import {
  installMockRpc,
  type InstalledMockRpc,
  type MockRpcOptions
} from "./fixtures/mock-rpc";
import {
  installMockWallet,
  LOCALNET_CHAIN_ID,
  openAndSelectMockWallet,
  readMockWallet
} from "./fixtures/mock-wallet";

const ACTIVE_ID = 8_388_608n;
const DEFAULT_LIVE_BALANCE = 2_000_000_000_000_000_000n;

for (const [label, binCount, expectedTransactions] of [
  ["below", 47, 1],
  ["at", 48, 1],
  ["above", 49, 2]
] as const) {
  test(`${label}-policy-boundary full exit discloses a provisional ${expectedTransactions}-transaction serial plan`, async ({ page }) => {
    await setupFullExit(page, { ownerPositionCount: binCount });

    await beginFullExitReview(page);

    const status = page.getByTestId("full-exit-workflow-status");
    await expect(status).toContainText(`${binCount} live bins require ${expectedTransactions} non-atomic transaction`);
    await expect(status).toContainText("each later batch requires fresh enumeration, finality, and explicit review");
    expect((await readMockWallet(page)).sentTransactions).toEqual([]);
  });
}

test("advancing RPC and indexer heads together converges without invalidating an unchanged reviewed batch", async ({ page }) => {
  const rpc = await setupFullExit(page, { ownerPositionCount: 1 });
  await beginFullExitReview(page);

  rpc.update({ blockNumber: 43n, indexerBlockNumber: 43n });
  await page.getByTestId("liquidity-remove-button").click();

  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  await expect(page.getByText(/full-exit batch mined/i)).toBeVisible();
});

test("a delayed policy probe and submitted review use identical immutable-deadline calldata", async ({ page }) => {
  const rpc = await setupFullExit(page, { ownerPositionCount: 1, simulationDelayMs: 1_500 });
  await beginFullExitReview(page);
  const policyProbe = rpc.snapshot().ethCalls.find((call) => call.functionName === "removeLiquidity");
  expect(policyProbe).toBeDefined();

  await page.getByTestId("liquidity-remove-button").click();
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length, { timeout: 15_000 }).toBe(1);

  const submitted = (await readMockWallet(page)).sentTransactions[0] as { data?: Hex };
  expect(submitted.data).toBe(policyProbe?.data);
  const probed = decodeFunctionData({ abi: lbRouterAbi, data: policyProbe!.data });
  const sent = decodeFunctionData({ abi: lbRouterAbi, data: submitted.data! });
  expect((sent.args as readonly unknown[])[8]).toBe((probed.args as readonly unknown[])[8]);
});

for (const [name, options, expectedError] of [
  ["gas-estimate unavailable", { gasEstimateMode: "error" }, /candidate probe is unavailable|Missing or invalid parameters/i],
  ["simulation or calldata capacity", { maxRemoveLiquidityBinsForSimulation: 0 }, /semantic failure|Missing or invalid parameters/i]
] as const) {
  test(`${name} probe failure opens zero wallet requests`, async ({ page }) => {
    await setupFullExit(page, { ownerPositionCount: 1, ...options });

    await page.getByTestId("liquidity-remove-button").click();

    await expect(page.getByText(expectedError).first()).toBeVisible();
    expect((await readMockWallet(page)).sentTransactions).toEqual([]);
  });
}

test("a live balance change before second click forces a new review and submits only the current balance", async ({ page }) => {
  const rpc = await setupFullExit(page, { ownerPositionCount: 1 });
  await beginFullExitReview(page);

  const currentLiveBalance = 1_500_000_000_000_000_000n;
  rpc.update({
    binTotalSupply: currentLiveBalance,
    blockNumber: 43n,
    indexerBlockNumber: 43n,
    livePositionBalance: currentLiveBalance,
    positionLiquidity: currentLiveBalance
  });
  await page.getByTestId("liquidity-remove-button").click();
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
  await expect(page.getByTestId("gas-review")).toContainText("full liquidity exit");

  await page.getByTestId("liquidity-remove-button").click();
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  const remove = decodeRemove((await readMockWallet(page)).sentTransactions[0]);
  expect(remove.ids).toEqual([ACTIVE_ID]);
  expect(remove.amounts).toEqual([currentLiveBalance]);
});

test("a shallow first batch blocks replanning until 12-confirmation finality", async ({ page }) => {
  await setupFullExit(page, { ownerPositionCount: 49 });
  await submitReviewedFullExit(page);
  await expect(page.getByText(/full-exit batch mined/i)).toBeVisible();

  await page.getByTestId("resume-full-exit-button").click();

  await expect(page.getByTestId("full-exit-workflow-status")).toContainText(/not yet finalized|confirmations|finality/i);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(1);
});

test("finalized partial completion rejects then resumes only a newly live bin and verifies zero before completion", async ({ page }) => {
  test.setTimeout(60_000);
  const rpc = await setupFullExit(page, { ownerPositionCount: 1 });
  await submitReviewedFullExit(page);
  const first = decodeRemove((await readMockWallet(page)).sentTransactions[0]);
  expect(first.ids).toEqual([ACTIVE_ID]);
  expect(first.amounts[0]).toBeLessThanOrEqual(DEFAULT_LIVE_BALANCE);

  rpc.update({ blockNumber: 53n, indexerBlockNumber: 53n, receiptBlockNumber: 42n });
  await expectFinalizedRemoveCount(page, 1);

  const transferredBalance = 3_000_000_000_000_000_000n;
  rpc.update({
    analyticsOutOfRange: true,
    binTotalSupply: transferredBalance,
    blockNumber: 54n,
    indexerBlockNumber: 54n,
    livePositionBalance: transferredBalance,
    ownerPositionCount: 1,
    positionLiquidity: transferredBalance,
    receiptBlockNumber: 54n
  });
  await page.getByTestId("resume-full-exit-button").click();
  await expect(page.getByTestId("gas-review")).toContainText("full liquidity exit");
  await page.evaluate(() => { window.__mockWalletState.rejectTransactions = true; });
  await page.getByTestId("resume-full-exit-button").click();
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(2);
  await expect(page.getByText(/user rejected/i).first()).toBeVisible();
  const preReloadWallet = await readMockWallet(page);
  const rejectedAttempt = decodeRemove(preReloadWallet.sentTransactions[1]);
  const rejectedJournalRecord = await page.evaluate(() => {
    const raw = window.localStorage.getItem("feather.transaction-journal.v1");
    if (raw === null) return null;
    const records = (JSON.parse(raw) as {
      records: Array<{ activeHash: string | null; status: string }>;
    }).records;
    return records.findLast((record) => record.status === "rejected") ?? null;
  });
  expect(rejectedJournalRecord).toMatchObject({ activeHash: null, status: "rejected" });

  await page.reload();
  await reconnectIfNeeded(page);
  await page.evaluate(() => { window.__mockWalletState.rejectTransactions = false; });
  await expect(page.getByTestId("resume-full-exit-button")).toBeVisible();
  await page.getByTestId("resume-full-exit-button").click();
  await expect(page.getByTestId("gas-review")).toContainText("full liquidity exit");
  await page.getByTestId("resume-full-exit-button").click();
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);

  const postReloadWallet = await readMockWallet(page);
  const resumed = decodeRemove(postReloadWallet.sentTransactions[0]);
  const allWalletRequests = [
    ...preReloadWallet.sentTransactions.map(decodeRemove),
    ...postReloadWallet.sentTransactions.map(decodeRemove)
  ];
  expect(rejectedAttempt.ids).toEqual([ACTIVE_ID + 10n]);
  expect(resumed.ids).toEqual([ACTIVE_ID + 10n]);
  expect(resumed.amounts).toEqual([transferredBalance]);
  expect(resumed.amounts[0]).toBeLessThanOrEqual(transferredBalance);
  expect(new Set([...first.ids, ...resumed.ids]).size).toBe(first.ids.length + resumed.ids.length);
  expect(allWalletRequests).toHaveLength(3);
  expect(postReloadWallet.sentTransactions).toHaveLength(1);

  rpc.update({
    blockNumber: 65n,
    includePositions: false,
    indexerBlockNumber: 65n,
    livePositionBalance: 0n,
    receiptBlockNumber: 54n
  });
  await expectFinalizedRemoveCount(page, 2);
  await page.getByTestId("resume-full-exit-button").click();

  await expect(page.getByTestId("full-exit-workflow-status")).toContainText("Full exit verified complete: zero positive owner bins");
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(1);
});

async function setupFullExit(page: Page, options: MockRpcOptions): Promise<InstalledMockRpc> {
  const rpc = await installMockRpc(page, {
    includePairs: true,
    includePositions: true,
    lbApproved: true,
    ...options
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connectWallet(page);
  const picker = page.getByRole("group", { name: "Positions" }).first();
  await expect(picker.locator('input[type="checkbox"]')).toHaveCount(options.ownerPositionCount ?? 1);
  await picker.getByRole("button", { name: "All" }).click();
  await page.getByRole("group", { name: "Withdrawal percentage presets" }).getByRole("button", { name: "Max" }).click();
  await expect(page.getByTestId("withdraw-transaction-review")).toContainText("Full exit");
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  return rpc;
}

async function connectWallet(page: Page): Promise<void> {
  await openAndSelectMockWallet(page);
  await expect(page.getByTestId("wallet-account-button")).toContainText("0xf39F...2266");
}

async function reconnectIfNeeded(page: Page): Promise<void> {
  const connectButton = page.getByTestId("wallet-connect-button");
  const accountButton = page.getByTestId("wallet-account-button");
  await connectButton.or(accountButton).first().waitFor({ state: "visible" });
  if (!await accountButton.isVisible()) await openAndSelectMockWallet(page);
  await expect(accountButton).toContainText("0xf39F...2266");
}

async function beginFullExitReview(page: Page): Promise<void> {
  await page.getByTestId("liquidity-remove-button").click();
  await expect(page.getByTestId("gas-review")).toContainText("full liquidity exit");
  await expect(page.getByTestId("full-exit-workflow-status")).toContainText("Safe serial plan");
}

async function submitReviewedFullExit(page: Page): Promise<void> {
  await beginFullExitReview(page);
  await page.getByTestId("liquidity-remove-button").click();
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
}

async function expectFinalizedRemoveCount(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const raw = window.localStorage.getItem("feather.transaction-journal.v1");
    if (raw === null) return 0;
    const records = (JSON.parse(raw) as {
      records: Array<{ confirmations: number; reviewed: { intent: string }; status: string }>;
    }).records;
    return records.filter((record) =>
      record.reviewed.intent === "remove-liquidity" &&
      record.status === "canonical" &&
      record.confirmations >= 12
    ).length;
  }), { timeout: 12_000 }).toBe(count);
}

function decodeRemove(transaction: unknown): { amounts: readonly bigint[]; ids: readonly bigint[] } {
  const submitted = transaction as { data?: Hex };
  expect(submitted.data).toBeTruthy();
  const decoded = decodeFunctionData({ abi: lbRouterAbi, data: submitted.data! });
  expect(decoded.functionName).toBe("removeLiquidity");
  const args = decoded.args as readonly unknown[];
  return { ids: args[5] as readonly bigint[], amounts: args[6] as readonly bigint[] };
}
