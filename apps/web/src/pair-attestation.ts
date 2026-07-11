import { lbFactoryAbi, lbHooksAbi, lbPairAbi, lbQuoterAbi, lbRouterAbi } from "@robinhood-lb/sdk/abi";
import type { DexRegistry } from "@robinhood-lb/sdk/registry";
import {
  getAddress,
  isAddressEqual,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient
} from "viem";

import type { PoolRow } from "./data";

const HOOK_ADDRESS_MASK = (1n << 160n) - 1n;
const KNOWN_HOOK_FLAGS_MASK = ((1n << 10n) - 1n) << 160n;
const CANONICAL_HOOK_MASK = HOOK_ADDRESS_MASK | KNOWN_HOOK_FLAGS_MASK;
const ZERO_HOOKS = `0x${"0".repeat(64)}` as Hex;
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
export const MAX_ATTESTED_ROUTE_HOPS = 2;

export const HOOK_FLAG_NAMES = [
  "before swap",
  "after swap",
  "before flash loan",
  "after flash loan",
  "before mint",
  "after mint",
  "before burn",
  "after burn",
  "before batch transfer",
  "after batch transfer"
] as const;

export interface PairClaim {
  binStep: number;
  hooksParameters: Hex | null;
  indexerFactory: Address;
  indexerIgnoredForRouting: boolean;
  pair: Address;
  tokenX: Address;
  tokenY: Address;
  operation: "add-liquidity" | "remove-liquidity" | "swap";
}

export interface PairEvidence extends PairClaim {
  chainId: number;
  factory: Address;
  factoryLookupBinStep: number;
  factoryLookupIgnored: boolean;
  factoryLookupPair: Address;
  factoryHasCode: boolean;
  hookCode: Hex | undefined;
  hookLinked: boolean | undefined;
  hookPair: Address | undefined;
  hookImplementation: Address | undefined;
  hookImplementationCode: Hex | undefined;
  pairHasCode: boolean;
  pairImplementation: Address;
  pairImplementationHasCode: boolean;
  quoterFactory: Address | undefined;
  quoterHasCode: boolean;
  quoterRouter: Address | undefined;
  routerHasCode: boolean;
  routerFactory: Address;
}

export interface DecodedHooks {
  address: Address;
  enabledFlags: string[];
  flags: number;
  parameters: Hex;
  reservedBits: bigint;
}

export interface PairAttestation {
  behavior: string;
  hookAddress: Address | null;
  hookFlags: string[];
  hookIdentity: string;
  hookRisk: "none" | "low" | "medium" | "high";
  pair: Address;
}

export class PairAttestationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PairAttestationError";
    this.code = code;
  }
}

export interface CreatePairEvidence {
  activeId: number;
  binStep: number;
  chainId: number;
  existingPair: Address;
  factoryHasCode: boolean;
  implementation: Address;
  implementationHasCode: boolean;
  presetOpen: boolean;
  routerFactory: Address;
  routerHasCode: boolean;
  tokenX: Address;
  tokenY: Address;
  tokenYIsQuoteAsset: boolean;
}

export interface CreatePairAttestation {
  activeId: number;
  binStep: number;
  status: "ready-to-create";
  tokenX: Address;
  tokenY: Address;
}

