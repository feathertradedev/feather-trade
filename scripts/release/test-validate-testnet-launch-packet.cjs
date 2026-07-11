#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const childProcess = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { sha256, validatePacket } = require("./validate-testnet-launch-packet.cjs");

const root = path.resolve(__dirname, "..", "..");
const packetPath = path.join(root, "docs/wave-2/evidence/testnet-launch-packet.json");
const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));

assert.deepEqual(validatePacket(packet, { root, commitMode: "development" }), []);
assert.deepEqual(validatePacket(packet, { root, commitMode: "candidate", candidateCommit: packet.release.repositoryCommit }), []);
assert.deepEqual(validatePacket(packet, { root, commitMode: "ancestry" }), []);

const laterCheckout = fs.mkdtempSync(path.join(os.tmpdir(), "launch-packet-later-checkout-"));
try {
  childProcess.execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, laterCheckout]);
  childProcess.execFileSync("git", ["-c", "user.name=Evidence Test", "-c", "user.email=evidence@example.invalid", "commit", "--allow-empty", "-m", "later merge checkout"], { cwd: laterCheckout });
  assert.deepEqual(validatePacket(packet, { root: laterCheckout, commitMode: "ancestry" }), []);
} finally {
  fs.rmSync(laterCheckout, { recursive: true, force: true });
}

const inventedCommit = structuredClone(packet);
inventedCommit.release.repositoryCommit = "f".repeat(40);
inventedCommit.release.evidenceSourceCommit = inventedCommit.release.repositoryCommit;
assert(validatePacket(inventedCommit, { root, commitMode: "development" }).includes("release.repositoryCommit must identify a commit in this repository"));

const wrongBinding = structuredClone(packet);
wrongBinding.checks.find((check) => check.id === "ownership-handoff").evidence = "rpc-readiness";
assert(validatePacket(wrongBinding, { root, commitMode: "development" }).includes("ownership-handoff must reference fixed artifact id: goldsky-rehearsal"));

const stale = structuredClone(packet);
stale.artifacts[0].sha256 = "0".repeat(64);
assert(validatePacket(stale, { root, commitMode: "development" }).some((error) => error.includes("SHA-256 is stale")));

const missingCoverage = structuredClone(packet);
missingCoverage.artifacts.forEach((artifact) => {
  artifact.covers = artifact.covers.filter((item) => item !== "ownership");
});
assert(validatePacket(missingCoverage, { root, commitMode: "development" }).includes("missing required evidence coverage: ownership"));

const badCheck = structuredClone(packet);
badCheck.checks[0].status = "blocked";
assert(validatePacket(badCheck, { root, commitMode: "development" }).includes("checks[0].status must be pass"));

const degradedUnproven = packet.checks.find((check) => check.id === "multibin-remove-degraded-state");
assert.equal(degradedUnproven.status, "unproven");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launch-packet-"));
try {
  const escape = structuredClone(packet);
  escape.artifacts[0].path = "../secret.txt";
  assert(validatePacket(escape, { root: temporaryRoot, commitMode: "development" }).includes("artifacts[0].path escapes the repository root"));
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

const manifestMismatch = structuredClone(packet);
manifestMismatch.manifest.startBlock += 1;
assert(validatePacket(manifestMismatch, { root, commitMode: "development" }).includes("packet manifest.startBlock does not match the manifest"));

assert.equal(sha256(Buffer.from("packet\n")), "68d68c74f6cf22edab9fcb536f2680630f8c473e57e35d5150ab98974cdc84a6");
console.log("Testnet launch packet validator tests passed.");
