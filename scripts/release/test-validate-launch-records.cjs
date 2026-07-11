#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { canonicalDigest, readCandidateBlob, sha256, validatePacket, validateRecord } = require("./validate-launch-records.cjs");

const root = path.resolve(__dirname, "..", "..");
const now = new Date("2026-07-10T12:00:00Z");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launch-records-"));
fs.writeFileSync(path.join(temporaryRoot, "evidence.txt"), "verified evidence\n");
childProcess.execFileSync("git", ["init", "--quiet"], { cwd: temporaryRoot });
childProcess.execFileSync("git", ["add", "evidence.txt"], { cwd: temporaryRoot });
childProcess.execFileSync("git", ["-c", "user.name=Launch Test", "-c", "user.email=launch@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: temporaryRoot });
const commit = childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: temporaryRoot, encoding: "utf8" }).trim();
const evidence = { id: "proof", path: "evidence.txt", sha256: sha256(fs.readFileSync(path.join(temporaryRoot, "evidence.txt"))) };

function common(schemaVersion) {
  return {
    schemaVersion, recordStatus: "approved", environment: "mainnet", chainId: 4663,
    release: { repositoryCommit: commit, releaseId: "mainnet-2026-07-10" },
    approvedAt: "2026-07-10T11:00:00Z", expiresAt: "2026-07-11T11:00:00Z",
    evidence: [evidence], approvals: [{ role: "release", approver: "release-owner", decision: "approve", approvedAt: "2026-07-10T10:00:00Z" }]
  };
}

function rpc() {
  const record = common("robinhood.launch.rpc-provider-decision.v1");
  record.providers = ["primary", "fallback"].map((role, index) => ({
    role, provider: `provider-${index}`, accountOwner: `account-${index}`, sanitizedEndpointLabel: `${role}-robinhood`, failureDomain: `region-${index}`, supportTier: "production",
    quota: { requestsPerSecond: 100, monthlyRequests: 1000000, burst: "200 rps", backfillCapacity: "measured" },
    sla: { availability: "99.9%", supportChannel: "vendor portal", responseTarget: "one hour" },
    secretCustody: { system: "project vault", reference: `production/${role}`, owner: "operations", rotationTrigger: "suspected exposure" }
  }));
  record.archiveDecision = { status: "deferred", rationale: "fresh deployment", trigger: "retention exceeded", owner: "indexer" };
  record.failover = { owner: "operations", procedure: "RPC runbook section 4", rehearsedAt: "2026-07-09T12:00:00Z", evidence: "proof" };
  return record;
}

function admin() {
  const record = common("robinhood.launch.admin-control-decision.v1");
  record.multisig = { address: "0x1111111111111111111111111111111111111111", network: "Robinhood mainnet", platform: "Safe" };
  record.signers = [
    { id: "signer-a", organization: "org-a", custodyClass: "hardware-wallet" },
    { id: "signer-b", organization: "org-b", custodyClass: "hardware-wallet" },
    { id: "signer-c", organization: "org-c", custodyClass: "hardware-wallet" }
  ];
  record.threshold = 2;
  record.recovery = { owner: "security", procedure: "governance runbook section 3", testEvidence: "proof" };
  record.roles = [
    { role: "ownership-admin", account: record.multisig.address, authority: "factory administration", activation: "multisig-threshold" },
    { role: "fee-recipient", account: "0x2222222222222222222222222222222222222222", authority: "receive-protocol-fees", activation: "on-chain-transfer" },
    { role: "emergency-response", account: record.multisig.address, authority: "bounded incident actions", activation: "incident policy" }
  ];
  return record;
}

function goNoGo() {
  const record = common("robinhood.launch.go-no-go.v1");
  const lanes = ["release", "contracts", "security", "audit", "indexer", "frontend-sdk", "operations"];
  record.decision = "go";
  record.launchWindow = { startsAt: "2026-07-10T13:00:00Z", endsAt: "2026-07-11T10:00:00Z", watchOwner: "operations" };
  record.decisionRecords = {
    rpcProvider: { path: "records/rpc.json", sha256: "1".repeat(64) },
    adminControl: { path: "records/admin.json", sha256: "1".repeat(64) }
  };
  record.openBlockers = [];
  record.gates = lanes.map((lane) => ({ lane, status: "pass", evidence: "proof" }));
  record.approvals = lanes.map((role) => ({ role, approver: `${role}-owner`, decision: "approve", approvedAt: "2026-07-10T10:00:00Z" }));
  return record;
}

const options = { root: temporaryRoot, now, commitMode: "development" };
assert.deepEqual(validateRecord(rpc(), options), []);
assert.deepEqual(validateRecord(admin(), options), []);
assert.deepEqual(validateRecord(goNoGo(), options), []);

function packet() {
  const rpcRecord = rpc();
  const adminRecord = admin();
  const finalRecord = goNoGo();
  finalRecord.decisionRecords.rpcProvider.sha256 = canonicalDigest(rpcRecord);
  finalRecord.decisionRecords.adminControl.sha256 = canonicalDigest(adminRecord);
  return [
    { path: "records/final.json", record: finalRecord },
    { path: "records/rpc.json", record: rpcRecord },
    { path: "records/admin.json", record: adminRecord }
  ];
}

