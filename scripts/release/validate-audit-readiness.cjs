#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const defaultRecordDir = "docs/wave-2/audit";
const severities = new Set(["critical", "high", "medium", "low", "informational", "acknowledged-risk"]);
const findingStatuses = new Set(["open", "fixing", "fixed", "retesting", "accepted", "out-of-scope"]);
const attestationMechanisms = new Set(["detached-signature"]);
const prIntegrityBlockers = new Set(["external audit has not been completed", "launch approval is blocked"]);
const sha256Pattern = /^[0-9a-f]{64}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const statusStatements = Object.freeze({
  "not-audited": "External audit status: NOT AUDITED. This record is not an audit report or security approval.",
  audited: "External audit status: AUDITED. Validity requires the pinned report artifact and independently verifiable external attestation."
});

function git(root, args, encoding = "utf8") {
  return childProcess.spawnSync("git", args, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function gitOutput(root, args, label, encoding = "utf8") {
  const result = git(root, args, encoding);
  if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || `${label} failed`);
  return result.stdout;
}

function normalizeRepoPath(value, label = "path") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || /[\0-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty repository-relative POSIX path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || value.split("/").includes("..")) {
    throw new Error(`${label} is unsafe: ${value}`);
  }
  return value;
}

function candidateCommit(root, scope) {
  const commit = scope?.source?.candidateCommit;
  if (!/^[0-9a-f]{40}$/.test(commit || "")) throw new Error("scope.json: source.candidateCommit must be a lowercase 40-character commit");
  const resolved = gitOutput(root, ["rev-parse", "--verify", `${commit}^{commit}`], "git rev-parse").trim();
  if (resolved !== commit) throw new Error("scope.json: source.candidateCommit must identify a commit in this repository");
  return commit;
}

function committedFiles(root, commit) {
  return gitOutput(root, ["ls-tree", "-r", "--name-only", "-z", commit], "git ls-tree")
    .split("\0").filter(Boolean).sort();
}

function readCommittedFile(root, commit, relativePath) {
  normalizeRepoPath(relativePath, "committed file path");
  const listing = gitOutput(root, ["ls-tree", commit, "--", relativePath], `git ls-tree ${relativePath}`).trimEnd();
  const match = /^(100644|100755) blob [0-9a-f]{40}\t(.+)$/.exec(listing);
  if (!match || match[2] !== relativePath) throw new Error(`committed path is not a regular file: ${relativePath}`);
  return gitOutput(root, ["show", `${commit}:${relativePath}`], `git show ${relativePath}`, null);
}

function isWithin(file, entry) {
  return file === entry || file.startsWith(`${entry}/`);
}

function computeScope(root, scope) {
  const commit = candidateCommit(root, scope);
  const includes = (Array.isArray(scope.includedPaths) ? scope.includedPaths : []).map((item) => normalizeRepoPath(item, "scope path"));
  const excludes = (Array.isArray(scope.excludedPaths) ? scope.excludedPaths : []).map((item) => normalizeRepoPath(item, "scope path"));
  const files = committedFiles(root, commit).filter((file) => includes.some((entry) => isWithin(file, entry)) && !excludes.some((entry) => isWithin(file, entry)));
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readCommittedFile(root, commit, file)).update("\0");
  return { commit, files, sha256: hash.digest("hex") };
}

function readJson(file, errors) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { errors.push(`${path.basename(file)}: ${error.message}`); return {}; }
}

function validDate(value) { return datePattern.test(value || "") && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
function validTimestamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)); }
function isExpired(value, now) { return validDate(value) && !Number.isNaN(now.getTime()) && Date.parse(`${value}T23:59:59Z`) < now.getTime(); }

function validatePinnedArtifact(root, commit, artifact, label, expect) {
  expect(artifact && typeof artifact === "object", `${label} is required`);
  if (!artifact || typeof artifact !== "object") return;
  let artifactPath;
  try { artifactPath = normalizeRepoPath(artifact.path, `${label}.path`); }
  catch (error) { expect(false, error.message); return; }
  expect(sha256Pattern.test(artifact.sha256 || ""), `${label}.sha256 must be a lowercase SHA-256 digest`);
  try {
    const digest = crypto.createHash("sha256").update(readCommittedFile(root, commit, artifactPath)).digest("hex");
    expect(artifact.sha256 === digest, `${label}.sha256 does not match ${artifactPath} in candidateCommit`);
  } catch (_) { expect(false, `${label}.path must be a regular file committed in candidateCommit`); }
}

