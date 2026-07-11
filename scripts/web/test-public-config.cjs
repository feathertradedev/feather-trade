#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const fixtureWriter = path.join(repoRoot, "scripts/web/create-public-config-fixture.cjs");
const validator = path.join(repoRoot, "scripts/web/validate-public-config.cjs");
const anvilOwner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const legacyRoutingSlots = [
  "routerFactoryV1",
  "routerFactoryV2_1",
  "routerLegacyFactoryV2",
  "routerLegacyRouterV2"
];
const nonzeroLegacyRouter = "0x9999999999999999999999999999999999999999";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeFixture(dir, environment, name = `${environment}.latest.json`) {
  const manifestPath = path.join(dir, name);
  const result = childProcess.spawnSync(
    process.execPath,
    [fixtureWriter, "--environment", environment, "--out", path.relative(repoRoot, manifestPath)],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert(result.status === 0, `fixture writer failed:\n${result.stderr}\n${result.stdout}`);
  return manifestPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function runValidator(environment, manifestPath) {
  return childProcess.spawnSync(
    process.execPath,
    [validator, "--environment", environment, "--manifest", path.relative(repoRoot, manifestPath)],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

function expectPass(name, environment, manifestPath) {
  const result = runValidator(environment, manifestPath);
  assert(result.status === 0, `${name} should pass:\n${result.stderr}\n${result.stdout}`);
}

function expectFail(name, environment, manifestPath, pattern) {
  const result = runValidator(environment, manifestPath);
  const output = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, `${name} should fail`);
  assert(pattern.test(output), `${name} failed with unexpected output:\n${output}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-web-config-test-"));
const testnetManifestPath = writeFixture(dir, "robinhoodTestnet");
const mainnetManifestPath = writeFixture(dir, "robinhood");

expectPass("synthetic public testnet manifest", "robinhoodTestnet", testnetManifestPath);
expectPass("synthetic public mainnet manifest", "robinhood", mainnetManifestPath);

const dryRunPath = path.join(dir, "dry-run.json");
writeJson(dryRunPath, readJson(testnetManifestPath));
expectFail("dry-run manifest path", "robinhoodTestnet", dryRunPath, /dry-run\.json/i);

const localEndpointPath = path.join(dir, "local-endpoint.latest.json");
writeJson(localEndpointPath, {
  ...readJson(testnetManifestPath),
  endpoints: {
    ...readJson(testnetManifestPath).endpoints,
    rpcUrl: "http://127.0.0.1:8545"
  }
});
expectFail("local RPC endpoint", "robinhoodTestnet", localEndpointPath, /public endpoints must use https|local hosts/i);

const anvilOwnerPath = path.join(dir, "anvil-owner.latest.json");
writeJson(anvilOwnerPath, {
  ...readJson(testnetManifestPath),
  ownership: {
    ...readJson(testnetManifestPath).ownership,
    initialOwner: anvilOwner
  }
});
expectFail("Anvil owner", "robinhoodTestnet", anvilOwnerPath, /Anvil default addresses/i);

const localnetFieldsPath = path.join(dir, "localnet-fields.latest.json");
writeJson(localnetFieldsPath, {
  ...readJson(testnetManifestPath),
  seededPools: {
    wnativeUsdc: {
      activeId: 8_388_608,
      binStep: 10,
      pair: "0x1111111111111111111111111111111111111111",
      tokenX: "0x2222222222222222222222222222222222222222",
      tokenY: "0x3333333333333333333333333333333333333333"
    }
  },
  smoke: {
    tokenIn: "0x2222222222222222222222222222222222222222",
    tokenOut: "0x3333333333333333333333333333333333333333"
  }
});
expectFail("localnet-only manifest fields", "robinhoodTestnet", localnetFieldsPath, /seededPools.*localnet-only/i);

const quoteMismatchPath = path.join(dir, "quote-mismatch.latest.json");
writeJson(quoteMismatchPath, {
  ...readJson(mainnetManifestPath),
  quoteAssets: {
    extra0: "0x9999999999999999999999999999999999999999",
    extra1: "0x0000000000000000000000000000000000000000",
    extra2: "0x0000000000000000000000000000000000000000",
    extra3: "0x0000000000000000000000000000000000000000",
    wrappedNative: readJson(mainnetManifestPath).tokens.wrappedNative
  }
});
expectFail("quote asset mismatch", "robinhood", quoteMismatchPath, /quote token .* is not present/i);

for (const slot of legacyRoutingSlots) {
  const legacyRoutingPath = path.join(dir, `legacy-${slot}.latest.json`);
  const manifest = readJson(mainnetManifestPath);
  writeJson(legacyRoutingPath, {
    ...manifest,
    constructorArgs: {
      ...manifest.constructorArgs,
      [slot]: nonzeroLegacyRouter
    }
  });
  expectFail(
    `nonzero ${slot}`,
    "robinhood",
    legacyRoutingPath,
    new RegExp(`${slot}.*zero address.*V2\\.2-only routing`, "i")
  );
}

for (const [name, mutate] of [
  ["top-level Zap metadata", (manifest) => ({ ...manifest, zap: { pair: nonzeroLegacyRouter } })],
  [
    "Zap contract address",
    (manifest) => ({ ...manifest, contracts: { ...manifest.contracts, zap: nonzeroLegacyRouter } })
  ],
  [
    "Zap constructor metadata",
    (manifest) => ({ ...manifest, constructorArgs: { ...manifest.constructorArgs, zapRouter: nonzeroLegacyRouter } })
  ]
]) {
  const retiredZapPath = path.join(dir, `${name.toLowerCase().replaceAll(/[^a-z]+/g, "-")}.latest.json`);
  writeJson(retiredZapPath, mutate(readJson(mainnetManifestPath)));
  expectFail(name, "robinhood", retiredZapPath, /on-chain Zap (?:was removed|constructor fields)/i);
}

console.log("public web config fixture tests passed");
