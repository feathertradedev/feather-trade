import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { decodeFunctionData, zeroAddress, type Address, type PublicClient } from "viem";

import {
  DISTRIBUTION_PRECISION,
  LB_ROUTER_VERSION_V2_2,
  ROBINHOOD_TESTNET_CHAIN_ID,
  applyBurnQuoteSlippage,
  applyLiquiditySlippageMin,
  assertQuoteMatchesExactInRequest,
  buildAddLiquidityTransaction,
  buildExactInCandidatePaths,
  buildExactInSwapTransaction,
  buildLiquidityDistribution,
  buildProtectedBurnMinimums,
  buildRemoveLiquidityTransaction,
  calculateAmountOutMin,
  deadlineFromNow,
  getBestExactInQuote,
  getTokens,
  findTokenBySymbol,
  lbRouterAbi,
  quoteLiquidityBurn,
  readDeploymentManifest,
  registryFromRobinhoodManifest,
  robinhoodTestnetChain,
  type ExactInQuote,
  type LocalnetDeploymentManifest,
  type RobinhoodDeploymentManifest
} from "../src/index.js";

const addresses = {
  deployer: "0x1000000000000000000000000000000000000001",
  factory: "0x2000000000000000000000000000000000000002",
  pairImplementation: "0x3000000000000000000000000000000000000003",
  router: "0x4000000000000000000000000000000000000004",
  quoter: "0x5000000000000000000000000000000000000005",
  weth: "0x7943e237c7F95DA44E0301572D358911207852Fa",
  usdc: "0x7000000000000000000000000000000000000007",
  pair: "0x8000000000000000000000000000000000000008",
  recipient: "0x9000000000000000000000000000000000000009",
  refund: "0xA00000000000000000000000000000000000000A"
} as const satisfies Record<string, Address>;
const legacyRoutingSlots = [
  "routerFactoryV1",
  "routerFactoryV2_1",
  "routerLegacyFactoryV2",
  "routerLegacyRouterV2"
] as const;

test("normalizes a Robinhood testnet manifest into chain, token, and contract registries", () => {
  const manifest = readManifestFixture({
    contracts: {
      lbFactory: lowerAddress(addresses.factory),
      lbPairImplementation: lowerAddress(addresses.pairImplementation),
      lbRouter: lowerAddress(addresses.router),
      lbQuoter: lowerAddress(addresses.quoter)
    },
    tokens: {
      wrappedNative: lowerAddress(addresses.weth)
    },
    quoteAssets: {
      wrappedNative: lowerAddress(addresses.weth),
      usdc: lowerAddress(addresses.usdc)
    }
  });
  const registry = fixtureRegistry(manifest);
  const tokens = getTokens(registry);

  assert.equal(manifest.chainId, ROBINHOOD_TESTNET_CHAIN_ID);
  assert.equal(registry.environment, "robinhoodTestnet");
  assert.equal(registry.chain, robinhoodTestnetChain);
  assert.equal(registry.contracts.lbRouter, addresses.router);
  const weth = findTokenBySymbol(tokens, "WETH");
  assert.ok(weth);
  assert.equal(weth.address, addresses.weth);
  assert.equal(weth.chainId, ROBINHOOD_TESTNET_CHAIN_ID);
  assert.equal(weth.tags.includes("wrapped-native"), true);
});

test("normalizes reviewed pair implementations and immutable or EIP-1967 hook policies", () => {
  const immutableHook = {
    address: addresses.pair,
    behavior: "Reviews swaps",
    codeHash: `0x${"11".repeat(32)}`,
    flags: 1,
    identity: "Reviewed immutable hook",
    risk: "low",
    upgradeability: "immutable"
  } as const;
  const proxyHook = {
    address: addresses.recipient,
    behavior: "Reviews liquidity",
    codeHash: `0x${"22".repeat(32)}`,
    flags: 48,
    identity: "Reviewed proxy hook",
    implementationAddress: addresses.refund,
    implementationCodeHash: `0x${"33".repeat(32)}`,
    risk: "medium",
    upgradeability: "eip1967"
  } as const;
  const manifest = readManifestFixture({
    supportedHooks: [immutableHook, proxyHook],
    supportedPairImplementations: [addresses.pairImplementation, addresses.pair]
  });
  const registry = fixtureRegistry(manifest);

  assert.deepEqual(registry.supportedPairImplementations, [addresses.pairImplementation, addresses.pair]);
  assert.equal(registry.supportedHooks[0]?.upgradeability, "immutable");
  assert.equal(registry.supportedHooks[1]?.implementationAddress, addresses.refund);
  assert.equal(registry.supportedHooks[1]?.implementationCodeHash, proxyHook.implementationCodeHash);
});

