#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

try {
  const options = parseArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  if (options["validate-url"]) {
    const deployedOrigin = canonicalPublicOrigin(options["validate-url"]);
    if (!options["github-output"]) throw new Error("--github-output is required");
    fs.appendFileSync(path.resolve(options["github-output"]), `deployed_origin=${deployedOrigin}\n`);
    console.log(`Validated deployed origin ${deployedOrigin}`);
    return;
  }
  for (const name of ["environment", "commit", "deployed-url", "output", "outcome"]) {
    if (!options[name]) throw new Error(`--${name} is required`);
  }
  if (!["sepolia", "testnet", "mainnet"].includes(options.environment)) throw new Error("invalid environment");
  if (!/^[0-9a-f]{40}$/.test(options.commit)) throw new Error("invalid immutable commit");
  if (!["promoted", "failed", "blocked"].includes(options.outcome)) throw new Error("invalid outcome");
  const custody = readCustody(options.custody, options.commit, options.environment);
  const deployedOrigin = canonicalPublicOrigin(options["deployed-url"]);
  const now = new Date().toISOString();
  const base = {
    schemaVersion: "robinhood.web-promotion-evidence.v1",
    environment: options.environment,
    repositoryCommit: options.commit,
    custodyStatus: custody ? "available" : "unavailable",
    deployedOrigin,
    workflowRun: process.env.GITHUB_RUN_ID ? `github-run:${process.env.GITHUB_RUN_ID}` : "local-run",
    recordedAt: now
  };
  if (custody) {
    base.manifestSha256 = custody.files.find((file) => file.path === "manifest.json")?.sha256;
    base.artifactArchiveSha256 = custody.archiveSha256;
  }
  const output = path.resolve(options.output);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "promotion.json"), `${JSON.stringify({ ...base, outcome: options.outcome }, null, 2)}\n`);
  fs.writeFileSync(path.join(output, "rollback-readiness.json"), `${JSON.stringify({
    ...base,
    schemaVersion: "robinhood.web-rollback-readiness.v1",
    readiness: "operator-action-required",
    proposedTarget: "last-approved-custody-artifact",
    requiredVerification: "hosted smoke against the restored custody artifact"
  }, null, 2)}\n`);
  console.log(`Wrote sanitized promotion and rollback-readiness evidence to ${output}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function canonicalPublicOrigin(value) {
  if (value !== value.trim()) throw new Error("deployed URL must not contain surrounding whitespace");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("deployed URL must be credential-free HTTPS");
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("deployed URL must be an origin without a path, query, or fragment");
  return url.origin;
}

function readCustody(file, commit, environment) {
  if (!file || !fs.existsSync(path.resolve(file))) return null;
  try {
    const custody = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    if (custody.repositoryCommit !== commit || custody.environment !== environment) return null;
    if (!Array.isArray(custody.files) || typeof custody.archiveSha256 !== "string") return null;
    return custody;
  } catch {
    return null;
  }
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error("invalid arguments");
    result[args[index].slice(2)] = args[index + 1];
  }
  return result;
}
