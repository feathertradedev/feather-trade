#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const errors = [];
  if (typeof options.manifest !== "string") errors.push("--manifest is required");
  if (typeof options.dist !== "string") errors.push("--dist is required");
  if (errors.length > 0) return finish(errors);

  const manifestPath = path.resolve(repoRoot, options.manifest);
  const distPath = path.resolve(repoRoot, options.dist);
  const manifest = readJson(manifestPath, errors);
  if (!fs.existsSync(distPath) || !fs.statSync(distPath).isDirectory()) {
    errors.push(`${display(distPath)}: dist directory does not exist`);
  }
  if (errors.length > 0) return finish(errors);

  const origins = endpointOrigins(manifest, options.analytics, errors);
  if (errors.length > 0) return finish(errors);

  const headersPath = path.join(distPath, "_headers");
  fs.writeFileSync(headersPath, renderHeaders(origins));
  console.log(`Wrote public headers to ${display(headersPath)}.`);
}

function endpointOrigins(manifest, analytics, errors) {
  const origins = new Set();
  for (const [field, value] of Object.entries(manifest.endpoints ?? {})) {
    if (!["rpcUrl", "indexerUrl", "apiUrl", "tokenListUrl"].includes(field)) continue;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string") {
      errors.push(`manifest.endpoints.${field}: expected URL string`);
      continue;
    }

    let url;
    try {
      url = new URL(value);
    } catch {
      errors.push(`manifest.endpoints.${field}: expected absolute URL`);
      continue;
    }

    if (url.protocol !== "https:") {
      errors.push(`manifest.endpoints.${field}: public headers only allow https endpoints`);
      continue;
    }

    origins.add(url.origin);
  }

  if (analytics !== undefined && analytics !== "") {
    if (typeof analytics !== "string") {
      errors.push("--analytics: expected URL string");
    } else {
      try {
        const url = new URL(analytics);
        if (url.protocol !== "https:") errors.push("--analytics: public headers only allow https endpoints");
        else origins.add(url.origin);
      } catch {
        errors.push("--analytics: expected absolute URL");
      }
    }
  }

  return [...origins].sort();
}

function renderHeaders(origins) {
  const connectSrc = ["'self'", ...origins].join(" ");
  return `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ${connectSrc}; frame-ancestors 'none'; base-uri 'self'; form-action 'none'

/index.html
  Cache-Control: no-store

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/token-assets/*
  Cache-Control: public, max-age=3600, must-revalidate
`;
}

function readJson(filePath, errors) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${display(filePath)}: ${error.message}`);
    return {};
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    options[toCamelCase(arg.slice(2))] = next;
    index += 1;
  }
  return options;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function display(filePath) {
  return path.relative(repoRoot, filePath);
}

function finish(errors) {
  if (errors.length === 0) return;
  for (const error of errors) console.error(error);
  process.exitCode = 1;
}

function printHelp() {
  console.log("Usage: node scripts/web/write-public-headers.cjs --manifest <path> --dist <apps/web/dist> [--analytics <https-url>]");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
