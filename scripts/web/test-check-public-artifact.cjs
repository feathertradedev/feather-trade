#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isWalletVendorArtifact,
  scanForForbiddenPublicValues,
  scanForSecretCanaries,
  validateWalletVendorAudit
} = require("./check-public-artifact.cjs");

function artifact(relativePath, text) {
  return { relativePath, text: text.toLowerCase() };
}

function publicBuildErrors(artifacts, audited = new Set()) {
  const errors = [];
  scanForForbiddenPublicValues(artifacts, errors, audited);
  return errors;
}

assert.equal(isWalletVendorArtifact("assets/wallet-vendor-dist-Abcd_123.js"), true);
assert.equal(isWalletVendorArtifact("assets/wallet-vendor.js"), false);
assert.equal(isWalletVendorArtifact("assets/not-wallet-vendor-Abc_123.js"), false);
assert.equal(isWalletVendorArtifact("wallet-vendor-Abc_123.js"), false);

const reviewedVendorPath = "assets/wallet-vendor-dist-Abcd_123.js";
const reviewedVendorArtifact = artifact(
      reviewedVendorPath,
      [
        "31337",
        "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        "http://127.0.0.1:8545",
        "http://localhost:15005/api",
        "wss://127.0.0.1:9944"
      ].join(" ")
    );

assert.ok(
  publicBuildErrors([reviewedVendorArtifact]).length > 0,
  "a wallet-vendor filename without the build audit inventory must not receive exceptions"
);
assert.deepEqual(
  publicBuildErrors([reviewedVendorArtifact], new Set([reviewedVendorPath])),
  [],
  "known inert local constants should be allowed only in audited dependency-only wallet vendor chunks"
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
    [artifact(reviewedVendorPath, "http://localhost:9999")]
  ],
  [
    "app-specific local deployment address in wallet chunk",
    [artifact(reviewedVendorPath, "0x0165878A594ca255338adfa4d48449f69242Eb8F")]
  ],
  [
    "local manifest marker in wallet chunk",
    [artifact(reviewedVendorPath, "lb.localnet.v1")]
  ]
]) {
  assert.ok(publicBuildErrors(artifacts, new Set([reviewedVendorPath])).length > 0, `${name} unexpectedly passed`);
}

const canaryErrors = [];
scanForSecretCanaries(
  [artifact("assets/wallet-vendor-dist-Abcd_123.js", "prefix super-secret-canary suffix")],
  { ROBINHOOD_RPC_URL: "super-secret-canary" },
  canaryErrors
);
assert.ok(canaryErrors.some((error) => error.includes("ROBINHOOD_RPC_URL")), "wallet chunks must still be scanned for secret canaries");

const tempDist = fs.mkdtempSync(path.join(os.tmpdir(), "feather-wallet-vendor-audit-"));
try {
  const relativePath = reviewedVendorPath;
  const filePath = path.join(tempDist, ...relativePath.split("/"));
  const source = "const localChain = 'http://127.0.0.1:8545';";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
  fs.writeFileSync(path.join(tempDist, "wallet-vendor-audit.json"), JSON.stringify({
    schemaVersion: "feather.wallet-vendor-audit.v1",
    artifacts: [{
      file: relativePath,
      sha256: crypto.createHash("sha256").update(source).digest("hex")
    }]
  }));
  const searchable = [artifact(relativePath, source)];
  const validErrors = [];
  assert.deepEqual(
    [...validateWalletVendorAudit(tempDist, searchable, validErrors)],
    [relativePath],
    "a digest-bound build inventory should authorize its exact dependency chunk"
  );
  assert.deepEqual(validErrors, []);

  fs.writeFileSync(filePath, `${source}/* modified */`);
  const digestErrors = [];
  assert.deepEqual([...validateWalletVendorAudit(tempDist, searchable, digestErrors)], []);
  assert.ok(digestErrors.some((error) => error.includes("digest mismatch")), "post-build mutation must invalidate the audit");

  fs.writeFileSync(filePath, source);
  fs.writeFileSync(path.join(tempDist, "wallet-vendor-audit.json"), JSON.stringify({
    schemaVersion: "feather.wallet-vendor-audit.v1",
    artifacts: []
  }));
  const spoofErrors = [];
  assert.deepEqual([...validateWalletVendorAudit(tempDist, searchable, spoofErrors)], []);
  assert.ok(
    spoofErrors.some((error) => error.includes("not present in the build audit inventory")),
    "a copied static wallet-vendor filename must not receive provenance exceptions"
  );
} finally {
  fs.rmSync(tempDist, { force: true, recursive: true });
}

console.log("public artifact security tests passed");
