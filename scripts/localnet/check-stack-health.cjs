#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    strict: true,
    checks: {},
    errors: [{ code: "HEALTH_CHECK", message: publicMessage(error) }]
  })}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.strict || !options.json) throw new Error("--strict and --json are required");
  const manifestText = fs.readFileSync(options.manifest, "utf8");
  const manifest = JSON.parse(manifestText);
  validateManifest(manifest);

  const deadline = Date.now() + options.timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const checks = await inspect(options, manifest, manifestText);
      process.stdout.write(`${JSON.stringify({ ok: true, strict: true, checks, errors: [] })}\n`);
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() + options.pollMs > deadline) break;
      await delay(options.pollMs);
    }
  }
  throw lastError ?? new Error("Stack health timed out");
}

async function inspect(options, manifest, manifestText) {
  const factory = manifest.contracts.lbFactory.toLowerCase();
  const pair = manifest.seededPools.wnativeUsdc.pair.toLowerCase();
  const manifestSha256 = crypto.createHash("sha256").update(manifestText).digest("hex");
  const [rpcChainId, rpcBlock, indexer, analytics, web] = await Promise.all([
    rpc(options.rpcUrl, "eth_chainId", []),
    rpc(options.rpcUrl, "eth_getBlockByNumber", ["latest", false]),
    graphql(options.indexerUrl, `query StackIndexerHealth($factory: ID!, $pair: ID!) {
      _meta { block { number hash } hasIndexingErrors }
      factory(id: $factory) { id pairCount }
      pair(id: $pair) { id reserveX reserveY }
    }`, { factory, pair }),
    graphql(`${options.analyticsUrl.replace(/\/$/, "")}/graphql`, `query StackAnalyticsHealth {
      analyticsHealth {
        status headBlock headHash headTimestamp fresh partialEventCount backfillStatus backfillError
        coverageStartTimestamp coverageThroughTimestamp missingPriceTokens
        prices { token status }
      }
    }`),
    fetchWeb(options.webUrl, {
      analyticsUrl: options.analyticsUrl,
      indexerUrl: options.indexerUrl,
      manifestPath: options.manifest,
      manifestSha256,
      rpcUrl: options.rpcUrl
    })
  ]);

  const chainId = Number(BigInt(rpcChainId));
  const rpcNumber = Number(BigInt(rpcBlock?.number ?? "-1"));
  const rpcHash = normalizeHash(rpcBlock?.hash, "RPC head hash");
  const indexerMeta = indexer?._meta;
  const indexerNumber = integer(indexerMeta?.block?.number, "Indexer head number");
  const indexerHash = normalizeHash(indexerMeta?.block?.hash, "Indexer head hash");
  const analyticsHealth = analytics?.analyticsHealth;
  const analyticsNumber = integer(analyticsHealth?.headBlock, "Analytics head number");
  const analyticsHash = normalizeHash(analyticsHealth?.headHash, "Analytics head hash");
  const analyticsTimestamp = integer(analyticsHealth?.headTimestamp, "Analytics head timestamp");
  const coverageThroughTimestamp = integer(analyticsHealth?.coverageThroughTimestamp, "Analytics coverage-through timestamp");

  if (chainId !== manifest.chainId) throw coded("CHAIN_ID", `RPC chain ${chainId} does not match manifest chain ${manifest.chainId}`);
  if (normalizeEndpoint(manifest?.endpoints?.rpcUrl, "Manifest RPC endpoint") !== options.rpcUrl) {
    throw coded("MANIFEST_ENDPOINT", "Manifest RPC endpoint does not match the owned stack RPC");
  }
  if (normalizeEndpoint(manifest?.endpoints?.indexerUrl, "Manifest indexer endpoint") !== options.indexerUrl) {
    throw coded("MANIFEST_ENDPOINT", "Manifest indexer endpoint does not match the owned stack indexer");
  }
  if (indexerMeta?.hasIndexingErrors !== false) throw coded("INDEXER_ERRORS", "Indexer metadata reports errors or is incomplete");
  if (indexer?.factory?.id?.toLowerCase() !== factory || BigInt(indexer.factory.pairCount ?? "0") < 1n) {
    throw coded("INDEXER_DATA", "Indexer does not contain the manifest factory");
  }
  if (indexer?.pair?.id?.toLowerCase() !== pair || BigInt(indexer.pair.reserveX ?? "0") <= 0n || BigInt(indexer.pair.reserveY ?? "0") <= 0n) {
    throw coded("INDEXER_DATA", "Indexer does not contain the funded manifest seeded pair");
  }
  if (rpcNumber !== indexerNumber || rpcNumber !== analyticsNumber || rpcHash !== indexerHash || rpcHash !== analyticsHash) {
    throw coded("HEAD_MISMATCH", "RPC, indexer, and analytics heads do not match exactly");
  }
  if (analyticsHealth?.status !== "READY" || analyticsHealth?.fresh !== true) {
    throw coded("ANALYTICS_NOT_READY", "Analytics is not READY and fresh");
  }
  if (analyticsHealth?.partialEventCount !== 0) throw coded("PARTIAL_EVENTS", "Analytics reports partial events");
  if (analyticsHealth?.backfillStatus !== "complete" || analyticsHealth?.backfillError != null) {
    throw coded("BACKFILL_INCOMPLETE", "Analytics canonical backfill is incomplete");
  }
  if (analyticsHealth?.coverageStartTimestamp == null || analyticsHealth?.coverageThroughTimestamp == null) {
    throw coded("COVERAGE_INCOMPLETE", "Analytics coverage bounds are incomplete");
  }
  if (coverageThroughTimestamp < analyticsTimestamp) {
    throw coded("COVERAGE_INCOMPLETE", "Analytics coverage does not reach the canonical head timestamp");
  }
  if (!Array.isArray(analyticsHealth?.missingPriceTokens) || analyticsHealth.missingPriceTokens.length !== 0) {
    throw coded("MISSING_PRICES", "Analytics reports missing price tokens");
  }
  if (!Array.isArray(analyticsHealth?.prices) || analyticsHealth.prices.length === 0 || analyticsHealth.prices.some((price) => price?.status !== "available")) {
    throw coded("PRICE_NOT_READY", "Analytics price policies are not all available");
  }

  const analyticsData = await graphql(`${options.analyticsUrl.replace(/\/$/, "")}/graphql`, `query StackAnalyticsData(
    $pair: ID!, $from: Int!, $to: Int!
  ) {
    poolMetrics(first: 100) {
      nodes { pair tvlUsdE18 volume24hUsdE18 fees24hUsdE18 status missingPriceTokens }
    }
    pairCandles(pair: $pair, interval: HOUR, fromTimestamp: $from, toTimestamp: $to, first: 100) {
      nodes { pair openUsdE18 highUsdE18 lowUsdE18 closeUsdE18 status missingPriceTokens }
    }
  }`, { pair, from: Math.max(0, analyticsTimestamp - 86_400), to: analyticsTimestamp });
  const metric = analyticsData?.poolMetrics?.nodes?.find((row) => row?.pair?.toLowerCase() === pair);
  if (!metric || metric.status !== "READY" || [metric.tvlUsdE18, metric.volume24hUsdE18, metric.fees24hUsdE18].some((value) => value == null) || metric.missingPriceTokens?.length !== 0) {
    throw coded("ANALYTICS_DATA", "Analytics seeded-pair metrics are not complete and READY");
  }
  const candles = analyticsData?.pairCandles?.nodes;
  if (!Array.isArray(candles) || candles.length === 0 || candles.some((row) =>
    row?.pair?.toLowerCase() !== pair || row.status !== "READY" ||
    [row.openUsdE18, row.highUsdE18, row.lowUsdE18, row.closeUsdE18].some((value) => value == null) ||
    row.missingPriceTokens?.length !== 0
  )) {
    throw coded("ANALYTICS_DATA", "Analytics seeded-pair candles are empty or incomplete");
  }

  return {
    manifest: {
      chainId: manifest.chainId,
      environment: manifest.environment,
      rpcUrl: options.rpcUrl,
      indexerUrl: options.indexerUrl,
      sha256: manifestSha256
    },
    rpc: { chainId, headBlock: rpcNumber, headHash: rpcHash },
    indexer: { headBlock: indexerNumber, headHash: indexerHash, hasIndexingErrors: false, factory, seededPair: pair },
    analytics: {
      headBlock: analyticsNumber,
      headHash: analyticsHash,
      status: analyticsHealth.status,
      fresh: analyticsHealth.fresh,
      headTimestamp: analyticsTimestamp,
      partialEventCount: analyticsHealth.partialEventCount,
      backfillStatus: analyticsHealth.backfillStatus,
      pricesAvailable: analyticsHealth.prices.length,
      seededPair: pair,
      candleCount: candles.length
    },
    web: { ...web, configuredAnalyticsUrl: options.analyticsUrl }
  };
}

