import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, zeroAddress } from "viem";
import { createServer } from "vite";

import { erc20Abi, lbPairAbi, lbRouterAbi } from "../../../packages/sdk/src/abi.ts";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({ configFile: resolve(webRoot, "vite.config.ts"), logLevel: "error", server: { middlewareMode: true } });

try {
  const { reconcileAddLiquidityReceipt, reconcileNativeAddLiquidityReceipt, reconcileNativeRemoveLiquidityReceipt, samePinnedLiquidityReview } = await server.ssrLoadModule("/src/liquidity-review.ts");
  const A = {
    account: getAddress("0x1000000000000000000000000000000000000001"),
    router: getAddress("0x2000000000000000000000000000000000000002"),
    pair: getAddress("0x3000000000000000000000000000000000000003"),
    tokenX: getAddress("0x4000000000000000000000000000000000000004"),
    tokenY: getAddress("0x5000000000000000000000000000000000000005"),
    recipient: getAddress("0x6000000000000000000000000000000000000006"),
    refund: getAddress("0x1000000000000000000000000000000000000001"),
    other: getAddress("0x7000000000000000000000000000000000000007")
  };
  const review = expectedReview(A);
  assert.equal(samePinnedLiquidityReview(review, structuredClone(review)), true);
  assert.equal(samePinnedLiquidityReview(review, { ...structuredClone(review), router: A.other }), false);
  assert.equal(samePinnedLiquidityReview(review, { ...structuredClone(review), parameters: { ...review.parameters, refundTo: A.other } }), false);

  const standard = reconcileAddLiquidityReceipt({
    account: A.account,
    effectiveGasPrice: 2n,
    expectedReview: review,
    gasUsed: 100n,
    logs: canonicalLogs(A, { compositionX: 5n, protocolX: 1n, refundRecipient: A.refund, shares: 7n }),
    pair: A.pair,
    recipient: A.recipient,
    refundRecipient: A.refund,
    router: A.router,
    tokenX: A.tokenX,
    tokenY: A.tokenY
  });
  assert.equal(standard.actualAddedX, 100n);
  assert.equal(standard.depositedX, 99n);
  assert.equal(standard.positionAmountAfterFeeX, 95n);
  assert.equal(standard.refundedX, 10n);
  assert.equal(standard.eventObservedNetSpendX, 100n);
  assert.equal(standard.eventObservedNetSpendY, 50n);
  assert.equal(standard.estimateMatchedActual, true);
  assert.equal(standard.actualGasCostWei, 200n);
  assert.deepEqual(standard.estimateDifferences, []);

  const nativeA = { ...A, recipient: A.account, refund: A.account };
  const nativeReview = expectedReview(nativeA, "native");
  const native = reconcileNativeAddLiquidityReceipt({
    account: A.account,
    effectiveGasPrice: 2n,
    expectedReview: nativeReview,
    gasUsed: 100n,
    logs: canonicalLogs(nativeA, { compositionX: 5n, grossSenderX: A.router, protocolX: 1n, refundRecipient: A.account, shares: 7n }),
    lpBalances: [{ after: 17n, before: 10n, binId: 100n }],
    nativeBalanceAfter: 800n,
    nativeBalanceBefore: 1_110n,
    nativeSide: "x",
    otherTokenBalanceAfter: 450n,
    otherTokenBalanceBefore: 500n,
    pair: A.pair,
    recipient: A.account,
    refundRecipient: A.account,
    router: A.router,
    tokenX: A.tokenX,
    tokenY: A.tokenY,
    transactionValue: 110n,
    wrapperBalanceAfter: 30n,
    wrapperBalanceBefore: 20n
  });
  assert.equal(native.nativeValueWei, 110n);
  assert.equal(native.wrapperRefund, 10n);
  assert.equal(native.otherTokenNetSpend, 50n);
  assert.deepEqual(native.lpBalanceDeltas, [{ binId: 100n, delta: 7n }]);
  assert.throws(() => reconcileNativeAddLiquidityReceipt({
    account: A.account,
    effectiveGasPrice: 2n,
    expectedReview: nativeReview,
    gasUsed: 100n,
    logs: canonicalLogs(nativeA, { compositionX: 5n, grossSenderX: A.router, protocolX: 1n, refundRecipient: A.account, shares: 7n }),
    lpBalances: [{ after: 18n, before: 10n, binId: 100n }],
    nativeBalanceAfter: 800n,
    nativeBalanceBefore: 1_110n,
    nativeSide: "x",
    otherTokenBalanceAfter: 450n,
    otherTokenBalanceBefore: 500n,
    pair: A.pair,
    recipient: A.account,
    refundRecipient: A.account,
    router: A.router,
    tokenX: A.tokenX,
    tokenY: A.tokenY,
    transactionValue: 110n,
    wrapperBalanceAfter: 30n,
    wrapperBalanceBefore: 20n
  }), /LP balance delta differs/);

  const nativeRemoveInput = {
    account: A.account,
    burnAmounts: [7n],
    effectiveGasPrice: 2n,
    expectedAmountX: 100n,
    expectedAmountY: 50n,
    gasUsed: 100n,
    ids: [100n],
    logs: nativeRemoveLogs(A, 100n, 50n, 7n),
    lpBalances: [{ after: 3n, before: 10n, binId: 100n }],
    minimumAmountX: 99n,
    minimumAmountY: 49n,
    nativeBalanceAfter: 900n,
    nativeBalanceBefore: 1_000n,
    nativeSide: "x",
    otherTokenBalanceAfter: 550n,
    otherTokenBalanceBefore: 500n,
    pair: A.pair,
    router: A.router,
    tokenX: A.tokenX,
    tokenY: A.tokenY,
    transactionValue: 0n
  };
  const nativeRemove = reconcileNativeRemoveLiquidityReceipt(nativeRemoveInput);
  assert.equal(nativeRemove.nativeAmount, 100n);
  assert.equal(nativeRemove.otherTokenAmount, 50n);
  assert.equal(nativeRemove.actualGasCostWei, 200n);
  assert.deepEqual(nativeRemove.burnedBalances, [{ binId: 100n, delta: 7n }]);
  assert.throws(() => reconcileNativeRemoveLiquidityReceipt({ ...nativeRemoveInput, transactionValue: 1n }), /value must be zero/);
  assert.throws(() => reconcileNativeRemoveLiquidityReceipt({ ...nativeRemoveInput, gasUsed: -1n }), /gas fields must be non-negative/);
  assert.throws(() => reconcileNativeRemoveLiquidityReceipt({ ...nativeRemoveInput, lpBalances: [{ after: 4n, before: 10n, binId: 100n }] }), /LP balance delta differs/);
  assert.throws(() => reconcileNativeRemoveLiquidityReceipt({ ...nativeRemoveInput, nativeBalanceAfter: 899n }), /below the reviewed minimum|differ from the simulated outputs/);

  const thirdParty = reconcileAddLiquidityReceipt({
    account: A.account,
    effectiveGasPrice: 2n,
    expectedReview: { ...review, parameters: { ...review.parameters, refundTo: A.other } },
    gasUsed: 100n,
    logs: canonicalLogs(A, { compositionX: 5n, protocolX: 1n, refundRecipient: A.other, shares: 7n }),
    pair: A.pair,
    recipient: A.recipient,
    refundRecipient: A.other,
    router: A.router,
    tokenX: A.tokenX,
    tokenY: A.tokenY
  });
  assert.equal(thirdParty.eventObservedNetSpendX, 110n, "a third-party refund must not reduce the sender wallet spend");

  const taxed = reconcileAddLiquidityReceipt({
    account: A.account,
    effectiveGasPrice: 2n,
    expectedReview: review,
    gasUsed: 100n,
    logs: canonicalLogs(A, { compositionX: 5n, extraOwnerFee: 2n, protocolX: 1n, refundRecipient: A.refund, shares: 7n }),
    pair: A.pair,
    recipient: A.recipient,
    refundRecipient: A.refund,
    router: A.router,
    tokenX: A.tokenX,
    tokenY: A.tokenY
  });
  assert.equal(taxed.eventObservedNetSpendX, 102n, "extra owner outflows must be included in event-observed wallet spend");

  const drift = reconcileAddLiquidityReceipt({
    account: A.account,
    effectiveGasPrice: 2n,
    expectedReview: review,
    gasUsed: 100n,
    logs: canonicalLogs(A, { compositionX: 6n, protocolX: 1n, refundRecipient: A.refund, shares: 8n }),
    pair: A.pair,
    recipient: A.recipient,
    refundRecipient: A.refund,
    router: A.router,
    tokenX: A.tokenX,
    tokenY: A.tokenY
  });
  assert.equal(drift.estimateMatchedActual, false);
  assert.match(drift.estimateDifferences.join("\n"), /composition fee changed/);
  assert.match(drift.estimateDifferences.join("\n"), /minted shares changed/);

  assert.throws(() => reconcileAddLiquidityReceipt({
    account: A.account,
    effectiveGasPrice: 2n,
    expectedReview: review,
    gasUsed: 100n,
    logs: canonicalLogs({ ...A, router: A.other }, { compositionX: 5n, protocolX: 1n, refundRecipient: A.refund, shares: 7n }),
    pair: A.pair,
    recipient: A.recipient,
    refundRecipient: A.refund,
    router: A.router,
    tokenX: A.tokenX,
    tokenY: A.tokenY
  }), /reviewed router/);

  assert.throws(() => reconcileAddLiquidityReceipt({
    account: A.account,
    effectiveGasPrice: 2n,
    expectedReview: review,
    gasUsed: 100n,
    logs: canonicalLogs(A, { compositionX: 5n, omitDeposit: true, protocolX: 1n, refundRecipient: A.refund, shares: 7n }),
    pair: A.pair,
    recipient: A.recipient,
    refundRecipient: A.refund,
    router: A.router,
    tokenX: A.tokenX,
    tokenY: A.tokenY
  }), /missing exact LB deposit/);

  console.log("liquidity review receipt tests passed");
} finally {
  await server.close();
}

