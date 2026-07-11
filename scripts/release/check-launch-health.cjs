#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const manifestValidator = path.join(repoRoot, "scripts/manifests/validate-manifests.cjs");
const defaultMaxIndexerLag = 20;
const defaultMaxRpcHeadAgeSeconds = 300;
const defaultTimeoutMs = 10_000;
const factoryOwnerSelector = "0x8da5cb5b";
const factoryFeeRecipientSelector = "0x4ccb20c0";
const factoryPairImplementationSelector = "0xaf371065";
const zeroAddress = "0x0000000000000000000000000000000000000000";

main().catch((error) => {
  printResult({
    ok: false,
    manifest: null,
    checks: [
      {
        name: "launch-health",
        status: "fail",
        message: error instanceof Error ? error.message : String(error)
      }
    ],
    warnings: [],
    launchBlockers: [error instanceof Error ? error.message : String(error)]
  });
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      JSON.stringify(
        {
          usage:
            "pnpm launch:health -- <manifest> [--manifest <manifest>] [--rpc-url <url>] [--graphql-url <url>] [--indexer-url <url>] [--expected-owner <address>] [--expected-fee-recipient <address>] [--strict-launch] [--offline] [--max-indexer-lag <blocks>] [--max-rpc-head-age-seconds <seconds>] [--timeout-ms <ms>] [--json]",
          env: [
            "LAUNCH_HEALTH_RPC_URL",
            "LAUNCH_HEALTH_GRAPHQL_URL",
            "ROBINHOOD_PRODUCTION_OWNER",
            "ROBINHOOD_FEE_RECIPIENT"
          ]
        },
        null,
        2
      )
    );
    return;
  }

  const checks = [];
  const warnings = [];
  const launchBlockers = [];
  const manifestPath = options.manifestPath ? path.resolve(repoRoot, options.manifestPath) : null;

  if (!manifestPath) {
    checks.push({
      name: "manifest",
      status: "fail",
      message: "missing Robinhood deployment manifest path"
    });
    launchBlockers.push("missing Robinhood deployment manifest path");
    finish({ manifest: null, checks, warnings, launchBlockers });
    return;
  }

  const manifestDisplayPath = path.relative(repoRoot, manifestPath);
  const manifest = readManifest(manifestPath, manifestDisplayPath, checks, launchBlockers);
  if (!manifest) {
    finish({ manifest: null, checks, warnings, launchBlockers });
    return;
  }

  const manifestSummary = {
    path: manifestDisplayPath,
    environment: manifest.environment,
    chainId: manifest.chainId,
    schemaVersion: manifest.schemaVersion,
    startBlock: manifest.startBlock
  };

  if (options.offline) {
    addManifestWarnings(manifest, checks, warnings);
    if (options.strictLaunch) {
      const message = "strict launch health cannot use --offline; provide live RPC and GraphQL endpoints";
      checks.push({
        name: "strict-launch",
        status: "fail",
        message
      });
      launchBlockers.push(message);
    }
    checks.push({
      name: "live",
      status: "skipped",
      message: "offline mode skips RPC and GraphQL checks"
    });
    warnings.push("offline launch health is suitable for no-secret CI, but it is not launch evidence for #61");
    finish({ manifest: manifestSummary, checks, warnings, launchBlockers });
    return;
  }

  const graphqlUrl = normalizeUrl(
    options.graphqlUrl || process.env.LAUNCH_HEALTH_GRAPHQL_URL || null,
    "graphql",
    launchBlockers
  );
  const rpcUrl = normalizeUrl(
    options.rpcUrl || process.env.LAUNCH_HEALTH_RPC_URL || (graphqlUrl ? manifest.endpoints?.rpcUrl : null),
    "rpc",
    launchBlockers
  );

  if (options.strictLaunch && !rpcUrl) {
    launchBlockers.push("strict launch health requires --rpc-url or LAUNCH_HEALTH_RPC_URL");
  }

  if (options.strictLaunch && !graphqlUrl) {
    launchBlockers.push("strict launch health requires --graphql-url or LAUNCH_HEALTH_GRAPHQL_URL");
  }

  const expectedOwnerInput = options.expectedOwner || process.env.ROBINHOOD_PRODUCTION_OWNER;
  const expectedFeeRecipientInput = options.expectedFeeRecipient || process.env.ROBINHOOD_FEE_RECIPIENT;
  const shouldResolveExpectedOwner = Boolean(rpcUrl || options.strictLaunch || expectedOwnerInput);
  const shouldResolveExpectedFeeRecipient = Boolean(rpcUrl || options.strictLaunch || expectedFeeRecipientInput);
  const expectedOwner = shouldResolveExpectedOwner
    ? normalizeOptionalAddress(expectedOwnerInput, "--expected-owner/ROBINHOOD_PRODUCTION_OWNER", launchBlockers)
    : null;
  const expectedFeeRecipient = shouldResolveExpectedFeeRecipient
    ? normalizeOptionalAddress(
        expectedFeeRecipientInput,
        "--expected-fee-recipient/ROBINHOOD_FEE_RECIPIENT",
        launchBlockers
      )
    : null;

  if (options.strictLaunch && !expectedOwner) {
    launchBlockers.push(
      "strict launch health requires --expected-owner or ROBINHOOD_PRODUCTION_OWNER for post-handoff LBFactory.owner()"
    );
  }

  if (options.strictLaunch && !expectedFeeRecipient) {
    launchBlockers.push(
      "strict launch health requires --expected-fee-recipient or ROBINHOOD_FEE_RECIPIENT for post-handoff LBFactory.getFeeRecipient()"
    );
  }

  addManifestWarnings(manifest, checks, warnings, {
    liveOwnershipChecksExpected: Boolean(rpcUrl && expectedOwner && expectedFeeRecipient)
  });

  let rpcHead = null;
  if (rpcUrl) {
    rpcHead = await checkRpc({
      expectedFeeRecipient,
      expectedOwner,
      rpcUrl,
      manifest,
      options,
      checks,
      launchBlockers
    });
  } else {
    checks.push({
      name: "rpc",
      status: "skipped",
      message: "no RPC URL supplied"
    });
  }

  if (graphqlUrl) {
    await checkGraphql({
      graphqlUrl,
      manifest,
      rpcHead,
      options,
      checks,
      launchBlockers
    });
  } else {
    checks.push({
      name: "graphql",
      status: "skipped",
      message: "no GraphQL endpoint supplied"
    });
  }

  if (!rpcUrl && !graphqlUrl) {
    warnings.push("manifest-only mode is suitable for no-secret CI, but it is not launch evidence for #61");
  }

  finish({ manifest: manifestSummary, checks, warnings, launchBlockers });
}

