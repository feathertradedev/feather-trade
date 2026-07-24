#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_POLICY = path.join(ROOT, "deployments/evm/sepolia/preset-policy.json");
const DEFAULT_MANIFEST = path.join(ROOT, "deployments/evm/sepolia/public.json");
const SET_PRESET_SIGNATURE = "setPreset(uint16,uint16,uint16,uint16,uint16,uint24,uint16,uint24,bool)";

function calculateFeeBounds(preset) {
  const binStep = BigInt(preset.binStep);
  const baseFactor = BigInt(preset.baseFactor);
  const variableFeeControl = BigInt(preset.variableFeeControl);
  const maxVolatilityAccumulator = BigInt(preset.maxVolatilityAccumulator);
  const minimumFeeRateE18 = baseFactor * binStep * 10_000_000_000n;
  const maximumProduct = maxVolatilityAccumulator * binStep;
  const maximumVariableFeeRateE18 = variableFeeControl === 0n
    ? 0n
    : (maximumProduct * maximumProduct * variableFeeControl + 99n) / 100n;
  return {
    minimumFeeRateE18,
    maximumFeeRateE18: minimumFeeRateE18 + maximumVariableFeeRateE18
  };
}

function validatePolicy(policy) {
  const errors = [];
  if (policy?.schemaVersion !== "feather.factory-preset-policy.v1") errors.push("unsupported schemaVersion");
  if (!Number.isSafeInteger(policy?.chainId) || policy.chainId <= 0) errors.push("chainId must be positive");
  if (!isAddress(policy?.factory)) errors.push("factory must be an address");
  if (!isAddress(policy?.owner)) errors.push("owner must be an address");
  if (!Array.isArray(policy?.presets) || policy.presets.length === 0) errors.push("presets must be non-empty");
  const seen = new Set();
  for (const [index, preset] of (policy?.presets ?? []).entries()) {
    const label = `presets[${index}]`;
    const keys = [
      "binStep",
      "baseFactor",
      "filterPeriod",
      "decayPeriod",
      "reductionFactor",
      "variableFeeControl",
      "protocolShare",
      "maxVolatilityAccumulator"
    ];
    for (const key of keys) {
      if (!Number.isSafeInteger(preset?.[key]) || preset[key] < 0) {
        errors.push(`${label}.${key} must be a non-negative integer`);
      }
    }
    if (preset?.binStep <= 0 || preset?.binStep > 65_535) errors.push(`${label}.binStep must fit a nonzero uint16`);
    if (seen.has(preset?.binStep)) errors.push(`${label}.binStep is duplicated`);
    seen.add(preset?.binStep);
    if (typeof preset?.open !== "boolean") errors.push(`${label}.open must be boolean`);
    if (typeof preset?.marketProfile !== "string" || preset.marketProfile.length === 0) {
      errors.push(`${label}.marketProfile is required`);
    }
    if (!/^\d+$/.test(preset?.minimumFeeRateE18 ?? "") || !/^\d+$/.test(preset?.maximumFeeRateE18 ?? "")) {
      errors.push(`${label} fee bounds must be unsigned E18 decimals`);
    } else if (keys.every((key) => Number.isSafeInteger(preset?.[key]))) {
      const calculated = calculateFeeBounds(preset);
      if (calculated.minimumFeeRateE18.toString() !== preset.minimumFeeRateE18) {
        errors.push(`${label}.minimumFeeRateE18 is incorrect`);
      }
      if (calculated.maximumFeeRateE18.toString() !== preset.maximumFeeRateE18) {
        errors.push(`${label}.maximumFeeRateE18 is incorrect`);
      }
      if (calculated.maximumFeeRateE18 > 100_000_000_000_000_000n) {
        errors.push(`${label} exceeds the protocol 10% fee limit`);
      }
    }
  }
  if (policy?.approval?.mainnetPolicy !== "separate-explicit-approval-required") {
    errors.push("mainnet policy must require separate explicit approval");
  }
  if (policy?.provisioning?.simulationRequired !== true || policy?.provisioning?.ownerOnly !== true) {
    errors.push("provisioning must be simulation-first and owner-only");
  }
  if (errors.length > 0) throw new Error(`Invalid preset policy:\n- ${errors.join("\n- ")}`);
  return policy;
}

function parseCastArray(output) {
  const match = /^\[\s*([^\]]*)\s*\]$/.exec(output.trim());
  if (!match) throw new Error(`Invalid cast array: ${output}`);
  if (match[1].trim() === "") return [];
  return match[1].split(",").map((value) => Number(firstToken(value)));
}

function parsePresetOutput(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 8) throw new Error(`Expected eight preset values, received ${lines.length}`);
  return {
    baseFactor: Number(firstToken(lines[0])),
    filterPeriod: Number(firstToken(lines[1])),
    decayPeriod: Number(firstToken(lines[2])),
    reductionFactor: Number(firstToken(lines[3])),
    variableFeeControl: Number(firstToken(lines[4])),
    protocolShare: Number(firstToken(lines[5])),
    maxVolatilityAccumulator: Number(firstToken(lines[6])),
    open: lines[7].trim() === "true"
  };
}

function presetArguments(preset) {
  return [
    preset.binStep,
    preset.baseFactor,
    preset.filterPeriod,
    preset.decayPeriod,
    preset.reductionFactor,
    preset.variableFeeControl,
    preset.protocolShare,
    preset.maxVolatilityAccumulator,
    preset.open
  ].map(String);
}

