#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const walletVendorAuditFile = "wallet-vendor-audit.json";
const walletVendorAuditSchema = "feather.wallet-vendor-audit.v1";
const anvilAddresses = [
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
];
const localnetManifestAddresses = [
  "0x0165878A594ca255338adfa4d48449f69242Eb8F",
  "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
  "0x4A47586912f0e03d9f3DCAa762fB8B659E52604b",
  "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
  "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
];
const environmentConfig = {
  sepolia: {
    chainId: 11_155_111,
    tokenList: "packages/sdk/src/token-lists/sepolia.json"
  },
  robinhoodTestnet: {
    chainId: 46_630,
    tokenList: "packages/sdk/src/token-lists/robinhood-testnet.json"
  },
  robinhood: {
    chainId: 4_663,
    tokenList: "packages/sdk/src/token-lists/robinhood.json"
  }
};
const secretCanaryEnvVars = [
  "EVM_DEPLOYER_PRIVATE_KEY",
  "EVM_DEPLOY_RPC_URL",
  "SEPOLIA_RPC_URL",
  "ROBINHOOD_DEPLOYER_PRIVATE_KEY",
  "DEPLOYER_PRIVATE_KEY",
  "GOLDSKY_API_KEY",
  "ROBINHOOD_TESTNET_RPC_URL",
  "ROBINHOOD_RPC_URL",
  "ROBINHOOD_ARCHIVE_RPC_URL",
  "ROBINHOOD_FALLBACK_RPC_URL",
  "ROBINHOOD_MAINNET_ARCHIVE_RPC_URL",
  "ROBINHOOD_MAINNET_FALLBACK_RPC_URL",
  "ROBINHOOD_TESTNET_ARCHIVE_RPC_URL",
  "ROBINHOOD_TESTNET_FALLBACK_RPC_URL",
  "ROBINHOOD_SUBGRAPH_URL",
  "INDEXER_ROBINHOOD_ENDPOINT",
  "AVALANCHE_RPC_URL"
];
const walletVendorAllowedForbiddenValues = new Set([
  "http://127.0.0.1",
  "https://127.0.0.1",
  "http://localhost",
  "https://localhost",
  "ws://127.0.0.1",
  "wss://127.0.0.1",
  "ws://localhost",
  "31337",
  // viem's bundled Anvil/Hardhat chain definitions include this deterministic
  // local deployment address. App-owned modules remain subject to the ban.
  "0x5fbdb2315678afecb367f032d93f642f64180aa3"
]);
const walletVendorAllowedLocalEndpointUrls = new Set([
  "http://127.0.0.1:8545",
  "http://127.0.0.1:9944",
  "http://localhost:15001/",
  "http://localhost:15001/api/v2",
  "http://localhost:15005/",
  "http://localhost:15005/api",
  "http://localhost:15045",
  "http://localhost:15100",
  "http://localhost:15200",
  "http://localhost:3050",
  "http://localhost:8011",
  "http://localhost:8545",
  "ws://127.0.0.1:8545",
  "ws://localhost:15101",
  "ws://localhost:15201",
  "wss://127.0.0.1:9944"
]);
const forbiddenPublicBuildValues = [
  "dry-run.json",
  "lb.localnet.v1",
  "http://0.0.0.0",
  "https://0.0.0.0",
  "http://127.0.0.1",
  "https://127.0.0.1",
  "http://localhost",
  "https://localhost",
  "http://[::1]",
  "https://[::1]",
  "ws://0.0.0.0",
  "wss://0.0.0.0",
  "ws://127.0.0.1",
  "wss://127.0.0.1",
  "ws://localhost",
  "wss://localhost",
  "ws://[::1]",
  "wss://[::1]",
  "31337",
  ...anvilAddresses,
  ...localnetManifestAddresses
];

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const errors = [];
  const config = environmentConfig[options.environment];
  if (config === undefined) errors.push("--environment must be sepolia, robinhoodTestnet, or robinhood");
  if (typeof options.manifest !== "string") errors.push("--manifest is required");
  if (typeof options.dist !== "string") errors.push("--dist is required");
  if (errors.length > 0) return finish(errors);

  const manifestPath = path.resolve(repoRoot, options.manifest);
  const distPath = path.resolve(repoRoot, options.dist);
  const tokenListPath = path.resolve(repoRoot, options.tokenList ?? config.tokenList);
  const manifest = readJson(manifestPath, errors);
  const tokenList = readJson(tokenListPath, errors);
  if (!fs.existsSync(distPath) || !fs.statSync(distPath).isDirectory()) {
    errors.push(`${display(distPath)}: dist directory does not exist`);
  }
  if (errors.length > 0) return finish(errors);

  const files = listFiles(distPath);
  requireFile(distPath, "index.html", errors);
  for (const controlFile of ["_worker.js", "_headers", "_redirects"]) {
    forbidFile(distPath, controlFile, errors);
  }
  requireFile(distPath, "robots.txt", errors);
  requireFile(distPath, "sitemap.xml", errors);
  requireFile(distPath, "docs/index.html", errors);
  requireFile(distPath, "docs/docs-manifest.json", errors);
  requireFile(distPath, "docs/search-index.json", errors);
  requireFile(distPath, "docs/pools/swap/index.html", errors);
  requireFile(distPath, "docs/contracts/mainnet-deployments/index.html", errors);
  if (!files.some((file) => /^index-.+\.js$/.test(path.basename(file)))) {
    errors.push("dist artifact must contain at least one hashed index JavaScript asset");
  }

  for (const file of files) {
    if (file.endsWith(".map")) {
      errors.push(`${display(file)}: public artifacts must not include source maps`);
    }
  }

  const searchableFiles = files.filter(isSearchableArtifactFile);
  const searchableArtifacts = searchableFiles.map((file) => ({
    file,
    relativePath: path.relative(distPath, file).split(path.sep).join("/"),
    text: fs.readFileSync(file, "utf8").toLowerCase()
  }));
  const haystack = searchableArtifacts.map((artifact) => artifact.text).join("\n");
  const auditedWalletVendorArtifacts = validateWalletVendorAudit(distPath, searchableArtifacts, errors);
  if (haystack.includes("sourcemappingurl")) {
    errors.push("dist artifact must not include sourceMappingURL comments");
  }
  const selectedStrings = [...new Set([
    String(config.chainId),
    manifest.endpoints.rpcUrl,
    manifest.endpoints.indexerUrl,
    manifest.contracts.lbFactory,
    manifest.contracts.lbPairImplementation,
    manifest.contracts.lbRouter,
    manifest.contracts.lbQuoter,
    ...Object.values(manifest.tokens ?? {}),
    ...Object.values(manifest.quoteAssets ?? {}),
    ...(Array.isArray(tokenList.tokens) ? tokenList.tokens.map((token) => token.address) : [])
  ].filter((value) => typeof value === "string" && value.length > 0))];

  for (const value of selectedStrings) {
    if (!haystack.includes(value.toLowerCase())) {
      errors.push(`dist artifact does not contain selected public config value: ${value}`);
    }
  }

  scanForForbiddenPublicValues(searchableArtifacts, errors, auditedWalletVendorArtifacts);
  scanForSecretCanaries(searchableArtifacts, process.env, errors);

  validateTokenAssets(distPath, tokenList, errors);
  validateDocsArtifact(distPath, files, errors);

  finish(errors, `Validated public ${options.environment} web artifact in ${display(distPath)}.`);
}

