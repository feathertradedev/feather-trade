#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const monitoringRoot = path.join(repoRoot, "infra", "monitoring");
const templatePath = path.join(monitoringRoot, "tabletop-evidence.template.json");
const requiredRoles = ["release-operator", "rpc-owner", "indexer-owner", "security-reviewer"];
const validResults = new Set(["pass", "fail", "blocked"]);
const validSeverities = new Set(["critical", "high", "medium", "low"]);
const commitPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

main();

function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const allowTemplate = args.includes("--allow-template");
  const optionValue = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const commitMode = optionValue("--commit-mode") || "current";
  const candidateCommit = optionValue("--candidate-commit");
  const maxAgeDays = Number(optionValue("--max-age-days") || 30);
  const now = optionValue("--now") ? Date.parse(optionValue("--now")) : Date.now();
  const valueOptions = new Set(["--commit-mode", "--candidate-commit", "--max-age-days", "--now"]);
  const positional = args.filter((arg, index) => arg !== "--allow-template" && !valueOptions.has(arg) && !valueOptions.has(args[index - 1]));
  const evidencePath = path.resolve(repoRoot, positional[0] || templatePath);
  const errors = [];

  const monitors = readJson(path.join(monitoringRoot, "monitors.json"), errors);
  const dashboards = readJson(path.join(monitoringRoot, "dashboards.json"), errors);
  const routing = readJson(path.join(monitoringRoot, "alert-routing.example.json"), errors);
  const evidence = readJson(evidencePath, errors);

  if (monitors) validateMonitors(monitors, errors);
  if (dashboards) validateDashboards(dashboards, errors);
  if (routing) validateRouting(routing, errors);
  if (evidence) validateEvidence(evidence, monitors, { allowTemplate, commitMode, candidateCommit, maxAgeDays, now }, errors);

  const report = {
    ok: errors.length === 0,
    evidencePath: path.relative(repoRoot, evidencePath),
    templateMode: allowTemplate,
    commitMode,
    errors
  };
  console.log(JSON.stringify(report, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

function readJson(filePath, errors) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${path.relative(repoRoot, filePath)}: ${error.message}`);
    return null;
  }
}

function validateMonitors(value, errors) {
  expect(value.schemaVersion === "robinhood.observability.monitors.v1", "monitors: unsupported schemaVersion", errors);
  expect(Array.isArray(value.monitors) && value.monitors.length >= 8, "monitors: at least eight monitors are required", errors);
  const ids = new Set();
  for (const monitor of value.monitors || []) {
    expect(nonempty(monitor.id), "monitors: every monitor needs an id", errors);
    expect(!ids.has(monitor.id), `monitors: duplicate id ${monitor.id}`, errors);
    ids.add(monitor.id);
    for (const field of ["surface", "signal", "condition", "owner", "runbook"]) {
      expect(nonempty(monitor[field]), `monitors: ${monitor.id || "unknown"} needs ${field}`, errors);
    }
    expect(validSeverities.has(monitor.severity), `monitors: ${monitor.id || "unknown"} has invalid severity`, errors);
  }
}

function validateDashboards(value, errors) {
  expect(value.schemaVersion === "robinhood.observability.dashboards.v1", "dashboards: unsupported schemaVersion", errors);
  expect(Array.isArray(value.dashboards) && value.dashboards.length >= 4, "dashboards: at least four dashboards are required", errors);
  for (const dashboard of value.dashboards || []) {
    expect(nonempty(dashboard.id) && nonempty(dashboard.owner), "dashboards: id and owner are required", errors);
    expect(Array.isArray(dashboard.panels) && dashboard.panels.length >= 4, `dashboards: ${dashboard.id || "unknown"} needs at least four panels`, errors);
  }
}

function validateRouting(value, errors) {
  expect(value.schemaVersion === "robinhood.observability.alert-routing.v1", "routing: unsupported schemaVersion", errors);
  expect(Number.isInteger(value.policy?.criticalAcknowledgeMinutes) && value.policy.criticalAcknowledgeMinutes > 0, "routing: positive critical acknowledgement threshold required", errors);
  const owners = new Set((value.routes || []).map((route) => route.owner));
  for (const role of requiredRoles) expect(owners.has(role), `routing: missing ${role}`, errors);
  for (const route of value.routes || []) {
    expect(nonempty(route.destinationRef) && nonempty(route.escalatesTo), `routing: ${route.owner || "unknown"} route is incomplete`, errors);
  }
  rejectSensitive(value, "routing", errors);
}

function validateEvidence(value, monitors, options, errors) {
  expect(value.schemaVersion === "robinhood.observability.tabletop-evidence.v1", "evidence: unsupported schemaVersion", errors);
  rejectSensitive(value, "evidence", errors);

  const serialized = JSON.stringify(value);
  const hasPlaceholders = /REPLACE_[A-Z0-9_]+/.test(serialized);
  if (options.allowTemplate) {
    expect(value.result === "not-run", "evidence template: result must be not-run", errors);
    expect(hasPlaceholders, "evidence template: expected replacement placeholders", errors);
  }

  if (!options.allowTemplate) expect(!hasPlaceholders, "evidence: unresolved REPLACE_* placeholder", errors);
  expect(nonempty(value.exerciseId), "evidence: exerciseId is required", errors);
  expect(["staging", "testnet", "mainnet-candidate"].includes(value.environment), "evidence: invalid environment", errors);
  expect(validResults.has(value.result) || (options.allowTemplate && value.result === "not-run"), "evidence: result must be pass, fail, blocked, or template not-run", errors);
  expect(nonempty(value.scenario) && nonempty(value.incidentCommander), "evidence: scenario and incidentCommander are required", errors);
  validateReleaseBinding(value.release, value.environment, options, errors, options.allowTemplate);

  const startedAt = timestamp(value.startedAt, "startedAt", errors, options.allowTemplate);
  const endedAt = timestamp(value.endedAt, "endedAt", errors, options.allowTemplate);
  expect(!startedAt || !endedAt || endedAt >= startedAt, "evidence: endedAt must not precede startedAt", errors);
  expect(!endedAt || endedAt <= options.now + 5 * 60 * 1000, "evidence: endedAt must not be in the future", errors);
  expect(Number.isFinite(options.maxAgeDays) && options.maxAgeDays > 0, "evidence: maxAgeDays must be positive", errors);
  expect(!endedAt || !Number.isFinite(options.maxAgeDays) || endedAt >= options.now - options.maxAgeDays * 86400000, `evidence: endedAt is older than ${options.maxAgeDays} days`, errors);

  const alert = value.syntheticAlert || {};
  const monitorIds = new Set((monitors?.monitors || []).map((monitor) => monitor.id));
  expect(monitorIds.has(alert.monitorId), "evidence: syntheticAlert.monitorId is not in monitors.json", errors);
  expect(validSeverities.has(alert.severity), "evidence: invalid synthetic alert severity", errors);
  const firedAt = timestamp(alert.firedAt, "syntheticAlert.firedAt", errors, options.allowTemplate);
  const acknowledgedAt = timestamp(alert.acknowledgedAt, "syntheticAlert.acknowledgedAt", errors, options.allowTemplate);
  expect(!firedAt || !acknowledgedAt || acknowledgedAt >= firedAt, "evidence: alert acknowledgement precedes firing", errors);
  expect(nonempty(alert.acknowledgedBy) && nonempty(alert.routeRef), "evidence: alert acknowledgement and route reference are required", errors);

  const responderMap = new Map((value.responders || []).map((entry) => [entry.role, entry]));
  for (const role of requiredRoles) {
    const responder = responderMap.get(role);
    expect(Boolean(responder), `evidence: missing responder role ${role}`, errors);
    expect(typeof responder?.acknowledged === "boolean", `evidence: ${role}.acknowledged must be boolean`, errors);
    if (!options.allowTemplate) expect(responder?.acknowledged === true, `evidence: ${role} must acknowledge its role`, errors);
  }
  expect(Array.isArray(value.timeline) && value.timeline.length >= (options.allowTemplate ? 1 : 2), `evidence: timeline needs at least ${options.allowTemplate ? "one" : "two"} entries`, errors);
  for (const entry of value.timeline || []) {
    timestamp(entry.at, "timeline.at", errors, options.allowTemplate);
    expect(nonempty(entry.actor) && nonempty(entry.action), "evidence: timeline entries require actor and action", errors);
  }
  expect(Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0 && value.evidenceRefs.every(nonempty), "evidence: at least one evidence reference is required", errors);
  expect(Array.isArray(value.unresolvedBlockers), "evidence: unresolvedBlockers must be an array", errors);
  expect(Array.isArray(value.followUpRefs), "evidence: followUpRefs must be an array", errors);
  expect(value.result !== "pass" || value.unresolvedBlockers.length === 0, "evidence: passing exercise cannot have unresolved blockers", errors);
}

function validateReleaseBinding(release, environment, options, errors, allowTemplate) {
  const templateCommit = allowTemplate && /^REPLACE_[A-Z0-9_]+$/.test(release?.repositoryCommit || "");
  const templateHash = allowTemplate && /^REPLACE_[A-Z0-9_]+$/.test(release?.manifestSha256 || "");
  expect(commitPattern.test(release?.repositoryCommit || "") || templateCommit, "evidence: release.repositoryCommit must be a lowercase Git commit", errors);
  expect(sha256Pattern.test(release?.manifestSha256 || "") || templateHash, "evidence: release.manifestSha256 must be a lowercase SHA-256 digest", errors);
  expect(Number.isSafeInteger(release?.chainId) && release.chainId > 0, "evidence: release.chainId must be a positive integer", errors);
  if (environment === "testnet") expect(release?.chainId === 46630, "evidence: testnet release.chainId must be 46630", errors);
  if (environment === "mainnet-candidate") expect(release?.chainId === 4663, "evidence: mainnet-candidate release.chainId must be 4663", errors);
  if (!commitPattern.test(release?.repositoryCommit || "")) return;

  const object = childProcess.spawnSync("git", ["cat-file", "-e", `${release.repositoryCommit}^{commit}`], { cwd: repoRoot });
  expect(object.status === 0, "evidence: release.repositoryCommit must identify a commit in this repository", errors);
  expect(["current", "candidate", "development"].includes(options.commitMode), `evidence: unsupported commit mode ${options.commitMode}`, errors);
  if (options.commitMode === "current") {
    const head = childProcess.spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
    expect(head.status === 0 && head.stdout.trim() === release.repositoryCommit, "evidence: release.repositoryCommit must match current HEAD", errors);
  }
  if (options.commitMode === "candidate") {
    expect(commitPattern.test(options.candidateCommit || ""), "evidence: candidate mode requires --candidate-commit", errors);
    expect(release.repositoryCommit === options.candidateCommit, "evidence: release.repositoryCommit must match --candidate-commit", errors);
  }
}

function rejectSensitive(value, label, errors) {
  const text = JSON.stringify(value);
  const patterns = [
    [/https?:\/\//i, "raw URL"],
    [/(api[_-]?key|secret|private[_-]?key|bearer\s+[a-z0-9])/i, "credential-like content"],
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "email address"],
    [/["'](?:phone|mobile|pager)["']\s*:|\+\d[\d ()-]{8,}\d/i, "phone-number-like content"]
  ];
  for (const [pattern, description] of patterns) expect(!pattern.test(text), `${label}: ${description} must not be committed`, errors);
}

function timestamp(value, field, errors, allowTemplate = false) {
  if (allowTemplate && /^REPLACE_[A-Z0-9_]+$/.test(value || "")) return null;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  expect(Number.isFinite(parsed), `evidence: ${field} must be an ISO-8601 timestamp`, errors);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function expect(condition, message, errors) {
  if (!condition) errors.push(message);
}
