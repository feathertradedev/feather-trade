import type { Address, Chain } from "viem";

import type { EndpointConfig } from "./endpoints.js";
import type {
  LocalnetDeploymentManifest,
  RobinhoodDeploymentManifest,
  SepoliaDeploymentManifest,
  SupportedHook
} from "./manifest.js";
import { assertLegacyRoutingDisabled } from "./routing-policy.js";
import { localnetChain, robinhoodChain, robinhoodTestnetChain, sepoliaChain } from "./chains.js";
import {
  localnetTokenListFromManifest,
  robinhoodTokenListFromManifest,
  sepoliaTokenListFromManifest,
  type TokenMetadata
} from "./tokens.js";

export interface DexRegistry {
  environment: "localnet" | "robinhood" | "robinhoodTestnet" | "sepolia";
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
  supportedHooks: SupportedHook[];
  supportedPairImplementations: Address[];
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
    supportedHooks: manifest.supportedHooks ?? [],
    supportedPairImplementations: manifest.supportedPairImplementations ?? [manifest.contracts.lbPairImplementation],
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
    endpoints: manifest.endpoints,
    supportedHooks: manifest.supportedHooks ?? [],
    supportedPairImplementations: manifest.supportedPairImplementations ?? [manifest.contracts.lbPairImplementation]
  };
}

export function registryFromSepoliaManifest(manifest: SepoliaDeploymentManifest): DexRegistry {
  if (manifest.environment !== "sepolia" || manifest.chainId !== sepoliaChain.id) {
    throw new Error(`Expected the Ethereum Sepolia runtime manifest for chain ${sepoliaChain.id}`);
  }
  if (manifest.endpoints.rpcUrl.trim().length === 0) {
    throw new Error("Sepolia runtime manifest requires endpoints.rpcUrl");
  }
  assertLegacyRoutingDisabled(manifest.constructorArgs);

  const rpcUrl = manifest.endpoints.rpcUrl;
  const runtimeChain = {
    ...sepoliaChain,
    rpcUrls: {
      default: { http: [rpcUrl] },
      public: { http: [rpcUrl] }
    }
  } as const satisfies Chain;

  return {
    environment: "sepolia",
    chain: runtimeChain,
    chainId: manifest.chainId,
    startBlock: manifest.startBlock,
    contracts: manifest.contracts,
    tokens: sepoliaTokenListFromManifest(manifest),
    endpoints: manifest.endpoints,
    supportedHooks: [],
    supportedPairImplementations: [manifest.contracts.lbPairImplementation]
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
