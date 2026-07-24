import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createBlockSource } from "./canonical-block-source.mjs";

const FACTORY = "0x1000000000000000000000000000000000000001";
const PAIR = "0x2000000000000000000000000000000000000002";
const TOKEN_X = "0x3000000000000000000000000000000000000003";
const TOKEN_Y = "0x4000000000000000000000000000000000000004";
const OWNER = "0x5000000000000000000000000000000000000005";
const ROUTER = "0x6000000000000000000000000000000000000006";
const RECIPIENT = "0x7000000000000000000000000000000000000007";
const FEED_X = "0x8000000000000000000000000000000000000008";
const FEED_Y = "0x9000000000000000000000000000000000000009";
const ZERO = "0x0000000000000000000000000000000000000000";
const CENTER = 8_388_608;
const Q128 = 1n << 128n;
const USD_SCALE = 10n ** 18n;

const PRICE_POLICIES = [
  {
    token: TOKEN_X,
    source: "chainlink-data-feeds",
    feedId: FEED_X,
    feedDecimals: 8,
    feedDescription: "TOKEN X / USD",
    maxAgeSeconds: 7_200,
    maxConfidenceBps: 0
  },
  {
    token: TOKEN_Y,
    source: "chainlink-data-feeds",
    feedId: FEED_Y,
    feedDecimals: 8,
    feedDescription: "TOKEN Y / USD",
    maxAgeSeconds: 90_000,
    maxConfidenceBps: 0
  }
];

const TOPIC = {
  pairCreated: "0x2c8d104b27c6b7f4492017a6f5cf3803043688934ebcaa6a03540beeaf976aff",
  swap: "0xad7d6f97abf51ce18e17a38f4d70e975be9c0708474987bb3e26ad21bd93ca70",
  deposit: "0x87f1f9dcf5e8089a3e00811b6a008d8f30293a3da878cb1fe8c90ca376402f8a",
  transferBatch: "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb"
};

