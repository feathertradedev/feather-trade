import type { Address, Chain } from "viem";

import type { EndpointConfig } from "./endpoints.js";
import type { LocalnetDeploymentManifest, RobinhoodDeploymentManifest } from "./manifest.js";
import { assertLegacyRoutingDisabled } from "./routing-policy.js";
import { localnetChain, robinhoodChain, robinhoodTestnetChain } from "./chains.js";
import { localnetTokenListFromManifest, robinhoodTokenListFromManifest, type TokenMetadata } from "./tokens.js";

export interface DexRegistry {
  environment: "localnet" | "robinhood" | "robinhoodTestnet";
  chain: Chain;
  chainId: number;
  startBlock: number;
  contracts: {
    lbFactory: Address;
    lbPairImplementation: Address;
    lbRouter: Address;
    lbQuoter: Address;
  };
  tokens: Record<string, TokenMetadata>;
  endpoints: EndpointConfig;
}

export interface LocalnetDexRegistry extends DexRegistry {
  environment: "localnet";
  seededPools: LocalnetDeploymentManifest["seededPools"];
}

export function registryFromLocalnetManifest(manifest: LocalnetDeploymentManifest): LocalnetDexRegistry {
  return {
    environment: "localnet",
    chain: localnetChain,
    chainId: manifest.chainId,
    startBlock: manifest.startBlock,
    contracts: manifest.contracts,
    tokens: localnetTokenListFromManifest(manifest),
    endpoints: manifest.endpoints,
    seededPools: manifest.seededPools
  };
}

export function registryFromRobinhoodManifest(manifest: RobinhoodDeploymentManifest): DexRegistry {
  assertLegacyRoutingDisabled(manifest.constructorArgs);

  const environment = manifest.environment === "mainnet" ? "robinhood" : "robinhoodTestnet";
  const chain = manifest.environment === "mainnet" ? robinhoodChain : robinhoodTestnetChain;

  return {
    environment,
    chain,
    chainId: manifest.chainId,
    startBlock: manifest.startBlock,
    contracts: manifest.contracts,
    tokens: robinhoodTokenListFromManifest(manifest),
    endpoints: manifest.endpoints
  };
}

export function getContracts(registry: DexRegistry): DexRegistry["contracts"] {
  return registry.contracts;
}

export function getTokens(registry: DexRegistry): DexRegistry["tokens"] {
  return registry.tokens;
}

export function getSeededPool(
  registry: LocalnetDexRegistry,
  pool: keyof LocalnetDexRegistry["seededPools"]
): LocalnetDexRegistry["seededPools"][typeof pool] {
  return registry.seededPools[pool];
}
