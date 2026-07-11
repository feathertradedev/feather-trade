#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const manifestValidator = path.join(repoRoot, "scripts/manifests/validate-manifests.cjs");
const zeroAddress = "0x0000000000000000000000000000000000000000";
const defaultTimeoutMs = 10_000;
const ownerSelector = "0x8da5cb5b";
const pendingOwnerSelector = "0xe30c3978";
const feeRecipientSelector = "0x4ccb20c0";
const pairImplementationSelector = "0xaf371065";
const flashLoanFeeSelector = "0xfd90c2be";
const isQuoteAssetSelector = "0x27721842";
const numberOfQuoteAssetsSelector = "0x80c5061e";
const quoteAssetAtIndexSelector = "0x0752092b";
const hasRoleSelector = "0x91d14854";
const defaultAdminRole = `0x${"0".repeat(64)}`;
const hooksManagerRole = "0xdcf4465aa60d92459eb361fac2489220ae3c524301cc0433c30a5d83e8fb0fa9";

main().catch((error) => {
  printResult({
    ok: false,
    manifest: null,
    checks: [
      {
        name: "ownership-handoff",
        status: "fail",
        message: error instanceof Error ? error.message : String(error)
      }
    ],
    warnings: [],
    launchBlockers: [error instanceof Error ? error.message : String(error)]
  });
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const checks = [];
  const warnings = [];
  const launchBlockers = [];
  const manifestPath = options.manifestPath ? path.resolve(repoRoot, options.manifestPath) : null;

  if (!manifestPath) {
    fail(checks, launchBlockers, "manifest", "missing Robinhood deployment manifest path");
    finish({ manifest: null, checks, warnings, launchBlockers });
    return;
  }

  const manifestDisplayPath = path.relative(repoRoot, manifestPath);
  const manifest = readManifest(manifestPath, manifestDisplayPath, checks, launchBlockers);
  if (!manifest) {
    finish({ manifest: null, checks, warnings, launchBlockers });
    return;
  }

  const expectedOwner = normalizeOptionalAddress(
    options.expectedOwner || process.env.ROBINHOOD_PRODUCTION_OWNER,
    "--expected-owner/ROBINHOOD_PRODUCTION_OWNER",
    launchBlockers
  );
  const expectedFeeRecipient = normalizeOptionalAddress(
    options.expectedFeeRecipient || process.env.ROBINHOOD_FEE_RECIPIENT,
    "--expected-fee-recipient/ROBINHOOD_FEE_RECIPIENT",
    launchBlockers
  );
  const rpcUrl = normalizeUrl(
    options.rpcUrl ||
      process.env.ROBINHOOD_OWNERSHIP_RPC_URL ||
      process.env[manifest.chain?.rpcEnvVar] ||
      null,
    "rpc",
    launchBlockers
  );

  checkManifestOwnership({
    checks,
    expectedFeeRecipient,
    expectedOwner,
    launchBlockers,
    manifest,
    manifestDisplayPath,
    options,
    warnings,
    liveOwnershipChecksEnabled: !options.offline && Boolean(rpcUrl)
  });

  if (options.strictLaunch) {
    if (options.offline) {
      launchBlockers.push("strict ownership handoff cannot use --offline; provide a live RPC endpoint");
    }
    if (!rpcUrl) {
      launchBlockers.push("strict ownership handoff requires --rpc-url, ROBINHOOD_OWNERSHIP_RPC_URL, or the manifest rpcEnvVar");
    }
    if (!expectedOwner) {
      launchBlockers.push("strict ownership handoff requires --expected-owner or ROBINHOOD_PRODUCTION_OWNER");
    }
    if (!expectedFeeRecipient) {
      launchBlockers.push("strict ownership handoff requires --expected-fee-recipient or ROBINHOOD_FEE_RECIPIENT");
    }
    if (path.basename(manifestDisplayPath) !== "latest.json") {
      launchBlockers.push("strict ownership handoff requires the promoted latest.json broadcast manifest");
    }
  }

  if (options.offline) {
    checks.push({
      name: "live-chain-state",
      status: "skipped",
      message: "offline mode skips RPC owner, pendingOwner, fee recipient, pair implementation, flash-loan fee, and quote-asset reads"
    });
    warnings.push("offline ownership handoff is suitable for no-secret CI, but it is not launch evidence for #52");
    finish({ manifest: summarizeManifest(manifest, manifestDisplayPath), checks, warnings, launchBlockers });
    return;
  }

  if (rpcUrl) {
    await checkLiveOwnership({ checks, expectedFeeRecipient, expectedOwner, launchBlockers, manifest, options, rpcUrl, warnings });
  } else {
    checks.push({
      name: "live-chain-state",
      status: "skipped",
      message: "no RPC URL supplied"
    });
    warnings.push("manifest-only ownership handoff is not launch evidence for #52");
  }

  finish({ manifest: summarizeManifest(manifest, manifestDisplayPath), checks, warnings, launchBlockers });
}

function printHelp() {
  console.log(
    JSON.stringify(
      {
        usage:
          "pnpm robinhood:ownership:check -- <manifest> [--rpc-url <url>] [--expected-owner <address>] [--expected-fee-recipient <address>] [--strict-launch] [--offline] [--timeout-ms <ms>] [--json]",
        env: ["ROBINHOOD_PRODUCTION_OWNER", "ROBINHOOD_FEE_RECIPIENT", "ROBINHOOD_OWNERSHIP_RPC_URL"]
      },
      null,
      2
    )
  );
}

function parseArgs(argv) {
  const options = {
    expectedFeeRecipient: null,
    expectedOwner: null,
    help: false,
    json: false,
    manifestPath: null,
    offline: false,
    rpcUrl: null,
    strictLaunch: false,
    timeoutMs: defaultTimeoutMs
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--offline") {
      options.offline = true;
      continue;
    }
    if (arg === "--strict-launch") {
      options.strictLaunch = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const { name, value, consumedNext } = readOption(argv, index);
    index += consumedNext ? 1 : 0;

    if (name === "--manifest") {
      options.manifestPath = value;
    } else if (name === "--rpc-url") {
      options.rpcUrl = value;
    } else if (name === "--expected-owner") {
      options.expectedOwner = value;
    } else if (name === "--expected-fee-recipient") {
      options.expectedFeeRecipient = value;
    } else if (name === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(value, name);
    } else {
      throw new Error(`unknown option: ${name}`);
    }
  }

  if (positional.length > 1) {
    throw new Error(`expected one manifest path, received ${positional.length}`);
  }
  if (positional.length === 1) {
    if (options.manifestPath) {
      throw new Error("provide the manifest path either positionally or with --manifest, not both");
    }
    options.manifestPath = positional[0];
  }

  return options;
}

function readOption(argv, index) {
  const arg = argv[index];
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex !== -1) {
    return {
      consumedNext: false,
      name: arg.slice(0, equalsIndex),
      value: arg.slice(equalsIndex + 1)
    };
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${arg}`);
  }

  return {
    consumedNext: true,
    name: arg,
    value
  };
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be an integer >= 1`);
  }
  return parsed;
}

