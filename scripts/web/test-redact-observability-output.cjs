#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");

const redactor = path.join(__dirname, "redact-observability-output.cjs");
const rpc = "https://user:password@rpc.example/v1/abcdef0123456789?key=secret-token";
const owner = "0x1111111111111111111111111111111111111111";
const input = `failed ${rpc} endpointHost=rpc.example host=rpc.example password abcdef0123456789 secret-token ${owner}\npublic status`;
const result = childProcess.spawnSync(process.execPath, [redactor], {
  encoding: "utf8",
  env: { ...process.env, OBSERVABILITY_REDACT_RPC_URL: rpc, OBSERVABILITY_REDACT_OWNER: owner },
  input
});

assert.equal(result.status, 0, result.stderr);
for (const secret of [rpc, "rpc.example", "password", "abcdef0123456789", "secret-token", owner]) {
  assert(!result.stdout.includes(secret), `output retained secret ${secret}`);
}
assert.match(result.stdout, /public status/);
console.log("observability output redaction tests passed");