function parseArgs(argv) {
  const options = {
    graphqlUrl: null,
    help: false,
    json: false,
    manifestPath: null,
    maxIndexerLag: defaultMaxIndexerLag,
    maxRpcHeadAgeSeconds: defaultMaxRpcHeadAgeSeconds,
    offline: false,
    rpcUrl: null,
    strictLaunch: false,
    timeoutMs: defaultTimeoutMs,
    expectedFeeRecipient: null,
    expectedOwner: null
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--strict-launch") {
      options.strictLaunch = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--offline") {
      options.offline = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const { name, value, consumedNext } = readOption(argv, index);
    index += consumedNext ? 1 : 0;

    if (name === "--rpc-url") {
      options.rpcUrl = value;
    } else if (name === "--manifest") {
      options.manifestPath = value;
    } else if (name === "--expected-owner") {
      options.expectedOwner = value;
    } else if (name === "--expected-fee-recipient") {
      options.expectedFeeRecipient = value;
    } else if (name === "--graphql-url" || name === "--graphql-endpoint" || name === "--indexer-url") {
      options.graphqlUrl = value;
    } else if (name === "--max-indexer-lag" || name === "--max-lag-blocks") {
      options.maxIndexerLag = parseNonNegativeInteger(value, name);
    } else if (name === "--max-rpc-head-age-seconds") {
      options.maxRpcHeadAgeSeconds = parseNonNegativeInteger(value, name);
    } else if (name === "--timeout-ms") {
      options.timeoutMs = parseNonNegativeInteger(value, name, { min: 1 });
    } else {
      throw new Error(`unknown option: ${name}`);
    }
  }

  if (positional.length > 1) {
    throw new Error(`expected one manifest path, received ${positional.length}`);
  }
  if (positional.length === 1) {
    if (options.manifestPath) {
      throw new Error("provide the manifest path either positionally or with --manifest, not both");
    }
    options.manifestPath = positional[0];
  }

  return options;
}

