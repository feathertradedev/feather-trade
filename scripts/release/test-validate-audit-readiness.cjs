#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { buildBundle, safeOutput } = require("./build-audit-bundle.cjs");
const { computeScope, statusStatements } = require("./validate-audit-readiness.cjs");

const projectRoot = path.resolve(__dirname, "..", "..");
const validator = path.join(projectRoot, "scripts/release/validate-audit-readiness.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-readiness-test-"));
const root = path.join(temp, "repo");
const recordDir = path.join(root, "docs/wave-2/audit");
const now = "2026-07-10T12:00:00Z";
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const reportBytes = Buffer.from("external report fixture\n");
const tamperedReportBytes = Buffer.from("tampered external report fixture\n");
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const { publicKey: wrongPublicKey } = crypto.generateKeyPairSync("ed25519");
const signatureBytes = crypto.sign(null, reportBytes, privateKey);
const tamperedSignatureBytes = Buffer.from(signatureBytes.map((byte, index) => index === 0 ? byte ^ 1 : byte));
const trustedPublicKey = path.join(temp, "trusted-public.pem");
const wrongTrustedPublicKey = path.join(temp, "wrong-public.pem");

function command(commandName, args, cwd = root) {
  const result = childProcess.spawnSync(commandName, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function write(relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeJson(relativePath, value) { write(relativePath, `${JSON.stringify(value, null, 2)}\n`); }

function makeRecords(name, mutate = () => {}) {
  const directory = path.join(temp, name);
  fs.cpSync(recordDir, directory, { recursive: true });
  const records = {};
  for (const file of ["scope.json", "findings.json", "exceptions.json"]) records[file] = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
  mutate(records);
  for (const [file, value] of Object.entries(records)) fs.writeFileSync(path.join(directory, file), `${JSON.stringify(value, null, 2)}\n`);
  return directory;
}

function run(records, ...args) {
  return childProcess.spawnSync(process.execPath, [validator, "--root", root, "--record-dir", records, "--now", now, ...args], { cwd: root, encoding: "utf8" });
}

function runWithEnv(records, env) {
  return childProcess.spawnSync(process.execPath, [validator, "--root", root, "--record-dir", records, "--now", now], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
}

try {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(trustedPublicKey, publicKey.export({ type: "spki", format: "pem" }));
  fs.writeFileSync(wrongTrustedPublicKey, wrongPublicKey.export({ type: "spki", format: "pem" }));
  command("git", ["init", "-q"]);
  command("git", ["config", "user.email", "audit-test@example.com"]);
  command("git", ["config", "user.name", "Audit Test"]);
  write(".gitignore", ".local/\n");
  write("src/candidate.txt", "committed candidate bytes\n");
  write("docs/evidence/report.pdf", reportBytes);
  write("docs/evidence/report.sig", signatureBytes);
  write("docs/evidence/tampered-report.pdf", tamperedReportBytes);
  write("docs/evidence/tampered-report.sig", signatureBytes);
  write("docs/evidence/tampered-signature.sig", tamperedSignatureBytes);
  for (const file of ["docs/wave-2/audit-readiness-package.md", "docs/wave-2/threat-model.md", "docs/provenance/joe-v2.md", "docs/provenance/dependency-license-report.md", "docs/provenance/license-exceptions.md"]) write(file, `${file}\n`);
  command("git", ["add", "."]);
  command("git", ["commit", "-qm", "candidate source"]);
  const candidateCommit = command("git", ["rev-parse", "HEAD"]);
  const scope = {
    schemaVersion: "robinhood.external-audit.scope.v1", auditStatus: "not-audited", statement: statusStatements["not-audited"], scopeId: "test-scope",
    source: { repository: "fixture", candidateCommit }, includedPaths: ["src"], excludedPaths: [], inventory: { algorithm: "sha256-path-nul-content-nul-v1", fileCount: 0, sha256: "" }
  };
  Object.assign(scope.inventory, (() => { const result = computeScope(root, scope); return { fileCount: result.files.length, sha256: result.sha256 }; })());
  const findings = { schemaVersion: "robinhood.external-audit.findings.v1", auditStatus: "not-audited", statement: statusStatements["not-audited"], scopeId: "test-scope", auditor: null, report: null, attestation: null, findings: [] };
  const exceptions = { schemaVersion: "robinhood.external-audit.exceptions.v1", auditStatus: "not-audited", statement: statusStatements["not-audited"], scopeId: "test-scope", launchApproval: { status: "blocked", approvedBy: null, approvedAt: null, expiresAt: null, evidenceRef: null, attestationSha256: null, protectedIdentityRef: null }, exceptions: [] };
  writeJson("docs/wave-2/audit/scope.json", scope);
  writeJson("docs/wave-2/audit/findings.json", findings);
  writeJson("docs/wave-2/audit/exceptions.json", exceptions);
  command("git", ["add", "."]);
  command("git", ["commit", "-qm", "committed audit handoff"]);

  const valid = makeRecords("valid");
  assert.equal(run(valid, "--pr-integrity").status, 0, "PR integrity suppresses only expected pre-audit blockers");
  assert.equal(run(valid, "--allow-not-audited").status, 1, "blocked launch approval remains blocking in pre-audit mode");
  assert.match(run(valid, "--allow-not-audited").stdout, /launch approval is blocked/);
  const approvalReady = makeRecords("approval-ready", ({ "exceptions.json": value }) => {
    value.launchApproval.status = "approved";
  });
  assert.equal(run(approvalReady, "--allow-not-audited").status, 1, "approval cannot precede external audit");

  const onlyMissingAudit = makeRecords("only-missing-audit", ({ "exceptions.json": value }) => {
    value.launchApproval = { status: "approved", approvedBy: "release-owner", approvedAt: now, expiresAt: "2026-07-20", evidenceRef: "https://approvals.example/41", attestationSha256: "0".repeat(64), protectedIdentityRef: "https://identity.example/release-owner" };
    value.auditStatus = "audited"; value.statement = statusStatements.audited;
  });
  assert.equal(run(onlyMissingAudit, "--allow-not-audited").status, 1, "status disagreement and missing attestation cannot be suppressed");

  const high = makeRecords("high", ({ "findings.json": value, "exceptions.json": approval }) => {
    value.findings.push({ id: "audit-high", severity: "high", status: "open", component: "router", owner: "security" });
    approval.launchApproval.status = "blocked";
  });
  assert.equal(run(high, "--allow-not-audited").status, 1, "high findings must remain blocking");
  assert.equal(run(high, "--pr-integrity").status, 1, "PR integrity must not suppress high findings");
  assert.match(run(high, "--allow-not-audited").stdout, /unresolved high finding/);

  const expired = makeRecords("expired", ({ "exceptions.json": value }) => value.exceptions.push({ id: "risk-one", owner: "security", component: "router", compensatingControl: "Pause", expiresAt: "2026-07-09", approval: { mainnet: true, approvedBy: "risk-owner", approvedAt: "2026-07-01T12:00:00Z", evidenceRef: "https://approvals.example/risk-one" } }));
  assert.equal(run(expired, "--allow-not-audited").status, 1, "expired exceptions must remain blocking");
  assert.equal(run(expired, "--pr-integrity").status, 1, "PR integrity must not suppress expired exceptions");

  const nonCanonical = makeRecords("non-canonical", ({ "scope.json": value }) => { value.statement = "not audited-ish"; });
  assert.equal(run(nonCanonical, "--allow-not-audited").status, 1, "ambiguous status statements must fail");

  const untracked = path.join(root, "src/untracked-secret.txt");
  fs.writeFileSync(untracked, "PRIVATE_KEY=" + "a".repeat(64));
  const outputA = path.join(temp, "bundle-a");
  const outputB = path.join(temp, "bundle-b");
  const first = buildBundle({ root, output: outputA, now });
  const second = buildBundle({ root, output: outputB, now });
  assert.equal(first.manifestSha256, second.manifestSha256, "bundle manifests must be deterministic");
  assert.equal(first.manifest.files.some((entry) => entry.path === "src/untracked-secret.txt"), false, "untracked files must never enter the bundle");
  assert.equal(fs.readFileSync(path.join(outputA, "files/src/candidate.txt"), "utf8"), "committed candidate bytes\n");

  assert.throws(() => safeOutput(root, root), /must not equal or contain/);
  assert.throws(() => safeOutput(root, path.dirname(root)), /must not equal or contain/);
  assert.throws(() => safeOutput(root, path.join(root, "output")), /only below ignored \.local/);
  const localOutput = path.join(root, ".local/audit/bundle");
  assert.equal(safeOutput(root, localOutput), localOutput);
  fs.mkdirSync(path.join(root, ".local"), { recursive: true });
  const symlinkOutput = path.join(root, ".local/escape");
  fs.symlinkSync(root, symlinkOutput);
  assert.throws(() => safeOutput(root, symlinkOutput), /realpath (?:is unsafe|escapes ignored \.local)/);

  const forceVictim = path.join(root, "force-victim");
  const forceMarker = path.join(forceVictim, "must-survive.txt");
  fs.mkdirSync(forceVictim);
  fs.writeFileSync(forceMarker, "repository content\n");
  const externalRepoLink = path.join(temp, "external-repo-link");
  fs.symlinkSync(root, externalRepoLink);
  assert.throws(
    () => buildBundle({ root, output: path.join(externalRepoLink, "force-victim"), now, force: true }),
    /external output resolves into the repository/,
    "--force must reject an external path whose symlinked parent resolves into the repository"
  );
  assert.equal(fs.readFileSync(forceMarker, "utf8"), "repository content\n", "--force must not delete through a symlinked parent");

  fs.rmSync(untracked);
  write("src/candidate.txt", "dirty worktree substitution\n");
  const outputC = path.join(temp, "bundle-c");
  buildBundle({ root, output: outputC, now });
  assert.equal(fs.readFileSync(path.join(outputC, "files/src/candidate.txt"), "utf8"), "committed candidate bytes\n", "dirty tracked bytes must not replace committed candidate bytes");

  const reportDigest = digest(reportBytes);
  const signatureDigest = digest(signatureBytes);
  const audited = makeRecords("audited", (records) => {
    for (const value of Object.values(records)) { value.auditStatus = "audited"; value.statement = statusStatements.audited; }
    records["findings.json"].auditor = "independent-auditor";
    records["findings.json"].report = { path: "docs/evidence/report.pdf", sha256: reportDigest };
    records["findings.json"].attestation = { mechanism: "detached-signature", artifact: { path: "docs/evidence/report.sig", sha256: signatureDigest }, subjectSha256: reportDigest, issuer: "protected-ci-identity", protectedIdentityRef: "https://identity.example/protected-ci", verificationRef: "https://verify.example/attestation/1" };
    records["exceptions.json"].launchApproval = { status: "approved", approvedBy: "release-owner", approvedAt: now, expiresAt: "2026-07-20", evidenceRef: "https://approvals.example/41", attestationSha256: signatureDigest, protectedIdentityRef: "https://identity.example/protected-ci" };
  });
  assert.equal(run(audited, "--trusted-public-key", trustedPublicKey).status, 0, "valid detached signature and trusted key should pass");
  assert.equal(runWithEnv(audited, { AUDIT_TRUSTED_PUBLIC_KEY: trustedPublicKey }).status, 0, "trusted key supplied by environment should pass");
  assert.equal(run(audited).status, 1, "audited status without an explicit trusted key must fail");
  assert.equal(run(audited, "--trusted-public-key", wrongTrustedPublicKey).status, 1, "a signature checked with the wrong trusted key must fail");
  const tamperedReport = makeRecords("tampered-report", (records) => {
    for (const value of Object.values(records)) { value.auditStatus = "audited"; value.statement = statusStatements.audited; }
    records["findings.json"].auditor = "independent-auditor";
    records["findings.json"].report = { path: "docs/evidence/tampered-report.pdf", sha256: digest(tamperedReportBytes) };
    records["findings.json"].attestation = { mechanism: "detached-signature", artifact: { path: "docs/evidence/tampered-report.sig", sha256: signatureDigest }, subjectSha256: digest(tamperedReportBytes), issuer: "protected-ci-identity", protectedIdentityRef: "https://identity.example/protected-ci", verificationRef: "https://verify.example/attestation/1" };
    records["exceptions.json"].launchApproval = { status: "approved", approvedBy: "release-owner", approvedAt: now, expiresAt: "2026-07-20", evidenceRef: "https://approvals.example/41", attestationSha256: signatureDigest, protectedIdentityRef: "https://identity.example/protected-ci" };
  });
  assert.equal(run(tamperedReport, "--trusted-public-key", trustedPublicKey).status, 1, "tampered report bytes must fail signature verification");
  const tamperedSignature = makeRecords("tampered-signature", (records) => {
    for (const value of Object.values(records)) { value.auditStatus = "audited"; value.statement = statusStatements.audited; }
    records["findings.json"].auditor = "independent-auditor";
    records["findings.json"].report = { path: "docs/evidence/report.pdf", sha256: reportDigest };
    records["findings.json"].attestation = { mechanism: "detached-signature", artifact: { path: "docs/evidence/tampered-signature.sig", sha256: digest(tamperedSignatureBytes) }, subjectSha256: reportDigest, issuer: "protected-ci-identity", protectedIdentityRef: "https://identity.example/protected-ci", verificationRef: "https://verify.example/attestation/1" };
    records["exceptions.json"].launchApproval = { status: "approved", approvedBy: "release-owner", approvedAt: now, expiresAt: "2026-07-20", evidenceRef: "https://approvals.example/41", attestationSha256: digest(tamperedSignatureBytes), protectedIdentityRef: "https://identity.example/protected-ci" };
  });
  assert.equal(run(tamperedSignature, "--trusted-public-key", trustedPublicKey).status, 1, "tampered signature bytes must fail verification");
  const selfAttested = makeRecords("self-attested", (records) => {
    for (const value of Object.values(records)) { value.auditStatus = "audited"; value.statement = statusStatements.audited; }
    records["findings.json"].auditor = "same-person";
    records["findings.json"].report = { path: "docs/evidence/report.pdf", sha256: reportDigest };
    records["findings.json"].attestation = { mechanism: "detached-signature", artifact: { path: "docs/evidence/report.sig", sha256: signatureDigest }, subjectSha256: reportDigest, issuer: "same-person", protectedIdentityRef: "file://self", verificationRef: "file://self" };
    records["exceptions.json"].launchApproval = { status: "approved", approvedBy: "same-person", approvedAt: now, expiresAt: "2026-07-20", evidenceRef: "file://self", attestationSha256: signatureDigest, protectedIdentityRef: "file://self" };
  });
  assert.equal(run(selfAttested).status, 1, "self-attestation and local identity references must fail");

  for (const file of ["scope.json", "findings.json", "exceptions.json"]) {
    fs.copyFileSync(path.join(audited, file), path.join(recordDir, file));
  }
  write("docs/evidence/report.pdf", "report changed after candidate commit\n");
  write("docs/evidence/report.sig", "signature changed after candidate commit\n");
  command("git", ["add", "docs/wave-2/audit", "docs/evidence"]);
  command("git", ["commit", "-qm", "later audited records and evidence changes"]);
  const outputD = path.join(temp, "bundle-d");
  const candidatePinned = buildBundle({ root, output: outputD, now, trustedPublicKey });
  assert.notEqual(candidatePinned.manifest.recordsCommit, candidateCommit, "records may come from a later records commit");
  for (const [artifactPath, expectedBytes, expectedDigest] of [
    ["docs/evidence/report.pdf", reportBytes, reportDigest],
    ["docs/evidence/report.sig", signatureBytes, signatureDigest]
  ]) {
    assert.deepEqual(fs.readFileSync(path.join(outputD, "files", artifactPath)), Buffer.from(expectedBytes), `${artifactPath} must be bundled from candidateCommit`);
    assert.equal(candidatePinned.manifest.files.find((entry) => entry.path === artifactPath)?.sha256, expectedDigest, `${artifactPath} manifest digest must match the validated candidate`);
  }

  console.log("Audit readiness validator and bundle builder adversarial tests passed.");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
