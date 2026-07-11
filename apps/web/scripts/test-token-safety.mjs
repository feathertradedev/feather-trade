import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, parseUnits } from "viem";
import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({ configFile: resolve(webRoot, "vite.config.ts"), logLevel: "error", server: { middlewareMode: true } });

try {
  const {
    UINT256_MAX,
    approvalMode,
    assertExecutableTokenAction,
    deterministicTokenFallback,
    exactApprovalDisclosure,
    maxAmountInput,
    parseTokenAmount,
    poolChoiceIdentityLabel,
    safeMaxAmount
  } = await server.ssrLoadModule("/src/token-safety.ts");

  for (const decimals of [6, 8, 18]) {
    assert.deepEqual(parseTokenAmount(`1.${"0".repeat(decimals - 1)}1`, decimals), { amount: 10n ** BigInt(decimals) + 1n, error: null });
    assert.deepEqual(parseTokenAmount(`0.${"0".repeat(decimals - 1)}1`, decimals), { amount: 1n, error: null });
    assert.equal(parseTokenAmount(`1.${"0".repeat(decimals)}1`, decimals).error, "overprecision");
  }
  assert.equal(parseTokenAmount(UINT256_MAX.toString(), 0).amount, UINT256_MAX);
  assert.equal(parseTokenAmount((UINT256_MAX + 1n).toString(), 0).error, "overflow");
  assert.equal(parseTokenAmount("1.000001", 6, 1_000_000n).error, "over-balance");
  assert.equal(parseTokenAmount("0.000000", 6).error, "zero");
  assert.equal(parseTokenAmount("1e6", 18).error, "invalid-format");
  assert.equal(parseTokenAmount(".5", 18).amount, 500_000_000_000_000_000n);
  assert.equal(parseTokenAmount(".000001", 6).amount, 1n);
  assert.equal(parseTokenAmount("9".repeat(400), 18).error, "overflow");
  assert.equal(parseTokenAmount("0".repeat(10_000), 18).error, "overflow");
  assert.equal(parseTokenAmount(`${"0".repeat(10_000)}1`, 18).error, "overflow");

  assert.equal(safeMaxAmount({ asset: "token", balance: 123n }), 123n);
  assert.equal(safeMaxAmount({ asset: "native", balance: 100n, gasReserveWei: 31n }), 69n);
  assert.equal(safeMaxAmount({ asset: "native", balance: 30n, gasReserveWei: 31n }), 0n);
  assert.throws(() => safeMaxAmount({ asset: "native", balance: 100n }), /reviewed gas reserve/);
  assert.throws(() => safeMaxAmount({ asset: "native", balance: 100n, gasReserveWei: -1n }), /uint256 bounds/);
  assert.equal(maxAmountInput({ asset: "token", balance: parseUnits("123.456789", 6), decimals: 6 }), "123.456789");
  assert.throws(() => maxAmountInput({ asset: "token", balance: 1n, decimals: 256 }), /integer from 0 to 255/);
  assert.throws(() => maxAmountInput({ asset: "native", balance: 1n, decimals: 8, gasReserveWei: 0n }), /requires 18 decimals/);

  const standard = token("standard-bool");
  const excluded = token("returns-false");
  assert.equal(approvalMode(standard), "standard");
  assert.equal(approvalMode(excluded), "special / excluded");
  assert.match(exactApprovalDisclosure({ amount: 1_234_567n, spender: getAddress("0x3000000000000000000000000000000000000003"), token: standard }), /Exact raw amount: 1234567/);
  assert.match(exactApprovalDisclosure({ amount: 1n, spender: null, token: excluded }), /Approval behavior: returns-false/);
  assert.deepEqual(deterministicTokenFallback(standard), deterministicTokenFallback({ ...standard }));
  const sameSymbolOtherAddress = { ...standard, address: getAddress("0x2000000000000000000000000000000000000002"), name: "Dollar Alternate" };
  const firstChoice = poolChoiceIdentityLabel({ address: getAddress("0x4000000000000000000000000000000000000004"), tokenX: standard, tokenXAddress: standard.address, tokenY: sameSymbolOtherAddress, tokenYAddress: sameSymbolOtherAddress.address });
  const reversedChoice = poolChoiceIdentityLabel({ address: getAddress("0x5000000000000000000000000000000000000005"), tokenX: sameSymbolOtherAddress, tokenXAddress: sameSymbolOtherAddress.address, tokenY: standard, tokenYAddress: standard.address });
  assert.match(firstChoice, /Dollar \(USD · 0x1000/);
  assert.match(firstChoice, /Dollar Alternate \(USD · 0x2000/);
  assert.notEqual(firstChoice, reversedChoice);

  let downstreamCalls = 0;
  assert.throws(() => {
    assertExecutableTokenAction([excluded], "swap");
    downstreamCalls += 1;
  }, /unsupported approval behavior/);
  assert.equal(downstreamCalls, 0);
  console.log("token safety tests passed");
} finally {
  await server.close();
}

function token(approvalBehavior) {
  return {
    address: getAddress("0x1000000000000000000000000000000000000001"),
    approvalBehavior,
    chainId: 31337,
    decimals: 6,
    id: "usd",
    logoURI: "/missing.svg",
    name: "Dollar",
    risk: { disabledActions: [], flags: [], reviewStatus: "standard" },
    symbol: "USD",
    tags: []
  };
}
