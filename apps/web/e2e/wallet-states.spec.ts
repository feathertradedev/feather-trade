import { expect, test } from "@playwright/test";
import { decodeFunctionData, type Hex } from "viem";

import { erc20Abi, lbPairAbi, lbRouterAbi } from "../../../packages/sdk/src/abi";
import { buildLiquidityDistribution } from "../../../packages/sdk/src/liquidity";
import {
  installMockRpc,
  LB_ROUTER,
  LOCALNET_INDEXER_URL,
  SECOND_WNATIVE_USDC_PAIR,
  WNATIVE,
  WNATIVE_USDC_PAIR,
  type InstalledMockRpc,
  type MockRpcOptions
} from "./fixtures/mock-rpc";
import { DEFAULT_ACCOUNT, installMockWallet, LOCALNET_CHAIN_ID, readMockWallet, ROBINHOOD_TESTNET_CHAIN_ID } from "./fixtures/mock-wallet";

const ONE_TOKEN = 1_000_000_000_000_000_000n;
const ROBINHOOD_TESTNET_RPC_URL = "https://rpc.testnet.chain.robinhood.com";
const TRANSACTION_ABI = [...erc20Abi, ...lbPairAbi, ...lbRouterAbi] as const;

interface RuntimeRpcRequest {
  id?: number | string | null;
  method: string;
}

test("disconnected wallet state disables guarded swap actions", async ({ page }) => {
  await installMockRpc(page);
  await page.goto("/#/swap");

  await expect(page.getByTestId("wallet-connect-button")).toBeVisible();
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
  await expect(page.getByTestId("swap-balance-value")).toHaveText("connect wallet");
});

test("missing injected provider is distinguished from an ordinary disconnected wallet", async ({ page }) => {
  await installMockRpc(page);
  await page.goto("/#/swap");

  await expect(page.getByTestId("wallet-connect-button")).toBeDisabled();
  await expect(page.getByTestId("wallet-status")).toHaveAttribute("data-wallet-state", "missing");
  await expect(page.getByTestId("wallet-status")).toContainText("No wallet provider was found");
});

for (const failure of [
  { mode: "locked", name: "locked", state: "locked", text: "Unlock the selected wallet" },
  { mode: "disconnected", name: "provider-disconnected", state: "provider-error", text: "wallet provider is disconnected" },
  { mode: "unauthorized", name: "unauthorized", state: "provider-error", text: "has not authorized account access" },
  { mode: "permission-rejected", name: "permission-rejected", state: "permission-rejected", text: "Account permission was rejected" },
  { mode: "provider-error", name: "provider-error", state: "provider-error", text: "selected wallet returned an error" }
] as const) {
  test(`${failure.name} connect state is actionable and remains disconnected`, async ({ page }) => {
    await installMockRpc(page);
    await installMockWallet(page, { connectMode: failure.mode });
    await page.goto("/#/swap");

    await page.getByTestId("wallet-connect-button").click();
    await expect(page.getByTestId("wallet-status")).toHaveAttribute("data-wallet-state", failure.state);
    await expect(page.getByTestId("wallet-status")).toContainText(failure.text);
    await expect(page.getByTestId("wallet-account-button")).toHaveCount(0);
    await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  });
}

test("multiple EIP-6963 providers require an explicit provider choice", async ({ page }) => {
  await installMockRpc(page);
  await installMockWallet(page, {
    account: "0x1111111111111111111111111111111111111111",
    primaryProvider: { name: "Brave Wallet", rdns: "com.brave.wallet", uuid: "robinhood-lb-brave-wallet" },
    additionalProviders: [
      { account: DEFAULT_ACCOUNT, name: "MetaMask", rdns: "io.metamask", uuid: "robinhood-lb-metamask" },
      { account: DEFAULT_ACCOUNT, name: "Duplicate MetaMask", rdns: "io.metamask", uuid: "robinhood-lb-metamask-duplicate" },
      { account: DEFAULT_ACCOUNT, name: "Unknown Wallet", rdns: "org.example.unknown", uuid: "robinhood-lb-unknown" }
    ]
  });
  await page.goto("/#/swap");

  const choices = page.getByTestId("wallet-provider-choices");
  await expect(choices.getByRole("button")).toHaveCount(2);
  await expect(page.getByTestId("wallet-connect-button")).toHaveCount(0);
  await choices.getByRole("button", { name: "Brave Wallet" }).click();
  await expect(page.getByTestId("wallet-account-button")).toContainText("0x1111...1111");
  expect(await page.evaluate(() => window.__mockWalletStates["io.metamask"].calls)).toEqual([]);
});

test("unsupported announced provider remains non-executable", async ({ page }) => {
  await installMockRpc(page);
  await installMockWallet(page, {
    primaryProvider: { name: "Unknown Wallet", rdns: "org.example.unknown", uuid: "robinhood-lb-unknown" }
  });
  await page.goto("/#/swap");

  await expect(page.getByTestId("wallet-connect-button")).toBeDisabled();
  await expect(page.getByTestId("wallet-status")).toHaveAttribute("data-wallet-state", "missing");
  await expect(page.getByTestId("wallet-status")).toContainText("No supported wallet was found");
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
});

test("unknown active network is added before switching", async ({ page }) => {
  await installMockRpc(page);
  await installMockWallet(page, { chainId: ROBINHOOD_TESTNET_CHAIN_ID, switchMode: "add-required" });
  await page.goto("/#/swap");
  await connectWallet(page);

  await expect(page.getByTestId("wallet-status")).toHaveAttribute("data-wallet-state", "wrong-chain");
  await page.getByTestId("wallet-switch-button").click();
  await expect(page.getByTestId("wallet-switch-button")).toBeHidden();
  expect((await readMockWallet(page)).addChainCalls).toContain(LOCALNET_CHAIN_ID);
});

test("rejected add/switch request remains a distinct actionable wrong-chain state", async ({ page }) => {
  await installMockRpc(page);
  await installMockWallet(page, { chainId: ROBINHOOD_TESTNET_CHAIN_ID, switchMode: "add-rejected" });
  await page.goto("/#/swap");
  await connectWallet(page);

  await page.getByTestId("wallet-switch-button").click();
  await expect(page.getByTestId("wallet-status")).toHaveAttribute("data-wallet-state", "switch-rejected");
  await expect(page.getByTestId("wallet-status")).toContainText("Network switch was rejected");
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
});

test("exact buffered gas insufficiency blocks swap but funding ETH recovers without changing intent", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN, estimatedGas: 2_000_000n, nativeBalance: 1_000_000_000_000_000n });

  await expect(page.getByTestId("swap-native-balance")).toContainText("0.001 ETH");
  await page.getByTestId("swap-submit-button").click();
  await expect(page.getByTestId("gas-review")).toContainText("0.0025 ETH required");
  await expect(page.getByTestId("swap-failure-state")).toContainText("Insufficient ETH for gas");
  await expect(page.getByTestId("swap-submit-button")).toContainText("Insufficient ETH for gas");
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
  expect(simulatedFunctions(rpc).filter((name) => name === "swapExactTokensForTokens")).toHaveLength(1);
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);

  rpc.update({ nativeBalance: 10_000_000_000_000_000n });
  await page.getByTestId("swap-submit-button").click();
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  expect(simulatedFunctions(rpc).filter((name) => name === "swapExactTokensForTokens")).toHaveLength(2);
});

test("exact buffered gas insufficiency blocks LP submission without dead-ending the action", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    estimatedGas: 2_000_000n,
    nativeBalance: 1_000_000_000_000_000n
  });

  await expect(page.getByTestId("liquidity-native-balance")).toContainText("0.001 ETH");
  await page.getByTestId("liquidity-add-button").click();
  await expect(page.getByTestId("gas-review")).toContainText("0.0025 ETH required");
  await expect(page.getByText(/Insufficient ETH for gas/).first()).toBeVisible();
  await expect(page.getByTestId("liquidity-add-button")).toBeEnabled();
  expect(simulatedFunctions(rpc).filter((name) => name === "addLiquidity")).toHaveLength(1);
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);

  rpc.update({ nativeBalance: 10_000_000_000_000_000n });
  await page.getByTestId("liquidity-add-button").click();
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  expect(simulatedFunctions(rpc).filter((name) => name === "addLiquidity")).toHaveLength(2);
});

test("an exact low-cost gas review permits a balance below the former fixed reserve", async ({ page }) => {
  await setupConnectedSwap(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    estimatedGas: 21_000n,
    nativeBalance: 100_000_000_000_000n
  });

  await clickReviewedAction(page, "swap-submit-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  await expect(page.getByTestId("gas-review")).toContainText("0.00002625 ETH required");
});

test("gas estimation failure blocks before wallet handoff and remains retryable", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    gasEstimateMode: "error"
  });

  await page.getByTestId("swap-submit-button").click();
  await expect(page.getByTestId("swap-failure-state")).toContainText("Gas estimation failed");
  await expect(page.getByTestId("gas-review")).toHaveCount(0);
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);

  rpc.update({ gasEstimateMode: "ready" });
  await clickReviewedAction(page, "swap-submit-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
});

test("gas requirement drift above the reviewed buffer requires another review", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    estimatedGas: 500_000n
  });
  await page.getByTestId("swap-submit-button").click();
  await expect(page.getByTestId("gas-review")).toContainText("0.000625 ETH required");

  rpc.update({ estimatedGas: 2_000_000n });
  await page.getByTestId("swap-submit-button").click();
  await expect(page.getByTestId("gas-review")).toContainText("0.0025 ETH required");
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);

  await page.getByTestId("swap-submit-button").click();
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
});

test("repeated clicks during delayed gas estimation cannot launch duplicate wallet prompts", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    gasEstimateDelayMs: 500
  });

  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="swap-submit-button"]');
    button?.click();
    button?.click();
  });
  await expect(page.getByTestId("gas-review")).toBeVisible();
  expect(rpc.snapshot().methods.filter((method) => method === "eth_estimateGas")).toHaveLength(1);
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("swap input and quote changes during second-click gas review discard stale review and block wallet handoff", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN
  });

  await page.getByTestId("swap-submit-button").click();
  await expect(page.getByTestId("gas-review")).toBeVisible();
  rpc.update({ gasEstimateDelayMs: 500 });
  await page.getByTestId("swap-submit-button").click();
  await expect.poll(() => rpc.snapshot().methods.filter((method) => method === "eth_estimateGas").length).toBe(2);

  await page.locator("#swap-amount").fill("2.0");
  await expect(page.getByTestId("gas-review")).toHaveCount(0);
  await expect.poll(() => rpc.snapshot().gasEstimatesCompleted).toBe(2);
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("LP input changes during second-click gas review discard stale review and block wallet handoff", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true
  });

  await expect(page.getByTestId("liquidity-add-button")).toBeEnabled();
  await page.getByTestId("liquidity-add-button").click();
  await expect(page.getByTestId("gas-review")).toBeVisible();
  rpc.update({ gasEstimateDelayMs: 500 });
  await page.getByTestId("liquidity-add-button").click();
  await expect.poll(() => rpc.snapshot().methods.filter((method) => method === "eth_estimateGas").length).toBe(2);

  await page.getByTestId("liquidity-amount-x").fill("0.02");
  await expect(page.getByTestId("gas-review")).toHaveCount(0);
  await expect.poll(() => rpc.snapshot().gasEstimatesCompleted).toBe(2);
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("LP selection changes during second-click gas review discard stale review and block wallet handoff", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true
  });

  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await page.getByTestId("liquidity-remove-button").click();
  await expect(page.getByTestId("gas-review")).toBeVisible();
  rpc.update({ gasEstimateDelayMs: 500 });
  await page.getByTestId("liquidity-remove-button").click();
  await expect.poll(() => rpc.snapshot().methods.filter((method) => method === "eth_estimateGas").length).toBe(2);

  await page.getByRole("group", { name: "Positions" }).getByRole("checkbox").first().uncheck();
  await expect(page.getByTestId("gas-review")).toHaveCount(0);
  await expect.poll(() => rpc.snapshot().gasEstimatesCompleted).toBe(2);
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("account change resets executable state and receipt banners but preserves the immutable submission record", async ({ page }) => {
  await setupConnectedSwap(page, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN });
  await page.locator("#swap-amount").fill("2.25");
  await clickReviewedAction(page, "swap-submit-button");
  await expect(page.getByText("Swap confirmed")).toBeVisible();
  await expect(page.getByTestId("submitted-transaction-journal")).toHaveCount(1);

  await page.evaluate(() => window.__mockWalletControl.setAccounts(["0x1111111111111111111111111111111111111111"]));
  await expect(page.getByTestId("wallet-account-button")).toContainText("0x1111...1111");
  await expect(page.locator("#swap-amount")).toHaveValue("1.0");
  await expect(page.getByText("Receipt state will appear here")).toBeVisible();
  await expect(page.getByText("Swap confirmed")).toHaveCount(0);
  await expect(page.getByTestId("submitted-transaction-journal")).toHaveCount(0);
  expect(await persistedTransactionJournalCount(page)).toBe(1);
});

