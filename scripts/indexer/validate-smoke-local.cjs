#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const file = process.argv[2];
const manifestFile =
  process.argv[3] || process.env.LOCALNET_MANIFEST_PATH || path.resolve(__dirname, "../../deployments/localnet/latest.json");
const expectedBlockHash = (process.argv[4] || "").toLowerCase();

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

function positive(value) {
  try {
    return BigInt(String(value || "0")) > 0n;
  } catch (_) {
    return false;
  }
}

function amountEq(actual, expected) {
  try {
    return BigInt(String(actual || "0")) === BigInt(String(expected || "0"));
  } catch (_) {
    return false;
  }
}

function nonzeroBytes(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && /[1-9a-fA-F]/.test(value.slice(2));
}

if (!file) {
  fail("Usage: validate-smoke-local.cjs <subgraph-response.json> [deployment-manifest.json] [expected-block-hash]");
}

const result = readJson(file, "subgraph smoke response");
const manifest = readJson(manifestFile, "localnet deployment manifest");

if (result.errors && result.errors.length > 0) {
  fail(result.errors.map((error) => error.message).join("\n"));
}

const data = result.data || {};

if (!data._meta || data._meta.hasIndexingErrors !== false) {
  fail("Subgraph metadata is missing or reports indexing errors.");
}

if (expectedBlockHash && lower(data._meta.block && data._meta.block.hash) !== expectedBlockHash) {
  fail(
    `Subgraph head ${lower(data._meta.block && data._meta.block.hash)} does not match local RPC head ${expectedBlockHash}.`
  );
}

const expectedFactory = lowerAddress(manifest.contracts && manifest.contracts.lbFactory, "contracts.lbFactory");
const startBlock = Number(manifest.startBlock);
const smoke = manifest.smoke || {};
const smokeTokenIn = smoke.swapTokenIn ? lowerAddress(smoke.swapTokenIn, "smoke.swapTokenIn") : null;
const smokeTokenOut = smoke.swapTokenOut ? lowerAddress(smoke.swapTokenOut, "smoke.swapTokenOut") : null;
const seededPools = Object.entries(manifest.seededPools || {}).map(([name, pool]) => ({
  name,
  pair: lowerAddress(pool && pool.pair, `seededPools.${name}.pair`),
  tokenX: lowerAddress(pool && pool.tokenX, `seededPools.${name}.tokenX`),
  tokenY: lowerAddress(pool && pool.tokenY, `seededPools.${name}.tokenY`),
  binStep: String(pool && pool.binStep)
}));

if (!Number.isInteger(startBlock) || startBlock < 0) {
  fail(`Manifest startBlock must be a non-negative integer: ${manifestFile}`);
}

if (Number(data._meta.block && data._meta.block.number) < startBlock) {
  fail(`Subgraph indexed block ${data._meta.block && data._meta.block.number} is before manifest startBlock ${startBlock}.`);
}

if (seededPools.length === 0) {
  fail(`Manifest is missing seeded pool addresses: ${manifestFile}`);
}

const factories = Array.isArray(data.factories) ? data.factories : [];
const pairs = Array.isArray(data.pairs) ? data.pairs : [];
const swaps = Array.isArray(data.swaps) ? data.swaps : [];
const liquidityEvents = Array.isArray(data.liquidityEvents) ? data.liquidityEvents : [];
const positions = Array.isArray(data.positions) ? data.positions : [];

const factory = factories.find((item) => lower(item.id) === expectedFactory);
if (!factory) {
  fail(`Indexed factory ${expectedFactory} was not found.`);
}

if (!positive(factory.pairCount)) {
  fail(`Indexed factory ${expectedFactory} has no pairs.`);
}

const checkedSeededPairs = [];