test("direct RPC source discovers pools, hash-pins state and Chainlink prices, deduplicates rounds, and repairs reorgs", async () => {
  const state = { reorg: false, head: 102, calls: [], latestCalls: [], codeChecks: [], logFilters: [] };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    try {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: rpcResult(payload, state) }));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await listen(server);
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const source = await createBlockSource({
      rpcUrl: `http://127.0.0.1:${address.port}`,
      allowInsecureRpc: true,
      manifest: {
        environment: "sepolia",
        chainId: 11_155_111,
        startBlock: 100,
        contracts: { lbFactory: FACTORY }
      },
      confirmations: 0,
      pageSize: 2,
      rpcRetries: 0,
      pollIntervalMs: 5,
      priceSampleBlockInterval: 1,
      pricePolicies: PRICE_POLICIES
    });

    assert.equal(await source.startupCursor({ persistedCursor: "103", retainedHead: null }), null);
    const first = await source.fetchPage(null);
    assert.deepEqual(first.blocks.map((block) => block.number), [100n, 101n]);
    assert.equal(first.nextCursor, "102");
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.blocks[0].prices, [
      expectedPrice(TOKEN_X, FEED_X, 2_000n * USD_SCALE, 100n, 1_699_999_995),
      expectedPrice(TOKEN_Y, FEED_Y, 999_900_000_000_000_000n, 200n, 1_699_999_996)
    ]);
    assert.deepEqual(
      first.blocks[1].prices,
      [],
      "the source must not re-emit unchanged Chainlink rounds"
    );

    const deposit = first.blocks[0].events.find((event) => event.kind === "deposit");
    assert(deposit);
    assert.equal(deposit.owner, OWNER);
    assert.deepEqual(deposit.bins, [{
      binId: String(CENTER),
      liquidityDelta: 50n,
      amountX: 11n,
      amountY: 22n
    }]);
    assert.equal(deposit.source.eventId, `${txHash(100)}-2`);

    const initialSnapshot = first.blocks[0].events.find((event) => event.kind === "pair-snapshot");
    assert(initialSnapshot?.poolState);
    assert.equal(initialSnapshot.pair, PAIR);
    assert.equal(initialSnapshot.tokenX, TOKEN_X);
    assert.equal(initialSnapshot.tokenY, TOKEN_Y);
    assert.equal(initialSnapshot.factoryAddress, FACTORY);
    assert.equal(initialSnapshot.createdAtBlock, 100n);
    assert.equal(initialSnapshot.createdAtBlockHash, blockHash(100, false));
    assert.equal(initialSnapshot.creationTransactionHash, txHash(100));
    assert.equal(initialSnapshot.creationLogIndex, 0);
    assert.equal(initialSnapshot.poolState.replaceBinWindow, true);
    assert.equal(initialSnapshot.poolState.binUpdates.length, 81);

    const swap = first.blocks[1].events.find((event) => event.kind === "swap");
    assert(swap);
    assert.equal(swap.activeId, CENTER + 1);
    assert.equal(swap.amountInX, 110n);
    assert.equal(swap.amountInY, 0n);
    assert.equal(swap.feeX, 10n);
    assert.equal(swap.protocolFeeX, 2n);
    assert.equal(
      swap.marketPriceQuoteE18,
      ((Q128 * 1_001n / 1_000n) * 10n ** 36n) / (Q128 * 10n ** 6n)
    );
    assert.equal(swap.source.logIndex, 1);

    const nextSnapshot = first.blocks[1].events.find((event) => event.kind === "pair-snapshot");
    assert(nextSnapshot?.poolState);
    assert.equal(nextSnapshot.poolState.replaceBinWindow, false);
    assert.deepEqual(nextSnapshot.poolState.binUpdates.map((bin) => Number(bin.binId)), [
      CENTER,
      CENTER + 1,
      CENTER + 41
    ]);

    const second = await source.fetchPage(first.nextCursor);
    assert.deepEqual(second.blocks.map((block) => block.number), [102n]);
    assert.deepEqual(second.blocks[0].prices, [
      expectedPrice(TOKEN_X, FEED_X, 2_050n * USD_SCALE, 101n, 1_700_000_023)
    ], "only the feed whose round changed should be emitted");
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.canonicalHead, {
      number: 102n,
      hash: blockHash(102, false),
      timestamp: 1_700_000_024
    });

    assert(state.calls.length > 0);
    assert(state.calls.every((call) =>
      call.block && typeof call.block === "object" && call.block.requireCanonical === true &&
      call.block.blockHash === blockHash(call.number, false)
    ), "all historical state reads must use the captured canonical block hash");
    const feedCalls = state.calls.filter((call) =>
      (call.to === FEED_X || call.to === FEED_Y) && call.data === "0xfeaf968c"
    );
    assert.deepEqual(
      [...new Set(feedCalls.map((call) => call.number))],
      [100, 101, 102],
      "both feeds should be sampled at each configured canonical interval"
    );
    assert.deepEqual(
      new Set(state.codeChecks),
      new Set([FACTORY, FEED_X, FEED_Y]),
      "startup must verify code at the factory and every configured feed"
    );
    for (const feed of [FEED_X, FEED_Y]) {
      assert(state.latestCalls.some((call) => call.to === feed && call.data === "0x313ce567"));
      assert(state.latestCalls.some((call) => call.to === feed && call.data === "0x7284e416"));
    }
    assert(state.logFilters.some((filter) => filter.address === FACTORY));
    assert(state.logFilters.some((filter) => Array.isArray(filter.address) && filter.address.includes(PAIR)));

    const resumedSource = await createBlockSource({
      rpcUrl: `http://127.0.0.1:${address.port}`,
      allowInsecureRpc: true,
      manifest: {
        environment: "sepolia",
        chainId: 11_155_111,
        startBlock: 100,
        contracts: { lbFactory: FACTORY }
      },
      confirmations: 0,
      pageSize: 2,
      discoveryBlockSpan: 2,
      rpcRetries: 0,
      priceSampleBlockInterval: 1,
      pricePolicies: PRICE_POLICIES
    });
    assert.equal(await resumedSource.startupCursor({
      persistedCursor: "102",
      retainedHead: second.canonicalHead
    }), "103");
    state.head = 103;
    const resumed = await resumedSource.fetchPage("103");
    assert.deepEqual(resumed.blocks.map((block) => block.number), [103n]);
    assert.equal(resumed.nextCursor, "104");
    const resumedSnapshot = resumed.blocks[0].events.find((event) => event.kind === "pair-snapshot");
    assert.equal(resumedSnapshot?.factoryAddress, FACTORY);
    assert.equal(resumedSnapshot?.createdAtBlock, 100n);
    assert.equal(resumedSnapshot?.creationTransactionHash, txHash(100));
    assert.equal(resumedSnapshot?.poolState?.replaceBinWindow, true);

    state.reorg = true;
    const replacement = await source.fetchPage("103");
    assert.deepEqual(replacement.blocks.map((block) => [block.number, block.hash]), [
      [101n, blockHash(101, true)],
      [102n, blockHash(102, true)]
    ]);
    const replacementSwap = replacement.blocks[0].events.find((event) => event.kind === "swap");
    assert.equal(replacementSwap?.activeId, CENTER - 1);
    assert.deepEqual(replacement.blocks[0].prices, [
      expectedPrice(TOKEN_X, FEED_X, 1_950n * USD_SCALE, 102n, 1_700_000_011)
    ], "a replacement fork must emit its newly canonical Chainlink round");
    assert.deepEqual(
      replacement.blocks[1].prices,
      [],
      "the replacement fork must retain round deduplication after restoring ancestor state"
    );
    const replacementFeedCalls = state.calls.filter((call) =>
      call.to === FEED_X && call.data === "0xfeaf968c" && call.number >= 101 &&
      call.block.blockHash === blockHash(call.number, true)
    );
    assert.deepEqual(
      [...new Set(replacementFeedCalls.map((call) => call.number))],
      [101, 102],
      "replacement feed reads must be pinned to replacement canonical hashes"
    );
    assert.equal(replacement.rewindTo, null);
  } finally {
    await close(server);
  }
});