export function evaluateFactoryForCreate(registry: DexRegistry, evidence: CreatePairEvidence): CreatePairAttestation {
  if (evidence.chainId !== registry.chainId) throw new PairAttestationError("chain-mismatch", "RPC chain differs from the deployment manifest");
  if (!evidence.factoryHasCode || !evidence.routerHasCode) throw new PairAttestationError("deployment-code-missing", "Configured factory or router has no code");
  if (!isAddressEqual(evidence.routerFactory, registry.contracts.lbFactory)) throw new PairAttestationError("router-factory-mismatch", "Configured router points to a different factory");
  if (!isAddressEqual(evidence.implementation, registry.contracts.lbPairImplementation) || !evidence.implementationHasCode) {
    throw new PairAttestationError("implementation-mismatch", "Factory pair implementation is not the reviewed deployment implementation");
  }
  if (evidence.tokenX === zeroAddress || evidence.tokenY === zeroAddress || isAddressEqual(evidence.tokenX, evidence.tokenY)) {
    throw new PairAttestationError("invalid-token-pair", "Pool tokens must be distinct nonzero addresses");
  }
  if (!evidence.tokenYIsQuoteAsset) throw new PairAttestationError("unsupported-quote-asset", "Token Y is not an allowlisted factory quote asset");
  if (!Number.isInteger(evidence.binStep) || evidence.binStep < 1 || evidence.binStep > 65_535 || !evidence.presetOpen) {
    throw new PairAttestationError("preset-closed", "Requested bin-step preset is unavailable or closed to router creation");
  }
  if (!Number.isInteger(evidence.activeId) || evidence.activeId < 0 || evidence.activeId > 16_777_215) {
    throw new PairAttestationError("invalid-active-id", "Initial active bin must fit uint24");
  }
  if (evidence.existingPair !== zeroAddress) throw new PairAttestationError("pair-exists", "Factory already resolves this token pair and bin step; open the canonical pair instead");
  return { activeId: evidence.activeId, binStep: evidence.binStep, status: "ready-to-create", tokenX: evidence.tokenX, tokenY: evidence.tokenY };
}

export async function attestFactoryForCreate(
  publicClient: PublicClient,
  registry: DexRegistry,
  input: { activeId: number; binStep: number; tokenX: Address; tokenY: Address }
): Promise<CreatePairAttestation> {
  try {
    const chainId = await publicClient.getChainId();
    const blockNumber = await publicClient.getBlockNumber();
    const [factoryCode, routerCode, routerFactory, implementation, lookup, preset, tokenYIsQuoteAsset] = await Promise.all([
      publicClient.getBytecode({ address: registry.contracts.lbFactory, blockNumber }),
      publicClient.getBytecode({ address: registry.contracts.lbRouter, blockNumber }),
      publicClient.readContract({ address: registry.contracts.lbRouter, abi: lbRouterAbi, functionName: "getFactory", blockNumber }),
      publicClient.readContract({ address: registry.contracts.lbFactory, abi: lbFactoryAbi, functionName: "getLBPairImplementation", blockNumber }),
      publicClient.readContract({ address: registry.contracts.lbFactory, abi: lbFactoryAbi, functionName: "getLBPairInformation", args: [input.tokenX, input.tokenY, BigInt(input.binStep)], blockNumber }),
      publicClient.readContract({ address: registry.contracts.lbFactory, abi: lbFactoryAbi, functionName: "getPreset", args: [BigInt(input.binStep)], blockNumber }),
      publicClient.readContract({ address: registry.contracts.lbFactory, abi: lbFactoryAbi, functionName: "isQuoteAsset", args: [input.tokenY], blockNumber })
    ]);
    const implementationCode = await publicClient.getBytecode({ address: implementation, blockNumber });
    const info = lookup as { LBPair: Address };
    const presetValues = preset as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean];
    return evaluateFactoryForCreate(registry, {
      ...input,
      chainId,
      existingPair: info.LBPair,
      factoryHasCode: factoryCode !== undefined && factoryCode !== "0x",
      implementation,
      implementationHasCode: implementationCode !== undefined && implementationCode !== "0x",
      presetOpen: presetValues[7],
      routerFactory,
      routerHasCode: routerCode !== undefined && routerCode !== "0x",
      tokenYIsQuoteAsset
    });
  } catch (error) {
    if (error instanceof PairAttestationError) throw error;
    throw new PairAttestationError("rpc-unavailable", "Create-pair attestation is unavailable; no simulation or wallet request was sent");
  }
}

export function poolRowToPairClaim(
  pool: PoolRow,
  operation: PairClaim["operation"] = "swap"
): PairClaim {
  return {
    binStep: Number(pool.binStep),
    hooksParameters: pool.hooksParameters,
    indexerFactory: pool.factoryAddress,
    indexerIgnoredForRouting: pool.ignoredForRouting,
    pair: pool.address,
    operation,
    tokenX: pool.tokenXAddress,
    tokenY: pool.tokenYAddress
  };
}

