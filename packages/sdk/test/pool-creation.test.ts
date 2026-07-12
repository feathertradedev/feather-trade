import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient
} from "viem";

import { lbFactoryAbi, lbRouterAbi } from "../src/abi.js";
import { priceQ128FromActiveId } from "../src/liquidity-price.js";
import {
  buildCreateLBPairTransaction,
  MAX_FACTORY_QUOTE_ASSETS,
  parseLBPairCreatedReceipt,
  preflightPoolCreation,
  readPoolCreationFactoryDiscovery,
  reconcileCreatedPool,
  type PoolCreationReceiptLog,
  validatePoolCreationSelection
} from "../src/pool-creation.js";

const factory = "0x1000000000000000000000000000000000000001" as Address;
const otherFactory = "0x1000000000000000000000000000000000000009" as Address;
const router = "0x1000000000000000000000000000000000000010" as Address;
const pair = "0x1000000000000000000000000000000000000020" as Address;
const otherPair = "0x1000000000000000000000000000000000000021" as Address;
const semanticBase = "0xF000000000000000000000000000000000000001" as Address;
const quoteAsset = "0x2000000000000000000000000000000000000002" as Address;
const otherToken = "0x3000000000000000000000000000000000000003" as Address;
const selection = { binStep: 25n, tokenX: semanticBase, tokenY: quoteAsset } as const;
const activeId = 8_388_609n;
const representedPriceQ128 = priceQ128FromActiveId(activeId, selection.binStep);

test("discovers deterministic open presets and quote assets at one pinned block", async () => {
  const calls: Array<{ args?: readonly unknown[]; blockNumber?: bigint; functionName: string }> = [];
  const client = discoveryClient(calls, {
    openBinSteps: [25n, 10n],
    quoteAssets: [otherToken, quoteAsset]
  });

  const discovery = await readPoolCreationFactoryDiscovery(client, factory, 42n);

  assert.deepEqual(discovery, {
    blockNumber: 42n,
    openBinSteps: [10n, 25n],
    quoteAssets: [quoteAsset, otherToken]
  });
  assert.equal(calls.length, 4);
  assert.equal(calls.every((call) => call.blockNumber === 42n), true);
  assert.deepEqual(
    calls.filter((call) => call.functionName === "getQuoteAssetAtIndex").map((call) => call.args),
    [[0n], [1n]]
  );

  assert.deepEqual(
    validatePoolCreationSelection(discovery, {
      binStep: 25n,
      tokenX: semanticBase,
      tokenY: quoteAsset
    }),
    { binStep: 25n, tokenX: semanticBase, tokenY: quoteAsset },
    "semantic X/Y order must be preserved even when address order differs"
  );
});

test("rejects malformed or duplicate factory discovery responses", async () => {
  for (const openBinSteps of [[0n], [65_536n], [10n, 10n]]) {
    await assert.rejects(
      readPoolCreationFactoryDiscovery(discoveryClient([], { openBinSteps, quoteAssets: [] }), factory, 42n),
      /nonzero uint16|duplicate open bin step/
    );
  }
  await assert.rejects(
    readPoolCreationFactoryDiscovery(
      discoveryClient([], { openBinSteps: [10n], quoteAssetCount: MAX_FACTORY_QUOTE_ASSETS + 1n, quoteAssets: [] }),
      factory,
      42n
    ),
    /quote-asset count/
  );
  await assert.rejects(
    readPoolCreationFactoryDiscovery(discoveryClient([], { openBinSteps: [10n], quoteAssets: [quoteAsset, quoteAsset] }), factory, 42n),
    /duplicate quote asset/
  );
  await assert.rejects(
    readPoolCreationFactoryDiscovery(discoveryClient([], { openBinSteps: [10n], quoteAssets: [zeroAddress] }), factory, 42n),
    /quote asset must be a nonzero address/
  );
});

test("selection validation preserves semantics and fails closed on unavailable authority", async () => {
  const discovery = await readPoolCreationFactoryDiscovery(
    discoveryClient([], { openBinSteps: [10n], quoteAssets: [quoteAsset] }),
    factory,
    42n
  );

  assert.throws(
    () => validatePoolCreationSelection(discovery, { binStep: 25n, tokenX: semanticBase, tokenY: quoteAsset }),
    /not an open factory preset/
  );
  assert.throws(
    () => validatePoolCreationSelection(discovery, { binStep: 10n, tokenX: semanticBase, tokenY: otherToken }),
    /not an allowed factory quote asset/
  );
  assert.throws(
    () => validatePoolCreationSelection(discovery, { binStep: 10n, tokenX: quoteAsset, tokenY: quoteAsset }),
    /must be distinct/
  );
  assert.throws(
    () => validatePoolCreationSelection(discovery, { binStep: 10n, tokenX: zeroAddress, tokenY: quoteAsset }),
    /tokenX must be a nonzero address/
  );
});