test("adapter validates Sepolia identity and never accepts a plaintext remote endpoint", async () => {
  await assert.rejects(
    () => createBlockSource({
      rpcUrl: "http://rpc.example.test/secret-key",
      manifest: {
        environment: "sepolia",
        chainId: 11_155_111,
        startBlock: 1,
        contracts: { lbFactory: FACTORY }
      }
    }),
    /must use HTTPS/
  );
  await assert.rejects(
    () => createBlockSource({
      rpcUrl: "https://rpc.example.test/key",
      manifest: {
        environment: "mainnet",
        chainId: 1,
        startBlock: 1,
        contracts: { lbFactory: FACTORY }
      }
    }),
    /requires a Sepolia deployment manifest/
  );
});

function rpcResult(payload, state) {
  if (payload.method === "eth_chainId") return "0xaa36a7";
  if (payload.method === "eth_getCode") {
    const target = payload.params[0].toLowerCase();
    state.codeChecks.push(target);
    return [FACTORY, FEED_X, FEED_Y].includes(target) ? "0x60016000" : "0x";
  }
  if (payload.method === "eth_blockNumber") return quantity(state.head);
  if (payload.method === "eth_getBlockByNumber") {
    const number = Number(BigInt(payload.params[0]));
    return block(number, state.reorg);
  }
  if (payload.method === "eth_getLogs") {
    const filter = payload.params[0];
    state.logFilters.push(filter);
    const from = Number(BigInt(filter.fromBlock));
    const to = Number(BigInt(filter.toBlock));
    return logs(state.reorg).filter((log) => {
      const number = Number(BigInt(log.blockNumber));
      if (number < from || number > to) return false;
      const expected = Array.isArray(filter.address) ? filter.address : [filter.address];
      return expected.map((entry) => entry.toLowerCase()).includes(log.address.toLowerCase());
    });
  }
  if (payload.method === "eth_call") return ethCall(payload, state);
  throw new Error(`Unexpected RPC method ${payload.method}`);
}

