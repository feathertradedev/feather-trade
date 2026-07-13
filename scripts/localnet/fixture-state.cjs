#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LOCAL_CHAIN_ID = 31_337;
const DEFAULT_ETH_WEI = 50n * 10n ** 18n;
const DEFAULT_TOKEN_RAW = 20n * 10n ** 18n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const SELECTORS = Object.freeze({
  allowance: "0xdd62ed3e",
  approve: "0x095ea7b3",
  balanceOf: "0x70a08231",
  isApprovedForAll: "0xe985e9c5",
  setApprovalForAll: "0xa22cb465",
  transfer: "0xa9059cbb"
});

async function main(argv = process.argv.slice(2), io = process) {
  const { command, options } = parseArguments(argv);
  if (command === "wrong-chain-config") {
    const rpcUrl = safeLoopbackRpcUrl(requiredOption(options, "rpc-url"));
    const expectedChainId = parseSafeInteger(requiredOption(options, "expected-chain-id"), "expected-chain-id");
    if (expectedChainId === LOCAL_CHAIN_ID) throw new Error("Wrong-chain fixture must not use local app chain 31337");
    const client = createRpcClient(rpcUrl, options.fetchImpl ?? globalThis.fetch);
    const actualChainId = Number(BigInt(await client.request("eth_chainId")));
    if (actualChainId !== expectedChainId) {
      throw new Error(`Wrong-chain RPC expected ${expectedChainId}, received ${actualChainId}`);
    }
    const modules = await client.request("rpc_modules");
    if (!modules || typeof modules.anvil !== "string") throw new Error("Wrong-chain fixture RPC must expose the Anvil module");
    writeJson(io.stdout, {
      schemaVersion: "feather.localnet-wrong-chain.v1",
      rpcUrl,
      chainId: actualChainId,
      appExpectedChainId: LOCAL_CHAIN_ID
    });
    return;
  }

  const rpcUrl = safeLoopbackRpcUrl(options["rpc-url"] ?? "http://127.0.0.1:8545");
  const manifestPath = path.resolve(requiredOption(options, "manifest"));
  const manifest = readManifest(manifestPath);
  const owner = normalizeAddress(requiredOption(options, "owner"), "owner");
  if (owner === ZERO_ADDRESS || owner === manifest.deployer) throw new Error("Fixture owner must be a nonzero non-deployer account");
  const client = createRpcClient(rpcUrl, options.fetchImpl ?? globalThis.fetch);
  await assertRuntime(client, manifest);

  if (command === "snapshot") {
    writeJson(io.stdout, await captureSnapshot(client, manifest, owner, rpcUrl));
    return;
  }

  const preWrite = await captureSnapshot(client, manifest, owner, rpcUrl);
  writeJson(io.stdout, { event: "pre-write-snapshot", command, snapshot: preWrite });

  if (command === "prepare-clean-funded" || command === "prepare-empty-owner") {
    assertFreshOwner(preWrite);
    const ethWei = parseUint(options["eth-wei"] ?? DEFAULT_ETH_WEI.toString(), "eth-wei");
    if (command === "prepare-clean-funded") {
      const tokenRaw = parseUint(options["token-raw"] ?? DEFAULT_TOKEN_RAW.toString(), "token-raw");
      await assertFundableTokens(client, manifest, tokenRaw);
      await client.request("anvil_setBalance", [owner, toQuantity(ethWei)]);
      await fundTokens(client, manifest, owner, tokenRaw);
    } else {
      await client.request("anvil_setBalance", [owner, toQuantity(ethWei)]);
    }
  } else if (command === "reset-approvals") {
    await resetApprovals(client, manifest, owner, preWrite);
  } else {
    throw new Error(`Unknown fixture command ${command}`);
  }

  const postWrite = await captureSnapshot(client, manifest, owner, rpcUrl);
  verifyPostcondition(command, manifest, postWrite, options);
  writeJson(io.stdout, { event: "fixture-complete", command, preWrite, postWrite });
}

