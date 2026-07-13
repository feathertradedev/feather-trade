import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  createBlockSource,
  createPositionSnapshotProvider,
  decodePackedAmounts
} from "./analytics-adapters.mjs";

const PAIR = "0x4a47586912f0e03d9f3dcaa762fb8b659e52604b";
const TOKEN_X = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const TOKEN_Y = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const OWNER = "0x3729a6a9ced02c9d0a86ec9834b28825b212abf3";
const RECIPIENT = "0xac76bb7bf95e0240c78ff9908fcb24e21f6e89ce";
const ZERO = "0x0000000000000000000000000000000000000000";
const HASH_0 = `0x${"10".repeat(32)}`;
const HASH_1 = `0x${"11".repeat(32)}`;
const OTHER_HASH = `0x${"22".repeat(32)}`;
const TX_SWAP = `0x${"aa".repeat(32)}`;
const TX_DEPOSIT = `0x${"bb".repeat(32)}`;
const TX_TRANSFER = `0x${"cc".repeat(32)}`;

test("local analytics adapters produce exact canonical blocks and head-pinned positions", async () => {
  const state = { graphHeadHash: HASH_1 };
  const rpcServer = createServer((request, response) => void handleJson(request, response, (payload) => rpc(payload)));
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
    const page = await source.fetchPage(null);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, "2");
    assert.deepEqual(page.blocks.map((block) => block.number), [0n, 1n]);
    assert.equal(page.blocks[1].hash, HASH_1);
    assert.equal(page.blocks[1].parentHash, HASH_0);
    assert.equal(page.blocks[1].prices.length, 4);
    assert(page.blocks[1].prices.every((price) =>
      price.source === "fixed-test" &&
      price.priceUsdE18 === 1_000_000_000_000_000_000n &&
      price.confidenceUsdE18 === 0n &&
      price.sequence === 1n &&
      price.signedReport === null
    ));

    const events = page.blocks[1].events;
    const swap = events.find((event) => event.kind === "swap");
    assert.deepEqual(swap, {
      pair: PAIR,
      tokenX: TOKEN_X,
      tokenY: TOKEN_Y,
      decimalsX: 18,
      decimalsY: 18,
      reserveX: 1_005n,
      reserveY: 1_993n,
      kind: "swap",
      amountInX: 10n,
      amountInY: 0n,
      feeX: 1n,
      feeY: 0n
    });

    const deposit = events.find((event) => event.kind === "deposit");
    assert.equal(deposit.owner, OWNER);
    assert.deepEqual(deposit.bins, [{
      binId: "8388609",
      liquidityDelta: 100n,
      amountX: 5n,
      amountY: 7n
    }]);
    const transfer = events.find((event) => event.kind === "position-transfer");
    assert.equal(transfer.from, OWNER);
    assert.equal(transfer.to, RECIPIENT);
    assert.deepEqual(transfer.bins, [{ binId: "8388609", liquidity: 20n }]);
    assert.equal(events.at(-1).kind, "pair-snapshot");

    const provider = await createPositionSnapshotProvider(options);
    const snapshots = await provider.load(OWNER, { number: 1n, hash: HASH_1, timestamp: 101 });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].pair, PAIR);
    assert.equal(snapshots[0].owner, OWNER);
    assert.deepEqual(snapshots[0].bins, [{
      binId: "8388609",
      liquidity: 40n,
      amountX: 20n,
      amountY: 40n
    }]);
    await assert.rejects(
      () => provider.load(OWNER, { number: 1n, hash: OTHER_HASH, timestamp: 101 }),
      /Canonical head 1 changed/
    );

    assert.deepEqual(decodePackedAmounts(pack(9n, 13n)), { amountX: 9n, amountY: 13n });

    state.graphHeadHash = OTHER_HASH;
    const mismatched = await createBlockSource(options);
    await assert.rejects(() => mismatched.fetchPage(null), /RPC\/indexer head hash mismatch/);
  } finally {
    await Promise.all([close(rpcServer), close(graphServer)]);
  }
});

function rpc(payload) {
  if (payload.method === "eth_chainId") return rpcResult(payload, "0x7a69");
  if (payload.method === "eth_blockNumber") return rpcResult(payload, "0x1");
  if (payload.method === "eth_getBlockByNumber") {
    const number = Number(BigInt(payload.params[0]));
    if (number === 0) {
      return rpcResult(payload, { number: "0x0", hash: HASH_0, parentHash: `0x${"00".repeat(32)}`, timestamp: "0x64" });
    }
    if (number === 1) return rpcResult(payload, { number: "0x1", hash: HASH_1, parentHash: HASH_0, timestamp: "0x65" });
    return rpcResult(payload, null);
  }
  if (payload.method === "eth_call") return rpcResult(payload, `0x${18n.toString(16).padStart(64, "0")}`);
  throw new Error(`Unexpected RPC method ${payload.method}`);
}

function graph(payload, state) {
  if (payload.query.includes("LocalAnalyticsHead")) {
    return { data: { _meta: meta(1, state.graphHeadHash) } };
  }
  if (payload.query.includes("LocalAnalyticsPositions")) {
    return {
      data: {
        _meta: meta(1, HASH_1),
        positions: [{
          id: `${PAIR}-${OWNER}-8388609`,
          liquidity: "40",
          pair: pairIdentity(),
          bin: { binId: "8388609", reserveX: "100", reserveY: "200", totalSupply: "200" }
        }]
      }
    };
  }
  if (payload.query.includes("LocalAnalyticsBlock")) {
    const number = payload.variables.block;
    if (number === 0) {
      return { data: { _meta: meta(0, HASH_0), pairs: [], swaps: [], liquidityEvents: [], transferBatchEvents: [] } };
    }
    return {
      data: {
        _meta: meta(1, HASH_1),
        pairs: [{ ...pairIdentity(), reserveX: "1005", reserveY: "1993" }],
        swaps: [{
          id: `${TX_SWAP}-2`,
          pair: { id: PAIR },
          amountInX: "10",
          amountInY: "0",
          amountOutX: "0",
          amountOutY: "7",
          totalFeeX: "1",
          totalFeeY: "0",
          transactionHash: TX_SWAP
        }],
        liquidityEvents: [{
          id: `${TX_DEPOSIT}-4`,
          pair: { id: PAIR },
          type: "DEPOSIT",
          ids: ["8388609"],
          amounts: [pack(5n, 7n)],
          transactionHash: TX_DEPOSIT
        }],
        transferBatchEvents: [
          {
            id: `${TX_DEPOSIT}-3`,
            pair: { id: PAIR },
            from: ZERO,
            to: OWNER,
            ids: ["8388609"],
            amounts: ["100"],
            transactionHash: TX_DEPOSIT
          },
          {
            id: `${TX_TRANSFER}-6`,
            pair: { id: PAIR },
            from: OWNER,
            to: RECIPIENT,
            ids: ["8388609"],
            amounts: ["20"],
            transactionHash: TX_TRANSFER
          }
        ]
      }
    };
  }
  throw new Error("Unexpected GraphQL operation");
}

function pairIdentity() {
  return {
    id: PAIR,
    address: PAIR,
    tokenX: { id: TOKEN_X, address: TOKEN_X },
    tokenY: { id: TOKEN_Y, address: TOKEN_Y }
  };
}

function meta(number, hash) {
  return { block: { number, hash }, hasIndexingErrors: false };
}

function pack(amountX, amountY) {
  return `0x${((amountY << 128n) | amountX).toString(16).padStart(64, "0")}`;
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
