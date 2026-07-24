import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPositionSnapshotProvider } from "../../infra/vps/adapters/position-snapshot-provider.mjs";

const FACTORY = "0x1111111111111111111111111111111111111111";
const PAIR_A = "0x2222222222222222222222222222222222222222";
const PAIR_B = "0x3333333333333333333333333333333333333333";
const FAKE_PAIR = "0x4444444444444444444444444444444444444444";
const TOKEN_X = "0x5555555555555555555555555555555555555555";
const TOKEN_Y = "0x6666666666666666666666666666666666666666";
const TOKEN_Z = "0x7777777777777777777777777777777777777777";
const OWNER = "0x8888888888888888888888888888888888888888";
const OTHER = "0x9999999999999999999999999999999999999999";
const ZERO = "0x0000000000000000000000000000000000000000";
const HEAD_HASH = `0x${"aa".repeat(32)}`;
const REORG_HASH = `0x${"bb".repeat(32)}`;
const TRANSFER_BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

test("position adapter is a standalone verified-runtime bundle", async () => {
  const bytes = await readFile(new URL("../../infra/vps/adapters/position-snapshot-provider.mjs", import.meta.url));
  const loaded = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
  assert.equal(typeof loaded.createPositionSnapshotProvider, "function");
});

test("position adapter returns head-pinned owner claims and authoritative empty pair snapshots", async () => {
  const fixture = await createFixture();
  try {
    const provider = await createPositionSnapshotProvider(fixture.options);
    const snapshots = await provider.load(OWNER.toUpperCase().replace("0X", "0x"), fixture.head);

    assert.deepEqual(snapshots, [
      {
        pair: PAIR_A,
        tokenX: TOKEN_X,
        tokenY: TOKEN_Y,
        decimalsX: 18,
        decimalsY: 6,
        kind: "position-snapshot",
        owner: OWNER,
        bins: [
          { binId: "99", liquidity: 5n, amountX: 4n, amountY: 10n },
          { binId: "100", liquidity: 25n, amountX: 100n, amountY: 200n }
        ],
        source: {
          eventId: `${HEAD_HASH}:${PAIR_A}:${OWNER}:position`,
          transactionHash: null,
          logIndex: null,
          sequence: 0,
          kind: "block-snapshot"
        }
      },
      {
        pair: PAIR_B,
        tokenX: TOKEN_X,
        tokenY: TOKEN_Z,
        decimalsX: 18,
        decimalsY: 8,
        kind: "position-snapshot",
        owner: OWNER,
        bins: [],
        source: {
          eventId: `${HEAD_HASH}:${PAIR_B}:${OWNER}:position`,
          transactionHash: null,
          logIndex: null,
          sequence: 1,
          kind: "block-snapshot"
        }
      }
    ]);

    const logCalls = fixture.state.calls.filter((call) => call.method === "eth_getLogs");
    assert.equal(logCalls.length, 6, "three five-block chunks should query incoming and outgoing ownership");
    assert.deepEqual(logCalls.map((call) => [call.params[0].fromBlock, call.params[0].toBlock]), [
      ["0x64", "0x68"], ["0x64", "0x68"],
      ["0x69", "0x6d"], ["0x69", "0x6d"],
      ["0x6e", "0x70"], ["0x6e", "0x70"]
    ]);
    assert(logCalls.every((call) => call.params[0].topics.includes(addressTopic(OWNER))));

    const callBlocks = fixture.state.calls
      .filter((call) => call.method === "eth_call")
      .map((call) => call.params[1]);
    assert(callBlocks.length > 0);
    assert(callBlocks.every((block) =>
      block?.blockHash === HEAD_HASH && block?.requireCanonical === true
    ), "every contract read must use the EIP-1898 canonical block hash");

    assert.equal(
      fixture.state.calls.filter((call) => call.method === "eth_getBlockByNumber").length,
      2,
      "the range-based history read must be enclosed by matching head attestations"
    );
    assert.equal(
      fixture.state.calls.some((call) => call.method === "eth_call" && call.params[0].to === FAKE_PAIR),
      false,
      "a contract that spoofs TransferBatch must not enter the factory-scoped read set"
    );
  } finally {
    await fixture.close();
  }
});

