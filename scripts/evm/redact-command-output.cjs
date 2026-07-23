#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const rpcUrl = process.env.EVM_DEPLOY_REDACT_RPC_URL || "";
const privateKey = process.env.EVM_DEPLOY_REDACT_PRIVATE_KEY || "";
let output = fs.readFileSync(0, "utf8");
const replacements = new Map();

add(rpcUrl, "[REDACTED_RPC_URL]");
add(privateKey, "[REDACTED_PRIVATE_KEY]");
if (privateKey.startsWith("0x")) add(privateKey.slice(2), "[REDACTED_PRIVATE_KEY]");

if (rpcUrl) {
  try {
    const parsed = new URL(rpcUrl);
    addCredential(parsed.username);
    addCredential(parsed.password);
    for (const value of parsed.searchParams.values()) addCredential(value);
    for (const segment of parsed.pathname.split("/").filter(Boolean)) {
      if (segment.length >= 12) addCredential(segment);
    }
  } catch (_) {
    // Exact-string replacement above still protects malformed provider URLs.
  }
}

for (const [secret, replacement] of [...replacements.entries()].sort((a, b) => b[0].length - a[0].length)) {
  output = output.split(secret).join(replacement);
}

process.stdout.write(output);

function addCredential(value) {
  if (!value) return;
  add(value, "[REDACTED_RPC_CREDENTIAL]");
  try {
    add(decodeURIComponent(value), "[REDACTED_RPC_CREDENTIAL]");
  } catch (_) {}
  add(encodeURIComponent(value), "[REDACTED_RPC_CREDENTIAL]");
}

function add(value, replacement) {
  if (typeof value !== "string" || value.length === 0) return;
  replacements.set(value, replacement);
}