test("rejects ambiguous or incomplete pair and hook allowlist metadata", () => {
  const validHook = {
    address: addresses.pair,
    behavior: "Reviews swaps",
    codeHash: `0x${"11".repeat(32)}`,
    flags: 1,
    identity: "Reviewed hook",
    risk: "low",
    upgradeability: "immutable"
  };
  const invalidHookCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["zero flags", { ...validHook, flags: 0 }, /integer >= 1/],
    ["missing upgradeability", (({ upgradeability: _, ...hook }) => hook)(validHook), /upgradeability/],
    ["blank identity", { ...validHook, identity: "  " }, /identity must not be blank/],
    ["blank behavior", { ...validHook, behavior: "  " }, /behavior must not be blank/],
    ["bad runtime hash", { ...validHook, codeHash: "0x12" }, /bytes32 hex value/],
    ["proxy without implementation", { ...validHook, upgradeability: "eip1967" }, /require implementationAddress and implementationCodeHash/],
    ["immutable with implementation", { ...validHook, implementationAddress: addresses.refund }, /immutable hooks cannot declare proxy implementation fields/]
  ];

  for (const [name, hook, pattern] of invalidHookCases) {
    assert.throws(
      () => readManifestFixture({ supportedHooks: [hook] } as unknown as Partial<RobinhoodDeploymentManifest>),
      pattern,
      name
    );
  }
  assert.throws(
    () => readManifestFixture({ supportedHooks: [validHook, validHook] } as unknown as Partial<RobinhoodDeploymentManifest>),
    /Duplicate supported hook address/
  );
  assert.throws(
    () => readManifestFixture({ supportedPairImplementations: [] }),
    /nonempty address array/
  );
  assert.throws(
    () => readManifestFixture({ supportedPairImplementations: [addresses.pairImplementation, addresses.pairImplementation] }),
    /contains duplicates/
  );
  assert.throws(
    () => readManifestFixture({ supportedPairImplementations: [addresses.pair] }),
    /must include contracts\.lbPairImplementation/
  );
});

test("rejects removed Zap fields instead of silently accepting legacy manifests", () => {
  assert.throws(
    () => readManifestFixture({ zap: { pair: addresses.pair } } as Partial<RobinhoodDeploymentManifest>),
    /Zap metadata is no longer supported/
  );
  assert.throws(
    () =>
      readManifestFixture({
        contracts: {
          lbFactory: addresses.factory,
          lbPairImplementation: addresses.pairImplementation,
          lbRouter: addresses.router,
          lbQuoter: addresses.quoter,
          zap: addresses.pair
        }
      } as Partial<RobinhoodDeploymentManifest>),
    /Unexpected contracts field: zap/
  );
  assert.throws(
    () => readManifestFixture({ constructorArgs: { ...baseManifest().constructorArgs, zapRouter: addresses.router } }),
    /constructorArgs\.zapRouter is no longer supported/
  );
});

test("rejects every legacy routing constructor slot in Robinhood and localnet manifests", () => {
  const robinhoodManifest = baseManifest();
  const localnetManifest = baseLocalnetManifest();

  for (const slot of legacyRoutingSlots) {
    assert.throws(
      () =>
        readManifestFixture({
          constructorArgs: {
            ...robinhoodManifest.constructorArgs,
            [slot]: addresses.factory
          }
        }),
      new RegExp(`${slot}.*zero address`),
      `Robinhood ${slot}`
    );
    assert.throws(
      () =>
        readLocalnetManifestFixture({
          constructorArgs: {
            ...localnetManifest.constructorArgs,
            [slot]: addresses.factory
          }
        }),
      new RegExp(`${slot}.*zero address`),
      `localnet ${slot}`
    );
  }
});