test("preflights a creatable pool at one block and builds exact semantic X/Y router calldata", async () => {
  const calls: Array<{ address?: Address; args?: readonly unknown[]; blockNumber?: bigint; functionName: string }> = [];
  const preflight = await preflightPoolCreation(poolPreflightClient(calls), factory, selection, 77n);

  assert.deepEqual(preflight, { kind: "creatable", blockNumber: 77n, selection });
  assert.equal(calls.length, 5);
  assert.equal(calls.every((call) => call.blockNumber === 77n), true);
  assert.deepEqual(
    calls.filter((call) => call.functionName === "getBytecode").map((call) => call.address),
    [semanticBase, quoteAsset]
  );
  assert.deepEqual(
    calls.find((call) => call.functionName === "getLBPairInformation")?.args,
    [semanticBase, quoteAsset, 25n],
    "duplicate lookup must not replace semantic order with lexical order"
  );

  assert.equal(preflight.kind, "creatable");
  if (preflight.kind !== "creatable") throw new Error("Expected creatable preflight");
  const transaction = buildCreateLBPairTransaction(router, preflight, activeId);
  assert.equal(transaction.to, router);
  assert.equal(transaction.value, 0n);
  assert.deepEqual(decodeFunctionData({ abi: lbRouterAbi, data: transaction.data }), {
    functionName: "createLBPair",
    args: [semanticBase, quoteAsset, Number(activeId), 25]
  });
  assert.throws(() => buildCreateLBPairTransaction(router, preflight, 1n << 24n), /activeId must fit uint24/);
  assert.throws(
    () => buildCreateLBPairTransaction(router, preflight, (1n << 23n) + (1n << 20n)),
    /Q128 power underflow/
  );
});

test("returns an existing pool without transaction data for either valid semantic orientation", async () => {
  const forward = await preflightPoolCreation(poolPreflightClient([], { existingPair: pair }), factory, selection, 77n);
  assert.deepEqual(forward, { kind: "existing", blockNumber: 77n, pair, selection });
  assert.equal("transaction" in forward, false);

  const reversedSelection = { binStep: 25n, tokenX: quoteAsset, tokenY: semanticBase } as const;
  const reversedCalls: Array<{ address?: Address; args?: readonly unknown[]; blockNumber?: bigint; functionName: string }> = [];
  const reversed = await preflightPoolCreation(
    poolPreflightClient(reversedCalls, { existingPair: pair }),
    factory,
    reversedSelection,
    77n
  );
  assert.deepEqual(reversed, { kind: "existing", blockNumber: 77n, pair, selection: reversedSelection });
  assert.deepEqual(reversedCalls.find((call) => call.functionName === "getLBPairInformation")?.args, [quoteAsset, semanticBase, 25n]);
});

test("preflight rejects no-code tokens, closed or malformed presets, disallowed Y, and malformed duplicates", async () => {
  await assert.rejects(
    preflightPoolCreation(poolPreflightClient([], { tokenXCode: "0x" }), factory, selection, 77n),
    /tokenX has no code/
  );
  await assert.rejects(
    preflightPoolCreation(poolPreflightClient([], { tokenYCode: undefined }), factory, selection, 77n),
    /tokenY has no code/
  );
  await assert.rejects(
    preflightPoolCreation(poolPreflightClient([], { presetOpen: false }), factory, selection, 77n),
    /preset 25 is closed/
  );
  await assert.rejects(
    preflightPoolCreation(poolPreflightClient([], { malformedPreset: true }), factory, selection, 77n),
    /malformed pool-creation preset/
  );
  await assert.rejects(
    preflightPoolCreation(poolPreflightClient([], { isQuoteAsset: false }), factory, selection, 77n),
    /tokenY is not an allowed/
  );
  await assert.rejects(
    preflightPoolCreation(poolPreflightClient([], { pairInformation: { binStep: 25, LBPair: zeroAddress, createdByOwner: false, ignoredForRouting: false } }), factory, selection, 77n),
    /inconsistent empty LB pair/
  );
});

