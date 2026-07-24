import { BPS_SCALE } from "./fixed.js";
import type { PricePolicy, PriceSample } from "./types.js";

export interface PriceResult {
  priceUsdE18: bigint | null;
  reason: "available" | "missing-policy" | "missing-sample" | "stale" | "invalid-confidence";
}

export class TrustedPriceBook {
  readonly #policies = new Map<string, PricePolicy>();
  readonly #samples = new Map<string, PriceSample[]>();
  readonly #sampleSequences = new Map<string, Set<bigint>>();

  constructor(policies: readonly PricePolicy[]) {
    for (const policy of policies) {
      if (policy === null || typeof policy !== "object") throw new Error("Price policy must be an object");
      if (!["chainlink-data-feeds", "chainlink-data-streams", "fixed-test"].includes(policy.source)) {
        throw new Error(`Invalid price source for ${String(policy.token)}`);
      }
      if (typeof policy.token !== "string" || policy.token.trim() === "") throw new Error("Price policy token is required");
      if (typeof policy.feedId !== "string" || policy.feedId.trim() === "") {
        throw new Error(`Price policy feedId is required for ${policy.token}`);
      }
      const token = normalize(policy.token);
      if (this.#policies.has(token)) throw new Error(`Duplicate price policy for ${policy.token}`);
      if (!Number.isSafeInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds <= 0) {
        throw new Error(`Invalid maxAgeSeconds for ${policy.token}`);
      }
      if (!Number.isSafeInteger(policy.maxConfidenceBps) || policy.maxConfidenceBps < 0 || policy.maxConfidenceBps > 10_000) {
        throw new Error(`Invalid maxConfidenceBps for ${policy.token}`);
      }
      if (policy.source === "chainlink-data-feeds") {
        if (!/^0x[0-9a-fA-F]{40}$/.test(policy.feedId)) {
          throw new Error(`Invalid Chainlink Data Feed address for ${policy.token}`);
        }
        if (!Number.isSafeInteger(policy.feedDecimals) || policy.feedDecimals! < 0 || policy.feedDecimals! > 36) {
          throw new Error(`Invalid feedDecimals for ${policy.token}`);
        }
        if (typeof policy.feedDescription !== "string" || policy.feedDescription.trim() === "") {
          throw new Error(`Invalid feedDescription for ${policy.token}`);
        }
        if (policy.maxConfidenceBps !== 0) {
          throw new Error(`Chainlink Data Feeds policy for ${policy.token} must use maxConfidenceBps 0`);
        }
      }
      const feedId = policy.source === "chainlink-data-feeds" ? policy.feedId.toLowerCase() : policy.feedId;
      this.#policies.set(token, { ...policy, token, feedId });
    }
  }

  apply(sample: PriceSample, blockTimestamp: number): void {
    const token = normalize(sample.token);
    const policy = this.#policies.get(token);
    if (!policy) return;
    const feedId = sample.source === "chainlink-data-feeds" ? sample.feedId.toLowerCase() : sample.feedId;
    if (sample.source !== policy.source || feedId !== policy.feedId) return;
    if (sample.source !== "fixed-test" && sample.verifiedBy.trim() === "") return;
    if (sample.priceUsdE18 <= 0n || sample.confidenceUsdE18 < 0n || sample.observedAt > blockTimestamp + 30) return;

    const samples = this.#samples.get(token) ?? [];
    const sequences = this.#sampleSequences.get(token) ?? new Set<bigint>();
    if (sequences.has(sample.sequence)) return;
    const normalized = { ...sample, token, feedId };
    const insertionIndex = upperBoundSample(samples, normalized);
    samples.splice(insertionIndex, 0, normalized);
    sequences.add(sample.sequence);
    this.#samples.set(token, samples);
    this.#sampleSequences.set(token, sequences);
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
    let low = 0;
    let high = samples.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (samples[middle]!.observedAt <= atTimestamp) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? null : samples[low - 1]!;
  }
}

function upperBoundSample(samples: readonly PriceSample[], sample: PriceSample): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const current = samples[middle]!;
    const orderedBeforeOrEqual = current.observedAt < sample.observedAt ||
      (current.observedAt === sample.observedAt && current.sequence <= sample.sequence);
    if (orderedBeforeOrEqual) low = middle + 1;
    else high = middle;
  }
  return low;
}

function normalize(value: string): string {
  return value.toLowerCase();
}
