#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const mainnetRpc = "https://deploymainnetuser:deploy%3Amainnet%2Dpassword@provider.rpc.example/deploymainnetpathcredential/mainnet?api-key=deploy-mainnet-secret-canary";
const testnetRpc = "https://deploytestnetuser:deploy%3Atestnet%2Dpassword@provider.rpc.example/deploytestnetpathcredential/testnet?api-key=deploy-testnet-secret-canary";
const privateKey = `0x${"12".repeat(32)}`;
const rpcSecretCanaries = [
  "deploy-mainnet-secret-canary",
  "deploy-testnet-secret-canary",
  "deploymainnetuser",
  "deploytestnetuser",
  "deploy%3Amainnet%2Dpassword",
  "deploy%3Atestnet%2Dpassword",
  "deploy:mainnet-password",
  "deploy:testnet-password",
  "deploymainnetpathcredential",
  "deploytestnetpathcredential"
];

main();

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-deploy-wrapper-"));
  const binDir = path.join(tempDir, "bin");
  const callLog = path.join(tempDir, "forge-calls.jsonl");
  fs.mkdirSync(binDir);
  writeFakeTools(binDir);

  let result = runDeploy({ binDir, callLog, manifestPath: path.join(tempDir, "testnet.json") });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertNoSecrets(result);
  assertForgeCall(readCalls(callLog)[0], { broadcast: true });

  fs.writeFileSync(callLog, "");
  result = runDeploy({
    binDir,
    callLog,
    dryRun: true,
    manifestPath: path.join(tempDir, "mainnet-dry-run.json"),
    robinhoodEnv: "mainnet"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertNoSecrets(result);
  assertForgeCall(readCalls(callLog)[0], { broadcast: false });

  fs.writeFileSync(callLog, "");
  result = runDeploy({
    binDir,
    callLog,
    extraEnv: { ROBINHOOD_TESTNET_RPC_URL: "" },
    manifestPath: path.join(tempDir, "missing-rpc.json")
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set ROBINHOOD_TESTNET_RPC_URL to an explicit provider RPC/i);
  assertNoSecrets(result);
  assert.equal(readCalls(callLog).length, 0);

  fs.writeFileSync(callLog, "");
  result = runDeploy({
    binDir,
    callLog,
    extraEnv: { ROBINHOOD_TESTNET_RPC_URL: "HTTPS://RPC.TESTNET.CHAIN.ROBINHOOD.COM:443/?ignored=1#fragment" },
    manifestPath: path.join(tempDir, "public-testnet-rpc.json")
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical public Robinhood RPC is prohibited/i);
  assert.equal(readCalls(callLog).length, 0, "public testnet RPC must fail before Forge");

  fs.writeFileSync(callLog, "");
  result = runDeploy({
    binDir,
    callLog,
    extraEnv: { ROBINHOOD_RPC_URL: "HTTPS://RPC.MAINNET.CHAIN.ROBINHOOD.COM.:443/#fragment" },
    manifestPath: path.join(tempDir, "public-mainnet-rpc.json"),
    robinhoodEnv: "mainnet"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical public Robinhood RPC is prohibited/i);
  assert.equal(readCalls(callLog).length, 0, "public mainnet RPC must fail before Forge");

  fs.writeFileSync(callLog, "");
  result = runDeploy({
    binDir,
    callLog,
    extraEnv: { FAKE_CAST_CHAIN_ID: "1" },
    manifestPath: path.join(tempDir, "wrong-chain.json")
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RPC chain-id mismatch/i);
  assertNoSecrets(result);
  assert.equal(readCalls(callLog).length, 0);

  fs.writeFileSync(callLog, "");
  result = runDeploy({
    binDir,
    callLog,
    extraEnv: { FAKE_FORGE_ECHO_SECRETS: "1", FAKE_FORGE_EXIT: "42" },
    manifestPath: path.join(tempDir, "provider-failure.json")
  });
  assert.equal(result.status, 42, result.stderr || result.stdout);
  assertNoSecrets(result);
  assert.match(`${result.stdout}\n${result.stderr}`, /forge diagnostic: provider request failed/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /\[REDACTED_RPC_URL\]/);
  assert.match(`${result.stdout}\n${result.stderr}`, /\[REDACTED_RPC_CREDENTIAL\]/);
  assert.match(`${result.stdout}\n${result.stderr}`, /\[REDACTED_PRIVATE_KEY\]/);
  assertLogHasNoSecrets(callLog);

  console.log("Robinhood deploy wrapper security tests passed.");
}

function runDeploy({ binDir, callLog, dryRun = false, extraEnv = {}, manifestPath, robinhoodEnv = "testnet" }) {
  return childProcess.spawnSync("bash", ["scripts/robinhood/deploy.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...scrubbedEnv(),
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      DEPLOY_FORGE_CALL_LOG: callLog,
      DRY_RUN: dryRun ? "1" : "0",
      FAKE_MAINNET_RPC_URL: mainnetRpc,
      FAKE_PRIVATE_KEY: privateKey,
      FAKE_TESTNET_RPC_URL: testnetRpc,
      ROBINHOOD_DEPLOYER_PRIVATE_KEY: privateKey,
      ROBINHOOD_ENV: robinhoodEnv,
      ROBINHOOD_MANIFEST_PATH: manifestPath,
      ROBINHOOD_RPC_URL: mainnetRpc,
      ROBINHOOD_TESTNET_RPC_URL: testnetRpc,
      ...extraEnv
    },
    timeout: 10_000
  });
}

function assertForgeCall(call, { broadcast }) {
  assert(call, "expected forge to be invoked");
  assert.equal(call.rpcConfigured, true, "forge should receive ETH_RPC_URL");
  assert.equal(call.privateKeyConfigured, true, "Solidity script should receive the private key through its environment");
  assert.equal(call.args.includes("--rpc-url"), false);
  assert.equal(call.args.includes("--private-key"), false);
  assert.equal(call.args.includes("--broadcast"), broadcast);
  const argv = JSON.stringify(call.args);
  for (const secret of [mainnetRpc, testnetRpc, privateKey]) assert.equal(argv.includes(secret), false);
}

function assertNoSecrets(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  for (const secret of [mainnetRpc, testnetRpc, privateKey, ...rpcSecretCanaries]) {
    assert.equal(output.includes(secret), false, `secret leaked to deploy output: ${secret}`);
  }
}

function assertLogHasNoSecrets(file) {
  const contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const secret of [mainnetRpc, testnetRpc, privateKey, ...rpcSecretCanaries]) {
    assert.equal(contents.includes(secret), false, `secret leaked to deploy test log: ${secret}`);
  }
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeFakeTools(binDir) {
  fs.writeFileSync(
    path.join(binDir, "cast"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "chain-id" || args.includes("--rpc-url")) process.exit(2);
if (process.env.FAKE_CAST_CHAIN_ID) console.log(process.env.FAKE_CAST_CHAIN_ID);
else if (process.env.ETH_RPC_URL === process.env.FAKE_MAINNET_RPC_URL) console.log("4663");
else if (process.env.ETH_RPC_URL === process.env.FAKE_TESTNET_RPC_URL) console.log("46630");
else process.exit(3);
`
  );
  fs.writeFileSync(
    path.join(binDir, "forge"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const rpcConfigured = [process.env.FAKE_MAINNET_RPC_URL, process.env.FAKE_TESTNET_RPC_URL].includes(process.env.ETH_RPC_URL);
const privateKeyConfigured = process.env.ROBINHOOD_DEPLOYER_PRIVATE_KEY === process.env.FAKE_PRIVATE_KEY;
fs.appendFileSync(process.env.DEPLOY_FORGE_CALL_LOG, JSON.stringify({ args, rpcConfigured, privateKeyConfigured }) + "\\n");
if (process.env.FAKE_FORGE_ECHO_SECRETS === "1") {
  const parsed = new URL(process.env.ETH_RPC_URL);
  console.error("forge diagnostic: provider request failed");
  console.error("provider=" + process.env.ETH_RPC_URL);
  console.error("provider-token=" + parsed.searchParams.get("api-key"));
  console.error("provider-user=" + parsed.username);
  console.error("provider-password=" + parsed.password);
  console.error("provider-password-decoded=" + decodeURIComponent(parsed.password));
  console.error("provider-path=" + parsed.pathname.split("/").filter(Boolean)[0]);
  console.error("private-key=" + process.env.ROBINHOOD_DEPLOYER_PRIVATE_KEY);
}
process.exit(Number(process.env.FAKE_FORGE_EXIT || "0"));
`
  );
  fs.chmodSync(path.join(binDir, "cast"), 0o755);
  fs.chmodSync(path.join(binDir, "forge"), 0o755);
}

function scrubbedEnv() {
  const env = { ...process.env };
  for (const name of [
    "DEPLOYER_PRIVATE_KEY",
    "DRY_RUN",
    "ETH_RPC_URL",
    "FAKE_FORGE_ECHO_SECRETS",
    "FAKE_FORGE_EXIT",
    "ROBINHOOD_DEPLOYER_PRIVATE_KEY",
    "ROBINHOOD_ENV",
    "ROBINHOOD_MANIFEST_PATH",
    "ROBINHOOD_RPC_URL",
    "ROBINHOOD_TESTNET_RPC_URL"
  ]) {
    delete env[name];
  }
  return env;
}
