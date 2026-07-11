#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const defaultRegisterPath = "docs/wave-2/static-analysis-triage.json";
const requiredScopeRoot = "contracts/joe-v2/src";
const requiredConfigPath = "contracts/joe-v2/slither.config.json";
const jsonMode = process.argv.includes("--json");
const printScopeHash = process.argv.includes("--print-scope-hash");
const registerPath = readRegisterPath(process.argv.slice(2));
const allowedSeverities = new Set(["critical", "high", "medium", "low", "informational"]);
const allowedConfidences = new Set(["high", "medium", "low", "unknown"]);
const allowedStatuses = new Set(["open", "accepted-risk", "remediated", "false-positive", "deferred", "untriaged"]);
const blockerSeverities = new Set(["critical", "high"]);

const report = validateRegister(registerPath);

if (printScopeHash) {
  console.log(report.scope.sha256);
} else if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`# Static Analysis Triage\n`);
  console.log(`Register: ${report.path}`);
  console.log(`Status: ${report.ok ? "pass" : "fail"}`);
  console.log(`Scope sha256: ${report.scope.sha256}`);
  console.log(`Findings: ${report.summary.total}`);
  for (const error of report.errors) console.log(`- error: ${error}`);
  for (const warning of report.warnings) console.log(`- warn: ${warning}`);
}

process.exitCode = report.ok ? 0 : 1;

function readRegisterPath(argv) {
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" || arg === "--json" || arg === "--print-scope-hash") continue;
    if (arg === "--register") {
      positional.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--register=")) {
      positional.push(arg.slice("--register=".length));
      continue;
    }
    if (!arg.startsWith("--")) positional.push(arg);
  }
  if (positional.length > 1) {
    throw new Error(`expected at most one register path, received ${positional.length}`);
  }
  return positional[0] || defaultRegisterPath;
}

