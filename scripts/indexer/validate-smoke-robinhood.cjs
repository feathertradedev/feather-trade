#!/usr/bin/env node

const childProcess = require("child_process");
const fs = require("fs");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Could not read ${label} at ${filePath}: ${error.message}`);
  }
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function lowerAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    fail(`Manifest ${label} must be an EVM address.`);
  }
  return value.toLowerCase();
}

function indexedAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    fail(`${label} must be an indexed EVM address.`);
  }
  return value.toLowerCase();
}

function parseInteger(value, label) {
  try {
    const parsed = BigInt(String(value));
    return parsed;
  } catch (_) {
    fail(`${label} must be an integer, got ${value}.`);
  }
}

function requireIntegerRange(value, label, { min = 0n, max = null } = {}) {
  const parsed = parseInteger(value, label);
  if (parsed < min || (max != null && parsed > max)) {
    const maxText = max == null ? "" : ` and <= ${max.toString()}`;
    fail(`${label} must be >= ${min.toString()}${maxText}, got ${parsed.toString()}.`);
  }
  return parsed;
}

function positive(value) {
  try {
    return BigInt(String(value || "0")) > 0n;
  } catch (_) {
    return false;
  }
}

function nonzeroBytes(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && /[1-9a-fA-F]/.test(value.slice(2));
}

function parsePairList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function castOutput(rpcUrl, args, label) {
  try {
    return childProcess
      .execFileSync("cast", args, {
        encoding: "utf8",
        env: { ...process.env, ETH_RPC_URL: rpcUrl },
        stdio: ["ignore", "pipe", "pipe"]
      })
      .trim();
  } catch (_) {
    fail(`${label} failed against the configured RPC.`);
  }
}

function castCall(rpcUrl, address, signature, args, blockNumber, label) {
  return castOutput(rpcUrl, ["call", address, signature, ...args, "--block", String(blockNumber)], label);
}

function castBlockHash(rpcUrl, blockNumber) {
  const hash = castOutput(rpcUrl, ["block", String(blockNumber), "--field", "hash"], `RPC block ${blockNumber} hash read`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    fail(`RPC block ${blockNumber} returned an invalid hash.`);
  }
  return hash.toLowerCase();
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

function castNumbers(rpcUrl, address, signature, args, blockNumber, label, expectedCount = 1) {
  const numbers = parseNumbers(castCall(rpcUrl, address, signature, args, blockNumber, label));
  if (numbers.length < expectedCount) {
    fail(`${label} returned ${numbers.length} value(s), expected ${expectedCount}.`);
  }
  return numbers;
}

function hasPair(item, pairSet) {
  return pairSet.has(lower(item && item.pair && item.pair.id));
}

function hasSwapActivity(item) {
  return (
    (positive(item.amountInX) || positive(item.amountInY)) &&
    (positive(item.amountOutX) || positive(item.amountOutY)) &&
    nonzeroBytes(item.amountsIn) &&
    nonzeroBytes(item.amountsOut)
  );
}

function hasLiquidityActivity(item, type) {
  return (
    item.type === type &&
    Array.isArray(item.ids) &&
    item.ids.length > 0 &&
    Array.isArray(item.amounts) &&
    item.amounts.length > 0 &&
    (positive(item.amountX) || positive(item.amountY)) &&
    item.amounts.some(nonzeroBytes)
  );
}

function requireActivity({ items, pairSet, pairLabel, predicate, singular }) {
  const matches = items.filter((item) => hasPair(item, pairSet) && predicate(item));
  if (matches.length === 0) {
    fail(`Robinhood smoke expected ${singular} for ${pairLabel}.`);
  }
  return matches;
}

function requirePairActivity({ items, pairs, predicate, singular }) {
  const matches = [];
  for (const pair of pairs) {
    const pairAddress = lower(pair.id);
    const pairSet = new Set([pairAddress]);
    const pairMatches = items.filter((item) => hasPair(item, pairSet) && predicate(item));
    if (pairMatches.length === 0) {
      fail(`Expected pair ${pairAddress} is missing ${singular}.`);
    }
    matches.push(...pairMatches);
  }
  return matches;
}

function validatePairIntegrity(pair, expectedFactory) {
  const pairAddress = indexedAddress(pair && pair.id, "Indexed pair id");
  const pairFactory = indexedAddress(pair && pair.factory && pair.factory.id, `Indexed pair ${pairAddress} factory id`);
  const tokenX = indexedAddress(pair && pair.tokenX && pair.tokenX.id, `Indexed pair ${pairAddress} tokenX id`);
  const tokenY = indexedAddress(pair && pair.tokenY && pair.tokenY.id, `Indexed pair ${pairAddress} tokenY id`);

  if (pairFactory !== expectedFactory) {
    fail(`Indexed pair ${pairAddress} is attached to factory ${pairFactory}, expected ${expectedFactory}.`);
  }

  if (tokenX === tokenY) {
    fail(`Indexed pair ${pairAddress} tokenX and tokenY are identical.`);
  }

  requireIntegerRange(pair.binStep, `Indexed pair ${pairAddress} binStep`, { min: 1n, max: 65_535n });
  requireIntegerRange(pair.activeId, `Indexed pair ${pairAddress} activeId`, { min: 0n, max: 16_777_215n });
  requireIntegerRange(pair.reserveX, `Indexed pair ${pairAddress} reserveX`);
  requireIntegerRange(pair.reserveY, `Indexed pair ${pairAddress} reserveY`);
  requireIntegerRange(pair.swapCount, `Indexed pair ${pairAddress} swapCount`);
  requireIntegerRange(pair.depositCount, `Indexed pair ${pairAddress} depositCount`);
  requireIntegerRange(pair.withdrawCount, `Indexed pair ${pairAddress} withdrawCount`);

  return pairAddress;
}

const file = process.argv[2];
const manifestFile = process.argv[3];
const rpcUrl = process.env.ETH_RPC_URL || "";
const expectedPairs = parsePairList(process.argv[4] || process.env.INDEXER_ROBINHOOD_EXPECT_PAIRS);
const allowEmpty = process.env.INDEXER_ROBINHOOD_ALLOW_EMPTY === "1";
const rpcHeadBlock = process.argv[5] ? Number(process.argv[5]) : null;
const maxLagBlocks = Number(process.env.INDEXER_ROBINHOOD_MAX_LAG_BLOCKS || "20");

if (!file || !manifestFile) {
  fail("Usage: validate-smoke-robinhood.cjs <subgraph-response.json> <deployment-manifest.json> [expected-pair-csv] [rpc-head-block]");
}

const result = readJson(file, "subgraph smoke response");
const manifest = readJson(manifestFile, "Robinhood deployment manifest");

if (result.errors && result.errors.length > 0) {
  fail(result.errors.map((error) => error.message).join("\n"));
}

const data = result.data || {};

if (!data._meta || data._meta.hasIndexingErrors !== false) {
  fail("Subgraph metadata is missing or reports indexing errors.");
}

const startBlock = Number(manifest.startBlock);
if (!Number.isInteger(startBlock) || startBlock < 0) {
  fail(`Manifest startBlock must be a non-negative integer: ${manifestFile}`);
}

if (Number(data._meta.block && data._meta.block.number) < startBlock) {
  fail(`Subgraph indexed block ${data._meta.block && data._meta.block.number} is before manifest startBlock ${startBlock}.`);
}

const indexedBlock = Number(data._meta.block && data._meta.block.number);
if (!Number.isInteger(indexedBlock) || indexedBlock < 0) {
  fail("Subgraph metadata is missing a valid indexed block number.");
}
const indexedBlockHash = lower(data._meta.block && data._meta.block.hash);
if (!/^0x[0-9a-f]{64}$/.test(indexedBlockHash)) {
  fail("Subgraph metadata is missing a valid indexed block hash.");
}

if (rpcHeadBlock != null) {
  if (!Number.isInteger(rpcHeadBlock) || rpcHeadBlock < 0) {
    fail(`RPC head block is not a valid non-negative integer: ${process.argv[5]}`);
  }

  if (!Number.isInteger(maxLagBlocks) || maxLagBlocks < 0) {
    fail(`INDEXER_ROBINHOOD_MAX_LAG_BLOCKS must be a non-negative integer, got ${process.env.INDEXER_ROBINHOOD_MAX_LAG_BLOCKS}`);
  }

  if (indexedBlock > rpcHeadBlock) {
    fail(`Subgraph indexed block ${indexedBlock} is ahead of RPC head ${rpcHeadBlock}.`);
  }

  if (rpcHeadBlock - indexedBlock > maxLagBlocks) {
    fail(`Subgraph indexed block ${indexedBlock} is ${rpcHeadBlock - indexedBlock} blocks behind RPC head ${rpcHeadBlock}; max lag is ${maxLagBlocks}.`);
  }
}

const rpcBlockHash = rpcUrl ? castBlockHash(rpcUrl, indexedBlock) : null;
if (rpcBlockHash !== null && rpcBlockHash !== indexedBlockHash) {
  fail(`Subgraph block hash ${indexedBlockHash} does not match RPC block ${indexedBlock} hash ${rpcBlockHash}.`);
}

const expectedFactory = lowerAddress(manifest.contracts && manifest.contracts.lbFactory, "contracts.lbFactory");
const factories = Array.isArray(data.factories) ? data.factories : [];
const pairs = Array.isArray(data.pairs) ? data.pairs : [];
const bins = Array.isArray(data.bins) ? data.bins : [];
const swaps = Array.isArray(data.swaps) ? data.swaps : [];
const liquidityEvents = Array.isArray(data.liquidityEvents) ? data.liquidityEvents : [];
const positions = Array.isArray(data.positions) ? data.positions : [];
const factory = factories.find((item) => lower(item.id) === expectedFactory);

if (!factory) {
  fail(`Indexed factory ${expectedFactory} was not found.`);
}

if (!allowEmpty && pairs.length === 0) {
  fail("Robinhood smoke expected at least one indexed pair. Set INDEXER_ROBINHOOD_ALLOW_EMPTY=1 only for pre-liquidity endpoint checks.");
}

if (!allowEmpty && !positive(factory.pairCount)) {
  fail(`Indexed factory ${expectedFactory} has no pairs.`);
}

if (allowEmpty && (pairs.length > 0 || positive(factory.pairCount))) {
  fail(
    "INDEXER_ROBINHOOD_ALLOW_EMPTY=1 is only allowed for pre-liquidity endpoint checks with zero indexed pairs and factory pairCount 0."
  );
}

const factoryPairCount = requireIntegerRange(factory.pairCount, `Indexed factory ${expectedFactory} pairCount`);
if (!allowEmpty && factoryPairCount < BigInt(pairs.length)) {
  fail(`Indexed factory ${expectedFactory} pairCount ${factoryPairCount.toString()} is below returned pair count ${pairs.length}.`);
}

const expectedPairSet = new Set(expectedPairs);
for (const expectedPair of expectedPairSet) {
  if (!/^0x[0-9a-f]{40}$/.test(expectedPair)) {
    fail(`Expected pair is not a valid address: ${expectedPair}`);
  }
  if (!pairs.some((pair) => lower(pair.id) === expectedPair)) {
    fail(`Expected pair ${expectedPair} was not found in indexed pairs.`);
  }
}

for (const pair of pairs) {
  validatePairIntegrity(pair, expectedFactory);
}

const sampledPairs = pairs.filter((pair) => expectedPairSet.size === 0 || expectedPairSet.has(lower(pair.id))).slice(0, 5);
const rpcChecks = [];
const activityPairSet = new Set(sampledPairs.map((pair) => lower(pair.id)));
const checkedActivity = {
  swaps: 0,
  deposits: 0,
  withdrawals: 0,
  positions: 0
};

if (!allowEmpty && sampledPairs.length === 0) {
  fail("Robinhood smoke has no sampled pairs to check for activity.");
}

if (!allowEmpty && sampledPairs.length > 0) {
  const activityPairLabel =
    expectedPairSet.size > 0 ? `expected pair(s) ${sampledPairs.map((pair) => lower(pair.id)).join(", ")}` : "sampled indexed pairs";
  const requireScopedActivity =
    expectedPairSet.size > 0
      ? ({ items, predicate, singular }) => requirePairActivity({ items, pairs: sampledPairs, predicate, singular })
      : ({ items, predicate, singular }) =>
          requireActivity({ items, pairSet: activityPairSet, pairLabel: activityPairLabel, predicate, singular });

  checkedActivity.swaps = requireScopedActivity({
    items: swaps,
    predicate: hasSwapActivity,
    singular: "a decoded indexed swap"
  }).length;
  checkedActivity.deposits = requireScopedActivity({
    items: liquidityEvents,
    predicate: (item) => hasLiquidityActivity(item, "DEPOSIT"),
    singular: "a nonzero indexed deposit"
  }).length;
  checkedActivity.withdrawals = requireScopedActivity({
    items: liquidityEvents,
    predicate: (item) => hasLiquidityActivity(item, "WITHDRAW"),
    singular: "a nonzero indexed withdrawal"
  }).length;
  checkedActivity.positions = requireScopedActivity({
    items: positions,
    predicate: (item) => positive(item.liquidity),
    singular: "a nonzero LP position"
  }).length;
}

if (!allowEmpty && rpcUrl && sampledPairs.length > 0) {
  for (const pair of sampledPairs) {
    const pairAddress = lower(pair.id);
    const activeId = castNumbers(
      rpcUrl,
      pairAddress,
      "getActiveId()(uint24)",
      [],
      indexedBlock,
      `Pair ${pairAddress} getActiveId()`
    )[0];
    const reserves = castNumbers(
      rpcUrl,
      pairAddress,
      "getReserves()(uint128,uint128)",
      [],
      indexedBlock,
      `Pair ${pairAddress} getReserves()`,
      2
    );
    const activeBin = castNumbers(
      rpcUrl,
      pairAddress,
      "getBin(uint24)(uint128,uint128)",
      [String(activeId)],
      indexedBlock,
      `Pair ${pairAddress} getBin(${activeId.toString()})`,
      2
    );
    const activeBinTotalSupply = castNumbers(
      rpcUrl,
      pairAddress,
      "totalSupply(uint256)(uint256)",
      [String(activeId)],
      indexedBlock,
      `Pair ${pairAddress} totalSupply(${activeId.toString()})`
    )[0];

    if (BigInt(String(pair.activeId || "0")) !== activeId) {
      fail(`Pair ${pairAddress} activeId ${pair.activeId} does not match RPC ${activeId}.`);
    }

    if (BigInt(String(pair.reserveX || "0")) !== reserves[0] || BigInt(String(pair.reserveY || "0")) !== reserves[1]) {
      fail(`Pair ${pairAddress} reserves do not match RPC getReserves().`);
    }

    const indexedActiveBin = bins.find(
      (bin) => lower(bin.pair && bin.pair.id) === pairAddress && BigInt(String(bin.binId || "0")) === activeId
    );
    if (!indexedActiveBin) {
      fail(`Pair ${pairAddress} active bin ${activeId.toString()} was not returned by the indexer smoke query.`);
    }
    if (
      BigInt(String(indexedActiveBin.reserveX || "0")) !== activeBin[0] ||
      BigInt(String(indexedActiveBin.reserveY || "0")) !== activeBin[1]
    ) {
      fail(`Pair ${pairAddress} active bin ${activeId.toString()} reserves do not match RPC getBin().`);
    }
    if (BigInt(String(indexedActiveBin.totalSupply || "0")) !== activeBinTotalSupply) {
      fail(`Pair ${pairAddress} active bin ${activeId.toString()} totalSupply does not match RPC totalSupply(id).`);
    }

    rpcChecks.push({
      pair: pairAddress,
      activeId: activeId.toString(),
      reserveX: reserves[0].toString(),
      reserveY: reserves[1].toString(),
      activeBinReserveX: activeBin[0].toString(),
      activeBinReserveY: activeBin[1].toString(),
      activeBinTotalSupply: activeBinTotalSupply.toString()
    });
  }
}

console.log(
  JSON.stringify(
    {
      block: data._meta.block.number,
      rpcHeadBlock,
      rpcBlockHash,
      maxLagBlocks,
      allowEmpty,
      blockHash: data._meta.block.hash,
      factory: expectedFactory,
      pairCount: String(factory.pairCount || pairs.length),
      indexedPairs: pairs.length,
      indexedBins: bins.length,
      swaps: swaps.length,
      liquidityEvents: liquidityEvents.length,
      positions: positions.length,
      requiredActivity: checkedActivity,
      rpcChecks
    },
    null,
    2
  )
);
