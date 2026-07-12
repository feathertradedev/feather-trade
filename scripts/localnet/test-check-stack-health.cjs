#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { isLoopbackPortAvailable } = require("./check-port-available.cjs");

const root = path.resolve(__dirname, "../..");
const healthScript = path.join(root, "scripts/localnet/check-stack-health.cjs");
const stackScript = path.join(root, "scripts/localnet/stack.sh");
const hash = `0x${"22".repeat(32)}`;
const factory = "0x1111111111111111111111111111111111111111";
const pair = "0x2222222222222222222222222222222222222222";
const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "feather-stack-health-"));
const manifestPath = path.join(manifestDir, "manifest.json");

main().finally(() => fs.rmSync(manifestDir, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const state = { analyticsData: true, analyticsHash: hash, analyticsStatus: "READY", indexerData: true, webConfig: null };
  const rpcServer = await serve(async (request, response, body) => {
    const payload = JSON.parse(body);
    const result = payload.method === "eth_chainId"
      ? "0x7a69"
      : { number: "0x2a", hash };
    json(response, { jsonrpc: "2.0", id: payload.id, result });
  });
  const indexerServer = await serve(async (_request, response) => {
    json(response, { data: {
      _meta: { block: { number: 42, hash }, hasIndexingErrors: false },
      factory: state.indexerData ? { id: factory, pairCount: "1" } : null,
      pair: state.indexerData ? { id: pair, reserveX: "1", reserveY: "1" } : null
    } });
  });
  const analyticsServer = await serve(async (_request, response, body) => {
    if (JSON.parse(body).query.includes("StackAnalyticsData")) {
      json(response, { data: {
        poolMetrics: { nodes: state.analyticsData ? [{ pair, tvlUsdE18: "2", volume24hUsdE18: "1", fees24hUsdE18: "1", status: "READY", missingPriceTokens: [] }] : [] },
        pairCandles: { nodes: state.analyticsData ? [{ pair, openUsdE18: "1", highUsdE18: "1", lowUsdE18: "1", closeUsdE18: "1", status: "READY", missingPriceTokens: [] }] : [] }
      } });
      return;
    }
    json(response, { data: { analyticsHealth: {
      status: state.analyticsStatus,
      headBlock: "42",
      headHash: state.analyticsHash,
      headTimestamp: 2,
      fresh: true,
      partialEventCount: 0,
      backfillStatus: "complete",
      backfillError: null,
      coverageStartTimestamp: "1",
      coverageThroughTimestamp: "2",
      missingPriceTokens: [],
      prices: [{ token: "0x1111111111111111111111111111111111111111", status: "available" }]
    } } });
  });
  const webServer = await serve(async (request, response) => {
    if (request.url === "/src/config.ts") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(`import.meta.env = ${JSON.stringify(state.webConfig)};export const runtime = true;`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Feather</title>");
  });
  const occupiedRpcPort = rpcServer.address().port;

  try {
    assert.equal(await isLoopbackPortAvailable(occupiedRpcPort), false, "occupied RPC ports must fail the ownership probe");
    const endpoints = {
      rpc: endpoint(rpcServer),
      indexer: endpoint(indexerServer),
      analytics: endpoint(analyticsServer),
      web: endpoint(webServer)
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: "lb.localnet.v1",
      environment: "localnet",
      chainId: 31_337,
      endpoints: { rpcUrl: endpoints.rpc, indexerUrl: endpoints.indexer },
      contracts: { lbFactory: factory },
      seededPools: { wnativeUsdc: { pair } }
    })}\n`);
    state.webConfig = {
      VITE_ANALYTICS_LOCALNET_URL: endpoints.analytics,
      VITE_LOCALNET_INDEXER_URL: endpoints.indexer,
      VITE_LOCALNET_MANIFEST_PATH: manifestPath,
      VITE_LOCALNET_MANIFEST_SHA256: crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"),
      VITE_LOCALNET_RPC_URL: endpoints.rpc
    };
    const healthy = await runHealth(endpoints);
    assert.equal(healthy.status, 0, `${healthy.stderr}\n${healthy.stdout}`);
    const result = JSON.parse(healthy.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.strict, true);
    assert.equal(result.checks.rpc.headBlock, 42);
    assert.equal(result.checks.indexer.headHash, hash);
    assert.equal(result.checks.analytics.status, "READY");
    assert.equal(result.checks.web.status, 200);

    const originalManifest = fs.readFileSync(manifestPath, "utf8");
    const mismatchedManifest = JSON.parse(originalManifest);
    mismatchedManifest.endpoints.indexerUrl = "http://127.0.0.1:1/subgraphs/name/other";
    fs.writeFileSync(manifestPath, `${JSON.stringify(mismatchedManifest)}\n`);
    state.webConfig.VITE_LOCALNET_MANIFEST_SHA256 = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
    const endpointMismatch = await runHealth(endpoints);
    assert.equal(endpointMismatch.status, 1);
    assert.match(JSON.parse(endpointMismatch.stdout).errors[0].message, /MANIFEST_ENDPOINT/);
    fs.writeFileSync(manifestPath, originalManifest);
    state.webConfig.VITE_LOCALNET_MANIFEST_SHA256 = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");

    state.indexerData = false;
    const missingIndexerData = await runHealth(endpoints);
    assert.equal(missingIndexerData.status, 1);
    assert.match(JSON.parse(missingIndexerData.stdout).errors[0].message, /INDEXER_DATA/);
    state.indexerData = true;

    state.analyticsData = false;
    const missingAnalyticsData = await runHealth(endpoints);
    assert.equal(missingAnalyticsData.status, 1);
    assert.match(JSON.parse(missingAnalyticsData.stdout).errors[0].message, /ANALYTICS_DATA/);
    state.analyticsData = true;

    state.analyticsHash = `0x${"33".repeat(32)}`;
    const mismatch = await runHealth(endpoints);
    assert.equal(mismatch.status, 1);
    assert.match(JSON.parse(mismatch.stdout).errors[0].message, /HEAD_MISMATCH/);

    state.analyticsHash = hash;
    state.analyticsStatus = "PARTIAL";
    const partial = await runHealth(endpoints);
    assert.equal(partial.status, 1);
    assert.match(JSON.parse(partial.stdout).errors[0].message, /ANALYTICS_NOT_READY/);
    state.analyticsStatus = "READY";

    state.webConfig.VITE_ANALYTICS_LOCALNET_URL = "http://127.0.0.1:1";
    const mismatchedWebConfig = await runHealth(endpoints);
    assert.equal(mismatchedWebConfig.status, 1);
    assert.match(JSON.parse(mismatchedWebConfig.stdout).errors[0].message, /WEB_CONFIG/);
    state.webConfig.VITE_ANALYTICS_LOCALNET_URL = endpoints.analytics;

    const help = childProcess.spawnSync("bash", [stackScript, "help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /up --fresh/);
    assert.match(help.stdout, /strict manifest\/RPC\/indexer\/analytics\/web health check/);
    const stackSource = fs.readFileSync(stackScript, "utf8");
    assert.ok(stackSource.indexOf("check-port-available.cjs") < stackSource.indexOf("nohup anvil"), "collision probe must run before Anvil launch");
    assert.ok((stackSource.match(/kill -0 \"\$anvil_pid\"/g) ?? []).length >= 3, "Anvil PID must be checked before, during, and after RPC readiness");
  } finally {
    await Promise.all([rpcServer, indexerServer, analyticsServer, webServer].map(close));
  }
  assert.equal(await isLoopbackPortAvailable(occupiedRpcPort), true, "released RPC ports must become available");

  console.log("Local full-stack health fixtures passed: exact parity, analytics readiness, fail-closed mismatch, and safe shell help.");
}

function runHealth(endpoints) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [
      healthScript,
      "--strict",
      "--json",
      "--manifest", manifestPath,
      "--rpc-url", endpoints.rpc,
      "--indexer-url", endpoints.indexer,
      "--analytics-url", endpoints.analytics,
      "--web-url", endpoints.web,
      "--timeout-ms", "100",
      "--poll-ms", "25"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function serve(handler) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    await handler(request, response, Buffer.concat(chunks).toString("utf8"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function endpoint(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function json(response, body) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