test("position adapter fails closed when the canonical hash changes during a load", async () => {
  const fixture = await createFixture();
  try {
    const provider = await createPositionSnapshotProvider(fixture.options);
    fixture.state.reorgOnSecondAttestation = true;
    await assert.rejects(
      () => provider.load(OWNER, fixture.head),
      /Requested canonical head no longer matches/
    );
  } finally {
    await fixture.close();
  }
});

test("position adapter rejects an RPC connected to the wrong manifest chain", async () => {
  const fixture = await createFixture();
  try {
    fixture.state.chainId = 1;
    await assert.rejects(
      () => createPositionSnapshotProvider(fixture.options),
      /RPC chain ID 1 does not match manifest chain ID 11155111/
    );
  } finally {
    await fixture.close();
  }
});

test("position adapter returns no snapshots for an owner with no ownership events", async () => {
  const fixture = await createFixture();
  try {
    fixture.state.logs = [];
    const provider = await createPositionSnapshotProvider(fixture.options);
    assert.deepEqual(await provider.load(OWNER, fixture.head), []);
    assert.equal(
      fixture.state.calls.filter((call) => call.method === "eth_call" &&
        [PAIR_A, PAIR_B].includes(call.params[0].to) &&
        ["0x05e8746d", "0xda10610c"].includes(call.params[0].data)).length,
      0,
      "token identities should only be fetched for owner-touched pairs"
    );
  } finally {
    await fixture.close();
  }
});

test("position adapter rejects the zero-address mint and burn sentinel as an owner", async () => {
  const fixture = await createFixture();
  try {
    const provider = await createPositionSnapshotProvider(fixture.options);
    await assert.rejects(
      () => provider.load(ZERO, fixture.head),
      /owner must not be the zero address/
    );
    assert.equal(
      fixture.state.calls.filter((call) => call.method === "eth_getLogs").length,
      0,
      "the zero address must be rejected before it can match all mint and burn events"
    );
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
  const state = {
    calls: [],
    chainId: 11_155_111,
    headAttestations: 0,
    reorgOnSecondAttestation: false,
    logs: fixtureLogs()
  };
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      try {
        const body = JSON.parse(raw);
        const result = Array.isArray(body)
          ? body.map((entry) => handleRpc(entry, state))
          : handleRpc(body, state);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const directory = await mkdtemp(join(tmpdir(), "feather-position-adapter-"));
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    chainId: 11_155_111,
    startBlock: 100,
    contracts: { lbFactory: FACTORY }
  }));
  return {
    state,
    head: { number: 112n, hash: HEAD_HASH, timestamp: 1_700 },
    options: {
      rpcUrl: `http://127.0.0.1:${address.port}`,
      manifestPath,
      logBlockSpan: 5,
      rpcBatchSize: 3,
      timeoutMs: 2_000
    },
    async close() {
      await Promise.all([
        new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
        rm(directory, { recursive: true, force: true })
      ]);
    }
  };
}

function handleRpc(payload, state) {
  state.calls.push({ method: payload.method, params: payload.params });
  try {
    return { id: payload.id, jsonrpc: "2.0", result: rpcResult(payload, state) };
  } catch (error) {
    return {
      id: payload.id,
      jsonrpc: "2.0",
      error: { code: -32_000, message: error instanceof Error ? error.message : String(error) }
    };
  }
}