assert.deepEqual(validatePacket(packet(), options), []);

const substituted = packet();
substituted[1].record.providers[0].supportTier = "unapproved-tier";
assert(validatePacket(substituted, options).some((error) => error.includes("canonical digest")));

const mixedCommit = packet();
mixedCommit[2].record.release.repositoryCommit = "f".repeat(40);
assert(validatePacket(mixedCommit, options).some((error) => error.includes("same release.repositoryCommit")));

const mixedEnvironment = packet();
mixedEnvironment[1].record.environment = "testnet";
assert(validatePacket(mixedEnvironment, options).some((error) => error.includes("same environment")));

const expiredPacket = packet();
expiredPacket[1].record.expiresAt = "2026-07-10T11:30:00Z";
assert(validatePacket(expiredPacket, options).some((error) => error.includes("approved record is expired")));

assert(validatePacket(packet().slice(0, 2), options).includes("packet is missing admin control record"));
const noGo = goNoGo();
noGo.decision = "no-go";
noGo.gates[0].status = "fail";
noGo.openBlockers = ["Release artifact is not ready."];
assert.deepEqual(validateRecord(noGo, options), []);

const unsafeGo = goNoGo();
unsafeGo.gates[0].status = "fail";
assert(validateRecord(unsafeGo, options).includes("go decision requires release to pass"));

const missingBlockers = goNoGo();
delete missingBlockers.openBlockers;
assert(validateRecord(missingBlockers, options).includes("approved go decision requires openBlockers to be an empty array"));

const nonArrayBlockers = goNoGo();
nonArrayBlockers.openBlockers = "none";
assert(validateRecord(nonArrayBlockers, options).includes("approved go decision requires openBlockers to be an empty array"));

const duplicateGateLane = goNoGo();
duplicateGateLane.gates.push({ lane: "release", status: "pass", evidence: "proof" });
assert(validateRecord(duplicateGateLane, options).includes("gates[7].lane is duplicated: release"));

const approvedInTemplateMode = goNoGo();
assert(validateRecord(approvedInTemplateMode, { ...options, allowTemplate: true }).includes("--allow-template accepts only records with recordStatus template"));

const cliDirectory = path.join(temporaryRoot, "scripts", "release");
fs.mkdirSync(cliDirectory, { recursive: true });
const cliValidator = path.join(cliDirectory, "validate-launch-records.cjs");
fs.copyFileSync(path.join(root, "scripts", "release", "validate-launch-records.cjs"), cliValidator);
fs.writeFileSync(path.join(temporaryRoot, "approved-go.json"), `${JSON.stringify(goNoGo(), null, 2)}\n`);
const approvedTemplateMode = childProcess.spawnSync(process.execPath, [cliValidator, "--allow-template", "approved-go.json"], { cwd: temporaryRoot, encoding: "utf8" });
assert.notEqual(approvedTemplateMode.status, 0);
assert.match(approvedTemplateMode.stderr, /--allow-template accepts only records with recordStatus template/);

for (const name of ["final-go-no-go", "rpc-provider-decision", "admin-control-decision"]) {
  const template = JSON.parse(fs.readFileSync(path.join(root, `docs/wave-2/launch/${name}.template.json`), "utf8"));
  assert.deepEqual(validateRecord(template, { root, now, allowTemplate: true, commitMode: "development" }), []);
  assert(validateRecord(template, { root, now }).some((error) => error.includes("template is not approved launch evidence")));
}

const expired = rpc();
expired.expiresAt = "2026-07-10T11:30:00Z";
assert(validateRecord(expired, options).includes("approved record is expired"));

const future = rpc();
future.approvedAt = "2026-07-10T13:00:00Z";
assert(validateRecord(future, options).includes("approvedAt cannot be in the future"));

const wrongCommit = rpc();
assert(validateRecord(wrongCommit, { ...options, commitMode: "candidate", candidateCommit: "f".repeat(40) }).includes("release.repositoryCommit must match --candidate-commit in candidate mode"));
assert.deepEqual(validateRecord(rpc(), { ...options, commitMode: "candidate", candidateCommit: commit }), []);

const stale = rpc();
stale.evidence[0].sha256 = "f".repeat(64);
assert(validateRecord(stale, options).some((error) => error.includes("SHA-256 is stale")));

const escaping = rpc();
escaping.evidence[0].path = "../evidence.txt";
assert(validateRecord(escaping, options).includes("evidence[0].path must be a normalized repository-relative path"));

fs.symlinkSync("evidence.txt", path.join(temporaryRoot, "evidence-link.txt"));
const linked = rpc();
linked.evidence[0] = { ...linked.evidence[0], path: "evidence-link.txt" };
assert(validateRecord(linked, options).some((error) => error.includes("must not contain symlink components")));