function ethCall(payload, state) {
  const call = payload.params[0];
  const blockRef = payload.params[1];
  const to = call.to.toLowerCase();
  const selector = call.data.slice(0, 10);
  if (blockRef === "latest") {
    state.latestCalls.push({ to, data: call.data, block: blockRef });
    if (selector === "0x313ce567" && (to === FEED_X || to === FEED_Y)) return words(8n);
    if (selector === "0x7284e416" && to === FEED_X) return abiString("TOKEN X / USD");
    if (selector === "0x7284e416" && to === FEED_Y) return abiString("TOKEN Y / USD");
    throw new Error(`Unexpected latest eth_call ${to}:${selector}`);
  }
  assert.equal(blockRef.requireCanonical, true);
  const number = blockNumberForHash(blockRef.blockHash, state.reorg);
  state.calls.push({ to, data: call.data, block: blockRef, number });
  if (selector === "0xfeaf968c" && (to === FEED_X || to === FEED_Y)) {
    const round = chainlinkRound(to, number, state.reorg);
    return words(round.roundId, round.answer, round.startedAt, round.updatedAt, round.roundId);
  }
  if (selector === "0x05e8746d") return words(addressWord(TOKEN_X));
  if (selector === "0xda10610c") return words(addressWord(TOKEN_Y));
  if (selector === "0x17f11ecc") return words(10n);
  if (selector === "0x313ce567") return words(to === TOKEN_X ? 18n : 6n);
  if (selector === "0x0902f1ac") return words(BigInt(number * 10), BigInt(number * 20));
  if (selector === "0xdbe65edc") return words(BigInt(activeId(number, state.reorg)));
  if (selector === "0x4c7cffbd") {
    const id = Number(BigInt(`0x${call.data.slice(10)}`));
    return words(id === CENTER ? Q128 : id > CENTER ? Q128 * 1_001n / 1_000n : Q128 * 999n / 1_000n);
  }
  if (selector === "0x7ca0de30") return words(10_000n, 30n, 600n, 5_000n, 40_000n, 0n, 350_000n);
  if (selector === "0x8d7024e5") return words(1n, 2n, BigInt(activeId(number, state.reorg)), BigInt(1_700_000_000 + (number - 100) * 12));
  if (selector === "0x0abe9688") {
    const id = BigInt(`0x${call.data.slice(10)}`);
    return words(id % 100n, id % 200n);
  }
  if (selector === "0xbd85b039") return words(100n);
  throw new Error(`Unexpected eth_call selector ${selector}`);
}

function chainlinkRound(feed, number, reorg) {
  if (feed === FEED_Y) {
    return {
      roundId: 200n,
      answer: 99_990_000n,
      startedAt: 1_699_999_990n,
      updatedAt: 1_699_999_996n
    };
  }
  if (reorg && number >= 101) {
    return {
      roundId: 102n,
      answer: 195_000_000_000n,
      startedAt: 1_700_000_005n,
      updatedAt: 1_700_000_011n
    };
  }
  if (number >= 102) {
    return {
      roundId: 101n,
      answer: 205_000_000_000n,
      startedAt: 1_700_000_017n,
      updatedAt: 1_700_000_023n
    };
  }
  return {
    roundId: 100n,
    answer: 200_000_000_000n,
    startedAt: 1_699_999_990n,
    updatedAt: 1_699_999_995n
  };
}