test("builds exact-in swap calldata from a non-localnet registry with slippage and deadline helpers", () => {
  const registry = fixtureRegistry(readManifestFixture());
  const amountIn = 1_000_000_000_000_000_000n;
  const quotedOut = 2_000_000n;
  const amountOutMin = calculateAmountOutMin(quotedOut, 50n);
  const deadline = deadlineFromNow(20, 1_700_000_000);
  const quote: ExactInQuote = {
    route: [addresses.weth, addresses.usdc],
    pairs: [addresses.pair],
    binSteps: [25n],
    versions: [LB_ROUTER_VERSION_V2_2],
    amounts: [amountIn, quotedOut],
    virtualAmountsWithoutSlippage: [amountIn, 2_010_000n],
    fees: [1_000_000_000_000_000n]
  };

  const tx = buildExactInSwapTransaction(registry, quote, amountIn, amountOutMin, addresses.recipient, deadline);
  const decoded = decodeFunctionData({ abi: lbRouterAbi, data: tx.data });

  assert.equal(tx.to, addresses.router);
  assert.equal(tx.value, 0n);
  assert.equal(decoded.functionName, "swapExactTokensForTokens");
  assert.deepEqual(decoded.args, [
    amountIn,
    1_990_000n,
    {
      pairBinSteps: [25n],
      versions: [LB_ROUTER_VERSION_V2_2],
      tokenPath: [addresses.weth, addresses.usdc]
    },
    addresses.recipient,
    1_700_001_200n
  ]);

  assert.throws(
    () =>
      buildExactInSwapTransaction(
        registry,
        { ...quote, versions: [2] },
        amountIn,
        amountOutMin,
        addresses.recipient,
        deadline
      ),
    /Only V2\.2 swap route versions/
  );
  assert.throws(
    () =>
      buildExactInSwapTransaction(
        registry,
        { ...quote, pairs: [] },
        amountIn,
        amountOutMin,
        addresses.recipient,
        deadline
      ),
    /arrays do not match/
  );
  assert.throws(
    () =>
      assertQuoteMatchesExactInRequest(
        { ...quote, route: [addresses.usdc, addresses.weth] },
        { tokenIn: addresses.weth, tokenOut: addresses.usdc, amountIn }
      ),
    /does not start with the requested tokenIn/
  );
  assert.throws(
    () =>
      assertQuoteMatchesExactInRequest(
        { ...quote, amounts: [amountIn + 1n, quotedOut] },
        { tokenIn: addresses.weth, tokenOut: addresses.usdc, amountIn }
      ),
    /does not match the requested amountIn/
  );
  assert.throws(
    () => buildExactInSwapTransaction(registry, quote, amountIn + 1n, amountOutMin, addresses.recipient, deadline),
    /swap amount does not match the quote input amount/
  );
  assert.throws(() => deadlineFromNow(0.5, 1_700_000_000), /integer from 1 to 120/);
  assert.throws(() => deadlineFromNow(121, 1_700_000_000), /integer from 1 to 120/);
});

test("accepts structurally complete multi-hop V2.2 swap routes", () => {
  const registry = fixtureRegistry(readManifestFixture());
  const quote: ExactInQuote = {
    route: [addresses.weth, addresses.usdc, addresses.recipient],
    pairs: [addresses.pair, addresses.router],
    binSteps: [25n, 10n],
    versions: [LB_ROUTER_VERSION_V2_2, LB_ROUTER_VERSION_V2_2],
    amounts: [1_000n, 900n, 800n],
    virtualAmountsWithoutSlippage: [1_000n, 910n, 820n],
    fees: [1n, 1n]
  };

  assert.doesNotThrow(() => buildExactInSwapTransaction(registry, quote, 1_000n, 790n, addresses.recipient, 2n));
});

test("ranks direct and one-intermediary V2.2 quotes without binding to a selected pair", async () => {
  const registry = fixtureRegistry(readManifestFixture());
  const baseToken = Object.values(registry.tokens)[0];
  assert.ok(baseToken);
  const routingRegistry = {
    ...registry,
    tokens: {
      ...registry.tokens,
      BRIDGE: {
        ...baseToken,
        address: addresses.recipient,
        id: "bridge",
        symbol: "BRIDGE",
        tags: ["quote"] as const
      }
    }
  };
  const amountIn = 1_000n;
  const candidatePaths = buildExactInCandidatePaths(routingRegistry.tokens, addresses.weth, addresses.usdc);
  assert.deepEqual(candidatePaths, [
    [addresses.weth, addresses.usdc],
    [addresses.weth, addresses.recipient, addresses.usdc]
  ]);

  const client = {
    readContract: async ({ args }: { args: [Address[], bigint] }) => {
      const route = [...args[0]];
      const multiHop = route.length === 3;
      return {
        route,
        pairs: multiHop ? [addresses.pair, addresses.router] : [addresses.pair],
        binSteps: multiHop ? [25n, 10n] : [25n],
        versions: multiHop ? [LB_ROUTER_VERSION_V2_2, LB_ROUTER_VERSION_V2_2] : [LB_ROUTER_VERSION_V2_2],
        amounts: multiHop ? [amountIn, 975n, 950n] : [amountIn, 900n],
        virtualAmountsWithoutSlippage: multiHop ? [amountIn, 980n, 960n] : [amountIn, 910n],
        fees: multiHop ? [1n, 1n] : [1n]
      } satisfies ExactInQuote;
    }
  } as unknown as PublicClient;

  const best = await getBestExactInQuote(client, routingRegistry, addresses.weth, addresses.usdc, amountIn);
  assert.deepEqual(best.route, [addresses.weth, addresses.recipient, addresses.usdc]);
  assert.equal(best.amounts.at(-1), 950n);
});

