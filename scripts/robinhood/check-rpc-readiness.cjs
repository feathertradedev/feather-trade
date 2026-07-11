#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const manifestValidator = path.join(repoRoot, "scripts/manifests/validate-manifests.cjs");
const chainConfigPath = path.join(repoRoot, "config/chains/robinhood.json");

const defaultLogSampleBlocks = 5_000;
const defaultMaxRpcHeadAgeSeconds = 300;
const defaultTimeoutMs = 10_000;
const zeroAddress = "0x0000000000000000000000000000000000000000";

const ownerSelector = "0x8da5cb5b";
const getActiveIdSelector = "0xdbe65edc";
const getReservesSelector = "0x0902f1ac";
const getBinSelector = "0x0abe9688";
const totalSupplySelector = "0xbd85b039";
const lbPairCreatedTopic = "0x2c8d104b27c6b7f4492017a6f5cf3803043688934ebcaa6a03540beeaf976aff";

main().catch((error) => {
  printResult({
    ok: false,
    manifest: null,
    selectedEnvVars: {},
    checks: [
      {
        name: "rpc-readiness",
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
    printHelp();
    return;
  }

  const checks = [];
  const warnings = [];
  const launchBlockers = [];
  const manifestPath = options.manifestPath ? path.resolve(repoRoot, options.manifestPath) : null;

  if (!manifestPath) {
    fail(checks, launchBlockers, "manifest", "missing Robinhood deployment manifest path");
    finish({ manifest: null, selectedEnvVars: {}, checks, warnings, launchBlockers });
    return;
  }

  const manifestDisplayPath = path.relative(repoRoot, manifestPath);
  const manifest = readManifest(manifestPath, manifestDisplayPath, checks, launchBlockers);
  if (!manifest) {
    finish({ manifest: null, selectedEnvVars: {}, checks, warnings, launchBlockers });
    return;
  }

  const chainConfig = readChainConfig(manifest.environment);
  const envNames = rpcEnvNames(manifest);
  const endpointInputs = {
    primary: firstValue([options.rpcUrl, process.env.ROBINHOOD_RPC_READINESS_RPC_URL, process.env[envNames.primary]]),
    archive: firstValue([
      options.archiveRpcUrl,
      process.env[envNames.archive],
      process.env.ROBINHOOD_ARCHIVE_RPC_URL,
      process.env.INDEXER_ROBINHOOD_RPC_URL,
      process.env.GRAPH_NODE_ARCHIVE_RPC_URL
    ]),
    fallback: firstValue([options.fallbackRpcUrl, process.env[envNames.fallback], process.env.ROBINHOOD_FALLBACK_RPC_URL])
  };
  const endpoints = {
    primary: normalizeUrl(endpointInputs.primary, "primary RPC", launchBlockers),
    archive: normalizeUrl(endpointInputs.archive, "archive RPC", launchBlockers),
    fallback: normalizeUrl(endpointInputs.fallback, "fallback RPC", launchBlockers)
  };
  const historicalBlock = options.historicalBlock ?? manifest.startBlock;
  const factoryDeploymentBlock =
    options.factoryDeploymentBlock ??
    parseEnvInteger("ROBINHOOD_RPC_CHECK_FACTORY_BLOCK", launchBlockers) ??
    historicalBlock;
  const pair = normalizeOptionalAddress(
    firstValue([options.pair, process.env.ROBINHOOD_RPC_CHECK_PAIR]),
    "--pair/ROBINHOOD_RPC_CHECK_PAIR",
    launchBlockers
  );
  const pairHistoricalBlock = firstValue([options.pairHistoricalBlock, parseEnvInteger("ROBINHOOD_RPC_CHECK_PAIR_BLOCK", launchBlockers)]);
  const liveReadinessAttempt = hasLiveReadinessEvidence({ endpointInputs, pair, pairHistoricalBlock });

  if (options.strictLaunch) {
    if (options.offline) {
      launchBlockers.push("strict RPC readiness cannot use --offline; provide live primary and fallback RPC endpoints plus post-deployment pair evidence");
    }
    if (path.basename(manifestDisplayPath) !== "latest.json") {
      launchBlockers.push("strict RPC readiness requires the promoted latest.json broadcast manifest");
    }
    if (!endpoints.primary) {
      launchBlockers.push(`strict RPC readiness requires --rpc-url, ROBINHOOD_RPC_READINESS_RPC_URL, or ${envNames.primary}`);
    }
    if (!endpoints.fallback) {
      launchBlockers.push(`strict RPC readiness requires --fallback-rpc-url, ${envNames.fallback}, or ROBINHOOD_FALLBACK_RPC_URL`);
    }
    if (!pair) {
      launchBlockers.push(
        "strict RPC readiness requires --pair or ROBINHOOD_RPC_CHECK_PAIR so block-tagged eth_call proves getActiveId/getReserves/getBin/totalSupply"
      );
    }
    if (pair && pairHistoricalBlock === null) {
      launchBlockers.push(
        "strict RPC readiness requires --pair-historical-block or ROBINHOOD_RPC_CHECK_PAIR_BLOCK at or after the sampled pair creation block"
      );
    }

    for (const [role, endpoint] of Object.entries(endpoints)) {
      if (endpoint && isPublicRobinhoodRpc(endpoint, chainConfig.publicRpcUrl)) {
        warnings.push(
          `strict RPC readiness ${role} endpoint uses public Robinhood RPC ${chainConfig.publicRpcUrl}; acceptance depends on live health, block-tagged calls, rate-limit tolerance, and independent fallback evidence`
        );
      }
    }

    if (endpoints.primary && endpoints.fallback && sameUrl(endpoints.primary, endpoints.fallback)) {
      launchBlockers.push("strict RPC readiness fallback RPC must not be identical to the primary RPC URL");
    }
  }

  if (!options.strictLaunch && !options.offline && liveReadinessAttempt) {
    addLiveReadinessCompletenessCheck({
      checks,
      endpoints,
      envNames,
      launchBlockers,
      pair,
      pairHistoricalBlock
    });
  }

  if (options.offline) {
    checks.push({
      name: "live-rpc",
      status: "skipped",
      message: "offline mode validates the manifest and selected env-var names only"
    });
    warnings.push("offline RPC readiness is suitable for no-secret CI, but it is not launch evidence for #47");
    finish({
      manifest: summarizeManifest(manifest, manifestDisplayPath),
      selectedEnvVars: envNames,
      checks,
      warnings,
      launchBlockers
    });
    return;
  }

  if (options.strictLaunch && launchBlockers.length > 0) {
    checks.push({
      name: "strict-rpc-readiness-preflight",
      status: "fail",
      message: "strict launch RPC readiness cannot proceed until launch blockers are resolved"
    });
    finish({
      manifest: summarizeManifest(manifest, manifestDisplayPath),
      selectedEnvVars: envNames,
      checks,
      warnings,
      launchBlockers
    });
    return;
  }

  const primaryCheck = endpoints.primary
    ? await checkEndpoint({
        chainConfig,
        checks,
        endpoint: endpoints.primary,
        launchBlockers,
        manifest,
        options,
        role: "primary-rpc"
      })
    : skipped(checks, "primary-rpc", "no explicit primary RPC URL supplied; manifest.endpoints.rpcUrl is not used for live checks");

  const archiveCheck = endpoints.archive
    ? await checkEndpoint({
        chainConfig,
        checks,
        endpoint: endpoints.archive,
        launchBlockers,
        manifest,
        options,
        role: "archive-rpc"
      })
    : skipped(checks, "archive-rpc", "no archive RPC URL supplied");

  const fallbackCheck = endpoints.fallback
    ? await checkEndpoint({
        chainConfig,
        checks,
        endpoint: endpoints.fallback,
        launchBlockers,
        manifest,
        options,
        role: "fallback-rpc"
      })
    : skipped(checks, "fallback-rpc", "no fallback RPC URL supplied");

  if (options.strictLaunch && endpoints.primary && endpoints.fallback) {
    if (urlHost(endpoints.primary) === urlHost(endpoints.fallback)) {
      warnings.push("fallback RPC host matches primary RPC host; attach provider evidence proving independent failover ownership");
    }
  }

  const historicalEndpoint = endpoints.archive || endpoints.primary;
  const historicalEndpointCheck = endpoints.archive ? archiveCheck : primaryCheck;
  if (historicalEndpoint && historicalEndpointCheck.status === "pass") {
    await checkHistoricalReads({
      checks,
      endpoint: historicalEndpoint,
      factoryDeploymentBlock,
      historicalBlock,
      latestBlock: historicalEndpointCheck.headBlock,
      launchBlockers,
      manifest,
      options
    });
  }

  if (pair) {
    const pairEndpoint = endpoints.archive || endpoints.primary;
    if (pairEndpoint) {
      await checkPairReads({
        blockLabel: "latest",
        checks,
        endpoint: pairEndpoint,
        launchBlockers,
        pair,
        timeoutMs: options.timeoutMs
      });
      if (pairHistoricalBlock !== null) {
        await checkPairReads({
          blockLabel: toBlockTag(pairHistoricalBlock),
          checks,
          endpoint: pairEndpoint,
          launchBlockers,
          pair,
          timeoutMs: options.timeoutMs
        });
      } else {
        warnings.push("pair method checks ran at latest only; pass --pair-historical-block for replay/read-at-event-block evidence");
      }
    }
  }

  if (primaryCheck.status === "skipped" && archiveCheck.status === "skipped" && fallbackCheck.status === "skipped") {
    warnings.push("manifest-only RPC readiness is not launch evidence for #47");
  }

  finish({
    manifest: summarizeManifest(manifest, manifestDisplayPath),
    selectedEnvVars: envNames,
    checks,
    warnings,
    launchBlockers
  });
}

function printHelp() {
  console.log(
    JSON.stringify(
      {
        usage:
          "pnpm robinhood:rpc:check -- <manifest> [--rpc-url <url>] [--archive-rpc-url <url>] [--fallback-rpc-url <url>] [--pair <address>] [--pair-historical-block <block>] [--historical-block <block>] [--factory-deployment-block <block>] [--strict-launch] [--offline] [--max-rpc-head-age-seconds <seconds>] [--log-sample-blocks <blocks>] [--timeout-ms <ms>] [--json]",
        env: [
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
        ]
      },
      null,
      2
    )
  );
}

function parseArgs(argv) {
  const options = {
    archiveRpcUrl: null,
    fallbackRpcUrl: null,
    factoryDeploymentBlock: null,
    help: false,
    historicalBlock: null,
    json: false,
    logSampleBlocks: defaultLogSampleBlocks,
    manifestPath: null,
    maxRpcHeadAgeSeconds: defaultMaxRpcHeadAgeSeconds,
    offline: false,
    pair: null,
    pairHistoricalBlock: null,
    rpcUrl: null,
    strictLaunch: false,
    timeoutMs: defaultTimeoutMs
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;

    if (arg === "--help" || arg === "-h") {
      options.help = true;
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
    if (arg === "--strict-launch") {
      options.strictLaunch = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const { name, value, consumedNext } = readOption(argv, index);
    index += consumedNext ? 1 : 0;

    if (name === "--manifest") {
      options.manifestPath = value;
    } else if (name === "--rpc-url") {
      options.rpcUrl = value;
    } else if (name === "--archive-rpc-url" || name === "--archive-url") {
      options.archiveRpcUrl = value;
    } else if (name === "--fallback-rpc-url" || name === "--fallback-url") {
      options.fallbackRpcUrl = value;
    } else if (name === "--pair" || name === "--check-pair") {
      options.pair = value;
    } else if (name === "--historical-block") {
      options.historicalBlock = parseNonNegativeInteger(value, name);
    } else if (name === "--factory-deployment-block") {
      options.factoryDeploymentBlock = parseNonNegativeInteger(value, name);
    } else if (name === "--pair-historical-block") {
      options.pairHistoricalBlock = parseNonNegativeInteger(value, name);
    } else if (name === "--max-rpc-head-age-seconds") {
      options.maxRpcHeadAgeSeconds = parseNonNegativeInteger(value, name);
    } else if (name === "--log-sample-blocks") {
      options.logSampleBlocks = parseNonNegativeInteger(value, name, { min: 1 });
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

function parseEnvInteger(name, launchBlockers) {
  const value = process.env[name];
  if (!value) return null;
  try {
    return parseNonNegativeInteger(value, name);
  } catch (error) {
    launchBlockers.push(error.message);
    return null;
  }
}

function readManifest(manifestPath, displayPath, checks, launchBlockers) {
  if (!fs.existsSync(manifestPath)) {
    fail(checks, launchBlockers, "manifest", `${displayPath}: file does not exist`);
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(checks, launchBlockers, "manifest", `${displayPath}: invalid JSON: ${error.message}`);
    return null;
  }

  const validation = childProcess.spawnSync(process.execPath, [manifestValidator, manifestPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  const validationOutput = `${validation.stdout ?? ""}${validation.stderr ?? ""}`.trim();
  if (validation.status !== 0) {
    fail(checks, launchBlockers, "manifest", validationOutput || `${displayPath}: manifest validation failed`);
    return null;
  }

  const manifestErrors = validateRobinhoodManifest(manifest, displayPath);
  if (manifestErrors.length > 0) {
    fail(checks, launchBlockers, "manifest", manifestErrors.join("; "));
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
  if (!isAddress(manifest.contracts?.lbFactory)) {
    errors.push(`${displayPath}.contracts.lbFactory: expected non-zero address`);
  }
  if (!Number.isInteger(manifest.startBlock) || manifest.startBlock < 0) {
    errors.push(`${displayPath}.startBlock: expected non-negative integer`);
  }
  return errors;
}

function readChainConfig(environment) {
  try {
    const config = JSON.parse(fs.readFileSync(chainConfigPath, "utf8"));
    return config[environment] ?? {};
  } catch {
    return {};
  }
}

function rpcEnvNames(manifest) {
  const prefix = manifest.environment === "testnet" ? "ROBINHOOD_TESTNET" : "ROBINHOOD_MAINNET";
  return {
    primary: manifest.chain?.rpcEnvVar || (manifest.environment === "testnet" ? "ROBINHOOD_TESTNET_RPC_URL" : "ROBINHOOD_RPC_URL"),
    archive: `${prefix}_ARCHIVE_RPC_URL`,
    fallback: `${prefix}_FALLBACK_RPC_URL`
  };
}

function hasLiveReadinessEvidence({ endpointInputs, pair, pairHistoricalBlock }) {
  return Boolean(endpointInputs.primary || endpointInputs.archive || endpointInputs.fallback || pair || pairHistoricalBlock !== null);
}

function addLiveReadinessCompletenessCheck({ checks, endpoints, envNames, launchBlockers, pair, pairHistoricalBlock }) {
  const messages = [];

  if (!endpoints.primary) {
    messages.push(
      `live RPC readiness requires --rpc-url, ROBINHOOD_RPC_READINESS_RPC_URL, or ${envNames.primary}; manifest.endpoints.rpcUrl is not used for live checks`
    );
  }
  if (!endpoints.fallback) {
    messages.push(`live RPC readiness requires --fallback-rpc-url, ${envNames.fallback}, or ROBINHOOD_FALLBACK_RPC_URL`);
  }
  if (!pair) {
    messages.push("live RPC readiness requires --pair or ROBINHOOD_RPC_CHECK_PAIR for pair method evidence");
  }
  if (pairHistoricalBlock === null) {
    messages.push("live RPC readiness requires --pair-historical-block or ROBINHOOD_RPC_CHECK_PAIR_BLOCK for historical pair method evidence");
  }

  if (messages.length > 0) {
    checks.push({
      name: "live-readiness-completeness",
      status: "fail",
      message: "live #47 RPC readiness requires explicit primary, fallback, pair, and historical pair inputs",
      messages
    });
    launchBlockers.push(...messages);
    return;
  }

  checks.push({
    name: "live-readiness-completeness",
    status: "pass",
    message: "explicit primary, fallback, pair, and historical pair inputs supplied; a separate archive endpoint is optional until replay requires one"
  });
}

async function checkEndpoint({ chainConfig, checks, endpoint, launchBlockers, manifest, options, role }) {
  const check = {
    name: role,
    status: "pass",
    endpointHost: displayEndpointHost(endpoint),
    publicRobinhoodEndpoint: isPublicRobinhoodRpc(endpoint, chainConfig.publicRpcUrl)
  };

  try {
    const chainId = parseHexQuantity(await rpcCall(endpoint, "eth_chainId", [], options.timeoutMs), "eth_chainId");
    check.chainId = chainId;
    if (chainId !== manifest.chainId) {
      failCheck(check, launchBlockers, `${role} chain ID ${chainId} does not match manifest chain ID ${manifest.chainId}`);
    }

    const headBlock = parseHexQuantity(await rpcCall(endpoint, "eth_blockNumber", [], options.timeoutMs), "eth_blockNumber");
    check.headBlock = headBlock;
    if (headBlock < manifest.startBlock) {
      failCheck(check, launchBlockers, `${role} head block ${headBlock} is behind manifest startBlock ${manifest.startBlock}`);
    }

    const latestBlock = await rpcCall(endpoint, "eth_getBlockByNumber", ["latest", false], options.timeoutMs);
    if (!latestBlock || typeof latestBlock !== "object") {
      failCheck(check, launchBlockers, `${role} latest block payload is missing`);
    } else if (typeof latestBlock.timestamp === "string") {
      const timestamp = parseHexQuantity(latestBlock.timestamp, "latest.timestamp");
      const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
      check.headAgeSeconds = ageSeconds;
      if (ageSeconds > options.maxRpcHeadAgeSeconds) {
        failCheck(check, launchBlockers, `${role} latest block is ${ageSeconds}s old, above ${options.maxRpcHeadAgeSeconds}s threshold`);
      }
    } else {
      failCheck(check, launchBlockers, `${role} latest block timestamp is missing`);
    }

    try {
      const clientVersion = await rpcCall(endpoint, "web3_clientVersion", [], options.timeoutMs);
      check.clientVersion = String(clientVersion);
    } catch (error) {
      check.clientVersion = null;
      check.messages = [...(check.messages ?? []), `web3_clientVersion unavailable: ${error.message}`];
    }
  } catch (error) {
    failCheck(check, launchBlockers, `${role} health check failed: ${error.message}`);
  }

  checks.push(check);
  return check;
}

async function checkHistoricalReads({
  checks,
  endpoint,
  factoryDeploymentBlock,
  historicalBlock,
  latestBlock,
  launchBlockers,
  manifest,
  options
}) {
  const blockTag = toBlockTag(historicalBlock);
  const historicalBlockCheck = {
    name: "historical-block",
    status: "pass",
    block: historicalBlock,
    endpointHost: displayEndpointHost(endpoint)
  };

  try {
    const block = await rpcCall(endpoint, "eth_getBlockByNumber", [blockTag, false], options.timeoutMs);
    if (!block || typeof block !== "object") {
      failCheck(historicalBlockCheck, launchBlockers, `selected indexer RPC returned no block for ${historicalBlock}`);
    } else {
      historicalBlockCheck.blockHash = block.hash ?? null;
      historicalBlockCheck.timestamp = typeof block.timestamp === "string" ? parseHexQuantity(block.timestamp, "historical.timestamp") : null;
    }
  } catch (error) {
    failCheck(historicalBlockCheck, launchBlockers, `historical block check failed: ${error.message}`);
  }
  checks.push(historicalBlockCheck);

  await checkFactoryOwnerAtBlock({
    checks,
    endpoint,
    blockTag: toBlockTag(factoryDeploymentBlock),
    historicalBlock: factoryDeploymentBlock,
    launchBlockers,
    manifest,
    timeoutMs: options.timeoutMs
  });

  await checkFactoryLogs({
    checks,
    endpoint,
    fromBlock: historicalBlock,
    launchBlockers,
    manifest,
    maxBlocks: options.logSampleBlocks,
    latestBlock,
    timeoutMs: options.timeoutMs
  });
}

async function checkFactoryOwnerAtBlock({ checks, endpoint, blockTag, historicalBlock, launchBlockers, manifest, timeoutMs }) {
  const check = {
    name: "historical-factory-owner-call",
    status: "pass",
    block: historicalBlock,
    contract: manifest.contracts?.lbFactory,
    endpointHost: displayEndpointHost(endpoint)
  };

  try {
    if (!isAddress(manifest.contracts?.lbFactory)) {
      throw new Error("manifest contracts.lbFactory is missing");
    }
    const output = await rpcCall(endpoint, "eth_call", [{ to: manifest.contracts.lbFactory, data: ownerSelector }, blockTag], timeoutMs);
    check.owner = decodeAbiAddress(output);
  } catch (error) {
    failCheck(check, launchBlockers, `factory owner historical eth_call failed at block ${historicalBlock}: ${error.message}`);
  }
  checks.push(check);
}

async function checkFactoryLogs({ checks, endpoint, fromBlock, launchBlockers, manifest, maxBlocks, latestBlock, timeoutMs }) {
  const toBlock = Math.min(latestBlock ?? fromBlock, fromBlock + Math.max(0, maxBlocks - 1));
  const check = {
    name: "historical-factory-log-sample",
    status: "pass",
    contract: manifest.contracts?.lbFactory,
    eventTopic: lbPairCreatedTopic,
    fromBlock,
    toBlock,
    endpointHost: displayEndpointHost(endpoint)
  };

  try {
    if (!isAddress(manifest.contracts?.lbFactory)) {
      throw new Error("manifest contracts.lbFactory is missing");
    }
    const logs = await rpcCall(
      endpoint,
      "eth_getLogs",
      [
        {
          address: manifest.contracts.lbFactory,
          fromBlock: toBlockTag(fromBlock),
          topics: [lbPairCreatedTopic],
          toBlock: toBlockTag(toBlock)
        }
      ],
      timeoutMs
    );
    if (!Array.isArray(logs)) {
      failCheck(check, launchBlockers, "selected indexer RPC eth_getLogs response is not an array");
    } else {
      check.logCount = logs.length;
    }
  } catch (error) {
    failCheck(check, launchBlockers, `historical factory log sample failed: ${error.message}`);
  }
  checks.push(check);
}

async function checkPairReads({ blockLabel, checks, endpoint, launchBlockers, pair, timeoutMs }) {
  const check = {
    name: blockLabel === "latest" ? "pair-latest-methods" : "pair-historical-methods",
    status: "pass",
    block: blockLabel,
    pair,
    endpointHost: displayEndpointHost(endpoint)
  };

  try {
    const activeId = decodeAbiUint(await rpcCall(endpoint, "eth_call", [{ to: pair, data: getActiveIdSelector }, blockLabel], timeoutMs));
    const reserves = decodeAbiUintTuple(await rpcCall(endpoint, "eth_call", [{ to: pair, data: getReservesSelector }, blockLabel], timeoutMs), 2);
    const bin = decodeAbiUintTuple(
      await rpcCall(endpoint, "eth_call", [{ to: pair, data: `${getBinSelector}${encodeAbiUint(activeId)}` }, blockLabel], timeoutMs),
      2
    );
    const totalSupply = decodeAbiUint(
      await rpcCall(endpoint, "eth_call", [{ to: pair, data: `${totalSupplySelector}${encodeAbiUint(activeId)}` }, blockLabel], timeoutMs)
    );

    check.activeId = activeId.toString();
    check.reserveX = reserves[0].toString();
    check.reserveY = reserves[1].toString();
    check.activeBinReserveX = bin[0].toString();
    check.activeBinReserveY = bin[1].toString();
    check.activeBinTotalSupply = totalSupply.toString();
  } catch (error) {
    failCheck(check, launchBlockers, `${check.name} failed for ${pair} at ${blockLabel}: ${error.message}`);
  }

  checks.push(check);
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
  if (!isAddress(value) || lower(value) === lower(zeroAddress)) {
    launchBlockers.push(`${label} must be a non-zero EVM address`);
    return null;
  }
  return checksumless(value);
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

function decodeAbiUint(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`expected ABI-encoded uint, got ${typeof value === "string" ? value : typeof value}`);
  }
  return BigInt(value);
}

function decodeAbiUintTuple(value, count) {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${64 * count}}$`).test(value)) {
    throw new Error(`expected ABI-encoded uint tuple with ${count} values`);
  }
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const start = 2 + index * 64;
    values.push(BigInt(`0x${value.slice(start, start + 64)}`));
  }
  return values;
}

function encodeAbiUint(value) {
  const bigint = typeof value === "bigint" ? value : BigInt(value);
  if (bigint < 0n) {
    throw new Error("cannot ABI-encode negative uint");
  }
  return bigint.toString(16).padStart(64, "0");
}

function toBlockTag(blockNumber) {
  if (!Number.isInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`invalid block number ${blockNumber}`);
  }
  return `0x${blockNumber.toString(16)}`;
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && lower(value) !== lower(zeroAddress);
}

function checksumless(value) {
  return `0x${value.slice(2)}`;
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function firstValue(values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function isPublicRobinhoodRpc(value, publicRpcUrl) {
  return Boolean(publicRpcUrl && sameUrl(value, publicRpcUrl));
}

function sameUrl(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.hostname === rightUrl.hostname &&
      leftUrl.port === rightUrl.port &&
      leftUrl.pathname.replace(/\/+$/, "") === rightUrl.pathname.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

function urlHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function displayEndpointHost(value) {
  try {
    const url = new URL(value);
    const hostname = redactTokenSubdomain(url.hostname);
    return url.port ? `${hostname}:${url.port}` : hostname;
  } catch {
    return null;
  }
}

function redactTokenSubdomain(hostname) {
  if (!hostname || hostname === "localhost" || hostname.includes(":") || /^[0-9.]+$/.test(hostname)) {
    return hostname;
  }

  const labels = hostname.split(".");
  if (labels.length < 3) {
    return hostname;
  }

  const firstLabel = labels[0];
  const compactLabel = firstLabel.replace(/[-_]/g, "");
  if (compactLabel.length < 20 || !/^[a-z0-9]+$/i.test(compactLabel)) {
    return hostname;
  }

  if (compactLabel.length >= 32 || (/[a-z]/i.test(compactLabel) && /[0-9]/.test(compactLabel))) {
    return ["[redacted]", ...labels.slice(1)].join(".");
  }

  return hostname;
}

function skipped(checks, name, message) {
  const check = { name, status: "skipped", message };
  checks.push(check);
  return check;
}

function fail(checks, launchBlockers, name, message) {
  checks.push({ name, status: "fail", message });
  launchBlockers.push(message);
}

function failCheck(check, launchBlockers, message) {
  check.status = "fail";
  if (!check.messages) check.messages = [];
  check.messages.push(message);
  launchBlockers.push(message);
}

function summarizeManifest(manifest, displayPath) {
  return {
    path: displayPath,
    environment: manifest.environment,
    chainId: manifest.chainId,
    startBlock: manifest.startBlock,
    lbFactory: manifest.contracts?.lbFactory
  };
}

function finish({ manifest, selectedEnvVars, checks, warnings, launchBlockers }) {
  printResult({
    ok: launchBlockers.length === 0,
    manifest,
    selectedEnvVars,
    checks,
    warnings,
    launchBlockers
  });
  process.exitCode = launchBlockers.length === 0 ? 0 : 1;
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}
