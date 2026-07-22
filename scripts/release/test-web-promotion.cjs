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
const providerAdapter = path.join(__dirname, "promote-web-provider.sh");
const remoteAdapter = path.join(__dirname, "promote-web-vps-remote.sh");
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
  testVpsPromotionAdapter({ bundle, extracted });

  fs.appendFileSync(path.join(bundle, "web-promotion.tar.gz"), "tampered");
  assert.notEqual(run(custody, ["verify", "--environment", "testnet", "--commit", commit, "--bundle", relative(bundle), "--output", relative(extracted)], false).status, 0);
  assert.notEqual(childProcess.spawnSync("bash", [providerAdapter], { cwd: root }).status, 0);
  console.log("web promotion custody and evidence tests passed");
} finally {
  childProcess.spawnSync("chmod", ["-R", "u+w", temp]);
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
  assert.match(workflow, /DEPLOYED_ORIGIN: \$\{\{ needs\.trusted-preflight\.outputs\.deployed_origin \}\}/);
  assert.match(workflow, /VITE_ANALYTICS_ROBINHOOD_TESTNET_URL="\$DEPLOYED_ORIGIN\/graphql"/);
  assert.match(workflow, /VITE_ANALYTICS_ROBINHOOD_URL="\$DEPLOYED_ORIGIN\/graphql"/);
  const approvalBoundary = workflow.indexOf("  promote:");
  const verify = workflow.indexOf("Verify custody without rebuilding");
  const adapter = workflow.indexOf("Invoke provider adapter and smoke hosted app/docs");
  const evidenceStep = workflow.indexOf("Write sanitized promotion and rollback-readiness evidence");
  assert(approvalBoundary > 0 && approvalBoundary < verify && verify < adapter && adapter < evidenceStep);
  assert.doesNotMatch(workflow, /Smoke hosted release against sealed artifact/);
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
  for (const protectedValue of [
    "WEB_VPS_DEPLOYED_ORIGIN",
    "WEB_VPS_DOCS_ORIGIN",
    "WEB_VPS_RELEASE_ROOT",
    "WEB_VPS_SSH_HOST",
    "WEB_VPS_SSH_KNOWN_HOSTS",
    "WEB_VPS_SSH_PORT",
    "WEB_VPS_SSH_PRIVATE_KEY",
    "WEB_VPS_SSH_USER"
  ]) {
    assert.match(workflow, new RegExp(`${protectedValue}: \\$\\{\\{ secrets\\.${protectedValue} \\}\\}`));
  }
  for (const promotionValue of [
    "WEB_PROMOTION_ENVIRONMENT",
    "WEB_PROMOTION_COMMIT",
    "WEB_PROMOTION_ARTIFACT",
    "WEB_PROMOTION_MANIFEST",
    "WEB_PROMOTION_ARCHIVE",
    "WEB_PROMOTION_CUSTODY",
    "WEB_PROMOTION_DEPLOYED_URL"
  ]) {
    assert.match(workflow, new RegExp(`^          ${promotionValue}:`, "m"));
  }
  assert.match(fs.readFileSync(providerAdapter, "utf8"), /StrictHostKeyChecking=yes/);
  assert.match(fs.readFileSync(providerAdapter, "utf8"), /UserKnownHostsFile=/);
  assert.match(fs.readFileSync(providerAdapter, "utf8"), /--manifest "\$WEB_PROMOTION_MANIFEST"/);
  assert.match(fs.readFileSync(providerAdapter, "utf8"), /--docs-url "\$docs_origin\/docs"/);
  assert.match(fs.readFileSync(providerAdapter, "utf8"), /attempt_guarded_rollback/);
  assert.match(fs.readFileSync(providerAdapter, "utf8"), /confirm_activation/);
  assert.match(fs.readFileSync(providerAdapter, "utf8"), /WEB_PROMOTION_LEASE_SECONDS/);
  assert.match(fs.readFileSync(remoteAdapter, "utf8"), /release_target="releases\/\$commit\/dist"/);
  assert.match(fs.readFileSync(remoteAdapter, "utf8"), /replace_link "\$current_tmp" "\$current"/);
  assert.match(fs.readFileSync(remoteAdapter, "utf8"), /acquire_activation_lock/);
  assert.match(fs.readFileSync(remoteAdapter, "utf8"), /release payload integrity check failed/);
  assert.match(fs.readFileSync(remoteAdapter, "utf8"), /activation record anchor identity does not match/);
  assert.match(fs.readFileSync(remoteAdapter, "utf8"), /lease_watch/);
  assert.match(fs.readFileSync(remoteAdapter, "utf8"), /PROMOTION_CONFIRM=confirmed/);
  const custodySource = fs.readFileSync(custody, "utf8");
  assert.match(custodySource, /validateArchiveEntries\(archive\)/);
  assert.match(custodySource, /links and special files are forbidden/);
  assert.match(custodySource, /duplicate promotion archive path/);
  for (const action of workflow.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(action[1], /@[0-9a-f]{40}$/, `action must be pinned by SHA: ${action[1]}`);
  }
}