test("rejects quoter responses that do not match the exact-in request context", async () => {
  const registry = fixtureRegistry(readManifestFixture());
  const requestedAmountIn = 1_000n;
  const baseQuote: ExactInQuote = {
    route: [addresses.weth, addresses.usdc],
    pairs: [addresses.pair],
    binSteps: [25n],
    versions: [LB_ROUTER_VERSION_V2_2],
    amounts: [requestedAmountIn, 900n],
    virtualAmountsWithoutSlippage: [requestedAmountIn, 910n],
    fees: [1n]
  };
  const clientReturning = (quote: ExactInQuote) =>
    ({ readContract: async () => quote }) as unknown as PublicClient;

  await assert.rejects(
    getBestExactInQuote(
      clientReturning({ ...baseQuote, route: [addresses.usdc, addresses.weth] }),
      registry,
      addresses.weth,
      addresses.usdc,
      requestedAmountIn
    ),
    /does not start with the requested tokenIn/
  );
  await assert.rejects(
    getBestExactInQuote(
      clientReturning({ ...baseQuote, amounts: [requestedAmountIn + 1n, 900n] }),
      registry,
      addresses.weth,
      addresses.usdc,
      requestedAmountIn
    ),
    /does not match the requested amountIn/
  );
});

test("rejects V1, V2, and V2.1 in direct and mixed V2.2 swap paths", () => {
  const registry = fixtureRegistry(readManifestFixture());
  const legacyVersions = [
    { label: "V1", version: 0 },
    { label: "V2", version: 1 },
    { label: "V2.1", version: 2 }
  ] as const;

  for (const legacy of legacyVersions) {
    for (const versions of [[legacy.version], [LB_ROUTER_VERSION_V2_2, legacy.version]]) {
      const mixed = versions.length === 2;
      const route = mixed ? [addresses.weth, addresses.recipient, addresses.usdc] : [addresses.weth, addresses.usdc];
      const pairs = mixed ? [addresses.pair, addresses.router] : [addresses.pair];
      const amounts = mixed ? [1_000n, 900n, 800n] : [1_000n, 800n];
      const quote: ExactInQuote = {
        route,
        pairs,
        binSteps: versions.map(() => 25n),
        versions: [...versions],
        amounts,
        virtualAmountsWithoutSlippage: [...amounts],
        fees: versions.map(() => 1n)
      };
      const caseLabel = `${mixed ? "mixed V2.2 + " : "direct "}${legacy.label}`;

      assert.throws(
        () => buildExactInSwapTransaction(registry, quote, 1_000n, 790n, addresses.recipient, 2n),
        /Only V2\.2 swap route versions/,
        `swap ${caseLabel}`
      );
    }
  }
});

