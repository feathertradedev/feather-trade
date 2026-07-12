#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { main, safeLoopbackRpcUrl } = require("./fixture-state.cjs");

const DEPLOYER = "0x1000000000000000000000000000000000000001";
const OWNER = "0x2000000000000000000000000000000000000002";
const ROUTER = "0x3000000000000000000000000000000000000003";
const TOKEN_A = "0x4000000000000000000000000000000000000004";
const TOKEN_B = "0x5000000000000000000000000000000000000005";
const PAIR = "0x6000000000000000000000000000000000000006";

test("refuses credentials, public hosts, and non-HTTP RPCs", () => {
  assert.throws(() => safeLoopbackRpcUrl("https://127.0.0.1:8545"), /loopback HTTP/);
  assert.throws(() => safeLoopbackRpcUrl("http://user:secret@127.0.0.1:8545"), /credential-free/);
  assert.throws(() => safeLoopbackRpcUrl("http://rpc.example:8545"), /non-loopback/);
  assert.equal(safeLoopbackRpcUrl("http://127.0.0.1:8545"), "http://127.0.0.1:8545/");
});

test("snapshot is read-only and contains only bounded public fixture state", async () => {
  await withFixture(async ({ manifestPath, rpc, state }) => {
    const output = await runMain(["snapshot", "--rpc-url", rpc, "--manifest", manifestPath, "--owner", OWNER]);
    const [snapshot] = output;
    assert.equal(snapshot.schemaVersion, "feather.localnet-fixture-snapshot.v1");
    assert.equal(snapshot.owner, OWNER);
    assert.equal(snapshot.nativeBalance, "0");
    assert.deepEqual(snapshot.tokens.map(({ id, balance, routerAllowance }) => ({ id, balance, routerAllowance })), [
      { id: "tokenA", balance: "0", routerAllowance: "0" },
      { id: "tokenB", balance: "0", routerAllowance: "0" }
    ]);
    assert.equal(snapshot.pairs[0].ownerTransferLogCount, 0);
    assert.equal(state.writeMethods.length, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /private|mnemonic|password|secret/i);
  });
});

test("prepare-empty-owner writes only the requested native balance after a fresh-owner proof", async () => {
  await withFixture(async ({ manifestPath, rpc, state }) => {
    const output = await runMain([
      "prepare-empty-owner",
      "--rpc-url", rpc,
      "--manifest", manifestPath,
      "--owner", OWNER,
      "--eth-wei", "12345"
    ]);
    assert.equal(output[0].event, "pre-write-snapshot");
    assert.equal(output[1].postWrite.nativeBalance, "12345");
    assert.ok(output[1].postWrite.tokens.every((token) => token.balance === "0" && token.routerAllowance === "0"));
    assert.deepEqual(state.writeMethods, ["anvil_setBalance"]);
  });
});

test("prepare-clean-funded sets exact native and raw token balances with zero executable approvals", async () => {
  await withFixture(async ({ manifestPath, rpc, state }) => {
    state.tokenBalances.get(TOKEN_A).set(DEPLOYER, 1_000n);
    state.tokenBalances.get(TOKEN_B).set(DEPLOYER, 1_000n);
    const output = await runMain([
      "prepare-clean-funded",
      "--rpc-url", rpc,
      "--manifest", manifestPath,
      "--owner", OWNER,
      "--eth-wei", "500",
      "--token-raw", "20"
    ]);
    const post = output[1].postWrite;
    assert.equal(post.nativeBalance, "500");
    assert.ok(post.tokens.every((token) => token.balance === "20" && token.routerAllowance === "0"));
    assert.deepEqual(state.writeMethods, [
      "anvil_setBalance",
      "anvil_impersonateAccount",
      "eth_sendTransaction",
      "eth_sendTransaction",
      "anvil_stopImpersonatingAccount"
    ]);
  });
});

test("dirty owners fail before the first mutation", async () => {
  await withFixture(async ({ manifestPath, rpc, state }) => {
    state.tokenBalances.get(TOKEN_A).set(OWNER, 1n);
    await assert.rejects(
      runMain(["prepare-clean-funded", "--rpc-url", rpc, "--manifest", manifestPath, "--owner", OWNER]),
      /already has token balance/
    );
    assert.deepEqual(state.writeMethods, []);
  });
});

