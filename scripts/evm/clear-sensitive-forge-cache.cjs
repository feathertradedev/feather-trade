#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const chainId = process.argv[2];
if (!chainId || !/^[1-9][0-9]*$/.test(chainId)) {
  fail("Usage: node scripts/evm/clear-sensitive-forge-cache.cjs <chain-id>");
}

const repoRoot = path.resolve(__dirname, "..", "..");
const cacheRoot = path.join(repoRoot, "cache", "deploy-evm.s.sol");
const target = path.join(cacheRoot, chainId);

if (path.dirname(target) !== cacheRoot) fail("Refusing to clean a path outside the generic deploy cache.");

try {
  fs.rmSync(target, { recursive: true, force: true });
} catch (error) {
  fail(`Could not clear the sensitive Forge deploy cache: ${error.message}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
