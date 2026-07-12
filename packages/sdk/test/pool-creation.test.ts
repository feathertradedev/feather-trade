import assert from "node:assert/strict";
import test from "node:test";

import { zeroAddress, type Address, type PublicClient } from "viem";

import {
  MAX_FACTORY_QUOTE_ASSETS,
  readPoolCreationFactoryDiscovery,
  validatePoolCreationSelection
} from "../src/pool-creation.js";

const factory = "0x1000000000000000000000000000000000000001" as Address;
const semanticBase = "0xF000000000000000000000000000000000000001" as Address;
const quoteAsset = "0x2000000000000000000000000000000000000002" as Address;
const otherToken = "0x3000000000000000000000000000000000000003" as Address;

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
