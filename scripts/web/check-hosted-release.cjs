#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const LOCAL_MARKERS = [
  /\bdry-run\.json\b/i,
  /\blb\.localnet\.v1\b/i,
  /\blocalhost\b/i,
  /\b127(?:\.\d{1,3}){3}\b/,
  /\b0\.0\.0\.0\b/,
  /\[::1\]/i,
  /\bchainId["'\s:=]+31337\b/i,
  /\bVITE_PUBLIC_RELEASE_ENV["'\s:=]+localnet\b/i
];

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  if (!options.url) throw new Error("--url is required");
  if (!options.dist) throw new Error("--dist is required to bind the hosted release to a local artifact");

  const baseUrl = parseReleaseUrl(options.url, options.allowHttp);
  const dist = resolveDist(options.dist);
  const timeoutMs = parsePositiveInteger(options.timeoutMs ?? String(DEFAULT_TIMEOUT_MS), "--timeout-ms");
  const errors = [];
  const fetchedText = [];

  const root = await inspectUrl(baseUrl, { allowHttp: options.allowHttp, timeoutMs }, errors);
  if (!root) return finish(errors);
  validateDocument("root document", root, baseUrl, errors);
  validateArtifactDigest("root document", root, path.join(dist, "index.html"), errors);
  if (isTextResponse(root)) fetchedText.push([root.url.href, root.body]);

  const routeUrl = new URL(`__release-smoke-${crypto.randomBytes(6).toString("hex")}`, baseUrl);
  const route = await inspectUrl(routeUrl, { allowHttp: options.allowHttp, timeoutMs }, errors);
  if (route) {
    validateDocument("SPA route", route, baseUrl, errors);
    if (isTextResponse(route)) fetchedText.push([route.url.href, route.body]);
    if (root.response.ok && route.response.ok && documentFingerprint(root.body) !== documentFingerprint(route.body)) {
      errors.push("SPA route did not return the deployed index document");
    }
  }

  const assets = extractSameOriginAssets(root.body, root.url, baseUrl.origin, errors);
  if (assets.length === 0) errors.push("root document does not reference any same-origin script or stylesheet assets");
  for (const assetUrl of assets) {
    const asset = await inspectUrl(assetUrl, { allowHttp: options.allowHttp, timeoutMs }, errors);
    if (!asset) continue;
    if (!asset.response.ok) errors.push(`asset ${assetUrl.pathname} returned HTTP ${asset.response.status}`);
    validateArtifactDigest(`asset ${assetUrl.pathname}`, asset, artifactPath(dist, assetUrl.pathname), errors);
    const contentType = asset.response.headers.get("content-type") ?? "";
    if (assetUrl.pathname.endsWith(".js") && !/javascript|ecmascript/i.test(contentType)) {
      errors.push(`asset ${assetUrl.pathname} has unexpected Content-Type: ${contentType || "<missing>"}`);
    }
    if (assetUrl.pathname.endsWith(".css") && !/text\/css/i.test(contentType)) {
      errors.push(`asset ${assetUrl.pathname} has unexpected Content-Type: ${contentType || "<missing>"}`);
    }
    if (isHashedAsset(assetUrl.pathname)) validateImmutableCache(asset, errors);
    if (isTextResponse(asset)) fetchedText.push([asset.url.href, asset.body]);
  }

  for (const [url, body] of fetchedText) scanForLeakage(url, body, errors);
  finish(errors, `Hosted release smoke checks passed for ${baseUrl.href}`);
}

async function inspectUrl(url, options, errors) {
  let current = new URL(url);
  const seen = new Set();
  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    if (seen.has(current.href)) {
      errors.push(`redirect loop detected at ${current.href}`);
      return null;
    }
    seen.add(current.href);
    let response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { "user-agent": "robinhood-lb-hosted-release-smoke/1" }
      });
    } catch (error) {
      errors.push(`${current.href}: request failed: ${error.message}`);
      return null;
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      const body = await response.text();
      return { body, response, url: current };
    }
    const location = response.headers.get("location");
    if (!location) {
      errors.push(`${current.href}: redirect response is missing Location`);
      return null;
    }
    const next = new URL(location, current);
    if (current.protocol === "https:" && next.protocol !== "https:") {
      errors.push(`redirect downgrades HTTPS to ${next.protocol} at ${current.href}`);
      return null;
    }
    if (!options.allowHttp && next.protocol !== "https:") {
      errors.push(`redirect target must use HTTPS: ${next.href}`);
      return null;
    }
    if (next.origin !== new URL(url).origin) {
      errors.push(`redirect leaves the release origin: ${current.href} -> ${next.href}`);
      return null;
    }
    current = next;
  }
  errors.push(`${url.href}: exceeded ${MAX_REDIRECTS} redirects`);
  return null;
}

