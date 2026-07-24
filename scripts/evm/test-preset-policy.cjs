#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  calculateFeeBounds,
  parseCastArray,
  parsePresetOutput,
  presetArguments,
  validatePolicy
} = require("./check-preset-policy.cjs");

const policy = validatePolicy(JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../deployments/evm/sepolia/preset-policy.json"),
  "utf8"
)));
assert.deepEqual(policy.presets.map((preset) => preset.binStep), [10, 20]);
assert.equal(policy.evidence.parameterReference, "contracts/joe-v2/script/config/bips-config.sol");
assert.match(policy.evidence.adaptation, /Step 20 halves baseFactor and variableFeeControl/);
for (const preset of policy.presets) {
  assert.deepEqual(calculateFeeBounds(preset), {
    minimumFeeRateE18: 1_000_000_000_000_000n,
    maximumFeeRateE18: 5_900_000_000_000_000n
  });
  assert.equal(presetArguments(preset).length, 9);
}
assert.deepEqual(parseCastArray("[10, 20]"), [10, 20]);
assert.deepEqual(parseCastArray("[]"), []);
assert.deepEqual(parsePresetOutput([
  "10000 [1e4]",
  "30",
  "600",
  "5000",
  "40000 [4e4]",
  "0",
  "350000 [3.5e5]",
  "true"
].join("\n")), {
  baseFactor: 10000,
  filterPeriod: 30,
  decayPeriod: 600,
  reductionFactor: 5000,
  variableFeeControl: 40000,
  protocolShare: 0,
  maxVolatilityAccumulator: 350000,
  open: true
});
assert.throws(
  () => validatePolicy({
    ...policy,
    presets: [{ ...policy.presets[0], maximumFeeRateE18: "1" }]
  }),
  /maximumFeeRateE18 is incorrect/
);
assert.throws(
  () => validatePolicy({
    ...policy,
    approval: { ...policy.approval, mainnetPolicy: "reuse-sepolia" }
  }),
  /mainnet policy/
);

console.log("Sepolia preset policy fixture passed: curated steps, exact parameters, fee bounds, parser behavior, and separate mainnet approval.");