test("disconnect, reconnect, chain, and environment changes clear prior-owner drafts", async ({ page }) => {
  await installMockRpc(page);
  await installMockWallet(page);
  await page.goto("/#/swap");
  await connectWallet(page);
  await page.locator("#swap-amount").fill("7.5");

  await page.getByTestId("wallet-account-button").click();
  await expect(page.getByTestId("wallet-connect-button")).toBeVisible();
  await expect(page.locator("#swap-amount")).toHaveValue("1.0");
  await connectWallet(page);
  await page.locator("#swap-amount").fill("6.5");
  await page.evaluate((chainId) => window.__mockWalletControl.setChain(chainId), ROBINHOOD_TESTNET_CHAIN_ID);
  await expect(page.getByTestId("wallet-switch-button")).toBeVisible();
  await expect(page.locator("#swap-amount")).toHaveValue("1.0");

  await page.locator("#swap-amount").fill("5.5");
  await page.getByRole("button", { name: /Robinhood Testnet/ }).click();
  await expect(page.locator("#swap-amount")).toHaveValue("1.0");
});

test("provider-emitted disconnect requires an explicit reconnect and reloads wallet reads", async ({ page }) => {
  const rpc = await installMockRpc(page);
  await installMockWallet(page);
  await page.goto("/#/swap");
  await connectWallet(page);
  const readsBefore = rpc.snapshot().ethCalls.filter((call) => call.functionName === "allowance").length;

  await page.evaluate(() => window.__mockWalletControl.disconnect());
  await expect(page.getByTestId("wallet-connect-button")).toBeVisible();
  await expect(page.getByTestId("swap-balance-value")).toHaveText("connect wallet");
  await connectWallet(page);
  await expect.poll(() => rpc.snapshot().ethCalls.filter((call) => call.functionName === "allowance").length).toBeGreaterThan(readsBefore);
});

test("LP owner change reissues owner queries and clears LP drafts and terminal banners", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, { allowance: 0n, balance: 5n * ONE_TOKEN });
  await page.getByTestId("liquidity-amount-x").fill("2.5");
  await clickReviewedAction(page, "liquidity-approve-x-button");
  await expect(page.getByText("Token approval confirmed")).toBeVisible();

  const nextOwner = "0x1111111111111111111111111111111111111111";
  rpc.update({ allowance: 5n * ONE_TOKEN, balance: 3n * ONE_TOKEN });
  await page.evaluate((owner) => window.__mockWalletControl.setAccounts([owner]), nextOwner);

  await expect(page.getByTestId("wallet-account-button")).toContainText("0x1111...1111");
  await expect(page.getByTestId("liquidity-amount-x")).toHaveValue("0.01");
  await expect(page.getByText("Token approval confirmed")).toHaveCount(0);
  await expect.poll(() => rpc.snapshot().graphRequests.some((request) => request.variables?.owner?.toLowerCase() === nextOwner)).toBe(true);
  await expect(page.getByTestId("submitted-transaction-journal")).toHaveCount(0);
  expect(await persistedTransactionJournalCount(page)).toBe(1);
});

test("wrong-chain wallet state disables approvals and submit handlers", async ({ page }) => {
  const rpc = await installMockRpc(page);
  await installMockWallet(page, { chainId: ROBINHOOD_TESTNET_CHAIN_ID });
  await page.goto("/#/swap");

  await connectWallet(page);

  await expect(page.getByTestId("wallet-switch-button")).toBeVisible();
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();

  await bypassDisabledButtonAndClick(page, "swap-submit-button");
  await bypassDisabledButtonAndClick(page, "swap-approve-button");

  const wallet = await readMockWallet(page);
  expect(wallet.chainId).toBe(ROBINHOOD_TESTNET_CHAIN_ID);
  expect(wallet.sentTransactions).toEqual([]);
  expect(simulatedFunctions(rpc)).not.toContain("approve");
  expect(simulatedFunctions(rpc)).not.toContain("swapExactTokensForTokens");
});

test("wrong-chain RPC fails closed even when the wallet is on the expected chain", async ({ page }) => {
  const rpc = await installMockRpc(page, { chainId: ROBINHOOD_TESTNET_CHAIN_ID, includePairs: true, includePositions: true });
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connectWallet(page);

  await expect(page.locator(".status-pill").filter({ hasText: "Expected 31337, RPC 46630" })).toContainText(
    "Expected 31337, RPC 46630"
  );
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
  await expect(page.getByTestId("swap-failure-state")).toContainText("RPC chain mismatch: expected 31337, received 46630");
  await bypassDisabledButtonAndClick(page, "swap-submit-button");
  await bypassDisabledButtonAndClick(page, "swap-approve-button");

  await page.getByRole("link", { name: "Liquidity" }).click();
  for (const testId of liquidityActionTestIds) {
    await expect(page.getByTestId(testId)).toBeDisabled();
    await bypassDisabledButtonAndClick(page, testId);
  }

  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
  expect(simulatedFunctions(rpc)).toEqual([]);
});

test("wallet-read-loading state keeps swap actions disabled", async ({ page }) => {
  await installMockRpc(page, { walletReadDelayMs: 1_500 });
  await installMockWallet(page);
  await page.goto("/#/swap");

  await connectWallet(page);

  await expect(page.getByTestId("swap-balance-value")).toHaveText("loading");
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
});

test("wallet-read-error state fails closed and renders an actionable error", async ({ page }) => {
  await installMockRpc(page, { walletReadMode: "error" });
  await installMockWallet(page);
  await page.goto("/#/swap");

  await connectWallet(page);

  await expect(page.getByTestId("swap-failure-state")).toContainText("Wallet read failed");
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
});

test("empty selected pool renders position recovery and force-clicks make zero downstream calls", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    allowance: 0n,
    balance: 5n * ONE_TOKEN,
    includePairs: true,
    pairReserveX: 0n,
    pairReserveY: 0n
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connectWallet(page);

  const recovery = page.getByTestId("swap-market-recovery");
  await expect(recovery).toContainText("Selected pool has no swap liquidity yet");
  await expect(recovery.getByRole("link", { name: "Create position" })).toHaveAttribute(
    "href",
    `#/liquidity/add/${WNATIVE_USDC_PAIR.toLowerCase()}`
  );
  await assertSwapBlockedBeforeDownstream(page, rpc);
});

test("malformed selected pool fails closed before quote, simulation, or wallet submission", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    allowance: 0n,
    balance: 5n * ONE_TOKEN,
    includePairs: true,
    pairBinStep: "0"
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connectWallet(page);

  await expect(page.getByTestId("swap-market-recovery")).toContainText("Selected pool binStep is not a valid integer");
  await expect(page.getByTestId("swap-market-recovery").getByRole("button", { name: "Refresh market data" })).toBeVisible();
  await assertSwapBlockedBeforeDownstream(page, rpc);
});

test("unsafe selected-pool source fails closed before quote, simulation, or wallet submission", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    allowance: 0n,
    balance: 5n * ONE_TOKEN,
    includePairs: true,
    indexerHasErrors: true
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connectWallet(page);

  await expect(page.getByTestId("swap-market-recovery")).toContainText("Indexer reports indexing errors");
  await assertSwapBlockedBeforeDownstream(page, rpc);
});

test("insufficient-balance state blocks approval and swap submission", async ({ page }) => {
  await installMockRpc(page, { allowance: 0n, balance: 0n });
  await installMockWallet(page);
  await page.goto("/#/swap");

  await connectWallet(page);

  await expect(page.getByTestId("swap-submit-button")).toContainText("Insufficient balance");
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
  await expect(page.getByTestId("swap-failure-state")).toContainText("Insufficient token balance");
});

test("approval-needed state enables approval but guards swap until allowance exists", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, { allowance: 0n, balance: 5n * ONE_TOKEN });

  await expect(page.getByTestId("swap-approve-button")).toContainText("Approve WNATIVE");
  await expect(page.getByTestId("swap-approve-button")).toBeEnabled();
  await expect(page.getByTestId("swap-submit-button")).toContainText("Approve first");
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();

  await clickReviewedAction(page, "swap-approve-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);

  expect(simulatedFunctions(rpc)).toContain("approve");
  assertTransactionMatchesSimulation((await readMockWallet(page)).sentTransactions[0], rpc, "approve");
});

test("approval confirmation invalidates the reviewed quote until fresh wallet, market, and quote reads complete", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 0n,
    allowanceAfterReceipt: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    includePairs: true,
    indexerDelayMsAfterReceipt: 900,
    pairReserveXAfterReceipt: 80n * ONE_TOKEN,
    quoteRate: 999n,
    quoteRateAfterReceipt: 900n
  });
  const output = page.locator("#swap-output");
  await expect.poll(() => output.inputValue()).not.toBe("0");
  const preApprovalOutput = await output.inputValue();
  const quoteCallsBeforeApproval = rpc.snapshot().ethCalls.filter((call) => call.functionName === "findBestPathFromAmountIn").length;
  const selectedMarket = page.getByTestId("swap-selected-market-identity");
  const preApprovalReserve = await selectedMarket.getAttribute("data-reserve-x");

  await clickReviewedAction(page, "swap-approve-button");
  await expect(page.getByText("Approval confirmed")).toBeVisible({ timeout: 12_000 });
  await page.waitForTimeout(250);
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await expect(selectedMarket).toHaveAttribute("data-reserve-x", preApprovalReserve ?? "");
  expect(rpc.snapshot().ethCalls.filter((call) => call.functionName === "findBestPathFromAmountIn")).toHaveLength(
    quoteCallsBeforeApproval
  );
  await bypassDisabledButtonAndClick(page, "swap-submit-button");
  await expect(page.getByTestId("swap-failure-state")).toContainText(
    "Refreshing balance, allowance, and quote after approval"
  );

  expect(simulatedFunctions(rpc)).not.toContain("swapExactTokensForTokens");
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(1);

  await expect(selectedMarket).toHaveAttribute("data-reserve-x", (80n * ONE_TOKEN).toString(), { timeout: 12_000 });
  await expect.poll(() => output.inputValue(), { timeout: 12_000 }).not.toBe(preApprovalOutput);
  await expect(page.getByTestId("swap-allowance-value")).toContainText("5");
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();
  expect(rpc.snapshot().ethCalls.filter((call) => call.functionName === "findBestPathFromAmountIn").length).toBeGreaterThanOrEqual(2);

  const postApprovalOutput = await output.inputValue();
  const postApprovalQuoteCalls = rpc.snapshot().ethCalls.filter((call) => call.functionName === "findBestPathFromAmountIn").length;
  rpc.update({
    blockNumber: 43n,
    indexerBlockNumber: 43n,
    indexerDelayMs: 0,
    pairReserveX: 70n * ONE_TOKEN,
    quoteRate: 850n
  });
  await page.getByTestId("snapshot-refresh-button").click();

  await expect(selectedMarket).toHaveAttribute("data-reserve-x", (70n * ONE_TOKEN).toString());
  await expect.poll(() => output.inputValue()).not.toBe(postApprovalOutput);
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();
  expect(rpc.snapshot().ethCalls.filter((call) => call.functionName === "findBestPathFromAmountIn").length).toBeGreaterThan(
    postApprovalQuoteCalls
  );
});

test("a stale same-hash approval refresh cannot overwrite a newer intent generation", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 0n,
    allowanceAfterReceipt: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    includePairs: true,
    indexerDelayMsAfterReceipt: 900
  });

  await clickReviewedAction(page, "swap-approve-button");
  await expect(page.getByText("Approval confirmed")).toBeVisible({ timeout: 12_000 });
  await page.locator("#swap-slippage").fill("0.6");
  await expect(page.getByTestId("swap-approval-refresh-button")).toBeVisible();

  rpc.update({ indexerDelayMs: 0 });
  await page.getByTestId("swap-approval-refresh-button").click();
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled({ timeout: 12_000 });
  await page.waitForTimeout(1_100);

  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();
  await expect(page.getByTestId("swap-approval-refresh-button")).toHaveCount(0);
  await expect(page.getByTestId("swap-failure-state")).not.toContainText("Swap context changed while refreshing");
});

