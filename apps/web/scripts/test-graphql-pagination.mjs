import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const indexerUrl = "https://indexer.example.test/graphql";
const rpcUrl = "https://rpc.example.test";
const factoryAddress = "0x1111111111111111111111111111111111111111";
const pairAddress = "0x2222222222222222222222222222222222222222";
const ownerAddress = "0x3333333333333333333333333333333333333333";
const otherOwnerAddress = "0x3333333333333333333333333333333333333334";
const otherPairAddress = "0x2222222222222222222222222222222222222223";
const recipientAddress = "0x3333333333333333333333333333333333333335";
const routerAddress = "0x3333333333333333333333333333333333333336";
const zeroAddress = "0x0000000000000000000000000000000000000000";
const tokenXAddress = "0x4444444444444444444444444444444444444444";
const tokenYAddress = "0x5555555555555555555555555555555555555555";
const pinnedBlockHash = `0x${"99".repeat(32)}`;

const fixtures = {
  bins: range(501, (index) => ({
    id: `bin-${index}`,
    binId: String(8_388_000 + index),
    reserveX: String(1_000 + index),
    reserveY: String(2_000 + index),
    totalSupply: String(3_000 + index),
    updatedAtBlock: String(10_000 + index)
  })),
  pairs: range(205, (index) => ({
    id: `pair-${index}`,
    address: addressFromIndex(0x6000 + index),
    tokenX: { address: tokenXAddress },
    tokenY: { address: tokenYAddress },
    activeId: String(8_388_608 + index),
    binStep: "10",
    factory: { id: factoryAddress.toLowerCase() },
    hooksParameters: `0x${"0".repeat(64)}`,
    ignoredForRouting: false,
    reserveX: "1000000000000000000",
    reserveY: "2000000000000000000",
    totalVolumeX: "3000000000000000000",
    totalVolumeY: "4000000000000000000",
    totalFeesX: "1000000000000000",
    totalFeesY: "2000000000000000",
    swapCount: String(index),
    depositCount: String(index + 1),
    updatedAtBlock: String(10_000 - index)
  })),
  swaps: range(501, (index) => ({
    id: `swap-${index}`,
    transactionHash: addressFromIndex(0x7000 + index),
    blockNumber: String(20_000 - index * 2),
    timestamp: String(1_800_000_000 - index),
    amountInX: index % 2 === 0 ? "100" : "0",
    amountInY: index % 2 === 0 ? "0" : "100",
    amountOutX: index % 2 === 0 ? "0" : "99",
    amountOutY: index % 2 === 0 ? "99" : "0",
    pair: { id: pairAddress },
    transactionFrom: index === 0 ? recipientAddress : ownerAddress,
    sender: index === 0 ? routerAddress : ownerAddress,
    to: index === 0 ? routerAddress : ownerAddress
  })),
  liquidityEvents: range(116, (index) => ({
    id: `liquidity-${index}`,
    type: index % 2 === 0 ? "Deposit" : "Withdraw",
    transactionHash: addressFromIndex(0x8000 + index),
    blockNumber: String(19_999 - index * 2),
    timestamp: String(1_800_000_000 - index),
    amountX: "100",
    amountY: "200",
    pair: { id: pairAddress },
    sender: ownerAddress,
    to: index === 0 ? recipientAddress : ownerAddress
  })),
  positionHistoryLiquidity: [
    historyLiquidityFixture("history-deposit", "DEPOSIT", 0x8801, "41", ["101", "100"], "100", "200", ownerAddress),
    historyLiquidityFixture("history-withdraw", "WITHDRAW", 0x8802, "42", ["102"], "10", "20", routerAddress)
  ],
  positionHistoryTransfers: [
    historyTransferFixture("history-mint", 0x8801, "41", zeroAddress, ownerAddress, ["100", "101"]),
    historyTransferFixture("history-same-tx-transfer", 0x8801, "41", ownerAddress, recipientAddress, ["101", "100"]),
    historyTransferFixture("history-burn", 0x8802, "42", ownerAddress, zeroAddress, ["102"])
  ],
  positions: range(215, (index) => positionFixture(index)),
  ownerPositions: range(501, (index) => positionFixture(index + 1000))
};
let failSwapsAtSkip = null;
let failPositionHistoryAtSkip = null;
let failPositionLiquidityDetails = false;
let forcePoolActivityPair = null;
let forceSummaryGraphError = false;
let hasIndexingErrors = false;
let rpcBlockNumber = 123_460n;
let rpcChainId = 4_663;
let hangQuery = null;
let hangAtSkip = null;
let abortedGraphRequests = 0;
const pinnedOwnerPositionBlocks = [];

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  logLevel: "error",
  server: { middlewareMode: true }
});

