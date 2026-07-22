import assert from "node:assert/strict";
import test from "node:test";

import { TrustedPriceBook, USD_SCALE, type PricePolicy, type PriceSample } from "../src/index.js";

const TOKEN = "0xprice";
const policy: PricePolicy = {
  token: TOKEN,
  source: "chainlink-data-streams",
  feedId: "price-usd",
  maxAgeSeconds: 10_000,
  maxConfidenceBps: 100
};

test("indexes out-of-order trusted samples while preserving sequence and timestamp semantics", () => {
  const book = new TrustedPriceBook([policy]);
  const apply = (observedAt: number, sequence: bigint, value: bigint) => book.apply(
    sample(observedAt, sequence, value),
    1_000
  );

  apply(300, 3n, 30n * USD_SCALE);
  apply(100, 1n, 10n * USD_SCALE);
  apply(200, 2n, 20n * USD_SCALE);
  apply(200, 4n, 24n * USD_SCALE);
  apply(50, 4n, 999n * USD_SCALE); // duplicate sequence remains first-write-wins

  assert.equal(book.get(TOKEN, 99).priceUsdE18, null);
  assert.equal(book.get(TOKEN, 100).priceUsdE18, 10n * USD_SCALE);
  assert.equal(book.get(TOKEN, 199).priceUsdE18, 10n * USD_SCALE);
  assert.equal(book.get(TOKEN, 200).priceUsdE18, 24n * USD_SCALE, "highest sequence wins at one timestamp");
  assert.equal(book.get(TOKEN, 300).priceUsdE18, 30n * USD_SCALE);
});

function sample(observedAt: number, sequence: bigint, priceUsdE18: bigint): PriceSample {
  return {
    token: TOKEN,
    source: "chainlink-data-streams",
    feedId: "price-usd",
    priceUsdE18,
    confidenceUsdE18: priceUsdE18 / 1_000n,
    observedAt,
    sequence,
    verifiedBy: "test-verifier"
  };
}