test("builds one-sided liquidity ranges above and below the active bin without an atomic swap", () => {
  const registry = fixtureRegistry(readManifestFixture());
  const above = buildLiquidityDistribution(8_388_608, 1, 3);
  const below = buildLiquidityDistribution(8_388_608, -3, -1);

  assert.equal(above.mode, "token-x");
  assert.deepEqual(above.distributionX, [DISTRIBUTION_PRECISION / 3n, DISTRIBUTION_PRECISION / 3n, DISTRIBUTION_PRECISION / 3n + 1n]);
  assert.deepEqual(above.distributionY, [0n, 0n, 0n]);
  assert.equal(below.mode, "token-y");
  assert.deepEqual(below.distributionX, [0n, 0n, 0n]);
  assert.deepEqual(below.distributionY, [DISTRIBUTION_PRECISION / 3n, DISTRIBUTION_PRECISION / 3n, DISTRIBUTION_PRECISION / 3n + 1n]);

  const tx = buildAddLiquidityTransaction(registry, {
    tokenX: addresses.weth,
    tokenY: addresses.usdc,
    binStep: 25,
    amountX: 1_000n,
    amountY: 0n,
    amountXMin: 990n,
    amountYMin: 0n,
    activeIdDesired: 8_388_608,
    ...above,
    to: addresses.recipient,
    deadline: 1_700_000_600n
  });
  const decoded = decodeFunctionData({ abi: lbRouterAbi, data: tx.data });
  assert.equal(decoded.functionName, "addLiquidity");
  assert.equal(decoded.args[0].amountY, 0n);
  assert.deepEqual(decoded.args[0].distributionY, [0n, 0n, 0n]);

  assert.throws(
    () => buildAddLiquidityTransaction(registry, {
      tokenX: addresses.weth,
      tokenY: addresses.usdc,
      binStep: 25,
      amountX: 1_000n,
      amountY: 1n,
      activeIdDesired: 8_388_608,
      ...above,
      to: addresses.recipient,
      deadline: 1n
    }),
    /Token Y amount and minimum must be zero/
  );
  assert.doesNotThrow(() => buildAddLiquidityTransaction(registry, {
    tokenX: addresses.weth,
    tokenY: addresses.usdc,
    binStep: 25,
    amountX: 1_000n,
    amountY: 1_000n,
    activeIdDesired: 8_388_608,
    deltaIds: [-1n, 1n],
    distributionX: [0n, DISTRIBUTION_PRECISION / 2n],
    distributionY: [DISTRIBUTION_PRECISION / 2n, 0n],
    to: addresses.recipient,
    deadline: 1n
  }));
});

test("builds deterministic Spot, Curve, and Bid-Ask distributions within the 69-bin product envelope", () => {
  const spot = buildLiquidityDistribution(8_388_608, -2, 2, "spot");
  const curve = buildLiquidityDistribution(8_388_608, -2, 2, "curve");
  const bidAsk = buildLiquidityDistribution(8_388_608, -2, 2, "bid-ask");
  for (const distribution of [spot, curve, bidAsk]) {
    assert.equal(distribution.distributionX.reduce((sum, weight) => sum + weight, 0n), DISTRIBUTION_PRECISION);
    assert.equal(distribution.distributionY.reduce((sum, weight) => sum + weight, 0n), DISTRIBUTION_PRECISION);
    assert.equal(distribution.deltaIds.length, 5);
  }
  assert.equal(curve.distributionX[2] > curve.distributionX[4], true);
  assert.equal(curve.distributionY[2] > curve.distributionY[0], true);
  assert.equal(bidAsk.distributionX[4] > bidAsk.distributionX[2], true);
  assert.equal(bidAsk.distributionY[0] > bidAsk.distributionY[2], true);
  assert.deepEqual(buildLiquidityDistribution(8_388_608, -2, 2, "curve"), curve);

  assert.equal(buildLiquidityDistribution(8_388_608, -34, 34, "bid-ask").bins.length, 69);
  assert.throws(() => buildLiquidityDistribution(8_388_608, -34, 35, "spot"), /between 1 and 69 bins/);
  const seventyBins = Array.from({ length: 70 }, (_, index) => BigInt(index));
  assert.throws(
    () => buildAddLiquidityTransaction(fixtureRegistry(readManifestFixture()), {
      tokenX: addresses.weth,
      tokenY: addresses.usdc,
      binStep: 25,
      amountX: 1_000n,
      amountY: 0n,
      activeIdDesired: 8_388_608,
      deltaIds: seventyBins,
      distributionX: seventyBins.map((_, index) => index === 69 ? DISTRIBUTION_PRECISION : 0n),
      distributionY: seventyBins.map(() => 0n),
      to: addresses.recipient,
      deadline: 1n
    }),
    /at most 69 bins/
  );
  assert.throws(() => buildLiquidityDistribution(0, -1, 0, "curve"), /uint24 bin bounds/);
});

