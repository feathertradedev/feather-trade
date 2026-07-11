import { BPS_SCALE } from "./fixed.js";
import type { PricePolicy, PriceSample } from "./types.js";

export interface PriceResult {
  priceUsdE18: bigint | null;
  reason: "available" | "missing-policy" | "missing-sample" | "stale" | "invalid-confidence";
}

export class TrustedPriceBook {
  readonly #policies = new Map<string, PricePolicy>();
  readonly #samples = new Map<string, PriceSample[]>();

  constructor(policies: readonly PricePolicy[]) {
    for (const policy of policies) {
      const token = normalize(policy.token);
      if (this.#policies.has(token)) throw new Error(`Duplicate price policy for ${policy.token}`);
      if (!Number.isSafeInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds <= 0) {
        throw new Error(`Invalid maxAgeSeconds for ${policy.token}`);
      }
      if (!Number.isSafeInteger(policy.maxConfidenceBps) || policy.maxConfidenceBps < 0 || policy.maxConfidenceBps > 10_000) {
        throw new Error(`Invalid maxConfidenceBps for ${policy.token}`);
      }
      this.#policies.set(token, { ...policy, token });
    }
  }

  apply(sample: PriceSample, blockTimestamp: number): void {
    const token = normalize(sample.token);
    const policy = this.#policies.get(token);
    if (!policy) return;
    if (sample.source !== policy.source || sample.feedId !== policy.feedId) return;
    if (sample.source === "chainlink-data-streams" && sample.verifiedBy.trim() === "") return;
    if (sample.priceUsdE18 <= 0n || sample.confidenceUsdE18 < 0n || sample.observedAt > blockTimestamp + 30) return;

    const samples = this.#samples.get(token) ?? [];
    if (samples.some((current) => current.sequence === sample.sequence)) return;
    samples.push({ ...sample, token });
    samples.sort((a, b) => a.observedAt - b.observedAt || (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));
    this.#samples.set(token, samples);
  }

  get(tokenValue: string, atTimestamp: number): PriceResult {
    const token = normalize(tokenValue);
    const policy = this.#policies.get(token);
    if (!policy) return { priceUsdE18: null, reason: "missing-policy" };

    const sample = this.#sampleAt(token, atTimestamp);
    if (!sample) return { priceUsdE18: null, reason: "missing-sample" };
    if (sample.observedAt > atTimestamp || atTimestamp - sample.observedAt > policy.maxAgeSeconds) {
      return { priceUsdE18: null, reason: "stale" };
    }
    if (sample.confidenceUsdE18 * BPS_SCALE > sample.priceUsdE18 * BigInt(policy.maxConfidenceBps)) {
      return { priceUsdE18: null, reason: "invalid-confidence" };
    }

    return { priceUsdE18: sample.priceUsdE18, reason: "available" };
  }

  inspect(tokenValue: string, atTimestamp: number): PriceResult & { sample: PriceSample | null } {
    const token = normalize(tokenValue);
    const result = this.get(token, atTimestamp);
    return { ...result, sample: this.#sampleAt(token, atTimestamp) };
  }

  #sampleAt(token: string, atTimestamp: number): PriceSample | null {
    const samples = this.#samples.get(token) ?? [];
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      if (samples[index].observedAt <= atTimestamp) return samples[index];
    }
    return null;
  }
}

function normalize(value: string): string {
  return value.toLowerCase();
}