fs.mkdirSync(path.join(temporaryRoot, "linked-target"));
fs.writeFileSync(path.join(temporaryRoot, "linked-target", "proof.txt"), "verified evidence\n");
fs.symlinkSync("linked-target", path.join(temporaryRoot, "linked-dir"));
const linkedDirectory = rpc();
linkedDirectory.evidence[0] = { ...linkedDirectory.evidence[0], path: "linked-dir/proof.txt" };
assert(validateRecord(linkedDirectory, options).some((error) => error.includes("must not contain symlink components")));

const coupled = rpc();
coupled.providers[1].failureDomain = coupled.providers[0].failureDomain;
assert(validateRecord(coupled, options).some((error) => error.includes("must use independent")));

const weakAdmin = admin();
weakAdmin.threshold = 1;
assert(validateRecord(weakAdmin, options).some((error) => error.includes("threshold must be at least two")));

const shortApproval = goNoGo();
shortApproval.expiresAt = "2026-07-10T14:00:00Z";
assert(validateRecord(shortApproval, options).includes("expiresAt must cover the complete launch window"));

const leaked = rpc();
leaked.providers[0].rpcUrl = "https://rpc.example.invalid/path?token=exposed";
assert(validateRecord(leaked, options).some((error) => error.includes("forbidden secret-bearing field")));

const incomplete = rpc();
incomplete.recordStatus = "incomplete";
assert(validateRecord(incomplete, options).includes("incomplete record is not approved launch evidence"));

fs.mkdirSync(path.join(temporaryRoot, "records"));
const committedPacket = packet();
for (const item of committedPacket) fs.writeFileSync(path.join(temporaryRoot, item.path), `${JSON.stringify(item.record, null, 2)}\n`);
childProcess.execFileSync("git", ["add", "records"], { cwd: temporaryRoot });
childProcess.execFileSync("git", ["-c", "user.name=Launch Test", "-c", "user.email=launch@example.invalid", "commit", "--quiet", "-m", "packet"], { cwd: temporaryRoot });
const candidateCommit = childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: temporaryRoot, encoding: "utf8" }).trim();

// Rebind and commit records to the actual candidate commit.
for (const item of committedPacket) item.record.release.repositoryCommit = candidateCommit;
committedPacket[0].record.decisionRecords.rpcProvider.sha256 = canonicalDigest(committedPacket[1].record);
committedPacket[0].record.decisionRecords.adminControl.sha256 = canonicalDigest(committedPacket[2].record);
for (const item of committedPacket) fs.writeFileSync(path.join(temporaryRoot, item.path), `${JSON.stringify(item.record, null, 2)}\n`);
childProcess.execFileSync("git", ["add", "records"], { cwd: temporaryRoot });
childProcess.execFileSync("git", ["-c", "user.name=Launch Test", "-c", "user.email=launch@example.invalid", "commit", "--amend", "--quiet", "--no-edit"], { cwd: temporaryRoot });
const finalCandidate = childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: temporaryRoot, encoding: "utf8" }).trim();
// An amended commit cannot self-reference its own hash; use an exact clean candidate fixture with an empty follow-up commit.
for (const item of committedPacket) item.record.release.repositoryCommit = finalCandidate;
committedPacket[0].record.decisionRecords.rpcProvider.sha256 = canonicalDigest(committedPacket[1].record);
committedPacket[0].record.decisionRecords.adminControl.sha256 = canonicalDigest(committedPacket[2].record);
for (const item of committedPacket) fs.writeFileSync(path.join(temporaryRoot, item.path), `${JSON.stringify(item.record, null, 2)}\n`);
childProcess.execFileSync("git", ["add", "records"], { cwd: temporaryRoot });
childProcess.execFileSync("git", ["-c", "user.name=Launch Test", "-c", "user.email=launch@example.invalid", "commit", "--quiet", "-m", "bound packet"], { cwd: temporaryRoot });
const evidenceCommit = childProcess.execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: temporaryRoot, encoding: "utf8" }).trim();
const candidateErrors = [];
const committedEvidence = readCandidateBlob(temporaryRoot, evidenceCommit, "evidence.txt", "evidence", candidateErrors);
assert.deepEqual(candidateErrors, []);
assert.equal(committedEvidence.toString(), "verified evidence\n");
fs.writeFileSync(path.join(temporaryRoot, "evidence.txt"), "tampered working tree\n");
assert.equal(readCandidateBlob(temporaryRoot, evidenceCommit, "evidence.txt", "evidence", []).toString(), "verified evidence\n");

fs.symlinkSync("evidence.txt", path.join(temporaryRoot, "git-link"));
childProcess.execFileSync("git", ["add", "git-link"], { cwd: temporaryRoot });
childProcess.execFileSync("git", ["-c", "user.name=Launch Test", "-c", "user.email=launch@example.invalid", "commit", "--quiet", "-m", "symlink fixture"], { cwd: temporaryRoot });
const symlinkCommit = childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: temporaryRoot, encoding: "utf8" }).trim();
const treeLinkErrors = [];
assert.equal(readCandidateBlob(temporaryRoot, symlinkCommit, "git-link", "evidence", treeLinkErrors), null);
assert(treeLinkErrors.some((error) => error.includes("must not contain symlink components")));

fs.rmSync(temporaryRoot, { recursive: true, force: true });
console.log("Launch record validator tests passed.");