test("post-approval snapshot refresh rejects a malformed token identity at an otherwise unchanged market", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 0n,
    allowanceAfterReceipt: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    includePairs: true,
    indexerDelayMsAfterReceipt: 700,
    pairTokenXAfterReceipt: "malformed-token-address"
  });
  const selectedMarket = page.getByTestId("swap-selected-market-identity");
  const quoteCallsBeforeApproval = rpc.snapshot().ethCalls.filter((call) => call.functionName === "findBestPathFromAmountIn").length;
  const walletReadsBeforeApproval = rpc.snapshot().ethCalls.filter((call) => ["allowance", "balanceOf"].includes(call.functionName)).length;

  await expect(selectedMarket).toHaveAttribute("data-token-x", WNATIVE);
  await clickReviewedAction(page, "swap-approve-button");
  await expect(page.getByText("Approval confirmed")).toBeVisible({ timeout: 12_000 });
  await page.waitForTimeout(200);
  await expect(selectedMarket).toHaveAttribute("data-token-x", WNATIVE);
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();

  await expect(page.getByTestId("swap-market-recovery")).toContainText(
    "Selected pool tokenXAddress is not a valid address",
    { timeout: 12_000 }
  );
  await expect(selectedMarket).toHaveAttribute("data-token-x", "unavailable");
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
  await bypassDisabledButtonAndClick(page, "swap-submit-button");
  await bypassDisabledButtonAndClick(page, "swap-approve-button");
  await waitForForcedClickEffects(page);

  expect(rpc.snapshot().ethCalls.filter((call) => call.functionName === "findBestPathFromAmountIn")).toHaveLength(
    quoteCallsBeforeApproval
  );
  expect(rpc.snapshot().ethCalls.filter((call) => ["allowance", "balanceOf"].includes(call.functionName))).toHaveLength(
    walletReadsBeforeApproval
  );
  expect(simulatedFunctions(rpc).filter((name) => name === "swapExactTokensForTokens")).toEqual([]);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(1);
});

test("wallet switch control requests the active localnet chain", async ({ page }) => {
  await installMockRpc(page);
  await installMockWallet(page, { chainId: ROBINHOOD_TESTNET_CHAIN_ID });
  await page.goto("/#/swap");

  await connectWallet(page);
  await page.getByTestId("wallet-switch-button").click();

  await expect(page.getByTestId("wallet-switch-button")).toBeHidden();
  await expect(page.getByTestId("wallet-account-button")).toContainText("0xf39F...2266");

  const wallet = await readMockWallet(page);
  expect(wallet.chainId).toBe(LOCALNET_CHAIN_ID);
  expect(wallet.switchChainCalls).toContain(LOCALNET_CHAIN_ID);
  expect(wallet.sentTransactions).toEqual([]);
});

test("ready wallet state simulates and submits a guarded swap transaction", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN });

  await expect(page.getByTestId("swap-allowance-value")).toContainText("5");
  await expect(page.getByTestId("swap-submit-button")).toContainText("Swap");
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();
  await expect(page.getByTestId("swap-selected-market-identity")).toContainText(`${WNATIVE_USDC_PAIR} · bin step 10`);

  await clickReviewedAction(page, "swap-submit-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);

  expect(simulatedFunctions(rpc)).toContain("swapExactTokensForTokens");
  assertTransactionMatchesSimulation((await readMockWallet(page)).sentTransactions[0], rpc, "swapExactTokensForTokens");
});

test("wallet prompts longer than the reconciliation interval retain their durable pre-broadcast intent", async ({ page }) => {
  await installMockRpc(page, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID, transactionDelayMs: 3_500 });
  await page.goto("/#/swap");
  await connectWallet(page);
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();

  await clickReviewedAction(page, "swap-submit-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  await expect(page.getByTestId("submitted-transaction-journal").locator("[data-transaction-hash]"), { timeout: 8_000 }).toHaveCount(1);
  expect(await persistedTransactionJournalCount(page)).toBe(1);
});

test("ambiguous wallet transport blocks blind retry while preserving a hashless intent", async ({ page }) => {
  await installMockRpc(page, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID, transactionMode: "ambiguous" });
  await page.goto("/#/swap");
  await connectWallet(page);

  await clickReviewedAction(page, "swap-submit-button");
  await expect(page.getByTestId("swap-failure-state")).toContainText(/possible broadcast/i);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(1);
  await expect(page.getByTestId("submitted-transaction-journal")).toContainText(/unknown-submission|reconciling/);

  await page.locator("#swap-amount").fill("1.1");
  await page.locator("#swap-amount").fill("1.0");
  await clickReviewedAction(page, "swap-submit-button");
  await expect(page.getByTestId("swap-failure-state")).toContainText(/still unresolved/i);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(1);
});

test("unavailable durable storage blocks wallet handoff and surfaces a controlled journal error", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "feather.transaction-journal.v1") throw new DOMException("Mock quota unavailable", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await installMockRpc(page, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connectWallet(page);

  await clickReviewedAction(page, "swap-submit-button");
  await expect(page.getByTestId("swap-failure-state")).toContainText(/quota|storage|journal/i);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(0);
});

test("two same-origin tabs serialize identical intents before either wallet can double-submit", async ({ page, context }) => {
  await installMockRpc(page, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID, transactionDelayMs: 4_000 });
  await page.goto("/#/swap");
  await connectWallet(page);

  await clickReviewedAction(page, "swap-submit-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);

  const secondPage = await context.newPage();
  await installMockRpc(secondPage, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN });
  await installMockWallet(secondPage, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await secondPage.goto("/#/swap");
  await expect.poll(async () =>
    await secondPage.getByTestId("wallet-account-button").isVisible() ||
    await secondPage.getByTestId("wallet-connect-button").isEnabled()).toBe(true);
  if (!await secondPage.getByTestId("wallet-account-button").isVisible()) {
    await secondPage.getByTestId("wallet-connect-button").click();
  }
  await expect(secondPage.getByTestId("wallet-account-button")).toContainText("0xf39F...2266");
  await clickReviewedAction(secondPage, "swap-submit-button");

  await expect(secondPage.getByTestId("swap-failure-state")).toContainText(/still unresolved/i);
  expect((await readMockWallet(secondPage)).sentTransactions).toHaveLength(0);
  await expect(page.getByTestId("submitted-transaction-journal").locator("[data-transaction-hash]"), { timeout: 8_000 }).toHaveCount(1);
});

test("best multi-hop route remains executable when it differs from the selected indexed pool", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    quotePreferMultiHop: true
  });

  await expect(page.getByTestId("swap-route-steps").locator(".route-step")).toHaveCount(2);
  await expect(page.getByTestId("swap-submit-button")).toContainText("Swap");
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();

  await clickReviewedAction(page, "swap-submit-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);

  const transaction = (await readMockWallet(page)).sentTransactions[0];
  const decoded = decodeFunctionData({ abi: lbRouterAbi, data: transaction.data });
  expect(decoded.functionName).toBe("swapExactTokensForTokens");
  if (decoded.functionName !== "swapExactTokensForTokens") throw new Error("Unexpected swap function");
  expect(decoded.args[2].tokenPath).toHaveLength(3);
  expect(simulatedFunctions(rpc)).toContain("swapExactTokensForTokens");
  assertTransactionMatchesSimulation(transaction, rpc, "swapExactTokensForTokens");
});

test("best direct quote may use a different V2.2 pool than the indexed market row", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    quoteUseAlternateDirectPool: true
  });

  await expect(page.getByTestId("swap-route-steps").locator(".route-step")).toHaveCount(1);
  await expect(page.getByTestId("swap-route-steps")).toContainText("0x1111...1101");
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();

  await clickReviewedAction(page, "swap-submit-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  expect(simulatedFunctions(rpc)).toContain("swapExactTokensForTokens");
  assertTransactionMatchesSimulation((await readMockWallet(page)).sentTransactions[0], rpc, "swapExactTokensForTokens");
});

test("connected wallet surfaces EIP-1193 4001 rejection without a false success state", async ({ page }) => {
  const rpc = await installMockRpc(page, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID, rejectTransactions: true });
  await page.goto("/#/swap");
  await connectWallet(page);
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();

  await clickReviewedAction(page, "swap-submit-button");

  await expect(page.getByTestId("swap-failure-state")).toContainText(/user rejected/i);
  await expect(page.getByText("Swap confirmed")).toHaveCount(0);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(1);
  expect(rpc.snapshot().methods).not.toContain("eth_getTransactionReceipt");
});

test("connected wallet surfaces a reverted receipt without a false confirmation", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    receiptStatus: "reverted"
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connectWallet(page);
  await expect(page.getByTestId("swap-submit-button")).toBeEnabled();

  await clickReviewedAction(page, "swap-submit-button");

  await expect(page.getByTestId("swap-failure-state")).toContainText("Swap reverted", { timeout: 12_000 });
  await expect(page.getByText("Swap confirmed")).toHaveCount(0);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(1);
  expect(rpc.snapshot().methods).toContain("eth_getTransactionReceipt");
});

test("swap submission is cancelled when execution context changes during simulation", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    simulationDelayMs: 500
  });

  await page.getByTestId("swap-submit-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "swapExactTokensForTokens").length).toBe(1);
  await page.locator("#swap-slippage").fill("0.6");

  await expect(page.getByTestId("swap-failure-state")).toContainText(
    "Execution context changed during simulation; refresh the quote and try again"
  );
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("dashboard polling advances RPC and indexer heads through stale, error, and recovery states", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Polling timing is covered once in desktop Chromium");

  const rpc = await installMockRpc(page, { blockNumber: 42n, includePairs: true, indexerBlockNumber: 42n });
  await page.goto("/#/swap");
  const blockValue = page.locator(".metric").filter({ hasText: "Block" }).locator("strong");
  const indexerHeadValue = page.locator(".metric").filter({ hasText: "Indexer Head" }).locator("strong");
  const indexerPill = page.locator(".status-pill").filter({ hasText: "Indexer" });
  await expect(blockValue).toHaveText("42");
  await expect(indexerHeadValue).toHaveText("42");
  await expect(indexerPill).toHaveClass(/ready/);
  await expect.poll(() => rpc.snapshot().ethCalls.filter((call) => call.functionName === "findBestPathFromAmountIn").length).toBeGreaterThan(0);
  const initialQuoteCalls = rpc.snapshot().ethCalls.filter((call) => call.functionName === "findBestPathFromAmountIn").length;

  rpc.update({ blockNumber: 63n });
  await expect(blockValue).toHaveText("63", { timeout: 12_000 });
  await expect(indexerPill).toHaveClass(/stale/);

  rpc.update({ indexerBlockNumber: 63n });
  await page.getByTestId("snapshot-refresh-button").click();
  await expect(indexerHeadValue).toHaveText("63");
  await expect(indexerPill).toHaveClass(/ready/);
  await expect
    .poll(() => rpc.snapshot().ethCalls.filter((call) => call.functionName === "findBestPathFromAmountIn").length)
    .toBeGreaterThan(initialQuoteCalls);

  rpc.update({ indexerMode: "error" });
  await page.getByTestId("snapshot-refresh-button").click();
  await expect(indexerPill).toHaveClass(/error/);

  rpc.update({ blockNumber: 64n, indexerBlockNumber: 64n, indexerMode: "ready" });
  await page.getByTestId("snapshot-refresh-button").click();
  await expect(blockValue).toHaveText("64");
  await expect(indexerHeadValue).toHaveText("64");
  await expect(indexerPill).toHaveClass(/ready/);
});

