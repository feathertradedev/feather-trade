#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const manifestPath = path.resolve(
  root,
  process.env.LOCALNET_MANIFEST_PATH || process.env.INDEXER_LOCAL_MANIFEST || "deployments/localnet/latest.json"
);
const templatePath = path.resolve(root, "indexer/subgraph/subgraph.template.yaml");
const outputPath = path.resolve(root, "indexer/subgraph/subgraph.yaml");
const DEFAULT_LOCALNET_FACTORY = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
const DEFAULT_LOCALNET_START_BLOCK = 0;

function fail(message) {
  console.error(`generate-subgraph-local: ${message}`);
  process.exit(1);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`could not read ${label} at ${filePath}: ${error.message}`);
  }
}

const hasManifest = fs.existsSync(manifestPath);
const manifest = hasManifest ? readJson(manifestPath, "local deployment manifest") : null;
const network = process.env.INDEXER_LOCAL_NETWORK || (manifest && manifest.environment) || "localnet";
const lbFactory = manifest && manifest.contracts ? manifest.contracts.lbFactory : DEFAULT_LOCALNET_FACTORY;
const startBlock = manifest ? Number(manifest.startBlock) : DEFAULT_LOCALNET_START_BLOCK;

if (!/^[A-Za-z0-9_-]+$/.test(network)) {
  fail("network must contain only letters, numbers, underscores, or hyphens");
}

if (!lbFactory || !/^0x[0-9a-fA-F]{40}$/.test(lbFactory)) {
  fail(`manifest does not contain a valid contracts.lbFactory address: ${manifestPath}`);
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
  if (hasManifest) {
    console.log(`Generated ${path.relative(root, outputPath)} from ${path.relative(root, manifestPath)}`);
  } else {
    console.log(
      `Generated ${path.relative(root, outputPath)} with deterministic default localnet factory. Run pnpm localnet:up to render from ${path.relative(root, manifestPath)}.`
    );
  }
}
