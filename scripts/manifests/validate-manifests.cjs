#!/usr/bin/env node
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join, relative, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");
const schemaPath = join(repoRoot, "packages/sdk/src/manifests/schema.json");
const zeroAddress = "0x0000000000000000000000000000000000000000";
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const sourceCommitPattern = /^[a-fA-F0-9]{40}$/;
const allowedSchemaVersions = new Set(["lb.localnet.v1", "lb.robinhood.v1"]);
const allowedEndpointKeys = ["rpcUrl", "indexerUrl", "apiUrl", "tokenListUrl"];
const requiredCoreContracts = ["lbFactory", "lbPairImplementation", "lbRouter", "lbQuoter"];
const disabledLegacyRoutingConstructorArgs = [
  "routerFactoryV1",
  "routerFactoryV2_1",
  "routerLegacyFactoryV2",
  "routerLegacyRouterV2"
];
const commonManifestKeys = [
  "chainId",
  "contracts",
  "constructorArgs",
  "deployer",
  "endpoints",
  "environment",
  "factoryPreset",
  "ownership",
  "schemaVersion",
  "sourceJoeV2Commit",
  "startBlock",
  "tokens"
];
const localnetManifestKeys = [...commonManifestKeys, "seededPools", "smoke"];
const robinhoodManifestKeys = [...commonManifestKeys, "chain", "quoteAssets"];

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.map((file) => resolve(repoRoot, file)) : defaultManifestFiles();
  const errors = [...validateSchemaAlignment(), ...files.flatMap(validateFile)];

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${files.length} deployment manifest${files.length === 1 ? "" : "s"}.`);
}

function defaultManifestFiles() {
  const examplesDir = join(repoRoot, "deployments/examples");
  return readdirSync(examplesDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => join(examplesDir, file));
}

function validateFile(file) {
  const displayPath = relative(repoRoot, file);
  const errors = [];

  if (!existsSync(file)) {
    return [`${displayPath}: file does not exist`];
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return [`${displayPath}: invalid JSON: ${error.message}`];
  }

  if (!isObject(manifest)) {
    return [`${displayPath}: manifest must be an object`];
  }

  expectString(manifest.schemaVersion, `${displayPath}.schemaVersion`, errors);
  expectString(manifest.environment, `${displayPath}.environment`, errors);
  expectInteger(manifest.chainId, `${displayPath}.chainId`, errors);
  expectInteger(manifest.startBlock, `${displayPath}.startBlock`, errors, { min: 0 });
  expectString(manifest.sourceJoeV2Commit, `${displayPath}.sourceJoeV2Commit`, errors);
  expectAddress(manifest.deployer, `${displayPath}.deployer`, errors, { allowZero: false });

  if (!allowedSchemaVersions.has(manifest.schemaVersion)) {
    errors.push(`${displayPath}.schemaVersion: unsupported schemaVersion ${format(manifest.schemaVersion)}`);
  }

  if (typeof manifest.sourceJoeV2Commit === "string" && !sourceCommitPattern.test(manifest.sourceJoeV2Commit)) {
    errors.push(`${displayPath}.sourceJoeV2Commit: expected 40-character git commit`);
  }

  validateEndpoints(manifest.endpoints, `${displayPath}.endpoints`, errors);
  validateContracts(manifest.contracts, `${displayPath}.contracts`, errors);
  validateOwnership(manifest.ownership, manifest.constructorArgs, `${displayPath}.ownership`, errors);
  validatePreset(manifest.factoryPreset, `${displayPath}.factoryPreset`, errors);
  validateObject(manifest.constructorArgs, `${displayPath}.constructorArgs`, errors);
  validateDisabledLegacyRouting(manifest, displayPath, errors);
  validateNoZapFields(manifest, displayPath, errors);

  if (manifest.schemaVersion === "lb.localnet.v1") {
    validateLocalnet(manifest, displayPath, errors);
  } else if (manifest.schemaVersion === "lb.robinhood.v1") {
    validateRobinhood(manifest, displayPath, errors);
  }

  return errors;
}

function validateLocalnet(manifest, displayPath, errors) {
  rejectUnexpectedKeys(manifest, new Set(localnetManifestKeys), displayPath, errors);

  if (manifest.environment !== "localnet") {
    errors.push(`${displayPath}.environment: expected "localnet" for lb.localnet.v1`);
  }

  if (!Number.isInteger(manifest.chainId) || manifest.chainId < 1) {
    errors.push(`${displayPath}.chainId: expected positive localnet chain ID`);
  }

  validateAddressRecord(manifest.tokens, `${displayPath}.tokens`, ["wnative", "usdc", "usdt", "weth"], errors, {
    allowZero: false,
    allowAdditional: false
  });

  const seededPools = validateObject(manifest.seededPools, `${displayPath}.seededPools`, errors);
  const wnativeUsdc = seededPools && validateObject(seededPools.wnativeUsdc, `${displayPath}.seededPools.wnativeUsdc`, errors);
  if (wnativeUsdc) {
    expectAddress(wnativeUsdc.pair, `${displayPath}.seededPools.wnativeUsdc.pair`, errors, { allowZero: false });
    expectAddress(wnativeUsdc.tokenX, `${displayPath}.seededPools.wnativeUsdc.tokenX`, errors, { allowZero: false });
    expectAddress(wnativeUsdc.tokenY, `${displayPath}.seededPools.wnativeUsdc.tokenY`, errors, { allowZero: false });
    expectInteger(wnativeUsdc.activeId, `${displayPath}.seededPools.wnativeUsdc.activeId`, errors);
    expectInteger(wnativeUsdc.binStep, `${displayPath}.seededPools.wnativeUsdc.binStep`, errors, { min: 1 });
  }

  const smoke = validateObject(manifest.smoke, `${displayPath}.smoke`, errors);
  if (smoke) {
    expectAddress(smoke.swapTokenIn, `${displayPath}.smoke.swapTokenIn`, errors, { allowZero: false });
    expectAddress(smoke.swapTokenOut, `${displayPath}.smoke.swapTokenOut`, errors, { allowZero: false });
  }
}

function validateRobinhood(manifest, displayPath, errors) {
  rejectUnexpectedKeys(manifest, new Set(robinhoodManifestKeys), displayPath, errors);

  if (manifest.environment !== "testnet" && manifest.environment !== "mainnet") {
    errors.push(`${displayPath}.environment: expected "testnet" or "mainnet" for lb.robinhood.v1`);
  }

  if (manifest.environment === "testnet" && manifest.chainId !== 46_630) {
    errors.push(`${displayPath}.chainId: expected 46630 for testnet`);
  }

  if (manifest.environment === "mainnet" && manifest.chainId !== 4_663) {
    errors.push(`${displayPath}.chainId: expected 4663 for mainnet`);
  }

  const chain = validateObject(manifest.chain, `${displayPath}.chain`, errors);
  if (chain) {
    rejectUnexpectedKeys(
      chain,
      new Set(["explorerUrl", "name", "nativeCurrency", "rpcEnvVar", "verifierUrl"]),
      `${displayPath}.chain`,
      errors
    );
    expectString(chain.name, `${displayPath}.chain.name`, errors);
    expectString(chain.rpcEnvVar, `${displayPath}.chain.rpcEnvVar`, errors);
    expectString(chain.explorerUrl, `${displayPath}.chain.explorerUrl`, errors);
    expectString(chain.verifierUrl, `${displayPath}.chain.verifierUrl`, errors);
    if (chain.nativeCurrency !== "ETH") {
      errors.push(`${displayPath}.chain.nativeCurrency: expected "ETH"`);
    }
  }

  validateAddressRecord(manifest.tokens, `${displayPath}.tokens`, ["wrappedNative"], errors, {
    allowZero: false,
    allowAdditional: false
  });
  validateQuoteAssets(manifest.quoteAssets, `${displayPath}.quoteAssets`, errors);
}

function validateNoZapFields(manifest, displayPath, errors) {
  if (Object.prototype.hasOwnProperty.call(manifest, "zap")) {
    errors.push(`${displayPath}.zap: on-chain Zap was removed; this field must be absent`);
  }
  if (isObject(manifest.contracts) && Object.prototype.hasOwnProperty.call(manifest.contracts, "zap")) {
    errors.push(`${displayPath}.contracts.zap: on-chain Zap was removed; this field must be absent`);
  }
  if (isObject(manifest.constructorArgs)) {
    for (const key of Object.keys(manifest.constructorArgs)) {
      if (/^zap/i.test(key)) errors.push(`${displayPath}.constructorArgs.${key}: on-chain Zap was removed; this field must be absent`);
    }
  }
}

function validateDisabledLegacyRouting(manifest, displayPath, errors) {
  for (const key of disabledLegacyRoutingConstructorArgs) {
    const path = `${displayPath}.constructorArgs.${key}`;
    const value = manifest.constructorArgs?.[key];
    expectAddress(value, path, errors, { allowZero: true });
    if (typeof value === "string" && addressPattern.test(value) && lower(value) !== zeroAddress) {
      errors.push(`${path}: expected zero address for V2.2-only routing`);
    }
  }
}

function validateContracts(value, path, errors) {
  validateAddressRecord(value, path, requiredCoreContracts, errors, {
    allowZero: false,
    allowAdditional: false
  });
}

function validateEndpoints(value, path, errors) {
  const endpoints = validateObject(value, path, errors);
  if (!endpoints) return;

  rejectUnexpectedKeys(endpoints, new Set(allowedEndpointKeys), path, errors);
  expectString(endpoints.rpcUrl, `${path}.rpcUrl`, errors);
  for (const key of ["indexerUrl", "apiUrl", "tokenListUrl"]) {
    if (endpoints[key] !== undefined && endpoints[key] !== null) {
      expectString(endpoints[key], `${path}.${key}`, errors);
    }
  }
}

function validateOwnership(value, constructorArgs, path, errors) {
  validateAddressRecord(value, path, ["feeRecipient", "initialOwner", "lbFactoryOwner"], errors, {
    allowZero: false,
    allowAdditional: false
  });

  if (isObject(value) && isObject(constructorArgs)) {
    if (typeof constructorArgs.feeRecipient === "string" && lower(constructorArgs.feeRecipient) !== lower(value.feeRecipient)) {
      errors.push(`${path}.feeRecipient: must match constructorArgs.feeRecipient`);
    }
    if (typeof constructorArgs.initialOwner === "string" && lower(constructorArgs.initialOwner) !== lower(value.initialOwner)) {
      errors.push(`${path}.initialOwner: must match constructorArgs.initialOwner`);
    }
  }
}

function validatePreset(value, path, errors) {
  const preset = validateObject(value, path, errors);
  if (!preset) return;

  const keys = [
    "baseFactor",
    "binStep",
    "decayPeriod",
    "filterPeriod",
    "maxVolatilityAccumulator",
    "protocolShare",
    "reductionFactor",
    "variableFeeControl"
  ];
  rejectUnexpectedKeys(preset, new Set([...keys, "open"]), path, errors);

  for (const key of keys) {
    expectInteger(preset[key], `${path}.${key}`, errors);
  }

  if (typeof preset.open !== "boolean") {
    errors.push(`${path}.open: expected boolean`);
  }
}

function validateAddressRecord(value, path, requiredKeys, errors, options) {
  const record = validateObject(value, path, errors);
  if (!record) return;

  if (options.allowAdditional !== true) {
    rejectUnexpectedKeys(record, new Set([...requiredKeys, ...(options.optionalKeys ?? [])]), path, errors);
  }

  for (const key of requiredKeys) {
    expectAddress(record[key], `${path}.${key}`, errors, options);
  }

  for (const [key, address] of Object.entries(record)) {
    if (typeof address === "string") {
      expectAddress(address, `${path}.${key}`, errors, options);
    }
  }
}

function validateQuoteAssets(value, path, errors) {
  const record = validateObject(value, path, errors);
  if (!record) return;

  expectAddress(record.wrappedNative, `${path}.wrappedNative`, errors, { allowZero: false });

  for (const [key, address] of Object.entries(record)) {
    if (typeof address === "string") {
      expectAddress(address, `${path}.${key}`, errors, { allowZero: key !== "wrappedNative" });
    }
  }
}

function validateSchemaAlignment() {
  const errors = [];
  let schema;

  try {
    schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch (error) {
    return [`packages/sdk/src/manifests/schema.json: invalid JSON: ${error.message}`];
  }

  const defs = schema && schema.$defs;
  if (!isObject(defs)) {
    return ["packages/sdk/src/manifests/schema.json.$defs: expected object"];
  }

  if (defs.nonZeroAddress?.not?.const !== zeroAddress) {
    errors.push("packages/sdk/src/manifests/schema.json.$defs.nonZeroAddress: must reject the zero address");
  }

  const endpointConfig = defs.endpointConfig;
  if (!isObject(endpointConfig) || endpointConfig.additionalProperties !== false) {
    errors.push("packages/sdk/src/manifests/schema.json.$defs.endpointConfig: must forbid additional properties");
  }
  expectSchemaRequired(endpointConfig, ["rpcUrl"], "$defs.endpointConfig", errors);

  const contracts = defs.contracts;
  expectSchemaRequired(contracts, requiredCoreContracts, "$defs.contracts", errors);
  for (const key of requiredCoreContracts) {
    if (contracts?.properties?.[key]?.$ref !== "#/$defs/nonZeroAddress") {
      errors.push(`packages/sdk/src/manifests/schema.json.$defs.contracts.properties.${key}: must use nonZeroAddress`);
    }
  }
  if (contracts?.properties && Object.prototype.hasOwnProperty.call(contracts.properties, "zap")) {
    errors.push("packages/sdk/src/manifests/schema.json.$defs.contracts.properties.zap: on-chain Zap was removed");
  }

  const ownership = defs.ownership;
  expectSchemaRequired(ownership, ["feeRecipient", "initialOwner", "lbFactoryOwner"], "$defs.ownership", errors);
  for (const key of ["feeRecipient", "initialOwner", "lbFactoryOwner"]) {
    if (ownership?.properties?.[key]?.$ref !== "#/$defs/nonZeroAddress") {
      errors.push(`packages/sdk/src/manifests/schema.json.$defs.ownership.properties.${key}: must use nonZeroAddress`);
    }
  }

  const disabledLegacyRouting = defs.disabledLegacyRoutingConstructorArgs;
  expectSchemaRequired(
    disabledLegacyRouting,
    disabledLegacyRoutingConstructorArgs,
    "$defs.disabledLegacyRoutingConstructorArgs",
    errors
  );
  for (const key of disabledLegacyRoutingConstructorArgs) {
    if (disabledLegacyRouting?.properties?.[key]?.const !== zeroAddress) {
      errors.push(
        `packages/sdk/src/manifests/schema.json.$defs.disabledLegacyRoutingConstructorArgs.properties.${key}: must require the zero address`
      );
    }
  }

  const root = defs.root;
  if (root?.properties?.deployer?.$ref !== "#/$defs/nonZeroAddress") {
    errors.push("packages/sdk/src/manifests/schema.json.$defs.root.properties.deployer: must use nonZeroAddress");
  }
  if (root?.properties?.constructorArgs?.$ref !== "#/$defs/disabledLegacyRoutingConstructorArgs") {
    errors.push(
      "packages/sdk/src/manifests/schema.json.$defs.root.properties.constructorArgs: must require disabled legacy routing constructor args"
    );
  }

  if (Object.prototype.hasOwnProperty.call(defs, "zapMetadata")) {
    errors.push("packages/sdk/src/manifests/schema.json.$defs.zapMetadata: on-chain Zap was removed");
  }

  const localnetChainId = defs.localnetManifest?.allOf?.[1]?.properties?.chainId;
  if (localnetChainId?.type !== "integer" || localnetChainId?.minimum !== 1) {
    errors.push("packages/sdk/src/manifests/schema.json.$defs.localnetManifest: must allow positive localnet chain IDs");
  }

  const robinhoodAllOf = defs.robinhoodManifest?.allOf;
  if (!Array.isArray(robinhoodAllOf) || !hasThenConst(robinhoodAllOf, "testnet", 46_630) || !hasThenConst(robinhoodAllOf, "mainnet", 4_663)) {
    errors.push("packages/sdk/src/manifests/schema.json.$defs.robinhoodManifest: must require testnet/mainnet chain IDs");
  }
  if (/\"zap\"/.test(JSON.stringify(defs.robinhoodManifest))) {
    errors.push("packages/sdk/src/manifests/schema.json.$defs.robinhoodManifest: on-chain Zap fields must be absent");
  }
  if (!Array.isArray(robinhoodAllOf) || !hasDisabledLegacyRoutingReference(robinhoodAllOf)) {
    errors.push("packages/sdk/src/manifests/schema.json.$defs.robinhoodManifest: must require disabled legacy routing constructor args");
  }

  return errors;
}

function expectSchemaRequired(schema, expectedKeys, path, errors) {
  if (!isObject(schema) || !sameStringSet(schema.required, expectedKeys)) {
    errors.push(`packages/sdk/src/manifests/schema.json.${path}.required: expected ${expectedKeys.join(", ")}`);
  }
}

function hasThenConst(allOf, environment, chainId) {
  return allOf.some((entry) => entry?.if?.properties?.environment?.const === environment && entry?.then?.properties?.chainId?.const === chainId);
}

function hasDisabledLegacyRoutingReference(allOf) {
  return allOf.some(
    (entry) => entry?.properties?.constructorArgs?.$ref === "#/$defs/disabledLegacyRoutingConstructorArgs"
  );
}

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((key) => actual.includes(key)) &&
    actual.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function rejectUnexpectedKeys(value, allowedKeys, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${path}.${key}: unexpected field`);
    }
  }
}

function expectAddress(value, path, errors, options = { allowZero: false }) {
  if (typeof value !== "string" || !addressPattern.test(value)) {
    errors.push(`${path}: expected EVM address`);
    return;
  }

  if (!options.allowZero && value.toLowerCase() === zeroAddress) {
    errors.push(`${path}: expected non-zero address`);
  }
}

function expectInteger(value, path, errors, options = {}) {
  if (!Number.isInteger(value)) {
    errors.push(`${path}: expected integer`);
    return;
  }

  if (options.min !== undefined && value < options.min) {
    errors.push(`${path}: expected integer >= ${options.min}`);
  }

  if (options.max !== undefined && value > options.max) {
    errors.push(`${path}: expected integer <= ${options.max}`);
  }
}

function expectString(value, path, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path}: expected non-empty string`);
  }
}

function validateObject(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path}: expected object`);
    return null;
  }

  return value;
}

function format(value) {
  return JSON.stringify(value);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

main();
