#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const checker = path.join(__dirname, "check-hosted-release.cjs");
const fixtureDir = path.join(__dirname, "test/fixtures/hosted-release");
const indexHtml = fs.readFileSync(path.join(fixtureDir, "index.html"), "utf8");
const js = fs.readFileSync(path.join(fixtureDir, "assets/index-1234abcd.js"), "utf8");
const css = fs.readFileSync(path.join(fixtureDir, "assets/index-1234abcd.css"), "utf8");

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await withServer({}, async (url) => expectPass("healthy hosted release", url));
  await withServer({ rootRedirect: true }, async (url) => expectPass("same-origin root redirect", url));
  await withServer({ crossOriginRedirect: true }, async (url) => expectFail("cross-origin redirect", url, /redirect leaves the release origin/i));
  await withServer({ spaMissing: true }, async (url) => expectFail("missing SPA fallback", url, /SPA route returned HTTP 404|deployed index document/i));
  await withServer({ broadCsp: true }, async (url) => expectFail("broad CSP", url, /connect-src contains broad source https:/i));
  await withServer({ unsafeScript: true }, async (url) => expectFail("unsafe script CSP", url, /script-src must contain only/i));
  await withServer({ weakHsts: true }, async (url) => expectFail("weak HSTS", url, /HSTS max-age|includeSubDomains/i));
  await withServer({ staleIndex: true }, async (url) => expectFail("stale index cache", url, /prevent stale index caching/i));
  await withServer({ mutableAssets: true }, async (url) => expectFail("mutable hashed asset", url, /must use public.*immutable caching/i));
  await withServer({ leakedBundle: true }, async (url) => expectFail("local bundle leakage", url, /local endpoint URL|local or dry-run release marker/i));
  await withServer({ missingAsset: true }, async (url) => expectFail("missing asset", url, /asset .* returned HTTP 404/i));
  await withServer({ changedArtifact: true }, async (url) => expectFail("release artifact mismatch", url, /SHA-256 does not match/i));

  const insecure = await runChecker("http://release.example/");
  assert.notEqual(insecure.status, 0);
  assert.match(`${insecure.stdout}\n${insecure.stderr}`, /must use HTTPS/i);
  console.log("hosted release smoke fixture tests passed");
}

async function expectPass(name, url) {
  const result = await runChecker(url, true);
  assert.equal(result.status, 0, `${name} should pass:\n${result.stdout}\n${result.stderr}`);
}

async function expectFail(name, url, pattern) {
  const result = await runChecker(url, true);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `${name} should fail`);
  assert.match(output, pattern, `${name} produced unexpected output:\n${output}`);
}

function runChecker(url, allowHttp = false) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [checker, "--url", url, "--dist", fixtureDir, ...(allowHttp ? ["--allow-http"] : [])], {
      cwd: repoRoot
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr, stdout }));
  });
}

async function withServer(state, callback) {
  const server = http.createServer((request, response) => {
    const securityHeaders = {
      "content-security-policy": `default-src 'self'; script-src 'self'${state.unsafeScript ? " 'unsafe-inline'" : ""}; connect-src ${state.broadCsp ? "https:" : "'self' https://rpc.example"}; frame-ancestors 'none'; base-uri 'self'`,
      "referrer-policy": "strict-origin-when-cross-origin",
      "strict-transport-security": state.weakHsts ? "max-age=300" : "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff"
    };
    if (request.url === "/" && state.crossOriginRedirect) {
      response.writeHead(302, { location: "https://preview-host.example/" });
      return response.end();
    }
    if (request.url === "/" && state.rootRedirect) {
      response.writeHead(302, { location: "/app/" });
      return response.end();
    }
    if (request.url === "/assets/index-1234abcd.js") {
      if (state.missingAsset) return send(response, 404, "missing", { "content-type": "text/plain" });
      return send(response, 200, state.leakedBundle ? `${js}\nfetch("http://127.0.0.1:8545")` : js, {
        "cache-control": state.mutableAssets ? "public, max-age=60" : "public, max-age=31536000, immutable",
        "content-type": "text/javascript"
      });
    }
    if (request.url === "/assets/index-1234abcd.css") {
      return send(response, 200, css, {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": "text/css"
      });
    }
    if (state.spaMissing && request.url.startsWith("/__release-smoke-")) {
      return send(response, 404, "missing", { ...securityHeaders, "cache-control": "no-store", "content-type": "text/html" });
    }
    return send(response, 200, state.changedArtifact ? indexHtml.replace("Hosted release fixture", "Different release") : indexHtml, {
      ...securityHeaders,
      "cache-control": state.staleIndex ? "public, max-age=86400" : "no-store",
      "content-type": "text/html"
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}/`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function send(response, status, body, headers) {
  response.writeHead(status, headers);
  response.end(body);
}
