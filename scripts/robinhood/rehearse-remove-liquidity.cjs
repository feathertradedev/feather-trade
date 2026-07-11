#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const defaultPageSize = 100;
const defaultMaxPages = 20;
const defaultMaxIndexerLag = 300;
const defaultBurnBps = 100n;
const bpsDenominator = 10_000n;
const rpcBatchSize = 10;
const balanceOfSelector = "00fdd58e";
const getBinSelector = "0abe9688";
const totalSupplySelector = "bd85b039";

if (require.main === module) {
  main().catch((error) => {
    printResult(
      {
        ok: false,
        checks: [
          {
            name: "remove-liquidity-rehearsal",
            status: "fail",
            message: error instanceof Error ? error.message : String(error)
          }
        ],
        warnings: [],
        launchBlockers: [error instanceof Error ? error.message : String(error)]
      },
      true
    );
    process.exitCode = 1;
  });
}

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
    fail(checks, launchBlockers, "manifest", "missing --manifest <path>");
    finish({ checks, warnings, launchBlockers }, options);
    return;
  }

  const manifest = readManifest(manifestPath, checks, launchBlockers);
  const owner = normalizeAddress(options.owner, "--owner", launchBlockers);
  const pair = normalizeAddress(options.pair, "--pair", launchBlockers);
  const rpcUrl = firstValue([options.rpcUrl, manifest?.endpoints?.rpcUrl]);
  const graphqlUrl = firstValue([options.graphqlUrl, manifest?.endpoints?.indexerUrl]);
  const router = normalizeAddress(manifest?.contracts?.lbRouter, "manifest contracts.lbRouter", launchBlockers);
  const burnBps = normalizeBurnBps(options.burnBps, launchBlockers);
  const minBins = normalizePositiveInteger(options.minBins ?? "2", "--min-bins", launchBlockers);
  const pageSize = normalizePositiveInteger(options.pageSize ?? String(defaultPageSize), "--page-size", launchBlockers);
  const maxPages = normalizePositiveInteger(options.maxPages ?? String(defaultMaxPages), "--max-pages", launchBlockers);
  const maxIndexerLag = normalizeNonNegativeInteger(
    options.maxIndexerLag ?? String(defaultMaxIndexerLag),
    "--max-indexer-lag",
    launchBlockers
  );

  if (!rpcUrl) launchBlockers.push("missing RPC URL; pass --rpc-url or set manifest endpoints.rpcUrl");
  if (!graphqlUrl) launchBlockers.push("missing GraphQL URL; pass --graphql-url or set manifest endpoints.indexerUrl");

  if (launchBlockers.length > 0) {
    finish({ manifest: summarizeManifest(manifest, manifestPath), checks, warnings, launchBlockers }, options);
    return;
  }

  const indexed = await loadOwnerPairPositions({
    endpoint: graphqlUrl,
    maxPages,
    owner,
    pageSize,
    pair
  });

  if (indexed.capped) {
    fail(
      checks,
      launchBlockers,
      "owner-pair-pagination",
      `owner+pair positions hit max page cap (${maxPages}); rerun with a higher --max-pages before signing`
    );
  } else if (indexed.rows.length < minBins) {
    fail(
      checks,
      launchBlockers,
      "owner-pair-pagination",
      `owner+pair positions returned ${indexed.rows.length} bin(s), expected at least ${minBins}`
    );
  } else {
    checks.push({
      name: "owner-pair-pagination",
      status: "pass",
      pagesFetched: indexed.pagesFetched,
      pageSize,
      positions: indexed.rows.length,
      capped: false
    });
  }

  const rpcHeadBlock = Number(castOutput(rpcUrl, ["block-number"], "RPC block number"));
  const indexerFreshness = checkIndexerFreshness({
    checks,
    indexed,
    launchBlockers,
    maxIndexerLag,
    rpcHeadBlock,
    rpcUrl
  });

  if (launchBlockers.length > 0) {
    finish({ manifest: summarizeManifest(manifest, manifestPath), checks, warnings, launchBlockers }, options);
    return;
  }

  const firstPosition = indexed.rows[0];
  const tokenX = normalizeAddress(firstPosition.pair?.tokenX?.id, "indexed pair tokenX", launchBlockers);
  const tokenY = normalizeAddress(firstPosition.pair?.tokenY?.id, "indexed pair tokenY", launchBlockers);
  const binStep = normalizePositiveInteger(firstPosition.pair?.binStep, "indexed pair binStep", launchBlockers);
  const blockNumber = indexerFreshness.blockNumber;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const selected = indexed.rows
    .map((row) => ({
      id: row.id,
      indexedLiquidity: parseBigInt(row.liquidity, `indexed liquidity for ${row.id}`),
      binId: parseBigInt(row.bin?.binId, `indexed bin id for ${row.id}`)
    }))
    .sort((left, right) => compareBigInt(left.binId, right.binId));

  const indexedBlockStates = await readLiveBinStates({
    rpcUrl,
    pair,
    owner,
    binIds: selected.map((position) => position.binId),
    blockNumber,
    labelPrefix: "indexed-block"
  });
  const liveBins = selected.map((position, index) => {
    const binId = position.binId;
    const liveState = indexedBlockStates[index];
    const { liveBalance, reserveX, reserveY, totalSupply } = liveState;

    if (liveBalance === 0n) {
      fail(checks, launchBlockers, "live-balance", `live balance is zero for bin ${binId.toString()}`);
    }
    if (liveBalance !== position.indexedLiquidity) {
      fail(
        checks,
        launchBlockers,
        "live-indexed-liquidity-match",
        `indexed liquidity ${position.indexedLiquidity.toString()} differs from live balance ${liveBalance.toString()} for bin ${binId.toString()} at indexed block ${blockNumber}`
      );
    }
    if (totalSupply === 0n) {
      fail(checks, launchBlockers, "live-bin-state", `totalSupply is zero for bin ${binId.toString()}`);
    }

    const burnAmount = (liveBalance * burnBps) / bpsDenominator;
    if (burnAmount === 0n) {
      fail(checks, launchBlockers, "burn-amounts", `burn amount rounds to zero for bin ${binId.toString()}`);
    }

    return {
      binId,
      indexedLiquidity: position.indexedLiquidity,
      liveBalance,
      burnAmount,
      reserveX,
      reserveY,
      totalSupply,
      expectedAmountXOut: totalSupply === 0n ? 0n : (burnAmount * reserveX) / totalSupply,
      expectedAmountYOut: totalSupply === 0n ? 0n : (burnAmount * reserveY) / totalSupply
    };
  });

  if (launchBlockers.length === 0) {
    checks.push({
      name: "same-block-live-reads",
      status: "pass",
      blockNumber,
      binCount: liveBins.length,
      readSurface: ["balanceOf", "getBin", "totalSupply"]
    });
  }

  const currentBins = await readLiveBinStates({
    rpcUrl,
    pair,
    owner,
    binIds: selected.map((position) => position.binId),
    blockNumber: rpcHeadBlock,
    labelPrefix: "current-head"
  });
  const currentStateFailures = [];
  for (let index = 0; index < liveBins.length; index += 1) {
    const indexedBin = liveBins[index];
    const currentBin = currentBins[index];
    for (const field of ["liveBalance", "reserveX", "reserveY", "totalSupply"]) {
      if (indexedBin[field] !== currentBin[field]) {
        currentStateFailures.push(
          `bin ${indexedBin.binId.toString()} ${field} changed from ${indexedBin[field].toString()} at indexed block ${blockNumber} to ${currentBin[field].toString()} at RPC head ${rpcHeadBlock}`
        );
      }
    }
  }
  if (currentStateFailures.length > 0) {
    fail(checks, launchBlockers, "current-live-state", currentStateFailures.join("; "));
  } else if (launchBlockers.length === 0) {
    checks.push({
      name: "current-live-state",
      status: "pass",
      rpcHeadBlock,
      binCount: currentBins.length,
      readSurface: ["balanceOf", "getBin", "totalSupply"]
    });
  }

  const approvalOutput = castOutput(
    rpcUrl,
    ["call", pair, "isApprovedForAll(address,address)(bool)", owner, router, "--block", String(blockNumber)],
    "LBPair.isApprovedForAll"
  );
  const approved = /\btrue\b/i.test(approvalOutput);
  if (!approved) {
    fail(checks, launchBlockers, "router-approval", `router ${router} is not approved for owner ${owner}`);
  } else {
    checks.push({ name: "router-approval", status: "pass", owner, router });
  }

  const currentApprovalOutput = castOutput(
    rpcUrl,
    ["call", pair, "isApprovedForAll(address,address)(bool)", owner, router, "--block", String(rpcHeadBlock)],
    "Current LBPair.isApprovedForAll"
  );
  const currentApproved = /\btrue\b/i.test(currentApprovalOutput);
  if (!currentApproved) {
    fail(
      checks,
      launchBlockers,
      "current-router-approval",
      `router ${router} is not currently approved for owner ${owner} at RPC head ${rpcHeadBlock}`
    );
  } else if (launchBlockers.length === 0) {
    checks.push({ name: "current-router-approval", status: "pass", owner, router, rpcHeadBlock });
  }

  const ids = liveBins.map((bin) => bin.binId);
  const amounts = liveBins.map((bin) => bin.burnAmount);
  const expectedAmountXOut = liveBins.reduce((total, bin) => total + bin.expectedAmountXOut, 0n);
  const expectedAmountYOut = liveBins.reduce((total, bin) => total + bin.expectedAmountYOut, 0n);

  if (launchBlockers.length === 0) {
    const simulation = simulateRemoveLiquidity({
      amountXMin: 0n,
      amountYMin: 0n,
      amounts,
      binStep,
      blockNumber,
      deadline,
      ids,
      owner,
      pair,
      router,
      rpcUrl,
      tokenX,
      tokenY
    });
    checks.push({
      name: "remove-liquidity-simulation",
      status: "pass",
      blockNumber,
      amountXOut: simulation[0].toString(),
      amountYOut: simulation[1].toString()
    });

    const currentSimulation = simulateRemoveLiquidity({
      amountXMin: 0n,
      amountYMin: 0n,
      amounts,
      binStep,
      blockNumber: rpcHeadBlock,
      deadline,
      ids,
      owner,
      pair,
      router,
      rpcUrl,
      tokenX,
      tokenY
    });
    checks.push({
      name: "current-remove-liquidity-simulation",
      status: "pass",
      blockNumber: rpcHeadBlock,
      amountXOut: currentSimulation[0].toString(),
      amountYOut: currentSimulation[1].toString()
    });
  }

  finish(
    {
      ok: launchBlockers.length === 0,
      manifest: summarizeManifest(manifest, manifestPath),
      owner,
      pair,
      tokenX,
      tokenY,
      binStep,
      blockNumber,
      indexerBlockHash: indexerFreshness.blockHash,
      rpcHeadBlock,
      blockLag: indexerFreshness.blockLag,
      maxIndexerLag,
      burnBps: burnBps.toString(),
      ids: ids.map(String),
      amounts: amounts.map(String),
      expectedAmountXOut: expectedAmountXOut.toString(),
      expectedAmountYOut: expectedAmountYOut.toString(),
      positions: liveBins.map((bin) => ({
        binId: bin.binId.toString(),
        indexedLiquidity: bin.indexedLiquidity.toString(),
        liveBalance: bin.liveBalance.toString(),
        burnAmount: bin.burnAmount.toString(),
        reserveX: bin.reserveX.toString(),
        reserveY: bin.reserveY.toString(),
        totalSupply: bin.totalSupply.toString()
      })),
      checks,
      warnings,
      launchBlockers
    },
    options
  );
}

