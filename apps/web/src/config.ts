import {
  registryFromLocalnetManifest,
  registryFromRobinhoodManifest,
  type DexRegistry,
  type LocalnetDexRegistry
} from "@robinhood-lb/sdk/registry";

import {
  localnetDefaultManifest,
  robinhoodDefaultManifest,
  robinhoodTestnetDefaultManifest
} from "./default-manifests";

export type EnvironmentKey = "localnet" | "robinhoodTestnet" | "robinhood";
export type RouteKey = "home" | "swap" | "pools" | "liquidity" | "positions" | "activity";

export interface BrandLink {
  href: string;
  label: "Docs" | "Security" | "X" | "Discord";
}

declare const __LOCALNET_MANIFEST__: typeof localnetDefaultManifest | undefined;
declare const __ROBINHOOD_TESTNET_MANIFEST__: typeof robinhoodTestnetDefaultManifest | undefined;
declare const __ROBINHOOD_MANIFEST__: typeof robinhoodDefaultManifest | undefined;
declare const __PUBLIC_RELEASE_ENV__: "robinhoodTestnet" | "robinhood" | undefined;

export const publicReleaseEnvironment = __PUBLIC_RELEASE_ENV__;
export const defaultEnvironmentKey: EnvironmentKey = publicReleaseEnvironment ?? "localnet";
const analyticsEndpoints: Record<EnvironmentKey, string | null> = {
  localnet: normalizeOptionalUrl(import.meta.env.VITE_ANALYTICS_LOCALNET_URL ?? import.meta.env.VITE_ANALYTICS_URL),
  robinhoodTestnet: normalizeOptionalUrl(import.meta.env.VITE_ANALYTICS_ROBINHOOD_TESTNET_URL),
  robinhood: normalizeOptionalUrl(import.meta.env.VITE_ANALYTICS_ROBINHOOD_URL)
};

export function analyticsEndpointForRegistry(registry: DexRegistry): string | null {
  const environmentKey = registry.environment === "localnet"
    ? "localnet"
    : registry.chain.id === 46_630
      ? "robinhoodTestnet"
      : "robinhood";
  return analyticsEndpoints[environmentKey];
}

export const registries = createRegistries();

export const environmentOptions = createEnvironmentOptions();

export const routes: Array<{
  key: RouteKey;
  label: string;
}> = [
  { key: "swap", label: "Swap" },
  { key: "pools", label: "Pools" },
  { key: "liquidity", label: "Liquidity" },
  { key: "positions", label: "Portfolio" },
  { key: "activity", label: "Activity" }
];

export const brandLinks: BrandLink[] = [
  ...optionalBrandLink("Docs", import.meta.env.VITE_FEATHER_DOCS_URL),
  ...optionalBrandLink("Security", import.meta.env.VITE_FEATHER_SECURITY_URL),
  ...optionalBrandLink("X", import.meta.env.VITE_FEATHER_X_URL),
  ...optionalBrandLink("Discord", import.meta.env.VITE_FEATHER_DISCORD_URL)
];

export function isLocalnetRegistry(registry: DexRegistry): registry is LocalnetDexRegistry {
  return registry.environment === "localnet";
}

function createEnvironmentOptions(): Array<{
  key: EnvironmentKey;
  label: string;
  tone: "ready" | "dry";
}> {
  if (publicReleaseEnvironment === "robinhoodTestnet") {
    return [{ key: "robinhoodTestnet", label: "Robinhood Testnet", tone: publicTone(registries.robinhoodTestnet) }];
  }

  if (publicReleaseEnvironment === "robinhood") {
    return [{ key: "robinhood", label: "Robinhood Mainnet", tone: publicTone(registries.robinhood) }];
  }

  return [
    { key: "localnet", label: "Localnet", tone: "ready" },
    { key: "robinhoodTestnet", label: "Robinhood Testnet", tone: publicTone(registries.robinhoodTestnet) },
    { key: "robinhood", label: "Robinhood Mainnet", tone: publicTone(registries.robinhood) }
  ];
}

function publicTone(registry: DexRegistry): "ready" | "dry" {
  return registry.endpoints.indexerUrl === null ? "dry" : "ready";
}

function createRegistries(): Record<EnvironmentKey, DexRegistry> {
  if (publicReleaseEnvironment === "robinhoodTestnet") {
    const registry = registryFromRobinhoodManifest(__ROBINHOOD_TESTNET_MANIFEST__ ?? robinhoodTestnetDefaultManifest);
    return publicOnlyRegistries(registry);
  }

  if (publicReleaseEnvironment === "robinhood") {
    const registry = registryFromRobinhoodManifest(__ROBINHOOD_MANIFEST__ ?? robinhoodDefaultManifest);
    return publicOnlyRegistries(registry);
  }

  const robinhoodTestnetRegistry = registryFromRobinhoodManifest(
    __ROBINHOOD_TESTNET_MANIFEST__ ?? robinhoodTestnetDefaultManifest
  );
  const robinhoodRegistry = registryFromRobinhoodManifest(__ROBINHOOD_MANIFEST__ ?? robinhoodDefaultManifest);

  return {
    localnet: registryFromLocalnetManifest(__LOCALNET_MANIFEST__ ?? localnetDefaultManifest),
    robinhoodTestnet: robinhoodTestnetRegistry,
    robinhood: robinhoodRegistry
  };
}

function publicOnlyRegistries(registry: DexRegistry): Record<EnvironmentKey, DexRegistry> {
  return {
    localnet: registry,
    robinhoodTestnet: registry,
    robinhood: registry
  };
}

function normalizeOptionalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.replace(/\/$/, "");
}

function optionalBrandLink(label: BrandLink["label"], value: unknown): BrandLink[] {
  const href = normalizeOptionalUrl(value);
  if (href === null) return [];

  try {
    const url = new URL(href);
    return url.protocol === "https:" ? [{ href: url.toString(), label }] : [];
  } catch {
    return [];
  }
}
