#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const wrapper = path.join(root, "scripts/indexer/deploy-goldsky-robinhood.sh");
const generator = path.join(root, "scripts/indexer/generate-subgraph-robinhood.cjs");
const testnetManifest = path.join(root, "deployments/examples/robinhood-testnet.example.json");
const mainnetManifest = path.join(root, "deployments/examples/robinhood-mainnet.example.json");

main();

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goldsky-wrapper-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  writeFakeTools(binDir);

  assertDeploy(runWrapper({ binDir, dir, manifestPath: testnetManifest }), "robinhood-lb-testnet/v0.1.0", "testnet");
  assertDeploy(runWrapper({ binDir, dir, manifestPath: mainnetManifest }), "robinhood-lb-mainnet/v0.1.0", "mainnet");
  assertDeploy(
    runWrapper({ binDir, dir, manifestPath: testnetManifest, extraEnv: { GOLDSKY_SUBGRAPH_NAME: "custom-robinhood" } }),
    "custom-robinhood/v0.1.0",
    "testnet"
  );

  const mismatch = runWrapper({ binDir, dir, manifestPath: mainnetManifest, extraEnv: { ROBINHOOD_ENV: "testnet" } });
  assert.notEqual(mismatch.result.status, 0);
  assert.match(mismatch.result.stderr, /does not match manifest environment mainnet/i);
  assert.equal(readCalls(mismatch.goldskyLog).length, 0);
  assert.equal(readCalls(mismatch.pnpmLog).length, 0);

  const malformedPath = path.join(dir, "malformed.json");
  fs.writeFileSync(malformedPath, '{"schemaVersion":"lb.robinhood.v1","environment":"testnet"}\n');
  const malformed = runWrapper({ binDir, dir, manifestPath: malformedPath });
  assert.notEqual(malformed.result.status, 0);
  assert.equal(readCalls(malformed.goldskyLog).length, 0);
  assert.equal(readCalls(malformed.pnpmLog).length, 0);

  const renderedPath = path.join(dir, "mainnet-subgraph.yaml");
  const generated = childProcess.spawnSync(process.execPath, [generator, "--manifest", mainnetManifest, "--output", renderedPath], {
    cwd: root,
    encoding: "utf8",
    env: scrubbedEnv()
  });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  assert.match(fs.readFileSync(renderedPath, "utf8"), /network: robinhood-mainnet/);

  const generatorMismatch = childProcess.spawnSync(
    process.execPath,
    [generator, "--manifest", mainnetManifest, "--output", path.join(dir, "mismatch.yaml")],
    { cwd: root, encoding: "utf8", env: { ...scrubbedEnv(), ROBINHOOD_ENV: "testnet" } }
  );
  assert.notEqual(generatorMismatch.status, 0);
  assert.match(generatorMismatch.stderr, /does not match manifest environment/i);

  console.log("Goldsky Robinhood manifest binding tests passed.");
}

function runWrapper({ binDir, dir, extraEnv = {}, manifestPath }) {
  const nonce = `${Date.now()}-${Math.random()}`;
  const goldskyLog = path.join(dir, `goldsky-${nonce}.jsonl`);
  const pnpmLog = path.join(dir, `pnpm-${nonce}.jsonl`);
  const result = childProcess.spawnSync("bash", [wrapper], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...scrubbedEnv(),
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_GOLDSKY_LOG: goldskyLog,
      FAKE_PNPM_LOG: pnpmLog,
      ROBINHOOD_MANIFEST_PATH: manifestPath,
      ...extraEnv
    },
    timeout: 10_000
  });
  return { goldskyLog, pnpmLog, result };
}

function assertDeploy(run, expectedDeployment, expectedEnvironment) {
  assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
  const goldskyCalls = readCalls(run.goldskyLog);
  assert.equal(goldskyCalls.length, 1);
  assert.deepEqual(goldskyCalls[0], ["subgraph", "deploy", expectedDeployment, "--path", "."]);
  const pnpmCalls = readCalls(run.pnpmLog);
  assert.deepEqual(pnpmCalls.map((call) => call.args), [
    ["indexer:generate:robinhood"],
    ["indexer:codegen:rendered"],
    ["indexer:build:rendered"]
  ]);
  assert.equal(pnpmCalls[0].environment, expectedEnvironment);
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeFakeTools(binDir) {
  fs.writeFileSync(
    path.join(binDir, "goldsky"),
    '#!/usr/bin/env node\nconst fs=require("node:fs"); fs.appendFileSync(process.env.FAKE_GOLDSKY_LOG, JSON.stringify(process.argv.slice(2))+"\\n");\n'
  );
  fs.writeFileSync(
    path.join(binDir, "pnpm"),
    '#!/usr/bin/env node\nconst fs=require("node:fs"); fs.appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify({args:process.argv.slice(2),environment:process.env.ROBINHOOD_ENV||null})+"\\n");\n'
  );
  fs.chmodSync(path.join(binDir, "goldsky"), 0o755);
  fs.chmodSync(path.join(binDir, "pnpm"), 0o755);
}

function scrubbedEnv() {
  const env = { ...process.env };
  for (const name of [
    "GOLDSKY_API_KEY",
    "GOLDSKY_SUBGRAPH_NAME",
    "GOLDSKY_TOKEN",
    "INDEXER_ROBINHOOD_MANIFEST",
    "ROBINHOOD_ENV",
    "ROBINHOOD_MANIFEST_PATH"
  ]) delete env[name];
  return env;
}
