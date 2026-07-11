import { getAddress, isAddressEqual, type Address } from "viem";

import localnetTokenListJson from "./token-lists/localnet.json" with { type: "json" };
import robinhoodTokenListJson from "./token-lists/robinhood.json" with { type: "json" };
import robinhoodTestnetTokenListJson from "./token-lists/robinhood-testnet.json" with { type: "json" };
import type { LocalnetDeploymentManifest, RobinhoodDeploymentManifest } from "./manifest.js";

export type TokenListEnvironment = "localnet" | "robinhood" | "robinhoodTestnet";

export type TokenTag =
  | "canonical"
  | "localnet"
  | "mainnet"
  | "mock"
  | "quote"
  | "stablecoin"
  | "testnet"
  | "wrapped-native";

export type TokenAddressRef = "tokens.wnative" | "tokens.usdc" | "tokens.usdt" | "tokens.weth" | "tokens.wrappedNative";
export type TokenRiskFlag = "fee-on-transfer" | "rebasing" | "blacklistable" | "upgradeable" | "suspicious";
export type TokenAction = "swap" | "add-liquidity" | "remove-liquidity";
export type TokenReviewStatus = "standard" | "restricted" | "blocked";

export interface TokenRiskPolicy {
  disabledActions: readonly TokenAction[];
  flags: readonly TokenRiskFlag[];
  notes?: string;
  reviewStatus: TokenReviewStatus;
}

export interface TokenListEntry {
  address?: Address;
  addressRef?: TokenAddressRef;
  decimals: number;
  id: string;
  logoURI: string;
  name: string;
  risk?: TokenRiskPolicy;
  symbol: string;
  tags: readonly TokenTag[];
}

export interface TokenListDefinition {
  chainId: number;
  environment: TokenListEnvironment;
  name: string;
  schemaVersion: "lb.token-list.v1";
  tokens: readonly TokenListEntry[];
  updatedAt: string;
}

export interface TokenMetadata {
  address: Address;
  chainId: number;
  decimals: number;
  id: string;
  logoURI: string;
  name: string;
  risk: TokenRiskPolicy;
  symbol: string;
  tags: readonly TokenTag[];
}

export type TokenMetadataMap = Record<string, TokenMetadata>;

export interface TokenListMapOptions {
  chainId?: number;
  key?: "address" | "symbol";
  resolveAddressRef?: (addressRef: TokenAddressRef) => Address;
}

export const localnetTokenListDefinition = localnetTokenListJson as unknown as TokenListDefinition;
export const robinhoodTokenListDefinition = robinhoodTokenListJson as unknown as TokenListDefinition;
export const robinhoodTestnetTokenListDefinition = robinhoodTestnetTokenListJson as unknown as TokenListDefinition;

export const defaultTokenRiskPolicy: TokenRiskPolicy = {
  disabledActions: [],
  flags: [],
  reviewStatus: "standard"
};

export const robinhoodTokenList = tokenListToMetadataMap(robinhoodTokenListDefinition);
export const robinhoodTestnetTokenList = tokenListToMetadataMap(robinhoodTestnetTokenListDefinition);

export function localnetTokenListFromManifest(manifest: LocalnetDeploymentManifest): TokenMetadataMap {
  return tokenListToMetadataMap(localnetTokenListDefinition, {
    chainId: manifest.chainId,
    resolveAddressRef: (addressRef) => resolveLocalnetAddressRef(addressRef, manifest)
  });
}

export function robinhoodTokenListFromManifest(manifest: RobinhoodDeploymentManifest): TokenMetadataMap {
  const definition = manifest.environment === "mainnet" ? robinhoodTokenListDefinition : robinhoodTestnetTokenListDefinition;
  const tokens = definition.tokens.map((entry) =>
    isWrappedNativeEntry(entry) ? { ...entry, address: manifest.tokens.wrappedNative } : entry
  );

  return tokenListToMetadataMap({ ...definition, chainId: manifest.chainId, tokens });
}

