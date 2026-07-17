import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tokenX = "0x0000000000000000000000000000000000000011";
const tokenY = "0x0000000000000000000000000000000000000022";
const pair = "0x0000000000000000000000000000000000000033";
const E18 = 10n ** 18n;
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  root: webRoot,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true }
});

try {
  const { DEFAULT_POOL_DISCOVERY_STATE, filterPoolPage } = await server.ssrLoadModule("/src/pool-discovery.ts");
  const {
    buildPoolDiscoveryRequests,
    buildPoolDiscoveryRows,
    calculatePriceChange24hE18,
    formatCompactUsdE18,
    formatPoolPriceE18,
    formatSignedPercentE18,
    invertPriceE18,
    normalizeSparkline,
    orientPoolPriceE18,
    resolveDisplayOrientation,
    resolveTokenLogo
  } = await server.ssrLoadModule("/src/pool-discovery-model.ts");

  const noTags = resolveDisplayOrientation(tokenX, tokenY, { tags: [] }, { tags: [] });
  assert.deepEqual(noTags, { baseToken: tokenX, quoteToken: tokenY, inverted: false });
  const stableX = resolveDisplayOrientation(tokenX, tokenY, { tags: ["quote"] }, { tags: [] });
  assert.deepEqual(stableX, { baseToken: tokenY, quoteToken: tokenX, inverted: true });
  const candleWins = resolveDisplayOrientation(tokenX, tokenY, { tags: ["quote"] }, { tags: [] }, tokenY);
  assert.deepEqual(candleWins, { baseToken: tokenX, quoteToken: tokenY, inverted: false });
  assert.throws(
    () => resolveDisplayOrientation(tokenX, tokenY, null, null, pair),
    /does not belong/
  );

  assert.equal(invertPriceE18((2n * E18).toString()), (E18 / 2n).toString());
  assert.equal(invertPriceE18("0"), null);
  assert.equal(orientPoolPriceE18((2n * E18).toString(), tokenX, tokenY, tokenY), (2n * E18).toString());
  assert.equal(orientPoolPriceE18((2n * E18).toString(), tokenX, tokenY, tokenX), (E18 / 2n).toString());
  assert.equal(orientPoolPriceE18(null, tokenX, tokenY, tokenX), null);

  assert.deepEqual(normalizeSparkline([]), {
    segments: [], points: [], sourcePointCount: 0, flat: false, available: false,
    title: "No canonical hourly price history is available."
  });
  const one = normalizeSparkline([{ startTimestamp: 0, valueE18: E18.toString() }]);
  assert.equal(one.points.length, 1);
  assert.equal(one.points[0].x, 50);
  assert.equal(one.points[0].y, 50);
  assert.equal(one.segments.length, 1);
  const flat = normalizeSparkline([
    { startTimestamp: 0, valueE18: E18.toString() },
    { startTimestamp: 3_600, valueE18: E18.toString() }
  ]);
  assert.equal(flat.flat, true);
  assert.deepEqual(flat.points.map((point) => point.y), [50, 50]);
  const gapped = normalizeSparkline([
    { startTimestamp: 0, valueE18: E18.toString() },
    { startTimestamp: 3_600, valueE18: null },
    { startTimestamp: 7_200, valueE18: (2n * E18).toString() }
  ]);
  assert.equal(gapped.points.length, 2, "missing points are never fabricated");
  assert.equal(gapped.segments.length, 2, "missing hours remain visually disconnected");
  assert.throws(() => normalizeSparkline([
    { startTimestamp: 0, valueE18: "1" },
    { startTimestamp: 0, valueE18: "2" }
  ]), /Duplicate/);

  assert.equal(calculatePriceChange24hE18([
    { startTimestamp: 0, valueE18: (100n * E18).toString() },
    { startTimestamp: 3_600, valueE18: (110n * E18).toString() }
  ]), (E18 / 10n).toString());
  assert.equal(calculatePriceChange24hE18([{ startTimestamp: 0, valueE18: "0" }, { startTimestamp: 3_600, valueE18: "1" }]), null);
  assert.equal(formatSignedPercentE18((E18 / 10n).toString()), "+10%");
  assert.equal(formatSignedPercentE18((-E18 / 20n).toString()), "-5%");
  assert.equal(formatCompactUsdE18((1_042_229n * E18).toString()), "$1.04M");
  assert.equal(formatCompactUsdE18(null), "-");
  assert.equal(formatPoolPriceE18((E18 / 2n).toString()), "0.5");

  const curated = resolveTokenLogo("/token-assets/weth.svg", "https://analytics.test/token-images/x", tokenX);
  assert.equal(curated.kind, "curated");
  assert.equal(curated.src, "/token-assets/weth.svg");
  const provider = resolveTokenLogo(null, "https://analytics.test/token-images/x", tokenX);
  assert.equal(provider.kind, "provider");
  const fallback = resolveTokenLogo(null, null, tokenX);
  assert.equal(fallback.kind, "address");
  assert.equal(fallback.src, null);
  assert.equal(fallback.fallbackLabel, "00");
  assert.equal(resolveTokenLogo(null, null, tokenX).fallbackColor, fallback.fallbackColor);

  const poolRow = poolFixture();
  assert.deepEqual(buildPoolDiscoveryRequests([poolRow]), [{ pair, preferredQuoteToken: tokenY }]);
  const manyPools = Array.from({ length: 205 }, (_, index) => poolFixture(address(index + 1_000)));
  const manyRequests = buildPoolDiscoveryRequests(manyPools);
  assert.equal(manyRequests.length, 205, "the frontend model never truncates indexed pools");
  assert.deepEqual(manyRequests.map((request) => request.pair), manyPools.map((pool) => pool.address));
  const manyRows = buildPoolDiscoveryRows(
    manyPools,
    { rows: manyPools.map((pool, index) => discoveryFixture(pool.address, index)), status: "READY", error: null },
    "https://analytics.test/graphql"
  );
  assert.equal(manyRows.length, 205);
  assert.equal(manyRows[204].address, manyPools[204].address, "pool 205 remains globally discoverable");
  const globalPage = filterPoolPage(manyRows, { ...DEFAULT_POOL_DISCOVERY_STATE, page: 10 }, null, 10);
  assert.equal(globalPage.filteredCount, 205);
  assert.equal(globalPage.pageCount, 21);
  assert.equal(globalPage.rows[0].address, manyPools[104].address, "global sorting and pagination reach beyond pool 100");
  const searchedTail = filterPoolPage(manyRows, {
    ...DEFAULT_POOL_DISCOVERY_STATE,
    query: manyPools[204].address
  }, null, 10);
  assert.deepEqual(searchedTail.rows.map((candidate) => candidate.address), [manyPools[204].address]);
  const analyticsRow = discoveryFixture();
  const page = { rows: [analyticsRow], status: "READY", error: null };
  const [row] = buildPoolDiscoveryRows([poolRow], page, "https://analytics.test/graphql");
  assert.equal(row.baseToken.symbol, "WETH");
  assert.equal(row.quoteToken.symbol, "USDC");
  assert.equal(row.baseToken.logo.kind, "provider");
  assert.match(row.baseToken.logo.src, /^https:\/\/analytics\.test\/token-images\//);
  assert.equal(row.marketCap.display, "$1M");
  assert.equal(row.tvl.display, "$100K");
  assert.equal(row.priceChange24hPct, "+10%");
  assert.equal(row.trend.points.length, 2);

  const [isolated] = buildPoolDiscoveryRows([poolRow], {
    rows: [{ ...analyticsRow, tokenX: pair }],
    status: "READY",
    error: null
  }, "https://analytics.test/graphql");
  assert.equal(isolated.analyticsStatus, "PARTIAL");
  assert.equal(isolated.marketCap.display, "-");
  assert.match(isolated.analyticsIssue, /identity/);

  const [missingChainIdentity] = buildPoolDiscoveryRows([poolRow], {
    rows: [{ ...analyticsRow, chainId: null }],
    status: "READY",
    error: null
  }, "https://analytics.test/graphql");
  assert.equal(missingChainIdentity.analyticsStatus, "PARTIAL");
  assert.equal(missingChainIdentity.marketCap.display, "-");
  assert.match(missingChainIdentity.analyticsIssue, /identity/);

  const inconsistentPoolChain = {
    ...poolRow,
    tokenY: { ...poolRow.tokenY, chainId: 1 }
  };
  const [inconsistentChainIdentity] = buildPoolDiscoveryRows([inconsistentPoolChain], page, "https://analytics.test/graphql");
  assert.equal(inconsistentChainIdentity.analyticsStatus, "PARTIAL");
  assert.equal(inconsistentChainIdentity.marketCap.display, "-");
  assert.match(inconsistentChainIdentity.analyticsIssue, /identity/);

  console.log("Pool discovery model fixture passed: all-pool ordering, exact chain identity, orientation, inversion, sparklines, formatting, logo precedence, and isolated joins.");
} finally {
  await server.close();
}

function poolFixture(pairAddress = pair) {
  return {
    id: pairAddress,
    address: pairAddress,
    tokenXAddress: tokenX,
    tokenYAddress: tokenY,
    tokenX: { address: tokenX, chainId: 31_337, symbol: "WETH", name: "Wrapped Ether", logoURI: "", tags: [] },
    tokenY: { address: tokenY, chainId: 31_337, symbol: "USDC", name: "USD Coin", logoURI: "/token-assets/usdc.svg", tags: ["quote", "stablecoin"] },
    activeId: "8388608",
    binStep: "10",
    reserveX: "1",
    reserveY: "1",
    swapCount: "1",
    depositCount: "1",
    updatedAtBlock: "1"
  };
}

function discoveryFixture(pairAddress = pair, valueOffset = 0) {
  return {
    pair: pairAddress,
    chainId: 31_337,
    tokenX,
    tokenY,
    displayBaseToken: tokenX,
    displayQuoteToken: tokenY,
    poolPriceQuotePerBaseE18: (160n * E18).toString(),
    hourlyCloses: [
      hourlyClose(0, 100n * E18),
      hourlyClose(3_600, 110n * E18)
    ],
    priceChange24hE18: (E18 / 10n).toString(),
    tvlUsdE18: (100_000n * E18).toString(),
    lpFees24hUsdE18: (1_000n * E18).toString(),
    volume24hUsdE18: ((500_000n + BigInt(valueOffset)) * E18).toString(),
    status: "READY",
    missingPriceTokens: [],
    asOfBlock: "100",
    asOfBlockHash: `0x${"1".repeat(64)}`,
    asOfTimestamp: 7_200,
    marketMetadata: {
      marketCapUsdE18: (1_000_000n * E18).toString(),
      source: "dex-screener",
      fetchedAt: 7_200,
      logoPath: `/token-images/${"a".repeat(64)}`,
      logoSource: "dex-screener"
    }
  };
}

function address(value) {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function hourlyClose(startTimestamp, closeUsdE18) {
  return {
    startTimestamp,
    closeUsdE18: closeUsdE18.toString(),
    quoteToken: tokenY,
    finalized: true,
    revision: 1,
    priceSource: "active-bin-quote-usd",
    firstBlockHash: `0x${"2".repeat(64)}`,
    lastBlockHash: `0x${"3".repeat(64)}`
  };
}
