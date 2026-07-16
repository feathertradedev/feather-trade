import { erc20Abi, lbPairAbi } from "@robinhood-lb/sdk/abi";
import {
  quoteCurrentFeeRates,
  type CurrentFeeRates,
  type StaticFeeParameters,
  type VariableFeeParameters
} from "@robinhood-lb/sdk/liquidity-review";
import type { DexRegistry } from "@robinhood-lb/sdk/registry";
import { findTokenMetadata } from "@robinhood-lb/sdk/tokens";
import { isAddressEqual, type Address, type Hex, type PublicClient } from "viem";

import type { PoolRow } from "./data";

export interface PinnedPoolEconomics {
  activeId: bigint;
  binStep: bigint;
  blockHash: Hex;
  blockNumber: bigint;
  blockTimestamp: bigint;
  decimalsX: number;
  decimalsY: number;
  factory: Address;
  feeRates: CurrentFeeRates;
  source: "rpc-at-indexer-block";
  tokenX: Address;
  tokenY: Address;
}

export interface PoolEconomicsAnchor {
  activeId: bigint;
  binStep: bigint;
  blockHash: Hex;
  blockNumber: bigint;
  factory: Address;
  tokenX: Address;
  tokenY: Address;
}

/**
 * Reads market identity and fee state from one canonical block. This function
 * is deliberately read-only and never calls a router or transaction builder.
 */
export async function loadPinnedPoolEconomics(
  publicClient: PublicClient,
  registry: DexRegistry,
  pool: PoolRow,
  anchor: PoolEconomicsAnchor
): Promise<PinnedPoolEconomics> {
  const chainId = await publicClient.getChainId();
  if (chainId !== registry.chainId) {
    throw new Error(`Pool economics RPC chain mismatch: expected ${registry.chainId}, received ${chainId}`);
  }
  const allowlistedTokenX = findTokenMetadata(registry.tokens, pool.tokenXAddress);
  const allowlistedTokenY = findTokenMetadata(registry.tokens, pool.tokenYAddress);
  if (allowlistedTokenX === null || allowlistedTokenY === null) {
    throw new Error("Pool economics tokens are not present in the environment allowlist");
  }

  if (anchor.blockNumber < 0n) throw new Error("Pool economics anchor block is invalid");
  const block = await publicClient.getBlock({ blockNumber: anchor.blockNumber });
  if (block.hash === null || block.hash.toLowerCase() !== anchor.blockHash.toLowerCase()) {
    throw new Error("Pool economics RPC block hash differs from the indexer snapshot");
  }
  const [factory, tokenX, tokenY, decimalsXRaw, decimalsYRaw, binStepRaw, activeIdRaw, staticFeesRaw, variableFeesRaw] = await Promise.all([
    publicClient.readContract({ address: pool.address, abi: lbPairAbi, functionName: "getFactory", blockNumber: block.number }),
    publicClient.readContract({ address: pool.address, abi: lbPairAbi, functionName: "getTokenX", blockNumber: block.number }),
    publicClient.readContract({ address: pool.address, abi: lbPairAbi, functionName: "getTokenY", blockNumber: block.number }),
    publicClient.readContract({ address: pool.tokenXAddress, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }),
    publicClient.readContract({ address: pool.tokenYAddress, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }),
    publicClient.readContract({ address: pool.address, abi: lbPairAbi, functionName: "getBinStep", blockNumber: block.number }),
    publicClient.readContract({ address: pool.address, abi: lbPairAbi, functionName: "getActiveId", blockNumber: block.number }),
    publicClient.readContract({ address: pool.address, abi: lbPairAbi, functionName: "getStaticFeeParameters", blockNumber: block.number }),
    publicClient.readContract({ address: pool.address, abi: lbPairAbi, functionName: "getVariableFeeParameters", blockNumber: block.number })
  ]);

  assertAddressIdentity(factory, registry.contracts.lbFactory, "registry factory");
  assertAddressIdentity(factory, pool.factoryAddress, "indexed factory");
  assertAddressIdentity(factory, anchor.factory, "indexer snapshot factory");
  assertAddressIdentity(tokenX, pool.tokenXAddress, "token X");
  assertAddressIdentity(tokenX, anchor.tokenX, "indexer snapshot token X");
  assertAddressIdentity(tokenY, pool.tokenYAddress, "token Y");
  assertAddressIdentity(tokenY, anchor.tokenY, "indexer snapshot token Y");
  const decimalsX = Number(decimalsXRaw);
  const decimalsY = Number(decimalsYRaw);
  assertTokenDecimals(decimalsX, allowlistedTokenX.decimals, pool.tokenX?.decimals ?? null, "token X");
  assertTokenDecimals(decimalsY, allowlistedTokenY.decimals, pool.tokenY?.decimals ?? null, "token Y");
  const binStep = BigInt(binStepRaw);
  if (binStep.toString() !== pool.binStep) {
    throw new Error(`Pinned pool bin step ${binStep} differs from indexed bin step ${pool.binStep}`);
  }
  if (binStep !== anchor.binStep) throw new Error("Pinned pool bin step differs from the indexer snapshot");
  const activeId = BigInt(activeIdRaw);
  if (activeId !== anchor.activeId) throw new Error("Pinned pool active ID differs from the indexer snapshot");
  const staticFees = staticFeeParameters(staticFeesRaw);
  const variableFees = variableFeeParameters(variableFeesRaw);
  const feeRates = quoteCurrentFeeRates({
    activeId,
    binStep,
    blockTimestamp: block.timestamp,
    staticFees,
    variableFees
  });

  const canonicalBlock = await publicClient.getBlock({ blockNumber: block.number });
  if (canonicalBlock.hash === null || canonicalBlock.hash.toLowerCase() !== block.hash.toLowerCase() ||
    canonicalBlock.timestamp !== block.timestamp) {
    throw new Error("Pinned pool economics block changed during RPC reads");
  }

  return {
    activeId,
    binStep,
    blockHash: block.hash,
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    decimalsX,
    decimalsY,
    factory,
    feeRates,
    source: "rpc-at-indexer-block",
    tokenX,
    tokenY
  };
}

function staticFeeParameters(value: readonly [number, number, number, number, number, number, number]): StaticFeeParameters {
  return {
    baseFactor: BigInt(value[0]),
    filterPeriod: BigInt(value[1]),
    decayPeriod: BigInt(value[2]),
    reductionFactor: BigInt(value[3]),
    variableFeeControl: BigInt(value[4]),
    protocolShare: BigInt(value[5]),
    maxVolatilityAccumulator: BigInt(value[6])
  };
}

function variableFeeParameters(value: readonly [number, number, number, number]): VariableFeeParameters {
  return {
    volatilityAccumulator: BigInt(value[0]),
    volatilityReference: BigInt(value[1]),
    idReference: BigInt(value[2]),
    timeOfLastUpdate: BigInt(value[3])
  };
}

function assertAddressIdentity(actual: Address, expected: Address, label: string): void {
  if (!isAddressEqual(actual, expected)) throw new Error(`Pinned pool ${label} does not match selected market identity`);
}

function assertTokenDecimals(actual: number, allowlisted: number, indexed: number | null, label: string): void {
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > 255) throw new Error(`Pinned pool ${label} decimals are invalid`);
  if (actual !== allowlisted || indexed !== null && actual !== indexed) {
    throw new Error(`Pinned pool ${label} decimals do not match allowlisted and indexed metadata`);
  }
}
