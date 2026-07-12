import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const endpoint = "https://indexer.example.test/graphql";
const owner = "0x00000000000000000000000000000000000000a1";
const pairA = "0x00000000000000000000000000000000000000b2";
const pairB = "0x00000000000000000000000000000000000000c3";
const pairC = "0x00000000000000000000000000000000000000d4";
const tokenX = "0x00000000000000000000000000000000000000e5";
const tokenY = "0x00000000000000000000000000000000000000f6";
const positions = Array.from({ length: 501 }, (_, index) => ({
  id: `position-${index}`,
  owner,
  liquidity: String(index + 1),
  updatedAtBlock: String(10_000 - index),
  pair: { id: index % 2 === 0 ? pairA : pairB.toUpperCase().replace("0X", "0x") },
  bin: { binId: String(index) }
}));

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  root: webRoot,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true }
});

try {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  const { loadPaginatedPositionsForOwner } = await server.ssrLoadModule("/src/data.ts");
  const {
    actionHref,
    buildOwnerLiquidityIndex,
    discoveryHref,
    filterPoolPage,
    parsePoolDiscoveryState,
    poolDetailHref,
    returnHrefFromAction,
    safeReturnHref,
    samePairPools
  } = await server.ssrLoadModule("/src/pool-discovery.ts");

  const parsed = parsePoolDiscoveryState("#/pools?q= USDC%20%2F%20WETH &category=stables&sort=updated&page=3&mine=1&ignored=yes");
  assert.deepEqual(parsed, { query: "USDC / WETH", category: "stables", sort: "updated", page: 2, hasLiquidity: true });
  assert.equal(discoveryHref(parsed), "#/pools?q=USDC+%2F+WETH&category=stables&sort=updated&page=3&mine=1");
  assert.deepEqual(parsePoolDiscoveryState("#/pools?category=bogus&sort=nope&page=-4&mine=true"), {
    query: "", category: "all", sort: "swaps", page: 0, hasLiquidity: false
  });

  const detail = poolDetailHref(pairA, parsed);
  const action = actionHref("add", pairA, detail);
  assert.match(action, new RegExp(`^#/liquidity/add/${pairA}\\?returnTo=`));
  assert.equal(returnHrefFromAction(action), detail);
  assert.equal(safeReturnHref("https://evil.example/#/pools"), null);
  assert.equal(safeReturnHref("#/swap/anything"), null);
  assert.equal(safeReturnHref("#/pools/%2e%2e"), null);

  const ownerPage = await loadPaginatedPositionsForOwner({ endpoints: { indexerUrl: endpoint } }, owner.toUpperCase().replace("0X", "0x"));
  assert.equal(ownerPage.rows.length, 500);
  assert.equal(ownerPage.pageInfo.capped, true);
  assert.equal(ownerPage.pageInfo.failed, false);
  const ownerIndex = buildOwnerLiquidityIndex(ownerPage.rows, ownerPage.pageInfo);
  assert.equal(ownerIndex.partial, true);
  assert.deepEqual([...ownerIndex.pairs].sort(), [pairA, pairB]);

  const pools = [
    pool(pairA, tokenX, tokenY, "25", "10"),
    pool(pairB, tokenY.toUpperCase().replace("0X", "0x"), tokenX, "5", "30"),
    pool(pairC, tokenX, "0x0000000000000000000000000000000000000001", "15", "20")
  ];
  const filtered = filterPoolPage(pools, { query: "", category: "all", sort: "swaps", page: 99, hasLiquidity: true }, ownerIndex, 1);
  assert.equal(filtered.ownerStatus, "partial");
  assert.equal(filtered.filteredCount, 2);
  assert.equal(filtered.page, 1);
  assert.equal(filtered.pageCount, 2);
  assert.equal(filtered.rows[0].address, pairA);
  const disconnected = filterPoolPage(pools, { ...parsed, query: "", category: "all", hasLiquidity: true }, null);
  assert.equal(disconnected.ownerStatus, "unavailable");
  assert.equal(disconnected.rows.length, 0);

  const current = pool(pairC, tokenX, tokenY, "20", "1");
  const siblings = samePairPools([
    current,
    pool(pairA, tokenY, tokenX, "100", "1"),
    pool(pairB, tokenX, tokenY, "5", "1")
  ], current);
  assert.deepEqual(siblings.map((candidate) => candidate.binStep), ["5", "100"]);

  globalThis.fetch = originalFetch;
  console.log("Pool discovery fixture passed: canonical URLs, safe return context, owner partials, page clamp, and bin-step siblings.");
} finally {
  await server.close();
}

async function mockFetch(url, init) {
  assert.equal(String(url), endpoint);
  const body = JSON.parse(String(init?.body));
  assert.match(String(body.query), /query OwnerPositions/);
  assert.equal(body.variables.owner, owner);
  const first = Number(body.variables.first);
  const skip = Number(body.variables.skip);
  return new Response(JSON.stringify({ data: { positions: positions.slice(skip, skip + first) } }), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function pool(address, x, y, binStep, swapCount) {
  return {
    id: address,
    address,
    tokenXAddress: x,
    tokenYAddress: y,
    tokenX: { address: x, name: "Token X", symbol: "TKX", tags: ["stablecoin"] },
    tokenY: { address: y, name: "Token Y", symbol: "TKY", tags: ["stablecoin"] },
    activeId: "8388608",
    binStep,
    reserveX: "1",
    reserveY: "1",
    swapCount,
    depositCount: "1",
    updatedAtBlock: "1"
  };
}
