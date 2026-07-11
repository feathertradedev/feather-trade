import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, keccak256 } from "viem";
import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({ configFile: resolve(webRoot, "vite.config.ts"), logLevel: "error", server: { middlewareMode: true } });

try {
  const { attestFactoryForCreate, attestPairForWrite, decodeHooksParameters, evaluateFactoryForCreate, evaluatePairEvidence, attestSwapRouteForWrite } = await server.ssrLoadModule("/src/pair-attestation.ts");
  const A = {
    factory: getAddress("0x1000000000000000000000000000000000000001"),
    implementation: getAddress("0x2000000000000000000000000000000000000002"),
    router: getAddress("0x3000000000000000000000000000000000000003"),
    quoter: getAddress("0x4000000000000000000000000000000000000004"),
    pair: getAddress("0x5000000000000000000000000000000000000005"),
    tokenX: getAddress("0x6000000000000000000000000000000000000006"),
    tokenY: getAddress("0x7000000000000000000000000000000000000007"),
    hook: getAddress("0x8000000000000000000000000000000000000008")
  };
  const code = "0x6001600055";
  const registry = {
    chainId: 31337,
    contracts: { lbFactory: A.factory, lbPairImplementation: A.implementation, lbRouter: A.router, lbQuoter: A.quoter },
    supportedHooks: [],
    supportedPairImplementations: [A.implementation]
  };
  const zeroHooks = `0x${"0".repeat(64)}`;
  const claim = {
    binStep: 10,
    hooksParameters: zeroHooks,
    indexerFactory: A.factory,
    indexerIgnoredForRouting: false,
    operation: "swap",
    pair: A.pair,
    tokenX: A.tokenX,
    tokenY: A.tokenY
  };
  const evidence = {
    ...claim,
    chainId: 31337,
    factory: A.factory,
    factoryHasCode: true,
    factoryLookupBinStep: 10,
    factoryLookupIgnored: false,
    factoryLookupPair: A.pair,
    hookCode: undefined,
    hookLinked: undefined,
    hookPair: undefined,
    hookImplementation: undefined,
    hookImplementationCode: undefined,
    pairHasCode: true,
    pairImplementation: A.implementation,
    pairImplementationHasCode: true,
    quoterFactory: A.factory,
    quoterHasCode: true,
    quoterRouter: A.router,
    routerFactory: A.factory,
    routerHasCode: true
  };

  assert.equal(evaluatePairEvidence(registry, claim, evidence).hookIdentity, "Hookless LB pair");
  assert.equal(evaluatePairEvidence({ ...registry, supportedPairImplementations: [A.implementation, A.router] }, { ...claim, operation: "remove-liquidity" }, { ...evidence, operation: "remove-liquidity", pairImplementation: A.router }).hookRisk, "none");
  for (const [name, mutate, pattern] of [
    ["foreign factory", (x) => x.factory = A.router, /foreign factory/],
    ["stale pair", (x) => x.factoryLookupPair = A.router, /no longer resolves/],
    ["token order", (x) => [x.tokenX, x.tokenY] = [x.tokenY, x.tokenX], /token order/],
    ["bin step", (x) => x.binStep = 20, /bin step/],
    ["router link", (x) => x.routerFactory = A.router, /router points/],
    ["quoter link", (x) => x.quoterFactory = A.router, /quoter is not linked/],
    ["pair implementation", (x) => x.pairImplementation = A.router, /Pair implementation/],
    ["hooks mismatch", (x) => x.hooksParameters = `0x${"0".repeat(63)}1`, /hooks changed/]
  ]) {
    const changed = structuredClone(evidence);
    mutate(changed);
    assert.throws(() => evaluatePairEvidence(registry, claim, changed), pattern, name);
  }
  assert.throws(() => evaluatePairEvidence(registry, { ...claim, hooksParameters: null }, { ...evidence, hooksParameters: null }), /has not attested/);

  const ignored = structuredClone(evidence);
  ignored.indexerIgnoredForRouting = true;
  ignored.factoryLookupIgnored = true;
  assert.throws(() => evaluatePairEvidence(registry, { ...claim, indexerIgnoredForRouting: true }, ignored), /disabled this pair/);
  assert.equal(evaluatePairEvidence(registry, { ...claim, indexerIgnoredForRouting: true, operation: "remove-liquidity" }, { ...ignored, operation: "remove-liquidity" }).hookRisk, "none");

  const hookParameters = `0x${(1n << 160n | BigInt(A.hook)).toString(16).padStart(64, "0")}`;
  const allowlistedRegistry = {
    ...registry,
    supportedHooks: [{ address: A.hook, behavior: "Reviews swaps", codeHash: keccak256(code), flags: 1, identity: "Reviewed hook", risk: "medium", upgradeability: "immutable" }]
  };
  const hookedClaim = { ...claim, hooksParameters: hookParameters };
  const hookedEvidence = { ...evidence, hooksParameters: hookParameters, hookCode: code, hookLinked: true, hookPair: A.pair };
  const hooked = evaluatePairEvidence(allowlistedRegistry, hookedClaim, hookedEvidence);
  assert.equal(hooked.hookIdentity, "Reviewed hook");
  assert.deepEqual(hooked.hookFlags, ["before swap"]);
  assert.throws(() => evaluatePairEvidence(registry, hookedClaim, hookedEvidence), /not in this deployment's allowlist/);
  assert.throws(() => evaluatePairEvidence(allowlistedRegistry, hookedClaim, { ...hookedEvidence, hookCode: "0x6002" }), /bytecode changed/);
  assert.throws(() => evaluatePairEvidence(allowlistedRegistry, hookedClaim, { ...hookedEvidence, hookLinked: false }), /not linked/);
  assert.throws(() => evaluatePairEvidence(allowlistedRegistry, hookedClaim, { ...hookedEvidence, hookImplementation: A.router, hookImplementationCode: code }), /declared immutable/);
  const implementationCode = "0x6002600055";
  const proxyRegistry = { ...registry, supportedHooks: [{ ...allowlistedRegistry.supportedHooks[0], implementationAddress: A.router, implementationCodeHash: keccak256(implementationCode), upgradeability: "eip1967" }] };
  assert.equal(evaluatePairEvidence(proxyRegistry, hookedClaim, { ...hookedEvidence, hookImplementation: A.router, hookImplementationCode: implementationCode }).hookIdentity, "Reviewed hook");
  assert.throws(() => evaluatePairEvidence(proxyRegistry, hookedClaim, { ...hookedEvidence, hookImplementation: A.router, hookImplementationCode: "0x6003" }), /proxy implementation differs/);

  const fakeClient = (overrides = {}) => ({
    getBlockNumber: async () => 42n,
    getChainId: async () => overrides.chainId ?? 31337,
    getBytecode: async ({ address }) => {
      if (address.toLowerCase() === A.hook.toLowerCase()) return overrides.hookCode ?? code;
      if (address.toLowerCase() === A.router.toLowerCase() && overrides.proxyImplementationCode) return overrides.proxyImplementationCode;
      return overrides.missingCodeAddress?.toLowerCase() === address.toLowerCase() ? "0x" : code;
    },
    getStorageAt: async () => overrides.implementationSlot ?? `0x${"0".repeat(64)}`,
    readContract: async ({ address, functionName }) => {
      if (functionName === "getLBPairInformation") return { LBPair: overrides.existingPair ?? A.pair, binStep: 10, createdByOwner: false, ignoredForRouting: false };
      if (functionName === "getLBPairImplementation" || functionName === "implementation") return overrides.implementation ?? A.implementation;
      if (functionName === "getFactory") return overrides.routerFactory ?? A.factory;
      if (functionName === "getFactoryV2_2") return A.factory;
      if (functionName === "getRouterV2_2") return A.router;
      if (functionName === "getTokenX") return A.tokenX;
      if (functionName === "getTokenY") return A.tokenY;
      if (functionName === "getBinStep") return 10;
      if (functionName === "getLBHooksParameters") return overrides.hooksParameters ?? zeroHooks;
      if (functionName === "getLBPair") return overrides.hookPair ?? A.pair;
      if (functionName === "isLinked") return overrides.hookLinked ?? true;
      if (functionName === "getPreset") return [1n, 1n, 1n, 1n, 1n, 1n, 1n, overrides.presetOpen ?? true];
      if (functionName === "isQuoteAsset") return overrides.quoteAsset ?? true;
      throw new Error(`Unexpected fake read ${functionName} at ${address}`);
    }
  });
  assert.equal((await attestPairForWrite(fakeClient(), registry, claim)).hookRisk, "none");
  assert.equal((await attestPairForWrite(fakeClient({ hooksParameters: hookParameters }), allowlistedRegistry, hookedClaim)).hookIdentity, "Reviewed hook");
  await assert.rejects(attestPairForWrite(fakeClient({ hooksParameters: hookParameters, hookCode: "0x" }), allowlistedRegistry, hookedClaim), /no contract code/);
  await assert.rejects(attestPairForWrite(fakeClient({ hooksParameters: hookParameters, hookPair: A.router }), allowlistedRegistry, hookedClaim), /not linked/);
  const proxySlot = `0x${"0".repeat(24)}${A.router.slice(2).toLowerCase()}`;
  assert.equal((await attestPairForWrite(fakeClient({ hooksParameters: hookParameters, implementationSlot: proxySlot, proxyImplementationCode: implementationCode }), proxyRegistry, hookedClaim)).hookIdentity, "Reviewed hook");
  await assert.rejects(attestPairForWrite(fakeClient({ hooksParameters: hookParameters, implementationSlot: proxySlot, proxyImplementationCode: "0x6003" }), proxyRegistry, hookedClaim), /proxy implementation differs/);
  await assert.rejects(attestPairForWrite(fakeClient({ hooksParameters: hookParameters, implementationSlot: proxySlot }), allowlistedRegistry, hookedClaim), /declared immutable/);

  const reserved = `0x${(1n << 170n | BigInt(A.hook)).toString(16).padStart(64, "0")}`;
  assert.equal(decodeHooksParameters(reserved).reservedBits !== 0n, true);
  assert.throws(() => evaluatePairEvidence(allowlistedRegistry, { ...claim, hooksParameters: reserved }, { ...hookedEvidence, hooksParameters: reserved }), /unknown hook flags/);
  const noFlags = `0x${BigInt(A.hook).toString(16).padStart(64, "0")}`;
  assert.throws(() => evaluatePairEvidence(allowlistedRegistry, { ...claim, hooksParameters: noFlags }, { ...hookedEvidence, hooksParameters: noFlags }), /without any recognized callback/);

  const pool = {
    address: A.pair, binStep: "10", factoryAddress: A.factory, hooksParameters: zeroHooks,
    ignoredForRouting: false, tokenXAddress: A.tokenX, tokenYAddress: A.tokenY
  };
  await assert.rejects(
    attestSwapRouteForWrite({}, registry, { binSteps: [10n], pairs: [A.pair], pools: [pool], route: [A.tokenX, A.tokenY], versions: [2] }),
    /non-V2.2/
  );

  const createEvidence = {
    activeId: 8_388_608,
    binStep: 10,
    chainId: 31337,
    existingPair: getAddress("0x0000000000000000000000000000000000000000"),
    factoryHasCode: true,
    implementation: A.implementation,
    implementationHasCode: true,
    presetOpen: true,
    routerFactory: A.factory,
    routerHasCode: true,
    tokenX: A.tokenX,
    tokenY: A.tokenY,
    tokenYIsQuoteAsset: true
  };
  assert.equal(evaluateFactoryForCreate(registry, createEvidence).status, "ready-to-create");
  assert.equal((await attestFactoryForCreate(fakeClient({ existingPair: getAddress("0x0000000000000000000000000000000000000000") }), registry, { activeId: 8_388_608, binStep: 10, tokenX: A.tokenX, tokenY: A.tokenY })).status, "ready-to-create");
  await assert.rejects(attestFactoryForCreate(fakeClient({ existingPair: A.pair }), registry, { activeId: 8_388_608, binStep: 10, tokenX: A.tokenX, tokenY: A.tokenY }), /already resolves/);
  await assert.rejects(attestFactoryForCreate(fakeClient({ existingPair: getAddress("0x0000000000000000000000000000000000000000"), presetOpen: false }), registry, { activeId: 8_388_608, binStep: 10, tokenX: A.tokenX, tokenY: A.tokenY }), /closed/);
  await assert.rejects(attestFactoryForCreate(fakeClient({ existingPair: getAddress("0x0000000000000000000000000000000000000000"), quoteAsset: false }), registry, { activeId: 8_388_608, binStep: 10, tokenX: A.tokenX, tokenY: A.tokenY }), /quote asset/);
  for (const [name, mutation, pattern] of [
    ["closed preset", { presetOpen: false }, /preset is unavailable or closed/],
    ["foreign router", { routerFactory: A.router }, /different factory/],
    ["unsupported quote", { tokenYIsQuoteAsset: false }, /not an allowlisted/],
    ["existing canonical pair", { existingPair: A.pair }, /already resolves/],
    ["missing implementation", { implementationHasCode: false }, /implementation/],
    ["same token", { tokenY: A.tokenX }, /distinct nonzero/],
    ["invalid active id", { activeId: 2 ** 24 }, /uint24/]
  ]) {
    assert.throws(() => evaluateFactoryForCreate(registry, { ...createEvidence, ...mutation }), pattern, name);
  }
  await assert.rejects(
    attestSwapRouteForWrite({}, registry, { binSteps: [10n, 10n, 10n], pairs: [A.pair, A.pair, A.pair], pools: [pool], route: [A.tokenX, A.tokenY, A.tokenX, A.tokenY], versions: [3, 3, 3] }),
    /one or two/
  );

  console.log("pair attestation tests passed");
} finally {
  await server.close();
}