test("parses exactly one successful matching factory LBPairCreated event at its receipt block", () => {
  const receipt = {
    blockNumber: 88n,
    status: "success",
    logs: [lbPairCreatedLog(factory, selection, pair, 3n)]
  } as const;
  assert.deepEqual(parseLBPairCreatedReceipt(receipt, factory, selection), {
    blockNumber: 88n,
    factory,
    pair,
    pid: 3n,
    selection
  });

  assert.throws(
    () => parseLBPairCreatedReceipt({ ...receipt, status: "reverted" }, factory, selection),
    /was not successful/
  );
  assert.throws(
    () => parseLBPairCreatedReceipt({ ...receipt, logs: [lbPairCreatedLog(otherFactory, selection, pair, 3n)] }, factory, selection),
    /exactly one.*received 0/
  );
  assert.throws(
    () => parseLBPairCreatedReceipt({ ...receipt, logs: [...receipt.logs, ...receipt.logs] }, factory, selection),
    /exactly one.*received 2/
  );
  assert.throws(
    () => parseLBPairCreatedReceipt({ ...receipt, logs: [lbPairCreatedLog(factory, { ...selection, tokenX: otherToken }, pair, 3n)] }, factory, selection),
    /fields do not match/
  );
  assert.throws(
    () => parseLBPairCreatedReceipt({ ...receipt, logs: [{ ...receipt.logs[0], data: "0x" }] }, factory, selection),
    /malformed LBPairCreated evidence/
  );
});

test("reconciles receipt-bound factory and live pair identity with exact price math", async () => {
  const created = parseLBPairCreatedReceipt(
    { blockNumber: 88n, status: "success", logs: [lbPairCreatedLog(factory, selection, pair, 3n)] },
    factory,
    selection
  );
  const calls: Array<{ address?: Address; args?: readonly unknown[]; blockNumber?: bigint; functionName: string }> = [];
  const reconciled = await reconcileCreatedPool(livePoolClient(calls, { idFromPrice: Number(activeId + 1n) }), {
    created,
    expectedActiveId: activeId,
    expectedPriceQ128: representedPriceQ128
  });

  assert.deepEqual(reconciled, {
    ...created,
    activeId,
    priceQ128: representedPriceQ128
  });
  assert.equal(calls.length, 9);
  assert.equal(calls.every((call) => call.blockNumber === 88n), true);
  assert.deepEqual(calls.find((call) => call.functionName === "getLBPairInformation")?.args, [semanticBase, quoteAsset, 25n]);
});

test("live reconciliation rejects registry, code, identity, active-ID, price, and tolerance mismatches", async () => {
  const created = {
    blockNumber: 88n,
    factory,
    pair,
    pid: 3n,
    selection
  } as const;
  const cases: Array<[Parameters<typeof livePoolClient>[1], RegExp]> = [
    [{ registeredPair: otherPair }, /factory lookup does not match/],
    [{ pairCode: "0x" }, /created pair has no code/],
    [{ liveFactory: otherFactory }, /pair factory does not match/],
    [{ tokenX: otherToken }, /token order does not match/],
    [{ tokenY: otherToken }, /token order does not match/],
    [{ binStep: 10 }, /bin step does not match/],
    [{ activeId: Number(activeId + 1n) }, /active ID does not match/],
    [{ priceQ128: representedPriceQ128 + 1n }, /price does not match/],
    [{ idFromPrice: Number(activeId + 2n) }, /more than one bin/]
  ];

  for (const [overrides, expectedError] of cases) {
    await assert.rejects(
      reconcileCreatedPool(livePoolClient([], overrides), {
        created,
        expectedActiveId: activeId,
        expectedPriceQ128: representedPriceQ128
      }),
      expectedError
    );
  }
  await assert.rejects(
    reconcileCreatedPool(livePoolClient([]), {
      created,
      expectedActiveId: activeId,
      expectedPriceQ128: representedPriceQ128 + 1n
    }),
    /Reviewed price does not match/
  );
});

interface PoolPreflightOverrides {
  existingPair?: Address;
  isQuoteAsset?: boolean;
  malformedPreset?: boolean;
  pairInformation?: unknown;
  presetOpen?: boolean;
  tokenXCode?: Hex;
  tokenYCode?: Hex;
}

