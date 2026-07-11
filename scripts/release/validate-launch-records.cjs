#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const schemas = new Set([
  "robinhood.launch.go-no-go.v1",
  "robinhood.launch.rpc-provider-decision.v1",
  "robinhood.launch.admin-control-decision.v1"
]);
const commitPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const requiredGateLanes = ["release", "contracts", "security", "audit", "indexer", "frontend-sdk", "operations"];

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalDigest(value) {
  return sha256(canonicalJson(value));
}

function git(root, args) {
  return childProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function safeRelativePath(value, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} is required`);
    return null;
  }
  if (path.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    errors.push(`${label} must be a normalized repository-relative path`);
    return null;
  }
  return value;
}

function readCandidateBlob(root, commit, relativePath, label, errors) {
  const safePath = safeRelativePath(relativePath, label, errors);
  if (!safePath) return null;
  const parts = safePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const component = parts.slice(0, index + 1).join("/");
    const entry = git(root, ["ls-tree", commit, "--", component]);
    const match = entry.status === 0 ? entry.stdout.trim().match(/^(\d{6})\s+(\w+)\s+[0-9a-f]+\t/) : null;
    if (!match) {
      errors.push(`${label} does not exist in candidate commit: ${relativePath}`);
      return null;
    }
    const final = index === parts.length - 1;
    if (match[1] === "120000") {
      errors.push(`${label} must not contain symlink components: ${relativePath}`);
      return null;
    }
    if ((!final && match[2] !== "tree") || (final && match[2] !== "blob")) {
      errors.push(`${label} must identify a regular file in candidate commit: ${relativePath}`);
      return null;
    }
  }
  const result = childProcess.spawnSync("git", ["show", `${commit}:${safePath}`], { cwd: root });
  if (result.status !== 0) {
    errors.push(`${label} could not be read from candidate commit: ${relativePath}`);
    return null;
  }
  return result.stdout;
}

function readLocalFile(root, relativePath, label, errors) {
  const safePath = safeRelativePath(relativePath, label, errors);
  if (!safePath) return null;
  const realRoot = fs.realpathSync(root);
  let current = root;
  for (const component of safePath.split("/")) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); } catch {
      errors.push(`${label} does not exist: ${relativePath}`);
      return null;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`${label} must not contain symlink components: ${relativePath}`);
      return null;
    }
    const componentRelative = path.relative(realRoot, fs.realpathSync(current));
    if (componentRelative.startsWith("..") || path.isAbsolute(componentRelative)) {
      errors.push(`${label} resolves outside the repository root`);
      return null;
    }
  }
  if (!fs.lstatSync(current).isFile()) {
    errors.push(`${label} must identify a regular file: ${relativePath}`);
    return null;
  }
  const realFile = fs.realpathSync(current);
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    errors.push(`${label} resolves outside the repository root`);
    return null;
  }
  return fs.readFileSync(realFile);
}

function readRepositoryFile(options, relativePath, label, errors) {
  if (options.commitMode === "candidate") return readCandidateBlob(options.root, options.candidateCommit, relativePath, label, errors);
  return readLocalFile(options.root, relativePath, label, errors);
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function scanForPlaceholders(value, location, errors) {
  if (Array.isArray(value)) return value.forEach((item, index) => scanForPlaceholders(item, `${location}[${index}]`, errors));
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && (/^<.+>$/.test(value.trim()) || /^0+$/.test(value))) errors.push(`${location} contains an unresolved placeholder`);
    return;
  }
  for (const [key, item] of Object.entries(value)) scanForPlaceholders(item, `${location}.${key}`, errors);
}

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function scanForSecrets(value, location, errors) {
  if (Array.isArray(value)) return value.forEach((item, index) => scanForSecrets(item, `${location}[${index}]`, errors));
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return;
    if (/\b(?:https?|wss?):\/\/[^\s/]+\/[^\s]*(?:key|token|secret|auth)[^\s]*/i.test(value) ||
        /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:mnemonic|seed phrase|private key)\s*[:=])/i.test(value)) {
      errors.push(`${location} appears to contain secret material; use a sanitized label or secret reference`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:secret|token|apiKey|privateKey|mnemonic|seedPhrase|password|rpcUrl|endpointUrl)$/i.test(key)) {
      errors.push(`${location}.${key} is a forbidden secret-bearing field`);
    }
    scanForSecrets(item, `${location}.${key}`, errors);
  }
}

function validateCommit(record, options, errors) {
  const commit = record.release?.repositoryCommit;
  const mode = options.commitMode || "ancestry";
  if (!commitPattern.test(commit || "")) {
    errors.push("release.repositoryCommit must be a 40-character lowercase commit");
    return;
  }
  if (record.recordStatus !== "approved") return;
  if (!["ancestry", "candidate", "development"].includes(mode)) {
    errors.push(`unsupported commit mode: ${mode}`);
    return;
  }
  if (git(options.root, ["cat-file", "-e", `${commit}^{commit}`]).status !== 0) {
    errors.push("release.repositoryCommit must identify a commit in this repository");
  } else if (mode === "ancestry" && git(options.root, ["merge-base", "--is-ancestor", commit, "HEAD"]).status !== 0) {
    errors.push("release.repositoryCommit must be an ancestor of the current checkout");
  }
  if (mode === "candidate" && commit !== options.candidateCommit) {
    errors.push("release.repositoryCommit must match --candidate-commit in candidate mode");
  }
}

function validateEvidence(record, options, errors) {
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  if (record.recordStatus === "approved" && evidence.length === 0) errors.push("approved records require evidence");
  const ids = new Set();
  for (const [index, item] of evidence.entries()) {
    const label = `evidence[${index}]`;
    if (!idPattern.test(item?.id || "")) errors.push(`${label}.id must be kebab-case`);
    if (ids.has(item?.id)) errors.push(`${label}.id is duplicated: ${item.id}`);
    ids.add(item?.id);
    if (typeof item?.path !== "string" || item.path.length === 0) errors.push(`${label}.path is required`);
    if (!digestPattern.test(item?.sha256 || "")) errors.push(`${label}.sha256 must be a lowercase SHA-256 digest`);
    if (record.recordStatus !== "approved" || typeof item?.path !== "string") continue;
    const contents = readRepositoryFile(options, item.path, `${label}.path`, errors);
    if (contents && sha256(contents) !== item.sha256) {
      errors.push(`${item.path} SHA-256 is stale`);
    }
  }
  return ids;
}

function requireApproval(record, options, errors) {
  if (record.recordStatus !== "approved") return;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!validTimestamp(record.approvedAt)) errors.push("approvedAt must be an RFC 3339 UTC timestamp");
  if (!validTimestamp(record.expiresAt)) errors.push("expiresAt must be an RFC 3339 UTC timestamp");
  if (validTimestamp(record.approvedAt) && Date.parse(record.approvedAt) > now.getTime()) errors.push("approvedAt cannot be in the future");
  if (validTimestamp(record.expiresAt) && Date.parse(record.expiresAt) <= now.getTime()) errors.push("approved record is expired");
  if (validTimestamp(record.approvedAt) && validTimestamp(record.expiresAt) && Date.parse(record.expiresAt) <= Date.parse(record.approvedAt)) errors.push("expiresAt must be after approvedAt");
  const approvals = Array.isArray(record.approvals) ? record.approvals : [];
  if (approvals.length === 0) errors.push("approved records require approvals");
  for (const [index, approval] of approvals.entries()) {
    if (!isNonEmpty(approval?.role)) errors.push(`approvals[${index}].role is required`);
    if (!isNonEmpty(approval?.approver)) errors.push(`approvals[${index}].approver is required`);
    if (approval?.decision !== "approve") errors.push(`approvals[${index}].decision must be approve`);
    if (!validTimestamp(approval?.approvedAt)) errors.push(`approvals[${index}].approvedAt must be an RFC 3339 UTC timestamp`);
    if (validTimestamp(approval?.approvedAt) && validTimestamp(record.approvedAt) && Date.parse(approval.approvedAt) > Date.parse(record.approvedAt)) errors.push(`approvals[${index}].approvedAt cannot be after record approvedAt`);
  }
}

function requireFields(object, fields, prefix, errors) {
  for (const field of fields) if (!isNonEmpty(object?.[field])) errors.push(`${prefix}.${field} is required`);
}

function validateGoNoGo(record, evidenceIds, errors) {
  if (!["go", "no-go"].includes(record.decision)) errors.push("decision must be go or no-go");
  const checks = record.gates;
  const gatesByLane = new Map();
  if (!Array.isArray(checks)) {
    errors.push("gates must be an array");
  } else {
    for (const [index, gate] of checks.entries()) {
      const lane = gate?.lane;
      if (!requiredGateLanes.includes(lane)) {
        errors.push(`gates[${index}].lane must be a required gate lane`);
        continue;
      }
      if (gatesByLane.has(lane)) errors.push(`gates[${index}].lane is duplicated: ${lane}`);
      else gatesByLane.set(lane, gate);
    }
  }
  for (const lane of requiredGateLanes) {
    const gate = gatesByLane.get(lane);
    if (!gate) errors.push(`gates must include exactly one ${lane} entry`);
    else if (!["pass", "fail"].includes(gate.status) || !evidenceIds.has(gate.evidence)) errors.push(`gates must include valid ${lane} evidence`);
    else if (record.decision === "go" && gate.status !== "pass") errors.push(`go decision requires ${lane} to pass`);
  }
  if (record.recordStatus === "approved" && record.decision === "go" && (!Array.isArray(record.openBlockers) || record.openBlockers.length !== 0)) {
    errors.push("approved go decision requires openBlockers to be an empty array");
  }
  requireFields(record.launchWindow, ["startsAt", "endsAt", "watchOwner"], "launchWindow", errors);
  if (record.recordStatus === "approved") {
    if (!validTimestamp(record.launchWindow?.startsAt) || !validTimestamp(record.launchWindow?.endsAt)) errors.push("launchWindow timestamps must be RFC 3339 UTC timestamps");
    else {
      if (Date.parse(record.launchWindow.endsAt) <= Date.parse(record.launchWindow.startsAt)) errors.push("launchWindow.endsAt must be after launchWindow.startsAt");
      if (validTimestamp(record.expiresAt) && Date.parse(record.expiresAt) < Date.parse(record.launchWindow.endsAt)) errors.push("expiresAt must cover the complete launch window");
    }
    const approvalRoles = new Set((record.approvals || []).map((item) => item?.role));
    for (const lane of requiredGateLanes) if (!approvalRoles.has(lane)) errors.push(`approvals must include ${lane}`);
  }
  const refs = record.decisionRecords || {};
  for (const field of ["rpcProvider", "adminControl"]) {
    const ref = refs[field];
    if (!ref || typeof ref !== "object") errors.push(`decisionRecords.${field} must bind a launch record`);
    else {
      if (!isNonEmpty(ref.path)) errors.push(`decisionRecords.${field}.path is required`);
      if (!digestPattern.test(ref.sha256 || "")) errors.push(`decisionRecords.${field}.sha256 must be a lowercase canonical JSON SHA-256 digest`);
    }
  }
}

function validateRpc(record, evidenceIds, errors) {
  const providers = Array.isArray(record.providers) ? record.providers : [];
  for (const role of ["primary", "fallback"]) if (!providers.some((item) => item?.role === role)) errors.push(`providers must include ${role}`);
  for (const [index, provider] of providers.entries()) {
    const label = `providers[${index}]`;
    requireFields(provider, ["role", "provider", "accountOwner", "sanitizedEndpointLabel", "failureDomain", "supportTier"], label, errors);
    if (/[:/]\//.test(provider?.sanitizedEndpointLabel || "")) errors.push(`${label}.sanitizedEndpointLabel must not be a URL`);
    if (!(Number.isFinite(provider?.quota?.requestsPerSecond) && provider.quota.requestsPerSecond > 0)) errors.push(`${label}.quota.requestsPerSecond must be positive`);
    if (!(Number.isFinite(provider?.quota?.monthlyRequests) && provider.quota.monthlyRequests > 0)) errors.push(`${label}.quota.monthlyRequests must be positive`);
    requireFields(provider?.sla, ["availability", "supportChannel", "responseTarget"], `${label}.sla`, errors);
    requireFields(provider?.secretCustody, ["system", "reference", "owner", "rotationTrigger"], `${label}.secretCustody`, errors);
  }
  const primary = providers.find((item) => item?.role === "primary");
  const fallback = providers.find((item) => item?.role === "fallback");
  if (primary && fallback && (primary.provider === fallback.provider || primary.failureDomain === fallback.failureDomain || primary.accountOwner === fallback.accountOwner)) errors.push("primary and fallback must use independent provider, account owner, and failure domain");
  requireFields(record.failover, ["owner", "procedure", "rehearsedAt", "evidence"], "failover", errors);
  if (record.recordStatus === "approved" && !validTimestamp(record.failover?.rehearsedAt)) errors.push("failover.rehearsedAt must be an RFC 3339 UTC timestamp");
  if (record.failover?.evidence && !evidenceIds.has(record.failover.evidence)) errors.push("failover.evidence must reference evidence");
  if (!record.archiveDecision || !["required", "deferred"].includes(record.archiveDecision.status)) errors.push("archiveDecision.status must be required or deferred");
  requireFields(record.archiveDecision, ["rationale", "trigger", "owner"], "archiveDecision", errors);
}

function validateAdmin(record, evidenceIds, errors) {
  requireFields(record.multisig, ["address", "network", "platform"], "multisig", errors);
  if (!/^0x[0-9a-fA-F]{40}$/.test(record.multisig?.address || "")) errors.push("multisig.address must be a public EVM address");
  const signers = Array.isArray(record.signers) ? record.signers : [];
  if (signers.length < 2) errors.push("signers must contain at least two sanitized signer records");
  const signerIds = new Set();
  for (const [index, signer] of signers.entries()) requireFields(signer, ["id", "organization", "custodyClass"], `signers[${index}]`, errors);
  for (const signer of signers) {
    if (signerIds.has(signer?.id)) errors.push(`signer id is duplicated: ${signer.id}`);
    signerIds.add(signer?.id);
  }
  if (!Number.isSafeInteger(record.threshold) || record.threshold < 2 || record.threshold > signers.length) errors.push("threshold must be at least two and no greater than signer count");
  requireFields(record.recovery, ["owner", "procedure", "testEvidence"], "recovery", errors);
  if (record.recovery?.testEvidence && !evidenceIds.has(record.recovery.testEvidence)) errors.push("recovery.testEvidence must reference evidence");
  for (const role of ["ownership-admin", "fee-recipient", "emergency-response"]) {
    const item = record.roles?.find?.((entry) => entry?.role === role);
    if (!item) errors.push(`roles must include ${role}`);
    else requireFields(item, ["role", "account", "authority", "activation"], `roles.${role}`, errors);
  }
}

function validateRecord(record, options = {}) {
  const settings = { root: path.resolve(options.root || repoRoot), ...options };
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["record must be a JSON object"];
  if (!schemas.has(record.schemaVersion)) errors.push("unsupported schemaVersion");
  if (!["template", "incomplete", "approved"].includes(record.recordStatus)) errors.push("recordStatus must be template, incomplete, or approved");
  if (settings.allowTemplate && record.recordStatus !== "template") errors.push("--allow-template accepts only records with recordStatus template");
  if (record.recordStatus === "template" && !settings.allowTemplate) errors.push("template is not approved launch evidence; pass --allow-template only for template validation");
  if (record.recordStatus === "incomplete") errors.push("incomplete record is not approved launch evidence");
  if (record.environment !== "mainnet" || record.chainId !== 4663) errors.push("environment and chainId must identify Robinhood mainnet (4663)");
  scanForSecrets(record, "record", errors);
  if (record.recordStatus === "approved") scanForPlaceholders(record, "record", errors);
  validateCommit(record, settings, errors);
  const evidenceIds = validateEvidence(record, settings, errors);
  requireApproval(record, settings, errors);
  if (record.schemaVersion === "robinhood.launch.go-no-go.v1") validateGoNoGo(record, evidenceIds, errors);
  if (record.schemaVersion === "robinhood.launch.rpc-provider-decision.v1") validateRpc(record, evidenceIds, errors);
  if (record.schemaVersion === "robinhood.launch.admin-control-decision.v1") validateAdmin(record, evidenceIds, errors);
  return errors;
}

function validatePacket(records, options = {}) {
  const settings = { root: path.resolve(options.root || repoRoot), ...options };
  const errors = [];
  const expected = {
    "robinhood.launch.go-no-go.v1": "final go/no-go",
    "robinhood.launch.rpc-provider-decision.v1": "RPC provider",
    "robinhood.launch.admin-control-decision.v1": "admin control"
  };
  const bySchema = new Map();
  for (const item of records) {
    const schema = item.record?.schemaVersion;
    if (!expected[schema]) errors.push(`${item.path}: unsupported packet record schema`);
    else if (bySchema.has(schema)) errors.push(`packet contains duplicate ${expected[schema]} record`);
    else bySchema.set(schema, item);
    for (const error of validateRecord(item.record, settings)) errors.push(`${item.path}: ${error}`);
  }
  for (const [schema, label] of Object.entries(expected)) if (!bySchema.has(schema)) errors.push(`packet is missing ${label} record`);
  if (bySchema.size !== 3) return errors;
  const go = bySchema.get("robinhood.launch.go-no-go.v1");
  const rpc = bySchema.get("robinhood.launch.rpc-provider-decision.v1");
  const admin = bySchema.get("robinhood.launch.admin-control-decision.v1");
  const packetRecords = [go, rpc, admin];
  if (packetRecords.some((item) => item.record.recordStatus !== "approved")) errors.push("all three packet records must be approved launch evidence");
  for (const field of ["environment", "chainId"]) {
    if (packetRecords.some((item) => item.record[field] !== go.record[field])) errors.push(`all three packet records must use the same ${field}`);
  }
  for (const field of ["repositoryCommit", "releaseId"]) {
    if (packetRecords.some((item) => item.record.release?.[field] !== go.record.release?.[field])) errors.push(`all three packet records must use the same release.${field}`);
  }
  for (const [field, item] of [["rpcProvider", rpc], ["adminControl", admin]]) {
    const binding = go.record.decisionRecords?.[field];
    if (binding?.path !== item.path) errors.push(`final go/no-go decisionRecords.${field}.path must identify the supplied ${expected[item.record.schemaVersion]} record`);
    if (binding?.sha256 !== canonicalDigest(item.record)) errors.push(`final go/no-go decisionRecords.${field}.sha256 does not match the supplied record canonical digest`);
  }
  return errors;
}

function parseArgs(argv) {
  const args = { paths: [], allowTemplate: false, commitMode: "ancestry" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--allow-template") args.allowTemplate = true;
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--commit-mode") args.commitMode = argv[++i];
    else if (argv[i] === "--candidate-commit") args.candidateCommit = argv[++i];
    else if (argv[i].startsWith("--")) throw new Error(`unknown argument: ${argv[i]}`);
    else args.paths.push(argv[i]);
  }
  if (args.paths.length === 0) throw new Error("provide at least one launch record path");
  if (args.commitMode === "candidate" && !commitPattern.test(args.candidateCommit || "")) throw new Error("candidate mode requires --candidate-commit with a 40-character lowercase commit");
  return args;
}

function main() {
  let args;
  const results = [];
  try {
    args = parseArgs(process.argv.slice(2));
    const records = args.paths.map((recordPath) => {
      const readErrors = [];
      const contents = readLocalFile(repoRoot, recordPath, "record path", readErrors);
      if (readErrors.length > 0) throw new Error(readErrors.join("; "));
      return { path: recordPath, record: JSON.parse(contents.toString("utf8")) };
    });
    const packetErrors = args.allowTemplate ? records.flatMap((item) => validateRecord(item.record, { ...args, root: repoRoot }).map((error) => `${item.path}: ${error}`)) : validatePacket(records, { ...args, root: repoRoot });
    results.push({ path: args.allowTemplate ? "templates" : "launch packet", errors: packetErrors });
  } catch (error) {
    results.push({ path: null, errors: [error.message] });
  }
  const ok = results.every((result) => result.errors.length === 0);
  if (args?.json) console.log(JSON.stringify({ ok, results }, null, 2));
  else for (const result of results) {
    if (result.errors.length === 0) console.log(args.allowTemplate ? "Launch record templates are structure-valid; they are not approved launch evidence." : "Approved three-record launch packet is valid.");
    else result.errors.forEach((error) => console.error(`ERROR ${result.path || "arguments"}: ${error}`));
  }
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) main();
module.exports = { canonicalDigest, canonicalJson, readCandidateBlob, validatePacket, sha256, validateRecord };
