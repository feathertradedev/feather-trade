import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import { encodeFunctionData } from "viem";

const createPairAbi = [{
  type: "function",
  name: "createLBPair",
  stateMutability: "nonpayable",
  inputs: [
    { name: "tokenX", type: "address" },
    { name: "tokenY", type: "address" },
    { name: "activeId", type: "uint24" },
    { name: "binStep", type: "uint16" }
  ],
  outputs: [{ name: "pair", type: "address" }]
}];

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  logLevel: "error",
  server: { middlewareMode: true }
});

try {
  const {
    createPoolCreationReview,
    poolCreationReviewFingerprint,
    poolCreationReviewIsCurrent,
    prepareFreshPoolAddReview,
    recordAmbiguousCreateSubmission,
    recordAmbiguousPoolAddSubmission,
    recordCanonicalPoolConfirmation,
    recordCreatedPoolEmpty,
    recordCreateMinedRevert,
    recordCreateWalletRejection,
    recordDuplicatePool,
    recordPoolAddFailure,
    recordPoolCreationReorg,
    recordPoolIndexingLag
  } = await server.ssrLoadModule("/src/pool-creation.ts");

  const addresses = {
    account: "0x1000000000000000000000000000000000000001",
    factory: "0x2000000000000000000000000000000000000002",
    router: "0x3000000000000000000000000000000000000003",
    tokenX: "0xF000000000000000000000000000000000000004",
    tokenY: "0x4000000000000000000000000000000000000004",
    pair: "0x5000000000000000000000000000000000000005",
    other: "0x6000000000000000000000000000000000000006"
  };
  const hash = (digit) => `0x${digit.repeat(64)}`;
  const creationData = (tokenX, tokenY, activeId, binStep) => encodeFunctionData({
    abi: createPairAbi,
    functionName: "createLBPair",
    args: [tokenX, tokenY, activeId, binStep]
  });
  const reviewInput = {
    environment: "localnet",
    deploymentEpoch: "localnet:factory-v1:router-v1",
    chainId: 31_337,
    walletChainId: 31_337,
    rpcChainId: 31_337,
    account: addresses.account,
    factory: addresses.factory,
    router: addresses.router,
    tokenX: addresses.tokenX,
    tokenY: addresses.tokenY,
    tokenXDecimals: 18,
    tokenYDecimals: 6,
    binStep: 25n,
    activeId: 8_388_608n,
    requestedQuotePerBase: "2500.125",
    representableQuotePerBase: "2499.999",
    representablePriceQ128: 340_282_366_920_938_463_463_374_607_431_768_211_456n,
    preset: {
      baseFactor: 20n,
      filterPeriod: 30n,
      decayPeriod: 600n,
      reductionFactor: 5_000n,
      variableFeeControl: 40_000n,
      protocolShare: 1_000n,
      maxVolatilityAccumulator: 350_000n,
      isOpen: true
    },
    pinnedHead: { number: 42n, hash: hash("1") },
    mode: "create-and-add",
    transaction: {
      to: addresses.router,
      data: creationData(addresses.tokenX, addresses.tokenY, 8_388_608, 25),
      value: 0n
    },
    roundingRiskAcknowledged: true
  };
  const review = createPoolCreationReview(reviewInput);
  assert.equal(poolCreationReviewIsCurrent(review, reviewInput), true);
  assert.equal(review.fingerprint, poolCreationReviewFingerprint(reviewInput));
  assert.equal(Object.isFrozen(review), true);
  assert.equal(Object.isFrozen(review.binding), true);
  assert.equal(Object.isFrozen(review.binding.preset), true);
  assert.equal(Object.isFrozen(review.binding.pinnedHead), true);
  assert.equal(Object.isFrozen(review.binding.transaction), true);
  assert.throws(() => {
    review.binding.mode = "create-only";
  }, TypeError);

  const mutations = [
    { environment: "robinhoodTestnet" },
    { deploymentEpoch: "localnet:factory-v2:router-v1" },
    { chainId: 46_630, walletChainId: 46_630, rpcChainId: 46_630 },
    { walletChainId: 46_630 },
    { rpcChainId: 46_630 },
    { account: addresses.other },
    { factory: addresses.other },
    { router: addresses.other },
    { tokenX: addresses.other },
    { tokenY: addresses.other },
    { tokenXDecimals: 8 },
    { tokenYDecimals: 18 },
    { binStep: 10n },
    { activeId: 8_388_609n },
    { requestedQuotePerBase: "2500.126" },
    { representableQuotePerBase: "2500" },
    { representablePriceQ128: reviewInput.representablePriceQ128 + 1n },
    { preset: { ...reviewInput.preset, baseFactor: 21n } },
    { preset: { ...reviewInput.preset, filterPeriod: 31n } },
    { preset: { ...reviewInput.preset, decayPeriod: 601n } },
    { preset: { ...reviewInput.preset, reductionFactor: 5_001n } },
    { preset: { ...reviewInput.preset, variableFeeControl: 40_001n } },
    { preset: { ...reviewInput.preset, protocolShare: 1_001n } },
    { preset: { ...reviewInput.preset, maxVolatilityAccumulator: 350_001n } },
    { pinnedHead: { ...reviewInput.pinnedHead, number: 43n } },
    { pinnedHead: { ...reviewInput.pinnedHead, hash: hash("2") } },
    { mode: "create-only" },
    { transaction: { ...reviewInput.transaction, to: addresses.other } },
    { transaction: { ...reviewInput.transaction, data: "0x87654321" } },
    { transaction: { ...reviewInput.transaction, data: creationData(addresses.tokenY, addresses.tokenX, 8_388_608, 25) } },
    { transaction: { ...reviewInput.transaction, data: creationData(addresses.tokenX, addresses.tokenY, 8_388_609, 25) } },
    { transaction: { ...reviewInput.transaction, data: creationData(addresses.tokenX, addresses.tokenY, 8_388_608, 10) } },
    { transaction: { ...reviewInput.transaction, value: 1n } },
    { roundingRiskAcknowledged: false }
  ];
  for (const mutation of mutations) {
    assert.equal(
      poolCreationReviewIsCurrent(review, { ...reviewInput, ...mutation }),
      false,
      `${Object.keys(mutation)[0]} must invalidate the immutable creation review`
    );
  }
  assert.throws(
    () => poolCreationReviewFingerprint({ ...reviewInput, preset: { ...reviewInput.preset, isOpen: false } }),
    /preset must be open/
  );

  const reviewedPool = {
    pair: addresses.pair,
    factory: addresses.factory,
    tokenX: addresses.tokenX,
    tokenY: addresses.tokenY,
    binStep: 25n,
    activeId: reviewInput.activeId,
    priceQ128: reviewInput.representablePriceQ128,
    observedHead: { number: 44n, hash: hash("3") }
  };
  const raceWinnerPool = {
    ...reviewedPool,
    activeId: reviewInput.activeId + 7n,
    priceQ128: reviewInput.representablePriceQ128 + 7n,
    observedHead: { number: 45n, hash: hash("4") }
  };

  const duplicate = recordDuplicatePool(review, raceWinnerPool, "race-winner");
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.canAutoSeed, false);
  assert.equal(duplicate.freshAddReviewRequired, true);
  const raceAddReview = prepareFreshPoolAddReview(duplicate, raceWinnerPool, "fresh-race-add-review");
  assert.equal(raceAddReview.desiredActiveId, raceWinnerPool.activeId);
  assert.notEqual(raceAddReview.desiredActiveId, review.binding.activeId);
  assert.equal(raceAddReview.representablePriceQ128, raceWinnerPool.priceQ128);
  assert.equal(raceAddReview.reusedCreationDesiredId, false);
  const movedRacePool = {
    ...raceWinnerPool,
    activeId: raceWinnerPool.activeId + 1n,
    priceQ128: raceWinnerPool.priceQ128 + 1n,
    observedHead: { number: 46n, hash: hash("8") }
  };
  const movedRaceAddReview = prepareFreshPoolAddReview(duplicate, movedRacePool, "fresh-moved-race-add-review");
  const movedRaceAddRejected = recordPoolAddFailure(duplicate, movedRaceAddReview, "wallet-rejected");
  assert.equal(movedRaceAddRejected.pool.activeId, movedRacePool.activeId);
  assert.equal(movedRaceAddRejected.pool.pair, duplicate.pool.pair);
  const ambiguousMovedAdd = recordAmbiguousPoolAddSubmission(duplicate, movedRaceAddReview, null);
  assert.equal(ambiguousMovedAdd.kind, "add-ambiguous-submission");
  assert.equal(ambiguousMovedAdd.pool.pair, duplicate.pool.pair);
  assert.equal(ambiguousMovedAdd.poolPreserved, true);
  assert.equal(ambiguousMovedAdd.retryBlocked, true);
  assert.equal(ambiguousMovedAdd.transactionHash, null);
  const otherAccountReview = createPoolCreationReview({ ...reviewInput, account: addresses.other });
  const otherAccountDuplicate = recordDuplicatePool(otherAccountReview, raceWinnerPool, "race-winner");
  const crossReviewAdd = prepareFreshPoolAddReview(otherAccountDuplicate, raceWinnerPool, "other-account-add");
  assert.throws(
    () => recordPoolAddFailure(duplicate, crossReviewAdd, "wallet-rejected"),
    /exact freshly reviewed live pool state/
  );
  assert.throws(
    () => recordDuplicatePool(review, { ...raceWinnerPool, observedHead: { number: 41n, hash: hash("9") } }, "race-winner"),
    /predates the reviewed pinned head/
  );

  assert.deepEqual(recordCreateWalletRejection(review), {
    kind: "wallet-rejection",
    review,
    retryRequiresReview: true
  });
  assert.deepEqual(recordAmbiguousCreateSubmission(review, null), {
    kind: "ambiguous-submission",
    review,
    transactionHash: null,
    retryBlocked: true
  });
  const txHash = hash("a");
  assert.equal(recordCreateMinedRevert(review, txHash, { number: 44n, hash: hash("3") }).kind, "mined-revert");
  assert.throws(
    () => recordCreateMinedRevert(review, txHash, { number: 41n, hash: hash("9") }),
    /predates the reviewed pinned head/
  );

  const confirmation = recordCanonicalPoolConfirmation(review, txHash, reviewedPool);
  assert.equal(confirmation.kind, "canonical-confirmation");
  assert.throws(
    () => recordCanonicalPoolConfirmation(review, txHash, raceWinnerPool),
    /price differs from the reviewed/
  );

  const lag = recordPoolIndexingLag(confirmation, { number: 48n, hash: hash("5") }, 43n);
  assert.equal(lag.kind, "indexing-lag");
  assert.equal(lag.pool.pair, addresses.pair);
  assert.equal(lag.swapEnabled, false);
  assert.equal(lag.canAutoSeed, false);
  assert.throws(
    () => recordPoolIndexingLag(confirmation, { number: 48n, hash: hash("5") }, 49n),
    /behind the created-pool observation/
  );
  assert.throws(
    () => recordPoolIndexingLag(confirmation, { number: 48n, hash: hash("5") }, 44n),
    /behind the created-pool observation/
  );

  const createdEmpty = recordCreatedPoolEmpty(confirmation, {
    ...reviewedPool,
    observedHead: { number: 49n, hash: hash("6") }
  }, true);
  assert.equal(createdEmpty.kind, "created-empty");
  assert.equal(createdEmpty.swapEnabled, false);
  assert.equal(createdEmpty.canAutoSeed, false);
  assert.equal(createdEmpty.freshAddReviewRequired, true);
  assert.equal(createdEmpty.emptyVerified, true);
  assert.throws(
    () => recordCreatedPoolEmpty(confirmation, { ...reviewedPool, observedHead: { number: 43n, hash: hash("9") } }, true),
    /older live pool head/
  );

  const addReview = prepareFreshPoolAddReview(createdEmpty, createdEmpty.pool, "fresh-created-add-review");
  assert.equal(addReview.desiredActiveId, createdEmpty.pool.activeId);
  assert.equal(addReview.reviewedHead.number, 49n);
  const addRejected = recordPoolAddFailure(createdEmpty, addReview, "wallet-rejected");
  assert.equal(addRejected.kind, "add-rejected");
  assert.equal(addRejected.pool.pair, addresses.pair);
  assert.equal(addRejected.poolPreserved, true);
  assert.equal(addRejected.freshAddReviewRequired, true);
  const addReverted = recordPoolAddFailure(createdEmpty, addReview, "mined-revert");
  assert.equal(addReverted.kind, "add-reverted");
  assert.equal(addReverted.pool.pair, addresses.pair);
  assert.equal(addReverted.poolPreserved, true);
  assert.equal(addReverted.freshAddReviewRequired, true);
  assert.throws(
    () => recordPoolAddFailure(createdEmpty, { ...addReview, desiredActiveId: addReview.desiredActiveId + 1n }, "mined-revert"),
    /exact freshly reviewed live pool state/
  );

  assert.throws(
    () => prepareFreshPoolAddReview(createdEmpty, { ...createdEmpty.pool, activeId: createdEmpty.pool.activeId + 1n }, "stale"),
    /freshly reviewed live active ID and price|created pool identity/
  );
  const reorg = recordPoolCreationReorg(createdEmpty, { number: 50n, hash: hash("7") });
  assert.equal(reorg.kind, "reorg");
  assert.equal(reorg.orphanedPool.pair, addresses.pair);
  assert.equal(reorg.canSeed, false);
  assert.equal(reorg.retryRequiresReview, true);
  assert.equal(recordPoolCreationReorg(addRejected, { number: 51n, hash: hash("8") }).kind, "reorg");
  assert.equal(recordPoolCreationReorg(ambiguousMovedAdd, { number: 52n, hash: hash("9") }).kind, "reorg");

  const createOnlyReview = createPoolCreationReview({ ...reviewInput, mode: "create-only" });
  const createOnlyDuplicate = recordDuplicatePool(createOnlyReview, raceWinnerPool, "preexisting");
  assert.equal(createOnlyDuplicate.freshAddReviewRequired, false);
  const createOnlyConfirmation = recordCanonicalPoolConfirmation(createOnlyReview, txHash, reviewedPool);
  const createOnlyEmpty = recordCreatedPoolEmpty(createOnlyConfirmation, {
    ...reviewedPool,
    observedHead: { number: 53n, hash: hash("b") }
  }, true);
  assert.equal(createOnlyEmpty.freshAddReviewRequired, false);
  assert.equal(createOnlyEmpty.canAutoSeed, false);

  console.log("Pool-creation state fixtures passed: immutable review binding, duplicate/race freshness, truthful submission recovery, receipt-bound confirmation, reorg/indexing lag, and preserved created-empty pools after add failures.");
} finally {
  await server.close();
}