function validateDocsArtifact(distPath, files, errors) {
  const manifest = readJson(path.join(distPath, "docs/docs-manifest.json"), errors);
  const search = readJson(path.join(distPath, "docs/search-index.json"), errors);
  if (!Array.isArray(manifest) || manifest.length !== 49) errors.push("docs manifest must contain 49 public pages");
  if (!Array.isArray(search) || search.length !== 49) errors.push("docs search index must contain 49 public pages");

  const docsIndex = readText(path.join(distPath, "docs/index.html"), errors);
  if (docsIndex !== null) {
    for (const token of [
      "Welcome to Feather",
      'rel="canonical" href="https://feather.markets/docs"',
      'type="application/ld+json"'
    ]) {
      if (!docsIndex.includes(token)) errors.push(`docs/index.html is missing ${token}`);
    }
  }

  if (files.some((file) => /apps[\\/]web[\\/]docs[\\/]README\.md$/.test(file))) {
    errors.push("public artifact must not contain the private docs sync tracker");
  }
}

function validateTokenAssets(distPath, tokenList, errors) {
  if (!Array.isArray(tokenList.tokens)) {
    errors.push("token list is missing tokens");
    return;
  }

  for (const token of tokenList.tokens) {
    if (typeof token.logoURI !== "string" || !token.logoURI.startsWith("/")) {
      errors.push(`token ${token.symbol ?? token.id ?? "<unknown>"} has invalid logoURI`);
      continue;
    }

    requireFile(distPath, token.logoURI.replace(/^\/+/, ""), errors);
  }
}

function isSearchableArtifactFile(file) {
  return /\.(css|html|js|json|svg|txt|webmanifest)$/i.test(file);
}

function scanForForbiddenPublicValues(artifacts, errors, auditedWalletVendorArtifacts = new Set()) {
  for (const forbidden of forbiddenPublicBuildValues) {
    const normalized = forbidden.toLowerCase();
    for (const artifact of artifacts) {
      if (!artifact.text.includes(normalized)) continue;
      if (auditedWalletVendorArtifacts.has(artifact.relativePath) && walletVendorAllowedForbiddenValues.has(normalized)) {
        continue;
      }
      errors.push(`${artifact.relativePath}: contains forbidden public-build value: ${forbidden}`);
    }
  }

  for (const artifact of artifacts) {
    const allowedUrls = auditedWalletVendorArtifacts.has(artifact.relativePath)
      ? walletVendorAllowedLocalEndpointUrls
      : undefined;
    scanForLocalEndpointUrls(artifact.text, artifact.relativePath, errors, allowedUrls);
  }
}

