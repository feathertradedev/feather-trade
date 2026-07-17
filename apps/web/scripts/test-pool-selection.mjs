import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress } from "viem";
import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  logLevel: "error",
  server: { middlewareMode: true }
});

try {
  const { buildSelectedPoolDescriptor } = await server.ssrLoadModule("/src/pool-selection.ts");
  const { localnetDefaultManifest } = await server.ssrLoadModule("/src/default-manifests.ts");

  const localnetRegistry = {
    seededPools: localnetDefaultManifest.seededPools,
    tokens: {
      WNATIVE: token("wnative", "WNATIVE", localnetDefaultManifest.tokens.wnative, localnetDefaultManifest.chainId, 18),
      WETH: token("weth", "WETH", localnetDefaultManifest.tokens.weth, localnetDefaultManifest.chainId, 18),
      USDC: token("usdc", "USDC", localnetDefaultManifest.tokens.usdc, localnetDefaultManifest.chainId, 6)
    }
  };
  const localnet = buildSelectedPoolDescriptor({
    poolKey: "wethUsdc",
    registry: localnetRegistry,
    source: "localnet-seeded"
  });
  assert.equal(localnet.ready, true);
  assert.equal(localnet.blocked, false);
  assert.equal(localnet.source, "localnet-seeded");
  assert.equal(localnet.pair, getAddress(localnetDefaultManifest.seededPools.wethUsdc.pair));
  assert.equal(localnet.tokenXAddress, getAddress(localnetDefaultManifest.tokens.weth));
  assert.equal(localnet.tokenYAddress, getAddress(localnetDefaultManifest.tokens.usdc));
  assert.equal(localnet.tokenX?.symbol, "WETH");
  assert.equal(localnet.tokenY?.symbol, "USDC");
  assert.equal(localnet.binStep, 10);
  assert.equal(localnet.activeId, 8_396_213);
  assert.deepEqual(localnet.blockers, []);
  assert.deepEqual(localnet.warnings, []);

  const implicitLocalnet = buildSelectedPoolDescriptor({
    registry: localnetRegistry,
    source: "localnet-seeded"
  });
  assert.equal(implicitLocalnet.ready, false);
  assertMessage(implicitLocalnet.blockers, "missing-pool");

  const weth = token("weth", "WETH", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", 4_663, 18);
  const usdg = token("usdg", "USDG", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", 4_663, 6);
  const robinhoodRegistry = {
    tokens: {
      USDG: usdg,
      WETH: weth
    }
  };
  const indexedPool = poolRow({
    activeId: "8388612",
    address: "0x3333333333333333333333333333333333333333",
    binStep: "25",
    tokenXAddress: weth.address.toLowerCase(),
    tokenYAddress: usdg.address.toLowerCase()
  });
  const indexed = buildSelectedPoolDescriptor({
    pool: indexedPool,
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(indexed.ready, true);
  assert.equal(indexed.source, "indexed");
  assert.equal(indexed.pair, getAddress(indexedPool.address));
  assert.equal(indexed.tokenXAddress, weth.address);
  assert.equal(indexed.tokenYAddress, usdg.address);
  assert.equal(indexed.tokenX?.symbol, "WETH");
  assert.equal(indexed.tokenY?.symbol, "USDG");
  assert.equal(indexed.binStep, 25);
  assert.equal(indexed.activeId, 8_388_612);

  for (const action of ["swap", "add-liquidity", "remove-liquidity"]) {
    const actionIndexed = buildSelectedPoolDescriptor({
      action,
      pool: indexedPool,
      registry: robinhoodRegistry,
      source: "indexed"
    });
    assert.equal(actionIndexed.ready, true);
    assert.equal(actionIndexed.source, "indexed");
    assert.equal(actionIndexed.pair, getAddress(indexedPool.address));
  }

  for (const [reserveX, reserveY] of [
    ["0", "2000000000"],
    ["1000000000000000000", "0"]
  ]) {
    const oneSidedReserveSwap = buildSelectedPoolDescriptor({
      action: "swap",
      pool: poolRow({
        activeId: "8388612",
        address: "0x3131313131313131313131313131313131313131",
        binStep: "25",
        reserveX,
        reserveY,
        tokenXAddress: weth.address,
        tokenYAddress: usdg.address
      }),
      registry: robinhoodRegistry,
      source: "indexed"
    });
    assert.equal(oneSidedReserveSwap.ready, true);
    assert.deepEqual(oneSidedReserveSwap.blockers, []);
  }

  const zeroReserveSwap = buildSelectedPoolDescriptor({
    action: "swap",
    pool: poolRow({
      activeId: "8388612",
      address: "0x3131313131313131313131313131313131313131",
      binStep: "25",
      reserveX: "0",
      reserveY: "0",
      tokenXAddress: weth.address,
      tokenYAddress: usdg.address
    }),
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(zeroReserveSwap.ready, false);
  assertMessage(zeroReserveSwap.blockers, "empty-pool", { action: "swap" });

  const missingPool = buildSelectedPoolDescriptor({
    pool: null,
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(missingPool.ready, false);
  assert.equal(missingPool.blocked, true);
  assert.equal(missingPool.pair, null);
  assert.equal(missingPool.binStep, null);
  assertMessage(missingPool.blockers, "missing-pool");

  const missingIndexer = buildSelectedPoolDescriptor({
    indexer: {
      unavailable: true,
      unavailableMessage: "Indexer endpoint is not configured for this environment yet."
    },
    pool: null,
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(missingIndexer.ready, false);
  assertMessage(missingIndexer.blockers, "missing-indexer");
  assertMessage(missingIndexer.blockers, "missing-pool");

  const emptyIndexedPools = buildSelectedPoolDescriptor({
    indexer: {
      empty: true,
      emptyMessage: "No indexed pools are available yet"
    },
    pool: null,
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(emptyIndexedPools.ready, false);
  assertMessage(emptyIndexedPools.blockers, "empty-indexed-pools");
  assertMessage(emptyIndexedPools.blockers, "missing-pool");

  const indexerError = buildSelectedPoolDescriptor({
    indexer: {
      error: true,
      errorMessage: "GraphQL endpoint returned HTTP 502"
    },
    pool: indexedPool,
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(indexerError.ready, false);
  assertMessage(indexerError.blockers, "indexer-error");

  const rpcLoading = buildSelectedPoolDescriptor({
    pool: indexedPool,
    registry: robinhoodRegistry,
    runtime: { actualChainId: null, expectedChainId: 4_663, status: "loading" },
    source: "indexed"
  });
  assert.equal(rpcLoading.ready, false);
  assertMessage(rpcLoading.blockers, "rpc-loading");

  const rpcMismatch = buildSelectedPoolDescriptor({
    pool: indexedPool,
    registry: robinhoodRegistry,
    runtime: {
      actualChainId: 46_630,
      expectedChainId: 4_663,
      message: "RPC chain mismatch: expected 4663, received 46630",
      status: "error"
    },
    source: "indexed"
  });
  assert.equal(rpcMismatch.ready, false);
  assertMessage(rpcMismatch.blockers, "rpc-chain-mismatch");

  const rpcReady = buildSelectedPoolDescriptor({
    pool: indexedPool,
    registry: robinhoodRegistry,
    runtime: { actualChainId: 4_663, expectedChainId: 4_663, status: "ready" },
    source: "indexed"
  });
  assert.equal(rpcReady.ready, true);

  const missingActiveIdPool = poolRow({
    activeId: null,
    address: "0x4444444444444444444444444444444444444444",
    binStep: "10",
    tokenXAddress: weth.address,
    tokenYAddress: usdg.address
  });
  const missingActiveIdDisplay = buildSelectedPoolDescriptor({
    pool: missingActiveIdPool,
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(missingActiveIdDisplay.ready, true);
  assert.equal(missingActiveIdDisplay.activeId, null);

  const missingActiveIdAdd = buildSelectedPoolDescriptor({
    action: "add-liquidity",
    pool: missingActiveIdPool,
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(missingActiveIdAdd.ready, false);
  assertMessage(missingActiveIdAdd.blockers, "missing-pool-field", { action: "add-liquidity" });

  const missingBinStepRemove = buildSelectedPoolDescriptor({
    action: "remove-liquidity",
    pool: {
      ...missingActiveIdPool,
      activeId: "8388614",
      binStep: null
    },
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(missingBinStepRemove.ready, false);
  assertMessage(missingBinStepRemove.blockers, "missing-pool-field", { action: "remove-liquidity" });

  const missingBinStepSwap = buildSelectedPoolDescriptor({
    action: "swap",
    pool: {
      ...missingActiveIdPool,
      activeId: "8388614",
      binStep: null
    },
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(missingBinStepSwap.ready, false);
  assertMessage(missingBinStepSwap.blockers, "missing-pool-field", { action: "swap" });

  const zeroBinStepAdd = buildSelectedPoolDescriptor({
    action: "add-liquidity",
    pool: {
      ...missingActiveIdPool,
      activeId: "8388614",
      binStep: "0"
    },
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(zeroBinStepAdd.ready, false);
  assertMessage(zeroBinStepAdd.blockers, "invalid-pool-number");

  const unknownTokenAddress = "0x9999999999999999999999999999999999999999";
  const missingMetadataPool = poolRow({
    activeId: "8388613",
    address: "0x4444444444444444444444444444444444444444",
    binStep: "10",
    tokenXAddress: unknownTokenAddress,
    tokenYAddress: usdg.address
  });
  const missingMetadataDisplay = buildSelectedPoolDescriptor({
    pool: missingMetadataPool,
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(missingMetadataDisplay.ready, true);
  assert.deepEqual(missingMetadataDisplay.blockers, []);
  assertMessage(missingMetadataDisplay.warnings, "missing-token-metadata", { side: "x" });

  const missingMetadataAction = buildSelectedPoolDescriptor({
    action: "swap",
    pool: missingMetadataPool,
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(missingMetadataAction.ready, false);
  assertMessage(missingMetadataAction.blockers, "missing-token-metadata", { action: "swap", side: "x" });
  assert.deepEqual(missingMetadataAction.warnings, []);

  const stalePartial = buildSelectedPoolDescriptor({
    indexer: {
      partial: true,
      partialMessage: "Fixture partial indexer",
      stale: true,
      staleMessage: "Fixture stale indexer"
    },
    pool: indexedPool,
    registry: robinhoodRegistry,
    source: "indexed"
  });
  assert.equal(stalePartial.ready, false);
  assertMessage(stalePartial.blockers, "partial-indexer");
  assertMessage(stalePartial.blockers, "stale-indexer");

  const liquidityBlockedToken = token("risk", "RISK", "0x7777777777777777777777777777777777777777", 4_663, 18, {
    disabledActions: ["add-liquidity"]
  });
  const riskyRegistry = {
    tokens: {
      RISK: liquidityBlockedToken,
      USDG: usdg
    }
  };
  const riskyPool = poolRow({
    activeId: "8388614",
    address: "0x5555555555555555555555555555555555555555",
    binStep: "10",
    tokenXAddress: liquidityBlockedToken.address,
    tokenYAddress: usdg.address
  });
  const swapAllowed = buildSelectedPoolDescriptor({
    action: "swap",
    pool: riskyPool,
    registry: riskyRegistry,
    source: "indexed"
  });
  assert.equal(swapAllowed.ready, true);
  assert.deepEqual(swapAllowed.blockers, []);

  const liquidityBlocked = buildSelectedPoolDescriptor({
    action: "add-liquidity",
    pool: riskyPool,
    registry: riskyRegistry,
    source: "indexed"
  });
  assert.equal(liquidityBlocked.ready, false);
  assertMessage(liquidityBlocked.blockers, "unsupported-token-action", { action: "add-liquidity", side: "x" });

  console.log(
    "Pool selection fixture passed: explicit localnet seeded descriptor, indexed Robinhood-style descriptor, missing pool/indexer states, metadata warning/blocker behavior, stale/partial indexer blockers, and action-specific token blockers."
  );
} finally {
  await server.close();
}

function poolRow(overrides) {
  return {
    activeId: null,
    address: "0x1111111111111111111111111111111111111111",
    binStep: "10",
    reserveX: "1000000000000000000",
    reserveY: "1000000",
    tokenX: null,
    tokenXAddress: "0x2222222222222222222222222222222222222222",
    tokenY: null,
    tokenYAddress: "0x3333333333333333333333333333333333333333",
    ...overrides
  };
}

function token(id, symbol, address, chainId, decimals, risk = {}) {
  return {
    address: getAddress(address),
    approvalBehavior: risk.approvalBehavior ?? "standard-bool",
    chainId,
    decimals,
    id,
    logoURI: `/token-assets/${id}.svg`,
    name: symbol,
    risk: {
      disabledActions: risk.disabledActions ?? [],
      flags: risk.flags ?? [],
      notes: risk.notes,
      reviewStatus: risk.reviewStatus ?? "standard"
    },
    symbol,
    tags: []
  };
}

function assertMessage(messages, code, expected = {}) {
  const message = messages.find((candidate) =>
    candidate.code === code &&
    (expected.action === undefined || candidate.action === expected.action) &&
    (expected.side === undefined || candidate.side === expected.side)
  );

  assert.ok(
    message,
    `Expected ${code}; received ${messages.map((candidate) => `${candidate.code}:${candidate.side ?? "pool"}`).join(", ")}`
  );
  return message;
}