function parseArgs(argv) {
  const options = {
    strict: false,
    json: false,
    manifest: process.env.LOCALNET_MANIFEST_PATH || path.join(root, "deployments/localnet/latest.json"),
    rpcUrl: process.env.LOCALNET_RPC_URL || "http://127.0.0.1:18545",
    indexerUrl: process.env.INDEXER_LOCAL_ENDPOINT || "http://127.0.0.1:18000/subgraphs/name/robinhood-lb/localnet",
    analyticsUrl: process.env.ANALYTICS_LOCAL_ENDPOINT || "http://127.0.0.1:18787",
    webUrl: process.env.FEATHER_WEB_URL || "http://127.0.0.1:15173",
    timeoutMs: 120_000,
    pollMs: 500
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--strict") options.strict = true;
    else if (value === "--json") options.json = true;
    else if (value === "--manifest") options.manifest = required(argv, ++index, value);
    else if (value === "--rpc-url") options.rpcUrl = url(required(argv, ++index, value), value);
    else if (value === "--indexer-url") options.indexerUrl = url(required(argv, ++index, value), value);
    else if (value === "--analytics-url") options.analyticsUrl = url(required(argv, ++index, value), value);
    else if (value === "--web-url") options.webUrl = url(required(argv, ++index, value), value);
    else if (value === "--timeout-ms") options.timeoutMs = positiveInteger(required(argv, ++index, value), value);
    else if (value === "--poll-ms") options.pollMs = positiveInteger(required(argv, ++index, value), value);
    else throw new Error(`Unknown option ${value}`);
  }
  return options;
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== "lb.localnet.v1" || manifest?.environment !== "localnet") {
    throw coded("MANIFEST", "Manifest is not a localnet deployment manifest");
  }
  if (!Number.isSafeInteger(manifest.chainId) || manifest.chainId <= 0) throw coded("MANIFEST", "Manifest chain ID is invalid");
  if (!/^0x[0-9a-fA-F]{40}$/.test(manifest?.contracts?.lbFactory ?? "")) throw coded("MANIFEST", "Manifest factory address is invalid");
  if (!/^0x[0-9a-fA-F]{40}$/.test(manifest?.seededPools?.wnativeUsdc?.pair ?? "")) throw coded("MANIFEST", "Manifest seeded pair address is invalid");
}

