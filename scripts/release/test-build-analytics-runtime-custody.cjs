#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const builder = path.join(root, "scripts/release/build-analytics-runtime-custody.cjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "feather-custody-builder-"));
const config = path.join(temporary, "config");
const adapters = path.join(temporary, "adapters");
const output = path.join(config, "runtime-custody.json");

try {
  fs.mkdirSync(config);
  fs.mkdirSync(adapters);
  fs.writeFileSync(path.join(config, "price-policies.json"), "[]\n");
  fs.writeFileSync(path.join(adapters, "chainlink-verifier.mjs"), "export const marker = 'verifier';\n");
  fs.writeFileSync(path.join(adapters, "canonical-block-source.mjs"), "export const marker = 'source';\n");
  fs.writeFileSync(path.join(adapters, "position-snapshot-provider.mjs"), "export const marker = 'positions';\n");

  const first = run(output);
  assert.equal(first.status, 0, first.stderr);
  const firstBytes = fs.readFileSync(output);
  const firstDigest = digestFromOutput(first.stdout);
  fs.chmodSync(output, 0o644);
  const second = run(output);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(fs.readFileSync(output), firstBytes, "identical inputs produce byte-identical inventory");
  assert.equal(digestFromOutput(second.stdout), firstDigest, "identical inputs produce the same bundle digest");

  fs.writeFileSync(path.join(adapters, "canonical-block-source.mjs"), "export const marker = 'changed';\n");
  fs.chmodSync(output, 0o644);
  const changed = run(output);
  assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(digestFromOutput(changed.stdout), firstDigest, "changing one bundle input changes custody");

  const realVerifier = path.join(adapters, "chainlink-verifier.mjs");
  fs.unlinkSync(realVerifier);
  fs.symlinkSync(path.join(adapters, "position-snapshot-provider.mjs"), realVerifier);
  fs.chmodSync(output, 0o644);
  const symlinked = run(output);
  assert.notEqual(symlinked.status, 0);
  assert.match(symlinked.stderr, /non-symlink file/);

  console.log("Deterministic analytics runtime custody builder tests passed.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function run(outputPath) {
  return childProcess.spawnSync(process.execPath, [
    builder,
    "--environment", "mainnet",
    "--deployment-identity", "mainnet:0123456789abcdef",
    "--config-dir", config,
    "--adapters-dir", adapters,
    "--output", outputPath
  ], { cwd: root, encoding: "utf8" });
}

function digestFromOutput(stdout) {
  const match = stdout.match(/^ANALYTICS_RUNTIME_CUSTODY_SHA256=([0-9a-f]{64})$/m);
  assert(match, `custody builder did not emit a digest: ${stdout}`);
  return match[1];
}
