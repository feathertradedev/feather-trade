#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const manifestPath = "deployments/examples/robinhood-testnet.example.json";
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, manifestPath), "utf8"));
const pair = "0x1111111111111111111111111111111111111111";
const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const startBlock = 88727015;
const factoryDeploymentBlock = startBlock + 20;
const latestBlock = startBlock + 120;
const scrubbedEnv = makeScrubbedEnv();

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const result = handleRpc(payload.method, payload.params || []);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: payload.id, jsonrpc: "2.0", result }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const rpcUrl = `http://127.0.0.1:${port}`;
    const output = await runNodeScript(
      process.execPath,
      [
        "scripts/robinhood/check-rpc-readiness.cjs",
        manifestPath,
        "--rpc-url",
        rpcUrl,
        "--fallback-rpc-url",
        rpcUrl,
        "--pair",
        pair,
        "--pair-historical-block",
        String(startBlock + 1),
        "--historical-block",
        String(startBlock),
        "--factory-deployment-block",
        String(factoryDeploymentBlock),
        "--max-rpc-head-age-seconds",
        "3600",
        "--json"
      ],
      { cwd: repoRoot, encoding: "utf8", env: scrubbedEnv }
    );

    const report = JSON.parse(output);
    assert.equal(report.ok, true);
    assert.equal(report.launchBlockers.length, 0);
    assert(
      report.checks.some(
        (check) =>
          check.name === "historical-factory-owner-call" &&
          check.status === "pass" &&
          check.block === factoryDeploymentBlock
      )
    );
    assert(report.checks.some((check) => check.name === "pair-historical-methods" && check.status === "pass"));
    assert(
      report.checks.some(
        (check) => check.name === "historical-factory-log-sample" && check.status === "pass" && check.toBlock === latestBlock
      )
    );

    const partial = await runNodeScriptWithStatus(
      process.execPath,
      [
        "scripts/robinhood/check-rpc-readiness.cjs",
        manifestPath,
        "--rpc-url",
        rpcUrl,
        "--max-rpc-head-age-seconds",
        "3600",
        "--json"
      ],
      { cwd: repoRoot, encoding: "utf8", env: scrubbedEnv }
    );
    assert.notEqual(partial.status, 0);
    const partialReport = JSON.parse(partial.stdout);
    assert.equal(partialReport.ok, false);
    assert(partialReport.checks.some((check) => check.name === "live-readiness-completeness" && check.status === "fail"));
    assert(partialReport.checks.some((check) => check.name === "primary-rpc" && check.status === "pass"));
    assert(!partialReport.launchBlockers.some((blocker) => blocker.includes("requires --archive-rpc-url")));
    assert(partialReport.launchBlockers.some((blocker) => blocker.includes("requires --fallback-rpc-url")));
    assert(partialReport.launchBlockers.some((blocker) => blocker.includes("requires --pair")));
    assert(partialReport.launchBlockers.some((blocker) => blocker.includes("requires --pair-historical-block")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const latestManifestPath = writeLatestManifest();
  try {
    await withRpcServers(2, async ([primaryRpcUrl, fallbackRpcUrl]) => {
      const strictOutput = await runNodeScript(
        process.execPath,
        [
          "scripts/robinhood/check-rpc-readiness.cjs",
          latestManifestPath,
          "--rpc-url",
          primaryRpcUrl,
          "--fallback-rpc-url",
          fallbackRpcUrl,
          "--pair",
          pair,
          "--pair-historical-block",
          String(startBlock + 1),
          "--historical-block",
          String(startBlock),
          "--factory-deployment-block",
          String(factoryDeploymentBlock),
          "--strict-launch",
          "--max-rpc-head-age-seconds",
          "3600",
          "--json"
        ],
        { cwd: repoRoot, encoding: "utf8", env: scrubbedEnv }
      );

      const strictReport = JSON.parse(strictOutput);
      assert.equal(strictReport.ok, true);
      assert.equal(strictReport.launchBlockers.length, 0);
      assert(!strictReport.checks.some((check) => check.name === "strict-rpc-readiness-preflight"));
      assert(strictReport.checks.some((check) => check.name === "primary-rpc" && check.status === "pass"));
      assert(strictReport.checks.some((check) => check.name === "fallback-rpc" && check.status === "pass"));
      assert(strictReport.checks.some((check) => check.name === "historical-block" && check.status === "pass"));
      assert(strictReport.checks.some((check) => check.name === "pair-historical-methods" && check.status === "pass"));
    });

    const identicalStrict = runWithFetchTrap([
      latestManifestPath,
      "--rpc-url",
      "https://primary.example/rpc",
      "--fallback-rpc-url",
      "https://primary.example/rpc",
      "--pair",
      pair,
      "--pair-historical-block",
      String(startBlock + 1),
      "--strict-launch",
      "--json"
    ]);
    assert.notEqual(identicalStrict.status, 0);
    const identicalReport = JSON.parse(identicalStrict.stdout);
    assert(
      identicalReport.launchBlockers.some((blocker) =>
        blocker.includes("strict RPC readiness fallback RPC must not be identical to the primary RPC URL")
      )
    );
    assert(identicalReport.checks.some((check) => check.name === "strict-rpc-readiness-preflight" && check.status === "fail"));
    assert(!identicalStrict.stdout.includes("FETCH_SHOULD_NOT_BE_CALLED"));
  } finally {
    fs.rmSync(path.dirname(latestManifestPath), { force: true, recursive: true });
  }

  const noFallback = runWithFetchTrap([manifestPath, "--json"]);
  assert.equal(noFallback.status, 0);
  const noFallbackReport = JSON.parse(noFallback.stdout);
  assert.equal(noFallbackReport.ok, true);
  assert(
    noFallbackReport.checks.some(
      (check) =>
        check.name === "primary-rpc" &&
        check.status === "skipped" &&
        check.message.includes("manifest.endpoints.rpcUrl is not used")
    )
  );
  assert(!JSON.stringify(noFallbackReport).includes("FETCH_SHOULD_NOT_BE_CALLED"));

  const offlineOutput = childProcess.execFileSync(
    process.execPath,
    ["scripts/robinhood/check-rpc-readiness.cjs", manifestPath, "--offline", "--json"],
    { cwd: repoRoot, encoding: "utf8", env: scrubbedEnv }
  );
  const offlineReport = JSON.parse(offlineOutput);
  assert.equal(offlineReport.ok, true);
  assert(offlineReport.warnings.some((warning) => warning.includes("not launch evidence")));

  const strictPublic = runWithFetchTrap(
    [
      manifestPath,
      "--rpc-url",
      "https://rpc.testnet.chain.robinhood.com",
      "--fallback-rpc-url",
      "https://fallback.example/rpc",
      "--strict-launch",
      "--json"
    ]
  );
  assert.notEqual(strictPublic.status, 0);
  const publicReport = JSON.parse(strictPublic.stdout);
  assert(!publicReport.launchBlockers.some((blocker) => blocker.includes("public Robinhood RPC")));
  assert(publicReport.warnings.some((warning) => warning.includes("public Robinhood RPC")));
  assert(publicReport.checks.some((check) => check.name === "strict-rpc-readiness-preflight" && check.status === "fail"));
  assert(!publicReport.checks.some((check) => check.name === "primary-rpc"));
  assert(!strictPublic.stdout.includes("FETCH_SHOULD_NOT_BE_CALLED"));

  const tokenHost = "http://a1b2c3d4e5f60718293a4b5c6d7e8f90.rpc.vendor.example";
  const redacted = runWithFetchTrap([manifestPath, "--rpc-url", tokenHost, "--json"]);
  assert.notEqual(redacted.status, 0);
  const redactedReport = JSON.parse(redacted.stdout);
  const redactedPrimary = redactedReport.checks.find((check) => check.name === "primary-rpc");
  assert.equal(redactedPrimary.endpointHost, "[redacted].rpc.vendor.example");
  assert(!JSON.stringify(redactedReport).includes("a1b2c3d4e5f60718293a4b5c6d7e8f90"));

  console.log("Robinhood RPC readiness helper tests passed.");
}

function runNodeScript(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, options);
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
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve(stdout);
        return;
      }
      const error = new Error(`${command} ${args.join(" ")} exited with ${status ?? signal}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function runNodeScriptWithStatus(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, options);
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
    child.on("close", (status, signal) => {
      resolve({ signal, status, stderr, stdout });
    });
  });
}

function runWithFetchTrap(args) {
  const argv = [process.execPath, "scripts/robinhood/check-rpc-readiness.cjs", ...args];
  const script = `
global.fetch = async () => {
  throw new Error("FETCH_SHOULD_NOT_BE_CALLED");
};
process.argv = ${JSON.stringify(argv)};
require("./scripts/robinhood/check-rpc-readiness.cjs");
`;
  return childProcess.spawnSync(process.execPath, ["-e", script], { cwd: repoRoot, encoding: "utf8", env: scrubbedEnv });
}

async function withRpcServers(count, callback) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const payload = JSON.parse(body);
          const result = handleRpc(payload.method, payload.params || []);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: payload.id, jsonrpc: "2.0", result }));
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      servers.push(server);
    }

    await callback(servers.map((server) => `http://127.0.0.1:${server.address().port}`));
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

function writeLatestManifest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-rpc-readiness-"));
  const latestManifestPath = path.join(dir, "latest.json");
  fs.writeFileSync(latestManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return latestManifestPath;
}

function makeScrubbedEnv() {
  const env = { ...process.env };
  for (const name of [
    "ROBINHOOD_RPC_READINESS_RPC_URL",
    "ROBINHOOD_RPC_URL",
    "ROBINHOOD_TESTNET_RPC_URL",
    "ROBINHOOD_MAINNET_ARCHIVE_RPC_URL",
    "ROBINHOOD_TESTNET_ARCHIVE_RPC_URL",
    "ROBINHOOD_ARCHIVE_RPC_URL",
    "INDEXER_ROBINHOOD_RPC_URL",
    "GRAPH_NODE_ARCHIVE_RPC_URL",
    "ROBINHOOD_MAINNET_FALLBACK_RPC_URL",
    "ROBINHOOD_TESTNET_FALLBACK_RPC_URL",
    "ROBINHOOD_FALLBACK_RPC_URL",
    "ROBINHOOD_RPC_CHECK_FACTORY_BLOCK",
    "ROBINHOOD_RPC_CHECK_PAIR",
    "ROBINHOOD_RPC_CHECK_PAIR_BLOCK"
  ]) {
    delete env[name];
  }
  return env;
}

function handleRpc(method, params) {
  if (method === "eth_chainId") return toQuantity(46630);
  if (method === "eth_blockNumber") return toQuantity(latestBlock);
  if (method === "web3_clientVersion") return "mock-robinhood-rpc/1.0";
  if (method === "eth_getLogs") return [];
  if (method === "eth_getBlockByNumber") {
    const blockNumber = params[0] === "latest" ? latestBlock : Number.parseInt(params[0], 16);
    return {
      hash: `0x${String(blockNumber).padStart(64, "0").slice(0, 64)}`,
      number: toQuantity(blockNumber),
      timestamp: toQuantity(Math.floor(Date.now() / 1000))
    };
  }
  if (method === "eth_call") {
    const data = String(params[0].data || "").toLowerCase();
    if (data === "0x8da5cb5b") {
      const blockNumber = params[1] === "latest" ? latestBlock : Number.parseInt(params[1], 16);
      return blockNumber < factoryDeploymentBlock ? "0x" : encodeAddress(owner);
    }
    if (data === "0xdbe65edc") return encodeUint(8388608n);
    if (data === "0x0902f1ac") return `${encodeUint(10n)}${encodeUint(20n).slice(2)}`;
    if (data.startsWith("0x0abe9688")) return `${encodeUint(3n)}${encodeUint(4n).slice(2)}`;
    if (data.startsWith("0xbd85b039")) return encodeUint(5n);
  }
  throw new Error(`unhandled RPC method ${method}`);
}

function encodeAddress(value) {
  return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}

function encodeUint(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function toQuantity(value) {
  return `0x${Number(value).toString(16)}`;
}