function readOption(argv, index) {
  const arg = argv[index];
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex !== -1) {
    return {
      consumedNext: false,
      name: arg.slice(0, equalsIndex),
      value: arg.slice(equalsIndex + 1)
    };
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${arg}`);
  }

  return {
    consumedNext: true,
    name: arg,
    value
  };
}

function parseNonNegativeInteger(value, name, options = {}) {
  const parsed = Number(value);
  const min = options.min ?? 0;
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

function readManifest(manifestPath, displayPath, checks, launchBlockers) {
  if (!fs.existsSync(manifestPath)) {
    checks.push({
      name: "manifest",
      status: "fail",
      path: displayPath,
      message: "file does not exist"
    });
    launchBlockers.push(`${displayPath}: file does not exist`);
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    checks.push({
      name: "manifest",
      status: "fail",
      path: displayPath,
      message: `invalid JSON: ${error.message}`
    });
    launchBlockers.push(`${displayPath}: invalid JSON: ${error.message}`);
    return null;
  }

  const validation = childProcess.spawnSync(process.execPath, [manifestValidator, manifestPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  const validationOutput = `${validation.stdout ?? ""}${validation.stderr ?? ""}`.trim();

  if (validation.status !== 0) {
    checks.push({
      name: "manifest",
      status: "fail",
      path: displayPath,
      message: validationOutput || "manifest validation failed"
    });
    launchBlockers.push(`${displayPath}: manifest validation failed`);
    return null;
  }

  const robinhoodErrors = validateRobinhoodManifest(manifest, displayPath);
  if (robinhoodErrors.length > 0) {
    checks.push({
      name: "manifest",
      status: "fail",
      path: displayPath,
      message: robinhoodErrors.join("; ")
    });
    launchBlockers.push(...robinhoodErrors);
    return null;
  }

  checks.push({
    name: "manifest",
    status: "pass",
    path: displayPath,
    environment: manifest.environment,
    chainId: manifest.chainId,
    startBlock: manifest.startBlock
  });
  return manifest;
}

function validateRobinhoodManifest(manifest, displayPath) {
  const errors = [];
  if (manifest.schemaVersion !== "lb.robinhood.v1") {
    errors.push(`${displayPath}.schemaVersion: expected "lb.robinhood.v1"`);
  }
  if (manifest.environment !== "testnet" && manifest.environment !== "mainnet") {
    errors.push(`${displayPath}.environment: expected "testnet" or "mainnet"`);
  }
  if (manifest.environment === "testnet" && manifest.chainId !== 46_630) {
    errors.push(`${displayPath}.chainId: expected 46630 for Robinhood testnet`);
  }
  if (manifest.environment === "mainnet" && manifest.chainId !== 4_663) {
    errors.push(`${displayPath}.chainId: expected 4663 for Robinhood mainnet`);
  }
  if (!manifest.endpoints || typeof manifest.endpoints !== "object" || Array.isArray(manifest.endpoints)) {
    errors.push(`${displayPath}.endpoints: expected object`);
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "zap") || Object.prototype.hasOwnProperty.call(manifest.contracts ?? {}, "zap")) {
    errors.push(`${displayPath}: on-chain Zap was removed; zap and contracts.zap must be absent`);
  }
  for (const key of Object.keys(manifest.constructorArgs ?? {})) {
    if (/^zap/i.test(key)) errors.push(`${displayPath}.constructorArgs.${key}: on-chain Zap constructor fields must be absent`);
  }
  return errors;
}

function addManifestWarnings(manifest, checks, warnings, { liveOwnershipChecksExpected = false } = {}) {
  if (
    typeof manifest.deployer === "string" &&
    typeof manifest.ownership?.lbFactoryOwner === "string" &&
    manifest.deployer.toLowerCase() === manifest.ownership.lbFactoryOwner.toLowerCase()
  ) {
    if (liveOwnershipChecksExpected) return;
    const message = "ownership.lbFactoryOwner still matches deployer; #52 needs handoff evidence before launch.";
    warnings.push(message);
    checks.push({ name: "ownership-handoff", status: "warn", message });
  }
}

function normalizeUrl(value, label, launchBlockers) {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      launchBlockers.push(`${label} URL must use http or https`);
      return null;
    }
    return value;
  } catch {
    launchBlockers.push(`${label} URL is not a valid URL`);
    return null;
  }
}

function normalizeOptionalAddress(value, label, launchBlockers) {
  if (!value) return null;
  if (!isAddress(value) || value.toLowerCase() === zeroAddress) {
    launchBlockers.push(`${label} must be a non-zero EVM address`);
    return null;
  }
  return checksumless(value);
}

async function checkRpc({ expectedFeeRecipient, expectedOwner, rpcUrl, manifest, options, checks, launchBlockers }) {
  const check = {
    name: "rpc",
    status: "pass",
    endpointHost: urlHost(rpcUrl)
  };

  try {
    const chainIdHex = await rpcCall(rpcUrl, "eth_chainId", [], options.timeoutMs);
    const chainId = parseHexQuantity(chainIdHex, "eth_chainId");
    check.chainId = chainId;
    if (chainId !== manifest.chainId) {
      failCheck(check, launchBlockers, `RPC chain ID ${chainId} does not match manifest chain ID ${manifest.chainId}`);
    }

    const blockNumberHex = await rpcCall(rpcUrl, "eth_blockNumber", [], options.timeoutMs);
    const blockNumber = parseHexQuantity(blockNumberHex, "eth_blockNumber");
    check.headBlock = blockNumber;
    if (blockNumber < manifest.startBlock) {
      failCheck(check, launchBlockers, `RPC head block ${blockNumber} is behind manifest startBlock ${manifest.startBlock}`);
    }

    const latestBlock = await rpcCall(rpcUrl, "eth_getBlockByNumber", ["latest", false], options.timeoutMs);
    if (!latestBlock || typeof latestBlock !== "object") {
      failCheck(check, launchBlockers, "RPC latest block payload is missing");
    } else if (typeof latestBlock.timestamp === "string") {
      const timestamp = parseHexQuantity(latestBlock.timestamp, "latest.timestamp");
      const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
      check.headAgeSeconds = ageSeconds;
      if (ageSeconds > options.maxRpcHeadAgeSeconds) {
        failCheck(
          check,
          launchBlockers,
          `RPC latest block is ${ageSeconds}s old, above ${options.maxRpcHeadAgeSeconds}s threshold`
        );
      }
    } else {
      failCheck(check, launchBlockers, "RPC latest block timestamp is missing");
    }
  } catch (error) {
    failCheck(check, launchBlockers, `RPC health check failed: ${error.message}`);
  }

  checks.push(check);

  if (check.status === "pass") {
    const ownerExpectation = ownershipExpectation({
      fallback: manifest.ownership?.lbFactoryOwner,
      fallbackPath: "ownership.lbFactoryOwner",
      provided: expectedOwner,
      providedPath: "--expected-owner/ROBINHOOD_PRODUCTION_OWNER",
      strictLaunch: options.strictLaunch
    });
    const feeRecipientExpectation = ownershipExpectation({
      fallback: manifest.ownership?.feeRecipient,
      fallbackPath: "ownership.feeRecipient",
      provided: expectedFeeRecipient,
      providedPath: "--expected-fee-recipient/ROBINHOOD_FEE_RECIPIENT",
      strictLaunch: options.strictLaunch
    });

    await checkFactoryAddress({
      checks,
      expected: ownerExpectation.expected,
      label: "factory-owner",
      launchBlockers,
      manifestPath: ownerExpectation.source,
      rpcUrl,
      selector: factoryOwnerSelector,
      timeoutMs: options.timeoutMs,
      to: manifest.contracts?.lbFactory
    });
    await checkFactoryAddress({
      checks,
      expected: feeRecipientExpectation.expected,
      label: "factory-fee-recipient",
      launchBlockers,
      manifestPath: feeRecipientExpectation.source,
      rpcUrl,
      selector: factoryFeeRecipientSelector,
      timeoutMs: options.timeoutMs,
      to: manifest.contracts?.lbFactory
    });
    await checkFactoryAddress({
      checks,
      expected: manifest.contracts?.lbPairImplementation,
      label: "factory-pair-implementation",
      launchBlockers,
      manifestPath: "contracts.lbPairImplementation",
      rpcUrl,
      selector: factoryPairImplementationSelector,
      timeoutMs: options.timeoutMs,
      to: manifest.contracts?.lbFactory
    });
  }

  return check.status === "pass" && Number.isInteger(check.headBlock) ? check.headBlock : null;
}

function ownershipExpectation({ fallback, fallbackPath, provided, providedPath, strictLaunch }) {
  if (typeof provided === "string") {
    return { expected: provided, source: providedPath };
  }

  if (strictLaunch) {
    return { expected: null, source: providedPath };
  }

  return { expected: fallback, source: fallbackPath };
}

async function checkFactoryAddress({ checks, expected, label, launchBlockers, manifestPath, rpcUrl, selector, timeoutMs, to }) {
  const check = {
    name: label,
    status: "pass",
    expected,
    expectedSource: manifestPath
  };

  try {
    if (typeof to !== "string") {
      failCheck(check, launchBlockers, `${label} cannot run because contracts.lbFactory is missing`);
    } else if (typeof expected !== "string") {
      failCheck(check, launchBlockers, `${label} cannot run because ${manifestPath} is missing`);
    } else {
      const output = await rpcCall(rpcUrl, "eth_call", [{ to, data: selector }, "latest"], timeoutMs);
      const actual = decodeAbiAddress(output);
      check.actual = actual;

      if (actual.toLowerCase() !== expected.toLowerCase()) {
        failCheck(check, launchBlockers, `${label} ${actual} does not match ${manifestPath} ${expected}`);
      }
    }
  } catch (error) {
    failCheck(check, launchBlockers, `${label} check failed: ${error.message}`);
  }

  checks.push(check);
}

async function checkGraphql({ graphqlUrl, manifest, rpcHead, options, checks, launchBlockers }) {
  const check = {
    name: "graphql",
    status: "pass",
    endpointHost: urlHost(graphqlUrl)
  };

  try {
    const result = await graphqlRequest(
      graphqlUrl,
      buildGraphqlQuery(),
      options.timeoutMs
    );
    const meta = result?._meta;
    if (!meta || typeof meta !== "object") {
      failCheck(check, launchBlockers, "GraphQL _meta payload is missing");
    } else {
      check.hasIndexingErrors = meta.hasIndexingErrors;
      if (meta.hasIndexingErrors !== false) {
        failCheck(check, launchBlockers, "GraphQL _meta.hasIndexingErrors must be false");
      }

      const indexedBlock = Number(meta.block?.number);
      check.indexedBlock = Number.isInteger(indexedBlock) ? indexedBlock : null;
      if (!Number.isInteger(indexedBlock)) {
        failCheck(check, launchBlockers, "GraphQL _meta.block.number is missing");
      } else if (rpcHead === null) {
        failCheck(check, launchBlockers, "GraphQL lag requires a passing RPC head check");
      } else {
        const lag = rpcHead - indexedBlock;
        check.blockLag = lag;
        if (lag > options.maxIndexerLag) {
          failCheck(check, launchBlockers, `GraphQL block lag ${lag} exceeds ${options.maxIndexerLag} block threshold`);
        }
        if (lag < -2) {
          failCheck(check, launchBlockers, `GraphQL indexed block ${indexedBlock} is ahead of RPC head ${rpcHead}`);
        }
      }
    }

    const factories = Array.isArray(result?.factories) ? result.factories : [];
    const factory = factories.find(
      (item) => typeof item?.id === "string" && item.id.toLowerCase() === manifest.contracts.lbFactory.toLowerCase()
    );
    check.factoryFound = Boolean(factory);
    if (!factory) {
      failCheck(check, launchBlockers, `GraphQL factory ${manifest.contracts.lbFactory} was not returned`);
    } else {
      check.factoryPairCount = factory.pairCount ?? null;
    }

    const pairs = Array.isArray(result?.pairs) ? result.pairs : [];
    check.recentPairs = pairs.length;
    if (pairs.length === 0) {
      check.messages = [
        ...(check.messages ?? []),
        "GraphQL returned zero recent pairs; acceptable only before testnet rehearsal liquidity is seeded"
      ];
    }

  } catch (error) {
    failCheck(check, launchBlockers, `GraphQL health check failed: ${error.message}`);
  }

  checks.push(check);
}

function buildGraphqlQuery() {
  return "query LaunchHealthMeta { _meta { hasIndexingErrors block { number hash } } factories(first: 10) { id pairCount quoteAssetCount presetCount } pairs(first: 10, orderBy: updatedAtBlock, orderDirection: desc) { id activeId reserveX reserveY swapCount depositCount withdrawCount } }";
}

async function rpcCall(rpcUrl, method, params, timeoutMs) {
  const response = await fetchJson(rpcUrl, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method,
      params
    }),
    timeoutMs
  });

  if (response.error) {
    const code = response.error.code === undefined ? "" : `${response.error.code} `;
    throw new Error(`${method}: ${code}${response.error.message ?? "JSON-RPC error"}`);
  }

  return response.result;
}

async function graphqlRequest(graphqlUrl, query, timeoutMs) {
  const response = await fetchJson(graphqlUrl, {
    body: JSON.stringify({ query }),
    timeoutMs
  });

  if (Array.isArray(response.errors) && response.errors.length > 0) {
    throw new Error(response.errors.map((error) => error.message ?? "GraphQL error").join("; "));
  }

  return response.data;
}

async function fetchJson(url, { body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseHexQuantity(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label}: expected hex quantity`);
  }

  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label}: value is not a safe non-negative integer`);
  }
  return parsed;
}

function decodeAbiAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`expected ABI-encoded address, got ${typeof value === "string" ? value : typeof value}`);
  }

  return `0x${value.slice(-40)}`;
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function checksumless(value) {
  return `0x${value.slice(2)}`;
}

function failCheck(check, launchBlockers, message) {
  check.status = "fail";
  if (!check.messages) check.messages = [];
  check.messages.push(message);
  launchBlockers.push(message);
}

function urlHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function finish({ manifest, checks, warnings, launchBlockers }) {
  printResult({
    ok: launchBlockers.length === 0,
    manifest,
    checks,
    warnings,
    launchBlockers
  });
  process.exitCode = launchBlockers.length === 0 ? 0 : 1;
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}
