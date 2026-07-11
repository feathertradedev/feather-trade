#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const baseManifestPath = path.join(repoRoot, "deployments/examples/robinhood-mainnet.example.json");
const testnetManifestPath = path.join(repoRoot, "deployments/examples/robinhood-testnet.example.json");
const baseManifest = JSON.parse(fs.readFileSync(baseManifestPath, "utf8"));
const testnetManifest = JSON.parse(fs.readFileSync(testnetManifestPath, "utf8"));
const providerRpcUrl = "https://verifymainnetuser:verify%3Amainnet%2Dpassword@provider.rpc.example/verifymainnetpathcredential/robinhood-mainnet?api-key=verify-mainnet-secret-canary";
const testnetProviderRpcUrl = "https://verifytestnetuser:verify%3Atestnet%2Dpassword@provider.rpc.example/verifytestnetpathcredential/robinhood-testnet?api-key=verify-testnet-secret-canary";
const fakeVerifierUrl = "https://verifier.example/api/";
const childTimeoutMs = 10_000;
const rpcSecretCanaries = [
  "verify-mainnet-secret-canary",
  "verify-testnet-secret-canary",
  "verifymainnetuser",
  "verifytestnetuser",
  "verify%3Amainnet%2Dpassword",
  "verify%3Atestnet%2Dpassword",
  "verify:mainnet-password",
  "verify:testnet-password",
  "verifymainnetpathcredential",
  "verifytestnetpathcredential"
];

main();

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-verify-"));
  const binDir = path.join(tempDir, "bin");
  const forgeLogPath = path.join(tempDir, "forge-calls.jsonl");
  fs.mkdirSync(binDir);
  writeFakeTools(binDir);

  const mainnetManifestPath = writeManifest(tempDir, "mainnet.json", {
    ...baseManifest,
    chain: { ...baseManifest.chain, verifierUrl: fakeVerifierUrl }
  });
  const mainnet = runVerify({ binDir, forgeLogPath, manifestPath: mainnetManifestPath });
  assert.equal(mainnet.status, 0, mainnet.stderr || mainnet.stdout);
  assertNoSecretOutput(mainnet);
  assertCoreVerifyCalls(readForgeCalls(forgeLogPath), JSON.parse(fs.readFileSync(mainnetManifestPath, "utf8")), {
    watch: true
  });

  fs.writeFileSync(forgeLogPath, "");
  const testnetManifestPath = writeManifest(tempDir, "testnet.json", {
    ...testnetManifest,
    chain: { ...testnetManifest.chain, verifierUrl: fakeVerifierUrl }
  });
  const testnet = runVerify({
    binDir,
    forgeLogPath,
    manifestPath: testnetManifestPath,
    robinhoodEnv: "testnet"
  });
  assert.equal(testnet.status, 0, testnet.stderr || testnet.stdout);
  assertNoSecretOutput(testnet);
  assertCoreVerifyCalls(readForgeCalls(forgeLogPath), JSON.parse(fs.readFileSync(testnetManifestPath, "utf8")), {
    rpcUrl: testnetProviderRpcUrl,
    watch: true
  });

  fs.writeFileSync(forgeLogPath, "");
  const noWatch = runVerify({ binDir, forgeLogPath, manifestPath: mainnetManifestPath, watch: false });
  assert.notEqual(noWatch.status, 0);
  assert.match(noWatch.stderr, /must be 1.*terminal Blockscout confirmation/i);
  assertNoSecretOutput(noWatch);
  assert.equal(readForgeCalls(forgeLogPath).length, 0);

  fs.writeFileSync(forgeLogPath, "");
  const mismatch = runVerify({
    binDir,
    forgeLogPath,
    manifestPath: mainnetManifestPath,
    extraEnv: { FAKE_CAST_CHAIN_ID: "1" }
  });
  assert.notEqual(mismatch.status, 0);
  assert(mismatch.stderr.includes("RPC chain-id mismatch"));
  assertNoSecretOutput(mismatch);
  assert.equal(readForgeCalls(forgeLogPath).length, 0);

  fs.writeFileSync(forgeLogPath, "");
  const missingRpc = runVerify({
    binDir,
    forgeLogPath,
    manifestPath: mainnetManifestPath,
    extraEnv: { ROBINHOOD_RPC_URL: "" }
  });
  assert.notEqual(missingRpc.status, 0);
  assert.match(missingRpc.stderr, /Set ROBINHOOD_RPC_URL to an explicit provider RPC/i);
  assertNoSecretOutput(missingRpc);
  assert.equal(readForgeCalls(forgeLogPath).length, 0);

  fs.writeFileSync(forgeLogPath, "");
  const publicMainnetRpc = runVerify({
    binDir,
    forgeLogPath,
    manifestPath: mainnetManifestPath,
    extraEnv: { ROBINHOOD_RPC_URL: "HTTPS://RPC.MAINNET.CHAIN.ROBINHOOD.COM:443/?ignored=1#fragment" }
  });
  assert.notEqual(publicMainnetRpc.status, 0);
  assert.match(publicMainnetRpc.stderr, /canonical public Robinhood RPC is prohibited/i);
  assert.equal(readForgeCalls(forgeLogPath).length, 0, "public mainnet RPC must fail before Forge");

  fs.writeFileSync(forgeLogPath, "");
  const publicTestnetRpc = runVerify({
    binDir,
    forgeLogPath,
    manifestPath: testnetManifestPath,
    robinhoodEnv: "testnet",
    extraEnv: { ROBINHOOD_TESTNET_RPC_URL: "HTTPS://RPC.TESTNET.CHAIN.ROBINHOOD.COM:443/#ignored" }
  });
  assert.notEqual(publicTestnetRpc.status, 0);
  assert.match(publicTestnetRpc.stderr, /canonical public Robinhood RPC is prohibited/i);
  assert.equal(readForgeCalls(forgeLogPath).length, 0, "public testnet RPC must fail before Forge");

  fs.writeFileSync(forgeLogPath, "");
  const terminalFailure = runVerify({
    binDir,
    forgeLogPath,
    manifestPath: mainnetManifestPath,
    extraEnv: { FAKE_FORGE_ECHO_SECRETS: "1", FAKE_FORGE_EXIT: "42" }
  });
  assert.equal(terminalFailure.status, 42);
  assertNoSecretOutput(terminalFailure);
  assert.match(`${terminalFailure.stdout}\n${terminalFailure.stderr}`, /forge diagnostic: provider request failed/i);
  assert.match(`${terminalFailure.stdout}\n${terminalFailure.stderr}`, /\[REDACTED_RPC_URL\]/);
  assert.match(`${terminalFailure.stdout}\n${terminalFailure.stderr}`, /\[REDACTED_RPC_CREDENTIAL\]/);
  const terminalFailureCalls = readForgeCalls(forgeLogPath);
  assert.equal(terminalFailureCalls.length, 1);
  assert.equal(terminalFailureCalls[0].args.includes("--watch"), true);
  assertLogHasNoSecrets(forgeLogPath);

  fs.writeFileSync(forgeLogPath, "");
  const envMismatch = runVerify({
    binDir,
    forgeLogPath,
    manifestPath: mainnetManifestPath,
    robinhoodEnv: "testnet"
  });
  assert.notEqual(envMismatch.status, 0);
  assert(envMismatch.stderr.includes("Manifest chain-id mismatch"));
  assertNoSecretOutput(envMismatch);
  assert.equal(readForgeCalls(forgeLogPath).length, 0);

  console.log("Robinhood verification constructor-arg tests passed.");
}

