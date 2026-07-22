#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const defaultRoot = path.resolve(__dirname, "../..");

function main() {
  const root = parseRoot(process.argv.slice(2));
  const errors = [];
  const files = {
    dockerignore: readRequired(root, ".dockerignore", errors),
    dockerfile: readRequired(root, "packages/analytics/Dockerfile", errors),
    compose: readRequired(root, "infra/vps/compose.yml", errors),
    caddy: readRequired(root, "infra/vps/Caddyfile", errors),
    hostEnv: readRequired(root, "infra/vps/host.env.example", errors),
    analyticsEnv: readRequired(root, "infra/vps/analytics.env.example", errors),
    readme: readRequired(root, "infra/vps/README.md", errors),
    custodyBuilder: readRequired(root, "scripts/release/build-analytics-runtime-custody.cjs", errors)
  };

  if (files.dockerignore !== null) validateDockerignore(files.dockerignore, errors);
  if (files.dockerfile !== null) validateDockerfile(files.dockerfile, errors);
  if (files.compose !== null) validateCompose(files.compose, errors);
  if (files.caddy !== null) validateCaddy(files.caddy, errors);
  if (files.hostEnv !== null) validateHostEnvironment(files.hostEnv, errors);
  if (files.analyticsEnv !== null) validateAnalyticsEnvironment(files.analyticsEnv, errors);
  if (files.readme !== null) validateRunbook(files.readme, errors);
  if (files.custodyBuilder !== null) validateCustodyBuilder(files.custodyBuilder, errors);

  if (errors.length > 0) {
    for (const error of errors) console.error(`VPS deployment validation: ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log("Validated VPS Docker context, images, isolation, Caddy routes, runtime examples, and runbook.");
}

function parseRoot(args) {
  if (args.length === 0) return defaultRoot;
  if (args.length === 2 && args[0] === "--root") return path.resolve(args[1]);
  throw new Error("Usage: validate-vps-deployment.cjs [--root <repository-root>]");
}

function readRequired(root, relativePath, errors) {
  const filePath = path.join(root, relativePath);
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      errors.push(`${relativePath} must be a regular file`);
      return null;
    }
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    errors.push(`${relativePath} is required: ${error.message}`);
    return null;
  }
}

function validateDockerignore(source, errors) {
  const lines = source.split(/\r?\n/).map((line) => line.trim());
  for (const pattern of [".git", ".env", ".env.*", "*.env", "**/.env", "**/.env.*", "**/*.env", ".local", "node_modules", "**/node_modules", "*.key", "*.pem", "*"]) {
    if (!lines.includes(pattern)) {
      errors.push(`.dockerignore must exclude ${pattern}`);
    }
  }
  for (const line of lines) {
    if (line.startsWith("!") && /(?:^|\/)\.env(?:\.|$)/.test(line) && !line.endsWith(".env.example")) {
      errors.push(`.dockerignore must not re-include secret environment files: ${line}`);
    }
  }
  for (const allowed of [
    "!package.json",
    "!pnpm-lock.yaml",
    "!pnpm-workspace.yaml",
    "!packages/analytics/Dockerfile",
    "!packages/analytics/package.json",
    "!packages/analytics/tsconfig.json",
    "!packages/analytics/schema.graphql",
    "!packages/analytics/src/*.ts"
  ]) {
    if (!lines.includes(allowed)) {
      errors.push(`.dockerignore analytics allowlist is missing ${allowed}`);
    }
  }

  if (lines.some((line) => line === "!packages/analytics/src/**" || line === "!packages/analytics/**")) {
    errors.push(".dockerignore must not broadly re-include the analytics source tree");
  }

  const sourceAllowIndex = lines.lastIndexOf("!packages/analytics/src/*.ts");
  for (const secretPattern of [
    ".env",
    ".env.*",
    "*.env",
    "**/.env",
    "**/.env.*",
    "**/*.env",
    ".npmrc",
    "**/.npmrc",
    "*.key",
    "*.pem",
    "*.p12",
    "*.pfx",
    ".local",
    ".local/**",
    "node_modules",
    "**/node_modules",
    ".pnpm-store",
    "**/.pnpm-store",
    "dist",
    "**/dist",
    "build",
    "**/build",
    "out",
    "**/out",
    "cache",
    "**/cache",
    "coverage",
    "**/coverage",
    "*.log",
    "*.tsbuildinfo"
  ]) {
    if (lines.lastIndexOf(secretPattern) <= sourceAllowIndex) {
      errors.push(`.dockerignore must re-assert ${secretPattern} after the analytics source allowlist`);
    }
  }
}

function validateDockerfile(source, errors) {
  const stages = new Set();
  const fromLines = [...source.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+(\S+))?\s*$/gmi)];
  if (fromLines.length < 2) errors.push("analytics Dockerfile must use separate build and runtime stages");
  for (const [, image, alias] of fromLines) {
    if (!stages.has(image.toLowerCase()) && !/@sha256:[0-9a-f]{64}$/i.test(image)) {
      errors.push(`analytics Dockerfile base image is not digest-pinned: ${image}`);
    }
    if (alias !== undefined) stages.add(alias.toLowerCase());
  }
  requireTokens(source, "analytics Dockerfile", [
    "pnpm install --frozen-lockfile --prod --filter @robinhood-lb/analytics...",
    "pnpm --filter @robinhood-lb/analytics build",
    "USER node",
    "ANALYTICS_DATABASE_URL is required",
    "ANALYTICS_PRICE_VERIFIER_MODULE is required",
    "ANALYTICS_BLOCK_SOURCE_MODULE is required",
    "ANALYTICS_POSITION_SNAPSHOT_MODULE is required",
    "ANALYTICS_DEPLOYMENT_IDENTITY is required",
    "ANALYTICS_RUNTIME_CUSTODY is required",
    "ANALYTICS_RUNTIME_CUSTODY_SHA256 is required"
  ], errors);
  if (/^\s*(?:COPY|ADD)\s+(?:--\S+\s+)*\.\s+/mi.test(source)) {
    errors.push("analytics Dockerfile must not copy the complete repository context");
  }
  if (/^\s*ARG\s+.*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL)/mi.test(source)) {
    errors.push("analytics Dockerfile must not accept secret build arguments");
  }
}

function validateCompose(source, errors) {
  const services = serviceNames(source);
  if (services.join(",") !== "analytics,caddy") {
    errors.push(`compose services must be exactly analytics and caddy, found ${services.join(",") || "none"}`);
  }
  const analytics = serviceBlock(source, "analytics");
  const caddy = serviceBlock(source, "caddy");
  if (analytics === null || caddy === null) {
    errors.push("compose must define analytics and caddy service blocks");
    return;
  }

  if (/^\s{4}ports:/m.test(analytics)) errors.push("analytics service must not publish ports");
  if (!/^\s{4}expose:\s*$[\s\S]*?^\s{6}- ["']?8787["']?\s*$/m.test(analytics)) {
    errors.push("analytics service must expose only its internal port 8787");
  }
  if (!/^\s{4}ports:/m.test(caddy)) errors.push("Caddy must be the public port owner");
  requireTokens(analytics, "analytics service", [
    "read_only: true",
    "no-new-privileges:true",
    "cap_drop:",
    "- ALL",
    "ANALYTICS_HOST: 0.0.0.0",
    "ANALYTICS_CORS_ORIGINS: https://${FEATHER_APP_DOMAIN:?set FEATHER_APP_DOMAIN}",
    "ANALYTICS_TRUST_PROXY: \"true\"",
    "ANALYTICS_MAX_STREAMS_PER_IP: ${FEATHER_ANALYTICS_MAX_STREAMS_PER_IP:-20}",
    "ANALYTICS_GRAPHQL_REQUESTS_PER_MINUTE: ${FEATHER_ANALYTICS_GRAPHQL_REQUESTS_PER_MINUTE:-120}",
    "ANALYTICS_GRAPHQL_RATE_LIMIT_CLIENTS: ${FEATHER_ANALYTICS_GRAPHQL_RATE_LIMIT_CLIENTS:-4096}",
    "ANALYTICS_POSITION_SNAPSHOT_TIMEOUT_MS: ${FEATHER_ANALYTICS_POSITION_SNAPSHOT_TIMEOUT_MS:-5000}",
    "ANALYTICS_DATABASE_KEEPALIVE_INITIAL_DELAY_MS: ${FEATHER_ANALYTICS_DATABASE_KEEPALIVE_INITIAL_DELAY_MS:-10000}",
    "ANALYTICS_DATABASE_HEALTH_INTERVAL_MS: ${FEATHER_ANALYTICS_DATABASE_HEALTH_INTERVAL_MS:-5000}",
    "ANALYTICS_DATABASE_FAILURE_GRACE_MS: ${FEATHER_ANALYTICS_DATABASE_FAILURE_GRACE_MS:-120000}",
    "cpus: \"${FEATHER_ANALYTICS_CPUS:-2.0}\"",
    "mem_limit: ${FEATHER_ANALYTICS_MEMORY_LIMIT:-2g}",
    "fetch('http://127.0.0.1:8787/readyz')",
    "target: /run/feather/config",
    "target: /run/feather/adapters",
    "logging: *bounded-logging"
  ], errors);
  requireTokens(caddy, "Caddy service", [
    "caddy:2.10.2-alpine@sha256:",
    "read_only: true",
    "no-new-privileges:true",
    "cap_drop:",
    "cap_add:",
    "NET_BIND_SERVICE",
    "cpus: \"${FEATHER_CADDY_CPUS:-1.0}\"",
    "mem_limit: ${FEATHER_CADDY_MEMORY_LIMIT:-512m}",
    '"80:80/tcp"',
    '"443:443/tcp"',
    '"443:443/udp"',
    "target: /srv/feather/releases",
    "logging: *bounded-logging"
  ], errors);

  const caddyImage = caddy.match(/^\s{4}image:\s*(\S+)\s*$/m)?.[1];
  if (!caddyImage || !/@sha256:[0-9a-f]{64}$/i.test(caddyImage)) {
    errors.push("Caddy image must use an immutable sha256 digest");
  }
  if (!source.includes("FEATHER_ANALYTICS_IMAGE_REPOSITORY:?") ||
      !source.includes("@sha256:${FEATHER_ANALYTICS_IMAGE_DIGEST:?")) {
    errors.push("analytics image must be assembled from a required repository and sha256 digest");
  }
  if (/^\s{4}depends_on:/m.test(caddy)) {
    errors.push("Caddy must start independently of fail-closed analytics");
  }
  for (const forbidden of ["/var/run/docker.sock", "privileged: true", "network_mode: host", "image: postgres", "image: mysql", "image: mariadb"]) {
    if (source.toLowerCase().includes(forbidden.toLowerCase())) errors.push(`compose contains forbidden deployment capability: ${forbidden}`);
  }
  if (!/^\s{2}backend:\s*$[\s\S]*?^\s{4}internal:\s*true\s*$/m.test(source)) {
    errors.push("compose backend network must be internal");
  }
  if ((source.match(/^\s{4}ports:/gm) ?? []).length !== 1) {
    errors.push("only one service may publish ports");
  }
  const readonlyBinds = (source.match(/^\s{8}read_only:\s*true\s*$/gm) ?? []).length;
  if (readonlyBinds < 4) errors.push("release, Caddyfile, analytics config, and adapter bind mounts must be read-only");
}

function validateCaddy(source, errors) {
  requireTokens(source, "Caddyfile", [
    "admin off",
    "read_header 10s",
    "read_body 15s",
    "idle 2m",
    "max_header_size 64KB",
    "output stdout",
    "format json",
    "Strict-Transport-Security \"max-age=31536000; includeSubDomains\"",
    "Cross-Origin-Opener-Policy \"same-origin-allow-popups\"",
    "{$FEATHER_APP_DOMAIN}",
    "{$FEATHER_DOCS_DOMAIN}",
    "https://{$FEATHER_DOCS_DOMAIN}{uri} 308",
    "https://{$FEATHER_APP_DOMAIN}{uri} 308",
    "@analytics_public path /graphql /events/candles /events/pools",
    "@analytics_graphql path /graphql",
    "request_body @analytics_graphql",
    "max_size 64KB",
    "reverse_proxy @analytics_public analytics:8787",
    "header_up X-Forwarded-For {remote_host}",
    "flush_interval -1",
    "wss://relay.walletconnect.com",
    "https://verify.walletconnect.com",
    "https://fonts.reown.com",
    "@private path /livez /readyz /metrics /internal/blocks /_headers /_redirects /_worker.js",
    "respond @private 404",
    "/srv/feather/releases/current",
    "public, max-age=31536000, immutable",
    "Cache-Control \"no-store\"",
    "connect-src 'none'"
  ], errors);
  if ((source.match(/\breverse_proxy\b/g) ?? []).length !== 1) {
    errors.push("Caddyfile must contain exactly one explicitly matched reverse proxy");
  }
  if (/reverse_proxy\s+(?!@analytics_public\b)/.test(source)) {
    errors.push("Caddyfile reverse proxy must use the exact public analytics matcher");
  }
  const publicMatcher = source.match(/^\s*@analytics_public\s+path\s+(.+)$/m)?.[1]?.trim();
  if (publicMatcher !== "/graphql /events/candles /events/pools") {
    errors.push("Caddyfile public analytics matcher must contain only the implemented GraphQL and SSE paths");
  }
}

function validateHostEnvironment(source, errors) {
  requireTokens(source, "host.env.example", [
    "FEATHER_ANALYTICS_IMAGE_REPOSITORY=",
    "FEATHER_ANALYTICS_IMAGE_DIGEST=REPLACE_WITH_64_HEX_CHARACTERS",
    "FEATHER_ANALYTICS_CPUS=2.0",
    "FEATHER_ANALYTICS_MEMORY_LIMIT=2g",
    "FEATHER_ANALYTICS_MAX_STREAMS_PER_IP=20",
    "FEATHER_ANALYTICS_GRAPHQL_REQUESTS_PER_MINUTE=120",
    "FEATHER_ANALYTICS_GRAPHQL_RATE_LIMIT_CLIENTS=4096",
    "FEATHER_ANALYTICS_POSITION_SNAPSHOT_TIMEOUT_MS=5000",
    "FEATHER_ANALYTICS_DATABASE_KEEPALIVE_INITIAL_DELAY_MS=10000",
    "FEATHER_ANALYTICS_DATABASE_HEALTH_INTERVAL_MS=5000",
    "FEATHER_ANALYTICS_DATABASE_FAILURE_GRACE_MS=120000",
    "FEATHER_CADDY_CPUS=1.0",
    "FEATHER_CADDY_MEMORY_LIMIT=512m",
    "FEATHER_APP_DOMAIN=",
    "FEATHER_DOCS_DOMAIN=",
    "FEATHER_APP_CONNECT_SRC=",
    "FEATHER_ANALYTICS_ENV_FILE=",
    "FEATHER_ANALYTICS_CONFIG_DIR=",
    "FEATHER_ANALYTICS_ADAPTERS_DIR=",
    "FEATHER_RELEASES_DIR="
  ], errors);
  if (/FEATHER_APP_CONNECT_SRC=.*(?:https:|wss:|\*)\s*(?:["']?)$/m.test(source) && !source.includes("REPLACE_INDEXER_ORIGIN")) {
    errors.push("host environment example must not recommend a broad CSP source");
  }
}

function validateAnalyticsEnvironment(source, errors) {
  requireTokens(source, "analytics.env.example", [
    "ANALYTICS_DATABASE_URL=postgresql://",
    "sslmode=verify-full",
    "ANALYTICS_DATABASE_SCHEMA=",
    "ANALYTICS_ENVIRONMENT=mainnet",
    "ANALYTICS_DEPLOYMENT_IDENTITY=mainnet:",
    "ANALYTICS_RUNTIME_CUSTODY=/run/feather/config/runtime-custody.json",
    "ANALYTICS_RUNTIME_CUSTODY_SHA256=REPLACE_WITH_64_HEX_CHARACTERS_FROM_CUSTODY_BUILD",
    "ANALYTICS_PRICE_POLICIES=/run/feather/config/",
    "ANALYTICS_PRICE_VERIFIER_MODULE=/run/feather/adapters/",
    "ANALYTICS_BLOCK_SOURCE_MODULE=/run/feather/adapters/",
    "ANALYTICS_POSITION_SNAPSHOT_MODULE=/run/feather/adapters/",
    "ANALYTICS_CORS_ORIGINS=",
    "ANALYTICS_READINESS_TIMEOUT_MS=",
    "ANALYTICS_POSITION_SNAPSHOT_TIMEOUT_MS=",
    "ANALYTICS_DATABASE_KEEPALIVE_INITIAL_DELAY_MS=",
    "ANALYTICS_DATABASE_HEALTH_INTERVAL_MS=",
    "ANALYTICS_DATABASE_FAILURE_GRACE_MS=",
    "ANALYTICS_SHUTDOWN_TIMEOUT_MS="
  ], errors);
  if (/^ANALYTICS_STATE_PATH=/m.test(source)) errors.push("production analytics example must not enable local checkpoint state");
  if (/^ANALYTICS_ALLOW_FIXED_TEST_PRICES=1/m.test(source)) errors.push("production analytics example must not enable fixed test prices");
}

function validateRunbook(source, errors) {
  requireTokens(source, "VPS runbook", [
    "not a claim that production analytics",
    "fail closed",
    "canonical block source",
    "Chainlink report verifier",
    "position snapshot provider",
    "managed PostgreSQL",
    "PgBouncer session pooling",
    "pnpm analytics:custody:build",
    "same process never reacquires the lease",
    "continuous failures",
    "FEATHER_ANALYTICS_POSITION_SNAPSHOT_TIMEOUT_MS",
    "FEATHER_ANALYTICS_DATABASE_FAILURE_GRACE_MS",
    "FEATHER_ANALYTICS_CPUS",
    "feather-deploy",
    "WEB_REOWN_PROJECT_ID",
    "current -> releases/<commit>/dist",
    "## Roll back",
    "/readyz"
  ], errors);
}

function validateCustodyBuilder(source, errors) {
  requireTokens(source, "analytics custody builder", [
    "price-policies.json",
    "chainlink-verifier.mjs",
    "canonical-block-source.mjs",
    "position-snapshot-provider.mjs",
    "O_NOFOLLOW",
    "ANALYTICS_RUNTIME_CUSTODY_SHA256=",
    "JSON.stringify(inventory, null, 2)"
  ], errors);
}

function serviceNames(source) {
  const start = source.indexOf("services:\n");
  const end = source.indexOf("\nnetworks:", start);
  if (start < 0 || end < 0) return [];
  return [...source.slice(start, end).matchAll(/^  ([a-z][a-z0-9_-]*):\s*$/gm)].map((match) => match[1]);
}

function serviceBlock(source, name) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const after = start + marker.length;
  const candidates = [];
  const nextService = source.slice(after).search(/^  [a-z][a-z0-9_-]*:\s*$/m);
  if (nextService >= 0) candidates.push(after + nextService);
  for (const topLevel of ["\nnetworks:", "\nvolumes:"]) {
    const position = source.indexOf(topLevel, after);
    if (position >= 0) candidates.push(position + 1);
  }
  const end = candidates.length === 0 ? source.length : Math.min(...candidates);
  return source.slice(start, end);
}

function requireTokens(source, label, tokens, errors) {
  for (const token of tokens) {
    if (!source.includes(token)) errors.push(`${label} is missing required token: ${token}`);
  }
}

if (require.main === module) main();

module.exports = { validateCaddy, validateCompose, validateDockerfile, validateDockerignore };
