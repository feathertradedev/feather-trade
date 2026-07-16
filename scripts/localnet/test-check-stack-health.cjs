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
const weth = "0x3333333333333333333333333333333333333333";
const usdc = "0x4444444444444444444444444444444444444444";
const pairCreatedAtBlock = 18;
const pairCreatedAtTimestamp = 1_700_000_012;
const headTimestamp = 1_700_000_042;
const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "feather-stack-health-"));
const manifestPath = path.join(manifestDir, "manifest.json");

main().finally(() => fs.rmSync(manifestDir, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const nextHash = `0x${"44".repeat(32)}`;
  const state = {
    analyticsData: true,
    analyticsHash: hash,
    analyticsStatus: "READY",
    candlePriceSource: "active-bin-quote-usd",
    candleQuoteToken: usdc,
    candleFirstBlock: String(pairCreatedAtBlock),
    hourCandles: true,
    indexerData: true,
    indexerPairCount: "1",
    indexerTokenX: weth,
    indexerTokenY: usdc,
    metricTokenX: weth,
    metricTokenY: usdc,
    minuteCandles: true,
    prices: availablePrices(),
    rpcHead: 42,
    webConfig: null
  };
  const rpcServer = await serve(async (request, response, body) => {
    const payload = JSON.parse(body);
    let result;
    if (payload.method === "eth_chainId") {
      result = "0x7a69";
    } else if (payload.params?.[0] === "0x2a") {
      result = { number: "0x2a", hash };
    } else {
      result = { number: `0x${state.rpcHead.toString(16)}`, hash: state.rpcHead === 42 ? hash : nextHash };
    }
    json(response, { jsonrpc: "2.0", id: payload.id, result });
  });
  const indexerServer = await serve(async (_request, response) => {
    json(response, { data: {
      _meta: { block: { number: 42, hash }, hasIndexingErrors: false },
      factory: state.indexerData ? { id: factory, pairCount: state.indexerPairCount } : null,
      pair: state.indexerData ? {
        id: pair,
        reserveX: "1",
        reserveY: "1",
        createdAtBlock: String(pairCreatedAtBlock),
        createdAtTimestamp: String(pairCreatedAtTimestamp),
        tokenX: { id: state.indexerTokenX, address: state.indexerTokenX },
        tokenY: { id: state.indexerTokenY, address: state.indexerTokenY }
      } : null
    } });
  });
  const analyticsServer = await serve(async (_request, response, body) => {
    if (JSON.parse(body).query.includes("StackAnalyticsData")) {
      json(response, { data: {
        poolMetrics: { nodes: state.analyticsData ? [{
          pair,
          tokenX: state.metricTokenX,
          tokenY: state.metricTokenY,
          tvlUsdE18: "2",
          volume24hUsdE18: "1",
          fees24hUsdE18: "1",
          priceUsdE18: "1",
          status: "READY",
          missingPriceTokens: []
        }] : [] },
        minuteCandles: { nodes: state.analyticsData && state.minuteCandles ? [candle("ONE_MINUTE", state)] : [] },
        hourCandles: { nodes: state.analyticsData && state.hourCandles ? [candle("HOUR", state)] : [] }
      } });
      return;
    }
    json(response, { data: { analyticsHealth: {
      status: state.analyticsStatus,
      headBlock: "42",
      headHash: state.analyticsHash,
      headTimestamp,
      fresh: true,
      partialEventCount: 0,
      backfillStatus: "complete",
      backfillError: null,
      coverageStartTimestamp: "1",
      coverageThroughTimestamp: String(headTimestamp),
      missingPriceTokens: [],
      prices: state.prices
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
      tokens: { weth, usdc },
      seededPools: { wethUsdc: { pair, tokenX: weth, tokenY: usdc } }
    })}\n`);
    state.webConfig = {
      VITE_ANALYTICS_LOCALNET_URL: `${endpoints.analytics}/graphql`,
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
    assert.equal(result.checks.analytics.pricesAvailable, 2);
    assert.equal(result.checks.analytics.firstMinuteCandleBlock, pairCreatedAtBlock);
    assert.equal(result.checks.analytics.firstMinuteCandleTimestamp, Math.floor(pairCreatedAtTimestamp / 60) * 60);
    assert.equal(result.checks.analytics.minuteCandleCount, 1);
    assert.equal(result.checks.analytics.hourCandleCount, 1);
    assert.equal(result.checks.web.status, 200);

    state.rpcHead = 43;
    const boundedLiveLag = await runHealth(endpoints);
    assert.equal(boundedLiveLag.status, 0, `${boundedLiveLag.stderr}\n${boundedLiveLag.stdout}`);
    assert.equal(JSON.parse(boundedLiveLag.stdout).checks.rpc.indexedHeadLagBlocks, 1);
    state.rpcHead = 42;

    const originalManifest = fs.readFileSync(manifestPath, "utf8");
    const extraPoolManifest = JSON.parse(originalManifest);
    extraPoolManifest.seededPools.extra = { pair, tokenX: weth, tokenY: usdc };
    fs.writeFileSync(manifestPath, `${JSON.stringify(extraPoolManifest)}\n`);
    state.webConfig.VITE_LOCALNET_MANIFEST_SHA256 = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
    const extraSeededPool = await runHealth(endpoints);
    assert.equal(extraSeededPool.status, 1);
    assert.match(JSON.parse(extraSeededPool.stdout).errors[0].message, /MANIFEST/);
    fs.writeFileSync(manifestPath, originalManifest);
    state.webConfig.VITE_LOCALNET_MANIFEST_SHA256 = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");

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

    state.indexerPairCount = "2";
    const extraIndexedPair = await runHealth(endpoints);
    assert.equal(extraIndexedPair.status, 1);
    assert.match(JSON.parse(extraIndexedPair.stdout).errors[0].message, /INDEXER_DATA/);
    state.indexerPairCount = "1";

    state.indexerTokenX = usdc;
    const wrongIndexedTokens = await runHealth(endpoints);
    assert.equal(wrongIndexedTokens.status, 1);
    assert.match(JSON.parse(wrongIndexedTokens.stdout).errors[0].message, /INDEXER_DATA/);
    state.indexerTokenX = weth;

    state.prices = availablePrices().slice(1);
    const missingWethPrice = await runHealth(endpoints);
    assert.equal(missingWethPrice.status, 1);
    assert.match(JSON.parse(missingWethPrice.stdout).errors[0].message, /PRICE_NOT_READY/);
    state.prices = availablePrices();

    state.prices = [...availablePrices(), { token: factory, source: "fixed-test", status: "available" }];
    const extraPricePolicy = await runHealth(endpoints);
    assert.equal(extraPricePolicy.status, 1);
    assert.match(JSON.parse(extraPricePolicy.stdout).errors[0].message, /PRICE_NOT_READY/);
    state.prices = availablePrices();

    state.metricTokenX = usdc;
    const wrongMetricTokens = await runHealth(endpoints);
    assert.equal(wrongMetricTokens.status, 1);
    assert.match(JSON.parse(wrongMetricTokens.stdout).errors[0].message, /ANALYTICS_DATA/);
    state.metricTokenX = weth;

    state.minuteCandles = false;
    const missingMinuteCandles = await runHealth(endpoints);
    assert.equal(missingMinuteCandles.status, 1);
    assert.match(JSON.parse(missingMinuteCandles.stdout).errors[0].message, /ANALYTICS_DATA/);
    state.minuteCandles = true;

    state.hourCandles = false;
    const missingHourCandles = await runHealth(endpoints);
    assert.equal(missingHourCandles.status, 1);
    assert.match(JSON.parse(missingHourCandles.stdout).errors[0].message, /ANALYTICS_DATA/);
    state.hourCandles = true;

    state.candleQuoteToken = weth;
    const wrongCandleQuote = await runHealth(endpoints);
    assert.equal(wrongCandleQuote.status, 1);
    assert.match(JSON.parse(wrongCandleQuote.stdout).errors[0].message, /ANALYTICS_DATA/);
    state.candleQuoteToken = usdc;

    state.candlePriceSource = "trusted-token-usd";
    const wrongCandleSource = await runHealth(endpoints);
    assert.equal(wrongCandleSource.status, 1);
    assert.match(JSON.parse(wrongCandleSource.stdout).errors[0].message, /ANALYTICS_DATA/);
    state.candlePriceSource = "active-bin-quote-usd";

    state.candleFirstBlock = String(pairCreatedAtBlock + 1);
    const lateFirstCandle = await runHealth(endpoints);
    assert.equal(lateFirstCandle.status, 1);
    assert.match(JSON.parse(lateFirstCandle.stdout).errors[0].message, /ANALYTICS_DATA/);
    state.candleFirstBlock = String(pairCreatedAtBlock);

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
    state.webConfig.VITE_ANALYTICS_LOCALNET_URL = `${endpoints.analytics}/graphql`;

    const help = childProcess.spawnSync("bash", [stackScript, "help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /up --fresh/);
    assert.match(help.stdout, /strict manifest\/RPC\/indexer\/analytics\/web health check/);
    const stackSource = fs.readFileSync(stackScript, "utf8");
    assert.ok(stackSource.indexOf("check-port-available.cjs") < stackSource.indexOf("nohup anvil"), "collision probe must run before Anvil launch");
    assert.ok((stackSource.match(/kill -0 \"\$anvil_pid\"/g) ?? []).length >= 3, "Anvil PID must be checked before, during, and after RPC readiness");
    assert.ok(stackSource.indexOf("check-stack-health.cjs") < stackSource.indexOf("node \"$ROOT_DIR/packages/dev-market-activity/dist/src/cli.js\" start"), "continuous activity must start only after stable stack health");
    assert.match(stackSource, /wait_market_activity/, "continuous activity startup must be health-gated");
  } finally {
    await Promise.all([rpcServer, indexerServer, analyticsServer, webServer].map(close));
  }
  assert.equal(await isLoopbackPortAvailable(occupiedRpcPort), true, "released RPC ports must become available");

  console.log("Local full-stack health fixtures passed: bounded canonical parity, analytics readiness, fail-closed mismatch, and safe shell help.");
}

function availablePrices() {
  return [
    { token: weth, source: "fixed-test", status: "available" },
    { token: usdc, source: "fixed-test", status: "available" }
  ];
}

function candle(interval, state) {
  const price = "2000000000000000000000";
  return {
    pair,
    interval,
    startTimestamp: interval === "ONE_MINUTE"
      ? Math.floor(pairCreatedAtTimestamp / 60) * 60
      : Math.floor(pairCreatedAtTimestamp / 3_600) * 3_600,
    openUsdE18: price,
    highUsdE18: price,
    lowUsdE18: price,
    closeUsdE18: price,
    status: "READY",
    missingPriceTokens: [],
    firstBlock: state.candleFirstBlock,
    priceSource: state.candlePriceSource,
    quoteToken: state.candleQuoteToken
  };
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