export function decodeHooksParameters(parameters: Hex): DecodedHooks {
  if (!/^0x[0-9a-fA-F]{64}$/.test(parameters)) {
    throw new PairAttestationError("invalid-hooks", "Indexer returned malformed hook parameters; refresh the market before writing");
  }
  const value = BigInt(parameters);
  const address = getAddress(`0x${(value & HOOK_ADDRESS_MASK).toString(16).padStart(40, "0")}`);
  const flags = Number((value >> 160n) & 0x3ffn);
  const enabledFlags = HOOK_FLAG_NAMES.filter((_, index) => (flags & (1 << index)) !== 0);
  return {
    address,
    enabledFlags: [...enabledFlags],
    flags,
    parameters: parameters.toLowerCase() as Hex,
    reservedBits: value & ~CANONICAL_HOOK_MASK
  };
}

export function evaluatePairEvidence(registry: DexRegistry, claim: PairClaim, evidence: PairEvidence): PairAttestation {
  if (evidence.chainId !== registry.chainId) {
    throw new PairAttestationError("chain-mismatch", `RPC chain changed: expected ${registry.chainId}, received ${evidence.chainId}; switch back and refresh`);
  }
  if (!evidence.factoryHasCode || !evidence.routerHasCode) {
    throw new PairAttestationError("deployment-code-missing", "Configured factory or router has no contract code on this chain; writes are disabled");
  }
  if (
    claim.operation === "swap" &&
    (!evidence.quoterHasCode || evidence.quoterFactory === undefined || evidence.quoterRouter === undefined || !isAddressEqual(evidence.quoterFactory, registry.contracts.lbFactory) || !isAddressEqual(evidence.quoterRouter, registry.contracts.lbRouter))
  ) {
    throw new PairAttestationError("quoter-deployment-mismatch", "Configured quoter is not linked to this factory and router; refresh deployment configuration");
  }
  if (!isAddressEqual(claim.indexerFactory, registry.contracts.lbFactory)) {
    throw new PairAttestationError("indexer-factory-mismatch", "Indexer attributes the displayed pair to a different factory; writes are disabled");
  }
  if (!isAddressEqual(evidence.routerFactory, registry.contracts.lbFactory)) {
    throw new PairAttestationError("router-factory-mismatch", "Configured router points to a different factory; writes are disabled for this deployment");
  }
  if (!evidence.pairHasCode) {
    throw new PairAttestationError("pair-code-missing", "Displayed pair has no contract code; refresh the indexer before writing");
  }
  if (!isAddressEqual(evidence.factory, registry.contracts.lbFactory)) {
    throw new PairAttestationError("foreign-factory", "Displayed pair belongs to a foreign factory; select a Feather market");
  }
  if (!evidence.pairImplementationHasCode || !registry.supportedPairImplementations.some((implementation) => isAddressEqual(evidence.pairImplementation, implementation))) {
    throw new PairAttestationError("pair-implementation-mismatch", "Pair implementation differs from the deployment manifest; writes are disabled");
  }
  if (!isAddressEqual(evidence.factoryLookupPair, claim.pair) || !isAddressEqual(evidence.pair, claim.pair)) {
    throw new PairAttestationError("stale-pair", "Factory lookup no longer resolves the displayed pair; refresh the market before writing");
  }
  if (evidence.factoryLookupIgnored !== claim.indexerIgnoredForRouting) {
    throw new PairAttestationError("ignored-state-mismatch", "Pair routing status differs between the indexer and RPC; refresh the market before writing");
  }
  if (evidence.factoryLookupIgnored && claim.operation !== "remove-liquidity") {
    throw new PairAttestationError("ignored-pair", "Factory has disabled this pair for routing; swaps and new liquidity are unavailable");
  }
  if (evidence.factoryLookupBinStep !== claim.binStep || evidence.binStep !== claim.binStep) {
    throw new PairAttestationError("bin-step-mismatch", "Pair bin step differs between the indexer and RPC; refresh the market before writing");
  }
  if (!isAddressEqual(evidence.tokenX, claim.tokenX) || !isAddressEqual(evidence.tokenY, claim.tokenY)) {
    throw new PairAttestationError("token-order-mismatch", "Pair token order differs between the indexer and RPC; the displayed market may be stale or spoofed");
  }
  if (claim.hooksParameters === null) {
    throw new PairAttestationError("indexer-hooks-missing", "Indexer has not attested this pair's hooks yet; wait for indexing and refresh");
  }
  if (claim.hooksParameters.toLowerCase() !== evidence.hooksParameters?.toLowerCase()) {
    throw new PairAttestationError("hooks-mismatch", "Pair hooks changed or differ from indexed data; refresh and review the hook risk before writing");
  }

  const decoded = decodeHooksParameters(claim.hooksParameters);
  if (decoded.reservedBits !== 0n) {
    throw new PairAttestationError("reserved-hook-flags", "Pair enables unknown hook flags; this market is unsupported");
  }
  const hookless = decoded.address === zeroAddress;
  if (hookless && decoded.flags !== 0) {
    throw new PairAttestationError("invalid-hooks", "Pair enables hook behavior without a hook contract; this market is unsupported");
  }
  if (hookless) {
    return {
      behavior: "No callbacks",
      hookAddress: null,
      hookFlags: [],
      hookIdentity: "Hookless LB pair",
      hookRisk: "none",
      pair: claim.pair
    };
  }
  if (decoded.flags === 0) {
    throw new PairAttestationError("invalid-hooks", "Pair declares a hook contract without any recognized callback flags; this market is unsupported");
  }
  if (!evidence.hookCode || evidence.hookCode === "0x") {
    throw new PairAttestationError("hook-code-missing", "Pair hook has no contract code; this market is unsupported");
  }
  if (evidence.hookLinked !== true || evidence.hookPair === undefined || !isAddressEqual(evidence.hookPair, claim.pair)) {
    throw new PairAttestationError("hook-link-mismatch", "Pair hook is not linked to this exact pair; writes are disabled");
  }
  const allowlisted = registry.supportedHooks.find((hook) => isAddressEqual(hook.address, decoded.address));
  if (allowlisted === undefined) {
    throw new PairAttestationError("unknown-hook", "Pair uses a hook that is not in this deployment's allowlist; writes are disabled");
  }
  if (allowlisted.flags !== decoded.flags) {
    throw new PairAttestationError("hook-flags-changed", "Pair hook flags differ from the deployment allowlist; writes are disabled");
  }
  if (keccak256(evidence.hookCode).toLowerCase() !== allowlisted.codeHash.toLowerCase()) {
    throw new PairAttestationError("hook-code-changed", "Pair hook bytecode changed from the reviewed deployment; writes are disabled");
  }
  if (allowlisted.upgradeability === "eip1967") {
    if (
      evidence.hookImplementation === undefined ||
      evidence.hookImplementationCode === undefined ||
      allowlisted.implementationAddress === undefined ||
      allowlisted.implementationCodeHash === undefined ||
      !isAddressEqual(evidence.hookImplementation, allowlisted.implementationAddress) ||
      keccak256(evidence.hookImplementationCode).toLowerCase() !== allowlisted.implementationCodeHash.toLowerCase()
    ) {
      throw new PairAttestationError("hook-implementation-changed", "Pair hook proxy implementation differs from the reviewed deployment; writes are disabled");
    }
  } else if (evidence.hookImplementation !== undefined) {
    throw new PairAttestationError("unexpected-hook-proxy", "Hook declared immutable exposes an EIP-1967 implementation; writes are disabled");
  }

  return {
    behavior: allowlisted.behavior,
    hookAddress: decoded.address,
    hookFlags: decoded.enabledFlags,
    hookIdentity: allowlisted.identity,
    hookRisk: allowlisted.risk,
    pair: claim.pair
  };
}