function validateRegister(relativePath) {
  const errors = [];
  const warnings = [];
  const absolutePath = path.resolve(root, relativePath);
  const displayPath = path.relative(root, absolutePath);
  const ciSlitherVersion = readPinnedSlitherVersion();

  let register = null;
  try {
    register = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    errors.push(`${displayPath}: cannot read static-analysis triage register: ${error.message}`);
  }

  if (!register || typeof register !== "object") {
    return emptyReport(displayPath, errors, warnings, {
      files: [],
      sha256: null
    });
  }

  const scope = computeScope(requiredScopeRoot, requiredConfigPath, errors);

  if (register.schemaVersion !== "static-analysis-triage.v1") {
    errors.push(`${displayPath}.schemaVersion must be static-analysis-triage.v1`);
  }

  for (const key of ["tool", "toolVersion", "command", "configPath", "scopeRoot", "scopeSha256", "lastReviewedCommit", "reviewedAt", "reviewOwner"]) {
    requireText(register[key], `${displayPath}.${key}`, errors);
  }

  if (register.tool !== "slither") {
    errors.push(`${displayPath}.tool must be slither`);
  }
  if (register.scopeRoot !== requiredScopeRoot) {
    errors.push(`${displayPath}.scopeRoot must be ${requiredScopeRoot}`);
  }
  if (register.configPath !== requiredConfigPath) {
    errors.push(`${displayPath}.configPath must be ${requiredConfigPath}`);
  }
  if (ciSlitherVersion && register.toolVersion !== ciSlitherVersion) {
    errors.push(`${displayPath}.toolVersion ${register.toolVersion} must match CI slither-analyzer ${ciSlitherVersion}`);
  }
  if (scope.sha256 && register.scopeSha256 !== scope.sha256) {
    errors.push(`${displayPath}.scopeSha256 is stale; expected ${scope.sha256}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(String(register.lastReviewedCommit || ""))) {
    errors.push(`${displayPath}.lastReviewedCommit must be a 40-character git commit hash`);
  } else if (!commitExists(register.lastReviewedCommit)) {
    warnings.push(`${displayPath}.lastReviewedCommit ${register.lastReviewedCommit} is not available in this checkout`);
  }
  if (isPlaceholder(register.reviewOwner)) {
    errors.push(`${displayPath}.reviewOwner must not be a placeholder`);
  }

  const findings = Array.isArray(register.findings) ? register.findings : null;
  if (!findings) {
    errors.push(`${displayPath}.findings must be an array`);
  }

  const summary = {
    total: findings ? findings.length : 0,
    criticalHighOpen: 0,
    acceptedCriticalHigh: 0,
    untriaged: 0,
    deferred: 0
  };

  for (const [index, finding] of (findings ?? []).entries()) {
    validateFinding(finding, `${displayPath}.findings[${index}]`, errors, warnings, summary);
  }

  if ((findings ?? []).length === 0) {
    warnings.push(`${displayPath}: no accepted/open static-analysis risk exceptions are recorded; attach the latest Slither report in release evidence.`);
  }

  return {
    ok: errors.length === 0,
    path: displayPath,
    errors,
    warnings,
    scope,
    ciSlitherVersion,
    summary
  };
}

function validateFinding(finding, label, errors, warnings, summary) {
  if (!finding || typeof finding !== "object") {
    errors.push(`${label} must be an object`);
    return;
  }

  for (const key of [
    "id",
    "tool",
    "detector",
    "severity",
    "confidence",
    "status",
    "affectedContract",
    "sourcePath",
    "line",
    "title",
    "impact",
    "mitigation",
    "owner",
    "evidence",
    "followUp",
    "reviewedAt"
  ]) {
    if (key === "line") {
      if (!Number.isInteger(finding.line) || finding.line < 1) {
        errors.push(`${label}.line must be an integer >= 1`);
      }
    } else {
      requireText(finding[key], `${label}.${key}`, errors);
    }
  }

  if (!allowedSeverities.has(String(finding.severity))) {
    errors.push(`${label}.severity must be one of ${[...allowedSeverities].join(", ")}`);
  }
  if (!allowedConfidences.has(String(finding.confidence))) {
    errors.push(`${label}.confidence must be one of ${[...allowedConfidences].join(", ")}`);
  }
  if (!allowedStatuses.has(String(finding.status))) {
    errors.push(`${label}.status must be one of ${[...allowedStatuses].join(", ")}`);
  }
  if (finding.tool !== "slither") {
    errors.push(`${label}.tool must be slither`);
  }

  const sourcePath = path.resolve(root, String(finding.sourcePath || ""));
  if (finding.sourcePath && !sourcePath.startsWith(root)) {
    errors.push(`${label}.sourcePath must stay inside the repository`);
  } else if (finding.sourcePath && !fs.existsSync(sourcePath)) {
    errors.push(`${label}.sourcePath does not exist: ${finding.sourcePath}`);
  }

  for (const key of ["owner", "impact", "mitigation", "evidence", "followUp"]) {
    if (isPlaceholder(finding[key])) errors.push(`${label}.${key} must not be a placeholder`);
  }

  if (finding.status === "untriaged") {
    summary.untriaged += 1;
    errors.push(`${label} is untriaged`);
  }
  if (finding.status === "deferred") {
    summary.deferred += 1;
  }

  const isCriticalHigh = blockerSeverities.has(String(finding.severity));
  if (isCriticalHigh && finding.status === "open") {
    summary.criticalHighOpen += 1;
    errors.push(`${label} is ${finding.severity} and open; critical/high static-analysis findings block release`);
  }

  if (["accepted-risk", "false-positive", "deferred"].includes(finding.status)) {
    validateAcceptedRisk(finding.acceptedRisk, `${label}.acceptedRisk`, errors);
  }

  if (isCriticalHigh && finding.status === "accepted-risk") {
    summary.acceptedCriticalHigh += 1;
    validateCriticalHighAcceptedRisk(finding.acceptedRisk, `${label}.acceptedRisk`, errors);
  }

  if (!isCriticalHigh && finding.status === "open") {
    warnings.push(`${label} is open ${finding.severity}; ensure launch evidence includes owner, mitigation, and follow-up.`);
  }
}

function validateAcceptedRisk(acceptedRisk, label, errors) {
  if (!acceptedRisk || typeof acceptedRisk !== "object") {
    errors.push(`${label} is required for accepted-risk, false-positive, and deferred findings`);
    return;
  }
  for (const key of ["rationale", "acceptedBy", "acceptedDate", "reviewBy"]) {
    requireText(acceptedRisk[key], `${label}.${key}`, errors);
    if (isPlaceholder(acceptedRisk[key])) errors.push(`${label}.${key} must not be a placeholder`);
    if ((key === "acceptedDate" || key === "reviewBy") && typeof acceptedRisk[key] === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(acceptedRisk[key])) {
      errors.push(`${label}.${key} must use YYYY-MM-DD`);
    }
  }
}

function validateCriticalHighAcceptedRisk(acceptedRisk, label, errors) {
  if (!acceptedRisk || typeof acceptedRisk !== "object") return;
  for (const key of ["signedOffBy", "expiresAt"]) {
    requireText(acceptedRisk[key], `${label}.${key}`, errors);
    if (isPlaceholder(acceptedRisk[key])) errors.push(`${label}.${key} must not be a placeholder`);
  }
  if (typeof acceptedRisk.expiresAt === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(acceptedRisk.expiresAt)) {
    errors.push(`${label}.expiresAt must use YYYY-MM-DD`);
  }
}

function computeScope(scopeRoot, configPath, errors) {
  const files = [];
  if (typeof scopeRoot !== "string" || scopeRoot.trim() === "") {
    errors.push("scopeRoot must be a non-empty string before scope hashing can run");
  } else {
    const absoluteScopeRoot = path.resolve(root, scopeRoot);
    if (!absoluteScopeRoot.startsWith(root) || !fs.existsSync(absoluteScopeRoot)) {
      errors.push(`scopeRoot does not exist inside repository: ${scopeRoot}`);
    } else {
      files.push(...listSolidityFiles(absoluteScopeRoot));
    }
  }

  if (typeof configPath !== "string" || configPath.trim() === "") {
    errors.push("configPath must be a non-empty string before scope hashing can run");
  } else {
    const absoluteConfigPath = path.resolve(root, configPath);
    if (!absoluteConfigPath.startsWith(root) || !fs.existsSync(absoluteConfigPath)) {
      errors.push(`configPath does not exist inside repository: ${configPath}`);
    } else {
      files.push(absoluteConfigPath);
    }
  }

  const sortedFiles = [...new Set(files)].sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
  const hash = crypto.createHash("sha256");
  for (const file of sortedFiles) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }

  return {
    files: sortedFiles.map((file) => path.relative(root, file)),
    sha256: sortedFiles.length > 0 ? hash.digest("hex") : null
  };
}

function listSolidityFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSolidityFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".sol")) {
      files.push(absolutePath);
    }
  }
  return files;
}

function readPinnedSlitherVersion() {
  try {
    const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    return ci.match(/slither-analyzer==([0-9.]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function commitExists(commit) {
  const result = childProcess.spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
    cwd: root,
    stdio: "ignore"
  });
  return result.status === 0;
}

function requireText(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string`);
  }
}

function isPlaceholder(value) {
  return typeof value === "string" && /^(tbd|todo|n\/a|unknown|placeholder)$/i.test(value.trim());
}

function emptyReport(displayPath, errors, warnings, scope) {
  return {
    ok: false,
    path: displayPath,
    errors,
    warnings,
    scope,
    ciSlitherVersion: readPinnedSlitherVersion(),
    summary: {
      total: 0,
      criticalHighOpen: 0,
      acceptedCriticalHigh: 0,
      untriaged: 0,
      deferred: 0
    }
  };
}
