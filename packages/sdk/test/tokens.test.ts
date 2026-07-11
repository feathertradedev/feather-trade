import assert from "node:assert/strict";
import test from "node:test";

import { getAddress } from "viem";

import {
  findTokenBySymbol,
  searchTokenMetadata,
  tokenAllowsAction,
  tokenListToMetadataMap,
  tokenSupportsExecutableApproval,
  type TokenListDefinition
} from "../src/tokens.js";
import { getBestExactInQuote } from "../src/swap.js";

const first = "0x1000000000000000000000000000000000000001";
const second = "0x2000000000000000000000000000000000000002";

test("stores same-symbol tokens by canonical address and makes symbol-only lookup fail closed", () => {
  const tokens = tokenListToMetadataMap(list([
    entry("usd-a", "USD", "Dollar A", first, "standard-bool", 6),
    entry("usd-b", "USD", "Dollar B", second, "standard-bool", 8)
  ]));

  assert.deepEqual(Object.keys(tokens), [first.toLowerCase(), second.toLowerCase()]);
  assert.equal(findTokenBySymbol(tokens, "USD"), null);
  assert.deepEqual(searchTokenMetadata(tokens, "dollar").map((token) => token.address), [getAddress(first), getAddress(second)]);
  assert.deepEqual(searchTokenMetadata(tokens, second).map((token) => token.name), ["Dollar B"]);
});

test("approval capability is explicit and only standard bool-return tokens execute", () => {
  for (const [behavior, executable] of [
    ["standard-bool", true],
    ["returns-false", false],
    ["no-return", false],
    ["zero-reset-required", false]
  ] as const) {
    const token = Object.values(tokenListToMetadataMap(list([entry(`token-${behavior}`, "TOK", "Token", first, behavior, 18)])))[0];
    assert.ok(token);
    assert.equal(tokenSupportsExecutableApproval(token), executable);
    assert.equal(tokenAllowsAction(token, "swap"), executable);
    assert.equal(tokenAllowsAction(token, "add-liquidity"), executable);
    assert.equal(tokenAllowsAction(token, "remove-liquidity"), true);
  }
});

test("runtime loader rejects missing/invalid capability and duplicate address or id", () => {
  const missing = entry("missing", "MISS", "Missing", first, "standard-bool", 18) as unknown as Record<string, unknown>;
  delete missing.approvalBehavior;
  assert.throws(() => tokenListToMetadataMap(list([missing as never])), /valid explicit approval behavior/);
  assert.throws(
    () => tokenListToMetadataMap(list([{ ...entry("invalid", "BAD", "Bad", first, "standard-bool", 18), approvalBehavior: "permit-only" } as never])),
    /valid explicit approval behavior/
  );
  assert.throws(
    () => tokenListToMetadataMap(list([{ ...entry("decimals", "DEC", "Decimals", first, "standard-bool", 18), decimals: 1.5 }])),
    /decimals must be an integer from 0 to 255/
  );
  assert.throws(() => tokenListToMetadataMap(list([
    entry("one", "ONE", "One", first, "standard-bool", 18),
    entry("two", "TWO", "Two", first, "standard-bool", 18)
  ])), /Duplicate token address/);
  assert.throws(() => tokenListToMetadataMap(list([
    entry("same", "ONE", "One", first, "standard-bool", 18),
    entry("same", "TWO", "Two", second, "standard-bool", 18)
  ])), /Duplicate token id/);
});

test("unsupported direct swap endpoints fail before any RPC request", async () => {
  const tokens = tokenListToMetadataMap(list([
    entry("unsupported", "BAD", "Unsupported", first, "no-return", 18),
    entry("output", "OUT", "Output", second, "standard-bool", 18)
  ]));
  let rpcCalls = 0;
  const client = { readContract: async () => { rpcCalls += 1; throw new Error("must not call RPC"); } };
  const contracts = { lbFactory: getAddress(first), lbPairImplementation: getAddress(first), lbQuoter: getAddress(first), lbRouter: getAddress(first) };

  await assert.rejects(
    getBestExactInQuote(client as never, { contracts, tokens }, getAddress(first), getAddress(second), 1n),
    /unsupported approval behavior no-return/
  );
  assert.equal(rpcCalls, 0);
});

function list(tokens: TokenListDefinition["tokens"]): TokenListDefinition {
  return { chainId: 31337, environment: "localnet", name: "fixture", schemaVersion: "lb.token-list.v1", tokens, updatedAt: "2026-07-11" };
}

function entry(
  id: string,
  symbol: string,
  name: string,
  address: string,
  approvalBehavior: "standard-bool" | "returns-false" | "no-return" | "zero-reset-required",
  decimals: number
): TokenListDefinition["tokens"][number] {
  return { address: getAddress(address), approvalBehavior, decimals, id, logoURI: "/token-assets/weth.svg", name, symbol, tags: [] };
}
