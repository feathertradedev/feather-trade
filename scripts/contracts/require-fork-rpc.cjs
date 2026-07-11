#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const variable = process.argv[2] || "AVALANCHE_RPC_URL";
const lane = process.argv[3] || "fork";
const value =
  process.env[variable] ||
  readEnvValue(path.join(process.cwd(), ".env"), variable) ||
  readEnvValue(path.join(process.cwd(), "contracts/joe-v2/.env"), variable);

if (!value || !value.trim()) {
  console.error(
    `${variable} is required for ${lane} contract tests. Set it to a stable archive-capable provider endpoint in a local .env file or protected CI secret.`
  );
  process.exit(1);
}

if (!/^https?:\/\//u.test(value.trim())) {
  console.error(`${variable} must be an HTTP(S) RPC endpoint for ${lane} contract tests.`);
  process.exit(1);
}

function readEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) return "";

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const name = trimmed.slice(0, separator).trim();
    if (name !== key) continue;

    const raw = trimmed.slice(separator + 1).trim();
    return raw.replace(/^['"]|['"]$/gu, "");
  }

  return "";
}