try {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  const {
    GRAPHQL_ACTIVITY_RENDER_LIMIT,
    GRAPHQL_MAX_PAGES,
    GRAPHQL_PAGE_SIZE,
    POOL_ACTIVITY_LIMIT,
    loadAppSnapshot,
    loadPaginatedBinsForPair,
    loadPaginatedPositionsForOwnerPair,
    loadPaginatedPositionsForOwnerPairAtBlock,
    loadPoolActivity,
    loadPoolBinWindow,
    loadPoolIndexerSnapshot,
    loadPositionHistory,
    selectWalletPortfolioPosition
  } =
    await server.ssrLoadModule("/src/data.ts");

  const snapshot = await loadAppSnapshot(registry());
  assert.equal(snapshot.indexer.pools.length, fixtures.pairs.length);
  assert.equal(snapshot.indexer.pools[0]?.tokenXAddress, tokenXAddress);
  assert.equal(snapshot.indexer.pools[0]?.tokenYAddress, tokenYAddress);
  assert.equal(snapshot.indexer.pools[0]?.factoryAddress, factoryAddress);
  assert.equal(snapshot.indexer.pools[0]?.hooksParameters, `0x${"0".repeat(64)}`);
  assert.equal(snapshot.indexer.pools.at(-1)?.tokenXAddress, tokenXAddress);
  assert.equal(snapshot.indexer.pools.at(-1)?.tokenYAddress, tokenYAddress);
  assert.equal(snapshot.indexer.positions.length, fixtures.positions.length);
  assert.equal(snapshot.indexer.activity.length, GRAPHQL_ACTIVITY_RENDER_LIMIT);
  assert.equal(snapshot.indexer.pagination.pools.loadedCount, fixtures.pairs.length);
  assert.equal(snapshot.indexer.pagination.swaps.loadedCount, GRAPHQL_ACTIVITY_RENDER_LIMIT);
  assert.equal(snapshot.indexer.pagination.liquidityEvents.loadedCount, GRAPHQL_ACTIVITY_RENDER_LIMIT);
  assert.equal(snapshot.indexer.pagination.positions.loadedCount, fixtures.positions.length);
  assert.equal(snapshot.indexer.pagination.pools.capped, false);
  assert.equal(snapshot.indexer.pagination.swaps.capped, false);
  assert.equal(snapshot.indexer.pagination.swaps.windowed, true);
  assert.equal(snapshot.indexer.pagination.liquidityEvents.windowed, true);
  assert.equal(snapshot.indexer.status, "ready");
  assert.equal(snapshot.indexer.message, null);

  const indexerSnapshot = await loadPoolIndexerSnapshot(registry(), snapshot.indexer.pools[0]);
  assert.equal(indexerSnapshot.blockNumber, 123_456n);
  assert.equal(indexerSnapshot.blockHash, pinnedBlockHash);
  assert.equal(indexerSnapshot.activeId, 8_388_608n);

  const ownerPositions = await loadPaginatedPositionsForOwnerPair(registry(), ownerAddress, pairAddress);
  assert.equal(ownerPositions.rows.length, GRAPHQL_PAGE_SIZE * GRAPHQL_MAX_PAGES);
  assert.equal(ownerPositions.pageInfo.capped, true);
  assert.equal(ownerPositions.rows.at(-1)?.binId, "1499");

  const pinnedOwnerPositions = await loadPaginatedPositionsForOwnerPairAtBlock(
    registry(),
    ownerAddress,
    pairAddress,
    123_456n
  );
  assert.equal(pinnedOwnerPositions.rows.length, GRAPHQL_PAGE_SIZE * GRAPHQL_MAX_PAGES);
  assert.deepEqual(pinnedOwnerPositionBlocks, Array(GRAPHQL_MAX_PAGES).fill(123_456));

  const originalOwnerPositions = fixtures.ownerPositions;
  fixtures.ownerPositions = [positionFixture(1), positionFixture(2)];
  fixtures.ownerPositions[0].owner = otherOwnerAddress;
  await assert.rejects(
    () => loadPaginatedPositionsForOwnerPair(registry(), ownerAddress, pairAddress),
    /another owner/
  );
  fixtures.ownerPositions = [positionFixture(1), positionFixture(2)];
  fixtures.ownerPositions[0].pair.id = otherPairAddress;
  await assert.rejects(
    () => loadPaginatedPositionsForOwnerPair(registry(), ownerAddress, pairAddress),
    /another pair/
  );
  fixtures.ownerPositions = [positionFixture(1), positionFixture(2)];
  fixtures.ownerPositions[1].id = fixtures.ownerPositions[0].id;
  await assert.rejects(
    () => loadPaginatedPositionsForOwnerPair(registry(), ownerAddress, pairAddress),
    /duplicate position id/
  );
  fixtures.ownerPositions = [positionFixture(1), positionFixture(2)];
  fixtures.ownerPositions[1].bin.binId = fixtures.ownerPositions[0].bin.binId;
  await assert.rejects(
    () => loadPaginatedPositionsForOwnerPairAtBlock(registry(), ownerAddress, pairAddress, 123_456n),
    /duplicate position bin/
  );
  fixtures.ownerPositions = originalOwnerPositions;

  const selectedPortfolio = selectWalletPortfolioPosition(
    walletPortfolioPage([
      portfolioPosition(ownerAddress, otherPairAddress),
      portfolioPosition(ownerAddress, pairAddress)
    ]),
    ownerAddress,
    pairAddress
  );
  assert.equal(selectedPortfolio?.pair, pairAddress);
  assert.equal(selectWalletPortfolioPosition(walletPortfolioPage([portfolioPosition(ownerAddress, otherPairAddress)]), ownerAddress, pairAddress), null);
  assert.throws(
    () => selectWalletPortfolioPosition(
      walletPortfolioPage([portfolioPosition(ownerAddress, otherPairAddress), portfolioPosition(otherOwnerAddress, pairAddress)]),
      ownerAddress,
      pairAddress
    ),
    /another owner/
  );
  assert.throws(
    () => selectWalletPortfolioPosition(
      walletPortfolioPage([portfolioPosition(ownerAddress, pairAddress), portfolioPosition(ownerAddress, pairAddress)]),
      ownerAddress,
      pairAddress
    ),
    /duplicate positions/
  );

  const routerHistory = await loadPositionHistory(registry(), ownerAddress, pairAddress);
  assert.equal(routerHistory.pageInfo.failed, false);
  assert.equal(routerHistory.pageInfo.capped, false);
  assert.deepEqual(routerHistory.rows.map((row) => row.type), ["WITHDRAW", "DEPOSIT", "TRANSFER_OUT"]);
  assert.deepEqual(routerHistory.rows.find((row) => row.type === "WITHDRAW")?.amountX, "10");
  assert.deepEqual(routerHistory.rows.find((row) => row.type === "DEPOSIT")?.amountY, "200");

  const originalHistoryLiquidity = fixtures.positionHistoryLiquidity;
  const originalHistoryTransfers = fixtures.positionHistoryTransfers;
  const ambiguousTransactionIndex = 0x8890;
  const ambiguousTransactionHash = addressFromIndex(ambiguousTransactionIndex);
  fixtures.positionHistoryLiquidity = [
    historyLiquidityFixture(`${ambiguousTransactionHash}-7`, "DEPOSIT", ambiguousTransactionIndex, "45", ["104"], "111", "222", ownerAddress),
    historyLiquidityFixture(`${ambiguousTransactionHash}-9`, "DEPOSIT", ambiguousTransactionIndex, "45", ["104"], "333", "444", ownerAddress)
  ];
  fixtures.positionHistoryTransfers = [
    historyTransferFixture(`${ambiguousTransactionHash}-5`, ambiguousTransactionIndex, "45", zeroAddress, ownerAddress, ["104"])
  ];
  const ambiguousHistory = await loadPositionHistory(registry(), ownerAddress, pairAddress);
  assert.equal(ambiguousHistory.pageInfo.failed, true);
  assert.match(ambiguousHistory.pageInfo.error ?? "", /ambiguous liquidity details/i);
  assert.equal(ambiguousHistory.rows[0]?.amountX, null);

  fixtures.positionHistoryLiquidity[0] = historyLiquidityFixture(
    `${ambiguousTransactionHash}-6`,
    "DEPOSIT",
    ambiguousTransactionIndex,
    "45",
    ["104"],
    "111",
    "222",
    ownerAddress
  );
  const adjacentHistory = await loadPositionHistory(registry(), ownerAddress, pairAddress);
  assert.equal(adjacentHistory.pageInfo.failed, false);
  assert.equal(adjacentHistory.rows[0]?.amountX, "111");

  fixtures.positionHistoryLiquidity = originalHistoryLiquidity;
  fixtures.positionHistoryTransfers = originalHistoryTransfers;

  failPositionLiquidityDetails = true;
  const partialRouterHistory = await loadPositionHistory(registry(), ownerAddress, pairAddress);
  assert.equal(partialRouterHistory.pageInfo.failed, true);
  assert.match(partialRouterHistory.pageInfo.error ?? "", /liquidity details/i);
  assert.deepEqual(partialRouterHistory.rows.map((row) => row.type), ["WITHDRAW", "DEPOSIT", "TRANSFER_OUT"]);
  assert.equal(partialRouterHistory.rows.find((row) => row.type === "WITHDRAW")?.amountX, null);
  failPositionLiquidityDetails = false;

  fixtures.positionHistoryLiquidity = range(101, (index) =>
    historyLiquidityFixture(`paged-liquidity-${index}`, "DEPOSIT", 0xa000 + index, String(1000 + index), [String(2000 + index)], "1", "2", ownerAddress)
  );
  fixtures.positionHistoryTransfers = range(101, (index) =>
    historyTransferFixture(`paged-transfer-${index}`, 0xa000 + index, String(1000 + index), zeroAddress, ownerAddress, [String(2000 + index)])
  );
  const pagedHistory = await loadPositionHistory(registry(), ownerAddress, pairAddress);
  assert.equal(pagedHistory.rows.length, 101);
  assert.equal(pagedHistory.pageInfo.failed, false);
  assert.equal(pagedHistory.pageInfo.capped, false);
  assert(pagedHistory.rows.every((row) => row.type === "DEPOSIT" && row.amountX === "1"));

  failPositionHistoryAtSkip = GRAPHQL_PAGE_SIZE;
  const partialPagedHistory = await loadPositionHistory(registry(), ownerAddress, pairAddress);
  assert.equal(partialPagedHistory.rows.length, GRAPHQL_PAGE_SIZE);
  assert.equal(partialPagedHistory.pageInfo.failed, true);
  assert.match(partialPagedHistory.pageInfo.error ?? "", /history page failed/i);
  failPositionHistoryAtSkip = null;

  fixtures.positionHistoryLiquidity = range(GRAPHQL_PAGE_SIZE * GRAPHQL_MAX_PAGES, (index) =>
    historyLiquidityFixture(`capped-liquidity-${index}`, "DEPOSIT", 0xb000 + index, String(2000 + index), [String(3000 + index)], "1", "2", ownerAddress)
  );
  fixtures.positionHistoryTransfers = range(GRAPHQL_PAGE_SIZE * GRAPHQL_MAX_PAGES, (index) =>
    historyTransferFixture(`capped-transfer-${index}`, 0xb000 + index, String(2000 + index), zeroAddress, ownerAddress, [String(3000 + index)])
  );
  const cappedHistory = await loadPositionHistory(registry(), ownerAddress, pairAddress);
  assert.equal(cappedHistory.rows.length, GRAPHQL_PAGE_SIZE * GRAPHQL_MAX_PAGES);
  assert.equal(cappedHistory.pageInfo.capped, true);
  assert.equal(cappedHistory.pageInfo.failed, false);
  fixtures.positionHistoryLiquidity = originalHistoryLiquidity;
  fixtures.positionHistoryTransfers = originalHistoryTransfers;

  const poolActivity = await loadPoolActivity(registry(), pairAddress);
  assert.equal(poolActivity.rows.length, POOL_ACTIVITY_LIMIT);
  assert.equal(poolActivity.pageInfo.windowed, true);
  assert(poolActivity.rows.every((row) => row.pair.toLowerCase() === pairAddress));
  const recipientActivity = await loadPoolActivity(registry(), pairAddress, recipientAddress);
  assert.equal(recipientActivity.rows.length, 2);
  assert(recipientActivity.rows.every((row) => row.id.endsWith("-0")));
  assert.equal(recipientActivity.rows.find((row) => row.type === "Swap")?.account, recipientAddress);
  const originalSwaps = fixtures.swaps;
  const originalLiquidityEvents = fixtures.liquidityEvents;
  fixtures.swaps = [];
  fixtures.liquidityEvents = [];
  const routerOwnerActivity = await loadPoolActivity(registry(), pairAddress, ownerAddress);
  assert.equal(routerOwnerActivity.rows.find((row) => row.id === "history-withdraw")?.type, "WITHDRAW");
  assert.equal(routerOwnerActivity.rows.find((row) => row.id === "history-withdraw")?.amountX, "10");
  fixtures.swaps = originalSwaps;
  fixtures.liquidityEvents = originalLiquidityEvents;
  forcePoolActivityPair = otherPairAddress;
  await assert.rejects(() => loadPoolActivity(registry(), pairAddress), /another pair/);
  forcePoolActivityPair = null;

  const pairBins = await loadPaginatedBinsForPair(registry(), pairAddress);
  assert.equal(pairBins.rows.length, GRAPHQL_PAGE_SIZE * GRAPHQL_MAX_PAGES);
  assert.equal(pairBins.pageInfo.capped, true);
  assert.equal(pairBins.rows.at(-1)?.binId, String(8_388_000 + GRAPHQL_PAGE_SIZE * GRAPHQL_MAX_PAGES - 1));

  const binWindow = await loadPoolBinWindow(registry(), pairAddress, {
    activeId: 8_388_250n,
    binStep: 10n,
    blockHash: pinnedBlockHash,
    blockNumber: 123_456n,
    factory: factoryAddress,
    tokenX: tokenXAddress,
    tokenY: tokenYAddress
  }, 40);
  assert.equal(binWindow.length, 81);
  assert.equal(binWindow[0]?.binId, "8388210");
  assert.equal(binWindow.at(-1)?.binId, "8388290");

  failSwapsAtSkip = 100;
  const boundedActivitySnapshot = await loadAppSnapshot(registry());
  assert.equal(boundedActivitySnapshot.indexer.status, "ready");
  assert.equal(boundedActivitySnapshot.indexer.pagination.swaps.failed, false);
  assert.equal(boundedActivitySnapshot.indexer.pagination.swaps.loadedCount, GRAPHQL_ACTIVITY_RENDER_LIMIT);
  assert.equal(boundedActivitySnapshot.indexer.pagination.swaps.windowed, true);
  assert.equal(boundedActivitySnapshot.indexer.message, null);

  failSwapsAtSkip = null;
  rpcChainId = 46_630;
  const wrongRpcSnapshot = await loadAppSnapshot(registry());
  assert.equal(wrongRpcSnapshot.runtime.status, "error");
  assert.equal(wrongRpcSnapshot.runtime.chainId, 46_630);
  assert.match(wrongRpcSnapshot.runtime.message ?? "", /expected 4663, received 46630/);

  rpcChainId = 4_663;
  rpcBlockNumber = 123_476n;
  const mainnetCeilingSnapshot = await loadAppSnapshot(registry());
  assert.equal(mainnetCeilingSnapshot.indexer.status, "ready");

  rpcBlockNumber = 123_477n;
  const staleMainnetSnapshot = await loadAppSnapshot(registry());
  assert.equal(staleMainnetSnapshot.indexer.status, "stale");
  assert.match(staleMainnetSnapshot.indexer.message ?? "", /Indexer stale by 21 blocks/);

  rpcBlockNumber = 123_476n;
  const localnetCeilingSnapshot = await loadAppSnapshot(registry("localnet"));
  assert.equal(localnetCeilingSnapshot.indexer.status, "ready");

  rpcBlockNumber = 123_477n;
  const staleLocalnetSnapshot = await loadAppSnapshot(registry("localnet"));
  assert.equal(staleLocalnetSnapshot.indexer.status, "stale");
  assert.match(staleLocalnetSnapshot.indexer.message ?? "", /Indexer stale by 21 blocks/);

  rpcBlockNumber = 123_756n;
  const testnetCeilingSnapshot = await loadAppSnapshot(registry("robinhoodTestnet"));
  assert.equal(testnetCeilingSnapshot.indexer.status, "ready");

  rpcBlockNumber = 123_757n;
  const staleTestnetSnapshot = await loadAppSnapshot(registry("robinhoodTestnet"));
  assert.equal(staleTestnetSnapshot.indexer.status, "stale");
  assert.match(staleTestnetSnapshot.indexer.message ?? "", /Indexer stale by 301 blocks/);

  hasIndexingErrors = true;
  const laggedTestnetErrorSnapshot = await loadAppSnapshot(registry("robinhoodTestnet"));
  assert.equal(laggedTestnetErrorSnapshot.indexer.status, "stale");
  assert.match(laggedTestnetErrorSnapshot.indexer.message ?? "", /indexing errors/i);
  assert.match(laggedTestnetErrorSnapshot.indexer.message ?? "", /Indexer stale by 301 blocks/);
  hasIndexingErrors = false;

  rpcBlockNumber = 123_460n;
  const unavailableSnapshot = await loadAppSnapshot({
    ...registry(),
    endpoints: {
      ...registry().endpoints,
      indexerUrl: null
    }
  });
  assert.equal(unavailableSnapshot.indexer.status, "unavailable");
  assert.match(unavailableSnapshot.indexer.message ?? "", /Indexer endpoint is not configured/);

  const originalPairs = fixtures.pairs;
  fixtures.pairs = [];
  const emptySnapshot = await loadAppSnapshot(registry());
  assert.equal(emptySnapshot.indexer.status, "empty");
  assert.equal(emptySnapshot.indexer.pools.length, 0);
  assert.equal(emptySnapshot.indexer.pairCount, "0");
  fixtures.pairs = originalPairs;

  hasIndexingErrors = true;
  const indexingErrorSnapshot = await loadAppSnapshot(registry());
  assert.equal(indexingErrorSnapshot.indexer.status, "error");
  assert.equal(indexingErrorSnapshot.indexer.hasIndexingErrors, true);
  assert.match(indexingErrorSnapshot.indexer.message ?? "", /indexing errors/i);
  hasIndexingErrors = false;

  forceSummaryGraphError = true;
  const graphErrorSnapshot = await loadAppSnapshot(registry());
  assert.equal(graphErrorSnapshot.indexer.status, "error");
  assert.match(graphErrorSnapshot.indexer.message ?? "", /synthetic summary error/);
  forceSummaryGraphError = false;

  hangQuery = "PairsPage";
  hangAtSkip = 0;
  const firstPageTimeoutSnapshot = await loadAppSnapshot(registry(), { graphqlTimeoutMs: 25 });
  assert.equal(firstPageTimeoutSnapshot.indexer.status, "error");
  assert.match(firstPageTimeoutSnapshot.indexer.message ?? "", /timed out after 25ms/);
  assert.equal(abortedGraphRequests > 0, true);

  hangQuery = "SwapsPage";
  hangAtSkip = 100;
  const abortedBeforeBoundedActivity = abortedGraphRequests;
  const boundedActivityTimeoutSnapshot = await loadAppSnapshot(registry(), { graphqlTimeoutMs: 25 });
  assert.equal(boundedActivityTimeoutSnapshot.indexer.status, "ready");
  assert.equal(boundedActivityTimeoutSnapshot.indexer.pagination.swaps.failed, false);
  assert.equal(boundedActivityTimeoutSnapshot.indexer.pagination.swaps.windowed, true);
  assert.equal(abortedGraphRequests, abortedBeforeBoundedActivity);

  hangQuery = null;
  hangAtSkip = null;
  const recoveredSnapshot = await loadAppSnapshot(registry(), { graphqlTimeoutMs: 25 });
  assert.equal(recoveredSnapshot.indexer.status, "ready");
  assert.equal(recoveredSnapshot.indexer.pagination.swaps.failed, false);

  globalThis.fetch = originalFetch;
  console.log(
    `Pagination fixture passed: ${snapshot.indexer.pools.length} pools, latest ${snapshot.indexer.activity.length} rendered events, ${snapshot.indexer.positions.length} dashboard positions, ${ownerPositions.rows.length}+ owner positions, ${pairBins.rows.length}+ pair bins, bounded activity, unavailable/empty/error/stale indexer states.`
  );
} finally {
  await server.close();
}

