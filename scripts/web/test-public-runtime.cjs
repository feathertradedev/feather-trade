#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const validator = path.join(__dirname, "validate-public-runtime.cjs");

for (const value of [undefined, "", "short", "contains whitespace", "x".repeat(129)]) {
  const env = { ...process.env };
  if (value === undefined) delete env.VITE_REOWN_PROJECT_ID;
  else env.VITE_REOWN_PROJECT_ID = value;
  const result = childProcess.spawnSync(process.execPath, [validator], { cwd: root, encoding: "utf8", env });
  assert.notEqual(result.status, 0, `validator unexpectedly accepted ${JSON.stringify(value)}`);
}

const accepted = childProcess.spawnSync(process.execPath, [validator], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, VITE_REOWN_PROJECT_ID: "public_wallet_project_0123456789" }
});
assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
console.log("public wallet runtime validation tests passed");
