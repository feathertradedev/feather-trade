#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256, validatePacket } = require("./validate-testnet-launch-packet.cjs");

const root = path.resolve(__dirname, "..", "..");
const defaultPacket = "docs/wave-2/evidence/testnet-launch-packet.json";

function parseArgs(argv) {
  const args = { check: false, packet: defaultPacket };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") args.check = true;
    else if (argv[index] === "--packet") args.packet = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!args.packet) throw new Error("--packet requires a path");
  return args;
}

function materialize(packet) {
  const artifacts = packet.artifacts.map((artifact) => {
    const contents = fs.readFileSync(path.resolve(root, artifact.path));
    return { ...artifact, sha256: sha256(contents), bytes: contents.length };
  });
  const manifestArtifact = artifacts.find((artifact) => artifact.id === "testnet-manifest");
  if (!manifestArtifact) throw new Error("testnet-manifest artifact is required");
  const manifest = JSON.parse(fs.readFileSync(path.resolve(root, manifestArtifact.path), "utf8"));
  return {
    ...packet,
    chainId: manifest.chainId,
    environment: manifest.environment,
    release: {
      ...packet.release,
      repositoryCommit: packet.release.evidenceSourceCommit,
      sourceJoeV2Commit: manifest.sourceJoeV2Commit
    },
    manifest: {
      path: manifestArtifact.path,
      sha256: manifestArtifact.sha256,
      startBlock: manifest.startBlock
    },
    artifacts
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const packetPath = path.resolve(root, args.packet);
    const original = fs.readFileSync(packetPath, "utf8");
    const packet = materialize(JSON.parse(original));
    const rendered = `${JSON.stringify(packet, null, 2)}\n`;
    const errors = validatePacket(packet, { root, commitMode: "ancestry" });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    if (args.check && rendered !== original) throw new Error(`${args.packet} is stale; run pnpm release:testnet-evidence:materialize`);
    if (!args.check) fs.writeFileSync(packetPath, rendered);
    console.log(args.check ? `Testnet evidence is reproducible: ${args.packet}` : `Materialized testnet evidence: ${args.packet}`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { materialize, parseArgs };