for (const seededPool of seededPools) {
  const pair = pairs.find((item) => lower(item.id) === seededPool.pair);
  if (!pair) {
    fail(`Indexed seeded pair ${seededPool.name} at ${seededPool.pair} was not found.`);
  }

  if (lower(pair.factory && pair.factory.id) !== expectedFactory) {
    fail(`Seeded pair ${seededPool.name} is attached to ${lower(pair.factory && pair.factory.id)}, expected ${expectedFactory}.`);
  }

  if (lower(pair.tokenX && pair.tokenX.id) !== seededPool.tokenX || lower(pair.tokenY && pair.tokenY.id) !== seededPool.tokenY) {
    fail(`Seeded pair ${seededPool.name} token ordering does not match ${manifestFile}.`);
  }

  if (String(pair.binStep) !== seededPool.binStep) {
    fail(`Seeded pair ${seededPool.name} binStep ${pair.binStep} does not match manifest ${seededPool.binStep}.`);
  }

  if (!positive(pair.reserveX) || !positive(pair.reserveY)) {
    fail(`Seeded pair ${seededPool.name} reserves are not both positive.`);
  }

  const expectsXForY = smokeTokenIn === seededPool.tokenX && smokeTokenOut === seededPool.tokenY;
  const expectsYForX = smokeTokenIn === seededPool.tokenY && smokeTokenOut === seededPool.tokenX;
  const isSmokePool = expectsXForY || expectsYForX;
  const hasExactSmokeSwap = smoke.swapAmountIn != null && smoke.swapAmountOut != null && (expectsXForY || expectsYForX);

  if (!positive(pair.depositCount)) {
    fail(`Seeded pair ${seededPool.name} deposit count is missing.`);
  }

  if (isSmokePool && !positive(pair.totalVolumeX) && !positive(pair.totalVolumeY)) {
    fail(`Smoke pair ${seededPool.name} decoded volume is not positive.`);
  }

  if (isSmokePool && !positive(pair.swapCount)) {
    fail(`Smoke pair ${seededPool.name} swap count is missing.`);
  }

  const swap = isSmokePool ? swaps.find((item) => {
    if (lower(item.pair && item.pair.id) !== seededPool.pair || !nonzeroBytes(item.amountsIn) || !nonzeroBytes(item.amountsOut)) {
      return false;
    }

    if (hasExactSmokeSwap && expectsXForY) {
      return (
        amountEq(item.amountInX, smoke.swapAmountIn) &&
        amountEq(item.amountInY, 0) &&
        amountEq(item.amountOutX, 0) &&
        amountEq(item.amountOutY, smoke.swapAmountOut)
      );
    }

    if (hasExactSmokeSwap && expectsYForX) {
      return (
        amountEq(item.amountInX, 0) &&
        amountEq(item.amountInY, smoke.swapAmountIn) &&
        amountEq(item.amountOutX, smoke.swapAmountOut) &&
        amountEq(item.amountOutY, 0)
      );
    }

    return (positive(item.amountInX) || positive(item.amountInY)) && (positive(item.amountOutX) || positive(item.amountOutY));
  }) : null;
  if (isSmokePool && !swap) {
    fail(`Smoke pair ${seededPool.name} has no decoded indexed swap matching the manifest side ordering.`);
  }

  const liquidityEvent = liquidityEvents.find(
    (item) =>
      lower(item.pair && item.pair.id) === seededPool.pair &&
      item.type === "DEPOSIT" &&
      Array.isArray(item.ids) &&
      item.ids.length > 0 &&
      (isSmokePool && smoke.liquidityAmountX != null ? amountEq(item.amountX, smoke.liquidityAmountX) : positive(item.amountX)) &&
      (isSmokePool && smoke.liquidityAmountY != null ? amountEq(item.amountY, smoke.liquidityAmountY) : positive(item.amountY))
  );
  if (!liquidityEvent) {
    fail(`Seeded pair ${seededPool.name} has no nonzero decoded indexed deposit.`);
  }

  const position = positions.find((item) => lower(item.pair && item.pair.id) === seededPool.pair && positive(item.liquidity));
  if (!position) {
    fail(`Seeded pair ${seededPool.name} has no nonzero LP position.`);
  }

  const checkedPair = {
    name: seededPool.name,
    pair: seededPool.pair,
    swap: swap?.id ?? null,
    liquidityEvent: liquidityEvent.id,
    position: position.id
  };

  checkedSeededPairs.push(checkedPair);
}

console.log(
  JSON.stringify(
    {
      block: data._meta.block.number,
      blockHash: data._meta.block.hash,
      factory: expectedFactory,
      seededPairs: checkedSeededPairs
    },
    null,
    2
  )
);