test("builds liquidity calldata against a manifest-driven production router", () => {
  const registry = fixtureRegistry(readManifestFixture());
  const distribution = buildLiquidityDistribution(8_388_608, -1, 1);
  const amountX = 10_000_000_000_000_000n;
  const amountY = 20_000_000n;
  const deadline = 1_700_000_600n;

  const addTx = buildAddLiquidityTransaction(registry, {
    tokenX: addresses.weth,
    tokenY: addresses.usdc,
    binStep: 25,
    amountX,
    amountY,
    amountXMin: applyLiquiditySlippageMin(amountX, 100n),
    amountYMin: applyLiquiditySlippageMin(amountY, 100n),
    activeIdDesired: 8_388_608,
    idSlippage: 2,
    ...distribution,
    to: addresses.recipient,
    refundTo: addresses.refund,
    deadline
  });
  const addDecoded = decodeFunctionData({ abi: lbRouterAbi, data: addTx.data });

  assert.equal(addTx.to, addresses.router);
  assert.equal(addDecoded.functionName, "addLiquidity");
  assert.deepEqual(addDecoded.args[0], {
    tokenX: addresses.weth,
    tokenY: addresses.usdc,
    binStep: 25n,
    amountX,
    amountY,
    amountXMin: 9_900_000_000_000_000n,
    amountYMin: 19_800_000n,
    activeIdDesired: 8_388_608n,
    idSlippage: 2n,
    deltaIds: [-1n, 0n, 1n],
    distributionX: [0n, DISTRIBUTION_PRECISION / 2n, DISTRIBUTION_PRECISION / 2n],
    distributionY: [DISTRIBUTION_PRECISION / 2n, DISTRIBUTION_PRECISION / 2n, 0n],
    to: addresses.recipient,
    refundTo: addresses.refund,
    deadline
  });

  const removeTx = buildRemoveLiquidityTransaction(registry, {
    tokenX: addresses.weth,
    tokenY: addresses.usdc,
    binStep: 25,
    minimums: buildProtectedBurnMinimums(1n, 2n, 0n),
    ids: [8_388_607n, 8_388_608n],
    amounts: [3n, 4n],
    to: addresses.recipient,
    deadline
  });
  const removeDecoded = decodeFunctionData({ abi: lbRouterAbi, data: removeTx.data });

  assert.equal(removeTx.to, addresses.router);
  assert.equal(removeDecoded.functionName, "removeLiquidity");
  assert.deepEqual(removeDecoded.args, [
    addresses.weth,
    addresses.usdc,
    25,
    1n,
    2n,
    [8_388_607n, 8_388_608n],
    [3n, 4n],
    addresses.recipient,
    deadline
  ]);

  assert.throws(() => buildProtectedBurnMinimums(0n, 0n), /At least one expected burn output must be nonzero/);

  const protectedBothSides = buildProtectedBurnMinimums(1n, 1n, 0n);
  const forgedZeroX = { ...protectedBothSides, amountXMin: 0n } as typeof protectedBothSides;
  assert.throws(
    () => buildRemoveLiquidityTransaction(registry, {
      tokenX: addresses.weth,
      tokenY: addresses.usdc,
      binStep: 25,
      minimums: forgedZeroX,
      ids: [8_388_608n],
      amounts: [1n],
      to: addresses.recipient,
      deadline
    }),
    /must be created by buildProtectedBurnMinimums/
  );
  assert.doesNotThrow(() => buildRemoveLiquidityTransaction(registry, {
    tokenX: addresses.weth,
    tokenY: addresses.usdc,
    binStep: 25,
    minimums: buildProtectedBurnMinimums(0n, 1n, 0n),
    ids: [8_388_608n],
    amounts: [1n],
    to: addresses.recipient,
    deadline
  }));

  assert.throws(
    () =>
      buildAddLiquidityTransaction(registry, {
        tokenX: addresses.weth,
        tokenY: addresses.usdc,
        binStep: 25,
        amountX,
        amountY,
        activeIdDesired: 8_388_608,
        idSlippage: 3,
        ...distribution,
        to: addresses.recipient,
        deadline
      }),
    /above 2 bins requires release-owner approval/
  );
  assert.throws(
    () => buildAddLiquidityTransaction(registry, {
      tokenX: addresses.weth,
      tokenY: addresses.usdc,
      binStep: 25,
      amountX,
      amountY,
      activeIdDesired: 8_388_608,
      idSlippage: -1,
      ...distribution,
      to: addresses.recipient,
      deadline
    }),
    /idSlippage must be from 0 to 2 bins/
  );
});

test("quotes LBPair burn outputs with per-bin round-down boundaries", () => {
  const partialQuote = quoteLiquidityBurn([
    {
      binId: 8_388_608n,
      amountToBurn: 1n,
      reserveX: 10n,
      reserveY: 20n,
      totalSupply: 3n
    }
  ]);

  assert.equal(partialQuote.amountXOut, 3n);
  assert.equal(partialQuote.amountYOut, 6n);
  assert.equal(partialQuote.bins[0]?.amountXOut, 3n);
  assert.equal(partialQuote.bins[0]?.amountYOut, 6n);

  const fullQuote = quoteLiquidityBurn([
    {
      binId: 16_777_215n,
      amountToBurn: 3n,
      reserveX: 10n,
      reserveY: 20n,
      totalSupply: 3n
    }
  ]);
  assert.equal(fullQuote.amountXOut, 10n);
  assert.equal(fullQuote.amountYOut, 20n);

  assert.throws(
    () =>
      quoteLiquidityBurn([
        { binId: 1n, amountToBurn: 1n, reserveX: 1n, reserveY: 1n, totalSupply: 2n }
      ]),
    /rounds both outputs to zero/
  );
  assert.throws(
    () =>
      quoteLiquidityBurn([
        { binId: 16_777_216n, amountToBurn: 1n, reserveX: 1n, reserveY: 0n, totalSupply: 1n }
      ]),
    /binId must be an unsigned integer/
  );
});