function testVpsPromotionAdapter({ bundle, extracted }) {
  const transportDir = path.join(temp, "fake-transport");
  const transportLog = path.join(temp, "fake-transport.jsonl");
  const smokeLog = path.join(temp, "fake-smoke.jsonl");
  fs.mkdirSync(transportDir, { recursive: true });
  const fakeSsh = path.join(transportDir, "ssh.cjs");
  const fakeScp = path.join(transportDir, "scp.cjs");
  const fakeSmoke = path.join(transportDir, "smoke.cjs");
  writeExecutable(fakeSsh, `#!/usr/bin/env node
"use strict";
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let index = 0;
while (index < args.length && args[index].startsWith("-")) {
  if (!["-F", "-i", "-p", "-o"].includes(args[index])) process.exit(64);
  index += 2;
}
const target = args[index++];
const command = args.slice(index);
const action = command[3];
fs.appendFileSync(process.env.FAKE_TRANSPORT_LOG, JSON.stringify({
  command: command.slice(0, 4),
  strictHostKeyChecking: args.includes("StrictHostKeyChecking=yes"),
  target,
  type: "ssh",
  userKnownHosts: args.some((value) => value.startsWith("UserKnownHostsFile="))
}) + "\\n");
if (process.env.FAKE_SSH_FAIL === "1") process.exit(70);
if (process.env.FAKE_SSH_FAIL_AFTER_PROMOTE === "1" && process.env.FAKE_SSH_STATE && fs.existsSync(process.env.FAKE_SSH_STATE)) process.exit(70);
if (command[0] !== "sh" || command[1] !== "-s" || command[2] !== "--") process.exit(64);
if (action === "promote" && process.env.FAKE_SSH_STOP_PROMOTE_BEFORE_LOCK === "1" && process.env.FAKE_SSH_STATE) {
  const helperFile = process.env.FAKE_SSH_STATE + ".helper.sh";
  fs.writeFileSync(helperFile, fs.readFileSync(0), { mode: 0o700 });
  const child = childProcess.spawn("sh", [helperFile, ...command.slice(3)], { detached: true, stdio: "ignore" });
  child.unref();
  const releaseRoot = process.env.FAKE_VPS_ROOT;
  const releaseCommit = command[6];
  const stage = path.join(releaseRoot, "releases", "." + releaseCommit + ".stage." + child.pid);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(stage) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  if (!fs.existsSync(stage)) process.exit(75);
  process.kill(child.pid, "SIGSTOP");
  fs.writeFileSync(process.env.FAKE_SSH_STATE, String(child.pid));
  process.exit(255);
}
const result = childProcess.spawnSync(command[0], command.slice(1), {
  encoding: "utf8",
  input: fs.readFileSync(0)
});
if (action === "promote" && process.env.FAKE_SSH_FAIL_AFTER_PROMOTE === "1") {
  if (result.status === 0 && process.env.FAKE_SSH_STATE) fs.writeFileSync(process.env.FAKE_SSH_STATE, "disconnected-after-promote\\n");
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status === 0 ? 255 : (result.status ?? 1));
}
if (action === "promote" && process.env.FAKE_SSH_DISCONNECT_AFTER_PROMOTE === "1") {
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status === 0 ? 255 : (result.status ?? 1));
}
if (action === "promote" && process.env.FAKE_SSH_MALFORM_PROMOTE_OUTPUT === "1" && result.status === 0) {
  process.stdout.write("malformed activation output\\n");
} else if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`);
  writeExecutable(fakeScp, `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let index = 0;
while (index < args.length && args[index].startsWith("-") && args[index] !== "--") {
  if (!["-F", "-i", "-P", "-o"].includes(args[index])) process.exit(64);
  index += 2;
}
if (args[index] === "--") index += 1;
const source = args[index++];
const destination = args[index++];
const separator = destination.indexOf(":");
if (!source || separator < 1 || index !== args.length) process.exit(64);
const target = destination.slice(0, separator);
const remotePath = destination.slice(separator + 1);
fs.appendFileSync(process.env.FAKE_TRANSPORT_LOG, JSON.stringify({
  destination: path.basename(remotePath),
  strictHostKeyChecking: args.includes("StrictHostKeyChecking=yes"),
  target,
  type: "scp",
  userKnownHosts: args.some((value) => value.startsWith("UserKnownHostsFile="))
}) + "\\n");
if (process.env.FAKE_SCP_FAIL === "1") process.exit(71);
fs.copyFileSync(source, remotePath);
if (process.env.FAKE_SCP_TAMPER === "1") fs.appendFileSync(remotePath, "tampered in transit");
`);
  writeExecutable(fakeSmoke, `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SMOKE_LOG, JSON.stringify({ args }) + "\\n");
if (process.env.FAKE_SMOKE_REPOINT_TARGET) {
  const current = path.join(process.env.FAKE_VPS_ROOT, "current");
  fs.unlinkSync(current);
  fs.symlinkSync(process.env.FAKE_SMOKE_REPOINT_TARGET, current);
}
if (process.env.FAKE_SMOKE_FAIL === "1") process.exit(72);
`);

  const vpsRoot = path.join(temp, "vps-testnet");
  const oldCommit = "1".repeat(40);
  const oldTarget = `releases/${oldCommit}/dist`;
  const oldRelease = path.join(vpsRoot, "releases", oldCommit);
  installReleaseFixture(oldRelease, { commit: oldCommit, environment: "testnet", index: "old release\n" });
  fs.symlinkSync(oldTarget, path.join(vpsRoot, "current"));

  const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-private-key\n-----END OPENSSH PRIVATE KEY-----";
  const baseEnv = {
    ...process.env,
    FAKE_SMOKE_LOG: smokeLog,
    FAKE_TRANSPORT_LOG: transportLog,
    FAKE_VPS_ROOT: vpsRoot,
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "123456",
    WEB_PROMOTION_ARCHIVE: path.join(bundle, "web-promotion.tar.gz"),
    WEB_PROMOTION_ARTIFACT: path.join(extracted, "dist"),
    WEB_PROMOTION_COMMIT: commit,
    WEB_PROMOTION_CUSTODY: path.join(bundle, "custody.json"),
    WEB_PROMOTION_DEPLOYED_URL: "https://release.example",
    WEB_PROMOTION_ENVIRONMENT: "testnet",
    WEB_PROMOTION_MANIFEST: path.join(extracted, "manifest.json"),
    WEB_PROMOTION_SCP_BIN: fakeScp,
    WEB_PROMOTION_SMOKE_BIN: fakeSmoke,
    WEB_PROMOTION_SSH_BIN: fakeSsh,
    WEB_PROMOTION_TEST_MODE: "1",
    WEB_PROMOTION_LEASE_SECONDS: "10",
    WEB_VPS_DEPLOYED_ORIGIN: "https://release.example:443/",
    WEB_VPS_DOCS_ORIGIN: "https://docs.release.example:443/",
    WEB_VPS_RELEASE_ROOT: vpsRoot,
    WEB_VPS_SSH_HOST: "vps.example",
    WEB_VPS_SSH_KNOWN_HOSTS: "vps.example ssh-ed25519 AAAAC3NzaFixture",
    WEB_VPS_SSH_PORT: "2222",
    WEB_VPS_SSH_PRIVATE_KEY: privateKey,
    WEB_VPS_SSH_USER: "feather"
  };

  const first = runAdapter(baseEnv);
  assert.equal(first.status, 0, `VPS promotion should pass:\n${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, new RegExp(commit));
  assert.doesNotMatch(`${first.stdout}\n${first.stderr}`, /fixture-private-key|OPENSSH PRIVATE KEY/);

  const releaseDir = path.join(vpsRoot, "releases", commit);
  assert.equal(fs.readlinkSync(path.join(vpsRoot, "current")), `releases/${commit}/dist`);
  assert.equal(fs.readlinkSync(path.join(vpsRoot, "previous")), oldTarget);
  assert.equal(
    fs.readFileSync(path.join(vpsRoot, fs.readlinkSync(path.join(vpsRoot, "current")), "index.html"), "utf8"),
    "<script src=/assets/index-a.js></script>\n"
  );
  assert.equal(fs.readFileSync(path.join(releaseDir, "dist", "assets", "index-a.js"), "utf8"), "console.log('release')\n");
  const custodyEnvelope = JSON.parse(fs.readFileSync(path.join(bundle, "custody.json"), "utf8"));
  assert.equal(fs.readFileSync(path.join(releaseDir, ".archive-sha256"), "utf8").trim(), custodyEnvelope.archiveSha256);
  assert.match(fs.readFileSync(path.join(releaseDir, ".payload-sha256"), "utf8").trim(), /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(path.join(releaseDir, ".release-identity"), "utf8").trim(), `testnet ${commit}`);
  assert.equal(fs.statSync(path.join(releaseDir, "dist", "index.html")).mode & 0o222, 0, "immutable release files must not be writable");
  assert.deepEqual(fs.readdirSync(path.join(vpsRoot, ".incoming")), []);
  const firstSmoke = JSON.parse(fs.readFileSync(smokeLog, "utf8").trim().split("\n")[0]);
  assert.deepEqual(firstSmoke.args, [
    "--url", "https://release.example",
    "--dist", path.join(extracted, "dist"),
    "--manifest", path.join(extracted, "manifest.json"),
    "--docs-url", "https://docs.release.example/docs"
  ]);

  const immutableContents = fs.readFileSync(path.join(releaseDir, "dist", "index.html"), "utf8");
  const second = runAdapter(baseEnv);
  assert.equal(second.status, 0, `idempotent VPS promotion should pass:\n${second.stdout}\n${second.stderr}`);
  assert.equal(fs.readFileSync(path.join(releaseDir, "dist", "index.html"), "utf8"), immutableContents);
  assert.equal(fs.readlinkSync(path.join(vpsRoot, "previous")), oldTarget, "idempotent promotion must retain the rollback pointer");

  const confirmedCurrentInode = fs.lstatSync(path.join(vpsRoot, "current")).ino;
  const newRunSameCommit = runAdapter({ ...baseEnv, GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "123457" }, false);
  assert.equal(newRunSameCommit.status, 0, `a new run of an already-confirmed commit must remain idempotent:\n${newRunSameCommit.stdout}\n${newRunSameCommit.stderr}`);
  assert.equal(fs.lstatSync(path.join(vpsRoot, "current")).ino, confirmedCurrentInode,
    "a new run of an already-confirmed commit must not create a fresh pending pointer");
  assert.equal(fs.readlinkSync(path.join(vpsRoot, "previous")), oldTarget);

  const failedResmoke = runAdapter({
    ...baseEnv,
    FAKE_SMOKE_FAIL: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "123458"
  }, false);
  assert.notEqual(failedResmoke.status, 0, "failed re-smoke of a confirmed current release must fail the workflow");
  assert.match(`${failedResmoke.stdout}\n${failedResmoke.stderr}`, /previously confirmed current release was left unchanged/i);
  assert.equal(fs.lstatSync(path.join(vpsRoot, "current")).ino, confirmedCurrentInode,
    "failed re-smoke must not roll back an already-confirmed current release");

  const pendingIntentRoot = path.join(temp, "vps-pending-intent-race");
  const pendingIntentState = path.join(temp, "vps-pending-intent-race.pid");
  installReleaseFixture(path.join(pendingIntentRoot, "releases", oldCommit), { commit: oldCommit, environment: "testnet", index: "old release\n" });
  fs.symlinkSync(oldTarget, path.join(pendingIntentRoot, "current"));
  const pendingIntent = runAdapter({
    ...baseEnv,
    FAKE_SSH_STATE: pendingIntentState,
    FAKE_SSH_STOP_PROMOTE_BEFORE_LOCK: "1",
    FAKE_VPS_ROOT: pendingIntentRoot,
    WEB_VPS_RELEASE_ROOT: pendingIntentRoot
  }, false);
  assert.notEqual(pendingIntent.status, 0, "an ambiguous in-flight promotion must not report success");
  assert.match(`${pendingIntent.stdout}\n${pendingIntent.stderr}`, /ambiguous|did not become current/i);
  const stoppedPromotionPid = Number(fs.readFileSync(pendingIntentState, "utf8"));
  process.kill(stoppedPromotionPid, "SIGCONT");
  childProcess.spawnSync("sleep", ["1"]);
  assert.equal(fs.readlinkSync(path.join(pendingIntentRoot, "current")), oldTarget,
    "cleanup must cancel the durable intent before an ambiguous original process can later activate");

  const corruptRoot = path.join(temp, "vps-corrupt-existing");
  fs.cpSync(vpsRoot, corruptRoot, { recursive: true, dereference: false, verbatimSymlinks: true });
  const corruptRelease = path.join(corruptRoot, "releases", commit);
  fs.chmodSync(path.join(corruptRelease, "dist", "index.html"), 0o644);
  fs.writeFileSync(path.join(corruptRelease, "dist", "index.html"), "corrupted but self-consistent\n");
  fs.chmodSync(path.join(corruptRelease, ".payload-sha256"), 0o644);
  fs.writeFileSync(path.join(corruptRelease, ".payload-sha256"), `${releasePayloadDigest(corruptRelease)}\n`);
  const corruptReuse = runAdapter({ ...baseEnv, FAKE_VPS_ROOT: corruptRoot, WEB_VPS_RELEASE_ROOT: corruptRoot }, false);
  assert.notEqual(corruptReuse.status, 0, "a modified existing release must not be reused");
  assert.match(`${corruptReuse.stdout}\n${corruptReuse.stderr}`, /payload differs|activation failed/i);
  assert.equal(fs.readlinkSync(path.join(corruptRoot, "current")), `releases/${commit}/dist`);

  const invalidPreviousRoot = path.join(temp, "vps-invalid-previous");
  const invalidOldDist = path.join(invalidPreviousRoot, oldTarget);
  fs.mkdirSync(invalidOldDist, { recursive: true });
  fs.writeFileSync(path.join(invalidOldDist, "index.html"), "unsealed old release\n");
  fs.symlinkSync(oldTarget, path.join(invalidPreviousRoot, "current"));
  const invalidPrevious = runAdapter({ ...baseEnv, FAKE_VPS_ROOT: invalidPreviousRoot, WEB_VPS_RELEASE_ROOT: invalidPreviousRoot }, false);
  assert.notEqual(invalidPrevious.status, 0, "an unsealed current target must not be recorded for rollback");
  assert.equal(fs.readlinkSync(path.join(invalidPreviousRoot, "current")), oldTarget);
  assert(!fs.existsSync(path.join(invalidPreviousRoot, "previous")));

  const lockedRoot = path.join(temp, "vps-locked-activation");
  installReleaseFixture(path.join(lockedRoot, "releases", oldCommit), { commit: oldCommit, environment: "testnet", index: "old release\n" });
  fs.symlinkSync(oldTarget, path.join(lockedRoot, "current"));
  fs.mkdirSync(path.join(lockedRoot, ".promotion.lock"));
  const locked = runAdapter({
    ...baseEnv,
    FAKE_VPS_ROOT: lockedRoot,
    WEB_PROMOTION_LOCK_ATTEMPTS: "1",
    WEB_VPS_RELEASE_ROOT: lockedRoot
  }, false);
  assert.notEqual(locked.status, 0, "an activation must fail closed while the VPS lock is held");
  assert.match(`${locked.stdout}\n${locked.stderr}`, /holds the VPS lock|activation failed/i);
  assert.equal(fs.readlinkSync(path.join(lockedRoot, "current")), oldTarget);
  assert(fs.existsSync(path.join(lockedRoot, ".promotion.lock")), "a contender must not remove another activation's lock");

  const rollbackRoot = path.join(temp, "vps-smoke-rollback");
  installReleaseFixture(path.join(rollbackRoot, "releases", oldCommit), { commit: oldCommit, environment: "testnet", index: "old release\n" });
  fs.symlinkSync(oldTarget, path.join(rollbackRoot, "current"));
  const failedSmoke = runAdapter({
    ...baseEnv,
    FAKE_SMOKE_FAIL: "1",
    FAKE_VPS_ROOT: rollbackRoot,
    WEB_VPS_RELEASE_ROOT: rollbackRoot
  }, false);
  assert.notEqual(failedSmoke.status, 0, "a failed hosted smoke must fail promotion");
  assert.match(`${failedSmoke.stdout}\n${failedSmoke.stderr}`, /prior verified release was restored/i);
  assert.equal(fs.readlinkSync(path.join(rollbackRoot, "current")), oldTarget, "failed smoke must restore the verified prior release");
  assert(fs.existsSync(path.join(rollbackRoot, "releases", commit)), "rollback retains the failed immutable release for investigation");

  const guardedRoot = path.join(temp, "vps-guarded-rollback");
  const concurrentCommit = "2".repeat(40);
  const concurrentTarget = `releases/${concurrentCommit}/dist`;
  installReleaseFixture(path.join(guardedRoot, "releases", oldCommit), { commit: oldCommit, environment: "testnet", index: "old release\n" });
  installReleaseFixture(path.join(guardedRoot, "releases", concurrentCommit), { commit: concurrentCommit, environment: "testnet", index: "newer concurrent release\n" });
  fs.symlinkSync(oldTarget, path.join(guardedRoot, "current"));
  const guarded = runAdapter({
    ...baseEnv,
    FAKE_SMOKE_FAIL: "1",
    FAKE_SMOKE_REPOINT_TARGET: concurrentTarget,
    FAKE_VPS_ROOT: guardedRoot,
    WEB_VPS_RELEASE_ROOT: guardedRoot
  }, false);
  assert.notEqual(guarded.status, 0, "failed smoke must still fail when a newer activation wins");
  assert.match(`${guarded.stdout}\n${guarded.stderr}`, /guarded rollback could not restore/i);
  assert.equal(fs.readlinkSync(path.join(guardedRoot, "current")), concurrentTarget, "rollback must never clobber a newer current target");

  const disconnectedRoot = path.join(temp, "vps-disconnected-activation-result");
  installReleaseFixture(path.join(disconnectedRoot, "releases", oldCommit), { commit: oldCommit, environment: "testnet", index: "old release\n" });
  fs.symlinkSync(oldTarget, path.join(disconnectedRoot, "current"));
  const disconnected = runAdapter({
    ...baseEnv,
    FAKE_SSH_DISCONNECT_AFTER_PROMOTE: "1",
    FAKE_VPS_ROOT: disconnectedRoot,
    WEB_VPS_RELEASE_ROOT: disconnectedRoot
  }, false);
  assert.equal(disconnected.status, 0, `a lost activation result must reconcile and continue smoke:\n${disconnected.stdout}\n${disconnected.stderr}`);
  assert.equal(fs.readlinkSync(path.join(disconnectedRoot, "current")), `releases/${commit}/dist`);
  assert(fs.readdirSync(path.join(disconnectedRoot, ".promotion-records")).some((name) => name.endsWith(".confirmed")),
    "reconciled activation must be explicitly confirmed after smoke");

  const malformedRoot = path.join(temp, "vps-malformed-activation-result");
  installReleaseFixture(path.join(malformedRoot, "releases", oldCommit), { commit: oldCommit, environment: "testnet", index: "old release\n" });
  fs.symlinkSync(oldTarget, path.join(malformedRoot, "current"));
  const malformed = runAdapter({
    ...baseEnv,
    FAKE_SSH_MALFORM_PROMOTE_OUTPUT: "1",
    FAKE_VPS_ROOT: malformedRoot,
    WEB_VPS_RELEASE_ROOT: malformedRoot
  }, false);
  assert.equal(malformed.status, 0, `malformed activation output must reconcile and continue smoke:\n${malformed.stdout}\n${malformed.stderr}`);
  assert.equal(fs.readlinkSync(path.join(malformedRoot, "current")), `releases/${commit}/dist`);

  const abandonedRoot = path.join(temp, "vps-abandoned-activation");
  const abandonedState = path.join(temp, "vps-abandoned-activation.ssh-state");
  installReleaseFixture(path.join(abandonedRoot, "releases", oldCommit), { commit: oldCommit, environment: "testnet", index: "old release\n" });
  fs.symlinkSync(oldTarget, path.join(abandonedRoot, "current"));
  const abandoned = runAdapter({
    ...baseEnv,
    FAKE_SSH_FAIL_AFTER_PROMOTE: "1",
    FAKE_SSH_STATE: abandonedState,
    FAKE_VPS_ROOT: abandonedRoot,
    WEB_PROMOTION_LEASE_SECONDS: "2",
    WEB_VPS_RELEASE_ROOT: abandonedRoot
  }, false);
  assert.notEqual(abandoned.status, 0, "a permanently disconnected activation cannot report success");
  assert.match(`${abandoned.stdout}\n${abandoned.stderr}`, /ambiguous|lease will roll it back/i);
  waitFor(() => fs.readlinkSync(path.join(abandonedRoot, "current")) === oldTarget, 7000,
    "the on-host lease must restore the prior release without any subsequent SSH call");

  const abandonedFirstRoot = path.join(temp, "vps-abandoned-first-activation");
  const abandonedFirstState = path.join(temp, "vps-abandoned-first-activation.ssh-state");
  const abandonedFirst = runAdapter({
    ...baseEnv,
    FAKE_SSH_FAIL_AFTER_PROMOTE: "1",
    FAKE_SSH_STATE: abandonedFirstState,
    FAKE_VPS_ROOT: abandonedFirstRoot,
    WEB_PROMOTION_LEASE_SECONDS: "2",
    WEB_VPS_RELEASE_ROOT: abandonedFirstRoot
  }, false);
  assert.notEqual(abandonedFirst.status, 0, "a disconnected first activation cannot report success");
  waitFor(() => !fs.existsSync(path.join(abandonedFirstRoot, "current")), 7000,
    "an abandoned first deployment must remove current when its on-host lease expires");

  const supersededSameCommitRoot = path.join(temp, "vps-superseded-same-commit");
  const supersededSameCommitState = path.join(temp, "vps-superseded-same-commit.ssh-state");
  installReleaseFixture(path.join(supersededSameCommitRoot, "releases", oldCommit), { commit: oldCommit, environment: "testnet", index: "old release\n" });
  fs.symlinkSync(oldTarget, path.join(supersededSameCommitRoot, "current"));
  const supersededSameCommit = runAdapter({
    ...baseEnv,
    FAKE_SSH_FAIL_AFTER_PROMOTE: "1",
    FAKE_SSH_STATE: supersededSameCommitState,
    FAKE_VPS_ROOT: supersededSameCommitRoot,
    WEB_PROMOTION_LEASE_SECONDS: "4",
    WEB_VPS_RELEASE_ROOT: supersededSameCommitRoot
  }, false);
  assert.notEqual(supersededSameCommit.status, 0);
  const sameCommitTarget = `releases/${commit}/dist`;
  assert.equal(fs.readlinkSync(path.join(supersededSameCommitRoot, "current")), sameCommitTarget);
  fs.unlinkSync(path.join(supersededSameCommitRoot, "current"));
  fs.symlinkSync(sameCommitTarget, path.join(supersededSameCommitRoot, "current"));
  childProcess.spawnSync("sleep", ["4.2"]);
  assert.equal(fs.readlinkSync(path.join(supersededSameCommitRoot, "current")), sameCommitTarget,
    "the anchored symlink identity must protect a newer same-commit activation from stale rollback");

  const transportEvents = fs.readFileSync(transportLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert(transportEvents.some((event) => event.type === "scp"));
  for (const event of transportEvents) {
    assert.equal(event.target, "feather@vps.example");
    assert.equal(event.strictHostKeyChecking, true);
    assert.equal(event.userKnownHosts, true);
  }
  assert.doesNotMatch(fs.readFileSync(transportLog, "utf8"), /fixture-private-key|OPENSSH PRIVATE KEY/);

  const tamperRoot = path.join(temp, "vps-tampered-transport");
  const tampered = runAdapter({ ...baseEnv, FAKE_SCP_TAMPER: "1", WEB_VPS_RELEASE_ROOT: tamperRoot }, false);
  assert.notEqual(tampered.status, 0, "transport tampering must fail");
  assert.match(`${tampered.stdout}\n${tampered.stderr}`, /digest mismatch|activation failed/i);
  assert(!fs.existsSync(path.join(tamperRoot, "releases", commit)), "a tampered archive must not create a release");
  assert.deepEqual(fs.readdirSync(path.join(tamperRoot, ".incoming")), []);

  const conflictRoot = path.join(temp, "vps-conflicting-release");
  const conflictRelease = path.join(conflictRoot, "releases", commit);
  installReleaseFixture(conflictRelease, { commit, environment: "testnet", index: "conflict\n" });
  fs.writeFileSync(path.join(conflictRelease, ".archive-sha256"), `${"0".repeat(64)}\n`);
  fs.writeFileSync(path.join(conflictRelease, ".payload-sha256"), `${releasePayloadDigest(conflictRelease)}\n`);
  const conflict = runAdapter({ ...baseEnv, WEB_VPS_RELEASE_ROOT: conflictRoot }, false);
  assert.notEqual(conflict.status, 0, "an immutable release digest conflict must fail");
  assert.equal(fs.readFileSync(path.join(conflictRoot, "releases", commit, "dist", "index.html"), "utf8"), "conflict\n");

  const unsafePointerRoot = path.join(temp, "vps-unsafe-current-pointer");
  const unsafeDist = path.join(unsafePointerRoot, "outside-layout", "dist");
  fs.mkdirSync(unsafeDist, { recursive: true });
  fs.writeFileSync(path.join(unsafeDist, "index.html"), "unsafe target\n");
  fs.symlinkSync(unsafeDist, path.join(unsafePointerRoot, "current"));
  const unsafePointer = runAdapter({ ...baseEnv, WEB_VPS_RELEASE_ROOT: unsafePointerRoot }, false);
  assert.notEqual(unsafePointer.status, 0, "an absolute or off-layout current pointer must fail closed");
  assert.equal(fs.readlinkSync(path.join(unsafePointerRoot, "current")), unsafeDist);

  const eventCount = fs.readFileSync(transportLog, "utf8").trim().split("\n").length;
  const wrongOrigin = runAdapter({ ...baseEnv, WEB_VPS_DEPLOYED_ORIGIN: "https://other.example" }, false);
  assert.notEqual(wrongOrigin.status, 0, "dispatch URL must match the protected origin");
  assert.equal(fs.readFileSync(transportLog, "utf8").trim().split("\n").length, eventCount, "origin rejection must happen before transport");

  const missingKnownHosts = { ...baseEnv, WEB_VPS_SSH_KNOWN_HOSTS: "" };
  assert.notEqual(runAdapter(missingKnownHosts, false).status, 0, "missing known-hosts data must fail closed");
  assert.notEqual(runAdapter({ ...baseEnv, WEB_VPS_DOCS_ORIGIN: "https://release.example" }, false).status, 0,
    "app and docs origins must be distinct protected HTTPS origins");
  const overridesOutsideTest = { ...baseEnv };
  delete overridesOutsideTest.WEB_PROMOTION_TEST_MODE;
  assert.notEqual(runAdapter(overridesOutsideTest, false).status, 0, "transport overrides must be test-only");

  const sentinel = path.join(temp, "root-injection-sentinel");
  const hostileRoot = `${path.join(temp, "bad")};touch-${path.basename(sentinel)}`;
  assert.notEqual(runAdapter({ ...baseEnv, WEB_VPS_RELEASE_ROOT: hostileRoot }, false).status, 0, "hostile release roots must fail closed");
  assert(!fs.existsSync(sentinel));
}

function installReleaseFixture(releaseDir, { commit: releaseCommit, environment, index }) {
  fs.mkdirSync(path.join(releaseDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, "dist", "index.html"), index);
  fs.writeFileSync(path.join(releaseDir, "manifest.json"), `${JSON.stringify({ environment, fixture: true })}\n`);
  fs.writeFileSync(path.join(releaseDir, "custody.json"), `${JSON.stringify({ schemaVersion: "fixture.custody.v1" })}\n`);
  fs.writeFileSync(path.join(releaseDir, ".archive-sha256"), `${"a".repeat(64)}\n`);
  fs.writeFileSync(path.join(releaseDir, ".release-identity"), `${environment} ${releaseCommit}\n`);
  fs.writeFileSync(path.join(releaseDir, ".payload-sha256"), `${releasePayloadDigest(releaseDir)}\n`);
}

function releasePayloadDigest(releaseDir) {
  const inventory = listRegularFiles(releaseDir)
    .map((file) => path.relative(releaseDir, file).split(path.sep).join("/"))
    .filter((file) => file !== ".payload-sha256")
    .sort()
    .map((relativePath) => {
      const body = fs.readFileSync(path.join(releaseDir, relativePath));
      return `${relativePath}\t${body.byteLength}\t${crypto.createHash("sha256").update(body).digest("hex")}\n`;
    })
    .join("");
  return crypto.createHash("sha256").update(inventory).digest("hex");
}

function listRegularFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listRegularFiles(target);
    assert(entry.isFile(), `release fixture must contain only regular files: ${target}`);
    return [target];
  });
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {}
    childProcess.spawnSync("sleep", ["0.1"]);
  }
  assert.fail(message);
}

function runAdapter(env, expectSuccess = true) {
  const result = childProcess.spawnSync("bash", [providerAdapter], { cwd: root, encoding: "utf8", env });
  if (expectSuccess) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
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