function assertCoreVerifyCalls(calls, manifest, options = {}) {
  const rpcUrl = options.rpcUrl || providerRpcUrl;
  assert.equal(calls.length, 4);
  assertVerifyCall(calls[0], {
    address: manifest.contracts.lbFactory,
    chainId: manifest.chainId,
    constructorArgs: expectedConstructorArgs([
      "constructor(address,address,uint256)",
      manifest.constructorArgs.feeRecipient,
      manifest.constructorArgs.initialOwner,
      String(manifest.constructorArgs.flashLoanFee)
    ]),
    contractId: "contracts/joe-v2/src/LBFactory.sol:LBFactory",
    rpcUrl,
    verifierUrl: fakeVerifierUrl,
    watch: options.watch
  });
  assertVerifyCall(calls[1], {
    address: manifest.contracts.lbPairImplementation,
    chainId: manifest.chainId,
    constructorArgs: expectedConstructorArgs(["constructor(address)", manifest.contracts.lbFactory]),
    contractId: "contracts/joe-v2/src/LBPair.sol:LBPair",
    rpcUrl,
    verifierUrl: fakeVerifierUrl,
    watch: options.watch
  });
  assertVerifyCall(calls[2], {
    address: manifest.contracts.lbRouter,
    chainId: manifest.chainId,
    constructorArgs: expectedConstructorArgs([
      "constructor(address,address,address,address,address,address)",
      manifest.contracts.lbFactory,
      manifest.constructorArgs.routerFactoryV1,
      manifest.constructorArgs.routerLegacyFactoryV2,
      manifest.constructorArgs.routerLegacyRouterV2,
      manifest.constructorArgs.routerFactoryV2_1,
      manifest.constructorArgs.routerWNative
    ]),
    contractId: "contracts/joe-v2/src/LBRouter.sol:LBRouter",
    rpcUrl,
    verifierUrl: fakeVerifierUrl,
    watch: options.watch
  });
  assertVerifyCall(calls[3], {
    address: manifest.contracts.lbQuoter,
    chainId: manifest.chainId,
    constructorArgs: expectedConstructorArgs([
      "constructor(address,address,address,address,address,address,address)",
      manifest.constructorArgs.quoterFactoryV1,
      manifest.constructorArgs.quoterLegacyFactoryV2,
      manifest.constructorArgs.quoterFactoryV2_1,
      manifest.constructorArgs.quoterFactoryV2_2,
      manifest.constructorArgs.quoterLegacyRouterV2,
      manifest.constructorArgs.quoterRouterV2_1,
      manifest.constructorArgs.quoterRouterV2_2
    ]),
    contractId: "contracts/joe-v2/src/LBQuoter.sol:LBQuoter",
    rpcUrl,
    verifierUrl: fakeVerifierUrl,
    watch: options.watch
  });
}

