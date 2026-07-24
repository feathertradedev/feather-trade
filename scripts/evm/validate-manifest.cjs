#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const manifestPath = process.argv[2];
const expectedNetwork = process.argv[3];
const expectedChainId = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
const zeroAddress = "0x0000000000000000000000000000000000000000";
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const commitPattern = /^[0-9a-fA-F]{40}$/;
const errors = [];

if (!manifestPath) fail("Usage: node scripts/evm/validate-manifest.cjs <manifest> [network] [chain-id]");

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`${manifestPath}: ${error.message}`);
}

validateRoot(manifest);

if (expectedNetwork !== undefined && manifest?.environment !== expectedNetwork) {
  errors.push(`environment: expected ${JSON.stringify(expectedNetwork)}, got ${JSON.stringify(manifest?.environment)}`);
}
if (expectedChainId !== undefined && manifest?.chainId !== expectedChainId) {
  errors.push(`chainId: expected ${expectedChainId}, got ${JSON.stringify(manifest?.chainId)}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`${manifestPath}: ${error}`);
  process.exit(1);
}

console.log(`Validated EVM deployment manifest: ${path.resolve(manifestPath)}`);

function validateRoot(value) {
  const root = object(value, "manifest");
  if (!root) return;
  onlyKeys(root, "manifest", [
    "chain",
    "chainId",
    "constructorArgs",
    "contracts",
    "deployer",
    "endpoints",
    "environment",
    "factoryPreset",
    "ownership",
    "quoteAssets",
    "schemaVersion",
    "sourceCommit",
    "sourceTreeDirty",
    "startBlock",
    "tokens"
  ], ["endpoints"]);

  if (root.schemaVersion !== "lb.evm.v1") errors.push(`schemaVersion: expected "lb.evm.v1"`);
  nonBlank(root.environment, "environment");
  if (typeof root.environment === "string" && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(root.environment)) {
    errors.push("environment: expected lowercase network slug");
  }
  integer(root.chainId, "chainId", 1);
  integer(root.startBlock, "startBlock", 0);
  address(root.deployer, "deployer", false);
  if (typeof root.sourceCommit !== "string" || !commitPattern.test(root.sourceCommit)) {
    errors.push("sourceCommit: expected 40-character git commit");
  }
  if (typeof root.sourceTreeDirty !== "boolean") errors.push("sourceTreeDirty: expected boolean");

  validateChain(root.chain);
  if (root.endpoints !== undefined) validateEndpoints(root.endpoints);
  validateContracts(root.contracts);
  validateOwnership(root.ownership, root.deployer);
  validateTokens(root.tokens);
  validateQuoteAssets(root.quoteAssets, root.tokens?.wrappedNative);
  validatePreset(root.factoryPreset);
  validateConstructorArgs(root.constructorArgs, root);
}

function validateEndpoints(value) {
  const endpoints = object(value, "endpoints");
  if (!endpoints) return;
  onlyKeys(endpoints, "endpoints", ["apiUrl", "indexerUrl", "rpcUrl", "tokenListUrl"]);
  runtimeUrl(endpoints.rpcUrl, "endpoints.rpcUrl", false);
  for (const key of ["apiUrl", "indexerUrl", "tokenListUrl"]) {
    if (endpoints[key] !== null) runtimeUrl(endpoints[key], `endpoints.${key}`, true);
  }
}

function validateChain(value) {
  const chain = object(value, "chain");
  if (!chain) return;
  onlyKeys(chain, "chain", ["explorerUrl", "name", "nativeCurrency", "rpcEnvVar", "verifierUrl"]);
  nonBlank(chain.name, "chain.name");
  nonBlank(chain.nativeCurrency, "chain.nativeCurrency");
  nonBlank(chain.rpcEnvVar, "chain.rpcEnvVar");
  if (typeof chain.rpcEnvVar === "string" && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(chain.rpcEnvVar)) {
    errors.push("chain.rpcEnvVar: expected environment variable name");
  }
  publicMetadataUrl(chain.explorerUrl, "chain.explorerUrl");
  publicMetadataUrl(chain.verifierUrl, "chain.verifierUrl");
}

function validateContracts(value) {
  const contracts = object(value, "contracts");
  if (!contracts) return;
  const keys = ["lbFactory", "lbPairImplementation", "lbRouter", "lbQuoter"];
  onlyKeys(contracts, "contracts", keys);
  for (const key of keys) address(contracts[key], `contracts.${key}`, false);
  const present = keys.map((key) => lower(contracts[key])).filter(Boolean);
  if (new Set(present).size !== present.length) errors.push("contracts: core addresses must be unique");
}

function validateOwnership(value, deployer) {
  const ownership = object(value, "ownership");
  if (!ownership) return;
  const keys = ["feeRecipient", "initialOwner", "lbFactoryOwner"];
  onlyKeys(ownership, "ownership", keys);
  for (const key of keys) {
    address(ownership[key], `ownership.${key}`, false);
    if (lower(ownership[key]) !== lower(deployer)) errors.push(`ownership.${key}: v1 deployer must retain ownership`);
  }
}

function validateTokens(value) {
  const tokens = object(value, "tokens");
  if (!tokens) return;
  onlyKeys(tokens, "tokens", ["wrappedNative"]);
  address(tokens.wrappedNative, "tokens.wrappedNative", false);
}

function validateQuoteAssets(value, wrappedNative) {
  const assets = object(value, "quoteAssets");
  if (!assets) return;
  const keys = ["wrappedNative", "extra0", "extra1", "extra2", "extra3"];
  onlyKeys(assets, "quoteAssets", keys);
  address(assets.wrappedNative, "quoteAssets.wrappedNative", false);
  if (lower(assets.wrappedNative) !== lower(wrappedNative)) {
    errors.push("quoteAssets.wrappedNative: must match tokens.wrappedNative");
  }
  const seen = new Set([lower(assets.wrappedNative)]);
  for (const key of keys.slice(1)) {
    address(assets[key], `quoteAssets.${key}`, true);
    const normalized = lower(assets[key]);
    if (!normalized || normalized === zeroAddress) continue;
    if (seen.has(normalized)) errors.push(`quoteAssets.${key}: duplicate quote asset`);
    seen.add(normalized);
  }
}

function validatePreset(value) {
  const preset = object(value, "factoryPreset");
  if (!preset) return;
  const integerKeys = [
    "baseFactor",
    "binStep",
    "decayPeriod",
    "filterPeriod",
    "maxVolatilityAccumulator",
    "protocolShare",
    "reductionFactor",
    "variableFeeControl"
  ];
  onlyKeys(preset, "factoryPreset", [...integerKeys, "open"]);
  for (const key of integerKeys) integer(preset[key], `factoryPreset.${key}`, 0);
  if (typeof preset.open !== "boolean") errors.push("factoryPreset.open: expected boolean");

  const expected = {
    baseFactor: 10_000,
    binStep: 10,
    decayPeriod: 600,
    filterPeriod: 30,
    maxVolatilityAccumulator: 350_000,
    protocolShare: 0,
    reductionFactor: 5_000,
    variableFeeControl: 40_000,
    open: true
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (preset[key] !== expectedValue) {
      errors.push(`factoryPreset.${key}: expected ${JSON.stringify(expectedValue)}`);
    }
  }
}

function validateConstructorArgs(value, root) {
  const args = object(value, "constructorArgs");
  if (!args) return;
  const addressKeys = [
    "feeRecipient",
    "initialOwner",
    "routerFactoryV1",
    "routerLegacyFactoryV2",
    "routerLegacyRouterV2",
    "routerFactoryV2_1",
    "routerWNative",
    "quoterFactoryV1",
    "quoterLegacyFactoryV2",
    "quoterFactoryV2_1",
    "quoterFactoryV2_2",
    "quoterLegacyRouterV2",
    "quoterRouterV2_1",
    "quoterRouterV2_2"
  ];
  onlyKeys(args, "constructorArgs", [...addressKeys, "flashLoanFee"]);
  for (const key of addressKeys) address(args[key], `constructorArgs.${key}`, true);
  integer(args.flashLoanFee, "constructorArgs.flashLoanFee", 0);
  if (args.flashLoanFee !== 5_000_000_000_000) {
    errors.push("constructorArgs.flashLoanFee: expected 5000000000000");
  }

  equalAddress(args.feeRecipient, root.ownership?.feeRecipient, "constructorArgs.feeRecipient");
  equalAddress(args.initialOwner, root.ownership?.initialOwner, "constructorArgs.initialOwner");
  equalAddress(args.routerWNative, root.tokens?.wrappedNative, "constructorArgs.routerWNative");
  equalAddress(args.quoterFactoryV2_2, root.contracts?.lbFactory, "constructorArgs.quoterFactoryV2_2");
  equalAddress(args.quoterRouterV2_2, root.contracts?.lbRouter, "constructorArgs.quoterRouterV2_2");

  for (const key of [
    "routerFactoryV1",
    "routerLegacyFactoryV2",
    "routerLegacyRouterV2",
    "routerFactoryV2_1",
    "quoterFactoryV1",
    "quoterLegacyFactoryV2",
    "quoterFactoryV2_1",
    "quoterLegacyRouterV2",
    "quoterRouterV2_1"
  ]) {
    if (lower(args[key]) !== zeroAddress) errors.push(`constructorArgs.${key}: legacy routing must remain disabled`);
  }
}

function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${label}: expected object`);
    return null;
  }
  return value;
}