function expectedReview(A, assetMode = "erc20") {
  const parameters = {
    tokenX: A.tokenX,
    tokenY: A.tokenY,
    binStep: 10n,
    amountX: 110n,
    amountY: 50n,
    amountXMin: 99n,
    amountYMin: 49n,
    activeIdDesired: 100n,
    idSlippage: 1n,
    deltaIds: [0n],
    distributionX: [1_000_000_000_000_000_000n],
    distributionY: [1_000_000_000_000_000_000n],
    to: A.recipient,
    refundTo: A.refund,
    deadline: 2_000n
  };
  const functionName = assetMode === "native" ? "addLiquidityNATIVE" : "addLiquidity";
  return {
    account: A.account,
    activeId: 100n,
    assetMode,
    block: { hash: `0x${"11".repeat(32)}`, number: 42n, timestamp: 1_000n },
    math: {
      amountXAdded: 100n,
      amountYAdded: 50n,
      amountXLeft: 10n,
      amountYLeft: 0n,
      compositionFeeX: 5n,
      compositionFeeY: 0n,
      protocolFeeX: 1n,
      protocolFeeY: 0n,
      bins: []
    },
    pair: A.pair,
    parameters,
    router: A.router,
    simulation: {
      amountXAdded: 100n,
      amountYAdded: 50n,
      amountXLeft: 10n,
      amountYLeft: 0n,
      depositIds: [100n],
      liquidityMinted: [7n]
    },
    transaction: { data: encodeFunctionData({ abi: lbRouterAbi, functionName, args: [parameters] }), to: A.router, value: assetMode === "native" ? 110n : 0n }
  };
}