function assertVerifyCall(call, expected) {
  assert.equal(call.args[0], "verify-contract");
  assert.equal(call.args[1], expected.address);
  assert.equal(call.args[2], expected.contractId);
  assertArgValue(call.args, "--chain-id", String(expected.chainId));
  assert.equal(call.args.includes("--rpc-url"), false, "tokenized RPC URLs must not be placed in forge argv");
  assert.equal(call.rpcConfigured, true, "forge should receive the provider RPC through ETH_RPC_URL");
  assert.equal(call.args.includes(expected.rpcUrl), false, "provider RPC must not appear in forge argv");
  assertArgValue(call.args, "--verifier", "blockscout");
  assertArgValue(call.args, "--verifier-url", expected.verifierUrl);
  assertArgValue(call.args, "--constructor-args", expected.constructorArgs);
  assert.equal(call.args.includes("--watch"), Boolean(expected.watch));
}

function assertArgValue(args, name, expected) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `${name} missing from ${JSON.stringify(args)}`);
  assert.equal(args[index + 1], expected);
}

function runVerify({ binDir, extraEnv = {}, forgeLogPath, manifestPath, robinhoodEnv = "mainnet", watch }) {
  return childProcess.spawnSync("bash", ["scripts/robinhood/verify.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...scrubbedEnv(),
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_MAINNET_RPC_URL: providerRpcUrl,
      FAKE_TESTNET_RPC_URL: testnetProviderRpcUrl,
      ROBINHOOD_ENV: robinhoodEnv,
      ROBINHOOD_MANIFEST_PATH: manifestPath,
      ROBINHOOD_RPC_URL: providerRpcUrl,
      ROBINHOOD_TESTNET_RPC_URL: testnetProviderRpcUrl,
      VERIFY_CALL_LOG: forgeLogPath,
      ...(watch === undefined ? {} : { VERIFY_WATCH: watch ? "1" : "0" }),
      ...extraEnv
    },
    timeout: childTimeoutMs
  });
}

function assertNoSecretOutput(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  for (const secret of [providerRpcUrl, testnetProviderRpcUrl, ...rpcSecretCanaries]) {
    assert.equal(output.includes(secret), false, `secret canary leaked to output: ${secret}`);
  }
}

function assertLogHasNoSecrets(file) {
  const contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const secret of [providerRpcUrl, testnetProviderRpcUrl, ...rpcSecretCanaries]) {
    assert.equal(contents.includes(secret), false, `secret canary leaked to verification test log: ${secret}`);
  }
}