test("dashboard refetches on focus visibility and environment changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Refresh trigger coverage runs once in desktop Chromium");

  const rpc = await installMockRpc(page, { includePairs: true });
  let testnetRuntimeRequests = 0;
  await page.route(`${ROBINHOOD_TESTNET_RPC_URL}/`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ headers: rpcCorsHeaders(), status: 204 });
      return;
    }

    const payload = JSON.parse(route.request().postData() ?? "null") as RuntimeRpcRequest | RuntimeRpcRequest[];
    const requests = Array.isArray(payload) ? payload : [payload];
    testnetRuntimeRequests += requests.length;
    const responses = requests.map((request) => ({
      id: request.id ?? null,
      jsonrpc: "2.0",
      result: request.method === "eth_chainId" ? "0xb626" : request.method === "eth_blockNumber" ? "0x2a" : "0x0"
    }));
    await route.fulfill({
      body: JSON.stringify(Array.isArray(payload) ? responses : responses[0]),
      contentType: "application/json",
      headers: rpcCorsHeaders(),
      status: 200
    });
  });

  await page.goto("/#/swap");
  await expect.poll(() => rpc.snapshot().methods.filter((method) => method === "eth_chainId").length).toBeGreaterThan(0);
  const beforeFocus = rpc.snapshot().methods.filter((method) => method === "eth_chainId").length;

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => rpc.snapshot().methods.filter((method) => method === "eth_chainId").length)
    .toBeGreaterThan(beforeFocus);

  await page.getByRole("button", { name: /Robinhood Testnet/ }).click();
  await expect.poll(() => testnetRuntimeRequests).toBeGreaterThan(0);
  await expect(page.locator(".status-pill").filter({ hasText: "Chain 46630" })).toBeVisible();
});

test("pool discovery deep-links to real indexed bins and preselects liquidity actions", async ({ page }, testInfo) => {
  const rpc = await installMockRpc(page, { includePairs: true, includePositions: true, poolBinCount: 7 });
  await installMockWallet(page);
  await page.goto("/#/pools");
  await connectWallet(page);

  await expect(page.getByText("Liquidity pools")).toBeVisible();
  await page.getByLabel("Search pools").fill("WNATIVE");
  const discoveryRow = page.locator(".discovery-table .table-row").filter({ hasText: "WNATIVE / USDC" });
  await expect(discoveryRow).toHaveCount(1);
  if (testInfo.project.name === "mobile-chromium") {
    await expect.poll(() => discoveryRow.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
  }
  await page.getByRole("link", { name: /WNATIVE \/ USDC/ }).click();

  await expect(page).toHaveURL(/#\/pools\//);
  await expect(page.getByText("Live liquidity bins")).toBeVisible();
  await expect(page.locator(".pool-bin-chart .pool-bin")).toHaveCount(7);
  await expect(page.locator(".pool-bin-chart .pool-bin.active")).toHaveCount(1);
  await expect.poll(() => rpc.snapshot().graphQueries.some((query) => query.includes("PairBinWindow"))).toBe(true);
  await expect.poll(() => rpc.snapshot().graphQueries.some((query) => query.includes("OwnerPairPositions"))).toBe(true);

  await page.reload();
  await expect(page.locator(".pool-bin-chart .pool-bin")).toHaveCount(7);

  await page.getByRole("link", { name: "Withdraw" }).click();
  await expect(page).toHaveURL(/#\/liquidity\/withdraw\/0x/i);
  await expect(page.locator("#liquidity-withdraw")).toBeInViewport();

  await page.goBack();
  await expect(page).toHaveURL(/#\/pools\//);

  await page.getByRole("link", { name: "Deposit" }).click();
  await expect(page).toHaveURL(/#\/liquidity\/add\/0x/i);
  await expect(page.locator("#liquidity-add")).toBeInViewport();
  await expect(page.locator("#liquidity-pair")).toContainText("WNATIVE / USDC");
});

test("pool detail keeps an empty active-bin marker and reports capped wallet positions", async ({ page }) => {
  await installMockRpc(page, {
    includePairs: true,
    includePositions: true,
    omitActivePoolBin: true,
    ownerPositionCount: 501,
    poolBinCount: 7
  });
  await installMockWallet(page);
  await page.goto(`/#/pools/${WNATIVE_USDC_PAIR.toLowerCase()}`);
  await connectWallet(page);

  await expect(page.locator(".pool-bin-chart .pool-bin.active")).toHaveCount(1);
  await expect(page.locator(".table-panel").filter({ hasText: "Your bins" }).locator(".status-badge")).toContainText("partial");
  await expect(page.getByText("The owner/pair position query is partial; destructive actions remain blocked.")).toBeVisible();
});

test("pool and action deep links resolve outside the dashboard page and survive reload", async ({ page }) => {
  await installMockRpc(page, { dashboardPoolLimit: 1, includePairs: true, poolCount: 2, poolBinCount: 5 });
  await page.goto(`/#/pools/${SECOND_WNATIVE_USDC_PAIR.toLowerCase()}`);

  await expect(page.getByText("Live liquidity bins")).toBeVisible();
  await expect(page.getByText(/bin step 11/)).toBeVisible();
  await page.getByRole("link", { name: "Withdraw" }).click();
  await expect(page).toHaveURL(new RegExp(`#/liquidity/withdraw/${SECOND_WNATIVE_USDC_PAIR.toLowerCase()}$`, "i"));

  await page.reload();
  await expect(page.locator("#liquidity-pair")).toHaveValue(SECOND_WNATIVE_USDC_PAIR.toLowerCase());
  await expect(page.locator("#liquidity-withdraw")).toBeInViewport();
});

test("action deep links never fall back to the default pool while lookup is pending", async ({ page }) => {
  await page.addInitScript(() => {
    const observedPoolIds: string[] = [];
    Object.defineProperty(window, "__observedLiquidityPoolIds", { value: observedPoolIds });
    new MutationObserver(() => {
      const select = document.querySelector<HTMLSelectElement>("#liquidity-pair");
      if (select && observedPoolIds.at(-1) !== select.value) observedPoolIds.push(select.value);
    }).observe(document, { childList: true, subtree: true });
  });
  await installMockRpc(page, {
    dashboardPoolLimit: 1,
    includePairs: true,
    pairByIdDelayMs: 600,
    poolCount: 2
  });
  await page.goto(`/#/liquidity/add/${SECOND_WNATIVE_USDC_PAIR.toLowerCase()}`);

  await expect(page.getByTestId("requested-pool-state")).toContainText("Resolving requested pool");
  await expect(page.locator("#liquidity-pair")).toHaveCount(0);
  await expect(page.getByTestId("liquidity-add-button")).toHaveCount(0);

  await expect(page.locator("#liquidity-pair")).toHaveValue(SECOND_WNATIVE_USDC_PAIR.toLowerCase());
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __observedLiquidityPoolIds: string[] }).__observedLiquidityPoolIds))
    .toEqual([SECOND_WNATIVE_USDC_PAIR.toLowerCase()]);
});

test("failed action-pool lookup stays unavailable instead of rendering the default pool", async ({ page }) => {
  await installMockRpc(page, {
    dashboardPoolLimit: 1,
    includePairs: true,
    pairByIdMode: "error",
    poolCount: 2
  });
  await page.goto(`/#/swap/${SECOND_WNATIVE_USDC_PAIR.toLowerCase()}`);

  await expect(page.getByTestId("requested-pool-state")).toContainText("Mock pair lookup failed");
  await expect(page.locator("#swap-pool")).toHaveCount(0);
  await expect(page.getByTestId("swap-submit-button")).toHaveCount(0);
});

test("GraphQL timeout is visible and recovers through manual refresh and polling", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Timeout clock coverage runs once in desktop Chromium");

  await page.clock.install({ time: new Date() });
  await installMockRpc(page, { includePairs: true });
  let hangIndexer = true;
  let hangingRequests = 0;
  await page.route(LOCALNET_INDEXER_URL, async (route) => {
    if (hangIndexer && route.request().method() !== "OPTIONS") {
      hangingRequests += 1;
      return;
    }

    await route.fallback();
  });

  await page.goto("/#/pools");
  await expect.poll(() => hangingRequests).toBeGreaterThan(0);
  await page.clock.fastForward(10_100);
  await expect(page.getByTestId("indexer-status-message")).toContainText("Indexer request timed out after 10000ms");
  await expect(page.locator(".status-pill").filter({ hasText: "Indexer" })).toHaveClass(/error/);

  hangIndexer = false;
  await page.getByTestId("snapshot-refresh-button").click();
  await expect(page.locator(".status-pill").filter({ hasText: "Indexer" })).toHaveClass(/ready/);
  await expect(page.getByTestId("indexer-status-message")).toHaveCount(0);

  hangIndexer = true;
  const beforeSecondTimeout = hangingRequests;
  await page.getByTestId("snapshot-refresh-button").click();
  await expect.poll(() => hangingRequests).toBeGreaterThan(beforeSecondTimeout);
  await page.clock.fastForward(10_100);
  await expect(page.locator(".status-pill").filter({ hasText: "Indexer" })).toHaveClass(/error/);

  hangIndexer = false;
  await page.clock.fastForward(10_100);
  await expect(page.locator(".status-pill").filter({ hasText: "Indexer" })).toHaveClass(/ready/);
  await expect(page.getByTestId("indexer-status-message")).toHaveCount(0);
});

test("legacy swap quotes fail closed before simulation or wallet submission", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    quoteVersion: 2
  });

  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
  await expect(page.getByTestId("swap-failure-state")).toContainText("Only V2.2 swap route versions are supported");
  await bypassDisabledButtonAndClick(page, "swap-submit-button");
  await bypassDisabledButtonAndClick(page, "swap-approve-button");

  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
  expect(simulatedFunctions(rpc)).not.toContain("approve");
  expect(simulatedFunctions(rpc)).not.toContain("swapExactTokensForTokens");
});

test("unsafe id slippage and deadline inputs fail closed", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true
  });

  for (const value of ["0", "2"]) {
    await page.locator("#id-slippage").fill(value);
    await expect(page.getByTestId("liquidity-add-button")).toBeEnabled();
  }

  for (const [value, message] of [
    ["-1", "Enter an id slippage from 0 to 2 bins"],
    ["3", "ID slippage above 2 bins requires release-owner approval"]
  ] as const) {
    await page.locator("#id-slippage").fill(value);
    await expect(page.getByText(message).first()).toBeVisible();
    await expect(page.getByTestId("liquidity-add-button")).toBeDisabled();
    await bypassDisabledButtonAndClick(page, "liquidity-add-button");
  }

  await page.locator("#id-slippage").fill("2");
  const deadlineGuardedActions = ["liquidity-add-button", "liquidity-remove-button"];
  for (const value of ["1", "120"]) {
    await page.locator("#liquidity-deadline").fill(value);
    for (const testId of deadlineGuardedActions) await expect(page.getByTestId(testId)).toBeEnabled();
  }
  for (const value of ["", "0", "0.5", "121", "Infinity"]) {
    await page.locator("#liquidity-deadline").fill(value);
    await expect(page.getByText("Enter a deadline from 1 to 120 minutes").first()).toBeVisible();
    for (const testId of deadlineGuardedActions) {
      await expect(page.getByTestId(testId)).toBeDisabled();
      await bypassDisabledButtonAndClick(page, testId);
    }
  }

  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
  expect(simulatedFunctions(rpc)).not.toContain("addLiquidity");
  expect(simulatedFunctions(rpc)).not.toContain("removeLiquidity");
});

test("swap deadline boundaries remain handler-guarded", async ({ page }) => {
  const rpc = await setupConnectedSwap(page, { allowance: 5n * ONE_TOKEN, balance: 5n * ONE_TOKEN });

  for (const value of ["1", "120"]) {
    await page.locator("#swap-deadline").fill(value);
    await expect(page.getByTestId("swap-submit-button")).toBeEnabled();
  }

  for (const value of ["", "0", "0.5", "121", "Infinity"]) {
    await page.locator("#swap-deadline").fill(value);
    await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
    await bypassDisabledButtonAndClick(page, "swap-submit-button");
  }

  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
  expect(simulatedFunctions(rpc)).not.toContain("swapExactTokensForTokens");
});

for (const errorState of [
  {
    issue: "Mock indexer summary failed",
    name: "indexer request errors",
    options: { indexerMode: "error" }
  },
  {
    issue: "Indexer reports indexing errors",
    name: "indexer metadata errors",
    options: { indexerHasErrors: true }
  }
] as const) {
  test(`${errorState.name} block remove before simulation or wallet submission`, async ({ page }) => {
    const rpc = await setupConnectedLiquidity(page, {
      ...errorState.options,
      lbApproved: true
    });

    await expect(page.getByText(errorState.issue).first()).toBeVisible();
    await assertRemoveBlockedBeforeWallet(page, rpc);
  });
}

