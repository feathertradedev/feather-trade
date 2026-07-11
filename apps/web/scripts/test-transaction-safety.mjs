import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  logLevel: "error",
  server: { middlewareMode: true }
});

try {
  const {
    DANGEROUS_SLIPPAGE_BPS,
    approvalDisclosure,
    burnExecutionContextFingerprint,
    burnQuoteExecutionFingerprint,
    evaluateTransactionSafety,
    idSlippageInputError,
    parseDeadlineMinutes,
    parseIdSlippage,
    quoteIsStale,
    swapExecutionContextFingerprint
  } = await server.ssrLoadModule("/src/transaction-safety.ts");
  const now = 1_800_000_000_000;

  assert.equal(
    evaluateTransactionSafety(
      { connected: false, deadlineMinutes: 20, intent: "swap", onWrongChain: false, quoteUpdatedAt: now, simulationState: "success" },
      now
    ).reason,
    "Connect wallet"
  );
  assert.equal(
    evaluateTransactionSafety(
      { connected: true, deadlineMinutes: 20, intent: "swap", onWrongChain: true, quoteUpdatedAt: now, simulationState: "success" },
      now
    ).reason,
    "Switch network"
  );
  assert.equal(
    evaluateTransactionSafety(
      { connected: true, deadlineMinutes: 20, intent: "swap", onWrongChain: false, quoteUpdatedAt: now, rpcReady: false },
      now
    ).reason,
    "RPC chain identity is unavailable or mismatched"
  );
  assert.deepEqual(
    evaluateTransactionSafety(
      {
        connected: true,
        deadlineMinutes: 20,
        intent: "swap",
        needsApproval: true,
        onWrongChain: false,
        quoteUpdatedAt: now,
        simulationState: "success"
      },
      now
    ),
    { blocked: false, reason: null, warnings: ["Approval is required before submission"] }
  );
  assert.equal(
    evaluateTransactionSafety(
      { connected: true, deadlineMinutes: 20, intent: "approval", onWrongChain: false, simulationState: "failed", simulationError: "ERC20 approve reverted" },
      now
    ).reason,
    "ERC20 approve reverted"
  );
  assert.match(
    approvalDisclosure({
      amount: 1_000_000n,
      spender: "0x1111111111111111111111111111111111111111",
      tokenSymbol: "USDC"
    }),
    /Approve 1000000 USDC to 0x1111111111111111111111111111111111111111/
  );
  assert.equal(
    evaluateTransactionSafety(
      { connected: true, deadlineMinutes: 20, intent: "swap", onWrongChain: false, quoteUpdatedAt: now - 20_000, simulationState: "success" },
      now
    ).reason,
    "Quote is stale"
  );
  assert.equal(
    evaluateTransactionSafety(
      { connected: true, deadlineMinutes: 20, intent: "liquidity", onWrongChain: false, simulationState: "success", slippageBps: DANGEROUS_SLIPPAGE_BPS + 1n },
      now
    ).reason,
    "Slippage exceeds safety limit"
  );
  assert.equal(
    evaluateTransactionSafety(
      { connected: true, deadlineMinutes: 20, intent: "liquidity", liveBalanceMismatch: true, onWrongChain: false, simulationState: "unsupported" },
      now
    ).reason,
    "Live balance does not match indexed position"
  );
  assert.equal(
    evaluateTransactionSafety(
      { connected: true, deadlineMinutes: 20, intent: "liquidity", onWrongChain: false, simulationState: "unsupported" },
      now
    ).reason,
    "Simulation unsupported"
  );
  assert.equal(quoteIsStale(now - 14_999, now), false);
  assert.equal(quoteIsStale(now - 15_001, now), true);
  assert.equal(parseDeadlineMinutes("1"), 1);
  assert.equal(parseDeadlineMinutes("120"), 120);
  assert.equal(parseDeadlineMinutes("0"), null);
  assert.equal(parseDeadlineMinutes("0.5"), null);
  assert.equal(parseDeadlineMinutes("121"), null);
  assert.equal(parseDeadlineMinutes("Infinity"), null);
  assert.equal(parseIdSlippage("0"), 0);
  assert.equal(parseIdSlippage("2"), 2);
  assert.equal(parseIdSlippage("-1"), null);
  assert.equal(parseIdSlippage("3"), null);
  assert.equal(parseIdSlippage("1.5"), null);
  assert.equal(idSlippageInputError("3"), "ID slippage above 2 bins requires release-owner approval");
  assert.equal(idSlippageInputError("-1"), "Enter an id slippage from 0 to 2 bins");
  assert.equal(idSlippageInputError("invalid"), "Enter an id slippage from 0 to 2 bins");
  assert.equal(idSlippageInputError("2"), null);

  const executionContext = {
    activeId: 8_388_608,
    amountIn: "1000",
    binStep: 10,
    deadlineMinutes: 20,
    environment: "localnet",
    pair: "0x1111111111111111111111111111111111111111",
    poolId: "pool-1",
    registryChainId: 31_337,
    reserveX: "100",
    reserveY: "200",
    rpcChainId: 31_337,
    slippageBps: "50",
    tokenIn: "0x2222222222222222222222222222222222222222",
    tokenOut: "0x3333333333333333333333333333333333333333",
    updatedAtBlock: "42",
    walletAddress: "0x4444444444444444444444444444444444444444",
    walletChainId: 31_337
  };
  const executionFingerprint = swapExecutionContextFingerprint(executionContext);
  for (const [field, value] of Object.entries({
    activeId: 8_388_609,
    amountIn: "1001",
    binStep: 25,
    deadlineMinutes: 21,
    environment: "robinhoodTestnet",
    pair: "0x5555555555555555555555555555555555555555",
    poolId: "pool-2",
    registryChainId: 46_630,
    reserveX: "101",
    reserveY: "201",
    rpcChainId: 46_630,
    slippageBps: "51",
    tokenIn: "0x6666666666666666666666666666666666666666",
    tokenOut: "0x7777777777777777777777777777777777777777",
    updatedAtBlock: "43",
    walletAddress: "0x8888888888888888888888888888888888888888",
    walletChainId: 46_630
  })) {
    assert.notEqual(
      swapExecutionContextFingerprint({ ...executionContext, [field]: value }),
      executionFingerprint,
      `${field} must invalidate the swap execution context`
    );
  }

  const burnQuoteBinding = {
    balances: [{ binId: "8388608", balance: "2000" }],
    binStates: [{ binId: "8388608", reserveX: "8000", reserveY: "4000", totalSupply: "2000" }],
    burnAmounts: [{ binId: "8388608", amount: "1000", liveBalance: "2000" }],
    expectedAmountXOut: "4000",
    expectedAmountYOut: "2000",
    minimumAmountXOut: "3980",
    minimumAmountYOut: "1990"
  };
  const burnQuoteFingerprint = burnQuoteExecutionFingerprint(burnQuoteBinding);
  assert.equal(
    burnQuoteExecutionFingerprint({
      ...burnQuoteBinding,
      balances: [...burnQuoteBinding.balances].reverse(),
      binStates: [...burnQuoteBinding.binStates].reverse(),
      burnAmounts: [...burnQuoteBinding.burnAmounts].reverse()
    }),
    burnQuoteFingerprint,
    "burn quote binding must be independent of row order"
  );
  for (const mutation of [
    { balances: [{ binId: "8388608", balance: "1999" }] },
    { binStates: [{ binId: "8388608", reserveX: "7999", reserveY: "4000", totalSupply: "2000" }] },
    { burnAmounts: [{ binId: "8388608", amount: "999", liveBalance: "2000" }] },
    { expectedAmountXOut: "3999" },
    { expectedAmountYOut: "1999" },
    { minimumAmountXOut: "3979" },
    { minimumAmountYOut: "1989" }
  ]) {
    assert.notEqual(
      burnQuoteExecutionFingerprint({ ...burnQuoteBinding, ...mutation }),
      burnQuoteFingerprint,
      "every displayed burn quote dependency must invalidate its execution binding"
    );
  }

  const burnContext = {
    account: "0x1111111111111111111111111111111111111111",
    binStep: 10,
    burnBps: "10000",
    deadlineMinutes: 20,
    environment: "localnet",
    mode: "remove",
    pair: "0x2222222222222222222222222222222222222222",
    registryChainId: 31_337,
    router: "0x3333333333333333333333333333333333333333",
    selectedPositionsKey: "position-1:8388608",
    slippageBps: "50",
    tokenX: "0x4444444444444444444444444444444444444444",
    tokenY: "0x5555555555555555555555555555555555555555",
    walletChainId: 31_337
  };
  const burnFingerprint = burnExecutionContextFingerprint(burnContext);
  for (const [field, value] of Object.entries({
    account: "0x6666666666666666666666666666666666666666",
    binStep: 25,
    burnBps: "5000",
    deadlineMinutes: 21,
    environment: "robinhoodTestnet",
    pair: "0x7777777777777777777777777777777777777777",
    registryChainId: 46_630,
    router: "0x8888888888888888888888888888888888888888",
    selectedPositionsKey: "position-2:8388609",
    slippageBps: "51",
    tokenX: "0x9999999999999999999999999999999999999999",
    tokenY: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    walletChainId: 46_630
  })) {
    assert.notEqual(
      burnExecutionContextFingerprint({ ...burnContext, [field]: value }),
      burnFingerprint,
      `${field} must invalidate the burn execution context`
    );
  }

  console.log(
    "Transaction safety fixture passed: disconnected, wrong-chain, approval-needed warning, blocked approval, stale swap quote, dangerous liquidity slippage, unsupported simulation, and stale liquidity balance."
  );
} finally {
  await server.close();
}