function readForgeCalls(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeManifest(tempDir, name, manifest) {
  const manifestPath = path.join(tempDir, name);
  const normalized = JSON.parse(JSON.stringify(manifest));
  stripUndefined(normalized);
  fs.writeFileSync(manifestPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return manifestPath;
}

function expectedConstructorArgs(values) {
  return `encoded:${Buffer.from(JSON.stringify(values)).toString("base64url")}`;
}

function writeFakeTools(binDir) {
  fs.writeFileSync(
    path.join(binDir, "cast"),
    `#!/usr/bin/env node
"use strict";
const args = process.argv.slice(2);
if (args[0] === "chain-id") {
  if (args.includes("--rpc-url")) fail("chain-id must receive RPC through ETH_RPC_URL");
  const rpcUrl = process.env.ETH_RPC_URL;
  if (!rpcUrl) fail("chain-id requires ETH_RPC_URL");
  if (process.env.FAKE_CAST_CHAIN_ID) {
    console.log(process.env.FAKE_CAST_CHAIN_ID);
    process.exit(0);
  }
  if (rpcUrl === process.env.FAKE_MAINNET_RPC_URL) {
    console.log("4663");
    process.exit(0);
  }
  if (rpcUrl === process.env.FAKE_TESTNET_RPC_URL) {
    console.log("46630");
    process.exit(0);
  }
  fail("unexpected chain-id provider");
}

const signatures = {
  "constructor(address)": ["address"],
  "constructor(address,address,uint256)": ["address", "address", "uint256"],
  "constructor(address,address,address,address,address,address)": ["address", "address", "address", "address", "address", "address"],
  "constructor(address,address,address,address,address,address,address)": ["address", "address", "address", "address", "address", "address", "address"],
  "constructor(address,address,address,address,address,uint16,address)": ["address", "address", "address", "address", "address", "uint16", "address"]
};

function valueAfter(values, name) {
  const index = values.indexOf(name);
  return index === -1 ? null : values[index + 1] || null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function validateAbiEncode(signature, values) {
  const types = signatures[signature];
  if (!types) fail("unexpected abi-encode signature: " + signature);
  if (values.length !== types.length) {
    fail("abi-encode arity mismatch for " + signature + ": expected " + types.length + ", got " + values.length);
  }
  for (let index = 0; index < types.length; index += 1) {
    validateValue(types[index], values[index], signature, index);
  }
}

function validateValue(type, value, signature, index) {
  if (type === "address") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) fail("invalid address arg " + index + " for " + signature + ": " + value);
    return;
  }
  if (type === "uint256") {
    if (!/^\\d+$/.test(value) || BigInt(value) < 0n) fail("invalid uint256 arg " + index + " for " + signature + ": " + value);
    return;
  }
  if (type === "uint16") {
    if (!/^\\d+$/.test(value)) fail("invalid uint16 arg " + index + " for " + signature + ": " + value);
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > 65535n) fail("uint16 arg out of range " + index + " for " + signature + ": " + value);
    return;
  }
  fail("unsupported abi type: " + type);
}

if (args[0] === "abi-encode") {
  const signature = args[1];
  const values = args.slice(2);
  validateAbiEncode(signature, values);
  console.log("encoded:" + Buffer.from(JSON.stringify(args.slice(1))).toString("base64url"));
  process.exit(0);
}
fail("unexpected cast args: " + JSON.stringify(args));
`
  );
  fs.writeFileSync(
    path.join(binDir, "forge"),
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const rpcConfigured = [process.env.FAKE_MAINNET_RPC_URL, process.env.FAKE_TESTNET_RPC_URL].includes(process.env.ETH_RPC_URL);
fs.appendFileSync(process.env.VERIFY_CALL_LOG, JSON.stringify({ args, rpcConfigured }) + "\\n");
if (process.env.FAKE_FORGE_ECHO_SECRETS === "1") {
  const parsed = new URL(process.env.ETH_RPC_URL);
  console.error("forge diagnostic: provider request failed");
  console.error("provider=" + process.env.ETH_RPC_URL);
  console.error("provider-token=" + parsed.searchParams.get("api-key"));
  console.error("provider-user=" + parsed.username);
  console.error("provider-password=" + parsed.password);
  console.error("provider-password-decoded=" + decodeURIComponent(parsed.password));
  console.error("provider-path=" + parsed.pathname.split("/").filter(Boolean)[0]);
}
process.exit(Number(process.env.FAKE_FORGE_EXIT || "0"));
`
  );
  fs.chmodSync(path.join(binDir, "cast"), 0o755);
  fs.chmodSync(path.join(binDir, "forge"), 0o755);
}

function stripUndefined(value) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
      continue;
    }
    stripUndefined(value[key]);
  }
}

function scrubbedEnv() {
  const env = { ...process.env };
  for (const name of [
    "ROBINHOOD_ENV",
    "ROBINHOOD_MANIFEST_PATH",
    "ROBINHOOD_RPC_URL",
    "ROBINHOOD_TESTNET_RPC_URL",
    "ROBINHOOD_DEPLOYER_PRIVATE_KEY",
    "DEPLOYER_PRIVATE_KEY",
    "ETH_RPC_URL",
    "FAKE_FORGE_ECHO_SECRETS",
    "FAKE_FORGE_EXIT",
    "VERIFY_CALL_LOG",
    "VERIFY_WATCH"
  ]) {
    delete env[name];
  }
  return env;
}