export async function attestPairForWrite(
  publicClient: PublicClient,
  registry: DexRegistry,
  claim: PairClaim
): Promise<PairAttestation> {
  try {
    const chainId = await publicClient.getChainId();
    const blockNumber = await publicClient.getBlockNumber();
    const [
      factoryCode,
      routerCode,
      pairCode,
      factoryLookup,
      factory,
      routerFactory,
      pairImplementation,
      tokenX,
      tokenY,
      binStep,
      hooksParameters
    ] = await Promise.all([
      publicClient.getBytecode({ address: registry.contracts.lbFactory, blockNumber }),
      publicClient.getBytecode({ address: registry.contracts.lbRouter, blockNumber }),
      publicClient.getBytecode({ address: claim.pair, blockNumber }),
      publicClient.readContract({
        address: registry.contracts.lbFactory,
        abi: lbFactoryAbi,
        functionName: "getLBPairInformation",
        args: [claim.tokenX, claim.tokenY, BigInt(claim.binStep)],
        blockNumber
      }),
      publicClient.readContract({ address: claim.pair, abi: lbPairAbi, functionName: "getFactory", blockNumber }),
      publicClient.readContract({ address: registry.contracts.lbRouter, abi: lbRouterAbi, functionName: "getFactory", blockNumber }),
      publicClient.readContract({ address: claim.pair, abi: lbPairAbi, functionName: "implementation", blockNumber }),
      publicClient.readContract({ address: claim.pair, abi: lbPairAbi, functionName: "getTokenX", blockNumber }),
      publicClient.readContract({ address: claim.pair, abi: lbPairAbi, functionName: "getTokenY", blockNumber }),
      publicClient.readContract({ address: claim.pair, abi: lbPairAbi, functionName: "getBinStep", blockNumber }),
      publicClient.readContract({ address: claim.pair, abi: lbPairAbi, functionName: "getLBHooksParameters", blockNumber })
    ]);
    const info = factoryLookup as { LBPair: Address; binStep: number; ignoredForRouting: boolean };
    const decoded = decodeHooksParameters(hooksParameters);
    const pairImplementationCode = await publicClient.getBytecode({ address: pairImplementation, blockNumber });
    const [quoterCode, quoterFactory, quoterRouter] = claim.operation === "swap"
      ? await Promise.all([
          publicClient.getBytecode({ address: registry.contracts.lbQuoter, blockNumber }),
          publicClient.readContract({ address: registry.contracts.lbQuoter, abi: lbQuoterAbi, functionName: "getFactoryV2_2", blockNumber }),
          publicClient.readContract({ address: registry.contracts.lbQuoter, abi: lbQuoterAbi, functionName: "getRouterV2_2", blockNumber })
        ])
      : [undefined, undefined, undefined];
    if (claim.hooksParameters === null) {
      throw new PairAttestationError("indexer-hooks-missing", "Indexer has not attested this pair's hooks yet; wait for indexing and refresh");
    }
    if (claim.hooksParameters.toLowerCase() !== hooksParameters.toLowerCase()) {
      throw new PairAttestationError("hooks-mismatch", "Pair hooks changed or differ from indexed data; refresh and review the hook risk before writing");
    }
    if (decoded.reservedBits !== 0n || (decoded.address === zeroAddress && decoded.flags !== 0) || (decoded.address !== zeroAddress && decoded.flags === 0)) {
      throw new PairAttestationError("invalid-hooks", "Pair hook parameters contain an unsupported address or flag combination");
    }
    const allowlistedHook = decoded.address === zeroAddress
      ? undefined
      : registry.supportedHooks.find((hook) => isAddressEqual(hook.address, decoded.address) && hook.flags === decoded.flags);
    if (decoded.address !== zeroAddress && allowlistedHook === undefined) {
      throw new PairAttestationError("unknown-hook", "Pair uses a hook identity or flags that are not in this deployment's allowlist; writes are disabled");
    }
    const hookCode = decoded.address === zeroAddress ? undefined : await publicClient.getBytecode({ address: decoded.address, blockNumber });
    if (decoded.address !== zeroAddress && (!hookCode || hookCode === "0x")) {
      throw new PairAttestationError("hook-code-missing", "Pair hook has no contract code; this market is unsupported");
    }
    if (allowlistedHook && hookCode && keccak256(hookCode).toLowerCase() !== allowlistedHook.codeHash.toLowerCase()) {
      throw new PairAttestationError("hook-code-changed", "Pair hook bytecode changed from the reviewed deployment; writes are disabled");
    }
    let hookImplementation: Address | undefined;
    let hookImplementationCode: Hex | undefined;
    if (allowlistedHook) {
      const stored = await publicClient.getStorageAt({ address: decoded.address, slot: EIP1967_IMPLEMENTATION_SLOT, blockNumber });
      if (!stored) throw new PairAttestationError("hook-implementation-changed", "Pair hook upgradeability evidence is unavailable");
      if (BigInt(stored) !== 0n) {
        if (BigInt(`0x${stored.slice(2, 26)}`) !== 0n) {
          throw new PairAttestationError("hook-implementation-changed", "Pair hook implementation slot is malformed");
        }
        hookImplementation = getAddress(`0x${stored.slice(-40)}`);
        hookImplementationCode = await publicClient.getBytecode({ address: hookImplementation, blockNumber });
      }
    }
    const [hookPair, hookLinked] = decoded.address === zeroAddress
      ? [undefined, undefined]
      : await Promise.all([
          publicClient.readContract({ address: decoded.address, abi: lbHooksAbi, functionName: "getLBPair", blockNumber }),
          publicClient.readContract({ address: decoded.address, abi: lbHooksAbi, functionName: "isLinked", blockNumber })
        ]);
    return evaluatePairEvidence(registry, claim, {
      ...claim,
      binStep: Number(binStep),
      chainId,
      factory,
      factoryHasCode: factoryCode !== undefined && factoryCode !== "0x",
      factoryLookupBinStep: Number(info.binStep),
      factoryLookupIgnored: info.ignoredForRouting,
      factoryLookupPair: info.LBPair,
      hookCode,
      hookLinked,
      hookPair,
      hookImplementation,
      hookImplementationCode,
      hooksParameters,
      pairHasCode: pairCode !== undefined && pairCode !== "0x",
      pairImplementation,
      pairImplementationHasCode: pairImplementationCode !== undefined && pairImplementationCode !== "0x",
      quoterFactory,
      quoterHasCode: quoterCode !== undefined && quoterCode !== "0x",
      quoterRouter,
      routerHasCode: routerCode !== undefined && routerCode !== "0x",
      routerFactory,
      tokenX,
      tokenY
    });
  } catch (error) {
    if (error instanceof PairAttestationError) throw error;
    throw new PairAttestationError("rpc-unavailable", "Live pair attestation is unavailable; no simulation or wallet request was sent");
  }
}