test("stale indexer state blocks remove before simulation or wallet submission", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    blockNumber: 100n,
    indexerBlockNumber: 42n,
    lbApproved: true
  });

  await expect(page.getByText("Indexer is stale").first()).toBeVisible();
  await assertRemoveBlockedBeforeWallet(page, rpc);
});

test("partial owner position page failure blocks remove before simulation or wallet submission", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    lbApproved: true,
    ownerPositionCount: 100,
    ownerPositionsFailAtSkip: 100
  });

  await expect(page.getByText("Position data is partial").first()).toBeVisible();
  await assertRemoveBlockedBeforeWallet(page, rpc);
});

test("live and indexed LB balance mismatch blocks remove before simulation or wallet submission", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    lbApproved: true,
    livePositionBalance: ONE_TOKEN,
    positionLiquidity: 2n * ONE_TOKEN
  });

  await expect(page.getByText(/Live LB balance is below indexed liquidity/).first()).toBeVisible();
  await assertRemoveBlockedBeforeWallet(page, rpc);
});

for (const unsafeState of [
  {
    issue: "Indexer is stale",
    name: "stale indexer state",
    options: { blockNumber: 100n, indexerBlockNumber: 42n }
  },
  {
    issue: "Position data is partial",
    name: "partial owner position data",
    options: { ownerPositionCount: 100, ownerPositionsFailAtSkip: 100 }
  },
  {
    issue: /Live LB balance is below indexed liquidity/,
    name: "live and indexed LB balance mismatch",
    options: { livePositionBalance: ONE_TOKEN, positionLiquidity: 2n * ONE_TOKEN }
  },
  {
    issue: "Mock indexer summary failed",
    name: "indexer request errors",
    options: { indexerMode: "error" }
  },
  {
    issue: "Indexer reports indexing errors",
    name: "indexer metadata errors",
    options: { indexerHasErrors: true }
  }
] as const) {
  test(`${unsafeState.name} blocks LB approval before simulation or wallet submission`, async ({ page }) => {
    const rpc = await setupConnectedLiquidity(page, {
      ...unsafeState.options,
      lbApproved: false
    });

    await expect(page.getByText(unsafeState.issue).first()).toBeVisible();
    await assertLbApprovalBlockedBeforeWallet(page, rpc);
  });
}

test("fresh same-click LB balance guard blocks remove before simulation or wallet submission", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    lbApproved: true,
    livePositionBalance: 2n * ONE_TOKEN,
    positionLiquidity: 2n * ONE_TOKEN
  });

  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  rpc.update({ livePositionBalance: ONE_TOKEN });
  await page.getByTestId("liquidity-remove-button").click();

  await expect(page.getByText(/Live LB balance is below indexed liquidity/).first()).toBeVisible();
  expect(simulatedFunctions(rpc)).not.toContain("removeLiquidity");
  const wallet = await readMockWallet(page);
  expect(wallet.calls).not.toContain("eth_sendTransaction");
  expect(wallet.sentTransactions).toEqual([]);
});

for (const transition of [
  {
    issue: "Indexer is stale",
    name: "stale indexer",
    operation: "DashboardSummary",
    options: { indexerBlockNumber: 0n }
  },
  {
    issue: "Mock indexer summary failed",
    name: "indexer error",
    operation: "DashboardSummary",
    options: { indexerMode: "error" }
  },
  {
    issue: "Position data is partial",
    name: "partial owner position pagination",
    operation: "OwnerPairPositions",
    options: { ownerPositionCount: 100, ownerPositionsFailAtSkip: 100 }
  }
] as const) {
  test(`same-click remove preflight rejects a ${transition.name} transition after click`, async ({ page }) => {
    const rpc = await setupConnectedLiquidity(page, { lbApproved: true });
    await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();

    rpc.update({ indexerDelayMs: 750 });
    const requestsBeforeClick = graphQueryCount(rpc, transition.operation);
    await page.getByTestId("liquidity-remove-button").click();
    await expect.poll(() => graphQueryCount(rpc, transition.operation)).toBeGreaterThan(requestsBeforeClick);
    rpc.update(transition.options);

    await expect(page.getByText(transition.issue).first()).toBeVisible();
    expect(simulatedFunctions(rpc)).not.toContain("removeLiquidity");
    const wallet = await readMockWallet(page);
    expect(wallet.calls).not.toContain("eth_sendTransaction");
    expect(wallet.sentTransactions).toEqual([]);
  });
}

for (const transition of [
  {
    issue: "Mock indexer summary failed",
    name: "cached summary data after a refetch error",
    operation: "DashboardSummary",
    options: { indexerMode: "error" }
  },
  {
    issue: "Indexer reports indexing errors",
    name: "indexer metadata errors",
    operation: "DashboardSummary",
    options: { indexerHasErrors: true }
  },
  {
    issue: "Position data is partial",
    name: "partial owner position pagination",
    operation: "OwnerPairPositions",
    options: { ownerPositionCount: 100, ownerPositionsFailAtSkip: 100 }
  }
] as const) {
  test(`same-click LB approval preflight rejects ${transition.name} on desktop and mobile`, async ({ page }) => {
    const rpc = await setupConnectedLiquidity(page, { lbApproved: false });
    await expect(page.getByTestId("liquidity-approve-lb-button")).toBeEnabled();

    rpc.update({ indexerDelayMs: 750 });
    const requestsBeforeClick = graphQueryCount(rpc, transition.operation);
    await page.getByTestId("liquidity-approve-lb-button").click();
    await expect.poll(() => graphQueryCount(rpc, transition.operation)).toBeGreaterThan(requestsBeforeClick);
    rpc.update(transition.options);

    await expect(page.getByText(transition.issue).first()).toBeVisible();
    expect(simulatedFunctions(rpc)).not.toContain("approveForAll");
    const wallet = await readMockWallet(page);
    expect(wallet.calls).not.toContain("eth_sendTransaction");
    expect(wallet.sentTransactions).toEqual([]);
  });
}

test("fresh LB approval still simulates and submits once after complete preflights", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, { lbApproved: false });
  await expect(page.getByTestId("liquidity-approve-lb-button")).toBeEnabled();

  await clickReviewedAction(page, "liquidity-approve-lb-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);

  expect(simulatedFunctions(rpc).filter((name) => name === "approveForAll")).toHaveLength(2);
  assertTransactionMatchesSimulation((await readMockWallet(page)).sentTransactions[0], rpc, "approveForAll");
});

test("rapid duplicate LB approval clicks produce one simulation and wallet request", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, { lbApproved: false, simulationDelayMs: 300 });
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="liquidity-approve-lb-button"]');
    if (!button) throw new Error("LB approval button is unavailable");
    button.click();
    button.click();
  });

  await expect(page.getByTestId("gas-review")).toBeVisible();
  await page.getByTestId("liquidity-approve-lb-button").click();

  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  expect(simulatedFunctions(rpc).filter((name) => name === "approveForAll")).toHaveLength(2);
});

test("LB approval rechecks indexer freshness after simulation before wallet submission", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, { lbApproved: false, simulationDelayMs: 750 });
  await expect(page.getByTestId("liquidity-approve-lb-button")).toBeEnabled();

  await page.getByTestId("liquidity-approve-lb-button").click();
  await expect.poll(() => simulatedFunctions(rpc)).toContain("approveForAll");
  rpc.update({ indexerMode: "error" });

  await expect(page.getByText("Mock indexer summary failed").first()).toBeVisible();
  expect(simulatedFunctions(rpc).filter((name) => name === "approveForAll")).toHaveLength(1);
  const wallet = await readMockWallet(page);
  expect(wallet.calls).not.toContain("eth_sendTransaction");
  expect(wallet.sentTransactions).toEqual([]);
});

test("LB approval is cancelled when the wallet chain changes during simulation on desktop and mobile", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, { lbApproved: false, simulationDelayMs: 750 });
  await expect(page.getByTestId("liquidity-approve-lb-button")).toBeEnabled();

  await page.getByTestId("liquidity-approve-lb-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "approveForAll")).toHaveLength(1);
  await page.evaluate(async (chainId) => {
    const provider = window.ethereum as
      | { request?: (request: { method: string; params?: unknown[] }) => Promise<unknown> }
      | undefined;
    if (!provider?.request) throw new Error("Mock wallet provider is unavailable");

    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }]
    });
  }, ROBINHOOD_TESTNET_CHAIN_ID);

  await expect(page.getByTestId("wallet-switch-button")).toBeVisible();
  await page.waitForTimeout(850);

  const wallet = await readMockWallet(page);
  expect(wallet.chainId).toBe(ROBINHOOD_TESTNET_CHAIN_ID);
  expect(wallet.calls).not.toContain("eth_sendTransaction");
  expect(wallet.sentTransactions).toEqual([]);
});

test("navigating away during delayed LB approval cannot open a stale wallet request", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    lbApproved: false,
    simulationDelayMs: 600,
    simulationMode: "error"
  });
  await page.getByTestId("liquidity-approve-lb-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "approveForAll")).toHaveLength(1);

  await page.evaluate(() => {
    window.location.hash = "#/pools";
  });
  await expect(page).toHaveURL(/#\/pools$/);
  await page.waitForTimeout(700);

  const wallet = await readMockWallet(page);
  expect(wallet.calls).not.toContain("eth_sendTransaction");
  expect(wallet.sentTransactions).toEqual([]);
  await expect(page.getByText(/Simulation failed/)).toHaveCount(0);
});

test("changing pools during delayed LB approval cancels the stale wallet request", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, { lbApproved: false, poolCount: 2, simulationDelayMs: 600 });
  await page.getByTestId("liquidity-approve-lb-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "approveForAll")).toHaveLength(1);
  await page.evaluate((pair) => {
    window.location.hash = `#/liquidity/withdraw/${pair}`;
  }, SECOND_WNATIVE_USDC_PAIR.toLowerCase());
  await expect(page).toHaveURL(new RegExp(`#/liquidity/withdraw/${SECOND_WNATIVE_USDC_PAIR.toLowerCase()}$`, "i"));
  await page.waitForTimeout(700);

  const wallet = await readMockWallet(page);
  expect(wallet.calls).not.toContain("eth_sendTransaction");
  expect(wallet.sentTransactions).toEqual([]);
});

test("capped owner position pagination fails closed", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    lbApproved: true,
    ownerPositionCount: 500
  });

  await expect(page.getByText("Position data is capped").first()).toBeVisible();
  await assertRemoveBlockedBeforeWallet(page, rpc);
});

test("remove submission is cancelled when its burn context changes during simulation", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationDelayMs: 500
  });

  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await page.getByTestId("liquidity-remove-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "removeLiquidity").length).toBe(1);
  await page.locator("#remove-percent").fill("50");

  await expect(page.getByText("Remove execution context changed during live reads or simulation; review the current inputs and try again").first()).toBeVisible();
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("rapid duplicate remove clicks produce one simulation and wallet request", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationDelayMs: 300
  });
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="liquidity-remove-button"]');
    if (!button) throw new Error("Remove button is unavailable");
    button.click();
    button.click();
  });

  await expect(page.getByTestId("gas-review")).toBeVisible();
  await page.getByTestId("liquidity-remove-button").click();

  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  expect(simulatedFunctions(rpc).filter((name) => name === "removeLiquidity")).toHaveLength(2);
});

test("navigating away during delayed remove simulation cannot open a stale wallet request", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationDelayMs: 600
  });
  await page.getByTestId("liquidity-remove-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "removeLiquidity")).toHaveLength(1);

  await page.evaluate(() => {
    window.location.hash = "#/pools";
  });
  await expect(page).toHaveURL(/#\/pools$/);
  await page.waitForTimeout(700);

  const wallet = await readMockWallet(page);
  expect(wallet.calls).not.toContain("eth_sendTransaction");
  expect(wallet.sentTransactions).toEqual([]);
});

test("changing pools during delayed remove simulation cancels the stale wallet request", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    poolCount: 2,
    simulationDelayMs: 600
  });
  await page.getByTestId("liquidity-remove-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "removeLiquidity")).toHaveLength(1);
  await page.evaluate((pair) => {
    window.location.hash = `#/liquidity/withdraw/${pair}`;
  }, SECOND_WNATIVE_USDC_PAIR.toLowerCase());
  await expect(page).toHaveURL(new RegExp(`#/liquidity/withdraw/${SECOND_WNATIVE_USDC_PAIR.toLowerCase()}$`, "i"));
  await page.waitForTimeout(700);

  const wallet = await readMockWallet(page);
  expect(wallet.calls).not.toContain("eth_sendTransaction");
  expect(wallet.sentTransactions).toEqual([]);
});

