#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const sourceManifestPath = "deployments/examples/robinhood-testnet.example.json";
const sourceManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, sourceManifestPath), "utf8"));
const zeroAddress = "0x0000000000000000000000000000000000000000";
const productionOwner = "0x1111111111111111111111111111111111111111";
const feeRecipient = "0x2222222222222222222222222222222222222222";
const pendingOwner = "0x3333333333333333333333333333333333333333";
const wrongPairImplementation = "0x4444444444444444444444444444444444444444";
const extraQuoteAsset = "0x5555555555555555555555555555555555555555";
const defaultAdminRole = `0x${"0".repeat(64)}`;
const hooksManagerRole = "0xdcf4465aa60d92459eb361fac2489220ae3c524301cc0433c30a5d83e8fb0fa9";
const scrubbedEnv = makeScrubbedEnv();
const childTimeoutMs = 5_000;

const selectors = {
  owner: "0x8da5cb5b",
  pendingOwner: "0xe30c3978",
  feeRecipient: "0x4ccb20c0",
  pairImplementation: "0xaf371065",
  flashLoanFee: "0xfd90c2be",
  isQuoteAsset: "0x27721842",
  numberOfQuoteAssets: "0x80c5061e",
  quoteAssetAtIndex: "0x0752092b",
  hasRole: "0x91d14854"
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const latestManifestPath = writeLatestManifest({
    ownership: {
      ...sourceManifest.ownership,
      feeRecipient
    },
    constructorArgs: {
      ...sourceManifest.constructorArgs,
      feeRecipient
    }
  });
  const latestManifest = JSON.parse(fs.readFileSync(latestManifestPath, "utf8"));
  const expectedQuoteAssets = manifestQuoteAssets(latestManifest);

  await withRpc(baseState(latestManifest), async (rpcUrl) => {
    const report = await runReportAsync([
      latestManifestPath,
      "--rpc-url",
      rpcUrl,
      "--expected-owner",
      productionOwner,
      "--expected-fee-recipient",
      feeRecipient,
      "--strict-launch",
      "--json"
    ]);

    assert.equal(report.status, 0, JSON.stringify(report.json, null, 2));
    assert.equal(report.json.ok, true);
    assert.equal(report.json.launchBlockers.length, 0);
    assertCheck(report.json, "factory-owner", "pass");
    assertCheck(report.json, "factory-pending-owner", "pass");
    assertCheck(report.json, "factory-fee-recipient", "pass");
    assertCheck(report.json, "factory-pair-implementation", "pass");
    assertCheck(report.json, "factory-flash-loan-fee", "pass");
    assertCheck(report.json, "factory-quote-asset-set", "pass");
    assertCheck(report.json, "factory-default-admin-owner", "pass");
    assertCheck(report.json, "factory-default-admin-deployer", "pass");
    assertCheck(report.json, "factory-hooks-manager-owner", "pass");
    assertCheck(report.json, "factory-hooks-manager-deployer", "pass");
  });

  const offlineStrict = runReport([latestManifestPath, "--offline", "--strict-launch", "--json"]);
  assert.notEqual(offlineStrict.status, 0);
  assertBlocker(offlineStrict.json, "strict ownership handoff cannot use --offline");
  assertBlocker(offlineStrict.json, "strict ownership handoff requires --rpc-url");
  assertBlocker(offlineStrict.json, "strict ownership handoff requires --expected-owner");
  assertBlocker(offlineStrict.json, "strict ownership handoff requires --expected-fee-recipient");
  assertCheck(offlineStrict.json, "live-chain-state", "skipped");

  await withRpc(baseState(latestManifest), async (rpcUrl) => {
    const notLatest = await runReportAsync([
      sourceManifestPath,
      "--rpc-url",
      rpcUrl,
      "--expected-owner",
      productionOwner,
      "--expected-fee-recipient",
      feeRecipient,
      "--strict-launch",
      "--json"
    ]);

    assert.notEqual(notLatest.status, 0);
    assertBlocker(notLatest.json, "strict ownership handoff requires the promoted latest.json broadcast manifest");
  });

  await withRpc(baseState(latestManifest, { owner: latestManifest.deployer }), async (rpcUrl) => {
    const report = await runStrict(latestManifestPath, rpcUrl);
    assert.notEqual(report.status, 0);
    assertBlocker(report.json, "factory-owner");
    assertBlocker(report.json, "live LBFactory owner still matches deployer");
    assertCheck(report.json, "factory-default-admin-owner", "fail");
  });

  await withRpc(baseState(latestManifest, { pendingOwner }), async (rpcUrl) => {
    const report = await runStrict(latestManifestPath, rpcUrl);
    assert.notEqual(report.status, 0);
    assertBlocker(report.json, "factory-pending-owner");
    assertCheck(report.json, "factory-pending-owner", "fail");
  });

  await withRpc(baseState(latestManifest, { feeRecipient: latestManifest.deployer }), async (rpcUrl) => {
    const report = await runStrict(latestManifestPath, rpcUrl);
    assert.notEqual(report.status, 0);
    assertBlocker(report.json, "factory-fee-recipient");
    assertCheck(report.json, "factory-fee-recipient", "fail");
  });

  await withRpc(baseState(latestManifest, { pairImplementation: wrongPairImplementation }), async (rpcUrl) => {
    const report = await runStrict(latestManifestPath, rpcUrl);
    assert.notEqual(report.status, 0);
    assertBlocker(report.json, "factory-pair-implementation");
    assertCheck(report.json, "factory-pair-implementation", "fail");
  });

  await withRpc(baseState(latestManifest, { flashLoanFee: BigInt(latestManifest.constructorArgs.flashLoanFee) + 1n }), async (rpcUrl) => {
    const report = await runStrict(latestManifestPath, rpcUrl);
    assert.notEqual(report.status, 0);
    assertBlocker(report.json, "factory-flash-loan-fee");
    assertCheck(report.json, "factory-flash-loan-fee", "fail");
  });

  await withRpc(
    baseState(latestManifest, {
      quoteAssets: [extraQuoteAsset],
      quoteAssetMembership: {
        [lower(expectedQuoteAssets[0])]: false
      }
    }),
    async (rpcUrl) => {
      const report = await runStrict(latestManifestPath, rpcUrl);
      assert.notEqual(report.status, 0);
      assertBlocker(report.json, "factory-quote-asset-wrappedNative");
      assertBlocker(report.json, "factory quote asset set mismatch");
      assertCheck(report.json, "factory-quote-asset-set", "fail");
    }
  );

  await withRpc(
    baseState(latestManifest, {
      roleOverrides: {
        [roleKey(defaultAdminRole, productionOwner)]: false,
        [roleKey(defaultAdminRole, latestManifest.deployer)]: true,
        [roleKey(hooksManagerRole, productionOwner)]: true,
        [roleKey(hooksManagerRole, latestManifest.deployer)]: true
      }
    }),
    async (rpcUrl) => {
      const report = await runStrict(latestManifestPath, rpcUrl);
      assert.notEqual(report.status, 0);
      assertBlocker(report.json, "factory-default-admin-owner");
      assertBlocker(report.json, "factory-default-admin-deployer");
      assertBlocker(report.json, "factory-hooks-manager-owner");
      assertBlocker(report.json, "factory-hooks-manager-deployer");
    }
  );

  const badExpectedOwner = runReport([
    latestManifestPath,
    "--offline",
    "--expected-owner",
    zeroAddress,
    "--json"
  ]);
  assert.notEqual(badExpectedOwner.status, 0);
  assertBlocker(badExpectedOwner.json, "--expected-owner/ROBINHOOD_PRODUCTION_OWNER must be a non-zero EVM address");

  console.log("Robinhood ownership handoff helper tests passed.");
}

