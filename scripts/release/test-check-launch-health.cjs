#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const manifestPath = "deployments/examples/robinhood-testnet.example.json";
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, manifestPath), "utf8"));
const latestBlock = manifest.startBlock + 96;
const healthyIndexedBlock = latestBlock - 4;
const wrongOwner = "0x1111111111111111111111111111111111111111";
const scrubbedEnv = makeScrubbedEnv();

const selectors = {
  owner: "0x8da5cb5b",
  feeRecipient: "0x4ccb20c0",
  pairImplementation: "0xaf371065"
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await withHealthServers(baseState(), async ({ graphqlUrl, rpcUrl }) => {
    const report = await runReport([
      manifestPath,
      "--rpc-url",
      rpcUrl,
      "--graphql-url",
      graphqlUrl,
      "--expected-owner",
      manifest.ownership.lbFactoryOwner,
      "--expected-fee-recipient",
      manifest.ownership.feeRecipient,
      "--strict-launch",
      "--max-rpc-head-age-seconds",
      "3600",
      "--json"
    ]);

    assert.equal(report.status, 0, JSON.stringify(report.json, null, 2));
    assert.equal(report.json.ok, true);
    assert.equal(report.json.launchBlockers.length, 0);
    assertCheck(report.json, "rpc", "pass");
    assertCheck(report.json, "factory-owner", "pass");
    assertCheck(report.json, "factory-fee-recipient", "pass");
    assertCheck(report.json, "factory-pair-implementation", "pass");
    const graphql = assertCheck(report.json, "graphql", "pass");
    assert.equal(graphql.indexedBlock, healthyIndexedBlock);
    assert.equal(graphql.blockLag, 4);
    assert.equal(graphql.factoryFound, true);
  });

  const manifestOnly = await runReport([manifestPath, "--json"]);
  assert.equal(manifestOnly.status, 0, JSON.stringify(manifestOnly.json, null, 2));
  assert.equal(manifestOnly.json.ok, true);
  assertCheck(manifestOnly.json, "manifest", "pass");
  assertCheck(manifestOnly.json, "rpc", "skipped");
  assertCheck(manifestOnly.json, "graphql", "skipped");
  assert(manifestOnly.json.warnings.some((warning) => warning.includes("manifest-only mode")));

  const strictOffline = await runReport([manifestPath, "--offline", "--strict-launch", "--json"]);
  assert.notEqual(strictOffline.status, 0);
  assertBlocker(strictOffline.json, "strict launch health cannot use --offline");
  assertCheck(strictOffline.json, "strict-launch", "fail");
  assertCheck(strictOffline.json, "live", "skipped");

  await withHealthServers(baseState({ owner: wrongOwner }), async ({ graphqlUrl, rpcUrl }) => {
    const report = await runReport([
      manifestPath,
      "--rpc-url",
      rpcUrl,
      "--graphql-url",
      graphqlUrl,
      "--expected-owner",
      manifest.ownership.lbFactoryOwner,
      "--expected-fee-recipient",
      manifest.ownership.feeRecipient,
      "--strict-launch",
      "--max-rpc-head-age-seconds",
      "3600",
      "--json"
    ]);

    assert.notEqual(report.status, 0);
    assertBlocker(report.json, "factory-owner");
    assertCheck(report.json, "factory-owner", "fail");
  });

  await withHealthServers(
    baseState({
      graphql: {
        hasIndexingErrors: true,
        indexedBlock: latestBlock - 40
      }
    }),
    async ({ graphqlUrl, rpcUrl }) => {
      const report = await runReport([
        manifestPath,
        "--rpc-url",
        rpcUrl,
        "--graphql-url",
        graphqlUrl,
        "--expected-owner",
        manifest.ownership.lbFactoryOwner,
        "--expected-fee-recipient",
        manifest.ownership.feeRecipient,
        "--strict-launch",
        "--max-rpc-head-age-seconds",
        "3600",
        "--json"
      ]);

      assert.notEqual(report.status, 0);
      assertBlocker(report.json, "GraphQL _meta.hasIndexingErrors must be false");
      assertBlocker(report.json, "GraphQL block lag 40 exceeds 20 block threshold");
      assertCheck(report.json, "graphql", "fail");
    }
  );

  console.log("Launch health helper tests passed.");
}