export async function attestSwapRouteForWrite(
  publicClient: PublicClient,
  registry: DexRegistry,
  input: {
    binSteps: readonly bigint[];
    pairs: readonly Address[];
    pools: readonly PoolRow[];
    resolvePool?: (pair: Address) => Promise<PoolRow | null>;
    route: readonly Address[];
    versions: readonly number[];
  }
): Promise<PairAttestation[]> {
  if (
    input.pairs.length === 0 ||
    input.pairs.length > MAX_ATTESTED_ROUTE_HOPS ||
    input.route.length !== input.pairs.length + 1 ||
    input.binSteps.length !== input.pairs.length ||
    input.versions.length !== input.pairs.length
  ) {
    throw new PairAttestationError("invalid-route", `Quoted route must contain one or two V2.2 hops; refresh the quote`);
  }
  return Promise.all(input.pairs.map(async (pair, index) => {
    if (input.versions[index] !== 3) {
      throw new PairAttestationError("unsupported-route-version", "Quoted route contains a non-V2.2 hop; writes are disabled");
    }
    const indexed = input.pools.find((pool) => isAddressEqual(pool.address, pair)) ?? await input.resolvePool?.(pair);
    if (indexed === undefined || indexed === null) {
      throw new PairAttestationError("unindexed-route-hop", "A quoted route hop is not present in the current indexer snapshot; refresh before writing");
    }
    if (BigInt(indexed.binStep) !== input.binSteps[index]) {
      throw new PairAttestationError("route-bin-step-mismatch", "Quoted route bin step differs from the indexed pair; refresh the quote");
    }
    const routeTokenX = input.route[index];
    const routeTokenY = input.route[index + 1];
    const matchesPair =
      (isAddressEqual(indexed.tokenXAddress, routeTokenX) && isAddressEqual(indexed.tokenYAddress, routeTokenY)) ||
      (isAddressEqual(indexed.tokenXAddress, routeTokenY) && isAddressEqual(indexed.tokenYAddress, routeTokenX));
    if (!matchesPair) {
      throw new PairAttestationError("route-token-mismatch", "Quoted route tokens do not match the indexed pair; refresh the quote");
    }
    return attestPairForWrite(publicClient, registry, { ...poolRowToPairClaim(indexed), operation: "swap" });
  }));
}

export function hooklessClaim(input: Omit<PairClaim, "hooksParameters">): PairClaim {
  return { ...input, hooksParameters: ZERO_HOOKS };
}
