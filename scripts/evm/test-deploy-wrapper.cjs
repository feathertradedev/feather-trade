#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const zeroAddress = "0x0000000000000000000000000000000000000000";
const placeholderPrivateKey = `0x${"ff".repeat(32)}`;
const privateKey = `0x${"12".repeat(32)}`;
const privateKeyFallback = `0x${"34".repeat(32)}`;
const wrappedNative = "0x1111111111111111111111111111111111111111";
const quote0 = "0x2222222222222222222222222222222222222222";
const quote1 = "0x3333333333333333333333333333333333333333";
const contractAddresses = {
  lbFactory: "0x4444444444444444444444444444444444444444",
  lbPairImplementation: "0x5555555555555555555555555555555555555555",
  lbRouter: "0x6666666666666666666666666666666666666666",
  lbQuoter: "0x7777777777777777777777777777777777777777"
};
const deployer = "0x8888888888888888888888888888888888888888";
const cacheTestChainIds = ["700000000001", "700000000002"];
const sepoliaRpc =
  "https://sepolia-deployer:sepolia%3Apassword@provider.rpc.example/sepolia-path-credential?api-key=sepolia-api-secret";
const arbitraryRpc =
  "https://orbit-deployer:orbit%3Apassword@provider.rpc.example/orbit-path-credential?token=orbit-api-secret";
const secretCanaries = [
  privateKey,
  privateKey.slice(2),
  privateKeyFallback,
  privateKeyFallback.slice(2),
  sepoliaRpc,
  arbitraryRpc,
  "sepolia-deployer",
  "sepolia%3Apassword",
  "sepolia:password",
  "sepolia-path-credential",
  "sepolia-api-secret",
  "orbit-deployer",
  "orbit%3Apassword",
  "orbit:password",
  "orbit-path-credential",
  "orbit-api-secret",
  "metadata-user",
  "metadata%3Apassword",
  "metadata:password",
  "metadata-query-secret",
  "metadata-fragment-secret"
];