async function loadOwnerPairPositions({ endpoint, maxPages, owner, pageSize, pair }) {
  const query = `
    query OwnerPairPositions($owner: Bytes!, $pair: String!, $first: Int!, $skip: Int!) {
      _meta {
        block {
          number
          hash
        }
        hasIndexingErrors
      }
      positions(first: $first, skip: $skip, orderBy: updatedAtBlock, orderDirection: desc, where: { owner: $owner, pair: $pair, liquidity_gt: 0 }) {
        id
        owner
        liquidity
        updatedAtBlock
        pair {
          id
          tokenX { id }
          tokenY { id }
          binStep
        }
        bin { binId }
      }
    }
  `;
  const rows = [];
  let pagesFetched = 0;
  let meta = null;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await graphRequest(endpoint, query, {
      owner: lower(owner),
      pair: lower(pair),
      first: pageSize,
      skip: page * pageSize
    });
    const pageRows = response?.data?.positions;
    if (!Array.isArray(pageRows)) {
      throw new Error("GraphQL owner+pair positions response is missing positions[]");
    }

    if (!meta) meta = response?.data?._meta ?? null;
    rows.push(...pageRows);
    pagesFetched += 1;
    if (pageRows.length < pageSize) {
      return { rows, pagesFetched, capped: false, meta };
    }
  }

  return { rows, pagesFetched, capped: true, meta };
}

