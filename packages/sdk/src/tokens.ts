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
export type TokenApprovalBehavior = "standard-bool" | "returns-false" | "no-return" | "zero-reset-required";

export interface TokenRiskPolicy {
  disabledActions: readonly TokenAction[];
  flags: readonly TokenRiskFlag[];
  notes?: string;
  reviewStatus: TokenReviewStatus;
}

export interface TokenListEntry {
  approvalBehavior: TokenApprovalBehavior;
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
  approvalBehavior: TokenApprovalBehavior;
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
  const chainId = options.chainId ?? tokenList.chainId;
  const tokens = tokenList.tokens.map((entry) => tokenEntryToMetadata(entry, chainId, options.resolveAddressRef));

  const addresses = new Set<string>();
  const ids = new Set<string>();
  for (const token of tokens) {
    const address = token.address.toLowerCase();
    if (addresses.has(address)) throw new Error(`Duplicate token address ${token.address}`);
    if (ids.has(token.id)) throw new Error(`Duplicate token id ${token.id}`);
    addresses.add(address);
    ids.add(token.id);
  }

  return Object.fromEntries(tokens.map((token) => [token.address.toLowerCase(), token]));
}

export function findTokenMetadata(tokens: TokenMetadataMap, address: Address | string): TokenMetadata | null {
  return Object.values(tokens).find((token) => sameTokenAddress(token.address, address)) ?? null;
}

export function findTokenBySymbol(tokens: TokenMetadataMap, symbol: string): TokenMetadata | null {
  const matches = Object.values(tokens).filter((token) => token.symbol.toLowerCase() === symbol.trim().toLowerCase());
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function tokenAllowsAction(token: TokenMetadata, action: TokenAction): boolean {
  return tokenActionBlocker(token, action) === null;
}

export function tokenActionBlocker(token: TokenMetadata, action: TokenAction): string | null {
  if (token.risk.reviewStatus === "blocked") {
    return `${token.symbol} at ${token.address} is blocked by the Feather token policy${token.risk.notes ? `: ${token.risk.notes}` : ""}`;
  }
  if (token.risk.disabledActions.includes(action)) {
    return `${token.symbol} at ${token.address} is disabled for ${action}${token.risk.notes ? `: ${token.risk.notes}` : ""}`;
  }
  if (action !== "remove-liquidity" && !tokenSupportsExecutableApproval(token)) {
    return `${token.symbol} at ${token.address} uses unsupported approval behavior ${token.approvalBehavior}`;
  }
  return null;
}

export function assertTokenActionAllowed(
  tokens: TokenMetadataMap,
  addresses: readonly (Address | string)[],
  action: TokenAction
): void {
  for (const address of addresses) {
    const token = findTokenMetadata(tokens, address);
    if (token === null) throw new Error(`Token ${address} is not in the configured Feather token allowlist`);
    const blocker = tokenActionBlocker(token, action);
    if (blocker !== null) throw new Error(blocker);
  }
}

export function tokenSupportsExecutableApproval(token: Pick<TokenMetadata, "approvalBehavior">): boolean {
  return token.approvalBehavior === "standard-bool";
}

export function tokenApprovalCapabilityLabel(token: Pick<TokenMetadata, "approvalBehavior">): string {
  switch (token.approvalBehavior) {
    case "standard-bool":
      return "Standard ERC-20 approval";
    case "returns-false":
      return "Excluded: approval may return false";
    case "no-return":
      return "Excluded: approval has no return value";
    case "zero-reset-required":
      return "Excluded: approval requires a zero reset";
  }
}

export function searchTokenMetadata(tokens: TokenMetadataMap, query: string): TokenMetadata[] {
  const normalized = query.trim().toLowerCase();
  return Object.values(tokens)
    .filter((token) =>
      normalized.length === 0 ||
      [token.name, token.symbol, token.address].some((value) => value.toLowerCase().includes(normalized))
    )
    .sort((left, right) =>
      left.symbol.localeCompare(right.symbol) ||
      left.name.localeCompare(right.name) ||
      left.address.toLowerCase().localeCompare(right.address.toLowerCase())
    );
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
  if (!isTokenApprovalBehavior(entry.approvalBehavior)) {
    throw new Error(`Token ${entry.id} is missing a valid explicit approval behavior`);
  }
  if (!Number.isSafeInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 255) {
    throw new Error(`Token ${entry.id} decimals must be an integer from 0 to 255`);
  }
  return {
    address: resolveTokenAddress(entry, resolveAddressRef),
    approvalBehavior: entry.approvalBehavior,
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

function isTokenApprovalBehavior(value: unknown): value is TokenApprovalBehavior {
  return value === "standard-bool" || value === "returns-false" || value === "no-return" || value === "zero-reset-required";
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
