import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  root: webRoot,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true }
});

try {
  const { registries } = await server.ssrLoadModule("/src/config.ts");
  const { loadPinnedPoolEconomics } = await server.ssrLoadModule("/src/pool-economics.ts");
  const registry = registries.localnet;
  const seeded = registry.seededPools.wethUsdc;
  const tokenX = Object.values(registry.tokens).find((token) => token.address.toLowerCase() === seeded.tokenX.toLowerCase());
  const tokenY = Object.values(registry.tokens).find((token) => token.address.toLowerCase() === seeded.tokenY.toLowerCase());
  assert(tokenX && tokenY);
  const pool = {
    id: seeded.pair,
    address: seeded.pair,
    tokenXAddress: seeded.tokenX,
    tokenYAddress: seeded.tokenY,
    tokenX,
    tokenY,
    activeId: String(seeded.activeId),
    binStep: String(seeded.binStep),
    reserveX: "1",
    reserveY: "1",
    volumeX: "0",
    volumeY: "0",
    feesX: "0",
    feesY: "0",
    factoryAddress: registry.contracts.lbFactory,
    hooksParameters: null,
    ignoredForRouting: false,
    swapCount: "0",
    depositCount: "0",
    updatedAtBlock: "50"
  };
  const anchor = {
    activeId: BigInt(seeded.activeId),
    binStep: BigInt(seeded.binStep),
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: 55n,
    factory: pool.factoryAddress,
    tokenX: pool.tokenXAddress,
    tokenY: pool.tokenYAddress
  };

  const { client, calls } = fakeClient(registry, pool);
  const economics = await loadPinnedPoolEconomics(client, registry, pool, anchor);
  assert.equal(economics.blockNumber, 55n);
  assert.equal(economics.activeId, BigInt(seeded.activeId));
  assert.equal(economics.binStep, BigInt(seeded.binStep));
  assert.equal(economics.source, "rpc-at-indexer-block");
  assert.equal(economics.feeRates.totalFeeRate, economics.feeRates.baseFeeRate + economics.feeRates.variableFeeRate);
  assert.equal(economics.feeRates.totalFeeRate, economics.feeRates.protocolFeeRate + economics.feeRates.lpNetFeeRate);
  assert(calls.every((call) => call.blockNumber === 55n), "every economics contract read is pinned to one block");

  const wrongFactory = fakeClient(registry, pool, { getFactory: "0x00000000000000000000000000000000000000ff" });
  await assert.rejects(() => loadPinnedPoolEconomics(wrongFactory.client, registry, pool, anchor), /factory.*identity/);
  const reorg = fakeClient(registry, pool, { reorg: true });
  await assert.rejects(() => loadPinnedPoolEconomics(reorg.client, registry, pool, anchor), /block changed/);
  const wrongDecimalsX = fakeClient(registry, pool, { decimalsX: tokenX.decimals + 1 });
  await assert.rejects(() => loadPinnedPoolEconomics(wrongDecimalsX.client, registry, pool, anchor), /token X decimals/);
  const wrongDecimalsY = fakeClient(registry, pool, { decimalsY: tokenY.decimals + 1 });
  await assert.rejects(() => loadPinnedPoolEconomics(wrongDecimalsY.client, registry, pool, anchor), /token Y decimals/);
  await assert.rejects(
    () => loadPinnedPoolEconomics(client, registry, pool, { ...anchor, activeId: anchor.activeId + 1n }),
    /active ID differs from the indexer snapshot/
  );
  await assert.rejects(
    () => loadPinnedPoolEconomics(client, registry, { ...pool, tokenXAddress: "0x00000000000000000000000000000000000000ee" }, anchor),
    /allowlist/
  );

  console.log("Pinned pool economics fixture passed: one-block reads, identity/allowlist checks, fee decomposition, and reorg failure.");
} finally {
  await server.close();
}

function fakeClient(registry, pool, overrides = {}) {
  const calls = [];
  let blockReads = 0;
  const values = {
    getFactory: pool.factoryAddress,
    getTokenX: pool.tokenXAddress,
    getTokenY: pool.tokenYAddress,
    getBinStep: Number(pool.binStep),
    getActiveId: Number(pool.activeId),
    getStaticFeeParameters: [20, 30, 120, 5_000, 100, 1_000, 100_000],
    getVariableFeeParameters: [1_000, 500, Number(pool.activeId) - 1, 1_000n],
    ...overrides
  };
  return {
    calls,
    client: {
      getChainId: async () => registry.chainId,
      getBlock: async () => {
        blockReads += 1;
        return {
          hash: overrides.reorg && blockReads > 1 ? `0x${"22".repeat(32)}` : `0x${"11".repeat(32)}`,
          number: 55n,
          timestamp: 1_005n
        };
      },
      readContract: async (request) => {
        calls.push(request);
        if (request.functionName === "decimals") {
          return request.address.toLowerCase() === pool.tokenXAddress.toLowerCase()
            ? overrides.decimalsX ?? pool.tokenX.decimals
            : overrides.decimalsY ?? pool.tokenY.decimals;
        }
        return values[request.functionName];
      }
    }
  };
}
