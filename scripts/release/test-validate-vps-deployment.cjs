#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const validator = path.join(root, "scripts/release/validate-vps-deployment.cjs");
const fixtureFiles = [
  ".dockerignore",
  "packages/analytics/Dockerfile",
  "infra/vps/compose.yml",
  "infra/vps/Caddyfile",
  "infra/vps/host.env.example",
  "infra/vps/compose.web.yml",
  "infra/vps/Caddyfile.web",
  "infra/vps/host.web.env.example",
  "infra/vps/analytics.env.example",
  "infra/vps/README.md",
  "scripts/release/build-analytics-runtime-custody.cjs"
];

const baseline = run(root);
assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "feather-vps-validation-"));
try {
  copyFixture(temp);

  mutate(temp, ".dockerignore", (source) => {
    const lines = source.split(/\r?\n/);
    const lastLocal = lines.lastIndexOf(".local");
    lines.splice(lastLocal, 1);
    return lines.join("\n");
  });
  expectFailure(temp, /must re-assert \.local after the analytics source allowlist/);
  restore(temp, ".dockerignore");

  mutate(temp, ".dockerignore", (source) => {
    const lines = source.split(/\r?\n/);
    const lastPem = lines.lastIndexOf("*.pem");
    lines.splice(lastPem, 1);
    return lines.join("\n");
  });
  expectFailure(temp, /must re-assert \*\.pem after the analytics source allowlist/);
  restore(temp, ".dockerignore");

  mutate(temp, ".dockerignore", (source) => source.replace(
    "!packages/analytics/src/*.ts",
    "!packages/analytics/src/**"
  ));
  expectFailure(temp, /must not broadly re-include the analytics source tree/);
  restore(temp, ".dockerignore");

  mutate(temp, "packages/analytics/Dockerfile", (source) => source.replace(/@sha256:[0-9a-f]{64}/i, ""));
  expectFailure(temp, /base image is not digest-pinned/);
  restore(temp, "packages/analytics/Dockerfile");

  mutate(temp, "infra/vps/compose.yml", (source) => source.replace(
    '    expose:\n      - "8787"',
    '    ports:\n      - "8787:8787"'
  ));
  expectFailure(temp, /analytics service must not publish ports/);
  restore(temp, "infra/vps/compose.yml");

  mutate(temp, "infra/vps/compose.yml", (source) => source.replace(
    '    cpus: "${FEATHER_ANALYTICS_CPUS:-2.0}"',
    ""
  ));
  expectFailure(temp, /analytics service is missing required token: cpus/);
  restore(temp, "infra/vps/compose.yml");

  mutate(temp, "infra/vps/compose.yml", (source) => source.replace(
    "  caddy:\n",
    "  caddy:\n    depends_on:\n      analytics:\n        condition: service_started\n"
  ));
  expectFailure(temp, /Caddy must start independently/);
  restore(temp, "infra/vps/compose.yml");

  mutate(temp, "infra/vps/compose.yml", (source) => source.replace(
    "@sha256:${FEATHER_ANALYTICS_IMAGE_DIGEST:?set FEATHER_ANALYTICS_IMAGE_DIGEST}",
    ":latest"
  ));
  expectFailure(temp, /assembled from a required repository and sha256 digest/);
  restore(temp, "infra/vps/compose.yml");

  mutate(temp, "infra/vps/Caddyfile", (source) => source.replace(" /internal/blocks", ""));
  expectFailure(temp, /Caddyfile is missing required token/);
  restore(temp, "infra/vps/Caddyfile");

  mutate(temp, "infra/vps/Caddyfile", (source) => source.replace(
    "\t\t\theader_up X-Forwarded-For {remote_host}\n",
    ""
  ));
  expectFailure(temp, /Caddyfile is missing required token: header_up/);
  restore(temp, "infra/vps/Caddyfile");

  mutate(temp, "infra/vps/Caddyfile", (source) => source.replace("max_size 64KB", "max_size 10MB"));
  expectFailure(temp, /Caddyfile is missing required token/);
  restore(temp, "infra/vps/Caddyfile");

  mutate(temp, "infra/vps/Caddyfile", (source) => source.replace(
    "@analytics_public path /graphql /events/candles /events/pools /token-images/*",
    "@analytics_public path /graphql /events/candles /events/pools /token-images/* /internal/debug"
  ));
  expectFailure(temp, /public analytics matcher must contain only/);
  restore(temp, "infra/vps/Caddyfile");

  mutate(temp, "infra/vps/compose.web.yml", (source) => source.replace(/@sha256:[0-9a-f]{64}/i, ":latest"));
  expectFailure(temp, /web-only Caddy image must use an immutable sha256 digest/);
  restore(temp, "infra/vps/compose.web.yml");

  mutate(temp, "infra/vps/compose.web.yml", (source) => source.replace(
    '      - "443:443/udp"',
    '      - "443:443/udp"\n      - "8787:8787/tcp"'
  ));
  expectFailure(temp, /web-only Caddy must publish only/);
  restore(temp, "infra/vps/compose.web.yml");

  mutate(temp, "infra/vps/compose.web.yml", (source) => source.replace(
    "  caddy:\n",
    "  analytics:\n    image: example.invalid/analytics:latest\n\n  caddy:\n"
  ));
  expectFailure(temp, /web-only compose services must be exactly caddy/);
  restore(temp, "infra/vps/compose.web.yml");

  mutate(temp, "infra/vps/compose.web.yml", (source) => source.replace(
    "        target: /srv/feather/releases\n        read_only: true",
    "        target: /srv/feather/releases\n        read_only: false"
  ));
  expectFailure(temp, /immutable release bind mounts must be read-only/);
  restore(temp, "infra/vps/compose.web.yml");

  mutate(temp, "infra/vps/Caddyfile.web", (source) => source.replace(
    "\t\trespond @private 404\n",
    "\t\treverse_proxy @private analytics:8787\n",
    ));
  expectFailure(temp, /must not proxy analytics or any other upstream/);
  restore(temp, "infra/vps/Caddyfile.web");

  mutate(temp, "infra/vps/Caddyfile.web", (source) => source.replaceAll(" /graphql/*", ""));
  expectFailure(temp, /reject the complete analytics and private path set/);
  restore(temp, "infra/vps/Caddyfile.web");

  mutate(temp, "infra/vps/host.web.env.example", (source) => source.replace(
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https:"
  ));
  expectFailure(temp, /allow only self and the reviewed Sepolia public RPC origin/);
  restore(temp, "infra/vps/host.web.env.example");

  mutate(temp, "infra/vps/host.web.env.example", (source) => source.replace(
    "/srv/feather/web/sepolia",
    "/srv/feather/web/mainnet"
  ));
  expectFailure(temp, /web-only release root must be \/srv\/feather\/web\/sepolia/);
  restore(temp, "infra/vps/host.web.env.example");

  mutate(temp, "infra/vps/analytics.env.example", (source) => `${source}\nANALYTICS_STATE_PATH=/var/lib/feather/checkpoint.json\n`);
  expectFailure(temp, /must not enable local checkpoint state/);
  restore(temp, "infra/vps/analytics.env.example");

  mutate(temp, "infra/vps/analytics.env.example", (source) => source.replace(
    /^ANALYTICS_RUNTIME_CUSTODY_SHA256=.*\n/m,
    ""
  ));
  expectFailure(temp, /analytics.env.example is missing required token: ANALYTICS_RUNTIME_CUSTODY_SHA256/);
  restore(temp, "infra/vps/analytics.env.example");

  mutate(temp, "infra/vps/analytics.env.example", (source) => source.replace(
    /^ANALYTICS_DATABASE_FAILURE_GRACE_MS=.*\n/m,
    ""
  ));
  expectFailure(temp, /analytics.env.example is missing required token: ANALYTICS_DATABASE_FAILURE_GRACE_MS/);

  console.log("VPS deployment validator adversarial tests passed.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function copyFixture(destination) {
  for (const relativePath of fixtureFiles) restore(destination, relativePath);
}

function restore(destination, relativePath) {
  const target = path.join(destination, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, relativePath), target);
}

function mutate(destination, relativePath, transform) {
  const target = path.join(destination, relativePath);
  fs.writeFileSync(target, transform(fs.readFileSync(target, "utf8")));
}

function expectFailure(fixtureRoot, pattern) {
  const result = run(fixtureRoot);
  assert.notEqual(result.status, 0, "validator unexpectedly accepted an unsafe fixture");
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

function run(fixtureRoot) {
  return childProcess.spawnSync(process.execPath, [validator, "--root", fixtureRoot], {
    cwd: root,
    encoding: "utf8"
  });
}
