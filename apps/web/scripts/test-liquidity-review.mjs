import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeAbiParameters, encodeEventTopics, getAddress, zeroAddress } from "viem";
import { createServer } from "vite";

import { erc20Abi, lbPairAbi } from "../../../packages/sdk/src/abi.ts";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({ configFile: resolve(webRoot, "vite.config.ts"), logLevel: "error", server: { middlewareMode: true } });

try {
  const { reconcileAddLiquidityReceipt, samePinnedLiquidityReview } = await server.ssrLoadModule("/src/liquidity-review.ts");
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

function expectedReview(A) {
  return {
    account: A.account,
    activeId: 100n,
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
    parameters: {
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
    },
    router: A.router,
    simulation: {
      amountXAdded: 100n,
      amountYAdded: 50n,
      amountXLeft: 10n,
      amountYLeft: 0n,
      depositIds: [100n],
      liquidityMinted: [7n]
    }
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
    transferLog(A.tokenX, A.account, A.pair, 110n),
    transferLog(A.tokenX, A.pair, options.refundRecipient, 10n),
    transferLog(A.tokenY, A.account, A.pair, 50n)
  );
  if (options.extraOwnerFee) logs.push(transferLog(A.tokenX, A.account, A.other, options.extraOwnerFee));
  return logs;
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