function readManifest(manifestPath, displayPath, checks, launchBlockers) {
  if (!fs.existsSync(manifestPath)) {
    fail(checks, launchBlockers, "manifest", `${displayPath}: file does not exist`);
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(checks, launchBlockers, "manifest", `${displayPath}: invalid JSON: ${error.message}`);
    return null;
  }

  const validation = childProcess.spawnSync(process.execPath, [manifestValidator, manifestPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  const validationOutput = `${validation.stdout ?? ""}${validation.stderr ?? ""}`.trim();
  if (validation.status !== 0) {
    fail(checks, launchBlockers, "manifest", validationOutput || `${displayPath}: manifest validation failed`);
    return null;
  }

  if (manifest.schemaVersion !== "lb.robinhood.v1") {
    fail(checks, launchBlockers, "manifest", `${displayPath}.schemaVersion: expected lb.robinhood.v1`);
    return null;
  }

  checks.push({
    name: "manifest",
    status: "pass",
    path: displayPath,
    environment: manifest.environment,
    chainId: manifest.chainId
  });

  return manifest;
}

function checkManifestOwnership({
  checks,
  expectedFeeRecipient,
  expectedOwner,
  launchBlockers,
  liveOwnershipChecksEnabled,
  manifest,
  manifestDisplayPath,
  options,
  warnings
}) {
  const check = {
    name: "manifest-ownership",
    status: "pass",
    deployer: manifest.deployer,
    initialOwner: manifest.ownership?.initialOwner,
    lbFactoryOwner: manifest.ownership?.lbFactoryOwner,
    feeRecipient: manifest.ownership?.feeRecipient
  };

  if (lower(manifest.ownership?.initialOwner) !== lower(manifest.constructorArgs?.initialOwner)) {
    failCheck(check, launchBlockers, "ownership.initialOwner must match constructorArgs.initialOwner");
  }
  if (lower(manifest.ownership?.feeRecipient) !== lower(manifest.constructorArgs?.feeRecipient)) {
    failCheck(check, launchBlockers, "ownership.feeRecipient must match constructorArgs.feeRecipient");
  }

  if (expectedFeeRecipient && lower(manifest.ownership?.feeRecipient) !== lower(expectedFeeRecipient)) {
    warnings.push(
      `manifest ownership.feeRecipient is deployment-time ${manifest.ownership?.feeRecipient}; live chain state must match expected fee recipient ${expectedFeeRecipient}`
    );
  }

  if (!liveOwnershipChecksEnabled && lower(manifest.ownership?.lbFactoryOwner) === lower(manifest.deployer)) {
    warnings.push("ownership.lbFactoryOwner is deployment-time deployer; manifest-only output is not launch evidence for #52");
  }

  if (manifest.environment === "mainnet" && !expectedOwner) {
    warnings.push(`${manifestDisplayPath}: provide --expected-owner/ROBINHOOD_PRODUCTION_OWNER before mainnet sign-off`);
  }

  checks.push(check);
}

async function checkLiveOwnership({ checks, expectedFeeRecipient, expectedOwner, launchBlockers, manifest, options, rpcUrl, warnings }) {
  const rpcCheck = {
    name: "rpc",
    status: "pass",
    endpointHost: urlHost(rpcUrl)
  };

  try {
    const chainId = parseHexQuantity(await rpcCall(rpcUrl, "eth_chainId", [], options.timeoutMs), "eth_chainId");
    rpcCheck.chainId = chainId;
    if (chainId !== manifest.chainId) {
      failCheck(rpcCheck, launchBlockers, `RPC chain ID ${chainId} does not match manifest chain ID ${manifest.chainId}`);
    }
  } catch (error) {
    failCheck(rpcCheck, launchBlockers, `RPC chain check failed: ${error.message}`);
  }
  checks.push(rpcCheck);

  if (rpcCheck.status !== "pass") return;

  const owner = await readAddressCheck({
    checks,
    expected: expectedOwner || manifest.ownership?.lbFactoryOwner,
    label: "factory-owner",
    launchBlockers,
    rpcUrl,
    selector: ownerSelector,
    timeoutMs: options.timeoutMs,
    to: manifest.contracts?.lbFactory
  });

  const pendingOwner = await readAddressCheck({
    checks,
    expected: zeroAddress,
    label: "factory-pending-owner",
    launchBlockers,
    rpcUrl,
    selector: pendingOwnerSelector,
    timeoutMs: options.timeoutMs,
    to: manifest.contracts?.lbFactory
  });

  await readAddressCheck({
    checks,
    expected: expectedFeeRecipient || manifest.ownership?.feeRecipient,
    label: "factory-fee-recipient",
    launchBlockers,
    rpcUrl,
    selector: feeRecipientSelector,
    timeoutMs: options.timeoutMs,
    to: manifest.contracts?.lbFactory
  });

  await readAddressCheck({
    checks,
    expected: manifest.contracts?.lbPairImplementation,
    label: "factory-pair-implementation",
    launchBlockers,
    rpcUrl,
    selector: pairImplementationSelector,
    timeoutMs: options.timeoutMs,
    to: manifest.contracts?.lbFactory
  });

  await readUintCheck({
    checks,
    expected: manifest.constructorArgs?.flashLoanFee,
    label: "factory-flash-loan-fee",
    launchBlockers,
    rpcUrl,
    selector: flashLoanFeeSelector,
    timeoutMs: options.timeoutMs,
    to: manifest.contracts?.lbFactory
  });

  for (const [name, quoteAsset] of Object.entries(manifest.quoteAssets ?? {})) {
    if (!isAddress(quoteAsset) || lower(quoteAsset) === lower(zeroAddress)) continue;

    await readBoolCheck({
      args: [quoteAsset],
      checks,
      expected: true,
      label: `factory-quote-asset-${name}`,
      launchBlockers,
      rpcUrl,
      selector: isQuoteAssetSelector,
      timeoutMs: options.timeoutMs,
      to: manifest.contracts?.lbFactory
    });
  }
  if (options.strictLaunch) {
    await checkQuoteAssetSet({
      checks,
      expectedAssets: manifestQuoteAssets(manifest),
      launchBlockers,
      rpcUrl,
      timeoutMs: options.timeoutMs,
      to: manifest.contracts?.lbFactory
    });

    const ownerForRoleChecks = expectedOwner || owner;
    if (ownerForRoleChecks) {
      await readRoleCheck({
        account: ownerForRoleChecks,
        checks,
        expected: true,
        label: "factory-default-admin-owner",
        launchBlockers,
        role: defaultAdminRole,
        rpcUrl,
        timeoutMs: options.timeoutMs,
        to: manifest.contracts?.lbFactory
      });

      await readRoleCheck({
        account: ownerForRoleChecks,
        checks,
        expected: false,
        label: "factory-hooks-manager-owner",
        launchBlockers,
        role: hooksManagerRole,
        rpcUrl,
        timeoutMs: options.timeoutMs,
        to: manifest.contracts?.lbFactory
      });
    }

    if (isAddress(manifest.deployer) && (!ownerForRoleChecks || lower(manifest.deployer) !== lower(ownerForRoleChecks))) {
      await readRoleCheck({
        account: manifest.deployer,
        checks,
        expected: false,
        label: "factory-default-admin-deployer",
        launchBlockers,
        role: defaultAdminRole,
        rpcUrl,
        timeoutMs: options.timeoutMs,
        to: manifest.contracts?.lbFactory
      });

      await readRoleCheck({
        account: manifest.deployer,
        checks,
        expected: false,
        label: "factory-hooks-manager-deployer",
        launchBlockers,
        role: hooksManagerRole,
        rpcUrl,
        timeoutMs: options.timeoutMs,
        to: manifest.contracts?.lbFactory
      });
    }
  }

  if (owner && lower(owner) === lower(manifest.deployer)) {
    const message = "live LBFactory owner still matches deployer";
    if (options.strictLaunch) {
      launchBlockers.push(message);
    } else {
      warnings.push(message);
    }
  }
}

async function readRoleCheck({ account, checks, expected, label, launchBlockers, role, rpcUrl, timeoutMs, to }) {
  const check = {
    name: label,
    status: "pass",
    account,
    contract: to,
    expected,
    role
  };

  try {
    if (!isAddress(to)) {
      throw new Error(`${label}: missing contract address`);
    }
    if (!isAddress(account)) {
      throw new Error(`${label}: missing account address`);
    }
    if (!isBytes32(role)) {
      throw new Error(`${label}: invalid role`);
    }
    const data = `${hasRoleSelector}${encodeAbiBytes32(role)}${encodeAbiAddress(account)}`;
    const output = await rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"], timeoutMs);
    const actual = decodeAbiBool(output);
    check.actual = actual;
    if (actual !== expected) {
      failCheck(check, launchBlockers, `${label} ${actual} does not match expected ${expected}`);
    }
    checks.push(check);
    return actual;
  } catch (error) {
    failCheck(check, launchBlockers, `${label} check failed: ${error.message}`);
    checks.push(check);
    return null;
  }
}

async function readAddressCheck({ checks, expected, label, launchBlockers, rpcUrl, selector, timeoutMs, to }) {
  const check = {
    name: label,
    status: "pass",
    contract: to,
    expected
  };

  try {
    if (!isAddress(to)) {
      throw new Error(`${label}: missing contract address`);
    }
    const output = await rpcCall(rpcUrl, "eth_call", [{ to, data: selector }, "latest"], timeoutMs);
    const actual = decodeAbiAddress(output);
    check.actual = actual;
    if (isAddress(expected) && lower(actual) !== lower(expected)) {
      failCheck(check, launchBlockers, `${label} ${actual} does not match expected ${expected}`);
    }
    checks.push(check);
    return actual;
  } catch (error) {
    failCheck(check, launchBlockers, `${label} check failed: ${error.message}`);
    checks.push(check);
    return null;
  }
}

async function readUintCheck({ checks, expected, label, launchBlockers, rpcUrl, selector, timeoutMs, to }) {
  const check = {
    name: label,
    status: "pass",
    contract: to,
    expected
  };

  try {
    if (!isAddress(to)) {
      throw new Error(`${label}: missing contract address`);
    }
    const output = await rpcCall(rpcUrl, "eth_call", [{ to, data: selector }, "latest"], timeoutMs);
    const actual = decodeAbiUint(output);
    check.actual = actual.toString();
    if (expected !== undefined && BigInt(expected) !== actual) {
      failCheck(check, launchBlockers, `${label} ${actual.toString()} does not match expected ${expected}`);
    }
    checks.push(check);
    return actual;
  } catch (error) {
    failCheck(check, launchBlockers, `${label} check failed: ${error.message}`);
    checks.push(check);
    return null;
  }
}

async function readBoolCheck({ args = [], checks, expected, label, launchBlockers, rpcUrl, selector, timeoutMs, to }) {
  const check = {
    name: label,
    status: "pass",
    contract: to,
    expected
  };

  try {
    if (!isAddress(to)) {
      throw new Error(`${label}: missing contract address`);
    }
    const data = `${selector}${args.map(encodeAbiAddress).join("")}`;
    const output = await rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"], timeoutMs);
    const actual = decodeAbiBool(output);
    check.actual = actual;
    if (actual !== expected) {
      failCheck(check, launchBlockers, `${label} ${actual} does not match expected ${expected}`);
    }
    checks.push(check);
    return actual;
  } catch (error) {
    failCheck(check, launchBlockers, `${label} check failed: ${error.message}`);
    checks.push(check);
    return null;
  }
}

async function checkQuoteAssetSet({ checks, expectedAssets, launchBlockers, rpcUrl, timeoutMs, to }) {
  const check = {
    name: "factory-quote-asset-set",
    status: "pass",
    contract: to,
    expected: expectedAssets
  };

  try {
    if (!isAddress(to)) {
      throw new Error("factory-quote-asset-set: missing contract address");
    }
    const countOutput = await rpcCall(rpcUrl, "eth_call", [{ to, data: numberOfQuoteAssetsSelector }, "latest"], timeoutMs);
    const count = decodeAbiUint(countOutput);
    if (count > 1_000n) {
      throw new Error(`quote asset count ${count.toString()} is unexpectedly large`);
    }

    const actualAssets = [];
    for (let index = 0n; index < count; index += 1n) {
      const data = `${quoteAssetAtIndexSelector}${encodeAbiUint(index)}`;
      const output = await rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"], timeoutMs);
      actualAssets.push(decodeAbiAddress(output));
    }

    check.actual = actualAssets;
    const expectedSet = new Set(expectedAssets.map(lower));
    const actualSet = new Set(actualAssets.map(lower));
    const missing = [...expectedSet].filter((asset) => !actualSet.has(asset));
    const extra = [...actualSet].filter((asset) => !expectedSet.has(asset));
    if (missing.length > 0 || extra.length > 0) {
      failCheck(
        check,
        launchBlockers,
        `factory quote asset set mismatch: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`
      );
    }
    checks.push(check);
  } catch (error) {
    failCheck(check, launchBlockers, `factory quote asset set check failed: ${error.message}`);
    checks.push(check);
  }
}

async function rpcCall(rpcUrl, method, params, timeoutMs) {
  const response = await fetchJson(
    rpcUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method,
        params
      })
    },
    timeoutMs
  );

  if (response.error) {
    const code = response.error.code === undefined ? "" : `${response.error.code} `;
    throw new Error(`${method}: ${code}${response.error.message ?? "JSON-RPC error"}`);
  }
  return response.result;
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOptionalAddress(value, label, launchBlockers) {
  if (!value) return null;
  if (!isAddress(value) || lower(value) === lower(zeroAddress)) {
    launchBlockers.push(`${label} must be a non-zero EVM address`);
    return null;
  }
  return checksumless(value);
}

