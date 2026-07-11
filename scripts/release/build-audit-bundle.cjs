#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { computeScope, normalizeRepoPath, readCommittedFile, statusStatements, validateRecords } = require("./validate-audit-readiness.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const recordPaths = ["docs/wave-2/audit/scope.json", "docs/wave-2/audit/findings.json", "docs/wave-2/audit/exceptions.json", "docs/wave-2/audit-readiness-package.md", "docs/wave-2/threat-model.md", "docs/provenance/joe-v2.md", "docs/provenance/dependency-license-report.md", "docs/provenance/license-exceptions.md"];
const secretPathPattern = /(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|id_(?:rsa|ed25519)(?:\.pub)?$|[^/]*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const secretContentPatterns = [/-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/, /\b(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE|API_KEY|ACCESS_TOKEN|CLIENT_SECRET)\s*[:=]\s*["']?\S{12,}/i, /\b(?:ghp|github_pat|sk_live|xox[baprs])-[_A-Za-z0-9-]{16,}\b/];
const credentialUrlPattern = /https?:\/\/[^\s/:]+:[^\s/@]+@[^\s"']+/g;

function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function git(root, args) { return childProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" }); }
function gitText(root, args) {
  const result = git(root, args);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}
function within(child, parent) { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."); }

function nearestExistingParent(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.realpathSync(current);
}

function safeOutput(root, requested) {
  const lexicalRoot = path.resolve(root);
  const realRoot = fs.realpathSync(lexicalRoot);
  const output = path.resolve(requested);
  const existingParent = nearestExistingParent(output);
  const localRoot = path.join(lexicalRoot, ".local");
  if (output === lexicalRoot || output === realRoot || within(lexicalRoot, output) || within(realRoot, output)) throw new Error("output must not equal or contain the repository");
  if (!within(output, lexicalRoot) && !within(output, realRoot) && within(existingParent, realRoot)) throw new Error("external output resolves into the repository");
  if (within(output, lexicalRoot) || within(output, realRoot)) {
    if (!within(output, localRoot) || output === localRoot) throw new Error("repository output is allowed only below ignored .local/");
    const relative = path.relative(lexicalRoot, output).split(path.sep).join("/");
    const ignored = git(realRoot, ["check-ignore", "-q", "--", relative]);
    if (ignored.status !== 0) throw new Error("repository output must be ignored by git under .local/");
    if (fs.existsSync(localRoot)) {
      const realLocalRoot = fs.realpathSync(localRoot);
      if (!within(existingParent, realLocalRoot)) throw new Error("output parent realpath escapes ignored .local/");
    } else if (existingParent !== realRoot) throw new Error("output parent realpath is unsafe");
  }
  if (fs.existsSync(output)) {
    const realOutput = fs.realpathSync(output);
    const realLocalRoot = fs.existsSync(localRoot) ? fs.realpathSync(localRoot) : localRoot;
    if (realOutput === realRoot || within(realRoot, realOutput) || ((within(output, lexicalRoot) || within(output, realRoot)) && !within(realOutput, realLocalRoot))) throw new Error("output realpath is unsafe");
  }
  return output;
}

function assertSafeContent(relativePath, content) {
  normalizeRepoPath(relativePath, "bundle input");
  if (secretPathPattern.test(relativePath)) throw new Error(`refusing secret-prone path: ${relativePath}`);
  const text = content.toString("utf8");
  for (const pattern of secretContentPatterns) if (pattern.test(text)) throw new Error(`possible credential in bundle input: ${relativePath}`);
  for (const match of text.matchAll(credentialUrlPattern)) {
    const hostname = new URL(match[0]).hostname;
    if (!hostname.endsWith(".example")) throw new Error(`possible credential in bundle input: ${relativePath}`);
  }
}

function buildBundle(options = {}) {
  const root = fs.realpathSync(path.resolve(options.root || repoRoot));
  const output = safeOutput(root, options.output || path.join(os.tmpdir(), "robinhood-wave-2-audit-bundle"));
  if (fs.existsSync(output)) {
    if (!options.force) throw new Error(`output already exists: ${output}`);
    safeOutput(root, output);
    fs.rmSync(output, { recursive: true, force: false });
  }
  const validation = validateRecords({ root, recordDir: options.recordDir, now: options.now, trustedPublicKey: options.trustedPublicKey || process.env.AUDIT_TRUSTED_PUBLIC_KEY });
  if (validation.errors.length > 0) throw new Error(`audit records are invalid:\n${validation.errors.join("\n")}`);
  const scope = JSON.parse(fs.readFileSync(path.join(root, options.recordDir || "docs/wave-2/audit", "scope.json"), "utf8"));
  const ledger = JSON.parse(fs.readFileSync(path.join(root, options.recordDir || "docs/wave-2/audit", "findings.json"), "utf8"));
  const computed = computeScope(root, scope);
  const recordsCommit = gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const evidencePaths = scope.auditStatus === "audited" ? [ledger.report?.path, ledger.attestation?.artifact?.path].filter(Boolean) : [];
  const files = [...new Set([...computed.files, ...recordPaths, ...evidencePaths])].sort();
  const entries = [];
  fs.mkdirSync(output, { recursive: true, mode: 0o755 });
  safeOutput(root, output);
  try {
    for (const relativePath of files) {
      const content = readCommittedFile(root, recordPaths.includes(relativePath) ? recordsCommit : computed.commit, relativePath);
      if (recordPaths.includes(relativePath) && relativePath.startsWith("docs/wave-2/audit/") && options.recordDir) {
        const workingRecord = fs.readFileSync(path.join(root, options.recordDir, path.basename(relativePath)));
        if (!workingRecord.equals(content)) throw new Error(`audit record differs from committed HEAD: ${relativePath}`);
      } else if (recordPaths.includes(relativePath)) {
        const workingRecord = fs.readFileSync(path.join(root, relativePath));
        if (!workingRecord.equals(content)) throw new Error(`audit record differs from committed HEAD: ${relativePath}`);
      }
      assertSafeContent(relativePath, content);
      const destination = path.join(output, "files", relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      fs.writeFileSync(destination, content, { mode: 0o644, flag: "wx" });
      fs.utimesSync(destination, 0, 0);
      entries.push({ path: relativePath, bytes: content.length, sha256: sha256(content) });
    }
    const manifest = { schemaVersion: "robinhood.external-audit.bundle-manifest.v1", auditStatus: scope.auditStatus, statement: statusStatements[scope.auditStatus], scopeId: scope.scopeId, candidateCommit: computed.commit, recordsCommit, scopeInventorySha256: scope.inventory.sha256, files: entries };
    const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(output, "manifest.json"), manifestContent, { mode: 0o644, flag: "wx" });
    fs.utimesSync(path.join(output, "manifest.json"), 0, 0);
    return { output, manifest, manifestSha256: sha256(manifestContent), blockers: validation.blockers };
  } catch (error) {
    safeOutput(root, output);
    fs.rmSync(output, { recursive: true, force: false });
    throw error;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output") options.output = argv[++i];
    else if (arg === "--record-dir") options.recordDir = argv[++i];
    else if (arg === "--root") options.root = argv[++i];
    else if (arg === "--now") options.now = argv[++i];
    else if (arg === "--trusted-public-key") options.trustedPublicKey = argv[++i];
    else if (arg === "--force") options.force = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const result = buildBundle(parseArgs(process.argv.slice(2)));
    console.log(`Audit bundle written to ${result.output}`);
    console.log(`Manifest SHA-256: ${result.manifestSha256}`);
    for (const blocker of result.blockers) console.log(`BLOCKED: ${blocker}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildBundle, safeOutput };