function validateDocument(label, result, baseUrl, errors) {
  if (!result.response.ok) errors.push(`${label} returned HTTP ${result.response.status}`);
  if (result.url.origin !== baseUrl.origin) errors.push(`${label} resolved outside the release origin`);
  const contentType = result.response.headers.get("content-type") ?? "";
  if (!/text\/html/i.test(contentType)) errors.push(`${label} must return text/html, got ${contentType || "<missing>"}`);
  validateSecurityHeaders(label, result.response.headers, errors);
  validateDocumentCache(label, result.response.headers, errors);
}

function validateSecurityHeaders(label, headers, errors) {
  if ((headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
    errors.push(`${label} is missing X-Content-Type-Options: nosniff`);
  }
  if (!headers.get("referrer-policy")) errors.push(`${label} is missing Referrer-Policy`);
  const hsts = headers.get("strict-transport-security") ?? "";
  const maxAge = Number(hsts.match(/(?:^|;)\s*max-age=(\d+)/i)?.[1] ?? -1);
  if (maxAge < 31_536_000) errors.push(`${label} HSTS max-age must be at least 31536000 seconds`);
  if (!/(?:^|;)\s*includeSubDomains(?:;|$)/i.test(hsts)) errors.push(`${label} HSTS must include includeSubDomains`);
  const csp = headers.get("content-security-policy");
  if (!csp) {
    errors.push(`${label} is missing Content-Security-Policy`);
    return;
  }
  for (const directive of ["default-src", "script-src", "connect-src", "frame-ancestors", "base-uri"]) {
    if (!new RegExp(`(?:^|;)\\s*${directive}\\s+`, "i").test(csp)) errors.push(`${label} CSP is missing ${directive}`);
  }
  validateCspSources(label, csp, "default-src", ["'self'"], errors);
  validateCspSources(label, csp, "script-src", ["'self'"], errors);
  validateCspSources(label, csp, "frame-ancestors", ["'none'"], errors);
  const baseSources = cspSources(csp, "base-uri");
  if (!baseSources.every((source) => ["'self'", "'none'"].includes(source))) {
    errors.push(`${label} CSP base-uri must be restricted to 'self' or 'none'`);
  }
  const connectSrc = csp.match(/(?:^|;)\s*connect-src\s+([^;]+)/i)?.[1] ?? "";
  for (const source of connectSrc.split(/\s+/)) {
    if (["http:", "https:", "ws:", "wss:", "*"].includes(source)) {
      errors.push(`${label} CSP connect-src contains broad source ${source}`);
    }
  }
  scanForLeakage(`${label} CSP`, csp, errors);
}

function validateCspSources(label, csp, directive, allowed, errors) {
  const sources = cspSources(csp, directive);
  if (sources.length === 0 || sources.some((source) => !allowed.includes(source))) {
    errors.push(`${label} CSP ${directive} must contain only ${allowed.join(" or ")}`);
  }
}

function cspSources(csp, directive) {
  return (csp.match(new RegExp(`(?:^|;)\\s*${directive}\\s+([^;]+)`, "i"))?.[1] ?? "")
    .trim().split(/\s+/).filter(Boolean);
}

function validateArtifactDigest(label, result, filePath, errors) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    errors.push(`${label} is missing from the local artifact`);
    return;
  }
  const local = fs.readFileSync(filePath);
  const hosted = Buffer.from(result.body);
  if (sha256(local) !== sha256(hosted)) errors.push(`${label} SHA-256 does not match the local artifact`);
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function resolveDist(value) {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("--dist must name an existing directory");
  return resolved;
}

