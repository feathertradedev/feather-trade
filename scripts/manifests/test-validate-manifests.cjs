#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const validator = path.join(repoRoot, "scripts/manifests/validate-manifests.cjs");
const legacyRoutingSlots = [
  "routerFactoryV1",
  "routerFactoryV2_1",
  "routerLegacyFactoryV2",
  "routerLegacyRouterV2"
];
const nonzeroLegacyRouter = "0x9999999999999999999999999999999999999999";
const fixtures = [
  "deployments/examples/localnet.example.json",
  "deployments/examples/robinhood-testnet.example.json"
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-routing-policy-test-"));

try {
  for (const fixture of fixtures) {
    const baseline = JSON.parse(fs.readFileSync(path.join(repoRoot, fixture), "utf8"));

    for (const slot of legacyRoutingSlots) {
      const manifestPath = path.join(dir, `${baseline.environment}-${slot}.json`);
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify(
          {
            ...baseline,
            constructorArgs: {
              ...baseline.constructorArgs,
              [slot]: nonzeroLegacyRouter
            }
          },
          null,
          2
        )}\n`
      );

      const result = childProcess.spawnSync(process.execPath, [validator, manifestPath], {
        cwd: repoRoot,
        encoding: "utf8"
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (result.status === 0) {
        throw new Error(`${fixture} with nonzero ${slot} should fail manifest validation`);
      }
      if (!new RegExp(`${slot}.*zero address.*V2\\.2-only routing`, "i").test(output)) {
        throw new Error(`${fixture} with nonzero ${slot} failed for the wrong reason:\n${output}`);
      }
    }
  }

  console.log("manifest legacy-routing negative fixtures passed");
} finally {
  fs.rmSync(dir, { force: true, recursive: true });
}