function registry(environment = "robinhood") {
  return {
    chain: {
      id: 4663,
      name: "Fixture Chain",
      nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
      rpcUrls: { default: { http: [rpcUrl] } }
    },
    chainId: 4663,
    contracts: {
      lbFactory: factoryAddress,
      lbPairImplementation: addressFromIndex(0x9001),
      lbQuoter: addressFromIndex(0x9002),
      lbRouter: addressFromIndex(0x9003)
    },
    endpoints: {
      apiUrl: null,
      indexerUrl,
      rpcUrl,
      tokenListUrl: null
    },
    environment,
    ...(environment === "localnet"
      ? {
          seededPools: {
            wethUsdc: {
              activeId: 8_388_608,
              binStep: 10,
              pair: pairAddress,
              tokenX: tokenXAddress,
              tokenY: tokenYAddress
            }
          }
        }
      : {}),
    startBlock: 1,
    tokens: {
      WETH: token("weth", "WETH", tokenXAddress),
      USDG: token("usdg", "USDG", tokenYAddress)
    }
  };
}

async function mockFetch(url, init) {
  if (new URL(String(url)).origin === new URL(rpcUrl).origin) {
    const request = JSON.parse(String(init?.body));
    const method = Array.isArray(request) ? request[0]?.method : request.method;
    const id = Array.isArray(request) ? request[0]?.id : request.id;
    const result =
      method === "eth_chainId"
        ? `0x${rpcChainId.toString(16)}`
        : method === "eth_blockNumber"
          ? `0x${rpcBlockNumber.toString(16)}`
          : method === "eth_call"
            ? `0x${(8_388_608n).toString(16).padStart(64, "0")}`
            : "0x0";

    return jsonResponse({ id, jsonrpc: "2.0", result });
  }

  assert.equal(String(url), indexerUrl);
  const body = JSON.parse(String(init?.body));
  const query = String(body.query);
  const variables = body.variables ?? {};

  if (hangQuery !== null && query.includes(hangQuery) && Number(variables.skip ?? 0) >= Number(hangAtSkip ?? 0)) {
    return hangUntilAborted(init?.signal);
  }

  if (query.includes("DashboardSummary")) {
    if (forceSummaryGraphError) {
      return jsonResponse({
        errors: [{ message: "synthetic summary error" }]
      });
    }

    return jsonResponse({
      data: {
        _meta: { block: { number: 123_456, hash: addressFromIndex(0x9999) }, hasIndexingErrors },
        factory: { pairCount: String(fixtures.pairs.length) }
      }
    });
  }

  if (query.includes("PairsPage")) {
    return jsonResponse({ data: { pairs: page(fixtures.pairs, variables) } });
  }

  if (query.includes("PoolIndexerSnapshot")) {
    const selected = fixtures.pairs[0];
    return jsonResponse({
      data: {
        _meta: { block: { number: 123_456, hash: pinnedBlockHash }, hasIndexingErrors: false },
        pair: {
          id: String(variables.pairId).toLowerCase(),
          address: String(variables.pairId),
          activeId: selected.activeId,
          binStep: selected.binStep,
          factory: selected.factory,
          reserveX: selected.reserveX,
          reserveY: selected.reserveY,
          tokenX: selected.tokenX,
          tokenY: selected.tokenY,
          updatedAtBlock: selected.updatedAtBlock
        }
      }
    });
  }

  if (query.includes("PairBinWindow")) {
    assert.equal(String(variables.pair), pairAddress.toLowerCase());
    assert.equal(String(variables.pairId), pairAddress.toLowerCase());
    assert.equal(String(variables.blockHash), pinnedBlockHash);
    assert.equal(query.match(/block: \{ hash: \$blockHash \}/g)?.length, 3);
    const minBin = BigInt(variables.minBin);
    const maxBin = BigInt(variables.maxBin);
    const bins = fixtures.bins
      .filter((bin) => BigInt(bin.binId) >= minBin && BigInt(bin.binId) <= maxBin)
      .slice(0, Number(variables.first));
    return jsonResponse({
      data: {
        _meta: { block: { number: 123_456, hash: pinnedBlockHash }, hasIndexingErrors: false },
        pair: {
          id: pairAddress.toLowerCase(),
          address: pairAddress,
          activeId: "8388250",
          binStep: "10",
          factory: { id: factoryAddress.toLowerCase() },
          tokenX: { address: tokenXAddress },
          tokenY: { address: tokenYAddress }
        },
        bins
      }
    });
  }

  if (query.includes("PositionLiquidityDetails")) {
    if (failPositionLiquidityDetails) {
      return jsonResponse({ errors: [{ message: "Synthetic liquidity details failure" }] });
    }
    assert.match(query, /transactionHash_in:\s*\$transactionHashes/);
    const hashes = new Set((variables.transactionHashes ?? []).map((hash) => String(hash).toLowerCase()));
    const matching = fixtures.positionHistoryLiquidity.filter((event) => hashes.has(event.transactionHash.toLowerCase()));
    return jsonResponse({ data: { liquidityEvents: page(matching, variables) } });
  }

  if (query.includes("PositionLiquidityHistory")) {
    if (failPositionHistoryAtSkip !== null && Number(variables.skip) >= failPositionHistoryAtSkip) {
      return jsonResponse({ errors: [{ message: "Synthetic position history page failed" }] });
    }
    const requestedOwner = String(variables.owner).toLowerCase();
    assert.equal(String(variables.pair), pairAddress.toLowerCase());
    const matchingTransfers = fixtures.positionHistoryTransfers.filter((event) =>
      event.from.toLowerCase() === requestedOwner || event.to.toLowerCase() === requestedOwner
    );
    return jsonResponse({ data: { transferBatchEvents: page(matchingTransfers, variables) } });
  }

  if (query.includes("PoolActivity")) {
    assert.equal(String(variables.pair), pairAddress.toLowerCase());
    assert.equal(Number(variables.first), 101);
    const owner = variables.owner === undefined ? null : String(variables.owner).toLowerCase();
    if (owner !== null) assert.match(query, /transactionFrom/);
    const belongsToOwner = (event) => owner === null || event.transactionFrom?.toLowerCase() === owner || event.sender.toLowerCase() === owner || event.to.toLowerCase() === owner;
    const pair = forcePoolActivityPair ?? pairAddress;
    const swaps = fixtures.swaps.filter(belongsToOwner).slice(0, Number(variables.first)).map((event) => ({
      ...event,
      pair: { id: pair }
    }));
    const liquidityEvents = fixtures.liquidityEvents.filter(belongsToOwner).slice(0, Number(variables.first)).map((event) => ({
      ...event,
      pair: { id: pair }
    }));
    return jsonResponse({ data: { liquidityEvents, swaps } });
  }

  if (query.includes("PairBins")) {
    assert.equal(String(variables.pair), pairAddress.toLowerCase());
    return jsonResponse({ data: { bins: page(fixtures.bins, variables) } });
  }

  if (query.includes("SwapsPage")) {
    if (failSwapsAtSkip !== null && Number(variables.skip) >= failSwapsAtSkip) {
      throw new Error("synthetic swaps page failure");
    }

    return jsonResponse({ data: { swaps: page(fixtures.swaps, variables) } });
  }

  if (query.includes("LiquidityEventsPage")) {
    return jsonResponse({ data: { liquidityEvents: page(fixtures.liquidityEvents, variables) } });
  }

  if (query.includes("OwnerPairPositions")) {
    if (query.includes("OwnerPairPositionsAtBlock")) {
      pinnedOwnerPositionBlocks.push(Number(variables.blockNumber));
      assert.match(query, /block:\s*\{\s*number:\s*\$blockNumber\s*\}/);
    }
    return jsonResponse({ data: { positions: page(fixtures.ownerPositions, variables) } });
  }

  if (query.includes("PositionsPage")) {
    return jsonResponse({ data: { positions: page(fixtures.positions, variables) } });
  }

  throw new Error(`Unexpected GraphQL query: ${query}`);
}