function main(argv) {
  const options = parseArgs(argv);
  const policyPath = path.resolve(options.policy ?? DEFAULT_POLICY);
  const manifestPath = path.resolve(options.manifest ?? DEFAULT_MANIFEST);
  const policy = validatePolicy(JSON.parse(fs.readFileSync(policyPath, "utf8")));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rpcUrl = options.rpcUrl ??
    process.env.EVM_PRESET_RPC_URL ??
    process.env.SEPOLIA_RPC_URL ??
    manifest?.endpoints?.rpcUrl;
  if (typeof rpcUrl !== "string" || rpcUrl.length === 0) throw new Error("Preset RPC URL is required");
  if (
    manifest.chainId !== policy.chainId ||
    normalizeAddress(manifest.contracts?.lbFactory) !== normalizeAddress(policy.factory)
  ) {
    throw new Error("Preset policy does not match the selected deployment manifest");
  }

  const chainId = Number(runCast(["chain-id", "--rpc-url", rpcUrl]));
  const owner = runCast(["call", policy.factory, "owner()(address)", "--rpc-url", rpcUrl]);
  const configured = parseCastArray(runCast([
    "call", policy.factory, "getAllBinSteps()(uint256[])", "--rpc-url", rpcUrl
  ]));
  const open = parseCastArray(runCast([
    "call", policy.factory, "getOpenBinSteps()(uint256[])", "--rpc-url", rpcUrl
  ]));
  const expectedConfigured = policy.presets.map((preset) => preset.binStep).sort(numberAscending);
  const expectedOpen = policy.presets.filter((preset) => preset.open).map((preset) => preset.binStep).sort(numberAscending);
  const differences = [];
  if (chainId !== policy.chainId) differences.push(`chain ID ${chainId} != ${policy.chainId}`);
  if (normalizeAddress(owner) !== normalizeAddress(policy.owner)) differences.push(`owner ${owner} != ${policy.owner}`);
  if (JSON.stringify([...configured].sort(numberAscending)) !== JSON.stringify(expectedConfigured)) {
    differences.push(`configured steps [${configured}] != approved [${expectedConfigured}]`);
  }
  if (JSON.stringify([...open].sort(numberAscending)) !== JSON.stringify(expectedOpen)) {
    differences.push(`open steps [${open}] != approved open [${expectedOpen}]`);
  }

  const livePresets = [];
  for (const preset of policy.presets) {
    const live = parsePresetOutput(runCast([
      "call",
      policy.factory,
      "getPreset(uint256)(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
      String(preset.binStep),
      "--rpc-url",
      rpcUrl
    ]));
    livePresets.push({ binStep: preset.binStep, ...live });
    for (const key of [
      "baseFactor",
      "filterPeriod",
      "decayPeriod",
      "reductionFactor",
      "variableFeeControl",
      "protocolShare",
      "maxVolatilityAccumulator",
      "open"
    ]) {
      if (live[key] !== preset[key]) {
        differences.push(`step ${preset.binStep} ${key}: live ${live[key]} != approved ${preset[key]}`);
      }
    }
  }

  const report = {
    chainId,
    factory: policy.factory,
    owner,
    configured,
    open,
    presets: livePresets,
    differences
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Preset policy ${differences.length === 0 ? "matches" : "differs from"} live Sepolia.\n`);
    process.stdout.write(`Factory ${policy.factory} · owner ${owner}\n`);
    for (const preset of policy.presets) {
      process.stdout.write(
        `Step ${preset.binStep}: ${formatPercent(preset.minimumFeeRateE18)}-${formatPercent(preset.maximumFeeRateE18)} · ${preset.marketProfile} · ${preset.open ? "open" : "closed"}\n`
      );
    }
    for (const difference of differences) process.stdout.write(`DIFF ${difference}\n`);
  }

  if (options.plan) {
    process.stdout.write("\nSimulation-first owner provisioning plan (no transaction was broadcast):\n");
    for (const preset of policy.presets) {
      const args = presetArguments(preset);
      runCast([
        "call",
        "--from",
        policy.owner,
        policy.factory,
        SET_PRESET_SIGNATURE,
        ...args,
        "--rpc-url",
        rpcUrl
      ]);
      process.stdout.write(`SIMULATED step ${preset.binStep} from owner ${policy.owner}\n`);
      process.stdout.write(
        `cast send ${policy.factory} '${SET_PRESET_SIGNATURE}' ${args.join(" ")} --rpc-url "$EVM_PRESET_RPC_URL" --private-key "$EVM_DEPLOYER_PRIVATE_KEY"\n`
      );
    }
  }
  if (differences.length > 0) process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { json: false, plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--plan") options.plan = true;
    else if (["--policy", "--manifest", "--rpc-url"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace("-url", "Url")] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function runCast(args) {
  const result = spawnSync("cast", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `cast ${args[0]} failed`).trim());
  }
  return result.stdout.trim();
}

function firstToken(value) {
  return value.trim().split(/\s+/)[0];
}

function normalizeAddress(value) {
  if (!isAddress(value)) return "";
  return value.toLowerCase();
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function numberAscending(left, right) {
  return left - right;
}

function formatPercent(rateE18) {
  const millionths = BigInt(rateE18) * 1_000_000n / 10n ** 18n;
  const whole = millionths / 10_000n;
  const fraction = (millionths % 10_000n).toString().padStart(4, "0").replace(/0+$/, "") || "0";
  return `${whole}.${fraction}%`;
}

module.exports = {
  calculateFeeBounds,
  parseCastArray,
  parsePresetOutput,
  presetArguments,
  validatePolicy
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