test("remove aborts and visibly refreshes when its displayed burn quote changes before simulation", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true
  });
  await expect(page.getByTestId("remove-expected-x")).toContainText("8");

  rpc.update({ binReserveX: 4n * ONE_TOKEN, blockNumber: 43n, indexerBlockNumber: 43n });
  await page.getByTestId("liquidity-remove-button").click();

  await expect(page.getByText(/Burn quote changed during the mandatory live refresh/)).toBeVisible();
  await expect(page.getByTestId("remove-expected-x")).toContainText("4");
  expect(simulatedFunctions(rpc)).not.toContain("removeLiquidity");
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);

  await clickReviewedAction(page, "liquidity-remove-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  assertTransactionMatchesSimulation((await readMockWallet(page)).sentTransactions[0], rpc, "removeLiquidity");
});

test("one-sided live burn quotes keep only the truly zero output minimum at zero", async ({ page }) => {
  await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    binReserveX: 0n,
    binReserveY: 4n * ONE_TOKEN,
    lbApproved: true
  });

  await expect(page.getByTestId("remove-min-x")).toContainText("0");
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-remove-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);

  const decoded = decodeSubmittedTransaction((await readMockWallet(page)).sentTransactions[0]);
  const args = decoded.args as readonly unknown[];
  expect(args[3]).toBe(0n);
  expect(args[4] as bigint).toBeGreaterThan(0n);
});

test("withdrawal wallet rejection and reverted receipts remain retryable without false success", async ({ page }) => {
  const rpc = await installMockRpc(page, { includePositions: true, lbApproved: false });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connectWallet(page);
  await expect(page.getByTestId("liquidity-approve-lb-button")).toBeEnabled();
  rpc.update({ lbApproved: true });
  await clickReviewedAction(page, "liquidity-approve-lb-button");
  await expect(page.getByText("LB approval confirmed")).toBeVisible();
  await page.evaluate(() => { window.__mockWalletState.rejectTransactions = true; });
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await page.getByRole("group", { name: "Withdrawal percentage presets" }).getByRole("button", { name: "50%" }).click();
  await clickReviewedAction(page, "liquidity-remove-button");
  await expect(page.getByText(/user rejected/i).first()).toBeVisible();
  await expect(page.getByText("LB approval confirmed")).toHaveCount(0);
  await expect(page.getByText("Liquidity removed")).toHaveCount(0);
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
});

test("withdrawal percentage precision and subset Max semantics fail safe", async ({ page }) => {
  await installMockRpc(page, { includePositions: true, lbApproved: true, ownerPositionCount: 2 });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connectWallet(page);

  await page.locator("#remove-percent").fill("99.999");
  await expect(page.getByText("Enter a remove percent from 0% to 100%").first()).toBeVisible();
  await expect(page.getByTestId("liquidity-remove-button")).toBeDisabled();
  await page.locator("#remove-percent").fill("99.99");
  await expect(page.locator("#remove-percent-slider")).toHaveValue("99.99");
  await expect(page.getByTestId("withdraw-transaction-review")).toContainText("Partial withdrawal");

  await page.getByRole("group", { name: "Withdrawal percentage presets" }).getByRole("button", { name: "Max" }).click();
  await expect(page.getByTestId("withdraw-transaction-review")).toContainText("Partial withdrawal");
  await expect(page.getByTestId("liquidity-remove-button")).toContainText("Withdraw liquidity");
  await page.getByRole("group", { name: "Positions" }).first().getByRole("button", { name: "All" }).click();
  await expect(page.getByTestId("withdraw-transaction-review")).toContainText("Full exit");
  await expect(page.getByTestId("liquidity-remove-button")).toContainText("Full exit");
});

test("withdrawal reverted receipt is explicit and never reports success", async ({ page }) => {
  await installMockRpc(page, { includePositions: true, lbApproved: true, receiptStatus: "reverted" });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connectWallet(page);
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-remove-button");
  await expect(page.getByText("Remove liquidity reverted")).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText("Liquidity removed")).toHaveCount(0);
});

test("one-sided ranges submit direct add-liquidity transactions with the unused side zeroed", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true
  });

  await page.locator("#range-lower").fill("1");
  await page.locator("#range-upper").fill("2");
  await expect(page.getByTestId("liquidity-range-mode")).toContainText("One-sided WNATIVE");
  await expect(page.getByTestId("one-sided-liquidity-notice")).toContainText("does not perform a swap");
  await expect(page.getByTestId("liquidity-amount-y")).toBeDisabled();
  await expect(page.getByTestId("liquidity-amount-y")).toHaveValue("0");
  await clickReviewedAction(page, "liquidity-add-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);

  await page.locator("#range-lower").fill("-2");
  await page.locator("#range-upper").fill("-1");
  await expect(page.getByTestId("liquidity-range-mode")).toContainText("One-sided USDC");
  await expect(page.getByTestId("liquidity-amount-x")).toBeDisabled();
  await expect(page.getByTestId("liquidity-amount-x")).toHaveValue("0");
  await clickReviewedAction(page, "liquidity-add-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(2);

  const [above, below] = (await readMockWallet(page)).sentTransactions.map(decodeSubmittedTransaction);
  const aboveParams = (above?.args as readonly [LiquidityParams])[0];
  const belowParams = (below?.args as readonly [LiquidityParams])[0];
  expect(aboveParams.amountX).toBeGreaterThan(0n);
  expect(aboveParams.amountY).toBe(0n);
  expect(aboveParams.amountYMin).toBe(0n);
  expect(aboveParams.distributionY.every((weight) => weight === 0n)).toBe(true);
  expect(belowParams.amountX).toBe(0n);
  expect(belowParams.amountXMin).toBe(0n);
  expect(belowParams.amountY).toBeGreaterThan(0n);
  expect(belowParams.distributionX.every((weight) => weight === 0n)).toBe(true);
  expect(simulatedFunctions(rpc).filter((name) => name === "addLiquidity")).toHaveLength(4);
  expect(simulatedFunctions(rpc)).not.toContain("swapExactTokensForTokens");
});

test("strategy selection submits SDK-exact Curve distributions through the 69-bin product envelope", async ({ page }) => {
  await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true
  });
  await page.getByTestId("liquidity-strategy-curve").click();
  await expect(page.getByTestId("liquidity-strategy-curve")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("liquidity-composition-guidance")).toContainText("does not silently swap");
  await clickReviewedAction(page, "liquidity-add-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);

  const decoded = decodeSubmittedTransaction((await readMockWallet(page)).sentTransactions[0]);
  const parameters = (decoded.args as readonly [LiquidityParams])[0];
  const expected = buildLiquidityDistribution(8_388_608, -1, 1, "curve");
  expect(parameters.deltaIds).toEqual(expected.deltaIds);
  expect(parameters.distributionX).toEqual(expected.distributionX);
  expect(parameters.distributionY).toEqual(expected.distributionY);

  await page.getByLabel("Lower range handle").fill("-10");
  await expect(page.locator("#range-lower")).toHaveValue("-10");
  await page.locator("#range-upper").fill("10");
  await expect(page.getByLabel("Upper range handle")).toHaveValue("10");
  await page.locator("#range-lower").fill("1");
  await page.locator("#range-upper").fill("69");
  await expect(page.getByLabel("Lower range handle")).toHaveValue("1");
  await expect(page.getByLabel("Upper range handle")).toHaveValue("69");
  await expect(page.getByTestId("liquidity-range-sliders")).toContainText("69 bins · max 69");
  await expect(page.getByTestId("liquidity-range-mode")).toContainText("One-sided WNATIVE");
  await clickReviewedAction(page, "liquidity-add-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(2);
  const maximum = decodeSubmittedTransaction((await readMockWallet(page)).sentTransactions[1]);
  expect(((maximum.args as readonly [LiquidityParams])[0]).deltaIds).toHaveLength(69);

  await page.locator("#range-lower").fill("100");
  await page.locator("#range-upper").fill("168");
  await expect(page.getByLabel("Lower range handle")).toHaveValue("100");
  await expect(page.getByLabel("Upper range handle")).toHaveValue("168");
  await page.locator("#range-upper").fill("169");
  await expect(page.getByText("Liquidity range must include between 1 and 69 bins").first()).toBeVisible();
  await expect(page.getByTestId("liquidity-add-button")).toBeDisabled();
});

test("safety-setting changes during simulation cancel stale strategy calldata", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationDelayMs: 600
  });
  await page.getByTestId("liquidity-strategy-curve").click();
  await page.getByTestId("liquidity-add-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "addLiquidity")).toHaveLength(1);
  await page.locator("#liquidity-slippage").fill("1");

  await expect(page.getByText(/Liquidity execution context, safety settings, strategy, range, or composition changed during simulation/).first()).toBeVisible();
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("range and composition changes during simulation cancel stale token approval", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 0n,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationDelayMs: 600
  });
  await page.getByTestId("liquidity-approve-x-button").click();
  await expect(page.getByTestId("liquidity-approve-x-button")).toBeDisabled();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "approve")).toHaveLength(1);
  await page.locator("#range-upper").fill("-1");

  await expect(page.getByText(/Token X approval context, amount, strategy, range, or composition changed during simulation/).first()).toBeVisible();
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("replacement token approval survives completion of the invalidated wallet-chain generation", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 0n,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationDelayMs: 1_000
  });
  await page.getByTestId("liquidity-approve-x-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "approve")).toHaveLength(1);
  await page.evaluate(async (chainId) => {
    await window.ethereum?.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }]
    });
  }, ROBINHOOD_TESTNET_CHAIN_ID);
  await expect(page.getByTestId("wallet-switch-button")).toBeVisible();
  await page.evaluate(async (chainId) => {
    await window.ethereum?.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }]
    });
  }, LOCALNET_CHAIN_ID);
  await expect(page.getByTestId("liquidity-approve-x-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-approve-x-button");

  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  expect(simulatedFunctions(rpc).filter((name) => name === "approve")).toHaveLength(3);
});

test("navigating away during liquidity simulation cannot open a stale wallet request", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationDelayMs: 600
  });
  await page.getByTestId("liquidity-add-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "addLiquidity")).toHaveLength(1);
  await page.evaluate(() => {
    window.location.hash = "#/pools";
  });
  await expect(page).toHaveURL(/#\/pools$/);
  await page.waitForTimeout(700);

  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("replacement add survives completion of the invalidated wallet-chain generation", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationDelayMs: 1_000
  });
  await page.getByTestId("liquidity-add-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "addLiquidity")).toHaveLength(1);
  await page.evaluate(async (chainId) => {
    await window.ethereum?.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }]
    });
  }, ROBINHOOD_TESTNET_CHAIN_ID);
  await expect(page.getByTestId("wallet-switch-button")).toBeVisible();
  await page.evaluate(async (chainId) => {
    await window.ethereum?.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }]
    });
  }, LOCALNET_CHAIN_ID);
  await expect(page.getByTestId("liquidity-add-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-add-button");

  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  expect(simulatedFunctions(rpc).filter((name) => name === "addLiquidity")).toHaveLength(3);
});