function baseState(overrides = {}) {
  return {
    chainId: manifest.chainId,
    feeRecipient: manifest.ownership.feeRecipient,
    graphql: {
      factoryId: manifest.contracts.lbFactory,
      hasIndexingErrors: false,
      indexedBlock: healthyIndexedBlock,
      pairCount: "2",
      ...overrides.graphql
    },
    latestBlock,
    owner: manifest.ownership.lbFactoryOwner,
    pairImplementation: manifest.contracts.lbPairImplementation,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "graphql"))
  };
}

async function withHealthServers(state, callback) {
  const rpcServer = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const result = handleRpc(state, payload.method, payload.params || []);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: payload.id, jsonrpc: "2.0", result }));
    });
  });

  const graphqlServer = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: graphqlPayload(state) }));
    });
  });

  await Promise.all([
    new Promise((resolve) => rpcServer.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => graphqlServer.listen(0, "127.0.0.1", resolve))
  ]);

  try {
    const rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
    const graphqlUrl = `http://127.0.0.1:${graphqlServer.address().port}/graphql`;
    await callback({ graphqlUrl, rpcUrl });
  } finally {
    await Promise.all([
      new Promise((resolve) => rpcServer.close(resolve)),
      new Promise((resolve) => graphqlServer.close(resolve))
    ]);
  }
}

function handleRpc(state, method, params) {
  if (method === "eth_chainId") return toQuantity(state.chainId);
  if (method === "eth_blockNumber") return toQuantity(state.latestBlock);
  if (method === "eth_getBlockByNumber") {
    return {
      hash: `0x${"a".repeat(64)}`,
      number: toQuantity(state.latestBlock),
      timestamp: toQuantity(Math.floor(Date.now() / 1000))
    };
  }
  if (method === "eth_call") {
    const data = String(params?.[0]?.data || "").slice(0, 10).toLowerCase();
    if (data === selectors.owner) return encodeAddress(state.owner);
    if (data === selectors.feeRecipient) return encodeAddress(state.feeRecipient);
    if (data === selectors.pairImplementation) return encodeAddress(state.pairImplementation);
    return `0x${"0".repeat(64)}`;
  }
  throw new Error(`unexpected RPC method: ${method}`);
}

function graphqlPayload(state) {
  return {
    _meta: {
      block: {
        hash: `0x${"b".repeat(64)}`,
        number: state.graphql.indexedBlock
      },
      hasIndexingErrors: state.graphql.hasIndexingErrors
    },
    factories: [
      {
        id: state.graphql.factoryId,
        pairCount: state.graphql.pairCount,
        presetCount: "4",
        quoteAssetCount: "3"
      }
    ],
    pairs: [
      {
        activeId: "8388608",
        depositCount: "1",
        id: "0x2222222222222222222222222222222222222222",
        reserveX: "1000000000000000000",
        reserveY: "2000000000000000000",
        swapCount: "1",
        withdrawCount: "0"
      }
    ]
  };
}

function runReport(args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ["scripts/release/check-launch-health.cjs", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: scrubbedEnv
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch (error) {
        error.message = `${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ json, status, stderr, stdout });
    });
  });
}

function assertCheck(report, name, status) {
  const check = report.checks.find((item) => item.name === name);
  assert(check, `missing check ${name}`);
  assert.equal(check.status, status, JSON.stringify(check, null, 2));
  return check;
}

function assertBlocker(report, text) {
  assert(
    report.launchBlockers.some((blocker) => blocker.includes(text)),
    `expected launch blocker containing ${text}; got ${JSON.stringify(report.launchBlockers, null, 2)}`
  );
}

function encodeAddress(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function toQuantity(value) {
  return `0x${Number(value).toString(16)}`;
}

function makeScrubbedEnv() {
  const env = { ...process.env };
  for (const key of [
    "LAUNCH_HEALTH_GRAPHQL_URL",
    "LAUNCH_HEALTH_RPC_URL",
    "ROBINHOOD_FEE_RECIPIENT",
    "ROBINHOOD_PRODUCTION_OWNER"
  ]) {
    delete env[key];
  }
  return env;
}