async function graphRequest(endpoint, query, variables) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
  } catch (error) {
    throw new Error(`GraphQL request failed: ${redactSensitiveText(error.message, endpoint)}`);
  }

  if (!response.ok) {
    throw new Error(`GraphQL request failed with HTTP ${response.status}`);
  }

  let json;
  try {
    json = await response.json();
  } catch (error) {
    throw new Error(`GraphQL response was not JSON: ${redactSensitiveText(error.message, endpoint)}`);
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new Error(
      redactSensitiveText(
        json.errors.map((error) => error.message || String(error)).join("; "),
        endpoint
      )
    );
  }
  return json;
}

function simulateRemoveLiquidity(input) {
  const output = castOutput(
    input.rpcUrl,
    [
      "call",
      input.router,
      "removeLiquidity(address,address,uint16,uint256,uint256,uint256[],uint256[],address,uint256)(uint256,uint256)",
      input.tokenX,
      input.tokenY,
      String(input.binStep),
      input.amountXMin.toString(),
      input.amountYMin.toString(),
      arrayArg(input.ids),
      arrayArg(input.amounts),
      input.owner,
      input.deadline.toString(),
      "--from",
      input.owner,
      "--block",
      String(input.blockNumber)
    ],
    "removeLiquidity simulation"
  );
  const numbers = parseNumbers(output);
  if (numbers.length < 2) {
    throw new Error(`removeLiquidity simulation returned ${numbers.length} value(s), expected 2`);
  }
  return numbers;
}