test("maximum-bin strategy fails closed when exact transaction simulation exceeds the gas envelope", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationMode: "error"
  });
  await page.locator("#range-lower").fill("-34");
  await page.locator("#range-upper").fill("34");
  await page.getByTestId("liquidity-add-button").click();

  await expect(page.getByText(/Simulation failed/).first()).toBeVisible();
  expect(simulatedFunctions(rpc).filter((name) => name === "addLiquidity")).toHaveLength(1);
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("burn outputs recompute for selection, percentage, slippage, live pool state, and balance changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Timed live burn refresh coverage runs once in desktop Chromium");

  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true
  });
  const removeExpectedX = page.getByTestId("remove-expected-x");
  const removeExpectedY = page.getByTestId("remove-expected-y");
  const removeMinX = page.getByTestId("remove-min-x");
  const removeMinY = page.getByTestId("remove-min-y");

  await expect(removeExpectedX).toContainText("8");
  await expect(removeExpectedY).toContainText("4");
  await expect(removeMinX).toContainText("7.96");
  await expect(removeMinY).toContainText("3.98");

  const presets = page.getByRole("group", { name: "Withdrawal percentage presets" });
  await presets.getByRole("button", { name: "25%" }).click();
  await expect(page.locator("#remove-percent")).toHaveValue("25");
  await expect(page.locator("#remove-percent-slider")).toHaveValue("25");
  await expect(removeExpectedX).toContainText("2");
  await expect(removeExpectedY).toContainText("1");

  await page.locator("#remove-percent").fill("50");
  await expect(removeExpectedX).toContainText("4");
  await expect(removeExpectedY).toContainText("2");
  await expect(removeMinX).toContainText("3.98");
  await expect(removeMinY).toContainText("1.99");

  await page.locator("#liquidity-slippage").fill("1");
  await expect(removeMinX).toContainText("3.96");
  await expect(removeMinY).toContainText("1.98");

  const removePositionPicker = page.getByRole("group", { name: "Positions" }).first();
  await removePositionPicker.getByRole("button", { name: "Clear" }).click();
  await expect(removeExpectedX).toContainText("n/a");
  await removePositionPicker.getByRole("button", { name: "All" }).click();
  await expect(removeExpectedX).toContainText("4");

  rpc.update({
    binReserveX: 4n * ONE_TOKEN,
    binReserveY: 2n * ONE_TOKEN,
    blockNumber: 43n,
    indexerBlockNumber: 43n
  });
  await expect(removeExpectedX).toContainText("2", { timeout: 12_000 });
  await expect(removeExpectedY).toContainText("1");
  await expect(removeMinX).toContainText("1.98");
  await expect(removeMinY).toContainText("0.99");

  rpc.update({
    binTotalSupply: 2n * ONE_TOKEN,
    blockNumber: 44n,
    indexerBlockNumber: 44n,
    positionLiquidity: ONE_TOKEN
  });
  await expect(removeExpectedX).toContainText("1", { timeout: 12_000 });
  await expect(removeExpectedY).toContainText("0.5");
  await expect(removeMinX).toContainText("0.99");
  await expect(removeMinY).toContainText("0.495");
});

test("approval disclosures expose full spenders, scope, asset, and current state on every path", async ({ page }) => {
  await installMockRpc(page, { allowance: 0n, balance: 5n * ONE_TOKEN, includePositions: true, lbApproved: false });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connectWallet(page);

  await assertApprovalDisclosure(page, "swap-approval-details", LB_ROUTER, "swap-approve-button");
  await page.getByRole("link", { name: "Liquidity" }).click();

  for (const [id, spender, button] of [
    ["liquidity-x-approval-details", LB_ROUTER, "liquidity-approve-x-button"],
    ["liquidity-y-approval-details", LB_ROUTER, "liquidity-approve-y-button"],
    ["remove-lb-approval-details", LB_ROUTER, "liquidity-approve-lb-button"]
  ] as const) {
    await assertApprovalDisclosure(page, id, spender, button);
  }
});

test("mobile viewport renders core wallet and swap controls without overlap-critical hiding", async ({ page }) => {
  await installMockRpc(page);
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");

  await expect(page.getByRole("link", { name: "Feather Trade home" })).toBeVisible();
  await expect(page.getByTestId("wallet-connect-button")).toBeVisible();
  await expect(page.getByTestId("swap-submit-button")).toBeVisible();
});

test("mobile viewport reaches every core route", async ({ page }) => {
  await installMockRpc(page);
  await page.goto("/#/swap");

  for (const route of ["Swap", "Pools", "Liquidity", "Portfolio"]) {
    await page.getByRole("link", { name: route }).click();
    await expect(page.locator(".panel-heading").filter({ hasText: route === "Portfolio" ? "Positions" : route }).first()).toBeVisible();
  }

  await page.locator(".operations-menu summary").click();
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.locator(".panel-heading").filter({ hasText: "Activity" }).first()).toBeVisible();
});

