#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FILES = [
  ["pricePolicies", "config", "price-policies.json", "/run/feather/config/price-policies.json"],
  ["priceVerifierModule", "adapters", "chainlink-verifier.mjs", "/run/feather/adapters/chainlink-verifier.mjs"],
  ["blockSourceModule", "adapters", "canonical-block-source.mjs", "/run/feather/adapters/canonical-block-source.mjs"],
  ["positionSnapshotModule", "adapters", "position-snapshot-provider.mjs", "/run/feather/adapters/position-snapshot-provider.mjs"]
];

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = buildCustodyInventory(options);
  installCanonicalInventory(options.output, result.serialized);
  process.stdout.write(`ANALYTICS_RUNTIME_CUSTODY=/run/feather/config/runtime-custody.json\n`);
  process.stdout.write(`ANALYTICS_RUNTIME_CUSTODY_SHA256=${result.sha256}\n`);
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) usage();
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    values.set(flag, value);
  }
  for (const flag of values.keys()) {
    if (!["--environment", "--deployment-identity", "--config-dir", "--adapters-dir", "--output"].includes(flag)) {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  const environment = required(values, "--environment");
  if (environment !== "testnet" && environment !== "mainnet") {
    throw new Error("--environment must be testnet or mainnet");
  }
  const deploymentIdentity = required(values, "--deployment-identity");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(deploymentIdentity)) {
    throw new Error("--deployment-identity is invalid");
  }
  const configDir = absoluteDirectory(required(values, "--config-dir"), "--config-dir");
  const adaptersDir = absoluteDirectory(required(values, "--adapters-dir"), "--adapters-dir");
  const requestedOutput = values.get("--output") ?? path.join(configDir, "runtime-custody.json");
  if (!path.isAbsolute(requestedOutput)) throw new Error("--output must be an absolute path");
  const output = path.resolve(requestedOutput);
  return { environment, deploymentIdentity, configDir, adaptersDir, output };
}

function buildCustodyInventory(options) {
  const entries = {};
  for (const [role, directory, fileName, runtimePath] of FILES) {
    const sourcePath = path.join(directory === "config" ? options.configDir : options.adaptersDir, fileName);
    entries[role] = { path: runtimePath, sha256: sha256(readStableRegularFile(sourcePath, role)) };
  }
  const inventory = {
    version: 1,
    deploymentIdentity: options.deploymentIdentity,
    environment: options.environment,
    files: entries
  };
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  return { inventory, serialized, sha256: sha256(Buffer.from(serialized)) };
}

function readStableRegularFile(filePath, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be an existing non-symlink file: ${filePath}`, { cause: error });
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular file: ${filePath}`);
    const contents = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      contents.byteLength !== after.size
    ) {
      throw new Error(`${label} changed while its custody hash was computed`);
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function installCanonicalInventory(output, serialized) {
  if (fs.existsSync(output)) {
    const existing = fs.lstatSync(output);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("--output must be absent or an existing regular non-symlink file");
    }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o750 });
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    fs.chmodSync(temporary, 0o444);
    fs.renameSync(temporary, output);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function absoluteDirectory(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`);
  return path.resolve(value);
}

function required(values, flag) {
  const value = values.get(flag)?.trim();
  if (!value) usage();
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function usage() {
  throw new Error(
    "Usage: build-analytics-runtime-custody.cjs --environment <testnet|mainnet> " +
    "--deployment-identity <immutable-id> --config-dir <absolute-path> " +
    "--adapters-dir <absolute-path> [--output <absolute-path>]"
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Analytics custody build failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildCustodyInventory, parseArguments };
