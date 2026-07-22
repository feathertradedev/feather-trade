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
const pairD = "0x00000000000000000000000000000000000000d5";
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
    DEFAULT_POOL_DISCOVERY_STATE,
    discoveryHref,
    filterPoolPage,
    parsePoolDiscoveryState,
    poolDetailHref,
    returnHrefFromAction,
    returnHrefForPoolWorkspace,
    safeReturnHref,
    samePairPools,
    updatePoolDiscoveryState,
    usdDecimalToE18
  } = await server.ssrLoadModule("/src/pool-discovery.ts");

  const parsed = parsePoolDiscoveryState("#/pools?q= USDC%20%2F%20WETH &category=stables&sort=updated&direction=asc&minTvl=001&minVolume=10.5000&minFees=0.25&page=3&mine=1&ignored=yes");
  assert.deepEqual(parsed, {
    query: "USDC / WETH",
    category: "stables",
    sort: "updated",
    direction: "asc",
    minTvlUsd: null,
    minVolume24hUsd: "10.5",
    minLpFees24hUsd: "0.25",
    page: 2,
    hasLiquidity: true
  });
  assert.equal(discoveryHref(parsed), "#/pools?q=USDC+%2F+WETH&category=stables&sort=updated&direction=asc&minVolume=10.5&minFees=0.25&page=3&mine=1");
  assert.deepEqual(parsePoolDiscoveryState("#/pools?category=bogus&sort=nope&page=-4&mine=true"), {
    ...DEFAULT_POOL_DISCOVERY_STATE
  });
  assert.deepEqual(parsePoolDiscoveryState("#/pools?minTvl=1.&minVolume=-1&minFees=1.0000000000000000000"), DEFAULT_POOL_DISCOVERY_STATE);
  assert.equal(discoveryHref(DEFAULT_POOL_DISCOVERY_STATE), "#/pools");
  assert.equal(usdDecimalToE18("10.5"), "10500000000000000000");
  assert.deepEqual(updatePoolDiscoveryState({ ...DEFAULT_POOL_DISCOVERY_STATE, page: 4 }, { sort: "tvl" }), {
    ...DEFAULT_POOL_DISCOVERY_STATE,
    sort: "tvl",
    page: 0
  });
  assert.equal(updatePoolDiscoveryState({ ...DEFAULT_POOL_DISCOVERY_STATE, page: 1 }, { page: 2 }).page, 2);

  const detail = poolDetailHref(pairA, parsed);
  const action = actionHref("add", pairA, detail);
  assert.match(action, new RegExp(`^#/pools/${pairA}/create\\?returnTo=`));
  assert.equal(returnHrefFromAction(action), detail);
  assert.equal(safeReturnHref("https://evil.example/#/pools"), null);
  assert.equal(safeReturnHref("#/swap/anything"), null);
  assert.equal(safeReturnHref("#/pools/%2e%2e"), null);
  assert.equal(safeReturnHref("#/pools/%252e%252e"), null);
  assert.equal(safeReturnHref("#/pools/%2525ZZ"), null);
  assert.equal(returnHrefFromAction("#/swap/pool?returnTo=%23%2Fpools%2F%25252e%25252e"), null);
  assert.equal(
    returnHrefForPoolWorkspace(`#/pools/${pairA}?q=WETH&sort=tvl&direction=asc`),
    "#/pools?q=WETH&sort=tvl&direction=asc"
  );
  assert.equal(
    returnHrefForPoolWorkspace(`#/pools/${pairA}/market?q=WETH&sort=tvl&direction=asc`),
    "#/pools?q=WETH&sort=tvl&direction=asc"
  );
  assert.equal(returnHrefForPoolWorkspace(`#/pools/${pairA}/swap?q=WETH`), null);
  assert.equal(returnHrefForPoolWorkspace(action), detail, "validated action return targets take precedence");

  const ownerPage = await loadPaginatedPositionsForOwner({ endpoints: { indexerUrl: endpoint } }, owner.toUpperCase().replace("0X", "0x"));
  assert.equal(ownerPage.rows.length, 500);
  assert.equal(ownerPage.pageInfo.capped, true);
  assert.equal(ownerPage.pageInfo.failed, false);
  const ownerIndex = buildOwnerLiquidityIndex(ownerPage.rows, ownerPage.pageInfo);
  assert.equal(ownerIndex.partial, true);
  assert.deepEqual([...ownerIndex.pairs].sort(), [pairA, pairB]);
  const currentOwnerIndex = buildOwnerLiquidityIndex([
    { pair: pairA, bins: [{ liquidity: "0" }, { liquidity: "000" }] },
    { pair: pairB, bins: [{ liquidity: "1" }] }
  ], { capped: false, failed: false });
  assert.deepEqual([...currentOwnerIndex.pairs], [pairB]);
  assert.throws(
    () => buildOwnerLiquidityIndex([{ pair: pairA, bins: [{ liquidity: "-1" }] }], { capped: false, failed: false }),
    /Invalid owner liquidity/
  );

  const pools = [
    pool(pairA, tokenX, tokenY, "25", "10"),
    pool(pairB, tokenY.toUpperCase().replace("0X", "0x"), tokenX, "5", "30"),
    pool(pairC, tokenX, "0x0000000000000000000000000000000000000001", "15", "20")
  ];
  const filtered = filterPoolPage(pools, { ...DEFAULT_POOL_DISCOVERY_STATE, sort: "swaps", page: 99, hasLiquidity: true }, ownerIndex, 1);
  assert.equal(filtered.ownerStatus, "partial");
  assert.equal(filtered.filteredCount, 2);
  assert.equal(filtered.page, 1);
  assert.equal(filtered.pageCount, 2);
  assert.equal(filtered.rows[0].address, pairA);
  const disconnected = filterPoolPage(pools, { ...parsed, query: "", category: "all", hasLiquidity: true }, null);
  assert.equal(disconnected.ownerStatus, "unavailable");
  assert.equal(disconnected.rows.length, 0);

  const economics = [
    { ...pools[0], tvlUsdE18: usdDecimalToE18("100"), volume24hUsdE18: usdDecimalToE18("25"), lpFees24hUsdE18: usdDecimalToE18("2") },
    { ...pools[1], tvlUsdE18: usdDecimalToE18("50"), volume24hUsdE18: null, lpFees24hUsdE18: usdDecimalToE18("1") },
    { ...pools[2], tvlUsdE18: null, volume24hUsdE18: usdDecimalToE18("75"), lpFees24hUsdE18: null }
  ];
  const minimumState = {
    ...DEFAULT_POOL_DISCOVERY_STATE,
    minTvlUsd: "50",
    minVolume24hUsd: "20",
    minLpFees24hUsd: "1"
  };
  assert.deepEqual(filterPoolPage(economics, minimumState, null).rows.map((row) => row.address), [pairA]);
  assert.deepEqual(
    filterPoolPage(economics, { ...DEFAULT_POOL_DISCOVERY_STATE, sort: "volume24h", direction: "asc" }, null).rows.map((row) => row.address),
    [pairA, pairC, pairB],
    "unknown values sort last ascending"
  );
  assert.deepEqual(
    filterPoolPage(economics, { ...DEFAULT_POOL_DISCOVERY_STATE, sort: "volume24h", direction: "desc" }, null).rows.map((row) => row.address),
    [pairC, pairA, pairB],
    "unknown values sort last descending"
  );
  const unknownTie = [
    { ...pool(pairD, tokenX, tokenY, "10", "1"), volume24hUsdE18: null },
    { ...pool(pairB, tokenX, tokenY, "10", "1"), volume24hUsdE18: null }
  ];
  assert.deepEqual(
    filterPoolPage(unknownTie, { ...DEFAULT_POOL_DISCOVERY_STATE, direction: "asc" }, null).rows.map((row) => row.address),
    [pairB, pairD],
    "unknown ties use canonical addresses rather than input order"
  );
  const changes = [
    { ...pools[0], priceChange24hE18: "-100" },
    { ...pools[1], priceChange24hE18: "200" },
    { ...pools[2], priceChange24hE18: null }
  ];
  assert.deepEqual(
    filterPoolPage(changes, { ...DEFAULT_POOL_DISCOVERY_STATE, sort: "priceChange", direction: "desc" }, null).rows.map((row) => row.address),
    [pairB, pairA, pairC],
    "signed price changes sort numerically and leave unknowns last"
  );

  const current = pool(pairC, tokenX, tokenY, "20", "1");
  const siblings = samePairPools([
    current,
    pool(pairA, tokenY, tokenX, "100", "1"),
    pool(pairB, tokenX, tokenY, "5", "1")
  ], current);
  assert.deepEqual(siblings.map((candidate) => candidate.binStep), ["5", "100"]);

  globalThis.fetch = originalFetch;
  console.log("Pool discovery fixture passed: canonical URLs/minima, safe returns, owner partials, unknown-last sorting, filters, and siblings.");
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
