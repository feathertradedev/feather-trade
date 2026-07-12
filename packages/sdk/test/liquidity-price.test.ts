import assert from "node:assert/strict";
import test from "node:test";
import type { Address, PublicClient } from "viem";

import { buildLiquidityDistribution } from "../src/liquidity.js";
import {
  decimalPriceToQ128,
  formatExactPriceFraction,
  normalizeQ128Price,
  Q128,
  readIdFromPrice,
  readPriceFromId
} from "../src/liquidity-price.js";

const PAIR = "0x00000000000000000000000000000000000000aa" as Address;
const MAX_UINT256 = (1n << 256n) - 1n;

test("normalizes equal-decimal Q128 prices as exact reduced fractions", () => {
  assert.deepEqual(normalizeQ128Price(Q128 * 3n, { baseDecimals: 18, quoteDecimals: 18 }), {
    numerator: 3n,
    denominator: 1n
  });
  assert.equal(decimalPriceToQ128("3", { baseDecimals: 18, quoteDecimals: 18 }), Q128 * 3n);
});

test("normalizes unequal 18-to-6 and 6-to-18 token decimals without floating point", () => {
  assert.deepEqual(normalizeQ128Price(Q128, { baseDecimals: 18, quoteDecimals: 6 }), {
    numerator: 1_000_000_000_000n,
    denominator: 1n
  });
  assert.equal(decimalPriceToQ128("1000000000000", { baseDecimals: 18, quoteDecimals: 6 }), Q128);

  assert.deepEqual(normalizeQ128Price(Q128, { baseDecimals: 6, quoteDecimals: 18 }), {
    numerator: 1n,
    denominator: 1_000_000_000_000n
  });
  assert.equal(decimalPriceToQ128("0.000000000001", { baseDecimals: 6, quoteDecimals: 18 }), Q128);
});

test("inverse display is the exact reciprocal and converts back to the same Q128 price", () => {
  const forward = normalizeQ128Price(Q128 * 4n, { baseDecimals: 18, quoteDecimals: 6 });
  const inverse = normalizeQ128Price(Q128 * 4n, { baseDecimals: 18, quoteDecimals: 6, inverse: true });

  assert.equal(forward.numerator * inverse.numerator, forward.denominator * inverse.denominator);
  assert.equal(decimalPriceToQ128("0.00000000000025", { baseDecimals: 18, quoteDecimals: 6, inverse: true }), Q128 * 4n);
});

test("formats exact fractions as bounded decimal strings without floating point", () => {
  assert.equal(formatExactPriceFraction({ numerator: 3n, denominator: 2n }), "1.5");
  assert.equal(formatExactPriceFraction({ numerator: 1n, denominator: 1_000_000_000_000n }), "0.000000000001");
  assert.equal(formatExactPriceFraction({ numerator: 1n, denominator: 3n }, 4), "0.3333");
  assert.throws(() => formatExactPriceFraction({ numerator: 0n, denominator: 1n }));
});

test("rejects invalid decimal strings, decimal metadata, underflow, and uint256 overflow", () => {
  for (const value of ["", " 1", "1 ", "-1", "+1", "1e3", ".5", "01", "0", "1."]) {
    assert.throws(() => decimalPriceToQ128(value, { baseDecimals: 18, quoteDecimals: 18 }));
  }
  assert.throws(() => decimalPriceToQ128("1", { baseDecimals: -1, quoteDecimals: 18 }));
  assert.throws(() => decimalPriceToQ128("1", { baseDecimals: 18, quoteDecimals: 256 }));
  assert.throws(() => decimalPriceToQ128("0.000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", { baseDecimals: 18, quoteDecimals: 18 }));
  assert.throws(() => decimalPriceToQ128(MAX_UINT256.toString(), { baseDecimals: 0, quoteDecimals: 0 }));
  assert.throws(() => normalizeQ128Price(0n, { baseDecimals: 18, quoteDecimals: 18 }));
  assert.throws(() => normalizeQ128Price(MAX_UINT256 + 1n, { baseDecimals: 18, quoteDecimals: 18 }));
});

test("thin readers use exact LBPair price functions and preserve the pinned block", async () => {
  const calls: unknown[] = [];
  const client = {
    readContract: async (request: { functionName: string }) => {
      calls.push(request);
      return request.functionName === "getPriceFromId" ? Q128 * 2n : 8_388_609;
    }
  } as unknown as PublicClient;

  assert.equal(await readPriceFromId(client, PAIR, 8_388_608n, { blockNumber: 42n }), Q128 * 2n);
  assert.equal(await readIdFromPrice(client, PAIR, Q128 * 2n, { blockNumber: 42n }), 8_388_609n);
  assert.deepEqual(calls.map((call) => {
    const request = call as { args: readonly unknown[]; blockNumber: bigint; functionName: string };
    return { args: request.args, blockNumber: request.blockNumber, functionName: request.functionName };
  }), [
    { args: [8_388_608], blockNumber: 42n, functionName: "getPriceFromId" },
    { args: [Q128 * 2n], blockNumber: 42n, functionName: "getIdFromPrice" }
  ]);
});

test("distribution boundaries explicitly accept 1 and 69 bins and reject 70", () => {
  assert.equal(buildLiquidityDistribution(8_388_608, 0, 0, "spot").bins.length, 1);
  assert.equal(buildLiquidityDistribution(8_388_608, 0, 68, "curve").bins.length, 69);
  assert.throws(() => buildLiquidityDistribution(8_388_608, 0, 69, "bid-ask"), /between 1 and 69 bins/);
});