function runStrict(manifestPath, rpcUrl) {
  return runReportAsync([
    manifestPath,
    "--rpc-url",
    rpcUrl,
    "--expected-owner",
    productionOwner,
    "--expected-fee-recipient",
    feeRecipient,
    "--strict-launch",
    "--json"
  ]);
}

function runReportAsync(args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ["scripts/robinhood/check-ownership-handoff.cjs", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: scrubbedEnv
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ownership helper timed out after ${childTimeoutMs}ms: ${args.join(" ")}`));
    }, childTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      try {
        resolve({ json: JSON.parse(stdout), signal, status, stderr, stdout });
      } catch (error) {
        const details = `${stdout}\n${stderr}`.trim();
        reject(new Error(`ownership helper did not emit JSON: ${details || error.message}`));
      }
    });
  });
}

function runReport(args) {
  const result = childProcess.spawnSync(
    process.execPath,
    ["scripts/robinhood/check-ownership-handoff.cjs", ...args],
    { cwd: repoRoot, encoding: "utf8", env: scrubbedEnv, timeout: childTimeoutMs }
  );

  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch (error) {
    const details = `${result.stdout}\n${result.stderr}`.trim();
    throw new Error(`ownership helper did not emit JSON: ${details || error.message}`);
  }

  return { ...result, json };
}

async function withRpc(state, callback) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        const payload = JSON.parse(body);
        const result = handleRpc(state, payload.method, payload.params || []);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: payload.id, jsonrpc: "2.0", result }));
      } catch (error) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            error: { code: -32000, message: error.message }
          })
        );
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function handleRpc(state, method, params) {
  if (method === "eth_chainId") return toQuantity(state.chainId);

  if (method === "eth_call") {
    if (lower(params[0]?.to) !== lower(state.lbFactory)) {
      throw new Error(`unexpected eth_call target ${params[0]?.to}`);
    }
    if (params[1] !== "latest") {
      throw new Error(`unexpected eth_call block tag ${params[1]}`);
    }
    const data = String(params[0]?.data || "").toLowerCase();
    if (data === selectors.owner) return encodeAddress(state.owner);
    if (data === selectors.pendingOwner) return encodeAddress(state.pendingOwner);
    if (data === selectors.feeRecipient) return encodeAddress(state.feeRecipient);
    if (data === selectors.pairImplementation) return encodeAddress(state.pairImplementation);
    if (data === selectors.flashLoanFee) return encodeUint(state.flashLoanFee);
    if (data.startsWith(selectors.isQuoteAsset)) {
      const asset = decodeEncodedAddress(data.slice(selectors.isQuoteAsset.length));
      const configured = state.quoteAssetMembership[lower(asset)];
      const actual = configured === undefined ? state.quoteAssets.map(lower).includes(lower(asset)) : configured;
      return encodeBool(actual);
    }
    if (data === selectors.numberOfQuoteAssets) return encodeUint(BigInt(state.quoteAssets.length));
    if (data.startsWith(selectors.quoteAssetAtIndex)) {
      const index = Number(decodeEncodedUint(data.slice(selectors.quoteAssetAtIndex.length)));
      return encodeAddress(state.quoteAssets[index] || zeroAddress);
    }
    if (data.startsWith(selectors.hasRole)) {
      const role = `0x${data.slice(10, 74)}`;
      const account = decodeEncodedAddress(data.slice(74, 138));
      return encodeBool(hasRole(state, role, account));
    }
  }

  throw new Error(`unhandled RPC method ${method}`);
}

function baseState(manifest, overrides = {}) {
  return {
    chainId: manifest.chainId,
    feeRecipient,
    flashLoanFee: BigInt(manifest.constructorArgs.flashLoanFee),
    owner: productionOwner,
    lbFactory: manifest.contracts.lbFactory,
    pairImplementation: manifest.contracts.lbPairImplementation,
    pendingOwner: zeroAddress,
    quoteAssetMembership: {},
    quoteAssets: manifestQuoteAssets(manifest),
    roleOverrides: {},
    ...overrides
  };
}

function hasRole(state, role, account) {
  const key = roleKey(role, account);
  if (Object.prototype.hasOwnProperty.call(state.roleOverrides, key)) {
    return state.roleOverrides[key];
  }
  if (lower(role) === lower(defaultAdminRole)) {
    return lower(account) === lower(state.owner);
  }
  if (lower(role) === lower(hooksManagerRole)) {
    return false;
  }
  return false;
}

function writeLatestManifest(overrides) {
  const manifest = merge(sourceManifest, overrides);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-ownership-"));
  const latestPath = path.join(dir, "latest.json");
  fs.writeFileSync(latestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return latestPath;
}

function merge(base, overrides) {
  const next = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = { ...(next[key] || {}), ...value };
    } else {
      next[key] = value;
    }
  }
  return next;
}

function assertCheck(report, name, status) {
  assert(
    report.checks.some((check) => check.name === name && check.status === status),
    `${name} should have status ${status}`
  );
}

function assertBlocker(report, text) {
  assert(
    report.launchBlockers.some((blocker) => blocker.includes(text)),
    `expected launch blocker containing ${text}`
  );
}

function manifestQuoteAssets(manifest) {
  const seen = new Set();
  const assets = [];
  for (const value of Object.values(manifest.quoteAssets || {})) {
    if (!isAddress(value) || lower(value) === lower(zeroAddress) || seen.has(lower(value))) continue;
    seen.add(lower(value));
    assets.push(value);
  }
  return assets;
}

function encodeAddress(value) {
  return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}

function encodeBool(value) {
  return encodeUint(value ? 1n : 0n);
}

function encodeUint(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function decodeEncodedAddress(encoded) {
  if (!/^[0-9a-f]{64}$/i.test(encoded)) {
    throw new Error(`expected encoded address argument, got ${encoded}`);
  }
  return `0x${encoded.slice(-40)}`;
}

function decodeEncodedUint(encoded) {
  if (!/^[0-9a-f]{64}$/i.test(encoded)) {
    throw new Error(`expected encoded uint argument, got ${encoded}`);
  }
  return BigInt(`0x${encoded}`);
}

function roleKey(role, account) {
  return `${lower(role)}:${lower(account)}`;
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function toQuantity(value) {
  return `0x${Number(value).toString(16)}`;
}

function makeScrubbedEnv() {
  const env = { ...process.env };
  for (const name of [
    "ROBINHOOD_PRODUCTION_OWNER",
    "ROBINHOOD_FEE_RECIPIENT",
    "ROBINHOOD_OWNERSHIP_RPC_URL",
    "ROBINHOOD_RPC_URL",
    "ROBINHOOD_TESTNET_RPC_URL",
    "ROBINHOOD_MAINNET_RPC_URL"
  ]) {
    delete env[name];
  }
  return env;
}
