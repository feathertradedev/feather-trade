import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  createBlockSource,
  createPositionSnapshotProvider,
  decodePackedAmounts
} from "./analytics-adapters.mjs";

const PAIR = "0xbf57b75d71d91e13c97693e4e5b850b0be638dac";
const TOKEN_X = "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9";
const TOKEN_Y = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const OWNER = "0x3729a6a9ced02c9d0a86ec9834b28825b212abf3";
const RECIPIENT = "0xac76bb7bf95e0240c78ff9908fcb24e21f6e89ce";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"00".repeat(32)}`;
const HASH_0 = `0x${"10".repeat(32)}`;
const HASH_1 = `0x${"11".repeat(32)}`;
const HASH_2 = `0x${"12".repeat(32)}`;
const HASH_3 = `0x${"13".repeat(32)}`;
const HASH_3_REORG = `0x${"23".repeat(32)}`;
const HASH_4 = `0x${"14".repeat(32)}`;
const HASH_4_REORG = `0x${"24".repeat(32)}`;
const OTHER_HASH = `0x${"22".repeat(32)}`;
const TX_SWAP = `0x${"aa".repeat(32)}`;
const TX_DEPOSIT = `0x${"bb".repeat(32)}`;
const TX_TRANSFER = `0x${"cc".repeat(32)}`;
const GET_PRICE_FROM_ID_SELECTOR = "0x4c7cffbd";
const GET_BIN_SELECTOR = "0x0abe9688";
const TOTAL_SUPPLY_SELECTOR = "0xbd85b039";
const GET_STATIC_FEE_PARAMETERS_SELECTOR = "0x7ca0de30";
const GET_VARIABLE_FEE_PARAMETERS_SELECTOR = "0x8d7024e5";
const CENTER = 8_388_609;
const Q128 = 1n << 128n;

test("local analytics adapters emit canonical identities and absolute exact-block pool observations", async () => {
  const state = fixtureState();
  const rpcServer = createServer((request, response) => void handleJson(request, response, (payload) => rpc(payload, state)));
  const graphServer = createServer((request, response) => void handleJson(request, response, (payload) => graph(payload, state)));
  await Promise.all([listen(rpcServer), listen(graphServer)]);

  const options = {
    rpcUrl: endpoint(rpcServer),
    indexerUrl: endpoint(graphServer),
    pageSize: 10,
    pollIntervalMs: 1,
    syncTimeoutMs: 25
  };

  try {
    const source = await createBlockSource(options);
    const firstPage = await source.fetchPage(null);
    assert.equal(firstPage.hasMore, false);
    assert.equal(firstPage.nextCursor, "2");
    assert.deepEqual(firstPage.canonicalHead, { number: 1n, hash: HASH_1, timestamp: 101 });
    assert.deepEqual(firstPage.blocks.map((block) => block.number), [0n, 1n]);
    const block = firstPage.blocks[1];
    assert.equal(block.chainId, 31_337);
    assert.equal(block.hash, HASH_1);
    assert.equal(block.parentHash, HASH_0);
    assert.deepEqual(block.prices.map((price) => price.token), [TOKEN_X, TOKEN_Y]);
    assert(block.prices.every((price) =>
      price.source === "fixed-test" &&
      price.priceUsdE18 === 1_000_000_000_000_000_000n &&
      price.confidenceUsdE18 === 0n &&
      price.sequence === 1n &&
      price.signedReport === null
    ));

    const swap = block.events.find((event) => event.kind === "swap");
    assert.equal(swap.source.eventId, `${TX_SWAP}-2`);
    assert.equal(swap.source.transactionHash, TX_SWAP);
    assert.equal(swap.source.logIndex, 2);
    assert.equal(swap.source.sequence, 0);
    assert.equal(swap.source.kind, "log");
    assert.equal(swap.activeId, CENTER);
    assert.equal(swap.marketPriceQuoteE18, 1_000_000_000_000_000_000n);
    assert.equal(swap.reserveX, 1_005n);
    assert.equal(swap.reserveY, 1_993n);

    const deposit = block.events.find((event) => event.kind === "deposit");
    assert.equal(deposit.owner, OWNER);
    assert.equal(deposit.source.eventId, `${TX_DEPOSIT}-4`);
    assert.equal(deposit.source.logIndex, 4);
    assert.equal(deposit.source.sequence, 1);
    assert.deepEqual(deposit.bins, [{
      binId: String(CENTER),
      liquidityDelta: 100n,
      amountX: 5n,
      amountY: 7n
    }]);

    const transfer = block.events.find((event) => event.kind === "position-transfer");
    assert.equal(transfer.from, OWNER);
    assert.equal(transfer.to, RECIPIENT);
    assert.equal(transfer.source.eventId, `${TX_TRANSFER}-6`);
    assert.equal(transfer.source.sequence, 2);
    assert.deepEqual(transfer.bins, [{ binId: String(CENTER), liquidity: 20n }]);

    const snapshot = block.events.at(-1);
    assert.equal(snapshot.kind, "pair-snapshot");
    assert.deepEqual(snapshot.source, {
      eventId: `${HASH_1}:${PAIR}:pool`,
      transactionHash: null,
      logIndex: null,
      sequence: 3,
      kind: "block-snapshot"
    });
    assert.equal(snapshot.poolState.replaceBinWindow, true);
    assert.deepEqual(snapshot.poolState.sourceEventIds, [
      `${TX_SWAP}-2`,
      `${TX_DEPOSIT}-4`,
      `${HASH_1}:${PAIR}:pool`
    ]);
    assert.equal(snapshot.poolState.binUpdates.length, 81);
    assert.deepEqual(snapshot.poolState.binUpdates.map((bin) => Number(bin.binId)),
      Array.from({ length: 81 }, (_, index) => CENTER - 40 + index));
    assert.deepEqual(snapshot.poolState.binUpdates[40], absoluteBin(CENTER, 1));
    assert.deepEqual(snapshot.poolState.feeState, feeState(1));
    assertExactPoolReads(state.calls, 1, 81);

    const provider = await createPositionSnapshotProvider(options);
    const positions = await provider.load(OWNER, { number: 1n, hash: HASH_1, timestamp: 101 });
    assert.equal(positions.length, 1);
    assert.equal(positions[0].pair, PAIR);
    assert.equal(positions[0].owner, OWNER);
    assert.equal(positions[0].source.kind, "block-snapshot");
    assert.equal(positions[0].source.eventId, `${HASH_1}:${PAIR}:${OWNER}:position`);
    assert.deepEqual(positions[0].bins, [{
      binId: String(CENTER),
      liquidity: 40n,
      amountX: 20n,
      amountY: 40n
    }]);
    await assert.rejects(
      () => provider.load(OWNER, { number: 1n, hash: OTHER_HASH, timestamp: 101 }),
      /Canonical head 1 changed/
    );
    assert.deepEqual(decodePackedAmounts(pack(9n, 13n)), { amountX: 9n, amountY: 13n });

    state.head = 2;
    const callsBeforeIncremental = state.calls.length;
    const secondPage = await source.fetchPage("2");
    assert.deepEqual(secondPage.blocks.map((entry) => entry.number), [2n]);
    const secondSnapshot = secondPage.blocks[0].events.at(-1);
    assert.equal(secondSnapshot.activeId, CENTER + 1);
    assert.equal(secondSnapshot.poolState.replaceBinWindow, false);
    assert.deepEqual(secondSnapshot.poolState.binUpdates.map((bin) => Number(bin.binId)), [
      CENTER - 2,
      CENTER,
      CENTER + 1,
      CENTER + 41
    ]);
    assert.deepEqual(secondSnapshot.poolState.sourceEventIds, [`${TX_SWAP}-12`, `${TX_DEPOSIT}-14`]);
    assertExactPoolReads(state.calls.slice(callsBeforeIncremental), 2, 4);

    const callsBeforeDuplicate = state.calls.length;
    const duplicatePage = await source.fetchPage("2");
    assert.deepEqual(duplicatePage.blocks, secondPage.blocks);
    assert.equal(state.calls.slice(callsBeforeDuplicate).filter(isPoolStateCall).length, 0);

    state.head = 3;
    const crossingPage = await source.fetchPage("3");
    const crossingSnapshot = crossingPage.blocks[0].events.at(-1);
    assert.equal(crossingSnapshot.activeId, CENTER + 100);
    assert.equal(crossingSnapshot.poolState.replaceBinWindow, true);
    assert.equal(crossingSnapshot.poolState.binUpdates.length, 81);
    assert.equal(Number(crossingSnapshot.poolState.binUpdates[0].binId), CENTER + 60);
    assert.equal(Number(crossingSnapshot.poolState.binUpdates.at(-1).binId), CENTER + 140);

    const restartedSameBranch = await createBlockSource(options);
    const deterministicReplay = await restartedSameBranch.fetchPage("4");
    assert.deepEqual(
      deterministicReplay.blocks,
      [...firstPage.blocks, ...secondPage.blocks, ...crossingPage.blocks],
      "a fresh source must reconstruct byte-for-byte-equivalent envelopes before resuming"
    );

    state.reorg = true;
    const replacementPage = await source.fetchPage("4");
    assert.deepEqual(replacementPage.blocks.map((entry) => entry.number), [3n]);
    assert.equal(replacementPage.blocks[0].hash, HASH_3_REORG);
    const replacementSnapshot = replacementPage.blocks[0].events.at(-1);
    assert.equal(replacementSnapshot.activeId, CENTER + 2);
    assert.equal(replacementSnapshot.poolState.replaceBinWindow, false);
    assert.deepEqual(replacementSnapshot.poolState.binUpdates.map((bin) => Number(bin.binId)), [
      CENTER + 1,
      CENTER + 2,
      CENTER + 42
    ]);

    state.head = 2;
    const rollbackPage = await source.fetchPage("4");
    assert.deepEqual(rollbackPage.blocks, []);
    assert.deepEqual(rollbackPage.rewindTo, {
      number: 2n,
      hash: HASH_2,
      timestamp: 102
    });
    assert.deepEqual(rollbackPage.canonicalHead, rollbackPage.rewindTo);
    assert.equal(rollbackPage.nextCursor, "3");
    assert.equal(rollbackPage.hasMore, false);

    const restartedAfterRollback = await createBlockSource(options);
    const restartedRollbackPage = await restartedAfterRollback.fetchPage("4");
    assert.deepEqual(restartedRollbackPage.blocks.map((entry) => entry.number), [0n, 1n, 2n]);
    assert.deepEqual(restartedRollbackPage.canonicalHead, {
      number: 2n,
      hash: HASH_2,
      timestamp: 102
    });
    assert.equal(restartedRollbackPage.nextCursor, "3");
    state.head = 3;
    const regrownPage = await restartedAfterRollback.fetchPage(restartedRollbackPage.nextCursor);
    assert.deepEqual(regrownPage.blocks.map((entry) => [entry.number, entry.hash, entry.parentHash]), [
      [3n, HASH_3_REORG, HASH_2]
    ]);

    state.head = 4;
    const restartedAfterOfflineRegrowth = await createBlockSource(options);
    assert.equal(await restartedAfterOfflineRegrowth.startupCursor({
      persistedCursor: "4",
      retainedHead: { number: 3n, hash: HASH_3, timestamp: 103 }
    }), null);
    const offlineReplacementPage = await restartedAfterOfflineRegrowth.fetchPage("4");
    assert.deepEqual(
      offlineReplacementPage.blocks.map((entry) => [entry.number, entry.hash, entry.parentHash]),
      [
        [0n, HASH_0, ZERO_HASH],
        [1n, HASH_1, HASH_0],
        [2n, HASH_2, HASH_1],
        [3n, HASH_3_REORG, HASH_2],
        [4n, HASH_4_REORG, HASH_3_REORG]
      ],
      "a fresh source must replay replacement ancestors after an offline reorg regrows past the saved cursor"
    );

    const paginatedRestart = await createBlockSource({ ...options, pageSize: 2 });
    const replayPageOne = await paginatedRestart.fetchPage("2");
    assert.deepEqual(replayPageOne.blocks.map((entry) => entry.number), [0n, 1n]);
    assert.equal(replayPageOne.nextCursor, "2");
    assert.equal(replayPageOne.hasMore, true);
    const replayPageTwo = await paginatedRestart.fetchPage(replayPageOne.nextCursor);
    assert.deepEqual(replayPageTwo.blocks.map((entry) => entry.number), [2n, 3n]);
    assert.equal(replayPageTwo.nextCursor, "4");
    assert.equal(replayPageTwo.hasMore, true);
    const replayPageThree = await paginatedRestart.fetchPage(replayPageTwo.nextCursor);
    assert.deepEqual(replayPageThree.blocks.map((entry) => entry.number), [4n]);
    assert.equal(replayPageThree.hasMore, false);

    state.head = 1;
    state.reorg = false;
    state.duplicateMode = "identical";
    const deduplicatingSource = await createBlockSource(options);
    const deduplicated = await deduplicatingSource.fetchPage(null);
    assert.equal(deduplicated.blocks[1].events.filter((event) => event.kind === "swap").length, 1);

    state.duplicateMode = "conflict";
    const conflictingSource = await createBlockSource(options);
    await assert.rejects(
      () => conflictingSource.fetchPage(null),
      /Conflicting duplicate canonical event id/
    );

    state.duplicateMode = null;
    state.headHashOverride = OTHER_HASH;
    const mismatched = await createBlockSource(options);
    await assert.rejects(() => mismatched.fetchPage(null), /RPC\/indexer head hash mismatch/);
  } finally {
    await Promise.all([close(rpcServer), close(graphServer)]);
  }
});

function fixtureState() {
  return {
    head: 1,
    reorg: false,
    duplicateMode: null,
    headHashOverride: null,
    headHashNullResponses: 1,
    calls: []
  };
}

function rpc(payload, state) {
  if (payload.method === "eth_chainId") return rpcResult(payload, "0x7a69");
  if (payload.method === "eth_blockNumber") return rpcResult(payload, quantity(state.head));
  if (payload.method === "eth_getBlockByNumber") {
    const number = Number(BigInt(payload.params[0]));
    return rpcResult(payload, rpcBlock(number, state));
  }
  if (payload.method === "eth_call") {
    const call = { to: payload.params[0]?.to, data: payload.params[0]?.data, block: payload.params[1] };
    state.calls.push(call);
    const data = call.data;
    const block = Number(BigInt(call.block));
    if (data === "0x313ce567") return rpcResult(payload, encodeWords(18n));
    if (data.startsWith(GET_PRICE_FROM_ID_SELECTOR)) return rpcResult(payload, encodeWords(Q128));
    if (data.startsWith(GET_BIN_SELECTOR)) {
      const binId = Number(BigInt(`0x${data.slice(10)}`));
      const bin = absoluteBin(binId, block);
      return rpcResult(payload, encodeWords(bin.reserveX, bin.reserveY));
    }
    if (data.startsWith(TOTAL_SUPPLY_SELECTOR)) {
      const binId = Number(BigInt(`0x${data.slice(10)}`));
      return rpcResult(payload, encodeWords(absoluteBin(binId, block).totalSupply));
    }
    if (data === GET_STATIC_FEE_PARAMETERS_SELECTOR) {
      return rpcResult(payload, encodeWords(...Object.values(feeState(block).static)));
    }
    if (data === GET_VARIABLE_FEE_PARAMETERS_SELECTOR) {
      return rpcResult(payload, encodeWords(...Object.values(feeState(block).variable)));
    }
    throw new Error(`Unexpected eth_call selector ${data}`);
  }
  throw new Error(`Unexpected RPC method ${payload.method}`);
}

function graph(payload, state) {
  if (payload.query.includes("LocalAnalyticsHead")) {
    if (state.headHashNullResponses > 0) {
      state.headHashNullResponses -= 1;
      return { data: { _meta: meta(state.head, null) } };
    }
    return { data: { _meta: meta(state.head, state.headHashOverride ?? rpcBlock(state.head, state).hash) } };
  }
  if (payload.query.includes("LocalAnalyticsPositions")) {
    const number = payload.variables.block;
    return {
      data: {
        _meta: meta(number, rpcBlock(number, state).hash),
        positions: [{
          id: `${PAIR}-${OWNER}-${CENTER}`,
          liquidity: "40",
          pair: pairIdentity(CENTER),
          bin: { binId: String(CENTER), reserveX: "100", reserveY: "200", totalSupply: "200" }
        }]
      }
    };
  }
  if (payload.query.includes("LocalAnalyticsBlock")) {
    const number = Number(payload.variables.blockNumber);
    const expectedHash = rpcBlock(number, state).hash;
    assert.equal(payload.variables.blockHash, expectedHash);
    assert.equal(
      payload.query.match(/block: \{ hash: \$blockHash \}/g)?.length,
      5,
      "historical metadata and every collection must use the RPC-attested hash pin"
    );
    const result = graphBlock(number, state);
    if (number === 0) result._meta = meta(0, null);
    if (number === 1 && state.duplicateMode !== null) {
      const duplicate = { ...result.swaps[0] };
      if (state.duplicateMode === "conflict") duplicate.amountInX = "11";
      result.swaps.push(duplicate);
    }
    return { data: result };
  }
  throw new Error("Unexpected GraphQL operation");
}

function graphBlock(number, state) {
  const block = rpcBlock(number, state);
  if (number === 0) {
    return { _meta: meta(0, HASH_0), pairs: [], swaps: [], liquidityEvents: [], transferBatchEvents: [] };
  }
  const activeId = number === 1
    ? CENTER
    : number === 2
      ? CENTER + 1
      : state.reorg
        ? CENTER + 2
        : CENTER + 100;
  const logOffset = (number - 1) * 10;
  const liquidityId = number === 2 ? CENTER - 2 : activeId;
  return {
    _meta: meta(number, block.hash),
    pairs: [{ ...pairIdentity(activeId), reserveX: String(1_000 + number * 5), reserveY: String(2_000 - number * 7) }],
    swaps: [{
      id: `${TX_SWAP}-${logOffset + 2}`,
      pair: { id: PAIR },
      amountInX: "10",
      amountInY: "0",
      amountOutX: "0",
      amountOutY: "7",
      totalFeeX: "1",
      totalFeeY: "0",
      protocolFeeX: "0",
      protocolFeeY: "0",
      activeId: String(activeId),
      transactionHash: TX_SWAP
    }],
    liquidityEvents: number <= 2 ? [{
      id: `${TX_DEPOSIT}-${logOffset + 4}`,
      pair: { id: PAIR },
      type: "DEPOSIT",
      ids: [String(liquidityId)],
      amounts: [pack(5n, 7n)],
      transactionHash: TX_DEPOSIT
    }] : [],
    transferBatchEvents: [
      ...(number <= 2 ? [{
        id: `${TX_DEPOSIT}-${logOffset + 3}`,
        pair: { id: PAIR },
        from: ZERO,
        to: OWNER,
        ids: [String(liquidityId)],
        amounts: ["100"],
        transactionHash: TX_DEPOSIT
      }] : []),
      ...(number === 1 ? [{
        id: `${TX_TRANSFER}-6`,
        pair: { id: PAIR },
        from: OWNER,
        to: RECIPIENT,
        ids: [String(CENTER)],
        amounts: ["20"],
        transactionHash: TX_TRANSFER
      }] : [])
    ]
  };
}

function rpcBlock(number, state) {
  if (number === 0) return { number: "0x0", hash: HASH_0, parentHash: ZERO_HASH, timestamp: "0x64" };
  if (number === 1) return { number: "0x1", hash: HASH_1, parentHash: HASH_0, timestamp: "0x65" };
  if (number === 2) return { number: "0x2", hash: HASH_2, parentHash: HASH_1, timestamp: "0x66" };
  if (number === 3) {
    return {
      number: "0x3",
      hash: state.reorg ? HASH_3_REORG : HASH_3,
      parentHash: HASH_2,
      timestamp: state.reorg ? "0x68" : "0x67"
    };
  }
  if (number === 4) {
    return {
      number: "0x4",
      hash: state.reorg ? HASH_4_REORG : HASH_4,
      parentHash: state.reorg ? HASH_3_REORG : HASH_3,
      timestamp: state.reorg ? "0x69" : "0x68"
    };
  }
  return null;
}

function pairIdentity(activeId) {
  return {
    id: PAIR,
    address: PAIR,
    tokenX: { id: TOKEN_X, address: TOKEN_X },
    tokenY: { id: TOKEN_Y, address: TOKEN_Y },
    activeId: String(activeId),
    binStep: "10"
  };
}

function absoluteBin(binId, block) {
  const offset = BigInt(binId - CENTER + 100);
  return {
    binId: String(binId),
    reserveX: offset + BigInt(block),
    reserveY: offset * 2n + BigInt(block),
    totalSupply: offset * 3n + BigInt(block)
  };
}

function feeState(block) {
  return {
    static: {
      baseFactor: 20n,
      filterPeriod: 30n,
      decayPeriod: 120n,
      reductionFactor: 5_000n,
      variableFeeControl: 100n,
      protocolShare: 1_000n,
      maxVolatilityAccumulator: 100_000n
    },
    variable: {
      volatilityAccumulator: 1_000n + BigInt(block),
      volatilityReference: 500n,
      idReference: BigInt(CENTER + block - 1),
      timeOfLastUpdate: 100n + BigInt(block)
    }
  };
}

function assertExactPoolReads(calls, block, expectedBins) {
  const poolCalls = calls.filter(isPoolStateCall);
  assert.equal(poolCalls.filter((call) => call.data.startsWith(GET_BIN_SELECTOR)).length, expectedBins);
  assert.equal(poolCalls.filter((call) => call.data.startsWith(TOTAL_SUPPLY_SELECTOR)).length, expectedBins);
  assert.equal(poolCalls.filter((call) => call.data === GET_STATIC_FEE_PARAMETERS_SELECTOR).length, 1);
  assert.equal(poolCalls.filter((call) => call.data === GET_VARIABLE_FEE_PARAMETERS_SELECTOR).length, 1);
  assert(poolCalls.every((call) => call.to === PAIR && call.block === quantity(block)));
}

function isPoolStateCall(call) {
  return call.data.startsWith(GET_BIN_SELECTOR) ||
    call.data.startsWith(TOTAL_SUPPLY_SELECTOR) ||
    call.data === GET_STATIC_FEE_PARAMETERS_SELECTOR ||
    call.data === GET_VARIABLE_FEE_PARAMETERS_SELECTOR;
}

function meta(number, hash) {
  return { block: { number, hash }, hasIndexingErrors: false };
}

function pack(amountX, amountY) {
  return `0x${((amountY << 128n) | amountX).toString(16).padStart(64, "0")}`;
}

function encodeWords(...values) {
  return `0x${values.map((value) => BigInt(value).toString(16).padStart(64, "0")).join("")}`;
}

function quantity(value) {
  return `0x${value.toString(16)}`;
}

function rpcResult(payload, result) {
  return { id: payload.id, jsonrpc: "2.0", result };
}

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function endpoint(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function handleJson(request, response, handler) {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = handler(JSON.parse(body));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}
