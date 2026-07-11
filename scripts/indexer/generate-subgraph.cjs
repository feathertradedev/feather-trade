#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const DEFAULT_TEMPLATE_PATH = path.resolve(root, "indexer/subgraph/subgraph.template.yaml");
const DEFAULT_OUTPUT_PATH = path.resolve(root, "indexer/subgraph/subgraph.yaml");

function fail(message) {
  console.error(`generate-subgraph: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith("--")) {
      fail(`unexpected argument ${arg}`);
    }

    const key = arg.slice(2);
    const value = argv[i + 1];

    if (!value || value.startsWith("--")) {
      fail(`missing value for --${key}`);
    }

    args[key] = value;
    i += 1;
  }

  return args;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`could not read ${label} at ${filePath}: ${error.message}`);
  }
}

function networkFromManifest(manifest) {
  if (manifest.environment === "testnet") return "robinhood-testnet";
  if (manifest.environment === "mainnet") return "robinhood-mainnet";
  if (manifest.environment === "localnet") return "localnet";
  return manifest.environment;
}

function requireAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    fail(`manifest does not contain a valid ${label} address`);
  }
  return value;
}

const args = parseArgs(process.argv.slice(2));
const manifestValue = args.manifest || process.env.INDEXER_MANIFEST_PATH || process.env.ROBINHOOD_MANIFEST_PATH;

if (!manifestValue) {
  fail("set --manifest <deployment-manifest.json> or INDEXER_MANIFEST_PATH");
}

const manifestPath = path.resolve(root, manifestValue);
const templatePath = path.resolve(root, args.template || process.env.INDEXER_TEMPLATE_PATH || DEFAULT_TEMPLATE_PATH);
const outputPath = path.resolve(root, args.output || process.env.INDEXER_SUBGRAPH_OUTPUT || DEFAULT_OUTPUT_PATH);
const manifest = readJson(manifestPath, "deployment manifest");
const network = args.network || process.env.INDEXER_NETWORK || networkFromManifest(manifest);
const lbFactory = requireAddress(manifest.contracts && manifest.contracts.lbFactory, "contracts.lbFactory");
const startBlock = Number(manifest.startBlock);

if (!/^[A-Za-z0-9_-]+$/.test(network)) {
  fail("network must contain only letters, numbers, underscores, or hyphens");
}

if (!Number.isInteger(startBlock) || startBlock < 0) {
  fail(`manifest does not contain a valid non-negative startBlock: ${manifestPath}`);
}

const template = fs.readFileSync(templatePath, "utf8");
const rendered = template
  .replaceAll("{{network}}", network)
  .replaceAll("{{lbFactory}}", lbFactory)
  .replaceAll("{{startBlock}}", String(startBlock));

if (/\{\{[^}]+\}\}/.test(rendered)) {
  fail("template contains unresolved placeholders");
}

let existing = null;
try {
  existing = fs.readFileSync(outputPath, "utf8");
} catch (_) {
  existing = null;
}

if (existing === rendered) {
  console.log(`${path.relative(root, outputPath)} is up to date`);
} else {
  fs.writeFileSync(outputPath, rendered);
  console.log(
    `Generated ${path.relative(root, outputPath)} from ${path.relative(root, manifestPath)} with network ${network}`
  );
}
