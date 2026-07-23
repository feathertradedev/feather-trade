#!/usr/bin/env node
const { existsSync, readFileSync } = require("node:fs");
const { relative, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");
const zeroAddress = "0x0000000000000000000000000000000000000000";
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const disabledLegacyRoutingConstructorArgs = [
  "routerFactoryV1",
  "routerFactoryV2_1",
  "routerLegacyFactoryV2",
  "routerLegacyRouterV2"
];
const environmentConfig = {
  sepolia: {
    chainId: 11_155_111,
    manifestEnvironment: "sepolia",
    manifestEnvVar: "VITE_SEPOLIA_MANIFEST_PATH",
    requireCanonicalStableQuote: true,
    requireIndexer: false,
    schemaVersion: "lb.evm.v1",
    tokenList: "packages/sdk/src/token-lists/sepolia.json",
    tokenListEnvironment: "sepolia"
  },
  robinhoodTestnet: {
    chainId: 46_630,
    manifestEnvironment: "testnet",
    manifestEnvVar: "VITE_ROBINHOOD_TESTNET_MANIFEST_PATH",
    requireCanonicalStableQuote: false,
    requireIndexer: true,
    schemaVersion: "lb.robinhood.v1",
    tokenList: "packages/sdk/src/token-lists/robinhood-testnet.json",
    tokenListEnvironment: "robinhoodTestnet"
  },
  robinhood: {
    chainId: 4_663,
    manifestEnvironment: "mainnet",
    manifestEnvVar: "VITE_ROBINHOOD_MANIFEST_PATH",
    requireCanonicalStableQuote: true,
    requireIndexer: true,
    schemaVersion: "lb.robinhood.v1",
    tokenList: "packages/sdk/src/token-lists/robinhood.json",
    tokenListEnvironment: "robinhood"
  }
};
const anvilAddresses = new Set([
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720"
]);

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const errors = validateOptions(options);
  if (errors.length > 0) {
    printErrors(errors);
    process.exitCode = 1;
    return;
  }

  const config = environmentConfig[options.environment];
  const manifestPath = resolve(repoRoot, options.manifest);
  const tokenListPath = resolve(repoRoot, options.tokenList ?? config.tokenList);
  const manifest = readJson(manifestPath, errors);
  const tokenList = readJson(tokenListPath, errors);

  if (manifest !== null) {
    validateManifest(manifest, manifestPath, config, options, errors);
  }

  if (tokenList !== null) {
    validateTokenList(tokenList, tokenListPath, config, errors);
  }

  if (manifest !== null && tokenList !== null) {
    validateManifestTokenListMatch(manifest, tokenList, manifestPath, tokenListPath, errors);
  }

  if (errors.length > 0) {
    printErrors(errors);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Validated public ${options.environment} config with ${relative(repoRoot, manifestPath)} and ${relative(repoRoot, tokenListPath)}.`
  );
}

function validateManifest(manifest, manifestPath, config, options, errors) {
  const path = relative(repoRoot, manifestPath);
  if (!isObject(manifest)) {
    errors.push(`${path}: manifest must be a JSON object`);
    return;
  }

  if (path.includes("/dry-run.json") || path.endsWith("dry-run.json")) {
    errors.push(`${path}: public builds must use a broadcast latest.json or promoted immutable manifest, not dry-run.json`);
  }

  expectEqual(manifest.schemaVersion, config.schemaVersion, `${path}.schemaVersion`, errors);
  expectEqual(manifest.environment, config.manifestEnvironment, `${path}.environment`, errors);
  expectEqual(manifest.chainId, config.chainId, `${path}.chainId`, errors);
  expectInteger(manifest.startBlock, `${path}.startBlock`, errors, { min: 1 });
  for (const field of ["seededPools", "smoke"]) {
    if (Object.prototype.hasOwnProperty.call(manifest, field)) {
      errors.push(`${path}.${field}: public manifests must not include localnet-only ${field}`);
    }
  }
  expectAddress(manifest.deployer, `${path}.deployer`, errors, { allowAnvil: false });
  expectAddress(manifest.tokens?.wrappedNative, `${path}.tokens.wrappedNative`, errors, { allowAnvil: false });
  expectAddress(manifest.quoteAssets?.wrappedNative, `${path}.quoteAssets.wrappedNative`, errors, { allowAnvil: false });

  for (const key of ["lbFactory", "lbPairImplementation", "lbRouter", "lbQuoter"]) {
    expectAddress(manifest.contracts?.[key], `${path}.contracts.${key}`, errors, { allowAnvil: false });
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "zap") || Object.prototype.hasOwnProperty.call(manifest.contracts ?? {}, "zap")) {
    errors.push(`${path}: on-chain Zap was removed; zap and contracts.zap must be absent`);
  }
  for (const key of Object.keys(manifest.constructorArgs ?? {})) {
    if (/^zap/i.test(key)) errors.push(`${path}.constructorArgs.${key}: on-chain Zap constructor fields must be absent`);
  }

  for (const key of ["feeRecipient", "initialOwner", "lbFactoryOwner"]) {
    expectAddress(manifest.ownership?.[key], `${path}.ownership.${key}`, errors, { allowAnvil: false });
  }
  validateDisabledLegacyRouting(manifest.constructorArgs, `${path}.constructorArgs`, errors);

  validateEndpoint(manifest.endpoints?.rpcUrl, `${path}.endpoints.rpcUrl`, errors, { required: true });
  validateEndpoint(manifest.endpoints?.indexerUrl, `${path}.endpoints.indexerUrl`, errors, {
    required: config.requireIndexer
  });
  validateEndpoint(manifest.endpoints?.apiUrl, `${path}.endpoints.apiUrl`, errors, { required: false });

  const tokenListSource = options.tokenListSource ?? "bundled";
  validateEndpoint(manifest.endpoints?.tokenListUrl, `${path}.endpoints.tokenListUrl`, errors, {
    required: tokenListSource === "hosted"
  });

  if (tokenListSource === "bundled" && typeof manifest.endpoints?.tokenListUrl === "string") {
    errors.push(`${path}.endpoints.tokenListUrl: bundled token-list builds should leave tokenListUrl null until runtime fetching is implemented`);
  }
}

function validateDisabledLegacyRouting(constructorArgs, path, errors) {
  for (const key of disabledLegacyRoutingConstructorArgs) {
    const value = constructorArgs?.[key];
    if (typeof value !== "string" || !addressPattern.test(value)) {
      errors.push(`${path}.${key}: expected EVM address`);
      continue;
    }
    if (value.toLowerCase() !== zeroAddress) {
      errors.push(`${path}.${key}: expected zero address for V2.2-only routing`);
    }
  }
}

function validateTokenList(tokenList, tokenListPath, config, errors) {
  const path = relative(repoRoot, tokenListPath);
  if (!isObject(tokenList)) {
    errors.push(`${path}: token list must be a JSON object`);
    return;
  }

  expectEqual(tokenList.schemaVersion, "lb.token-list.v1", `${path}.schemaVersion`, errors);
  expectEqual(tokenList.chainId, config.chainId, `${path}.chainId`, errors);
  expectEqual(tokenList.environment, config.tokenListEnvironment, `${path}.environment`, errors);

  if (!Array.isArray(tokenList.tokens) || tokenList.tokens.length === 0) {
    errors.push(`${path}.tokens: expected a non-empty token array`);
    return;
  }

  const quoteTokens = [];
  for (const [index, token] of tokenList.tokens.entries()) {
    const tokenPath = `${path}.tokens[${index}]`;
    if (!isObject(token)) {
      errors.push(`${tokenPath}: expected token object`);
      continue;
    }

    expectAddress(token.address, `${tokenPath}.address`, errors, { allowAnvil: false });

    if (!Array.isArray(token.tags)) {
      errors.push(`${tokenPath}.tags: expected tag array`);
      continue;
    }

    if (token.tags.includes("mock") || token.tags.includes("localnet")) {
      errors.push(`${tokenPath}.tags: public token lists must not include mock or localnet tags`);
    }

    if (token.tags.includes("quote")) {
      quoteTokens.push(token);
    }
  }

  if (config.requireCanonicalStableQuote && quoteTokens.length !== 1) {
    errors.push(`${path}.tokens: expected exactly one canonical stablecoin quote token, got ${quoteTokens.length}`);
  }

  if (config.requireCanonicalStableQuote) {
    for (const token of quoteTokens) {
      if (!token.tags.includes("canonical") || !token.tags.includes("stablecoin")) {
        errors.push(`${path}.tokens: quote token ${token.symbol ?? token.id ?? "<unknown>"} must be canonical and stablecoin`);
      }
    }
  }
}

function validateManifestTokenListMatch(manifest, tokenList, manifestPath, tokenListPath, errors) {
  if (!isObject(manifest) || !isObject(tokenList) || !Array.isArray(tokenList.tokens)) {
    return;
  }

  const manifestDisplay = relative(repoRoot, manifestPath);
  const tokenListDisplay = relative(repoRoot, tokenListPath);
  const quoteAssets = new Set(
    Object.values(manifest.quoteAssets ?? {})
      .filter((value) => typeof value === "string" && value.toLowerCase() !== zeroAddress)
      .map((value) => value.toLowerCase())
  );

  if (typeof manifest.tokens?.wrappedNative === "string") {
    const wrappedNative = manifest.tokens.wrappedNative.toLowerCase();
    const listedWrappedNative = tokenList.tokens.find((token) => Array.isArray(token.tags) && token.tags.includes("wrapped-native"));
    if (listedWrappedNative?.address?.toLowerCase() !== wrappedNative) {
      errors.push(`${tokenListDisplay}: wrapped-native token must match ${manifestDisplay}.tokens.wrappedNative`);
    }
  }

  for (const token of tokenList.tokens) {
    if (!isObject(token) || !Array.isArray(token.tags) || !token.tags.includes("quote")) {
      continue;
    }

    if (typeof token.address !== "string" || !quoteAssets.has(token.address.toLowerCase())) {
      errors.push(`${tokenListDisplay}: quote token ${token.symbol ?? token.id ?? "<unknown>"} is not present in ${manifestDisplay}.quoteAssets`);
    }
  }
}

function validateEndpoint(value, path, errors, options) {
  if (value === null || value === undefined || value === "") {
    if (options.required) {
      errors.push(`${path}: required for public builds`);
    }
    return;
  }

  if (typeof value !== "string") {
    errors.push(`${path}: expected string URL`);
    return;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${path}: expected absolute URL`);
    return;
  }

  if (url.protocol !== "https:") {
    errors.push(`${path}: public endpoints must use https`);
  }

  const hostname = url.hostname.toLowerCase();
  if (isLocalEndpointHost(hostname)) {
    errors.push(`${path}: public endpoints must not use local hosts`);
  }
}

function isLocalEndpointHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    /^::ffff:127\./.test(host) ||
    /^0:0:0:0:0:ffff:127\./.test(host) ||
    /^::ffff:7f[0-9a-f]{2}:/.test(host) ||
    /^0:0:0:0:0:ffff:7f[0-9a-f]{2}:/.test(host)
  );
}

function validateOptions(options) {
  const errors = [];

  if (!Object.hasOwn(environmentConfig, options.environment)) {
    errors.push("--environment must be sepolia, robinhoodTestnet, or robinhood");
  }

  if (typeof options.manifest !== "string" || options.manifest.length === 0) {
    errors.push("--manifest is required");
  }

  if (options.tokenListSource !== undefined && !["bundled", "hosted"].includes(options.tokenListSource)) {
    errors.push("--token-list-source must be bundled or hosted");
  }

  return errors;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument ${arg}`);
    }

    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    options[toCamelCase(arg.slice(2))] = next;
    index += 1;
  }

  return options;
}

function readJson(path, errors) {
  if (!existsSync(path)) {
    errors.push(`${relative(repoRoot, path)}: file does not exist`);
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${relative(repoRoot, path)}: invalid JSON: ${error.message}`);
    return null;
  }
}

function expectAddress(value, path, errors, options = {}) {
  if (typeof value !== "string" || !addressPattern.test(value)) {
    errors.push(`${path}: expected EVM address`);
    return;
  }

  const normalized = value.toLowerCase();
  if (normalized === zeroAddress) {
    errors.push(`${path}: expected non-zero address`);
  }

  if (options.allowAnvil === false && anvilAddresses.has(normalized)) {
    errors.push(`${path}: Anvil default addresses are not valid public deployment addresses`);
  }
}

function expectEqual(actual, expected, path, errors) {
  if (actual !== expected) {
    errors.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
}

function printErrors(errors) {
  for (const error of errors) {
    console.error(error);
  }
}

function printHelp() {
  console.log(`Usage: pnpm web:validate:public-config -- --environment <sepolia|robinhoodTestnet|robinhood> --manifest <path> [--token-list <path>] [--token-list-source bundled|hosted]

Validates a promoted public web configuration before building with the matching Vite manifest path env var:
  sepolia          -> VITE_SEPOLIA_MANIFEST_PATH
  robinhoodTestnet -> VITE_ROBINHOOD_TESTNET_MANIFEST_PATH
  robinhood        -> VITE_ROBINHOOD_MANIFEST_PATH`);
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