function artifactPath(dist, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const resolved = path.resolve(dist, relative);
  return resolved.startsWith(`${dist}${path.sep}`) ? resolved : null;
}

function validateDocumentCache(label, headers, errors) {
  const cache = headers.get("cache-control") ?? "";
  if (!/(?:^|,)\s*(?:no-store|no-cache|max-age=0)\b/i.test(cache)) {
    errors.push(`${label} Cache-Control must prevent stale index caching`);
  }
}

function validateImmutableCache(result, errors) {
  const cache = result.response.headers.get("cache-control") ?? "";
  if (!/\bpublic\b/i.test(cache) || !/\bimmutable\b/i.test(cache) || !/\bmax-age=31536000\b/i.test(cache)) {
    errors.push(`hashed asset ${result.url.pathname} must use public, max-age=31536000, immutable caching`);
  }
}

function extractSameOriginAssets(html, documentUrl, releaseOrigin, errors) {
  const urls = new Set();
  const tags = html.match(/<(?:script|link)\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (/^<link/i.test(tag) && !/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) continue;
    const raw = tag.match(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!raw || raw.startsWith("data:")) continue;
    const asset = new URL(raw, documentUrl);
    if (asset.origin !== releaseOrigin) {
      errors.push(`document asset leaves the release origin: ${asset.href}`);
      continue;
    }
    urls.add(asset.href);
  }
  return [...urls].map((value) => new URL(value));
}

function scanForLeakage(label, text, errors) {
  for (const marker of LOCAL_MARKERS) {
    if (marker.test(text)) errors.push(`${label} contains local or dry-run release marker: ${marker.source}`);
  }
  for (const match of text.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`<>\\)]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (isLocalHost(url.hostname)) errors.push(`${label} contains local endpoint URL: ${url.href}`);
    } catch {}
  }
}

function parseReleaseUrl(value, allowHttp) {
  let url;
  try { url = new URL(value); } catch { throw new Error("--url must be an absolute URL"); }
  if (url.username || url.password) throw new Error("--url must not contain credentials");
  if (url.search || url.hash) throw new Error("--url must not contain a query string or fragment");
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error("--url must use HTTPS (use --allow-http only for local fixture tests)");
  }
  if (!allowHttp && (isLocalHost(url.hostname) || net.isIP(stripBrackets(url.hostname)))) {
    throw new Error("--url must use a named, non-local public host");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function isLocalHost(hostname) {
  const host = stripBrackets(hostname).toLowerCase();
  return host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1" ||
    host.endsWith(".localhost") || host.endsWith(".local") || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function stripBrackets(value) { return value.replace(/^\[|\]$/g, ""); }
function isTextResponse(result) { return /(?:text|javascript|json|xml|svg)/i.test(result.response.headers.get("content-type") ?? ""); }
function isHashedAsset(pathname) { return /\/assets\/[^/]*[.-][a-f0-9]{8,}[.-][^/]+$/i.test(pathname); }
function documentFingerprint(html) { return html.replace(/__release-smoke-[a-f0-9]+/g, "").replace(/\s+/g, " ").trim(); }

function parsePositiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer`);
  return number;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--allow-http") options.allowHttp = true;
    else if (arg === "--url" || arg === "--timeout-ms" || arg === "--dist") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg === "--url" ? "url" : arg === "--dist" ? "dist" : "timeoutMs"] = args[++index];
    } else throw new Error(`Unexpected argument ${arg}`);
  }
  return options;
}

function finish(errors, success) {
  if (errors.length > 0) {
    for (const error of [...new Set(errors)]) console.error(`- ${error}`);
    process.exitCode = 1;
  } else console.log(success);
}

function printHelp() {
  console.log(`Usage: node scripts/web/check-hosted-release.cjs --url <https://release.example/> --dist <apps/web/dist> [--timeout-ms 10000]\n\nChecks URL/TLS policy, redirects, SPA fallback, security and cache headers, local artifact digests, same-origin assets, and local/dry-run leakage.\n--allow-http is intended only for local fixture tests.`);
}