function castOutput(rpcUrl, args, label) {
  try {
    return childProcess
      .execFileSync("cast", [...args, "--rpc-url", rpcUrl], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
      .trim();
  } catch (error) {
    const stderr = error && error.stderr ? redactSensitiveText(String(error.stderr).trim(), rpcUrl) : "";
    throw new Error(`${label} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

async function readLiveBinStates({ rpcUrl, pair, owner, binIds, blockNumber, labelPrefix }) {
  const requests = [];
  for (const binId of binIds) {
    requests.push({
      key: `${binId.toString()}:balanceOf`,
      data: encodeCall(balanceOfSelector, [owner, binId])
    });
    requests.push({
      key: `${binId.toString()}:getBin`,
      data: encodeCall(getBinSelector, [binId])
    });
    requests.push({
      key: `${binId.toString()}:totalSupply`,
      data: encodeCall(totalSupplySelector, [binId])
    });
  }

  const results = await batchEthCalls({ rpcUrl, pair, requests, blockNumber, labelPrefix });
  return binIds.map((binId) => {
    const id = binId.toString();
    const [liveBalance] = decodeUintWords(results.get(`${id}:balanceOf`), 1, `${labelPrefix} balanceOf bin ${id}`);
    const [reserveX, reserveY] = decodeUintWords(results.get(`${id}:getBin`), 2, `${labelPrefix} getBin ${id}`);
    const [totalSupply] = decodeUintWords(results.get(`${id}:totalSupply`), 1, `${labelPrefix} totalSupply ${id}`);
    return { binId, liveBalance, reserveX, reserveY, totalSupply };
  });
}

async function batchEthCalls({ rpcUrl, pair, requests, blockNumber, labelPrefix }) {
  const blockTag = `0x${BigInt(blockNumber).toString(16)}`;
  const results = new Map();

  for (let offset = 0; offset < requests.length; offset += rpcBatchSize) {
    const chunk = requests.slice(offset, offset + rpcBatchSize);
    const payload = chunk.map((request, index) => ({
      jsonrpc: "2.0",
      id: offset + index + 1,
      method: "eth_call",
      params: [{ to: pair, data: request.data }, blockTag]
    }));
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`${labelPrefix} RPC batch failed with HTTP ${response.status}`);

    const json = await response.json();
    if (!Array.isArray(json)) throw new Error(`${labelPrefix} RPC endpoint did not return a batch response`);
    const expectedIds = new Set(payload.map((entry) => entry.id));
    const byId = new Map();
    for (const entry of json) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Number.isInteger(entry.id)) {
        throw new Error(`${labelPrefix} RPC batch returned a malformed response entry`);
      }
      if (!expectedIds.has(entry.id)) {
        throw new Error(`${labelPrefix} RPC batch returned an unexpected response ID ${entry.id}`);
      }
      if (byId.has(entry.id)) {
        throw new Error(`${labelPrefix} RPC batch returned duplicate response ID ${entry.id}`);
      }
      byId.set(entry.id, entry);
    }
    for (let index = 0; index < chunk.length; index += 1) {
      const request = chunk[index];
      const entry = byId.get(offset + index + 1);
      if (!entry || entry.error || typeof entry.result !== "string") {
        const message = entry?.error?.message ?? "missing result";
        throw new Error(`${labelPrefix} RPC batch ${request.key} failed: ${redactSensitiveText(message, rpcUrl)}`);
      }
      results.set(request.key, entry.result);
    }
  }

  return results;
}

function encodeCall(selector, values) {
  return `0x${selector}${values.map(encodeWord).join("")}`;
}

function encodeWord(value) {
  const normalized = typeof value === "string" ? value.toLowerCase().replace(/^0x/, "") : BigInt(value).toString(16);
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length > 64) throw new Error(`cannot ABI-encode value ${String(value)}`);
  return normalized.padStart(64, "0");
}

function decodeUintWords(value, count, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]*$/i.test(value) || value.length < 2 + count * 64) {
    throw new Error(`${label} returned malformed ABI data`);
  }
  return Array.from({ length: count }, (_, index) => BigInt(`0x${value.slice(2 + index * 64, 2 + (index + 1) * 64)}`));
}

function parseNumbers(output) {
  return String(output || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[(),]/g, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => BigInt(item));
}

function arrayArg(values) {
  return `[${values.map((value) => value.toString()).join(",")}]`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--") {
      continue;
    } else if (arg === "--manifest") {
      options.manifestPath = requireValue(argv, ++index, arg);
    } else if (arg === "--owner") {
      options.owner = requireValue(argv, ++index, arg);
    } else if (arg === "--pair") {
      options.pair = requireValue(argv, ++index, arg);
    } else if (arg === "--rpc-url") {
      options.rpcUrl = requireValue(argv, ++index, arg);
    } else if (arg === "--graphql-url") {
      options.graphqlUrl = requireValue(argv, ++index, arg);
    } else if (arg === "--burn-bps") {
      options.burnBps = requireValue(argv, ++index, arg);
    } else if (arg === "--min-bins") {
      options.minBins = requireValue(argv, ++index, arg);
    } else if (arg === "--page-size") {
      options.pageSize = requireValue(argv, ++index, arg);
    } else if (arg === "--max-pages") {
      options.maxPages = requireValue(argv, ++index, arg);
    } else if (arg === "--max-indexer-lag") {
      options.maxIndexerLag = requireValue(argv, ++index, arg);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readManifest(manifestPath, checks, launchBlockers) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    checks.push({
      name: "manifest",
      status: "pass",
      path: path.relative(repoRoot, manifestPath),
      chainId: manifest.chainId,
      environment: manifest.environment
    });
    return manifest;
  } catch (error) {
    fail(checks, launchBlockers, "manifest", `could not read manifest: ${error.message}`);
    return null;
  }
}

function normalizeAddress(value, label, launchBlockers) {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value;
  }
  launchBlockers.push(`${label} must be an EVM address`);
  return null;
}

function normalizeBurnBps(value, launchBlockers) {
  const burnBps = parseBigInt(value ?? defaultBurnBps, "--burn-bps");
  if (burnBps <= 0n || burnBps > bpsDenominator) {
    launchBlockers.push("--burn-bps must be between 1 and 10000");
  }
  return burnBps;
}

function normalizePositiveInteger(value, label, launchBlockers) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    launchBlockers.push(`${label} must be a positive safe integer`);
    return 0;
  }
  return parsed;
}

function normalizeNonNegativeInteger(value, label, launchBlockers) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    launchBlockers.push(`${label} must be a non-negative safe integer`);
    return 0;
  }
  return parsed;
}

function checkIndexerFreshness({ checks, indexed, launchBlockers, maxIndexerLag, rpcHeadBlock, rpcUrl }) {
  const meta = indexed.meta;
  const blockNumber = Number(meta?.block?.number);
  const blockHash = typeof meta?.block?.hash === "string" ? meta.block.hash.toLowerCase() : "";
  const failures = [];

  if (!Number.isSafeInteger(rpcHeadBlock) || rpcHeadBlock <= 0) {
    failures.push("RPC head block is not a positive safe integer");
  }

  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
    failures.push("GraphQL _meta.block.number is missing or invalid");
  }

  if (!/^0x[0-9a-f]{64}$/.test(blockHash)) {
    failures.push("GraphQL _meta.block.hash is missing or invalid");
  }

  if (meta?.hasIndexingErrors !== false) {
    failures.push(`GraphQL _meta.hasIndexingErrors is ${String(meta?.hasIndexingErrors)}, expected false`);
  }

  const blockLag = Number.isSafeInteger(blockNumber) ? rpcHeadBlock - blockNumber : null;
  if (Number.isSafeInteger(blockLag)) {
    if (blockLag < 0) {
      failures.push(`GraphQL indexer block ${blockNumber} is ahead of RPC head ${rpcHeadBlock}`);
    } else if (blockLag > maxIndexerLag) {
      failures.push(`GraphQL indexer lag ${blockLag} block(s) exceeds --max-indexer-lag ${maxIndexerLag}`);
    }
  }

  let rpcBlockHash = null;
  if (failures.length === 0) {
    rpcBlockHash = castOutput(rpcUrl, ["block", String(blockNumber), "--field", "hash"], `RPC block hash ${blockNumber}`)
      .trim()
      .toLowerCase();
    if (rpcBlockHash !== blockHash) {
      failures.push(`GraphQL _meta block hash ${blockHash} does not match RPC block hash ${rpcBlockHash}`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) launchBlockers.push(failure);
  }

  checks.push({
    name: "indexer-freshness",
    status: failures.length === 0 ? "pass" : "fail",
    graphqlBlockNumber: Number.isSafeInteger(blockNumber) ? blockNumber : null,
    graphqlBlockHash: blockHash || null,
    rpcBlockHash,
    rpcHeadBlock: Number.isSafeInteger(rpcHeadBlock) ? rpcHeadBlock : null,
    blockLag,
    maxIndexerLag,
    hasIndexingErrors: meta?.hasIndexingErrors ?? null,
    message: failures.length > 0 ? failures.join("; ") : undefined
  });

  return { blockNumber, blockHash, blockLag };
}

function parseBigInt(value, label) {
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function compareBigInt(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

function summarizeManifest(manifest, manifestPath) {
  if (!manifest) return null;
  return {
    path: path.relative(repoRoot, manifestPath),
    environment: manifest.environment,
    chainId: manifest.chainId,
    lbRouter: manifest.contracts?.lbRouter
  };
}

function fail(checks, launchBlockers, name, message) {
  checks.push({ name, status: "fail", message });
  launchBlockers.push(message);
}

function redactSensitiveText(value, rpcUrl) {
  let text = String(value || "");
  if (rpcUrl) text = text.split(rpcUrl).join("[REDACTED_RPC_URL]");
  return text.replace(/https?:\/\/[^\s)'"`]+/gi, "[REDACTED_URL]");
}

function finish(report, options) {
  const fullReport = {
    ok: report.launchBlockers.length === 0,
    ...report
  };
  printResult(fullReport, options.json);
  if (fullReport.launchBlockers.length > 0) process.exitCode = 1;
}

function printResult(report, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  for (const check of report.checks || []) {
    console.log(`${check.status.toUpperCase()} ${check.name}${check.message ? `: ${check.message}` : ""}`);
  }
  for (const warning of report.warnings || []) {
    console.log(`WARN ${warning}`);
  }
  for (const blocker of report.launchBlockers || []) {
    console.log(`BLOCKED ${blocker}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/robinhood/rehearse-remove-liquidity.cjs --manifest <latest.json> --owner <address> --pair <address> [options]

Options:
  --rpc-url <url>       RPC URL. Defaults to manifest endpoints.rpcUrl.
  --graphql-url <url>   GraphQL URL. Defaults to manifest endpoints.indexerUrl.
  --burn-bps <bps>      Basis points of each live bin balance to simulate burning. Default: ${defaultBurnBps}.
  --min-bins <count>    Minimum indexed owner+pair bins required. Default: 2.
  --page-size <count>   GraphQL page size. Default: ${defaultPageSize}.
  --max-pages <count>   Maximum GraphQL pages before capped state. Default: ${defaultMaxPages}.
  --max-indexer-lag <n> Maximum GraphQL _meta block lag versus RPC head. Default: ${defaultMaxIndexerLag}.
  --json                Print JSON evidence.`);
}

module.exports = { readLiveBinStates };