function parseArguments(argv) {
  const command = argv[0];
  if (!command) throw new Error("Expected snapshot, prepare-clean-funded, prepare-empty-owner, reset-approvals, or wrong-chain-config");
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    if (Object.prototype.hasOwnProperty.call(options, key)) throw new Error(`Duplicate --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function safeLoopbackRpcUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("RPC URL must be a valid loopback HTTP URL");
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("RPC URL must be credential-free loopback HTTP without query or fragment");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Fixture commands refuse non-loopback RPC endpoints");
  }
  return parsed.toString();
}

function readManifest(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.schemaVersion !== "lb.localnet.v1" || value?.environment !== "localnet") {
    throw new Error("Fixture manifest must be an lb.localnet.v1 localnet manifest");
  }
  if (value.chainId !== LOCAL_CHAIN_ID) throw new Error(`Fixture manifest chainId must be ${LOCAL_CHAIN_ID}`);
  const deployer = normalizeAddress(value.deployer, "manifest deployer");
  const router = normalizeAddress(value.contracts?.lbRouter, "manifest router");
  const tokens = Object.entries(value.tokens ?? {}).map(([id, address]) => ({ id, address: normalizeAddress(address, `token ${id}`) }));
  if (tokens.length === 0) throw new Error("Fixture manifest has no tokens");
  const pairs = Object.entries(value.seededPools ?? {}).map(([id, pool]) => ({ id, address: normalizeAddress(pool?.pair, `pool ${id}`) }));
  return { ...value, deployer, router, tokens, pairs };
}

async function assertRuntime(client, manifest) {
  const chainId = Number(BigInt(await client.request("eth_chainId")));
  if (chainId !== LOCAL_CHAIN_ID || chainId !== manifest.chainId) {
    throw new Error(`Fixture RPC must be Anvil chain ${LOCAL_CHAIN_ID}; received ${chainId}`);
  }
  const modules = await client.request("rpc_modules");
  if (!modules || typeof modules.anvil !== "string") throw new Error("Fixture RPC must expose the Anvil module");
}

async function captureSnapshot(client, manifest, owner, rpcUrl) {
  const block = await client.request("eth_getBlockByNumber", ["latest", false]);
  const tokenStates = [];
  for (const token of manifest.tokens) {
    tokenStates.push({
      id: token.id,
      address: token.address,
      balance: await readUintCall(client, token.address, encodeCall(SELECTORS.balanceOf, owner)),
      routerAllowance: await readUintCall(client, token.address, encodeCall(SELECTORS.allowance, owner, manifest.router))
    });
  }
  const pairStates = [];
  for (const pair of manifest.pairs) {
    pairStates.push({
      id: pair.id,
      address: pair.address,
      routerApproved: (await readUintCall(client, pair.address, encodeCall(SELECTORS.isApprovedForAll, owner, manifest.router))) !== "0",
      ownerTransferLogCount: await ownerTransferLogCount(client, pair.address, manifest.startBlock ?? 0, owner)
    });
  }
  return {
    schemaVersion: "feather.localnet-fixture-snapshot.v1",
    rpcUrl,
    chainId: manifest.chainId,
    blockNumber: BigInt(block.number).toString(),
    blockHash: block.hash,
    owner,
    nonce: BigInt(await client.request("eth_getTransactionCount", [owner, "latest"])).toString(),
    nativeBalance: BigInt(await client.request("eth_getBalance", [owner, "latest"])).toString(),
    code: await client.request("eth_getCode", [owner, "latest"]),
    tokens: tokenStates,
    pairs: pairStates,
    coverage: "manifest tokens and seeded pools"
  };
}

function assertFreshOwner(snapshot) {
  if (snapshot.owner === ZERO_ADDRESS) throw new Error("Fixture owner must be nonzero");
  if (snapshot.nonce !== "0" || snapshot.code !== "0x") throw new Error("Fixture owner must be a fresh EOA with nonce zero");
  if (snapshot.tokens.some((token) => token.balance !== "0" || token.routerAllowance !== "0")) {
    throw new Error("Fixture owner already has token balance or router allowance");
  }
  if (snapshot.pairs.some((pair) => pair.routerApproved || pair.ownerTransferLogCount !== 0)) {
    throw new Error("Fixture owner has LB approval or manifest-pool transfer history");
  }
}

async function fundTokens(client, manifest, owner, amount) {
  if (amount === 0n) throw new Error("token-raw must be greater than zero for a funded fixture");
  await withImpersonated(client, manifest.deployer, async () => {
    for (const token of manifest.tokens) {
      await sendTransaction(client, {
        from: manifest.deployer,
        to: token.address,
        data: encodeCall(SELECTORS.transfer, owner, amount)
      });
    }
  });
}

async function assertFundableTokens(client, manifest, amount) {
  if (amount === 0n) throw new Error("token-raw must be greater than zero for a funded fixture");
  for (const token of manifest.tokens) {
    const deployerBalance = BigInt(await readUintCall(client, token.address, encodeCall(SELECTORS.balanceOf, manifest.deployer)));
    if (deployerBalance < amount) throw new Error(`Deployer lacks requested raw balance for token ${token.id}`);
  }
}

async function resetApprovals(client, manifest, owner, snapshot) {
  const tokenResets = snapshot.tokens.filter((token) => token.routerAllowance !== "0");
  const pairResets = snapshot.pairs.filter((pair) => pair.routerApproved);
  if (tokenResets.length + pairResets.length === 0) return;
  const transactions = [
    ...tokenResets.map((token) => ({ from: owner, to: token.address, data: encodeCall(SELECTORS.approve, manifest.router, 0n) })),
    ...pairResets.map((pair) => ({ from: owner, to: pair.address, data: encodeCall(SELECTORS.setApprovalForAll, manifest.router, false) }))
  ];
  const gasPrice = BigInt(await client.request("eth_gasPrice"));
  let estimatedGas = 0n;
  for (const transaction of transactions) estimatedGas += BigInt(await client.request("eth_estimateGas", [transaction]));
  const bufferedGasCost = estimatedGas * gasPrice * 125n / 100n;
  if (BigInt(snapshot.nativeBalance) < bufferedGasCost) {
    throw new Error(`Owner needs at least ${bufferedGasCost} wei to reset approvals safely`);
  }
  await withImpersonated(client, owner, async () => {
    for (const transaction of transactions) await sendTransaction(client, transaction);
  });
}

async function withImpersonated(client, address, operation) {
  await client.request("anvil_impersonateAccount", [address]);
  try {
    await operation();
  } finally {
    await client.request("anvil_stopImpersonatingAccount", [address]);
  }
}

async function sendTransaction(client, transaction) {
  const hash = await client.request("eth_sendTransaction", [transaction]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = await client.request("eth_getTransactionReceipt", [hash]);
    if (receipt !== null) {
      if (BigInt(receipt.status) !== 1n) throw new Error(`Fixture transaction ${hash} reverted`);
      return hash;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Fixture transaction ${hash} did not produce a receipt`);
}