test("portfolio stays owner-scoped and its deep link survives reload", async ({ page }) => {
  await installMockRpc(page, { analyticsIncludeOtherOwner: true, includePairs: true, includePositions: true });
  await installMockWallet(page);
  await page.goto("/#/positions");
  await connectWallet(page);

  await expect(page.getByText("Your portfolio")).toBeVisible();
  await expect(page.getByTestId("portfolio-position-card")).toHaveCount(1);
  await expect(page.getByTestId("portfolio-position-card")).toContainText("in range");
  await expect(page.getByTestId("portfolio-position-card")).toContainText("$120.00");
  await expect(page.getByText(/Fee growth is already reflected/)).toBeVisible();
  await expect(page.getByText("0x0000...0001")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Partial withdraw" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Full exit" })).toBeVisible();

  await page.getByRole("link", { name: "Details" }).click();
  await expect(page).toHaveURL(/#\/positions\//);
  await expect(page.getByText("Position detail")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Position detail")).toBeVisible();
  await expect(page.getByTestId("portfolio-position-card")).toHaveCount(1);
  await expect(page.getByTestId("position-history-row")).toHaveCount(2);
  await expect(page.getByText("Accounting summary")).toBeVisible();
  await page.getByRole("link", { name: "Partial withdraw" }).click();
  await expect(page).toHaveURL(/#\/liquidity\/partial\/0x/i);
  await expect(page.locator("#liquidity-pair")).toHaveValue(/0x4a4758/i);
});

test("portfolio partial and full exits preserve all-bin intent and full exit submits the receipt-tracked burn", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    analyticsBinCount: 3,
    includePairs: true,
    includePositions: true,
    lbApproved: true,
    ownerPositionCount: 3
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/positions");
  await connectWallet(page);

  await page.getByRole("link", { name: "Partial withdraw" }).click();
  await expect(page).toHaveURL(/#\/liquidity\/partial\/0x/i);
  await expect(page.getByTestId("portfolio-action-handoff")).toContainText("50% across every loaded bin");
  await expect(page.locator("#remove-percent")).toHaveValue("50");
  const partialPicker = page.getByRole("group", { name: "Positions" }).first();
  await expect(partialPicker.locator('input[type="checkbox"]')).toHaveCount(3);
  await expect(partialPicker.locator('input[type="checkbox"]:checked')).toHaveCount(3);
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-remove-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(1);
  await expect(page.getByText("Liquidity removed")).toBeVisible();
  await page.locator("#remove-percent").fill("40");
  await expect(page.getByText("Liquidity removed")).toHaveCount(0);
  rpc.update({ simulationMode: "error" });
  await page.getByTestId("liquidity-remove-button").click();
  await expect(page.getByText(/Simulation failed/).first()).toBeVisible();
  await expect(page.getByText("Liquidity removed")).toHaveCount(0);
  expect((await readMockWallet(page)).sentTransactions).toHaveLength(1);
  rpc.update({ simulationMode: "success" });
  const partialSubmitted = decodeSubmittedTransaction((await readMockWallet(page)).sentTransactions[0]);
  expect(partialSubmitted.functionName).toBe("removeLiquidity");
  const partialArgs = partialSubmitted.args as readonly unknown[];
  expect(partialArgs[5]).toHaveLength(3);
  expect(partialArgs[6]).toHaveLength(3);
  assertTransactionMatchesSimulation((await readMockWallet(page)).sentTransactions[0], rpc, "removeLiquidity");

  await page.goto("/#/positions");
  await expect(page.getByRole("link", { name: "Full exit" })).toBeVisible();
  await page.getByRole("link", { name: "Full exit" }).click();
  await expect(page).toHaveURL(/#\/liquidity\/full\/0x/i);
  await expect(page.getByTestId("portfolio-action-handoff")).toContainText("100% across every loaded bin");
  await expect(page.locator("#remove-percent")).toHaveValue("100");
  const fullPicker = page.getByRole("group", { name: "Positions" }).first();
  await expect(fullPicker.locator('input[type="checkbox"]:checked')).toHaveCount(3);
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await clickReviewedAction(page, "liquidity-remove-button");
  await expect.poll(async () => (await readMockWallet(page)).sentTransactions.length).toBe(2);
  await expect(page.getByText("Liquidity removed")).toBeVisible();

  const submitted = decodeSubmittedTransaction((await readMockWallet(page)).sentTransactions[1]);
  expect(submitted.functionName).toBe("removeLiquidity");
  const args = submitted.args as readonly unknown[];
  expect(args[5]).toHaveLength(3);
  expect(args[6]).toHaveLength(3);
  expect((args[6] as bigint[]).every((amount, index) => amount === (partialArgs[6] as bigint[])[index] * 2n)).toBe(true);
  assertTransactionMatchesSimulation((await readMockWallet(page)).sentTransactions[1], rpc, "removeLiquidity");
  const pinnedOwnerQuery = rpc.snapshot().graphQueries.find((query) => query.includes("OwnerPairPositionsAtBlock"));
  expect(pinnedOwnerQuery).toContain("block: { number: $blockNumber }");
});

test("full exit requires an exact indexer and RPC head even inside the normal stale threshold", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    analyticsAsOfBlock: 42n,
    blockNumber: 42n,
    includePairs: true,
    includePositions: true,
    indexerBlockNumber: 41n,
    lbApproved: true
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connectWallet(page);
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  await page.getByTestId("liquidity-remove-button").click();

  await expect(page.getByText(/Full exit requires the indexer and RPC to reconcile at the exact same block/).first()).toBeVisible();
  expect(simulatedFunctions(rpc)).not.toContain("removeLiquidity");
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("full exit rejects a newly enumerated exact-head bin that was not reviewed", async ({ page }) => {
  const rpc = await installMockRpc(page, {
    analyticsBinCount: 1,
    includePairs: true,
    includePositions: true,
    lbApproved: true,
    ownerPositionCount: 1
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connectWallet(page);
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
  rpc.update({ ownerPositionCount: 2 });
  await page.getByTestId("liquidity-remove-button").click();

  await expect(page.getByText(/exact-head owner position set changed/).first()).toBeVisible();
  expect(simulatedFunctions(rpc)).not.toContain("removeLiquidity");
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("full exit aborts when the RPC head advances during final simulation", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationDelayMs: 600
  });
  await page.getByTestId("liquidity-remove-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "removeLiquidity")).toHaveLength(1);
  rpc.update({ blockNumber: 43n });

  await expect(page.getByText(/chain advanced during full-exit validation/).first()).toBeVisible();
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("full exit aborts when its exact-head block hash is reorganized", async ({ page }) => {
  const rpc = await setupConnectedLiquidity(page, {
    allowance: 5n * ONE_TOKEN,
    balance: 5n * ONE_TOKEN,
    lbApproved: true,
    simulationDelayMs: 600
  });
  await page.getByTestId("liquidity-remove-button").click();
  await expect.poll(() => simulatedFunctions(rpc).filter((name) => name === "removeLiquidity")).toHaveLength(1);
  rpc.update({ blockHash: "0x3333333333333333333333333333333333333333333333333333333333333333" });

  await expect(page.getByText(/validation block was reorganized/).first()).toBeVisible();
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("same-pool partial-to-full route prefill cannot reuse the partial receipt", async ({ page }) => {
  await installMockRpc(page, {
    analyticsBinCount: 1,
    includePairs: true,
    includePositions: true,
    lbApproved: true,
    ownerPositionCount: 1
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto(`/#/liquidity/partial/${WNATIVE_USDC_PAIR.toLowerCase()}`);
  await connectWallet(page);
  await clickReviewedAction(page, "liquidity-remove-button");
  await expect(page.getByText("Liquidity removed")).toBeVisible();

  await page.evaluate((pair) => {
    window.location.hash = `#/liquidity/full/${pair}`;
  }, WNATIVE_USDC_PAIR.toLowerCase());
  await expect(page.locator("#remove-percent")).toHaveValue("100");
  await expect(page.getByText("Liquidity removed")).toHaveCount(0);
});

test("portfolio exits fail closed when the exact analytics bin set is missing from the indexer", async ({ page }) => {
  await installMockRpc(page, {
    analyticsBinCount: 3,
    includePairs: true,
    includePositions: true,
    indexerBlockNumber: 42n,
    lbApproved: true,
    ownerPositionCount: 2
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/positions");
  await connectWallet(page);
  await page.getByRole("link", { name: "Full exit" }).click();

  await expect(page.getByText(/Portfolio exit bin set does not match/).first()).toBeVisible();
  await expect(page.getByTestId("liquidity-remove-button")).toBeDisabled();
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("full exit cannot be edited into a subset or partial burn", async ({ page }) => {
  await installMockRpc(page, {
    analyticsBinCount: 3,
    includePairs: true,
    includePositions: true,
    lbApproved: true,
    ownerPositionCount: 3
  });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/positions");
  await connectWallet(page);
  await page.getByRole("link", { name: "Full exit" }).click();

  const picker = page.getByRole("group", { name: "Positions" }).first();
  await expect(picker.locator('input[type="checkbox"]:checked')).toHaveCount(3);
  await picker.locator('input[type="checkbox"]').last().uncheck();
  await expect(page.getByText(/must keep every intended position bin selected/).first()).toBeVisible();
  await expect(page.getByTestId("liquidity-remove-button")).toBeDisabled();

  await picker.locator('input[type="checkbox"]').last().check();
  await page.locator("#remove-percent").fill("75");
  await expect(page.getByText(/Full exit requires removing exactly 100%/).first()).toBeVisible();
  await expect(page.getByTestId("liquidity-remove-button")).toBeDisabled();
  expect((await readMockWallet(page)).sentTransactions).toEqual([]);
});

test("portfolio action deep links resolve the exact pair outside the dashboard page", async ({ page }) => {
  await installMockRpc(page, { includePairs: false, includePositions: true });
  await installMockWallet(page);
  await page.goto("/#/positions");
  await connectWallet(page);

  await page.getByRole("link", { name: "Add liquidity" }).click();
  await expect(page).toHaveURL(/#\/liquidity\/add\/0x/i);
  await expect(page.getByTestId("portfolio-action-handoff")).toContainText("selected portfolio pair");
  await expect(page.locator("#liquidity-pair")).toHaveValue(/0x4a4758/i);
});

test("portfolio disables withdrawals when analytics and RPC heads do not reconcile", async ({ page }) => {
  await installMockRpc(page, {
    analyticsAsOfBlock: 41n,
    blockNumber: 42n,
    includePairs: true,
    includePositions: true
  });
  await installMockWallet(page);
  await page.goto("/#/positions");
  await connectWallet(page);

  const card = page.getByTestId("portfolio-position-card");
  await expect(card).toContainText("RPC head does not match");
  await expect(page.getByRole("link", { name: "Partial withdraw" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Full exit" })).toHaveCount(0);
});

test("fully transferred portfolio positions remain visible but cannot be withdrawn", async ({ page }) => {
  await installMockRpc(page, {
    analyticsTransferred: true,
    includePairs: true,
    includePositions: true
  });
  await installMockWallet(page);
  await page.goto("/#/positions");
  await connectWallet(page);

  const card = page.getByTestId("portfolio-position-card");
  await expect(card).toContainText("no remaining LB balance");
  await expect(card.getByRole("link", { name: "Add liquidity" })).toBeVisible();
  await expect(card.getByRole("link", { name: "Partial withdraw" })).toHaveCount(0);
  await expect(card.getByRole("link", { name: "Full exit" })).toHaveCount(0);
  await card.getByRole("link", { name: "Details" }).click();
  const transfer = page.getByTestId("position-history-row").filter({ hasText: "TRANSFER_OUT" });
  await expect(transfer).toBeVisible();
  await expect(transfer).toContainText("Bins 8388608");
});

test("portfolio exposes disconnected, wrong-chain, empty, and partial-history states", async ({ page }) => {
  await installMockRpc(page, { includePairs: true });
  await page.goto("/#/positions");
  await expect(page.getByTestId("portfolio-state")).toContainText("Connect your wallet");

  await installMockWallet(page, { chainId: ROBINHOOD_TESTNET_CHAIN_ID });
  await page.reload();
  await connectWallet(page);
  await expect(page.getByTestId("portfolio-state")).toContainText("Switch network");
});

test("portfolio keeps known claims visible when history is partial and range is inactive", async ({ page }) => {
  await installMockRpc(page, {
    analyticsOutOfRange: true,
    analyticsPartialHistory: true,
    includePairs: true,
    includePositions: true
  });
  await installMockWallet(page);
  await page.goto("/#/positions");
  await connectWallet(page);

  const card = page.getByTestId("portfolio-position-card");
  await expect(card).toContainText("out of range");
  await expect(card).toContainText("Unavailable");
  await expect(card).toContainText("transferred or its history is partial");
  await expect(page.getByText("partial data")).toBeVisible();
  await expect(card).toContainText("50 WNATIVE");
  await expect(card).toContainText("70 USDC");
  await card.getByRole("link", { name: "Partial withdraw" }).click();
  await expect(page.getByTestId("liquidity-remove-button")).toBeEnabled();
});

test("connected portfolio renders a truthful empty state", async ({ page }) => {
  await installMockRpc(page, { includePairs: true, includePositions: false });
  await installMockWallet(page);
  await page.goto("/#/positions");
  await connectWallet(page);

  await expect(page.getByTestId("portfolio-state")).toContainText("No positions yet");
  await expect(page.getByTestId("portfolio-position-card")).toHaveCount(0);
});

async function setupConnectedSwap(page: Parameters<typeof installMockRpc>[0], rpcOptions: MockRpcOptions = {}): Promise<InstalledMockRpc> {
  const rpc = await installMockRpc(page, rpcOptions);
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/swap");
  await connectWallet(page);
  await expect(page.getByTestId("swap-balance-value")).not.toHaveText("loading");

  return rpc;
}

async function setupConnectedLiquidity(page: Parameters<typeof installMockRpc>[0], rpcOptions: MockRpcOptions = {}): Promise<InstalledMockRpc> {
  const rpc = await installMockRpc(page, { includePositions: true, ...rpcOptions });
  await installMockWallet(page, { allowTransactions: true, chainId: LOCALNET_CHAIN_ID });
  await page.goto("/#/liquidity");
  await connectWallet(page);
  await expect(page.getByTestId("liquidity-add-button")).toBeVisible();

  return rpc;
}

async function connectWallet(page: Parameters<typeof installMockRpc>[0]): Promise<void> {
  await page.getByTestId("wallet-connect-button").click();
  await expect(page.getByTestId("wallet-account-button")).toContainText("0xf39F...2266");
}

async function clickReviewedAction(page: Parameters<typeof installMockRpc>[0], testId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId("gas-review")).toBeVisible();
  await page.getByTestId(testId).click();
}

async function bypassDisabledButtonAndClick(page: Parameters<typeof installMockRpc>[0], testId: string): Promise<void> {
  await page.evaluate((id) => {
    const button = document.querySelector(`[data-testid="${id}"]`);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button ${id}`);
    button.removeAttribute("disabled");
    button.click();
  }, testId);
  await page.evaluate((id) => {
    document.querySelector(`[data-testid="${id}"]`)?.setAttribute("disabled", "");
  }, testId);
}

async function assertRemoveBlockedBeforeWallet(
  page: Parameters<typeof installMockRpc>[0],
  rpc: InstalledMockRpc
): Promise<void> {
  await expect(page.getByTestId("liquidity-remove-button")).toBeDisabled();
  await bypassDisabledButtonAndClick(page, "liquidity-remove-button");
  await waitForForcedClickEffects(page);

  expect(simulatedFunctions(rpc)).not.toContain("removeLiquidity");
  const wallet = await readMockWallet(page);
  expect(wallet.calls).not.toContain("eth_sendTransaction");
  expect(wallet.sentTransactions).toEqual([]);
}

async function assertSwapBlockedBeforeDownstream(
  page: Parameters<typeof installMockRpc>[0],
  rpc: InstalledMockRpc
): Promise<void> {
  await expect(page.getByTestId("swap-approve-button")).toBeDisabled();
  await expect(page.getByTestId("swap-submit-button")).toBeDisabled();
  await bypassDisabledButtonAndClick(page, "swap-approve-button");
  await bypassDisabledButtonAndClick(page, "swap-submit-button");
  await waitForForcedClickEffects(page);

  const calls = rpc.snapshot().ethCalls.map((call) => call.functionName);
  expect(calls).not.toContain("findBestPathFromAmountIn");
  expect(simulatedFunctions(rpc)).not.toContain("approve");
  expect(simulatedFunctions(rpc)).not.toContain("swapExactTokensForTokens");
  const wallet = await readMockWallet(page);
  expect(wallet.calls).not.toContain("eth_sendTransaction");
  expect(wallet.sentTransactions).toEqual([]);
}

async function assertLbApprovalBlockedBeforeWallet(
  page: Parameters<typeof installMockRpc>[0],
  rpc: InstalledMockRpc
): Promise<void> {
  await expect(page.getByTestId("liquidity-approve-lb-button")).toBeDisabled();
  await bypassDisabledButtonAndClick(page, "liquidity-approve-lb-button");
  await waitForForcedClickEffects(page);

  expect(simulatedFunctions(rpc)).not.toContain("approveForAll");
  const wallet = await readMockWallet(page);
  expect(wallet.calls).not.toContain("eth_sendTransaction");
  expect(wallet.sentTransactions).toEqual([]);
}

async function waitForForcedClickEffects(page: Parameters<typeof installMockRpc>[0]): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.waitForLoadState("networkidle");
}

function simulatedFunctions(rpc: InstalledMockRpc): string[] {
  return rpc
    .snapshot()
    .ethCalls.map((call) => call.functionName)
    .filter((functionName) =>
      [
        "addLiquidity",
        "approve",
        "approveForAll",
        "removeLiquidity",
        "swapExactTokensForTokens"
      ].includes(functionName)
    );
}

function graphQueryCount(rpc: InstalledMockRpc, operation: string): number {
  return rpc.snapshot().graphQueries.filter((query) => query.includes(`query ${operation}`)).length;
}

function decodeSubmittedTransaction(transaction: unknown) {
  const submitted = transaction as { data?: Hex };
  expect(typeof submitted.data).toBe("string");

  return decodeFunctionData({
    abi: TRANSACTION_ABI,
    data: submitted.data as Hex
  });
}

async function persistedTransactionJournalCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("feather.transaction-journal.v1");
    if (raw === null) return 0;
    const parsed = JSON.parse(raw) as { records?: unknown[] };
    return Array.isArray(parsed.records) ? parsed.records.length : 0;
  });
}

function assertTransactionMatchesSimulation(transaction: unknown, rpc: InstalledMockRpc, functionName: string): void {
  const submitted = transaction as { data?: string; to?: string; value?: string | number | bigint };
  const simulated = rpc
    .snapshot()
    .ethCalls.find(
      (call) =>
        call.functionName === functionName &&
        call.address?.toLowerCase() === submitted.to?.toLowerCase() &&
        call.data.toLowerCase() === submitted.data?.toLowerCase()
    );
  expect(simulated, `missing ${functionName} simulation`).toBeDefined();
  expect(submitted.to?.toLowerCase()).toBe(simulated?.address?.toLowerCase());
  expect(submitted.data?.toLowerCase()).toBe(simulated?.data.toLowerCase());
  expect(normalizeTransactionValue(submitted.value)).toBe(normalizeTransactionValue(simulated?.value));
}

function normalizeTransactionValue(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  return BigInt(value);
}

function rpcCorsHeaders(): Record<string, string> {
  return {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": "*"
  };
}

async function assertApprovalDisclosure(
  page: Parameters<typeof installMockRpc>[0],
  id: string,
  spender: string,
  buttonTestId: string
): Promise<void> {
  const disclosure = page.locator(`#${id}`);
  const spenderValue = page.getByTestId(`${id}-spender`);

  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText("Token / asset");
  await expect(disclosure).toContainText("Requested");
  await expect(disclosure).toContainText("Scope");
  await expect(disclosure).toContainText("Current state");
  await expect(spenderValue).toHaveText(spender);
  await expect(page.getByTestId(buttonTestId)).toHaveAttribute("aria-describedby", id);
  expect(await spenderValue.evaluate((element) => getComputedStyle(element).overflowWrap)).toBe("anywhere");
}

interface LiquidityParams {
  amountX: bigint;
  amountY: bigint;
  amountXMin: bigint;
  amountYMin: bigint;
  distributionX: readonly bigint[];
  distributionY: readonly bigint[];
}

const liquidityActionTestIds = [
  "liquidity-approve-x-button",
  "liquidity-approve-y-button",
  "liquidity-add-button",
  "liquidity-approve-lb-button",
  "liquidity-remove-button"
];