main();

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "evm-deploy-wrapper-"));
  const binDir = path.join(tempDir, "bin");
  const callLog = path.join(tempDir, "tool-calls.jsonl");
  fs.mkdirSync(binDir);
  writeFakeTools(binDir);

  try {
    testSepoliaBroadcast({ tempDir, binDir, callLog });
    testArbitraryChainDryRun({ tempDir, binDir, callLog });
    testFallbackPrivateKey({ tempDir, binDir, callLog });
    testChainMismatch({ tempDir, binDir, callLog });
    testBroadcastConfirmation({ tempDir, binDir, callLog });
    testInputValidation({ tempDir, binDir, callLog });
    testMetadataValidation({ tempDir, binDir, callLog });
    testQuoteValidation({ tempDir, binDir, callLog });
    testSensitiveForgeCacheCleanup({ tempDir, binDir, callLog });
    testForgeFailureIsAtomicAndRedacted({ tempDir, binDir, callLog });
    testMissingOrInvalidManifestIsAtomic({ tempDir, binDir, callLog });
    console.log("Generic EVM deploy wrapper tests passed (42 scenarios).");
  } finally {
    for (const chainId of cacheTestChainIds) {
      fs.rmSync(sensitiveCachePath(chainId), { recursive: true, force: true });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testSepoliaBroadcast(ctx) {
  const fixture = createFixture(ctx, "sepolia-broadcast");
  fs.writeFileSync(fixture.manifestPath, '{"sentinel":"old manifest"}\n');

  const result = runDeploy(fixture, {
    network: "sepolia",
    chainId: "11155111",
    rpcUrl: sepoliaRpc,
    quoteAssets: [quote0]
  });

  assert.equal(result.status, 0, diagnostic(result));
  assert.match(result.stdout, /EVM deployment broadcast completed/i);
  assertNoSecretsInResult(result);
  assertNoSecretsInFile(fixture.logPath("broadcast"));
  assertNoSecretsInFile(fixture.manifestPath);
  assertOwnerOnly(fixture.logPath("broadcast"));
  assertOwnerOnly(fixture.manifestPath);
  assertNoPendingManifest(fixture);

  const manifest = readJson(fixture.manifestPath);
  assert.equal(manifest.schemaVersion, "lb.evm.v1");
  assert.equal(manifest.environment, "sepolia");
  assert.equal(manifest.chainId, 11155111);
  assert.equal(manifest.tokens.wrappedNative, wrappedNative);
  assert.equal(manifest.quoteAssets.extra0, quote0);
  assert.notEqual(manifest.sentinel, "old manifest", "valid deployment must replace the prior manifest");

  const calls = readCalls(fixture.callLog);
  assertForgeCall(calls, { broadcast: true, expectedPrivateKey: privateKey });
  assertCastCalls(calls, { postDeployChecks: true });
  assertNoSecretsInFile(fixture.callLog);
}

function testArbitraryChainDryRun(ctx) {
  const fixture = createFixture(ctx, "arbitrary-dry-run");
  const result = runDeploy(fixture, {
    network: "orbit-dev-7",
    chainId: "84532007",
    rpcUrl: arbitraryRpc,
    dryRun: true,
    confirmation: "",
    quoteAssets: [quote0, quote1],
    extraEnv: {
      EVM_DEPLOY_CHAIN_NAME: "Orbit Development 7",
      EVM_DEPLOY_NATIVE_CURRENCY: "ORB",
      EVM_DEPLOY_RPC_ENV_VAR: "ORBIT_DEV_7_RPC_URL",
      EVM_DEPLOY_EXPLORER_URL: "https://explorer.orbit.example",
      EVM_DEPLOY_VERIFIER_URL: "https://explorer.orbit.example/api"
    }
  });

  assert.equal(result.status, 0, diagnostic(result));
  assert.match(result.stdout, /EVM deployment dry-run completed/i);
  assertNoSecretsInResult(result);
  assertNoSecretsInFile(fixture.logPath("dry-run"));
  assertNoSecretsInFile(fixture.manifestPath);
  assertOwnerOnly(fixture.logPath("dry-run"));
  assertOwnerOnly(fixture.manifestPath);
  assertNoPendingManifest(fixture);

  const manifest = readJson(fixture.manifestPath);
  assert.equal(manifest.environment, "orbit-dev-7");
  assert.equal(manifest.chainId, 84532007);
  assert.deepEqual(manifest.chain, {
    name: "Orbit Development 7",
    nativeCurrency: "ORB",
    rpcEnvVar: "ORBIT_DEV_7_RPC_URL",
    explorerUrl: "https://explorer.orbit.example",
    verifierUrl: "https://explorer.orbit.example/api"
  });
  assert.equal(manifest.quoteAssets.extra0, quote0);
  assert.equal(manifest.quoteAssets.extra1, quote1);

  const calls = readCalls(fixture.callLog);
  assertForgeCall(calls, { broadcast: false, expectedPrivateKey: privateKey });
  assertCastCalls(calls, { postDeployChecks: false });
  assertNoSecretsInFile(fixture.callLog);
}

function testFallbackPrivateKey(ctx) {
  const fixture = createFixture(ctx, "fallback-private-key");
  const result = runDeploy(fixture, {
    dryRun: true,
    privateKey: "",
    fallbackPrivateKey: privateKeyFallback
  });

  assert.equal(result.status, 0, diagnostic(result));
  assertNoSecretsInResult(result);
  assertForgeCall(readCalls(fixture.callLog), {
    broadcast: false,
    expectedPrivateKey: privateKeyFallback
  });
  assertNoSecretsInFile(fixture.callLog);
  assertNoSecretsInFile(fixture.logPath("dry-run"));
  assertNoSecretsInFile(fixture.manifestPath);
}

function testChainMismatch(ctx) {
  const fixture = createFixture(ctx, "chain-mismatch");
  fs.writeFileSync(fixture.manifestPath, '{"sentinel":"keep me"}\n');
  const result = runDeploy(fixture, { actualChainId: "1" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RPC chain-id mismatch: expected 11155111, got 1/i);
  assert.equal(readCalls(fixture.callLog).some((call) => call.tool === "forge"), false);
  assert.equal(readJson(fixture.manifestPath).sentinel, "keep me");
  assertNoPendingManifest(fixture);
  assertNoSecretsInResult(result);
}

function testBroadcastConfirmation(ctx) {
  for (const [name, confirmation] of [
    ["missing-confirmation", ""],
    ["wrong-confirmation", "1"]
  ]) {
    const fixture = createFixture(ctx, name);
    const result = runDeploy(fixture, { confirmation });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /Set EVM_DEPLOY_CONFIRM_CHAIN_ID=11155111 to authorize this broadcast/i);
    assert.equal(readCalls(fixture.callLog).some((call) => call.tool === "forge"), false, name);
    assert.equal(fs.existsSync(fixture.manifestPath), false, name);
    assertNoPendingManifest(fixture);
    assertNoSecretsInResult(result);
  }
}

function testInputValidation(ctx) {
  const cases = [
    ["missing-network", { network: "" }, /Set EVM_DEPLOY_NETWORK/i],
    ["invalid-network-uppercase", { network: "Sepolia" }, /lowercase slug/i],
    ["invalid-network-symbol", { network: "sepolia_dev" }, /lowercase slug/i],
    ["missing-chain", { chainId: "" }, /Set EVM_DEPLOY_EXPECTED_CHAIN_ID/i],
    ["invalid-chain-zero", { chainId: "0" }, /positive decimal chain ID/i],
    ["invalid-chain-hex", { chainId: "0xaa36a7" }, /positive decimal chain ID/i],
    [
      "chain-exceeds-json-safe-integer",
      { chainId: "9007199254740992" },
      /must fit safely in the JSON deployment manifest/i
    ],
    ["missing-rpc", { rpcUrl: "" }, /Set EVM_DEPLOY_RPC_URL/i],
    ["missing-private-key", { privateKey: "", fallbackPrivateKey: "" }, /32-byte 0x-prefixed private key/i],
    ["short-private-key", { privateKey: "0x1234" }, /32-byte 0x-prefixed private key/i],
    ["zero-private-key", { privateKey: `0x${"00".repeat(32)}` }, /must not be zero/i],
    ["placeholder-private-key", { privateKey: placeholderPrivateKey }, /placeholder key/i],
    ["missing-wrapped-native", { wrappedNativeAddress: "" }, /Set EVM_DEPLOY_WNATIVE_ADDRESS/i],
    ["invalid-wrapped-native", { wrappedNativeAddress: "0x1234" }, /20-byte 0x-prefixed EVM address/i],
    ["zero-wrapped-native", { wrappedNativeAddress: zeroAddress }, /must not be the zero address/i],
    [
      "invalid-rpc-env-var",
      { extraEnv: { EVM_DEPLOY_RPC_ENV_VAR: "SEPOLIA-RPC-URL" } },
      /EVM_DEPLOY_RPC_ENV_VAR must be a valid environment variable name/i
    ],
    ["invalid-dry-run", { dryRunRaw: "yes" }, /DRY_RUN must be 0 or 1/i]
  ];

  for (const [name, overrides, expectedError] of cases) {
    const fixture = createFixture(ctx, name);
    const result = runDeploy(fixture, overrides);
    assert.notEqual(result.status, 0, `${name} unexpectedly succeeded`);
    assert.match(result.stderr, expectedError, diagnostic(result));
    assert.equal(readCalls(fixture.callLog).some((call) => call.tool === "forge"), false, name);
    assert.equal(fs.existsSync(fixture.manifestPath), false, name);
    assertNoPendingManifest(fixture);
    assertNoSecretsInResult(result);
  }
}

function testMetadataValidation(ctx) {
  const cases = [
    [
      "explorer-url-credentials",
      "EVM_DEPLOY_EXPLORER_URL",
      "https://metadata-user:metadata%3Apassword@explorer.example",
      /EVM_DEPLOY_EXPLORER_URL must be an absolute public HTTP\(S\) URL/i
    ],
    [
      "explorer-url-query",
      "EVM_DEPLOY_EXPLORER_URL",
      "https://explorer.example?token=metadata-query-secret",
      /EVM_DEPLOY_EXPLORER_URL must be an absolute public HTTP\(S\) URL/i
    ],
    [
      "explorer-url-fragment",
      "EVM_DEPLOY_EXPLORER_URL",
      "https://explorer.example/#metadata-fragment-secret",
      /EVM_DEPLOY_EXPLORER_URL must be an absolute public HTTP\(S\) URL/i
    ],
    [
      "explorer-url-non-http",
      "EVM_DEPLOY_EXPLORER_URL",
      "ipfs://metadata-query-secret",
      /EVM_DEPLOY_EXPLORER_URL must be an absolute public HTTP\(S\) URL/i
    ],
    [
      "verifier-url-credentials",
      "EVM_DEPLOY_VERIFIER_URL",
      "https://metadata-user:metadata%3Apassword@verifier.example/api",
      /EVM_DEPLOY_VERIFIER_URL must be an absolute public HTTP\(S\) URL/i
    ],
    [
      "verifier-url-query",
      "EVM_DEPLOY_VERIFIER_URL",
      "https://verifier.example/api?token=metadata-query-secret",
      /EVM_DEPLOY_VERIFIER_URL must be an absolute public HTTP\(S\) URL/i
    ],
    [
      "verifier-url-fragment",
      "EVM_DEPLOY_VERIFIER_URL",
      "https://verifier.example/api#metadata-fragment-secret",
      /EVM_DEPLOY_VERIFIER_URL must be an absolute public HTTP\(S\) URL/i
    ],
    [
      "verifier-url-non-http",
      "EVM_DEPLOY_VERIFIER_URL",
      "file:///metadata-query-secret",
      /EVM_DEPLOY_VERIFIER_URL must be an absolute public HTTP\(S\) URL/i
    ]
  ];

  for (const [name, variable, value, expectedError] of cases) {
    const fixture = createFixture(ctx, name);
    const result = runDeploy(fixture, { extraEnv: { [variable]: value } });
    assert.notEqual(result.status, 0, `${name} unexpectedly succeeded`);
    assert.match(result.stderr, expectedError, diagnostic(result));
    assert.equal(readCalls(fixture.callLog).some((call) => call.tool === "forge"), false, name);
    assert.equal(fs.existsSync(fixture.manifestPath), false, name);
    assertNoPendingManifest(fixture);
    assertNoSecretsInResult(result);
  }
}

function testQuoteValidation(ctx) {
  const cases = [
    ["invalid-quote", ["0x1234"], {}, /20-byte 0x-prefixed EVM address/i],
    ["zero-quote", [zeroAddress], {}, /must not be the zero address/i],
    ["quote-duplicates-wrapped-native", [wrappedNative.toUpperCase().replace("0X", "0x")], {}, /duplicates wrapped native/i],
    ["quote-duplicates-quote", [quote0, quote0.toUpperCase().replace("0X", "0x")], {}, /duplicates wrapped native or another quote asset/i],
    ["wrapped-native-no-code", [], { noCodeAddresses: [wrappedNative] }, /EVM_DEPLOY_WNATIVE_ADDRESS has no deployed bytecode/i],
    ["quote-no-code", [quote0], { noCodeAddresses: [quote0] }, /EVM_DEPLOY_QUOTE_ASSET_0 has no deployed bytecode/i]
  ];

  for (const [name, quoteAssets, overrides, expectedError] of cases) {
    const fixture = createFixture(ctx, name);
    const result = runDeploy(fixture, { quoteAssets, ...overrides });
    assert.notEqual(result.status, 0, `${name} unexpectedly succeeded`);
    assert.match(result.stderr, expectedError, diagnostic(result));
    assert.equal(readCalls(fixture.callLog).some((call) => call.tool === "forge"), false, name);
    assert.equal(fs.existsSync(fixture.manifestPath), false, name);
    assertNoPendingManifest(fixture);
    assertNoSecretsInResult(result);
  }
}

function testSensitiveForgeCacheCleanup(ctx) {
  const cases = [
    ["sensitive-cache-success", cacheTestChainIds[0], false],
    ["sensitive-cache-forge-failure", cacheTestChainIds[1], true]
  ];

  for (const [name, chainId, forgeFails] of cases) {
    const fixture = createFixture(ctx, name);
    const cachePath = sensitiveCachePath(chainId);
    fs.rmSync(cachePath, { recursive: true, force: true });

    const extraEnv = { FAKE_FORGE_WRITE_SENSITIVE_CACHE: "1" };
    if (forgeFails) {
      extraEnv.FAKE_FORGE_EXIT = "42";
      extraEnv.FAKE_FORGE_WRITE_MANIFEST = "1";
    }
    const result = runDeploy(fixture, { chainId, extraEnv });

    assert.equal(result.status, forgeFails ? 42 : 0, diagnostic(result));
    const calls = readCalls(fixture.callLog);
    assertForgeCall(calls, { broadcast: true, expectedPrivateKey: privateKey });
    const cacheEvents = calls.filter((call) => call.tool === "fake-forge-cache-write");
    assert.equal(cacheEvents.length, 1, `${name}: fake Forge did not record its credential-bearing cache write`);
    assert.equal(cacheEvents[0].chainId, chainId);
    assert.equal(cacheEvents[0].containedCredentials, true);
    assert.equal(fs.existsSync(cachePath), false, `${name}: sensitive Forge resume cache survived wrapper exit`);
    assertNoSecretsInResult(result);
    assertNoSecretsInFile(fixture.callLog);
    assertNoSecretsInFile(fixture.logPath("broadcast"));
    assertOwnerOnly(fixture.logPath("broadcast"));

    if (forgeFails) {
      assert.equal(fs.existsSync(fixture.manifestPath), false);
      assertNoPendingManifest(fixture);
    } else {
      assert.equal(readJson(fixture.manifestPath).chainId, Number(chainId));
      assertOwnerOnly(fixture.manifestPath);
    }
  }
}

function testForgeFailureIsAtomicAndRedacted(ctx) {
  const fixture = createFixture(ctx, "forge-failure");
  const prior = '{"sentinel":"prior valid deployment"}\n';
  fs.writeFileSync(fixture.manifestPath, prior);

  const result = runDeploy(fixture, {
    extraEnv: {
      FAKE_FORGE_ECHO_SECRETS: "1",
      FAKE_FORGE_EXIT: "42",
      FAKE_FORGE_WRITE_MANIFEST: "1"
    }
  });

  assert.equal(result.status, 42, diagnostic(result));
  assert.match(`${result.stdout}\n${result.stderr}`, /forge diagnostic: provider request failed/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /\[REDACTED_RPC_URL\]/);
  assert.match(`${result.stdout}\n${result.stderr}`, /\[REDACTED_RPC_CREDENTIAL\]/);
  assert.match(`${result.stdout}\n${result.stderr}`, /\[REDACTED_PRIVATE_KEY\]/);
  assert.equal(fs.readFileSync(fixture.manifestPath, "utf8"), prior, "failed Forge must preserve prior manifest");
  assertNoPendingManifest(fixture);
  assertNoSecretsInResult(result);
  assertNoSecretsInFile(fixture.logPath("broadcast"));
  assertNoSecretsInFile(fixture.manifestPath);
  assertNoSecretsInFile(fixture.callLog);
}

function testMissingOrInvalidManifestIsAtomic(ctx) {
  for (const [name, manifestMode, expectedError] of [
    ["missing-forge-manifest", "missing", /without writing the deployment manifest/i],
    ["invalid-forge-manifest", "invalid", /schemaVersion: expected "lb\.evm\.v1"/i]
  ]) {
    const fixture = createFixture(ctx, name);
    const prior = `{\"sentinel\":\"${name}\"}\n`;
    fs.writeFileSync(fixture.manifestPath, prior);

    const result = runDeploy(fixture, { extraEnv: { FAKE_MANIFEST_MODE: manifestMode } });
    assert.notEqual(result.status, 0, `${name} unexpectedly succeeded`);
    assert.match(`${result.stdout}\n${result.stderr}`, expectedError, diagnostic(result));
    assert.equal(fs.readFileSync(fixture.manifestPath, "utf8"), prior, `${name} must preserve prior manifest`);
    assertNoPendingManifest(fixture);
    assertNoSecretsInResult(result);
    assertNoSecretsInFile(fixture.logPath("broadcast"));
  }
}

function createFixture(ctx, name) {
  const caseDir = path.join(ctx.tempDir, name);
  const outputDir = path.join(caseDir, "output");
  const manifestPath = path.join(caseDir, "manifest.json");
  const callLog = path.join(caseDir, "tool-calls.jsonl");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(callLog, "");
  return {
    ...ctx,
    callLog,
    caseDir,
    outputDir,
    manifestPath,
    logPath: (mode) => path.join(outputDir, `${mode}.log`)
  };
}

function runDeploy(fixture, options = {}) {
  const network = valueOr(options, "network", "sepolia");
  const chainId = valueOr(options, "chainId", "11155111");
  const rpcUrl = valueOr(options, "rpcUrl", sepoliaRpc);
  const deployPrivateKey = valueOr(options, "privateKey", privateKey);
  const fallbackPrivateKey = valueOr(options, "fallbackPrivateKey", "");
  const wrappedNativeAddress = valueOr(options, "wrappedNativeAddress", wrappedNative);
  const quoteAssets = options.quoteAssets ?? [quote0];
  const dryRun = options.dryRun ?? false;
  const dryRunRaw = options.dryRunRaw ?? (dryRun ? "1" : "0");
  const confirmation = valueOr(options, "confirmation", dryRun ? "" : chainId);
  const actualChainId = valueOr(options, "actualChainId", chainId);
  const noCodeAddresses = options.noCodeAddresses ?? [];

  const env = {
    ...scrubbedEnv(),
    PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH}`,
    DEPLOYER_PRIVATE_KEY: fallbackPrivateKey,
    DRY_RUN: dryRunRaw,
    EVM_DEPLOY_CHAIN_NAME: network || "missing-network",
    EVM_DEPLOY_CONFIRM_CHAIN_ID: confirmation,
    EVM_DEPLOYER_PRIVATE_KEY: deployPrivateKey,
    EVM_DEPLOY_EXPECTED_CHAIN_ID: chainId,
    EVM_DEPLOY_EXPLORER_URL: "",
    EVM_DEPLOY_MANIFEST_PATH: fixture.manifestPath,
    EVM_DEPLOY_NATIVE_CURRENCY: "ETH",
    EVM_DEPLOY_NETWORK: network,
    EVM_DEPLOY_OUTPUT_DIR: fixture.outputDir,
    EVM_DEPLOY_QUOTE_ASSET_0: quoteAssets[0] || "",
    EVM_DEPLOY_QUOTE_ASSET_1: quoteAssets[1] || "",
    EVM_DEPLOY_QUOTE_ASSET_2: quoteAssets[2] || "",
    EVM_DEPLOY_QUOTE_ASSET_3: quoteAssets[3] || "",
    EVM_DEPLOY_RPC_ENV_VAR: "SEPOLIA_RPC_URL",
    EVM_DEPLOY_RPC_URL: rpcUrl,
    EVM_DEPLOY_VERIFIER_URL: "",
    EVM_DEPLOY_WNATIVE_ADDRESS: wrappedNativeAddress,
    FAKE_CAST_CHAIN_ID: actualChainId,
    FAKE_FORGE_CALL_LOG: fixture.callLog,
    FAKE_NO_CODE_ADDRESSES: noCodeAddresses.join(","),
    FAKE_PRIVATE_KEY: deployPrivateKey || fallbackPrivateKey,
    FAKE_RPC_URL: rpcUrl,
    ...options.extraEnv
  };

  return childProcess.spawnSync("bash", ["scripts/evm/deploy.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 15_000
  });
}

function assertForgeCall(calls, { broadcast, expectedPrivateKey }) {
  const forgeCalls = calls.filter((call) => call.tool === "forge");
  assert.equal(forgeCalls.length, 1, `expected exactly one Forge call, got ${forgeCalls.length}`);
  const call = forgeCalls[0];
  assert.equal(call.foundryRpcConfigured, true, "Forge must receive its RPC through FOUNDRY_ETH_RPC_URL");
  assert.equal(call.ethRpcConfigured, true, "Forge must also receive ETH_RPC_URL for child RPC consumers");
  assert.equal(
    call.foundryCachePath,
    path.join(repoRoot, "cache"),
    "Forge cache path must be pinned to the same repository cache root scrubbed by the wrapper"
  );
  assert.equal(call.privateKeyConfigured, true, "Solidity script must receive its key through the environment");
  assert.equal(call.args.includes("--rpc-url"), false, "RPC must never be passed in argv");
  assert.equal(call.args.includes("--private-key"), false, "private key must never be passed in argv");
  assert.equal(call.args.includes("--broadcast"), broadcast);
  assert.equal(call.args.includes("contracts/joe-v2/script/deploy-evm.s.sol:GenericEvmDeployScript"), true);
  const argv = JSON.stringify(call.args);
  for (const secret of [...secretCanaries, expectedPrivateKey, expectedPrivateKey.slice(2)]) {
    assert.equal(argv.includes(secret), false, `secret leaked into Forge argv: ${secret}`);
  }
}

function assertCastCalls(calls, { postDeployChecks }) {
  const castCalls = calls.filter((call) => call.tool === "cast");
  assert(castCalls.length >= 2, "expected chain-id and bytecode preflight calls");
  assert.equal(castCalls[0].args[0], "chain-id");
  for (const call of castCalls) {
    assert.equal(call.rpcConfigured, true, "cast must receive its RPC through ETH_RPC_URL");
    assert.equal(call.args.includes("--rpc-url"), false, "RPC must never be passed in cast argv");
  }
  const deployedCodeChecks = castCalls.filter(
    (call) => call.args[0] === "code" && Object.values(contractAddresses).includes(call.args[1])
  );
  assert.equal(deployedCodeChecks.length, postDeployChecks ? 4 : 0);
}

function assertNoPendingManifest(fixture) {
  const pending = fs
    .readdirSync(path.dirname(fixture.manifestPath))
    .filter((entry) => entry.startsWith(`.pending-${path.basename(fixture.manifestPath)}.`));
  assert.deepEqual(pending, [], `pending manifest was not cleaned: ${pending.join(", ")}`);
}

function assertNoSecretsInResult(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assertNoSecrets(output, "deploy output");
}

function assertNoSecretsInFile(file) {
  if (!fs.existsSync(file)) return;
  assertNoSecrets(fs.readFileSync(file, "utf8"), file);
}

function assertNoSecrets(contents, label) {
  for (const secret of secretCanaries) {
    assert.equal(contents.includes(secret), false, `${label} leaked secret: ${secret}`);
  }
}

function assertOwnerOnly(file) {
  if (process.platform === "win32") return;
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `${file} must be owner-readable/writable only; got mode ${mode.toString(8)}`);
}

function sensitiveCachePath(chainId) {
  return path.join(repoRoot, "cache", "deploy-evm.s.sol", chainId);
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function diagnostic(result) {
  return `status=${result.status}\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`;
}

function valueOr(object, key, fallback) {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : fallback;
}

function writeFakeTools(binDir) {
  fs.writeFileSync(
    path.join(binDir, "cast"),
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_FORGE_CALL_LOG, JSON.stringify({
  tool: "cast",
  args,
  rpcConfigured: process.env.ETH_RPC_URL === process.env.FAKE_RPC_URL
}) + "\\n");
if (args.includes("--rpc-url")) process.exit(2);
if (args[0] === "chain-id" && args.length === 1) {
  console.log(process.env.FAKE_CAST_CHAIN_ID);
  process.exit(0);
}
if (args[0] === "code" && args.length === 2) {
  const missing = (process.env.FAKE_NO_CODE_ADDRESSES || "")
    .split(",")
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  console.log(missing.includes(args[1].toLowerCase()) ? "0x" : "0x6000");
  process.exit(0);
}
process.exit(3);
`
  );

  fs.writeFileSync(
    path.join(binDir, "forge"),
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_FORGE_CALL_LOG, JSON.stringify({
  tool: "forge",
  args,
  foundryRpcConfigured: process.env.FOUNDRY_ETH_RPC_URL === process.env.FAKE_RPC_URL,
  ethRpcConfigured: process.env.ETH_RPC_URL === process.env.FAKE_RPC_URL,
  foundryCachePath: process.env.FOUNDRY_CACHE_PATH,
  privateKeyConfigured: process.env.EVM_DEPLOYER_PRIVATE_KEY === process.env.FAKE_PRIVATE_KEY
}) + "\\n");

if (process.env.FAKE_FORGE_ECHO_SECRETS === "1") {
  const parsed = new URL(process.env.ETH_RPC_URL);
  console.error("forge diagnostic: provider request failed");
  console.error("provider=" + process.env.ETH_RPC_URL);
  console.error("provider-token=" + [...parsed.searchParams.values()][0]);
  console.error("provider-user=" + parsed.username);
  console.error("provider-password=" + parsed.password);
  console.error("provider-password-decoded=" + decodeURIComponent(parsed.password));
  console.error("provider-path=" + parsed.pathname.split("/").filter(Boolean)[0]);
  console.error("private-key=" + process.env.EVM_DEPLOYER_PRIVATE_KEY);
  console.error("private-key-no-prefix=" + process.env.EVM_DEPLOYER_PRIVATE_KEY.slice(2));
}

if (process.env.FAKE_FORGE_WRITE_SENSITIVE_CACHE === "1") {
  const path = require("node:path");
  const chainId = process.env.EVM_DEPLOY_EXPECTED_CHAIN_ID;
  const cachePath = path.join(process.env.FOUNDRY_CACHE_PATH, "deploy-evm.s.sol", chainId, "run-latest.json");
  const sensitiveContents = JSON.stringify({
    rpc: process.env.FOUNDRY_ETH_RPC_URL,
    privateKey: process.env.EVM_DEPLOYER_PRIVATE_KEY
  });
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, sensitiveContents + "\\n");
  fs.appendFileSync(process.env.FAKE_FORGE_CALL_LOG, JSON.stringify({
    tool: "fake-forge-cache-write",
    chainId,
    containedCredentials:
      sensitiveContents.includes(process.env.FOUNDRY_ETH_RPC_URL) &&
      sensitiveContents.includes(process.env.EVM_DEPLOYER_PRIVATE_KEY)
  }) + "\\n");
}

const mode = process.env.FAKE_MANIFEST_MODE || "valid";
if (mode !== "missing" && (process.env.FAKE_FORGE_WRITE_MANIFEST === "1" || !process.env.FAKE_FORGE_EXIT)) {
  const zero = "${zeroAddress}";
  const contracts = ${JSON.stringify(contractAddresses)};
  const deployer = "${deployer}";
  const manifest = {
    schemaVersion: mode === "invalid" ? "lb.evm.invalid" : "lb.evm.v1",
    environment: process.env.EVM_DEPLOY_NETWORK,
    chainId: Number(process.env.EVM_DEPLOY_EXPECTED_CHAIN_ID),
    startBlock: 123456,
    deployer,
    sourceCommit: process.env.EVM_DEPLOY_SOURCE_COMMIT,
    sourceTreeDirty: process.env.EVM_DEPLOY_SOURCE_TREE_DIRTY === "true",
    chain: {
      name: process.env.EVM_DEPLOY_CHAIN_NAME,
      nativeCurrency: process.env.EVM_DEPLOY_NATIVE_CURRENCY,
      rpcEnvVar: process.env.EVM_DEPLOY_RPC_ENV_VAR,
      explorerUrl: process.env.EVM_DEPLOY_EXPLORER_URL,
      verifierUrl: process.env.EVM_DEPLOY_VERIFIER_URL
    },
    contracts,
    ownership: { initialOwner: deployer, lbFactoryOwner: deployer, feeRecipient: deployer },
    tokens: { wrappedNative: process.env.EVM_DEPLOY_WNATIVE_ADDRESS },
    quoteAssets: {
      wrappedNative: process.env.EVM_DEPLOY_WNATIVE_ADDRESS,
      extra0: process.env.EVM_DEPLOY_QUOTE_ASSET_0 || zero,
      extra1: process.env.EVM_DEPLOY_QUOTE_ASSET_1 || zero,
      extra2: process.env.EVM_DEPLOY_QUOTE_ASSET_2 || zero,
      extra3: process.env.EVM_DEPLOY_QUOTE_ASSET_3 || zero
    },
    factoryPreset: {
      binStep: 10,
      baseFactor: 10000,
      filterPeriod: 30,
      decayPeriod: 600,
      reductionFactor: 5000,
      variableFeeControl: 40000,
      protocolShare: 0,
      maxVolatilityAccumulator: 350000,
      open: true
    },
    constructorArgs: {
      feeRecipient: deployer,
      initialOwner: deployer,
      flashLoanFee: 5000000000000,
      routerFactoryV1: zero,
      routerLegacyFactoryV2: zero,
      routerLegacyRouterV2: zero,
      routerFactoryV2_1: zero,
      routerWNative: process.env.EVM_DEPLOY_WNATIVE_ADDRESS,
      quoterFactoryV1: zero,
      quoterLegacyFactoryV2: zero,
      quoterFactoryV2_1: zero,
      quoterFactoryV2_2: contracts.lbFactory,
      quoterLegacyRouterV2: zero,
      quoterRouterV2_1: zero,
      quoterRouterV2_2: contracts.lbRouter
    }
  };
  fs.mkdirSync(require("node:path").dirname(process.env.EVM_DEPLOY_MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(process.env.EVM_DEPLOY_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\\n");
}

process.exit(Number(process.env.FAKE_FORGE_EXIT || "0"));
`
  );

  fs.chmodSync(path.join(binDir, "cast"), 0o755);
  fs.chmodSync(path.join(binDir, "forge"), 0o755);
}

function scrubbedEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      name === "DEPLOYER_PRIVATE_KEY" ||
      name === "DRY_RUN" ||
      name === "ETH_RPC_URL" ||
      name === "FOUNDRY_ETH_RPC_URL" ||
      name === "FOUNDRY_CACHE_PATH" ||
      name.startsWith("EVM_DEPLOY_") ||
      name.startsWith("FAKE_")
    ) {
      delete env[name];
    }
  }
  return env;
}
