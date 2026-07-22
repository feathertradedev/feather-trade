#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

const {
  isWalletVendorArtifact,
  scanForForbiddenPublicValues,
  scanForSecretCanaries
} = require("./check-public-artifact.cjs");

function artifact(relativePath, text) {
  return { relativePath, text: text.toLowerCase() };
}

function publicBuildErrors(artifacts) {
  const errors = [];
  scanForForbiddenPublicValues(artifacts, errors);
  return errors;
}

assert.equal(isWalletVendorArtifact("assets/wallet-vendor-Abcd_123.js"), true);
assert.equal(isWalletVendorArtifact("assets/wallet-vendor.js"), false);
assert.equal(isWalletVendorArtifact("assets/not-wallet-vendor-Abc_123.js"), false);
assert.equal(isWalletVendorArtifact("wallet-vendor-Abc_123.js"), false);

assert.deepEqual(
  publicBuildErrors([
    artifact(
      "assets/wallet-vendor-Abcd_123.js",
      [
        "31337",
        "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        "http://127.0.0.1:8545",
        "http://localhost:15005/api",
        "wss://127.0.0.1:9944"
      ].join(" ")
    )
  ]),
  [],
  "known inert local constants should be allowed only in the deterministic wallet vendor chunk"
);

for (const [name, artifacts] of [
  [
    "app-owned local endpoint",
    [artifact("assets/app-entry-Abcd_123.js", "http://127.0.0.1:8545")]
  ],
  [
    "renamed vendor chunk",
    [artifact("assets/vendor-Abcd_123.js", "http://127.0.0.1:8545")]
  ],
  [
    "new unreviewed wallet-vendor endpoint",
    [artifact("assets/wallet-vendor-Abcd_123.js", "http://localhost:9999")]
  ],
  [
    "app-specific local deployment address in wallet chunk",
    [artifact("assets/wallet-vendor-Abcd_123.js", "0x0165878A594ca255338adfa4d48449f69242Eb8F")]
  ],
  [
    "local manifest marker in wallet chunk",
    [artifact("assets/wallet-vendor-Abcd_123.js", "lb.localnet.v1")]
  ]
]) {
  assert.ok(publicBuildErrors(artifacts).length > 0, `${name} unexpectedly passed`);
}

const canaryErrors = [];
scanForSecretCanaries(
  [artifact("assets/wallet-vendor-Abcd_123.js", "prefix super-secret-canary suffix")],
  { ROBINHOOD_RPC_URL: "super-secret-canary" },
  canaryErrors
);
assert.ok(canaryErrors.some((error) => error.includes("ROBINHOOD_RPC_URL")), "wallet chunks must still be scanned for secret canaries");

console.log("public artifact security tests passed");