function verifyDetachedSignature(root, commit, report, attestation, trustedPublicKey, expect) {
  expect(typeof trustedPublicKey === "string" && trustedPublicKey.length > 0, "audited status requires --trusted-public-key or AUDIT_TRUSTED_PUBLIC_KEY");
  if (!trustedPublicKey || attestation?.mechanism !== "detached-signature" || !report?.path || !attestation?.artifact?.path) return;
  try {
    const publicKey = crypto.createPublicKey(fs.readFileSync(path.resolve(root, trustedPublicKey)));
    const algorithm = ["ed25519", "ed448"].includes(publicKey.asymmetricKeyType) ? null : "sha256";
    const reportBytes = readCommittedFile(root, commit, normalizeRepoPath(report.path, "findings.json: report.path"));
    const signatureBytes = readCommittedFile(root, commit, normalizeRepoPath(attestation.artifact.path, "findings.json: attestation.artifact.path"));
    expect(crypto.verify(algorithm, reportBytes, publicKey, signatureBytes), "findings.json: detached signature is not valid for the pinned report and trusted public key");
  } catch (error) {
    expect(false, `trusted public key or detached signature verification failed: ${error.message}`);
  }
}

function validateRecords(options = {}) {
  const root = path.resolve(options.root || repoRoot);
  const recordDir = path.resolve(root, options.recordDir || defaultRecordDir);
  const now = options.now ? new Date(options.now) : new Date();
  const errors = [];
  const blockers = [];
  const expect = (condition, message) => { if (!condition) errors.push(message); };
  expect(!Number.isNaN(now.getTime()), "--now must be an ISO date or timestamp");

  const scope = readJson(path.join(recordDir, "scope.json"), errors);
  const ledger = readJson(path.join(recordDir, "findings.json"), errors);
  const approvals = readJson(path.join(recordDir, "exceptions.json"), errors);
  expect(scope.schemaVersion === "robinhood.external-audit.scope.v1", "scope.json: unsupported schemaVersion");
  expect(ledger.schemaVersion === "robinhood.external-audit.findings.v1", "findings.json: unsupported schemaVersion");
  expect(approvals.schemaVersion === "robinhood.external-audit.exceptions.v1", "exceptions.json: unsupported schemaVersion");
  expect(scope.scopeId && scope.scopeId === ledger.scopeId && scope.scopeId === approvals.scopeId, "all records must use the same non-empty scopeId");
  for (const [name, record] of [["scope.json", scope], ["findings.json", ledger], ["exceptions.json", approvals]]) {
    expect(Object.hasOwn(statusStatements, record.auditStatus), `${name}: auditStatus must be not-audited or audited`);
    expect(record.statement === statusStatements[record.auditStatus], `${name}: statement must exactly match the canonical ${record.auditStatus || "unknown"} status statement`);
  }
  expect(scope.auditStatus === ledger.auditStatus && scope.auditStatus === approvals.auditStatus, "auditStatus must agree across all records");
  expect(Array.isArray(scope.includedPaths) && scope.includedPaths.length > 0, "scope.json: includedPaths must be non-empty");
  expect(Array.isArray(scope.excludedPaths), "scope.json: excludedPaths must be an array");
  for (const item of [...(scope.includedPaths || []), ...(scope.excludedPaths || [])]) {
    try { normalizeRepoPath(item, "scope.json path"); } catch (error) { expect(false, error.message); }
  }

  let computed = { commit: "", files: [], sha256: "" };
  try { computed = computeScope(root, scope); } catch (error) { errors.push(error.message); }
  expect(scope.inventory?.algorithm === "sha256-path-nul-content-nul-v1", "scope.json: unsupported inventory algorithm");
  expect(scope.inventory?.fileCount === computed.files.length, `scope drift: expected ${scope.inventory?.fileCount} files, found ${computed.files.length}`);
  expect(sha256Pattern.test(scope.inventory?.sha256 || ""), "scope.json: inventory.sha256 must be a lowercase SHA-256 digest");
  expect(scope.inventory?.sha256 === computed.sha256, `scope drift: expected ${scope.inventory?.sha256}, computed ${computed.sha256}`);

  const exceptions = Array.isArray(approvals.exceptions) ? approvals.exceptions : [];
  const exceptionById = new Map();
  expect(Array.isArray(approvals.exceptions), "exceptions.json: exceptions must be an array");
  for (const [index, item] of exceptions.entries()) {
    const label = `exceptions.json: exceptions[${index}]`;
    expect(idPattern.test(item?.id || ""), `${label}.id must be kebab-case`);
    expect(!exceptionById.has(item?.id), `${label}.id is duplicated`);
    exceptionById.set(item?.id, item);
    expect(typeof item?.owner === "string" && item.owner.length > 0, `${label}.owner is required`);
    expect(typeof item?.component === "string" && item.component.length > 0, `${label}.component is required`);
    expect(typeof item?.compensatingControl === "string" && item.compensatingControl.length > 0, `${label}.compensatingControl is required`);
    expect(validDate(item?.expiresAt), `${label}.expiresAt must be a valid YYYY-MM-DD date`);
    expect(item?.approval?.mainnet === true, `${label}.approval.mainnet must be true`);
    expect(typeof item?.approval?.approvedBy === "string" && item.approval.approvedBy.length > 0, `${label}.approval.approvedBy is required`);
    expect(validTimestamp(item?.approval?.approvedAt), `${label}.approval.approvedAt must be an ISO timestamp`);
    expect(typeof item?.approval?.evidenceRef === "string" && item.approval.evidenceRef.length > 0, `${label}.approval.evidenceRef is required`);
    if (isExpired(item?.expiresAt, now)) blockers.push(`exception expired: ${item.id}`);
  }

  const findings = Array.isArray(ledger.findings) ? ledger.findings : [];
  const findingIds = new Set();
  expect(Array.isArray(ledger.findings), "findings.json: findings must be an array");
  for (const [index, finding] of findings.entries()) {
    const label = `findings.json: findings[${index}]`;
    expect(idPattern.test(finding?.id || ""), `${label}.id must be kebab-case`);
    expect(!findingIds.has(finding?.id), `${label}.id is duplicated`);
    findingIds.add(finding?.id);
    expect(severities.has(finding?.severity), `${label}.severity is unsupported`);
    expect(findingStatuses.has(finding?.status), `${label}.status is unsupported`);
    expect(typeof finding?.component === "string" && finding.component.length > 0, `${label}.component is required`);
    expect(typeof finding?.owner === "string" && finding.owner.length > 0, `${label}.owner is required`);
    if (["fixed", "retesting"].includes(finding?.status)) expect(Array.isArray(finding.evidenceRefs) && finding.evidenceRefs.length > 0, `${label}.evidenceRefs is required for ${finding.status}`);
    if (finding?.status === "accepted") expect(exceptionById.has(finding.exceptionId), `${label}.exceptionId must reference an approved exception`);
    if (["critical", "high"].includes(finding?.severity) && !["fixed", "out-of-scope"].includes(finding?.status)) blockers.push(`unresolved ${finding.severity} finding: ${finding.id}`);
  }

  const attestation = ledger.attestation;
  if (scope.auditStatus === "not-audited") blockers.push("external audit has not been completed");
  if (scope.auditStatus === "audited") {
    expect(typeof ledger.auditor === "string" && ledger.auditor.length > 0, "findings.json: auditor is required when audited");
    validatePinnedArtifact(root, computed.commit, ledger.report, "findings.json: report", expect);
    validatePinnedArtifact(root, computed.commit, attestation?.artifact, "findings.json: attestation.artifact", expect);
    expect(attestationMechanisms.has(attestation?.mechanism), "findings.json: attestation.mechanism must be detached-signature");
    expect(sha256Pattern.test(attestation?.subjectSha256 || "") && attestation.subjectSha256 === ledger.report?.sha256, "findings.json: attestation.subjectSha256 must equal report.sha256");
    expect(typeof attestation?.issuer === "string" && attestation.issuer.length > 0 && attestation.issuer !== ledger.auditor, "findings.json: attestation.issuer must identify an external verifier distinct from the auditor");
    expect(typeof attestation?.protectedIdentityRef === "string" && /^https:\/\//.test(attestation.protectedIdentityRef), "findings.json: attestation.protectedIdentityRef must be an external HTTPS identity reference");
    expect(typeof attestation?.verificationRef === "string" && /^https:\/\//.test(attestation.verificationRef), "findings.json: attestation.verificationRef must be an external HTTPS verification reference");
    verifyDetachedSignature(root, computed.commit, ledger.report, attestation, options.trustedPublicKey, expect);
  }

  const launch = approvals.launchApproval || {};
  expect(["blocked", "approved"].includes(launch.status), "exceptions.json: launchApproval.status must be blocked or approved");
  if (launch.status === "approved") {
    expect(scope.auditStatus === "audited", "exceptions.json: launchApproval cannot be approved before audited status");
    expect(typeof launch.approvedBy === "string" && launch.approvedBy.length > 0, "exceptions.json: launchApproval.approvedBy is required");
    expect(validTimestamp(launch.approvedAt), "exceptions.json: launchApproval.approvedAt must be an ISO timestamp");
    expect(typeof launch.evidenceRef === "string" && /^https:\/\//.test(launch.evidenceRef), "exceptions.json: launchApproval.evidenceRef must be an external HTTPS reference");
    expect(validDate(launch.expiresAt), "exceptions.json: launchApproval.expiresAt must be a valid YYYY-MM-DD date");
    expect(launch.attestationSha256 === attestation?.artifact?.sha256, "exceptions.json: launchApproval.attestationSha256 must pin the external attestation artifact");
    expect(launch.protectedIdentityRef === attestation?.protectedIdentityRef, "exceptions.json: launchApproval.protectedIdentityRef must match the externally protected identity");
    expect(launch.approvedBy !== ledger.auditor && launch.approvedBy !== attestation?.issuer, "exceptions.json: launchApproval must not self-attest as auditor or attestation issuer");
    if (isExpired(launch.expiresAt, now)) blockers.push("launch approval expired");
  } else blockers.push("launch approval is blocked");
  return { errors, blockers, ready: errors.length === 0 && blockers.length === 0, scope: { commit: computed.commit, fileCount: computed.files.length, sha256: computed.sha256 } };
}

function parseArgs(argv) {
  const options = { allowNotAudited: false, prIntegrity: false, json: false, trustedPublicKey: process.env.AUDIT_TRUSTED_PUBLIC_KEY };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--allow-not-audited") options.allowNotAudited = true;
    else if (arg === "--pr-integrity" || arg === "--integrity-only") options.prIntegrity = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--record-dir") options.recordDir = argv[++i];
    else if (arg === "--root") options.root = argv[++i];
    else if (arg === "--now") options.now = argv[++i];
    else if (arg === "--trusted-public-key") options.trustedPublicKey = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = validateRecords(options);
    const effectiveBlockers = result.blockers.filter((blocker) =>
      !(options.allowNotAudited && blocker === "external audit has not been completed") &&
      !(options.prIntegrity && prIntegrityBlockers.has(blocker))
    );
    const failed = result.errors.length > 0 || effectiveBlockers.length > 0;
    if (options.json) console.log(JSON.stringify({ ...result, effectiveBlockers }, null, 2));
    else {
      for (const error of result.errors) console.error(`ERROR: ${error}`);
      for (const blocker of result.blockers) console.log(`BLOCKED: ${blocker}`);
      if (!failed) console.log(`Audit handoff integrity valid (${result.scope.fileCount} committed scoped files, status: ${result.ready ? "ready" : "not launch-approved"}).`);
    }
    process.exitCode = failed ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { computeScope, normalizeRepoPath, readCommittedFile, statusStatements, validateRecords };