function poolPreflightClient(
  calls: Array<{ address?: Address; args?: readonly unknown[]; blockNumber?: bigint; functionName: string }>,
  overrides: PoolPreflightOverrides = {}
): PublicClient {
  return {
    getBytecode: async (request: { address: Address; blockNumber?: bigint }) => {
      calls.push({ ...request, functionName: "getBytecode" });
      return request.address.toLowerCase() === semanticBase.toLowerCase()
        ? Object.prototype.hasOwnProperty.call(overrides, "tokenXCode") ? overrides.tokenXCode : "0x6001"
        : Object.prototype.hasOwnProperty.call(overrides, "tokenYCode") ? overrides.tokenYCode : "0x6002";
    },
    readContract: async (request: { args?: readonly unknown[]; blockNumber?: bigint; functionName: string }) => {
      calls.push(request);
      if (request.functionName === "getPreset") {
        return overrides.malformedPreset ? [1n] : [1n, 1n, 1n, 1n, 1n, 1n, 1n, overrides.presetOpen ?? true];
      }
      if (request.functionName === "isQuoteAsset") return overrides.isQuoteAsset ?? true;
      if (request.functionName === "getLBPairInformation") {
        if (overrides.pairInformation !== undefined) return overrides.pairInformation;
        return {
          binStep: overrides.existingPair === undefined ? 0 : 25,
          LBPair: overrides.existingPair ?? zeroAddress,
          createdByOwner: false,
          ignoredForRouting: false
        };
      }
      throw new Error(`Unexpected read ${request.functionName}`);
    }
  } as unknown as PublicClient;
}

function lbPairCreatedLog(
  emitter: Address,
  eventSelection: { binStep: bigint; tokenX: Address; tokenY: Address },
  createdPair: Address,
  pid: bigint
): PoolCreationReceiptLog {
  return {
    address: emitter,
    topics: encodeEventTopics({
      abi: lbFactoryAbi,
      eventName: "LBPairCreated",
      args: {
        tokenX: eventSelection.tokenX,
        tokenY: eventSelection.tokenY,
        binStep: eventSelection.binStep
      }
    }) as readonly Hex[],
    data: encodeAbiParameters(
      [
        { name: "LBPair", type: "address" },
        { name: "pid", type: "uint256" }
      ],
      [createdPair, pid]
    )
  };
}

interface LivePoolOverrides {
  activeId?: number;
  binStep?: number;
  idFromPrice?: number;
  liveFactory?: Address;
  pairCode?: Hex;
  priceQ128?: bigint;
  registeredPair?: Address;
  tokenX?: Address;
  tokenY?: Address;
}

function livePoolClient(
  calls: Array<{ address?: Address; args?: readonly unknown[]; blockNumber?: bigint; functionName: string }>,
  overrides: LivePoolOverrides = {}
): PublicClient {
  return {
    getBytecode: async (request: { address: Address; blockNumber?: bigint }) => {
      calls.push({ ...request, functionName: "getBytecode" });
      return overrides.pairCode ?? "0x6003";
    },
    readContract: async (request: { address: Address; args?: readonly unknown[]; blockNumber?: bigint; functionName: string }) => {
      calls.push(request);
      if (request.functionName === "getLBPairInformation") {
        return {
          binStep: 25,
          LBPair: overrides.registeredPair ?? pair,
          createdByOwner: false,
          ignoredForRouting: false
        };
      }
      if (request.functionName === "getFactory") return overrides.liveFactory ?? factory;
      if (request.functionName === "getTokenX") return overrides.tokenX ?? semanticBase;
      if (request.functionName === "getTokenY") return overrides.tokenY ?? quoteAsset;
      if (request.functionName === "getBinStep") return overrides.binStep ?? 25;
      if (request.functionName === "getActiveId") return overrides.activeId ?? Number(activeId);
      if (request.functionName === "getPriceFromId") return overrides.priceQ128 ?? representedPriceQ128;
      if (request.functionName === "getIdFromPrice") return overrides.idFromPrice ?? Number(activeId);
      throw new Error(`Unexpected read ${request.functionName}`);
    }
  } as unknown as PublicClient;
}

function discoveryClient(
  calls: Array<{ args?: readonly unknown[]; blockNumber?: bigint; functionName: string }>,
  response: { openBinSteps: bigint[]; quoteAssetCount?: bigint; quoteAssets: Address[] }
): PublicClient {
  return {
    readContract: async (request: { args?: readonly unknown[]; blockNumber?: bigint; functionName: string }) => {
      calls.push(request);
      if (request.functionName === "getOpenBinSteps") return response.openBinSteps;
      if (request.functionName === "getNumberOfQuoteAssets") return response.quoteAssetCount ?? BigInt(response.quoteAssets.length);
      if (request.functionName === "getQuoteAssetAtIndex") {
        const index = Number((request.args as readonly [bigint])[0]);
        const asset = response.quoteAssets[index];
        if (asset === undefined) throw new Error("Missing mock quote asset");
        return asset;
      }
      throw new Error(`Unexpected read ${request.functionName}`);
    }
  } as unknown as PublicClient;
}