async function rpc(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw coded("RPC_HTTP", `RPC returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error || payload.result == null) throw coded("RPC_RESPONSE", "RPC returned an error or incomplete result");
  return payload.result;
}

async function graphql(endpoint, query, variables = undefined) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw coded("GRAPHQL_HTTP", `GraphQL returned HTTP ${response.status}`);
  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) throw coded("GRAPHQL_RESPONSE", "GraphQL returned errors");
  if (!payload.data) throw coded("GRAPHQL_RESPONSE", "GraphQL data is missing");
  return payload.data;
}

async function fetchWeb(endpoint, expected) {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.toLowerCase().includes("text/html")) throw coded("WEB_HTTP", "Web app is not serving HTML");
  const configResponse = await fetch(new URL("/src/config.ts", endpoint), { signal: AbortSignal.timeout(5_000) });
  const configContentType = configResponse.headers.get("content-type") || "";
  if (!configResponse.ok || !configContentType.toLowerCase().includes("javascript")) {
    throw coded("WEB_CONFIG", "Web app is not serving its transformed runtime config");
  }
  const configSource = await configResponse.text();
  const match = configSource.match(/import\.meta\.env\s*=\s*(\{[^\n]*\});/);
  if (!match) throw coded("WEB_CONFIG", "Web runtime config does not expose transformed Vite environment data");
  let environment;
  try {
    environment = JSON.parse(match[1]);
  } catch {
    throw coded("WEB_CONFIG", "Web runtime config contains invalid Vite environment data");
  }
  let runtimeEndpoints;
  try {
    runtimeEndpoints = {
      analyticsUrl: normalizeEndpoint(environment.VITE_ANALYTICS_LOCALNET_URL, "Web analytics endpoint"),
      indexerUrl: normalizeEndpoint(environment.VITE_LOCALNET_INDEXER_URL, "Web indexer endpoint"),
      rpcUrl: normalizeEndpoint(environment.VITE_LOCALNET_RPC_URL, "Web RPC endpoint")
    };
  } catch {
    throw coded("WEB_CONFIG", "Web runtime endpoints are missing or invalid");
  }
  if (
    runtimeEndpoints.analyticsUrl !== expected.analyticsUrl ||
    runtimeEndpoints.indexerUrl !== expected.indexerUrl ||
    runtimeEndpoints.rpcUrl !== expected.rpcUrl
  ) {
    throw coded("WEB_CONFIG", "Web runtime endpoints do not match the owned stack");
  }
  if (path.resolve(environment.VITE_LOCALNET_MANIFEST_PATH ?? "") !== path.resolve(expected.manifestPath)) {
    throw coded("WEB_CONFIG", "Web runtime manifest path does not match the health manifest");
  }
  if (environment.VITE_LOCALNET_MANIFEST_SHA256 !== expected.manifestSha256) {
    throw coded("WEB_CONFIG", "Web runtime manifest digest does not match the health manifest");
  }
  return {
    status: response.status,
    contentType: "text/html",
    runtimeConfig: {
      analyticsUrl: expected.analyticsUrl,
      indexerUrl: expected.indexerUrl,
      manifestSha256: expected.manifestSha256,
      rpcUrl: expected.rpcUrl
    }
  };
}

function required(argv, index, option) {
  if (!argv[index] || argv[index].startsWith("--")) throw new Error(`Missing value for ${option}`);
  return argv[index];
}

function url(value, option) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${option} must use HTTP or HTTPS`);
  return parsed.toString().replace(/\/$/, "");
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw coded("HEAD_INVALID", `${label} is invalid`);
  return parsed;
}

function normalizeHash(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? "")) throw coded("HEAD_INVALID", `${label} is invalid`);
  return value.toLowerCase();
}

function normalizeEndpoint(value, label) {
  if (typeof value !== "string") throw coded("MANIFEST_ENDPOINT", `${label} is missing`);
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw coded("MANIFEST_ENDPOINT", `${label} is invalid`);
  }
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicMessage(error) {
  const code = typeof error?.code === "string" ? error.code : "FAILED";
  return `${code}: ${error instanceof Error ? error.message : "Stack health failed"}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