function normalizeUrl(value, label, launchBlockers) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      launchBlockers.push(`${label} URL must use http or https`);
      return null;
    }
    return value;
  } catch {
    launchBlockers.push(`${label} URL is not a valid URL`);
    return null;
  }
}

function parseHexQuantity(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label}: expected hex quantity`);
  }
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label}: value is not a safe non-negative integer`);
  }
  return parsed;
}

function decodeAbiAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`expected ABI-encoded address, got ${typeof value === "string" ? value : typeof value}`);
  }
  return `0x${value.slice(-40)}`;
}

function encodeAbiAddress(value) {
  if (!isAddress(value)) {
    throw new Error(`expected address argument, got ${typeof value === "string" ? value : typeof value}`);
  }
  return value.slice(2).padStart(64, "0").toLowerCase();
}

function encodeAbiUint(value) {
  const encoded = BigInt(value).toString(16);
  return encoded.padStart(64, "0");
}

function encodeAbiBytes32(value) {
  if (!isBytes32(value)) {
    throw new Error(`expected bytes32 argument, got ${typeof value === "string" ? value : typeof value}`);
  }
  return value.slice(2).toLowerCase();
}

function decodeAbiUint(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`expected ABI-encoded uint256, got ${typeof value === "string" ? value : typeof value}`);
  }
  return BigInt(value);
}

