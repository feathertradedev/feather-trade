import type { EnvironmentKey } from "./config";

export interface FullExitBatchPolicy {
  maxBlockGasBps: bigint;
  maxCalldataBytes: number;
  maxCandidateBins: number;
  maxProbeCount: number;
}

const POLICIES: Record<EnvironmentKey, FullExitBatchPolicy> = {
  localnet: {
    maxBlockGasBps: 5_000n,
    maxCalldataBytes: 24_000,
    maxCandidateBins: 48,
    maxProbeCount: 128
  },
  sepolia: {
    maxBlockGasBps: 4_000n,
    maxCalldataBytes: 20_000,
    maxCandidateBins: 32,
    maxProbeCount: 128
  },
  robinhoodTestnet: {
    maxBlockGasBps: 4_000n,
    maxCalldataBytes: 20_000,
    maxCandidateBins: 32,
    maxProbeCount: 128
  },
  robinhood: {
    maxBlockGasBps: 3_000n,
    maxCalldataBytes: 16_000,
    maxCandidateBins: 24,
    maxProbeCount: 96
  }
};

export function fullExitBatchPolicy(environment: EnvironmentKey): FullExitBatchPolicy {
  const policy = POLICIES[environment];
  if (!policy) throw new Error(`Full-exit batching is not configured for environment ${String(environment)}`);
  return { ...policy };
}