test("insufficient deployer token funding fails before changing owner balance", async () => {
  await withFixture(async ({ manifestPath, rpc, state }) => {
    state.tokenBalances.get(TOKEN_A).set(DEPLOYER, 100n);
    state.tokenBalances.get(TOKEN_B).set(DEPLOYER, 1n);
    await assert.rejects(
      runMain([
        "prepare-clean-funded",
        "--rpc-url", rpc,
        "--manifest", manifestPath,
        "--owner", OWNER,
        "--eth-wei", "500",
        "--token-raw", "20"
      ]),
      /lacks requested raw balance for token tokenB/
    );
    assert.equal(state.nativeBalances.get(OWNER), 0n);
    assert.deepEqual(state.writeMethods, []);
  });
});

test("reset-approvals revokes only nonzero router allowance and pair-wide approval", async () => {
  await withFixture(async ({ manifestPath, rpc, state }) => {
    state.nativeBalances.set(OWNER, 1_000_000n);
    state.allowances.get(TOKEN_A).set(key(OWNER, ROUTER), 99n);
    state.pairApprovals.get(PAIR).set(key(OWNER, ROUTER), true);
    const output = await runMain(["reset-approvals", "--rpc-url", rpc, "--manifest", manifestPath, "--owner", OWNER]);
    const post = output[1].postWrite;
    assert.ok(post.tokens.every((token) => token.routerAllowance === "0"));
    assert.ok(post.pairs.every((pair) => pair.routerApproved === false));
    assert.equal(state.sentTransactions.length, 2);
    assert.deepEqual(state.sentTransactions.map((transaction) => transaction.data.slice(0, 10)), ["0x095ea7b3", "0xa22cb465"]);
  });
});

test("wrong-chain config verifies a real loopback chain and performs no writes", async () => {
  await withFixture(async ({ rpc, state }) => {
    state.chainId = 46_630;
    const [config] = await runMain([
      "wrong-chain-config",
      "--rpc-url", rpc,
      "--expected-chain-id", "46630"
    ]);
    assert.deepEqual(config, {
      schemaVersion: "feather.localnet-wrong-chain.v1",
      rpcUrl: `${rpc}/`,
      chainId: 46_630,
      appExpectedChainId: 31_337
    });
    assert.deepEqual(state.writeMethods, []);
  });
});

async function withFixture(operation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feather-fixture-test-"));
  const manifestPath = path.join(directory, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: "lb.localnet.v1",
    environment: "localnet",
    chainId: 31_337,
    startBlock: 0,
    deployer: DEPLOYER,
    contracts: { lbRouter: ROUTER },
    tokens: { tokenA: TOKEN_A, tokenB: TOKEN_B },
    seededPools: { pool: { pair: PAIR } }
  }));
  const state = createState();
  const server = http.createServer((request, response) => handleRpc(request, response, state));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const rpc = `http://127.0.0.1:${address.port}`;
  try {
    await operation({ directory, manifestPath, rpc, state });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createState() {
  return {
    chainId: 31_337,
    blockNumber: 10n,
    blockHash: `0x${"a".repeat(64)}`,
    nativeBalances: new Map([[OWNER, 0n], [DEPLOYER, 10n ** 21n]]),
    nonces: new Map([[OWNER, 0n], [DEPLOYER, 0n]]),
    tokenBalances: new Map([[TOKEN_A, new Map()], [TOKEN_B, new Map()]]),
    allowances: new Map([[TOKEN_A, new Map()], [TOKEN_B, new Map()]]),
    pairApprovals: new Map([[PAIR, new Map()]]),
    logs: new Map([[PAIR, []]]),
    receipts: new Map(),
    sentTransactions: [],
    writeMethods: []
  };
}

async function handleRpc(request, response, state) {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  try {
    const result = rpcResult(payload.method, payload.params ?? [], state);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
  } catch (error) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32_000, message: error.message } }));
  }
}