function validateWalletVendorAudit(distPath, artifacts, errors) {
  const audited = new Set();
  const auditPath = path.join(distPath, walletVendorAuditFile);
  const audit = readJson(auditPath, errors);
  if (audit.schemaVersion !== walletVendorAuditSchema) {
    errors.push(`${display(auditPath)}: expected schemaVersion ${walletVendorAuditSchema}`);
    return audited;
  }
  if (!Array.isArray(audit.artifacts)) {
    errors.push(`${display(auditPath)}: artifacts must be an array`);
    return audited;
  }

  const artifactByPath = new Map(artifacts.map((artifact) => [artifact.relativePath, artifact]));
  for (const entry of audit.artifacts) {
    if (entry === null || typeof entry !== "object" || typeof entry.file !== "string" || typeof entry.sha256 !== "string") {
      errors.push(`${display(auditPath)}: each artifact requires file and sha256 strings`);
      continue;
    }
    const relativePath = entry.file.replaceAll("\\", "/");
    if (!isWalletVendorArtifact(relativePath)) {
      errors.push(`${display(auditPath)}: invalid wallet-vendor artifact path ${entry.file}`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      errors.push(`${display(auditPath)}: invalid sha256 for ${relativePath}`);
      continue;
    }
    if (audited.has(relativePath)) {
      errors.push(`${display(auditPath)}: duplicate artifact ${relativePath}`);
      continue;
    }

    const artifact = artifactByPath.get(relativePath);
    if (artifact === undefined) {
      errors.push(`${display(auditPath)}: audited artifact is missing: ${relativePath}`);
      continue;
    }
    const filePath = path.join(distPath, ...relativePath.split("/"));
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (sha256 !== entry.sha256) {
      errors.push(`${relativePath}: wallet-vendor audit digest mismatch`);
      continue;
    }
    audited.add(relativePath);
  }

  for (const artifact of artifacts) {
    if (isWalletVendorArtifact(artifact.relativePath) && !audited.has(artifact.relativePath)) {
      errors.push(`${artifact.relativePath}: wallet-vendor artifact is not present in the build audit inventory`);
    }
  }
  return audited;
}

function scanForSecretCanaries(artifacts, env, errors) {
  for (const envVar of secretCanaryEnvVars) {
    const value = env[envVar];
    if (typeof value !== "string" || value.length < 8) continue;
    const normalized = value.toLowerCase();
    for (const artifact of artifacts) {
      if (artifact.text.includes(normalized)) {
        errors.push(`${artifact.relativePath}: contains secret canary value from ${envVar}`);
      }
    }
  }
}

function isWalletVendorArtifact(relativePath) {
  return /^assets\/wallet-vendor-.+-[a-z0-9_-]{8}\.js$/i.test(relativePath.replaceAll("\\", "/"));
}

function scanForLocalEndpointUrls(text, label, errors, allowedUrls = undefined) {
  const matches = text.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`<>\\]+/g);
  for (const match of matches) {
    const raw = match[0].replace(/[),.;]+$/g, "");
    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }

    if (isLocalEndpointHost(url.hostname)) {
      if (allowedUrls?.has(raw.toLowerCase())) continue;
      errors.push(`${label} contains local endpoint URL: ${raw}`);
    }
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

function readJson(filePath, errors) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${display(filePath)}: ${error.message}`);
    return {};
  }
}

function readText(filePath, errors) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    errors.push(`${display(filePath)}: ${error.message}`);
    return null;
  }
}

function requireFile(root, relativePath, errors) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    errors.push(`${display(filePath)}: required artifact file is missing`);
  }
}

function forbidFile(root, relativePath, errors) {
  const filePath = path.join(root, relativePath);
  if (fs.existsSync(filePath)) {
    errors.push(`${display(filePath)}: Cloudflare control file must not be published`);
  }
}

function listFiles(root) {
  const entries = [];
  for (const name of fs.readdirSync(root)) {
    const filePath = path.join(root, name);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) entries.push(...listFiles(filePath));
    else if (stat.isFile()) entries.push(filePath);
  }
  return entries;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    options[toCamelCase(arg.slice(2))] = next;
    index += 1;
  }
  return options;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function display(filePath) {
  return path.relative(repoRoot, filePath);
}

function finish(errors, successMessage) {
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  if (successMessage) console.log(successMessage);
}

function printHelp() {
  console.log("Usage: node scripts/web/check-public-artifact.cjs --environment <sepolia|robinhoodTestnet|robinhood> --manifest <path> --dist <apps/web/dist> [--token-list <path>]");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  isWalletVendorArtifact,
  scanForForbiddenPublicValues,
  scanForLocalEndpointUrls,
  scanForSecretCanaries,
  validateWalletVendorAudit
};