function hangUntilAborted(signal) {
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error("GraphQL timeout request did not include an AbortSignal"));
      return;
    }

    const abort = () => {
      abortedGraphRequests += 1;
      reject(new DOMException("Synthetic GraphQL request aborted", "AbortError"));
    };

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener("abort", abort, { once: true });
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function page(values, variables) {
  const first = Number(variables.first);
  const skip = Number(variables.skip);

  return values.slice(skip, skip + first);
}

function positionFixture(index) {
  return {
    id: `position-${index}`,
    owner: ownerAddress,
    liquidity: String(1_000_000 + index),
    updatedAtBlock: String(30_000 - index),
    pair: { id: pairAddress },
    bin: { binId: String(index) }
  };
}

function historyLiquidityFixture(id, type, transactionIndex, blockNumber, ids, amountX, amountY, to) {
  return {
    id,
    type,
    transactionHash: addressFromIndex(transactionIndex),
    blockNumber,
    timestamp: String(1_800_000_000 + Number(blockNumber)),
    amountX,
    amountY,
    ids,
    pair: { id: pairAddress },
    sender: routerAddress,
    to
  };
}

function historyTransferFixture(id, transactionIndex, blockNumber, from, to, ids) {
  return {
    id,
    transactionHash: addressFromIndex(transactionIndex),
    blockNumber,
    timestamp: String(1_800_000_000 + Number(blockNumber)),
    sender: routerAddress,
    from,
    to,
    ids,
    pair: { id: pairAddress }
  };
}

function portfolioPosition(owner, pair) {
  return {
    owner,
    pair,
    bins: [],
    costBasisUsdE18: null,
    currentValueUsdE18: null,
    realizedPnlUsdE18: null,
    unrealizedPnlUsdE18: null,
    status: "UNAVAILABLE",
    missingPriceTokens: [],
    asOfBlock: null,
    asOfTimestamp: null
  };
}

function walletPortfolioPage(positions) {
  return {
    positions,
    pageInfo: { endCursor: null, hasNextPage: false, partial: false },
    health: { fresh: true, headBlock: "1", headHash: pinnedBlockHash, status: "READY" }
  };
}

function token(id, symbol, address) {
  return {
    address,
    chainId: 4663,
    decimals: 18,
    id,
    logoURI: `/token-assets/${id}.svg`,
    name: symbol,
    symbol,
    tags: []
  };
}

function addressFromIndex(index) {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

function range(length, create) {
  return Array.from({ length }, (_, index) => create(index));
}