function rpcResult(method, params, state) {
  if (method.startsWith("anvil_") || method === "eth_sendTransaction") state.writeMethods.push(method);
  switch (method) {
    case "eth_chainId": return quantity(BigInt(state.chainId));
    case "rpc_modules": return { anvil: "1.0.0", eth: "1.0" };
    case "eth_getBlockByNumber": return { number: quantity(state.blockNumber), hash: state.blockHash };
    case "eth_getBalance": return quantity(state.nativeBalances.get(normalize(params[0])) ?? 0n);
    case "eth_getTransactionCount": return quantity(state.nonces.get(normalize(params[0])) ?? 0n);
    case "eth_getCode": return "0x";
    case "eth_getLogs": return state.logs.get(normalize(params[0].address)) ?? [];
    case "eth_call": return handleCall(params[0], state);
    case "eth_gasPrice": return "0x1";
    case "eth_estimateGas": return "0x5208";
    case "anvil_setBalance": state.nativeBalances.set(normalize(params[0]), BigInt(params[1])); return true;
    case "anvil_impersonateAccount": return true;
    case "anvil_stopImpersonatingAccount": return true;
    case "eth_sendTransaction": return handleTransaction(params[0], state);
    case "eth_getTransactionReceipt": return state.receipts.get(params[0]) ?? null;
    default: throw new Error(`Unhandled test RPC method ${method}`);
  }
}

function handleCall(transaction, state) {
  const to = normalize(transaction.to);
  const selector = transaction.data.slice(0, 10);
  const words = calldataWords(transaction.data);
  if (selector === "0x70a08231") return word(state.tokenBalances.get(to)?.get(addressWord(words[0])) ?? 0n);
  if (selector === "0xdd62ed3e") return word(state.allowances.get(to)?.get(key(addressWord(words[0]), addressWord(words[1]))) ?? 0n);
  if (selector === "0xe985e9c5") return word(state.pairApprovals.get(to)?.get(key(addressWord(words[0]), addressWord(words[1]))) ? 1n : 0n);
  throw new Error(`Unhandled eth_call selector ${selector}`);
}

function handleTransaction(transaction, state) {
  const from = normalize(transaction.from);
  const to = normalize(transaction.to);
  const selector = transaction.data.slice(0, 10);
  const words = calldataWords(transaction.data);
  state.sentTransactions.push(transaction);
  state.nonces.set(from, (state.nonces.get(from) ?? 0n) + 1n);
  if (selector === "0xa9059cbb") {
    const recipient = addressWord(words[0]);
    const amount = BigInt(`0x${words[1]}`);
    const balances = state.tokenBalances.get(to);
    const senderBalance = balances.get(from) ?? 0n;
    if (senderBalance < amount) throw new Error("insufficient token balance");
    balances.set(from, senderBalance - amount);
    balances.set(recipient, (balances.get(recipient) ?? 0n) + amount);
  } else if (selector === "0x095ea7b3") {
    state.allowances.get(to).set(key(from, addressWord(words[0])), BigInt(`0x${words[1]}`));
  } else if (selector === "0xa22cb465") {
    state.pairApprovals.get(to).set(key(from, addressWord(words[0])), BigInt(`0x${words[1]}`) !== 0n);
  } else {
    throw new Error(`Unhandled transaction selector ${selector}`);
  }
  state.blockNumber += 1n;
  const hash = `0x${state.sentTransactions.length.toString(16).padStart(64, "0")}`;
  state.receipts.set(hash, { status: "0x1" });
  return hash;
}

async function runMain(args) {
  let stdout = "";
  await main(args, { stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: () => {} } });
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function calldataWords(data) {
  return data.slice(10).match(/.{64}/g) ?? [];
}

function addressWord(wordValue) {
  return normalize(`0x${wordValue.slice(24)}`);
}

function key(left, right) {
  return `${normalize(left)}:${normalize(right)}`;
}

function normalize(value) {
  return String(value).toLowerCase();
}

function quantity(value) {
  return `0x${value.toString(16)}`;
}

function word(value) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
