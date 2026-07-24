/**
 * Temporary Sepolia verifier used while trusted Chainlink pricing is absent.
 *
 * This adapter deliberately verifies nothing. The matching testnet price policy
 * file is empty and the canonical block source must submit no prices. If a
 * price submission appears unexpectedly, fail closed instead of accepting an
 * untrusted or fabricated USD value.
 */

export function createPriceVerifier() {
  if (process.env.ANALYTICS_ENVIRONMENT !== "testnet") {
    throw new Error("The unpriced verifier is restricted to ANALYTICS_ENVIRONMENT=testnet");
  }

  return Object.freeze({
    async verify() {
      throw new Error("Trusted Chainlink pricing is not configured for this testnet release");
    }
  });
}