function expectedPrice(token, feedId, priceUsdE18, sequence, observedAt) {
  return {
    token,
    source: "chainlink-data-feeds",
    feedId,
    priceUsdE18,
    confidenceUsdE18: 0n,
    observedAt,
    sequence,
    signedReport: null
  };
}

function logs(reorg) {
  const creation = rawLog({
    number: 100,
    index: 0,
    address: FACTORY,
    topics: [TOPIC.pairCreated, addressTopic(TOKEN_X), addressTopic(TOKEN_Y), wordHex(10n)],
    data: words(addressWord(PAIR), 0n),
    reorg: false
  });
  const transfer = rawLog({
    number: 100,
    index: 1,
    address: PAIR,
    topics: [TOPIC.transferBatch, addressTopic(ROUTER), addressTopic(ZERO), addressTopic(OWNER)],
    data: dynamicTwoArrays([BigInt(CENTER)], [50n]),
    reorg: false
  });
  const deposit = rawLog({
    number: 100,
    index: 2,
    address: PAIR,
    topics: [TOPIC.deposit, addressTopic(ROUTER), addressTopic(OWNER)],
    data: dynamicTwoArrays([BigInt(CENTER)], [pack(11n, 22n)]),
    reorg: false
  });
  const id = reorg ? CENTER - 1 : CENTER + 1;
  const swap = rawLog({
    number: 101,
    index: 1,
    address: PAIR,
    topics: [TOPIC.swap, addressTopic(ROUTER), addressTopic(RECIPIENT)],
    data: words(BigInt(id), pack(110n, 0n), pack(0n, 90n), 4n, pack(10n, 0n), pack(2n, 0n)),
    reorg
  });
  return [creation, transfer, deposit, swap];
}

function rawLog({ number, index, address, topics, data, reorg }) {
  return {
    address,
    blockNumber: quantity(number),
    blockHash: blockHash(number, reorg),
    transactionHash: txHash(number, reorg),
    logIndex: quantity(index),
    removed: false,
    topics,
    data
  };
}

function block(number, reorg) {
  if (number < 100 || number > 103) return null;
  return {
    number: quantity(number),
    hash: blockHash(number, reorg && number >= 101),
    parentHash: number === 100 ? hashNumber(99) : blockHash(number - 1, reorg && number - 1 >= 101),
    timestamp: quantity(1_700_000_000 + (number - 100) * 12)
  };
}

function activeId(number, reorg) {
  if (number === 100) return CENTER;
  return reorg ? CENTER - 1 : CENTER + 1;
}

function blockHash(number, reorg) {
  return hashNumber(reorg ? number + 10_000 : number);
}

function blockNumberForHash(value, reorg) {
  for (let number = 100; number <= 103; number += 1) {
    if (blockHash(number, reorg && number >= 101) === value) return number;
  }
  throw new Error(`Unknown canonical block hash ${value}`);
}

function txHash(number, reorg = false) {
  return hashNumber((reorg ? 20_000 : 1_000) + number);
}

function hashNumber(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function addressTopic(value) {
  return `0x${value.slice(2).padStart(64, "0")}`;
}

function addressWord(value) {
  return BigInt(value);
}

function pack(x, y) {
  return x | y << 128n;
}

function words(...values) {
  return `0x${values.map((value) => BigInt(value).toString(16).padStart(64, "0")).join("")}`;
}

function abiString(value) {
  const bytes = Buffer.from(value, "utf8");
  const paddedBytes = bytes.toString("hex").padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `${words(32n, BigInt(bytes.length))}${paddedBytes}`;
}

function wordHex(value) {
  return words(value);
}

function dynamicTwoArrays(first, second) {
  const firstOffset = 64n;
  const secondOffset = firstOffset + BigInt(32 * (1 + first.length));
  return words(firstOffset, secondOffset, BigInt(first.length), ...first, BigInt(second.length), ...second);
}

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
