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

test("uses zero confidence as the explicit Data Feed convention and enforces freshness boundaries", () => {
  const token = "0x00000000000000000000000000000000000000f1";
  const feedId = "0x00000000000000000000000000000000000000f2";
  const book = new TrustedPriceBook([{
    token,
    source: "chainlink-data-feeds",
    feedId: feedId.toUpperCase().replace("0X", "0x"),
    maxAgeSeconds: 60,
    maxConfidenceBps: 0,
    feedDecimals: 8,
    feedDescription: "TEST / USD"
  }]);
  book.apply({
    token,
    source: "chainlink-data-feeds",
    feedId,
    priceUsdE18: 3n * USD_SCALE,
    confidenceUsdE18: 0n,
    observedAt: 100,
    sequence: 9n,
    verifiedBy: "canonical-data-feed"
  }, 100);

  assert.equal(book.get(token, 160).priceUsdE18, 3n * USD_SCALE);
  assert.equal(book.get(token, 161).reason, "stale");
});

test("rejects malformed Data Feed policies at startup", () => {
  const base = {
    token: "0x00000000000000000000000000000000000000f1",
    source: "chainlink-data-feeds" as const,
    feedId: "0x00000000000000000000000000000000000000f2",
    maxAgeSeconds: 60,
    maxConfidenceBps: 0,
    feedDecimals: 8,
    feedDescription: "TEST / USD"
  };
  assert.throws(() => new TrustedPriceBook([{ ...base, feedId: "not-an-address" }]), /Data Feed address/);
  assert.throws(() => new TrustedPriceBook([{ ...base, feedDecimals: undefined }]), /feedDecimals/);
  assert.throws(() => new TrustedPriceBook([{ ...base, feedDescription: "" }]), /feedDescription/);
  assert.throws(() => new TrustedPriceBook([{ ...base, maxConfidenceBps: 1 }]), /maxConfidenceBps 0/);
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
