import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import { encodeFunctionData } from "viem";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  logLevel: "error",
  server: { middlewareMode: true }
});

const addresses = {
  account: "0x1000000000000000000000000000000000000001",
  factory: "0x2000000000000000000000000000000000000002",
  router: "0x3000000000000000000000000000000000000003",
  tokenX: "0x4000000000000000000000000000000000000004",
  tokenY: "0x5000000000000000000000000000000000000005"
};
const blockHash = `0x${"a".repeat(64)}`;
const transactionHash = `0x${"b".repeat(64)}`;

try {
  const { createPoolCreationReview } = await server.ssrLoadModule("/src/pool-creation.ts");
  const { loadPoolCreationReview, persistPoolCreationReview } = await server.ssrLoadModule("/src/pool-creation-review-storage.ts");
  const { formatPoolCreationElapsed, poolCreationProgress } = await server.ssrLoadModule("/src/pool-creation-progress.ts");
  const {
    TRUSTED_POOL_CREATION_PRICE_CLIENT_TTL_MS,
    loadTrustedPoolCreationPrice,
    trustedPoolCreationPriceIsLocallyFresh,
    trustedPoolCreationPriceLocalAgeSeconds,
    trustedPriceDeviationBps
  } = await server.ssrLoadModule("/src/pool-creation-price.ts");

  const transaction = {
    to: addresses.router,
    data: encodeFunctionData({
      abi: [{
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
      }],
      functionName: "createLBPair",
      args: [addresses.tokenX, addresses.tokenY, 8_388_608, 10]
    }),
    value: 0n
  };
  const review = createPoolCreationReview({
    environment: "sepolia",
    deploymentEpoch: "sepolia:test",
    chainId: 11_155_111,
    walletChainId: 11_155_111,
    rpcChainId: 11_155_111,
    account: addresses.account,
    factory: addresses.factory,
    router: addresses.router,
    tokenX: addresses.tokenX,
    tokenY: addresses.tokenY,
    tokenXDecimals: 18,
    tokenYDecimals: 6,
    binStep: 10n,
    activeId: 8_388_608n,
    requestedQuotePerBase: "1922",
    representableQuotePerBase: "1921.99",
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
    pinnedHead: { number: 42n, hash: blockHash },
    mode: "create-only",
    transaction,
    roundingRiskAcknowledged: true
  });

  const storageMap = new Map();
  const storage = {
    getItem: (key) => storageMap.get(key) ?? null,
    setItem: (key, value) => storageMap.set(key, value)
  };
  persistPoolCreationReview(storage, review, 1_000);
  assert.equal(loadPoolCreationReview(storage, review.fingerprint)?.fingerprint, review.fingerprint);
  storageMap.set("feather.pool-creation-reviews.v1", JSON.stringify({
    version: 1,
    reviews: [{
      fingerprint: review.fingerprint,
      savedAt: 1_000,
      binding: { transaction: { value: "1" } }
    }]
  }));
  assert.equal(loadPoolCreationReview(storage, review.fingerprint), null, "tampered review storage must fail closed");

  const journal = {
    actualNonce: "1",
    activeHash: transactionHash,
    canonicalReceipt: null,
    confirmations: 0,
    createdAt: 1_000,
    hashes: [],
    id: "create-1",
    lastCheckedAt: null,
    lifecycleRevision: 1,
    expectedNonce: "1",
    reconciliationAttempts: 0,
    rejectionReason: null,
    replacementCompatibility: null,
    replacementFinalized: false,
    reviewed: {
      account: addresses.account,
      calldataFingerprint: blockHash,
      chainId: 11_155_111,
      contractsFingerprint: "",
      deploymentEpoch: "sepolia:test",
      environment: "sepolia",
      executionFingerprint: review.fingerprint,
      intent: "create-pool",
      poolId: null,
      recipient: null,
      refundRecipient: null,
      settingsFingerprint: "",
      target: addresses.router,
      value: "0"
    },
    scanCursor: "0",
    status: "submitted",
    submissionBlock: "42",
    submittedAt: 2_000,
    timeoutAt: 602_000,
    updatedAt: 2_000,
    walletLeaseUntil: 0
  };
  assert.equal(poolCreationProgress(journal, null, false).verifiedStep, 1);
  assert.match(poolCreationProgress({ ...journal, status: "confirming", confirmations: 1 }, null, false).title, /Waiting for confirmation/);
  assert.match(poolCreationProgress({ ...journal, status: "timed-out" }, null, false).title, /longer than expected/);
  assert.equal(poolCreationProgress({ ...journal, status: "rejected" }, null, false).canStartFreshReview, true);
  assert.equal(formatPoolCreationElapsed(1_000, 66_000), "1m 5s");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      trustedPairPrice: {
        baseToken: addresses.tokenX,
        quoteToken: addresses.tokenY,
        quotePerBaseE18: "1922000000000000000000",
        status: "READY",
        baseSource: "chainlink-data-feeds",
        quoteSource: "chainlink-data-feeds",
        baseObservedAt: 1_000,
        quoteObservedAt: 1_000,
        baseAgeSeconds: 12,
        quoteAgeSeconds: 8,
        asOfBlock: "44",
        asOfBlockHash: blockHash,
        asOfTimestamp: 1_012
      }
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  const trusted = await loadTrustedPoolCreationPrice("https://analytics.example/graphql", addresses.tokenX, addresses.tokenY);
  assert.equal(trusted.reason, "available");
  assert.equal(trusted.price?.quotePerBaseE18, "1922000000000000000000");
  assert.equal(trustedPriceDeviationBps("1922", trusted.price.quotePerBaseE18), 0n);
  assert.equal(trustedPriceDeviationBps("1", trusted.price.quotePerBaseE18), 9_994n);
  assert.equal(
    trustedPoolCreationPriceIsLocallyFresh(10_000, 10_000 + TRUSTED_POOL_CREATION_PRICE_CLIENT_TTL_MS),
    true,
    "the bounded local freshness deadline is inclusive"
  );
  assert.equal(
    trustedPoolCreationPriceIsLocallyFresh(10_000, 10_001 + TRUSTED_POOL_CREATION_PRICE_CLIENT_TTL_MS),
    false,
    "a READY response must expire locally even when the server status remains frozen"
  );
  assert.equal(
    trustedPoolCreationPriceLocalAgeSeconds(trusted.price, 10_000, 15_999),
    17,
    "displayed sample age advances while the page stays open"
  );

  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      trustedPairPrice: {
        baseToken: addresses.tokenX,
        quoteToken: addresses.tokenY,
        quotePerBaseE18: null,
        status: "PARTIAL",
        baseSource: "chainlink-data-feeds",
        quoteSource: "chainlink-data-feeds"
      }
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  const stale = await loadTrustedPoolCreationPrice("https://analytics.example/graphql", addresses.tokenX, addresses.tokenY);
  assert.equal(stale.price, null);
  assert.equal(stale.reason, "stale");
  globalThis.fetch = originalFetch;

  console.log("pool creation safety fixtures passed");
} finally {
  await server.close();
}