function rpcResult(payload, state) {
  if (payload.method === "eth_chainId") return quantity(BigInt(state.chainId));
  if (payload.method === "eth_getBlockByNumber") {
    state.headAttestations += 1;
    return {
      number: "0x70",
      hash: state.reorgOnSecondAttestation && state.headAttestations >= 2 ? REORG_HASH : HEAD_HASH,
      parentHash: `0x${"cc".repeat(32)}`,
      timestamp: quantity(1_700n)
    };
  }
  if (payload.method === "eth_getLogs") return matchingLogs(state.logs, payload.params[0]);
  if (payload.method !== "eth_call") throw new Error(`unexpected method ${payload.method}`);

  const [call, block] = payload.params;
  if (block?.blockHash !== HEAD_HASH || block?.requireCanonical !== true) {
    throw new Error("contract call was not pinned to the canonical block hash");
  }
  const selector = call.data.slice(0, 10);
  if (call.to === FACTORY && selector === "0x4e937c3a") return words(2n);
  if (call.to === FACTORY && selector === "0x7daf5d66") {
    const index = argument(call.data);
    return addressWord(index === 0n ? PAIR_A : PAIR_B);
  }
  if (selector === "0x05e8746d") {
    if (call.to === PAIR_A || call.to === PAIR_B) return addressWord(TOKEN_X);
  }
  if (selector === "0xda10610c") {
    if (call.to === PAIR_A) return addressWord(TOKEN_Y);
    if (call.to === PAIR_B) return addressWord(TOKEN_Z);
  }
  if (selector === "0x313ce567") {
    if (call.to === TOKEN_X) return words(18n);
    if (call.to === TOKEN_Y) return words(6n);
    if (call.to === TOKEN_Z) return words(8n);
  }
  if (selector === "0x00fdd58e") {
    const id = argument(call.data);
    if (call.to === PAIR_A && id === 99n) return words(5n);
    if (call.to === PAIR_A && id === 100n) return words(25n);
    return words(0n);
  }
  if (selector === "0xbd85b039") {
    const id = argument(call.data);
    if (call.to === PAIR_A && id === 99n) return words(10n);
    if (call.to === PAIR_A && id === 100n) return words(100n);
  }
  if (selector === "0x0abe9688") {
    const id = argument(call.data);
    if (call.to === PAIR_A && id === 99n) return words(9n, 21n);
    if (call.to === PAIR_A && id === 100n) return words(400n, 800n);
  }
  throw new Error(`unexpected eth_call ${call.to}:${call.data}`);
}

function fixtureLogs() {
  return [
    transferLog(PAIR_A, 101, 1, ZERO, OWNER, [100n, 101n], [50n, 20n]),
    transferLog(PAIR_A, 102, 2, OWNER, OTHER, [101n], [20n]),
    transferLog(PAIR_A, 103, 3, OWNER, OWNER, [99n], [5n]),
    transferLog(PAIR_B, 106, 4, ZERO, OWNER, [200n], [10n]),
    transferLog(PAIR_B, 107, 5, OWNER, ZERO, [200n], [10n]),
    transferLog(FAKE_PAIR, 108, 6, ZERO, OWNER, [300n], [1n])
  ];
}

function matchingLogs(logs, filter) {
  const from = BigInt(filter.fromBlock);
  const to = BigInt(filter.toBlock);
  return logs.filter((log) => {
    const number = BigInt(log.blockNumber);
    if (number < from || number > to) return false;
    return filter.topics.every((topic, index) => topic === null || log.topics[index] === topic);
  });
}

function transferLog(pair, blockNumber, logIndex, from, to, ids, amounts) {
  return {
    address: pair,
    blockNumber: quantity(BigInt(blockNumber)),
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    transactionHash: `0x${(blockNumber * 100 + logIndex).toString(16).padStart(64, "0")}`,
    logIndex: quantity(BigInt(logIndex)),
    removed: false,
    topics: [TRANSFER_BATCH_TOPIC, addressTopic(OTHER), addressTopic(from), addressTopic(to)],
    data: dynamicArrays(ids, amounts)
  };
}

function dynamicArrays(left, right) {
  const leftOffset = 64n;
  const rightOffset = leftOffset + 32n + BigInt(left.length) * 32n;
  return words(leftOffset, rightOffset, BigInt(left.length), ...left, BigInt(right.length), ...right);
}

function words(...values) {
  return `0x${values.map((value) => BigInt(value).toString(16).padStart(64, "0")).join("")}`;
}

function addressWord(value) {
  return `0x${"0".repeat(24)}${value.slice(2)}`;
}

function addressTopic(value) {
  return `0x${"0".repeat(24)}${value.slice(2)}`;
}

function argument(data) {
  return BigInt(`0x${data.slice(-64)}`);
}

function quantity(value) {
  return `0x${value.toString(16)}`;
}
