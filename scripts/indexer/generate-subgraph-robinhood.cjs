#!/usr/bin/env node

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const configuredEnvironment = process.env.ROBINHOOD_ENV || null;
const environment = configuredEnvironment || "testnet";
const defaultManifest = `deployments/robinhood/${environment}/latest.json`;
const args = process.argv.slice(2);
const manifestArg = readOption(args, "--manifest");
const manifestPath = manifestArg || process.env.ROBINHOOD_MANIFEST_PATH || process.env.INDEXER_ROBINHOOD_MANIFEST || defaultManifest;

function fail(message) {
  console.error(`generate-subgraph-robinhood: ${message}`);
  process.exit(1);
}

function readOption(argv, option) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === option) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`missing value for ${option}`);
      return value;
    }
    if (arg.startsWith(`${option}=`)) {
      return arg.slice(option.length + 1);
    }
  }
  return null;
}

function withoutOption(argv, option) {
  const result = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === option) {
      index += 1;
      continue;
    }
    if (arg.startsWith(`${option}=`)) {
      continue;
    }
    result.push(arg);
  }

  return result;
}

function readManifest(file) {
  const absolute = path.resolve(root, file);
  try {
    return JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    fail(`could not read Robinhood manifest at ${file}: ${error.message}`);
  }
}

const manifest = readManifest(manifestPath);
if (manifest.schemaVersion !== "lb.robinhood.v1") {
  fail(`expected lb.robinhood.v1 manifest, got ${JSON.stringify(manifest.schemaVersion)}`);
}

if (manifest.environment !== "testnet" && manifest.environment !== "mainnet") {
  fail(`expected Robinhood testnet/mainnet manifest, got ${JSON.stringify(manifest.environment)}`);
}

if (configuredEnvironment !== null && manifest.environment !== configuredEnvironment) {
  fail(
    `ROBINHOOD_ENV=${configuredEnvironment} does not match manifest environment ${JSON.stringify(manifest.environment)}`
  );
}

const expectedChainId = manifest.environment === "mainnet" ? 4663 : 46630;
if (manifest.chainId !== expectedChainId) {
  fail(`manifest environment ${manifest.environment} requires chainId ${expectedChainId}, got ${JSON.stringify(manifest.chainId)}`);
}

const forwardedArgs = ["--manifest", manifestPath, ...withoutOption(args, "--manifest")];

const forwarded = [
  path.resolve(root, "scripts/indexer/generate-subgraph.cjs"),
  ...forwardedArgs
];

const result = childProcess.spawnSync(process.execPath, forwarded, {
  cwd: root,
  stdio: "inherit"
});

process.exit(result.status == null ? 1 : result.status);
