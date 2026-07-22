#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = path.resolve(__dirname, "..", "..");
const validator = path.join(repo, "scripts/release/validate-operator-runbooks.cjs");
const run = (root) => childProcess.spawnSync(process.execPath, [validator, "--root", root], { encoding: "utf8" });
const sections = ["Trigger", "Authority", "Prerequisites", "Commands", "Validation", "Rollback", "Evidence", "Communications", "Escalation"];

function validRunbook(extra = "") {
  return `# Test Runbook\n\n${sections.map((section) =>
    section === "Commands" ? "## Commands\nDetails.\n\n```sh\necho ok\n```" : `## ${section}\nRequired details.`
  ).join("\n\n")}\n${extra}`;
}

function fixture({ monitorSlug = "test-runbook", incidentTarget = "runbooks/test-runbook.md", content = validRunbook() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-runbooks-"));
  fs.mkdirSync(path.join(root, "infra/monitoring"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs/wave-2/runbooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "infra/monitoring/monitors.json"), JSON.stringify({ monitors: [{ id: "m1", runbook: monitorSlug }] }));
  fs.writeFileSync(path.join(root, "docs/wave-2/observability-incident-response.md"), `| [Incident](${incidentTarget}) | Action | Evidence |\n`);
  fs.writeFileSync(path.join(root, "docs/wave-2/runbooks/test-runbook.md"), content);
  return root;
}

function expectInvalid(options, pattern, mutate) {
  const root = fixture(options);
  try {
    if (mutate) mutate(root);
    const result = run(root);
    assert.equal(result.status, 1, `expected validation failure, got: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, pattern);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0, `expected valid fixture, got: ${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

expectInvalid({ monitorSlug: "../escape" }, /strict lowercase slug/);
expectInvalid({ monitorSlug: "/tmp/escape" }, /strict lowercase slug/);
expectInvalid({ monitorSlug: "Bad_Slug" }, /strict lowercase slug/);
expectInvalid({ incidentTarget: "runbooks/%2e%2e/escape.md" }, /escapes runbook directory/);
expectInvalid({ incidentTarget: "/tmp/runbooks/test-runbook.md" }, /invalid local runbook link/);
expectInvalid({ incidentTarget: "runbooks/Bad_Slug.md" }, /invalid local runbook link/);
expectInvalid({ incidentTarget: "runbooks/%ZZ.md" }, /invalid percent-encoding/);
expectInvalid({}, /resolves outside the runbook directory/, (root) => {
  const runbook = path.join(root, "docs/wave-2/runbooks/test-runbook.md");
  const outside = path.join(root, "outside.md");
  fs.writeFileSync(outside, validRunbook());
  fs.rmSync(runbook);
  fs.symlinkSync(outside, runbook);
});

expectInvalid({ content: `# Fake\n\n\`\`\`md\n${sections.map((section) => `## ${section}\nFake`).join("\n")}\n\`\`\`\n` }, /missing ## Trigger/);
expectInvalid({ content: validRunbook().replace("## Authority\nRequired details.", "## Authority\n") }, /## Authority must not be empty/);
expectInvalid({ content: validRunbook().replace("echo ok", "# comment only") }, /nonempty executable sh\/bash block/);
expectInvalid({}, /orphan runbook/, (root) => fs.writeFileSync(path.join(root, "docs/wave-2/runbooks/orphan.md"), validRunbook()));
expectInvalid({ incidentTarget: "runbooks/missing.md" }, /runbook .*missing/);
expectInvalid({ content: `${validRunbook()}\n[Escape](../outside.md)\n` }, /escapes runbook directory/);

for (const secret of [
  "https://operator:password@example.invalid/rpc",
  "https://example.invalid/rpc?access_token=actualcredential",
  "Authorization: Bearer abcdefghijklmnop",
  "-----BEGIN PRIVATE KEY-----",
  "api_key: abcdefghijklmnop",
  "{ \"access token\": \"abcdefghijklmnop\" }",
  "--auth-token abcdefghijklmnop",
  "secret = abcdefghijklmnop"
]) {
  expectInvalid({ content: `${validRunbook()}\n${secret}\n` }, /inline secret/);
}

console.log("Operator runbook validator tests passed.");