function canonicalLogs(A, options) {
  const logs = [
    eventLog(A.pair, lbPairAbi, "CompositionFees", { sender: A.router }, [
      { type: "uint24" }, { type: "bytes32" }, { type: "bytes32" }
    ], [100n, packed(options.compositionX, 0n), packed(options.protocolX, 0n)])
  ];
  if (!options.omitDeposit) {
    logs.push(eventLog(A.pair, lbPairAbi, "DepositedToBins", { sender: A.router, to: A.recipient }, [
      { type: "uint256[]" }, { type: "bytes32[]" }
    ], [[100n], [packed(99n, 50n)]]));
  }
  logs.push(
    eventLog(A.pair, lbPairAbi, "TransferBatch", { sender: A.router, from: zeroAddress, to: A.recipient }, [
      { type: "uint256[]" }, { type: "uint256[]" }
    ], [[100n], [options.shares]]),
    transferLog(A.tokenX, options.grossSenderX ?? A.account, A.pair, 110n),
    transferLog(A.tokenX, A.pair, options.refundRecipient, 10n),
    transferLog(A.tokenY, A.account, A.pair, 50n)
  );
  if (options.extraOwnerFee) logs.push(transferLog(A.tokenX, A.account, A.other, options.extraOwnerFee));
  return logs;
}

function nativeRemoveLogs(A, amountX, amountY, burnAmount) {
  return [
    eventLog(A.pair, lbPairAbi, "WithdrawnFromBins", { sender: A.router, to: A.router }, [
      { type: "uint256[]" }, { type: "bytes32[]" }
    ], [[100n], [packed(amountX, amountY)]]),
    eventLog(A.pair, lbPairAbi, "TransferBatch", { sender: A.router, from: A.account, to: zeroAddress }, [
      { type: "uint256[]" }, { type: "uint256[]" }
    ], [[100n], [burnAmount]]),
    transferLog(A.tokenY, A.router, A.account, amountY)
  ];
}

function eventLog(address, abi, eventName, indexedArgs, dataTypes, dataValues) {
  return {
    address,
    data: encodeAbiParameters(dataTypes, dataValues),
    topics: encodeEventTopics({ abi, eventName, args: indexedArgs })
  };
}

function transferLog(token, from, to, value) {
  return eventLog(token, erc20Abi, "Transfer", { from, to }, [{ type: "uint256" }], [value]);
}

function packed(x, y) {
  return `0x${((y << 128n) | x).toString(16).padStart(64, "0")}`;
}
