#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const validator = path.join(repoRoot, "scripts/release/validate-observability-evidence.cjs");
const repositoryCommit = childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const now = Date.parse("2026-07-10T18:00:00Z");

const validEvidence = {
  schemaVersion: "robinhood.observability.tabletop-evidence.v1",
  exerciseId: "obs-tabletop-2026-01",
  environment: "testnet",
  release: { repositoryCommit, manifestSha256: "a".repeat(64), chainId: 46630 },
  scenario: "indexer-stale-or-failed",
  startedAt: "2026-07-10T15:00:00Z",
  endedAt: "2026-07-10T15:20:00Z",
  result: "pass",
  incidentCommander: "release-lead",
  syntheticAlert: {
    monitorId: "indexer-sync",
    severity: "critical",
    firedAt: "2026-07-10T15:01:00Z",
    acknowledgedAt: "2026-07-10T15:05:00Z",
    acknowledgedBy: "indexer-oncall",
    routeRef: "evidence:alert-001"
  },
  responders: [
    { role: "release-operator", acknowledged: true },
    { role: "rpc-owner", acknowledged: true },
    { role: "indexer-owner", acknowledged: true },
    { role: "security-reviewer", acknowledged: true }
  ],
  timeline: [
    { at: "2026-07-10T15:01:00Z", actor: "monitor", action: "Synthetic alert fired" },
    { at: "2026-07-10T15:05:00Z", actor: "indexer-oncall", action: "Alert acknowledged and runbook opened" }
  ],
  evidenceRefs: ["artifact:launch-health-001", "ticket:incident-001"],
  unresolvedBlockers: [],
  followUpRefs: ["issue:capacity-threshold-review"],
  notes: "No-funds test alert rehearsal."
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "observability-evidence-"));
try {
  assert.equal(run(validEvidence).status, 0);
  assert.equal(run({ ...validEvidence, result: "pass", unresolvedBlockers: ["Indexer owner missing"] }).status, 1);
  assert.equal(run({ ...validEvidence, endedAt: "2026-07-10T14:00:00Z" }).status, 1);
  assert.equal(run({ ...validEvidence, endedAt: "2026-05-01T15:20:00Z" }).status, 1);
  assert.equal(run({ ...validEvidence, endedAt: "2026-07-11T15:20:00Z" }).status, 1);
  assert.equal(run({ ...validEvidence, release: { ...validEvidence.release, repositoryCommit: "f".repeat(40) } }).status, 1);
  assert.equal(run({ ...validEvidence, release: { ...validEvidence.release, chainId: 4663 } }).status, 1);
  assert.equal(run({ ...validEvidence, syntheticAlert: { ...validEvidence.syntheticAlert, monitorId: "unknown-monitor" } }).status, 1);
  assert.equal(run({ ...validEvidence, evidenceRefs: ["https://monitor.invalid/alert/1"] }).status, 1);
  assert.equal(run({ ...validEvidence, responders: validEvidence.responders.map((item) => item.role === "security-reviewer" ? { ...item, acknowledged: false } : item) }).status, 1);

  const template = childProcess.spawnSync(process.execPath, [validator, "infra/monitoring/tabletop-evidence.template.json", "--allow-template"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(template.status, 0, template.stdout + template.stderr);
  const invalidTemplate = JSON.parse(fs.readFileSync(path.join(repoRoot, "infra/monitoring/tabletop-evidence.template.json"), "utf8"));
  delete invalidTemplate.syntheticAlert.routeRef;
  assert.equal(runTemplate(invalidTemplate).status, 1, "template mode must enforce the full evidence shape");
  console.log("Observability evidence validator tests passed.");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function run(value) {
  const file = path.join(tempRoot, `${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const result = childProcess.spawnSync(process.execPath, [validator, file, "--commit-mode", "development", "--now", new Date(now).toISOString()], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 && !result.stdout) throw new Error(result.stderr);
  return result;
}

function runTemplate(value) {
  const file = path.join(tempRoot, `${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return childProcess.spawnSync(process.execPath, [validator, file, "--allow-template"], { cwd: repoRoot, encoding: "utf8" });
}
