#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "scripts/indexer/assert-graph-node-mappings.cjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-node-assertions-"));
const factory = "0x2222222222222222222222222222222222222222";
const pair = "0x1111111111111111111111111111111111111111";
const manifestPath = write("manifest.json", { contracts: { lbFactory: factory }, seededPools: { wethUsdc: { pair } } });

const response = {
  data: {
    _meta: { hasIndexingErrors: false, block: { number: 42, hash: `0x${"ab".repeat(32)}` } },
    factory: { id: factory, pairCount: "1" },
    pair: { id: pair, totalFeesX: "12", totalFeesY: "23", protocolFeesX: "3", protocolFeesY: "5" },
    bins: [{ id: `${pair}-1`, pair: { id: pair }, totalSupply: "1", reserveX: "1", reserveY: "1" }],
    positions: [{ id: "position-1", pair: { id: pair }, liquidity: "1" }],
    swaps: [{ id: "swap-1", pair: { id: pair }, transactionHash: `0x${"11".repeat(32)}`, totalFeeX: "5", totalFeeY: "11", protocolFeeX: "1", protocolFeeY: "2" }],
    liquidityEvents: [
      { id: "deposit", pair: { id: pair }, type: "DEPOSIT", ids: ["8388608"], amounts: ["0x01"], transactionHash: `0x${"22".repeat(32)}`, amountX: "1", amountY: "1" },
      { id: "withdraw", pair: { id: pair }, type: "WITHDRAW", ids: ["8388608"], amounts: ["0x01"], transactionHash: `0x${"33".repeat(32)}`, amountX: "1", amountY: "1" }
    ],
    feeEvents: [{ id: "composition", pair: { id: pair }, type: "COMPOSITION", totalFeeX: "7", totalFeeY: "12", protocolFeeX: "2", protocolFeeY: "3" }]
  }
};

const success = run(write("success.json", response));
assert.equal(success.status, 0, success.stderr || success.stdout);
const evidence = JSON.parse(success.stdout);
assert.equal(evidence.mappings.compositionFees, 1);
assert.equal(evidence.aggregateFees.totalFeeX, "12");
assert.equal(evidence.mappings.liquidityEvents, 2);

const missingComposition = structuredClone(response);
missingComposition.data.feeEvents = [];
const missingCompositionFailure = run(write("missing-composition.json", missingComposition));
assert.notEqual(missingCompositionFailure.status, 0);
assert.match(missingCompositionFailure.stderr, /composition-fee mapping is missing/i);

const wrongAggregate = structuredClone(response);
wrongAggregate.data.pair.totalFeesX = "13";
const wrongAggregateFailure = run(write("wrong-aggregate.json", wrongAggregate));
assert.notEqual(wrongAggregateFailure.status, 0);
assert.match(wrongAggregateFailure.stderr, /totalFeesX does not equal Swap plus CompositionFees rows/i);

const missingWithdraw = structuredClone(response);
missingWithdraw.data.liquidityEvents = missingWithdraw.data.liquidityEvents.filter((item) => item.type !== "WITHDRAW");
const missingWithdrawFailure = run(write("missing-withdraw.json", missingWithdraw));
assert.notEqual(missingWithdrawFailure.status, 0);
assert.match(missingWithdrawFailure.stderr, /deposit\/withdraw liquidity mappings are incomplete/i);

console.log("Graph Node mapping assertion fixtures passed.");

function run(responsePath) {
  return childProcess.spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GRAPH_NODE_E2E_ASSERT_ATTEMPTS: "1",
      GRAPH_NODE_E2E_RESPONSE_FILE: responsePath,
      LOCALNET_MANIFEST_PATH: manifestPath
    }
  });
}

function write(name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}