function onlyKeys(value, label, keys, optionalKeys = []) {
  const allowed = new Set(keys);
  const optional = new Set(optionalKeys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label}.${key}: unexpected field`);
  for (const key of keys) {
    if (!optional.has(key) && !Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${label}.${key}: missing field`);
  }
}

function address(value, label, allowZero) {
  if (typeof value !== "string" || !addressPattern.test(value)) {
    errors.push(`${label}: expected EVM address`);
    return;
  }
  if (!allowZero && lower(value) === zeroAddress) errors.push(`${label}: expected non-zero address`);
}

function integer(value, label, minimum) {
  if (!Number.isInteger(value) || value < minimum) errors.push(`${label}: expected integer >= ${minimum}`);
}

function nonBlank(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) errors.push(`${label}: expected non-empty string`);
}

function publicMetadataUrl(value, label) {
  if (typeof value !== "string") {
    errors.push(`${label}: expected string`);
    return;
  }
  if (value.length === 0) return;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) errors.push(`${label}: expected HTTP(S) URL`);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      errors.push(`${label}: credentials, query parameters, and fragments are prohibited`);
    }
  } catch (_) {
    errors.push(`${label}: expected absolute URL or empty string`);
  }
}

function runtimeUrl(value, label, nullable) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label}: expected non-empty URL string${nullable ? " or null" : ""}`);
    return;
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) errors.push(`${label}: expected HTTP(S) URL`);
    if (parsed.username || parsed.password || parsed.hash) {
      errors.push(`${label}: credentials and fragments are prohibited`);
    }
  } catch (_) {
    errors.push(`${label}: expected absolute URL`);
  }
}

function equalAddress(actual, expected, label) {
  if (lower(actual) !== lower(expected)) errors.push(`${label}: does not match deployed manifest state`);
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