function decodeAbiBool(value) {
  const decoded = decodeAbiUint(value);
  if (decoded === 0n) return false;
  if (decoded === 1n) return true;
  throw new Error(`expected ABI-encoded bool, got ${decoded.toString()}`);
}

function manifestQuoteAssets(manifest) {
  const assets = [];
  const seen = new Set();
  for (const quoteAsset of Object.values(manifest.quoteAssets ?? {})) {
    if (!isAddress(quoteAsset) || lower(quoteAsset) === lower(zeroAddress)) continue;
    const key = lower(quoteAsset);
    if (seen.has(key)) continue;
    seen.add(key);
    assets.push(quoteAsset);
  }
  return assets;
}

function summarizeManifest(manifest, displayPath) {
  return {
    path: displayPath,
    environment: manifest.environment,
    chainId: manifest.chainId,
    deployer: manifest.deployer,
    lbFactory: manifest.contracts?.lbFactory,
    lbFactoryOwner: manifest.ownership?.lbFactoryOwner,
    feeRecipient: manifest.ownership?.feeRecipient
  };
}

function fail(checks, launchBlockers, name, message) {
  checks.push({ name, status: "fail", message });
  launchBlockers.push(message);
}

function failCheck(check, launchBlockers, message) {
  check.status = "fail";
  if (!check.messages) check.messages = [];
  check.messages.push(message);
  launchBlockers.push(message);
}

function finish({ manifest, checks, warnings, launchBlockers }) {
  printResult({
    ok: launchBlockers.length === 0,
    manifest,
    checks,
    warnings,
    launchBlockers
  });
  process.exitCode = launchBlockers.length === 0 ? 0 : 1;
}

function printResult(result) {
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`# Robinhood Ownership Handoff Check\n`);
  console.log(`Status: ${result.ok ? "pass" : "fail"}\n`);
  if (result.manifest) {
    console.log(`Manifest: ${result.manifest.path}`);
    console.log(`Environment: ${result.manifest.environment}`);
    console.log(`LBFactory: ${result.manifest.lbFactory}\n`);
  }
  for (const check of result.checks) {
    const message = check.message || (check.messages ? check.messages.join("; ") : "");
    console.log(`- ${check.status}: ${check.name}${message ? ` - ${message}` : ""}`);
  }
  for (const warning of result.warnings) {
    console.log(`- warn: ${warning}`);
  }
  for (const blocker of result.launchBlockers) {
    console.log(`- blocker: ${blocker}`);
  }
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isBytes32(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function checksumless(value) {
  return `0x${value.slice(2)}`;
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function urlHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