test("aggregates multi-bin and one-sided LBPair burn outputs after per-bin rounding", () => {
  const quote = quoteLiquidityBurn([
    {
      binId: 8_388_607n,
      amountToBurn: 3n,
      reserveX: 100n,
      reserveY: 50n,
      totalSupply: 10n
    },
    {
      binId: 8_388_608n,
      amountToBurn: 2n,
      reserveX: 0n,
      reserveY: 99n,
      totalSupply: 9n
    },
    {
      binId: 8_388_609n,
      amountToBurn: 1n,
      reserveX: 77n,
      reserveY: 0n,
      totalSupply: 7n
    }
  ]);

  assert.deepEqual(
    quote.bins.map(({ amountXOut, amountYOut }) => [amountXOut, amountYOut]),
    [
      [30n, 15n],
      [0n, 22n],
      [11n, 0n]
    ]
  );
  assert.equal(quote.amountXOut, 41n);
  assert.equal(quote.amountYOut, 37n);

  assert.throws(
    () =>
      quoteLiquidityBurn([
        { binId: 1n, amountToBurn: 1n, reserveX: 1n, reserveY: 0n, totalSupply: 1n },
        { binId: 1n, amountToBurn: 1n, reserveX: 1n, reserveY: 0n, totalSupply: 1n }
      ]),
    /Duplicate burn bin id/
  );
  assert.throws(
    () => quoteLiquidityBurn([{ binId: 1n, amountToBurn: 2n, reserveX: 1n, reserveY: 0n, totalSupply: 1n }]),
    /no greater than total supply/
  );
});

test("applies default burn slippage while preserving nonzero output protection", () => {
  assert.deepEqual(applyBurnQuoteSlippage({ amountXOut: 10_000n, amountYOut: 1n }), {
    expectedAmountXOut: 10_000n,
    expectedAmountYOut: 1n,
    amountXMin: 9_950n,
    amountYMin: 1n,
    slippageBps: 50n
  });
  assert.deepEqual(applyBurnQuoteSlippage({ amountXOut: 0n, amountYOut: 25n }), {
    expectedAmountXOut: 0n,
    expectedAmountYOut: 25n,
    amountXMin: 0n,
    amountYMin: 24n,
    slippageBps: 50n
  });
  assert.deepEqual(applyBurnQuoteSlippage({ amountXOut: 10n, amountYOut: 20n }, 0n), {
    expectedAmountXOut: 10n,
    expectedAmountYOut: 20n,
    amountXMin: 10n,
    amountYMin: 20n,
    slippageBps: 0n
  });

  assert.throws(
    () => applyBurnQuoteSlippage({ amountXOut: 1n, amountYOut: 1n }, 10_000n),
    /between 0 and 9999/
  );
});