export function tokenListToMetadataMap(tokenList: TokenListDefinition, options: TokenListMapOptions = {}): TokenMetadataMap {
  const keyType = options.key ?? "symbol";
  const chainId = options.chainId ?? tokenList.chainId;
  const tokens = tokenList.tokens.map((entry) => tokenEntryToMetadata(entry, chainId, options.resolveAddressRef));

  return Object.fromEntries(
    tokens.map((token) => [keyType === "address" ? token.address.toLowerCase() : token.symbol.toUpperCase(), token])
  );
}

export function findTokenMetadata(tokens: TokenMetadataMap, address: Address | string): TokenMetadata | null {
  return Object.values(tokens).find((token) => sameTokenAddress(token.address, address)) ?? null;
}

export function tokenAllowsAction(token: TokenMetadata, action: TokenAction): boolean {
  return token.risk.reviewStatus !== "blocked" && !token.risk.disabledActions.includes(action);
}

export function tokenHasRiskFlag(token: TokenMetadata, flag: TokenRiskFlag): boolean {
  return token.risk.flags.includes(flag);
}

export function tokenDisablesLiquidity(token: TokenMetadata): boolean {
  return !tokenAllowsAction(token, "add-liquidity") || !tokenAllowsAction(token, "remove-liquidity");
}

function tokenEntryToMetadata(
  entry: TokenListEntry,
  chainId: number,
  resolveAddressRef?: (addressRef: TokenAddressRef) => Address
): TokenMetadata {
  return {
    address: resolveTokenAddress(entry, resolveAddressRef),
    chainId,
    decimals: entry.decimals,
    id: entry.id,
    logoURI: entry.logoURI,
    name: entry.name,
    risk: normalizeTokenRiskPolicy(entry.risk),
    symbol: entry.symbol,
    tags: entry.tags
  };
}

function normalizeTokenRiskPolicy(risk?: TokenRiskPolicy): TokenRiskPolicy {
  if (risk === undefined) {
    return {
      disabledActions: [...defaultTokenRiskPolicy.disabledActions],
      flags: [...defaultTokenRiskPolicy.flags],
      reviewStatus: defaultTokenRiskPolicy.reviewStatus
    };
  }

  const normalized: TokenRiskPolicy = {
    disabledActions: [...risk.disabledActions],
    flags: [...risk.flags],
    reviewStatus: risk.reviewStatus
  };

  if (risk.notes !== undefined) {
    normalized.notes = risk.notes;
  }

  return normalized;
}

function resolveTokenAddress(entry: TokenListEntry, resolveAddressRef?: (addressRef: TokenAddressRef) => Address): Address {
  if (entry.address !== undefined) {
    return getAddress(entry.address);
  }

  if (entry.addressRef !== undefined && resolveAddressRef !== undefined) {
    return resolveAddressRef(entry.addressRef);
  }

  throw new Error(`Token ${entry.id} is missing a resolvable address`);
}

function resolveLocalnetAddressRef(addressRef: TokenAddressRef, manifest: LocalnetDeploymentManifest): Address {
  if (addressRef === "tokens.wnative") {
    return manifest.tokens.wnative;
  }

  if (addressRef === "tokens.usdc") {
    return manifest.tokens.usdc;
  }

  if (addressRef === "tokens.usdt") {
    return manifest.tokens.usdt;
  }

  if (addressRef === "tokens.weth") {
    return manifest.tokens.weth;
  }

  throw new Error(`Unsupported localnet token addressRef ${addressRef}`);
}

function isWrappedNativeEntry(entry: TokenListEntry): boolean {
  return entry.addressRef === "tokens.wrappedNative" || entry.tags.includes("wrapped-native");
}

function sameTokenAddress(left: Address | string, right: Address | string): boolean {
  try {
    return isAddressEqual(left as Address, right as Address);
  } catch {
    return left.toLowerCase() === right.toLowerCase();
  }
}
