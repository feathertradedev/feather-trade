import assert from "node:assert/strict";
import test from "node:test";

import { createPriceVerifier } from "./chainlink-verifier.testnet-unpriced.mjs";

test("the temporary testnet verifier rejects every price submission", { concurrency: false }, async () => {
  const previous = process.env.ANALYTICS_ENVIRONMENT;
  process.env.ANALYTICS_ENVIRONMENT = "testnet";
  try {
    const verifier = createPriceVerifier();
    await assert.rejects(
      verifier.verify({}),
      /Trusted Chainlink pricing is not configured/
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test("the temporary testnet verifier cannot run outside testnet", { concurrency: false }, () => {
  const previous = process.env.ANALYTICS_ENVIRONMENT;
  process.env.ANALYTICS_ENVIRONMENT = "mainnet";
  try {
    assert.throws(
      () => createPriceVerifier(),
      /restricted to ANALYTICS_ENVIRONMENT=testnet/
    );
  } finally {
    restoreEnvironment(previous);
  }
});

function restoreEnvironment(previous) {
  if (previous === undefined) delete process.env.ANALYTICS_ENVIRONMENT;
  else process.env.ANALYTICS_ENVIRONMENT = previous;
}
