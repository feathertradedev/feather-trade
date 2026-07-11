#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const defaultPacket = "docs/wave-2/evidence/testnet-launch-packet.json";
const requiredCoverage = [
  "manifest",
  "deployment",
  "contract-verification",
  "indexer",
  "smoke",
  "ownership",
  "rpc",
  "liquidity"
];
const requiredCheckBindings = Object.freeze({
  "deployment-manifest": { artifactId: "testnet-manifest", coverage: "deployment" },
  "contract-verification": { artifactId: "contract-verification", coverage: "contract-verification" },
  "indexer-sync-and-smoke": { artifactId: "goldsky-rehearsal", coverage: "indexer" },
  "transaction-smoke-path": { artifactId: "goldsky-rehearsal", coverage: "smoke" },
  "ownership-handoff": { artifactId: "goldsky-rehearsal", coverage: "ownership" },
  "rpc-readiness": { artifactId: "rpc-readiness", coverage: "rpc" },
  "pagination-rehearsal": { artifactId: "pagination-rehearsal", coverage: "liquidity" },
  "multibin-remove": { artifactId: "multibin-remove", coverage: "liquidity" },
  "multibin-remove-degraded-state": { artifactId: "multibin-remove", coverage: "liquidity", allowedStatuses: ["pass", "unproven"] }
});
const requiredChecks = Object.keys(requiredCheckBindings);
const sha256Pattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function git(root, args) {
  return childProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function validateRepositoryCommit(commit, options, root, errors) {
  const mode = options.commitMode || "ancestry";
  const expect = (condition, message) => { if (!condition) errors.push(message); };
  expect(["ancestry", "candidate", "development"].includes(mode), `unsupported commit mode: ${mode}`);
  if (!commitPattern.test(commit || "") || !["ancestry", "candidate", "development"].includes(mode)) return;

  const object = git(root, ["cat-file", "-e", `${commit}^{commit}`]);
  expect(object.status === 0, "release.repositoryCommit must identify a commit in this repository");
  if (mode === "ancestry") {
    const ancestor = git(root, ["merge-base", "--is-ancestor", commit, "HEAD"]);
    expect(ancestor.status === 0, "release.evidenceSourceCommit must be an ancestor of the current checkout");
  }
  if (mode === "candidate") {
    expect(commitPattern.test(options.candidateCommit || ""), "candidate mode requires candidateCommit");
    expect(commit === options.candidateCommit, "release.repositoryCommit must match candidateCommit in candidate mode");
  }
}

function validatePacket(packet, options = {}) {
  const root = path.resolve(options.root || repoRoot);
  const errors = [];
  const expect = (condition, message) => {
    if (!condition) errors.push(message);
  };

  expect(packet && typeof packet === "object" && !Array.isArray(packet), "packet must be a JSON object");
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return errors;

  expect(packet.schemaVersion === "robinhood.testnet.launch-packet.v1", "unsupported schemaVersion");
  expect(packet.issue === 55, "issue must be 55");
  expect(packet.chainId === 46630, "chainId must be 46630");
  expect(packet.environment === "testnet", "environment must be testnet");
  expect(commitPattern.test(packet.release?.repositoryCommit || ""), "release.repositoryCommit must be a 40-character lowercase commit");
  expect(commitPattern.test(packet.release?.evidenceSourceCommit || ""), "release.evidenceSourceCommit must be a 40-character lowercase commit");
  expect(packet.release?.repositoryCommit === packet.release?.evidenceSourceCommit, "release.repositoryCommit must match release.evidenceSourceCommit");
  validateRepositoryCommit(packet.release?.evidenceSourceCommit, options, root, errors);
  expect(commitPattern.test(packet.release?.sourceJoeV2Commit || ""), "release.sourceJoeV2Commit must be a 40-character lowercase commit");
  expect(typeof packet.manifest?.path === "string", "manifest.path is required");
  expect(sha256Pattern.test(packet.manifest?.sha256 || ""), "manifest.sha256 must be a lowercase SHA-256 digest");
  expect(Number.isSafeInteger(packet.manifest?.startBlock) && packet.manifest.startBlock > 0, "manifest.startBlock must be a positive integer");

  const artifacts = Array.isArray(packet.artifacts) ? packet.artifacts : [];
  expect(artifacts.length > 0, "artifacts must be a non-empty array");
  const ids = new Set();
  const coverage = new Set();

  for (const [index, artifact] of artifacts.entries()) {
    const label = `artifacts[${index}]`;
    expect(typeof artifact?.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(artifact.id), `${label}.id must be kebab-case`);
    if (ids.has(artifact?.id)) errors.push(`${label}.id is duplicated: ${artifact.id}`);
    ids.add(artifact?.id);
    expect(typeof artifact?.path === "string" && artifact.path.length > 0, `${label}.path is required`);
    expect(Array.isArray(artifact?.covers) && artifact.covers.length > 0, `${label}.covers must be a non-empty array`);
    for (const item of artifact?.covers || []) {
      expect(requiredCoverage.includes(item), `${label}.covers contains unsupported value: ${item}`);
      coverage.add(item);
    }
    expect(sha256Pattern.test(artifact?.sha256 || ""), `${label}.sha256 must be a lowercase SHA-256 digest`);
    expect(Number.isSafeInteger(artifact?.bytes) && artifact.bytes > 0, `${label}.bytes must be a positive integer`);

    if (typeof artifact?.path !== "string") continue;
    const absolutePath = path.resolve(root, artifact.path);
    const relative = path.relative(root, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      errors.push(`${label}.path escapes the repository root`);
      continue;
    }
    if (!fs.existsSync(absolutePath)) {
      errors.push(`${label}.path does not exist: ${artifact.path}`);
      continue;
    }
    const contents = fs.readFileSync(absolutePath);
    expect(contents.length === artifact.bytes, `${artifact.path} byte count is stale`);
    expect(sha256(contents) === artifact.sha256, `${artifact.path} SHA-256 is stale`);
  }

  for (const item of requiredCoverage) expect(coverage.has(item), `missing required evidence coverage: ${item}`);

  const checks = Array.isArray(packet.checks) ? packet.checks : [];
  expect(checks.length > 0, "checks must be a non-empty array");
  const checkIds = new Set();
  for (const [index, check] of checks.entries()) {
    const label = `checks[${index}]`;
    expect(typeof check?.id === "string" && check.id.length > 0, `${label}.id is required`);
    if (checkIds.has(check?.id)) errors.push(`${label}.id is duplicated: ${check.id}`);
    checkIds.add(check?.id);
    const binding = requiredCheckBindings[check?.id];
    const allowedStatuses = binding?.allowedStatuses || ["pass"];
    expect(allowedStatuses.includes(check?.status), `${label}.status must be ${allowedStatuses.join(" or ")}`);
    expect(typeof check?.evidence === "string" && ids.has(check.evidence), `${label}.evidence must reference an artifact id`);
  }
  for (const id of requiredChecks) expect(checkIds.has(id), `missing required check: ${id}`);
  for (const [id, binding] of Object.entries(requiredCheckBindings)) {
    const check = checks.find((item) => item?.id === id);
    const artifact = artifacts.find((item) => item?.id === binding.artifactId);
    expect(check?.evidence === binding.artifactId, `${id} must reference fixed artifact id: ${binding.artifactId}`);
    expect(Boolean(artifact), `${id} requires artifact id: ${binding.artifactId}`);
    expect(artifact?.covers?.includes(binding.coverage), `${binding.artifactId} must declare ${binding.coverage} semantics`);
  }

  const manifestArtifact = artifacts.find((artifact) => artifact.id === "testnet-manifest");
  expect(Boolean(manifestArtifact), "testnet-manifest artifact is required");
  if (manifestArtifact) {
    expect(manifestArtifact.path === packet.manifest?.path, "manifest.path must match the testnet-manifest artifact");
    expect(manifestArtifact.sha256 === packet.manifest?.sha256, "manifest.sha256 must match the testnet-manifest artifact");
    try {
      const manifest = JSON.parse(fs.readFileSync(path.resolve(root, manifestArtifact.path), "utf8"));
      expect(manifest.chainId === packet.chainId, "packet chainId does not match the manifest");
      expect(manifest.environment === packet.environment, "packet environment does not match the manifest");
      expect(manifest.startBlock === packet.manifest?.startBlock, "packet manifest.startBlock does not match the manifest");
      expect(manifest.sourceJoeV2Commit === packet.release?.sourceJoeV2Commit, "packet sourceJoeV2Commit does not match the manifest");
    } catch (error) {
      errors.push(`testnet manifest must be valid JSON: ${error.message}`);
    }
  }

  return errors;
}

function parseArgs(argv) {
  const args = { json: false, packet: defaultPacket, commitMode: "ancestry", candidateCommit: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") args.json = true;
    else if (argv[index] === "--packet") args.packet = argv[++index];
    else if (argv[index] === "--commit-mode") args.commitMode = argv[++index];
    else if (argv[index] === "--candidate-commit") args.candidateCommit = argv[++index];
    else if (!argv[index].startsWith("--") && args.packet === defaultPacket) args.packet = argv[index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!args.packet) throw new Error("--packet requires a path");
  return args;
}

function main() {
  let args;
  let errors = [];
  try {
    args = parseArgs(process.argv.slice(2));
    const packetPath = path.resolve(repoRoot, args.packet);
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    errors = validatePacket(packet, { root: repoRoot, commitMode: args.commitMode, candidateCommit: args.candidateCommit });
  } catch (error) {
    errors = [error.message];
  }

  if (args?.json) console.log(JSON.stringify({ ok: errors.length === 0, errors }, null, 2));
  else if (errors.length === 0) console.log(`Testnet launch packet is valid: ${args.packet}`);
  else for (const error of errors) console.error(`ERROR: ${error}`);
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (require.main === module) main();

module.exports = { requiredCheckBindings, requiredChecks, requiredCoverage, sha256, validatePacket };
