#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const zlib = require("node:zlib");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const custody = path.join(__dirname, "web-promotion-custody.cjs");
const evidence = path.join(__dirname, "write-web-promotion-evidence.cjs");
const commit = childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const temp = fs.mkdtempSync(path.join(root, ".local-web-promotion-test-"));

try {
  validateWorkflowContract();
  const dist = path.join(temp, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<script src=/assets/index-a.js></script>\n");
  fs.writeFileSync(path.join(dist, "assets/index-a.js"), "console.log('release')\n");
  const manifest = path.join(temp, "manifest.json");
  fs.writeFileSync(manifest, '{"environment":"testnet","chainId":46630}\n');
  const bundle = path.join(temp, "bundle");
  run(custody, ["create", "--environment", "testnet", "--commit", commit, "--manifest", relative(manifest), "--dist", relative(dist), "--output", relative(bundle)]);
  const extracted = path.join(temp, "extracted");
  run(custody, ["verify", "--environment", "testnet", "--commit", commit, "--bundle", relative(bundle), "--output", relative(extracted)]);
  assert.equal(fs.readFileSync(path.join(extracted, "dist/assets/index-a.js"), "utf8"), "console.log('release')\n");

  const evidenceDir = path.join(temp, "evidence");
  run(evidence, ["--environment", "testnet", "--commit", commit, "--custody", path.join(bundle, "custody.json"), "--deployed-url", "https://RELEASE.example:443/", "--output", evidenceDir, "--outcome", "promoted"]);
  const promotion = JSON.parse(fs.readFileSync(path.join(evidenceDir, "promotion.json"), "utf8"));
  assert.equal(promotion.deployedOrigin, "https://release.example");
  assert.equal(promotion.custodyStatus, "available");
  const readiness = JSON.parse(fs.readFileSync(path.join(evidenceDir, "rollback-readiness.json"), "utf8"));
  assert.equal(readiness.schemaVersion, "robinhood.web-rollback-readiness.v1");
  for (const executedField of ["providerOperationId", "operator", "approver", "executedAt", "smokeResult"]) {
    assert.equal(readiness[executedField], undefined, `readiness must not imply executed rollback via ${executedField}`);
  }

  const missingCustodyDir = path.join(temp, "missing-custody-evidence");
  run(evidence, ["--environment", "testnet", "--commit", commit, "--custody", path.join(temp, "absent.json"), "--deployed-url", "https://release.example", "--output", missingCustodyDir, "--outcome", "blocked"]);
  const blocked = JSON.parse(fs.readFileSync(path.join(missingCustodyDir, "promotion.json"), "utf8"));
  assert.equal(blocked.custodyStatus, "unavailable");
  assert.equal(blocked.artifactArchiveSha256, undefined);
  const malformedCustody = path.join(temp, "malformed-custody.json");
  fs.writeFileSync(malformedCustody, '{"repositoryCommit":"candidate-controlled"');
  run(evidence, ["--environment", "testnet", "--commit", commit, "--custody", malformedCustody, "--deployed-url", "https://release.example", "--output", missingCustodyDir, "--outcome", "failed"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(missingCustodyDir, "promotion.json"), "utf8")).custodyStatus, "unavailable");

  const githubOutput = path.join(temp, "github-output");
  run(evidence, ["--validate-url", "https://RELEASE.example:443/", "--github-output", githubOutput]);
  assert.equal(fs.readFileSync(githubOutput, "utf8"), "deployed_origin=https://release.example\n");
  for (const hostileUrl of [
    "http://release.example", "https://user:pass@release.example", "https://release.example/path",
    "https://release.example/?token=secret", "https://release.example/#fragment", " https://release.example"
  ]) {
    assert.notEqual(run(evidence, ["--validate-url", hostileUrl, "--github-output", githubOutput], false).status, 0, `must reject ${hostileUrl}`);
  }

  testAdversarialArchives(bundle, extracted);

  fs.appendFileSync(path.join(bundle, "web-promotion.tar.gz"), "tampered");
  assert.notEqual(run(custody, ["verify", "--environment", "testnet", "--commit", commit, "--bundle", relative(bundle), "--output", relative(extracted)], false).status, 0);
  assert.notEqual(childProcess.spawnSync("bash", [path.join(__dirname, "promote-web-provider.sh")], { cwd: root }).status, 0);
  console.log("web promotion custody and evidence tests passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function relative(value) { return path.relative(root, value); }

function validateWorkflowContract() {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/web-promotion.yml"), "utf8");
  for (const input of ["environment", "immutable_commit", "manifest", "deployed_url"]) {
    assert.match(workflow, new RegExp(`^      ${input}:`, "m"));
  }
  assert.match(workflow, /environment:\n      name: web-\$\{\{ inputs\.environment \}\}\n      url: \$\{\{ needs\.trusted-preflight\.outputs\.deployed_origin \}\}/);
  assert.equal((workflow.match(/pnpm web:build:public:/g) || []).length, 2, "only the environment branches may contain build commands");
  const approvalBoundary = workflow.indexOf("  promote:");
  const verify = workflow.indexOf("Verify custody without rebuilding");
  const adapter = workflow.indexOf("Invoke provider adapter");
  const smoke = workflow.indexOf("Smoke hosted release against sealed artifact");
  assert(approvalBoundary > 0 && approvalBoundary < verify && verify < adapter && adapter < smoke);
  assert.doesNotMatch(workflow.slice(approvalBoundary), /pnpm web:build|vite build/i);
  assert.doesNotMatch(workflow.slice(approvalBoundary), /ref: \$\{\{ inputs\.immutable_commit \}\}/);
  assert.match(workflow.slice(approvalBoundary), /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow.slice(approvalBoundary), /git rev-parse HEAD/);
  assert.equal((workflow.match(/fetch-depth: 0/g) || []).length, 2, "candidate and promotion checkouts must retain full history");
  assert.equal((workflow.match(/git merge-base --is-ancestor "\$IMMUTABLE_COMMIT" "\$TRUSTED_WORKFLOW_SHA"/g) || []).length, 2);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.event\.repository\.default_branch == 'main'/);
  assert.match(workflow, /github\.workflow_ref == format\(/);
  assert.match(workflow, /needs: \[trusted-preflight, build\]/);
  assert.match(workflow, /if: \$\{\{ always\(\) && needs\.trusted-preflight\.result == 'success' \}\}/);
  assert.match(workflow, /if-no-files-found: error/g);
  assert.doesNotMatch(workflow, /if-no-files-found: warn/);
  assert.doesNotMatch(workflow, /rollback\.json/);
  const custodySource = fs.readFileSync(custody, "utf8");
  assert.match(custodySource, /validateArchiveEntries\(archive\)/);
  assert.match(custodySource, /links and special files are forbidden/);
  assert.match(custodySource, /duplicate promotion archive path/);
  for (const action of workflow.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(action[1], /@[0-9a-f]{40}$/, `action must be pinned by SHA: ${action[1]}`);
  }
}

function testAdversarialArchives(bundle, extracted) {
  const fixtures = [
    ["traversal", [{ name: "../escape", type: "0", body: "x" }], /unexpected promotion archive path: \.\.\/escape/],
    ["absolute path", [{ name: "/tmp/escape", type: "0", body: "x" }], /unsafe promotion archive path: "\/tmp\/escape"/],
    ["symlink", [{ name: "dist/link", type: "2", link: "../../escape" }], /promotion archive links and special files are forbidden: dist\/link/],
    ["hardlink", [{ name: "dist/hard", type: "1", link: "manifest.json" }], /promotion archive links and special files are forbidden: dist\/hard/],
    ["special file", [{ name: "dist/fifo", type: "6" }], /promotion archive links and special files are forbidden: dist\/fifo/],
    ["duplicate entries", [{ name: "dist/file", type: "0", body: "a" }, { name: "dist/file", type: "0", body: "b" }], /duplicate promotion archive path: dist\/file/],
    ["unexpected roots", [{ name: "unexpected/file", type: "0", body: "x" }], /unexpected promotion archive path: unexpected\/file/]
  ];
  for (const [label, hostileEntries, rejection] of fixtures) {
    const fixtureBundle = path.join(path.dirname(bundle), `hostile-${label.replaceAll(" ", "-")}`);
    fs.mkdirSync(fixtureBundle);
    const metadata = {
      schemaVersion: "robinhood.web-promotion-custody.v1",
      environment: "testnet",
      repositoryCommit: commit,
      sourceManifest: "fixture.json",
      files: []
    };
    const entries = [
      { name: "custody.json", type: "0", body: JSON.stringify(metadata) },
      { name: "manifest.json", type: "0", body: "{}" },
      { name: "dist", type: "5" },
      ...hostileEntries
    ];
    const archive = zlib.gzipSync(makeTar(entries));
    const archivePath = path.join(fixtureBundle, "web-promotion.tar.gz");
    fs.writeFileSync(archivePath, archive);
    const envelope = {
      ...metadata,
      archiveSha256: crypto.createHash("sha256").update(archive).digest("hex"),
      archiveBytes: archive.length
    };
    fs.writeFileSync(path.join(fixtureBundle, "custody.json"), JSON.stringify(envelope));
    const result = run(custody, ["verify", "--environment", "testnet", "--commit", commit, "--bundle", relative(fixtureBundle), "--output", relative(extracted)], false);
    assert.notEqual(result.status, 0, `${label} archive must be rejected`);
    assert.match(`${result.stdout}\n${result.stderr}`, rejection, `${label} archive must reach its intended entry rejection`);
  }
}

function makeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body || "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    writeOctal(header, 100, 8, entry.type === "5" ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type || "0", 156, 1, "ascii");
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    writeOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 2, "0") + "\0 ";
  buffer.write(encoded, offset, length, "ascii");
}

function run(script, args, expectSuccess = true) {
  const result = childProcess.spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
  if (expectSuccess) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}