function readManifestFixture(overrides: Partial<RobinhoodDeploymentManifest> = {}): RobinhoodDeploymentManifest {
  const dir = mkdtempSync(join(tmpdir(), "robinhood-sdk-manifest-"));
  const path = join(dir, "manifest.json");

  try {
    writeFileSync(path, JSON.stringify({ ...baseManifest(), ...overrides }));
    return readDeploymentManifest(path) as RobinhoodDeploymentManifest;
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function readLocalnetManifestFixture(overrides: Partial<LocalnetDeploymentManifest> = {}): LocalnetDeploymentManifest {
  const dir = mkdtempSync(join(tmpdir(), "localnet-sdk-manifest-"));
  const path = join(dir, "manifest.json");

  try {
    writeFileSync(path, JSON.stringify({ ...baseLocalnetManifest(), ...overrides }));
    return readDeploymentManifest(path) as LocalnetDeploymentManifest;
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function baseManifest(): RobinhoodDeploymentManifest {
  return {
    schemaVersion: "lb.robinhood.v1",
    environment: "testnet",
    sourceJoeV2Commit: "1111111111111111111111111111111111111111",
    chainId: ROBINHOOD_TESTNET_CHAIN_ID,
    startBlock: 123_456,
    deployer: addresses.deployer,
    endpoints: {
      rpcUrl: "https://rpc.testnet.chain.robinhood.com",
      indexerUrl: null,
      apiUrl: null,
      tokenListUrl: null
    },
    contracts: {
      lbFactory: addresses.factory,
      lbPairImplementation: addresses.pairImplementation,
      lbRouter: addresses.router,
      lbQuoter: addresses.quoter
    },
    ownership: {
      feeRecipient: addresses.deployer,
      initialOwner: addresses.deployer,
      lbFactoryOwner: addresses.deployer
    },
    tokens: {
      wrappedNative: addresses.weth
    },
    chain: {
      name: "Robinhood Chain Testnet",
      nativeCurrency: "ETH",
      rpcEnvVar: "ROBINHOOD_TESTNET_RPC_URL",
      explorerUrl: "https://explorer.testnet.chain.robinhood.com",
      verifierUrl: "https://explorer.testnet.chain.robinhood.com/api/"
    },
    quoteAssets: {
      wrappedNative: addresses.weth,
      usdc: addresses.usdc
    },
    factoryPreset: {
      binStep: 25,
      baseFactor: 10_000,
      filterPeriod: 30,
      decayPeriod: 600,
      reductionFactor: 5_000,
      variableFeeControl: 40_000,
      protocolShare: 1_000,
      maxVolatilityAccumulator: 350_000,
      open: true
    },
    constructorArgs: {
      routerFactoryV1: zeroAddress,
      routerFactoryV2_1: zeroAddress,
      routerLegacyFactoryV2: zeroAddress,
      routerLegacyRouterV2: zeroAddress
    }
  };
}

function baseLocalnetManifest(): LocalnetDeploymentManifest {
  return {
    schemaVersion: "lb.localnet.v1",
    environment: "localnet",
    sourceJoeV2Commit: "1111111111111111111111111111111111111111",
    chainId: 31_337,
    startBlock: 0,
    deployer: addresses.deployer,
    endpoints: {
      rpcUrl: "http://127.0.0.1:8545",
      indexerUrl: null,
      apiUrl: null,
      tokenListUrl: null
    },
    contracts: {
      lbFactory: addresses.factory,
      lbPairImplementation: addresses.pairImplementation,
      lbRouter: addresses.router,
      lbQuoter: addresses.quoter
    },
    ownership: {
      feeRecipient: addresses.deployer,
      initialOwner: addresses.deployer,
      lbFactoryOwner: addresses.deployer
    },
    tokens: {
      wnative: addresses.weth,
      usdc: addresses.usdc,
      usdt: addresses.recipient,
      weth: addresses.refund
    },
    factoryPreset: {
      binStep: 25,
      baseFactor: 10_000,
      filterPeriod: 30,
      decayPeriod: 600,
      reductionFactor: 5_000,
      variableFeeControl: 40_000,
      protocolShare: 1_000,
      maxVolatilityAccumulator: 350_000,
      open: true
    },
    seededPools: {
      wnativeUsdc: {
        pair: addresses.pair,
        tokenX: addresses.weth,
        tokenY: addresses.usdc,
        activeId: 8_388_608,
        binStep: 25
      }
    },
    constructorArgs: {
      feeRecipient: addresses.deployer,
      initialOwner: addresses.deployer,
      routerFactoryV1: zeroAddress,
      routerFactoryV2_1: zeroAddress,
      routerLegacyFactoryV2: zeroAddress,
      routerLegacyRouterV2: zeroAddress,
      routerWNative: addresses.weth
    },
    smoke: {}
  };
}

function fixtureRegistry(manifest: RobinhoodDeploymentManifest) {
  const registry = registryFromRobinhoodManifest(manifest);
  const template = Object.values(registry.tokens)[0];
  assert.ok(template);
  registry.tokens[addresses.usdc.toLowerCase()] = {
    ...template,
    address: addresses.usdc,
    decimals: 6,
    id: "fixture-usdc",
    name: "Fixture USDC",
    symbol: "USDC",
    tags: ["quote"]
  };
  registry.tokens[addresses.recipient.toLowerCase()] = {
    ...template,
    address: addresses.recipient,
    decimals: 18,
    id: "fixture-bridge",
    name: "Fixture Bridge",
    symbol: "BRIDGE",
    tags: []
  };
  return registry;
}

function lowerAddress(address: Address): Address {
  return address.toLowerCase() as Address;
}