function verifyPostcondition(command, manifest, snapshot, options) {
  const expectedNative = parseUint(options["eth-wei"] ?? DEFAULT_ETH_WEI.toString(), "eth-wei").toString();
  if (command === "prepare-empty-owner") {
    if (snapshot.nativeBalance !== expectedNative || snapshot.tokens.some((token) => token.balance !== "0" || token.routerAllowance !== "0") || snapshot.pairs.some((pair) => pair.routerApproved)) {
      throw new Error("Empty-owner fixture postcondition failed");
    }
  }
  if (command === "prepare-clean-funded") {
    const expected = parseUint(options["token-raw"] ?? DEFAULT_TOKEN_RAW.toString(), "token-raw").toString();
    if (snapshot.nativeBalance !== expectedNative || snapshot.tokens.length !== manifest.tokens.length || snapshot.tokens.some((token) => token.balance !== expected || token.routerAllowance !== "0")) {
      throw new Error("Clean-funded fixture postcondition failed");
    }
  }
  if (command === "reset-approvals" && (snapshot.tokens.some((token) => token.routerAllowance !== "0") || snapshot.pairs.some((pair) => pair.routerApproved))) {
    throw new Error("Approval reset postcondition failed");
  }
}

async function ownerTransferLogCount(client, pair, startBlock, owner) {
  const logs = await client.request("eth_getLogs", [{ address: pair, fromBlock: toQuantity(BigInt(startBlock)), toBlock: "latest" }]);
  const topicOwner = padAddress(owner).toLowerCase();
  return logs.filter((log) => [log.topics?.[2], log.topics?.[3]].some((topic) => String(topic).toLowerCase() === topicOwner)).length;
}

async function readUintCall(client, to, data) {
  const result = await client.request("eth_call", [{ to, data }, "latest"]);
  return BigInt(result).toString();
}

function encodeCall(selector, ...values) {
  return `${selector}${values.map((value) => typeof value === "boolean" ? padUint(value ? 1n : 0n) : typeof value === "bigint" ? padUint(value) : padAddress(value).slice(2)).join("")}`;
}

function padAddress(value) {
  return `0x${normalizeAddress(value, "calldata address").slice(2).padStart(64, "0")}`;
}

function padUint(value) {
  return value.toString(16).padStart(64, "0");
}

function normalizeAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an EVM address`);
  return value.toLowerCase();
}

function parseUint(value, label) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value))) throw new Error(`${label} must be an unsigned decimal integer`);
  return BigInt(value);
}

function parseSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive safe integer`);
  return parsed;
}

function toQuantity(value) {
  return `0x${value.toString(16)}`;
}

function requiredOption(options, key) {
  if (!options[key]) throw new Error(`Missing required --${key}`);
  return options[key];
}

function createRpcClient(rpcUrl, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("Node fetch is required");
  let id = 0;
  return {
    async request(method, params = []) {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
      });
      if (!response.ok) throw new Error(`RPC ${method} returned HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(`RPC ${method} failed: ${payload.error.message ?? "unknown error"}`);
      return payload.result;
    }
  };
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  captureSnapshot,
  createRpcClient,
  encodeCall,
  main,
  parseArguments,
  readManifest,
  safeLoopbackRpcUrl
};
