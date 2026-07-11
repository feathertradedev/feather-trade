import { readFileSync } from "node:fs";

import { getAddress, isAddress, zeroAddress, type Address } from "viem";

import { ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "./chains.js";
import { defaultEndpoints, type EndpointConfig } from "./endpoints.js";
import { assertLegacyRoutingDisabled } from "./routing-policy.js";

export interface FactoryPreset {
  binStep: number;
  baseFactor: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: number;
  protocolShare: number;
  maxVolatilityAccumulator: number;
  open: boolean;
}

export interface CoreContracts {
  lbFactory: Address;
  lbPairImplementation: Address;
  lbRouter: Address;
  lbQuoter: Address;
}

export interface DeploymentOwnership {
  feeRecipient: Address;
  initialOwner: Address;
  lbFactoryOwner: Address;
}

export interface LocalnetDeploymentManifest {
  schemaVersion: "lb.localnet.v1";
  environment: "localnet";
  sourceJoeV2Commit: string;
  chainId: number;
  startBlock: number;
  deployer: Address;
  endpoints: EndpointConfig;
  contracts: CoreContracts;
  ownership: DeploymentOwnership;
  tokens: {
    wnative: Address;
    usdc: Address;
    usdt: Address;
    weth: Address;
  };
  factoryPreset: FactoryPreset;
  seededPools: {
    wnativeUsdc: {
      pair: Address;
      tokenX: Address;
      tokenY: Address;
      activeId: number;
      binStep: number;
    };
  };
  constructorArgs: Record<string, unknown>;
  smoke: Record<string, unknown>;
}

export interface RobinhoodDeploymentManifestBase {
  schemaVersion: "lb.robinhood.v1";
  environment: "testnet" | "mainnet";
  sourceJoeV2Commit: string;
  chainId: number;
  startBlock: number;
  deployer: Address;
  endpoints: EndpointConfig;
  contracts: CoreContracts;
  ownership: DeploymentOwnership;
  tokens: {
    wrappedNative: Address;
  };
  chain: {
    name: string;
    nativeCurrency: "ETH";
    rpcEnvVar: string;
    explorerUrl: string;
    verifierUrl: string;
  };
  quoteAssets: Record<string, Address>;
  factoryPreset: FactoryPreset;
  constructorArgs: Record<string, unknown>;
}

export type RobinhoodDeploymentManifest = RobinhoodDeploymentManifestBase;

export type DeploymentManifest = LocalnetDeploymentManifest | RobinhoodDeploymentManifest;

export function readDeploymentManifest(path: string): DeploymentManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return normalizeManifest(parsed, path);
}

function normalizeManifest(value: unknown, path: string): DeploymentManifest {
  if (!isObject(value)) {
    throw new Error(`Deployment manifest ${path} must be a JSON object`);
  }

  if (value.zap !== undefined) {
    throw new Error("Zap metadata is no longer supported; use direct one-sided liquidity or the separate swap flow");
  }

  const schemaVersion = expectString(value.schemaVersion, "schemaVersion");

  if (schemaVersion === "lb.localnet.v1") {
    return normalizeLocalnetManifest(value, path);
  }

  if (schemaVersion === "lb.robinhood.v1") {
    return normalizeRobinhoodManifest(value, path);
  }

  throw new Error(`Unsupported deployment manifest schemaVersion ${schemaVersion} in ${path}`);
}

function normalizeLocalnetManifest(value: Record<string, unknown>, path: string): LocalnetDeploymentManifest {
  const contracts = expectObject(value.contracts, "contracts");
  const constructorArgs = expectObject(value.constructorArgs, "constructorArgs");
  const tokens = expectObject(value.tokens, "tokens");
  const preset = expectObject(value.factoryPreset, "factoryPreset");
  const seededPools = expectObject(value.seededPools, "seededPools");
  const wnativeUsdc = expectObject(seededPools.wnativeUsdc, "seededPools.wnativeUsdc");
  const environment = expectString(value.environment, "environment");
  const chainId = expectInteger(value.chainId, "chainId", { min: 1 });
  const deployer = expectAddress(value.deployer, "deployer", { allowZero: false });

  assertNoLegacyZapConstructorArgs(constructorArgs);

  if (environment !== "localnet") {
    throw new Error(`Expected localnet manifest environment "localnet" in ${path}, got ${environment}`);
  }

  assertLegacyRoutingDisabled(constructorArgs);

  return {
    schemaVersion: "lb.localnet.v1",
    environment,
    sourceJoeV2Commit: expectString(value.sourceJoeV2Commit, "sourceJoeV2Commit"),
    chainId,
    startBlock: expectInteger(value.startBlock, "startBlock", { min: 0 }),
    deployer,
    endpoints: normalizeEndpoints(value.endpoints, defaultEndpoints.localnet),
    contracts: normalizeCoreContracts(contracts),
    ownership: normalizeOwnership(value.ownership, constructorArgs, deployer),
    tokens: {
      wnative: expectAddress(tokens.wnative, "tokens.wnative", { allowZero: false }),
      usdc: expectAddress(tokens.usdc, "tokens.usdc", { allowZero: false }),
      usdt: expectAddress(tokens.usdt, "tokens.usdt", { allowZero: false }),
      weth: expectAddress(tokens.weth, "tokens.weth", { allowZero: false })
    },
    factoryPreset: normalizeFactoryPreset(preset),
    seededPools: {
      wnativeUsdc: {
        pair: expectAddress(wnativeUsdc.pair, "seededPools.wnativeUsdc.pair", { allowZero: false }),
        tokenX: expectAddress(wnativeUsdc.tokenX, "seededPools.wnativeUsdc.tokenX", { allowZero: false }),
        tokenY: expectAddress(wnativeUsdc.tokenY, "seededPools.wnativeUsdc.tokenY", { allowZero: false }),
        activeId: expectInteger(wnativeUsdc.activeId, "seededPools.wnativeUsdc.activeId"),
        binStep: expectInteger(wnativeUsdc.binStep, "seededPools.wnativeUsdc.binStep", { min: 1 })
      }
    },
    constructorArgs,
    smoke: expectObject(value.smoke, "smoke")
  };
}

function normalizeRobinhoodManifest(value: Record<string, unknown>, path: string): RobinhoodDeploymentManifest {
  const contracts = expectObject(value.contracts, "contracts");
  const constructorArgs = expectObject(value.constructorArgs, "constructorArgs");
  const tokens = expectObject(value.tokens, "tokens");
  const chain = expectObject(value.chain, "chain");
  const quoteAssets = expectObject(value.quoteAssets, "quoteAssets");
  const preset = expectObject(value.factoryPreset, "factoryPreset");
  const environment = expectString(value.environment, "environment");

  assertNoLegacyZapConstructorArgs(constructorArgs);

  if (environment !== "testnet" && environment !== "mainnet") {
    throw new Error(`Unsupported Robinhood manifest environment ${environment} in ${path}`);
  }

  const expectedChainId = environment === "mainnet" ? ROBINHOOD_CHAIN_ID : ROBINHOOD_TESTNET_CHAIN_ID;
  const deployer = expectAddress(value.deployer, "deployer", { allowZero: false });
  const defaultEndpointConfig = environment === "mainnet" ? defaultEndpoints.robinhood : defaultEndpoints.robinhoodTestnet;
  const normalizedContracts = normalizeCoreContracts(contracts);
  const normalizedTokens = {
    wrappedNative: expectAddress(tokens.wrappedNative, "tokens.wrappedNative", { allowZero: false })
  };
  const normalizedQuoteAssets = normalizeQuoteAssets(quoteAssets);

  assertLegacyRoutingDisabled(constructorArgs);

  return {
    schemaVersion: "lb.robinhood.v1",
    environment,
    sourceJoeV2Commit: expectString(value.sourceJoeV2Commit, "sourceJoeV2Commit"),
    chainId: expectExpectedChainId(value.chainId, expectedChainId, environment, path),
    startBlock: expectInteger(value.startBlock, "startBlock", { min: 0 }),
    deployer,
    endpoints: normalizeEndpoints(value.endpoints, defaultEndpointConfig),
    ownership: normalizeOwnership(value.ownership, constructorArgs, deployer),
    tokens: normalizedTokens,
    chain: {
      name: expectString(chain.name, "chain.name"),
      nativeCurrency: expectLiteral(chain.nativeCurrency, "ETH", "chain.nativeCurrency"),
      rpcEnvVar: expectString(chain.rpcEnvVar, "chain.rpcEnvVar"),
      explorerUrl: expectString(chain.explorerUrl, "chain.explorerUrl"),
      verifierUrl: expectString(chain.verifierUrl, "chain.verifierUrl")
    },
    quoteAssets: normalizedQuoteAssets,
    factoryPreset: normalizeFactoryPreset(preset),
    contracts: normalizedContracts,
    constructorArgs
  };
}

function normalizeCoreContracts(value: Record<string, unknown>): CoreContracts {
  expectOnlyKeys(value, "contracts", ["lbFactory", "lbPairImplementation", "lbRouter", "lbQuoter"]);

  return {
    lbFactory: expectAddress(value.lbFactory, "contracts.lbFactory", { allowZero: false }),
    lbPairImplementation: expectAddress(value.lbPairImplementation, "contracts.lbPairImplementation", { allowZero: false }),
    lbRouter: expectAddress(value.lbRouter, "contracts.lbRouter", { allowZero: false }),
    lbQuoter: expectAddress(value.lbQuoter, "contracts.lbQuoter", { allowZero: false })
  };
}

function assertNoLegacyZapConstructorArgs(constructorArgs: Record<string, unknown>): void {
  const legacyZapConstructorArg = Object.keys(constructorArgs).find((key) => key.toLowerCase().startsWith("zap"));
  if (legacyZapConstructorArg !== undefined) {
    throw new Error(`constructorArgs.${legacyZapConstructorArg} is no longer supported`);
  }
}

function normalizeFactoryPreset(value: Record<string, unknown>): FactoryPreset {
  return {
    binStep: expectNumber(value.binStep, "factoryPreset.binStep"),
    baseFactor: expectNumber(value.baseFactor, "factoryPreset.baseFactor"),
    filterPeriod: expectNumber(value.filterPeriod, "factoryPreset.filterPeriod"),
    decayPeriod: expectNumber(value.decayPeriod, "factoryPreset.decayPeriod"),
    reductionFactor: expectNumber(value.reductionFactor, "factoryPreset.reductionFactor"),
    variableFeeControl: expectNumber(value.variableFeeControl, "factoryPreset.variableFeeControl"),
    protocolShare: expectNumber(value.protocolShare, "factoryPreset.protocolShare"),
    maxVolatilityAccumulator: expectNumber(value.maxVolatilityAccumulator, "factoryPreset.maxVolatilityAccumulator"),
    open: expectBoolean(value.open, "factoryPreset.open")
  };
}

function normalizeAddressRecord(value: Record<string, unknown>, path: string): Record<string, Address> {
  return Object.fromEntries(Object.entries(value).map(([key, address]) => [key, expectAddress(address, `${path}.${key}`)]));
}

function normalizeQuoteAssets(value: Record<string, unknown>): Record<string, Address> {
  const quoteAssets = normalizeAddressRecord(value, "quoteAssets");

  if (quoteAssets.wrappedNative === undefined) {
    throw new Error("Expected quoteAssets.wrappedNative to be an address");
  }

  expectAddress(quoteAssets.wrappedNative, "quoteAssets.wrappedNative", { allowZero: false });

  return quoteAssets;
}

function normalizeEndpoints(value: unknown, defaults: EndpointConfig): EndpointConfig {
  if (value === undefined) {
    return defaults;
  }

  const endpoints = expectObject(value, "endpoints");
  expectOnlyKeys(endpoints, "endpoints", ["rpcUrl", "indexerUrl", "apiUrl", "tokenListUrl"]);

  return {
    rpcUrl: hasOwn(endpoints, "rpcUrl") ? expectString(endpoints.rpcUrl, "endpoints.rpcUrl") : defaults.rpcUrl,
    indexerUrl: hasOwn(endpoints, "indexerUrl")
      ? expectNullableString(endpoints.indexerUrl, "endpoints.indexerUrl")
      : defaults.indexerUrl,
    apiUrl: hasOwn(endpoints, "apiUrl") ? expectNullableString(endpoints.apiUrl, "endpoints.apiUrl") : defaults.apiUrl,
    tokenListUrl: hasOwn(endpoints, "tokenListUrl")
      ? expectNullableString(endpoints.tokenListUrl, "endpoints.tokenListUrl")
      : defaults.tokenListUrl
  };
}

function normalizeOwnership(
  value: unknown,
  constructorArgs: Record<string, unknown>,
  deployer: Address
): DeploymentOwnership {
  const inferredInitialOwner =
    typeof constructorArgs.initialOwner === "string" && isAddress(constructorArgs.initialOwner)
      ? getAddress(constructorArgs.initialOwner)
      : deployer;
  const inferredFeeRecipient =
    typeof constructorArgs.feeRecipient === "string" && isAddress(constructorArgs.feeRecipient)
      ? getAddress(constructorArgs.feeRecipient)
      : inferredInitialOwner;

  if (value === undefined) {
    return {
      feeRecipient: inferredFeeRecipient,
      initialOwner: inferredInitialOwner,
      lbFactoryOwner: inferredInitialOwner
    };
  }

  const ownership = expectObject(value, "ownership");

  return {
    feeRecipient: expectAddress(ownership.feeRecipient, "ownership.feeRecipient", { allowZero: false }),
    initialOwner: expectAddress(ownership.initialOwner, "ownership.initialOwner", { allowZero: false }),
    lbFactoryOwner: expectAddress(ownership.lbFactoryOwner, "ownership.lbFactoryOwner", { allowZero: false })
  };
}

function expectAddress(value: unknown, path: string, options: { allowZero?: boolean } = {}): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`Expected ${path} to be an address`);
  }

  const address = getAddress(value);
  if (options.allowZero === false && address === zeroAddress) {
    throw new Error(`Expected ${path} to be a non-zero address`);
  }

  return address;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Expected ${path} to be a boolean`);
  }

  return value;
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${path} to be a number`);
  }

  return value;
}

function expectInteger(value: unknown, path: string, options: { min?: number; max?: number } = {}): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Expected ${path} to be an integer`);
  }

  if (options.min !== undefined && value < options.min) {
    throw new Error(`Expected ${path} to be an integer >= ${options.min}`);
  }

  if (options.max !== undefined && value > options.max) {
    throw new Error(`Expected ${path} to be an integer <= ${options.max}`);
  }

  return value;
}

function expectExpectedChainId(value: unknown, expected: number, environment: string, path: string): number {
  const chainId = expectInteger(value, "chainId");

  if (chainId !== expected) {
    throw new Error(`Expected ${environment} manifest chainId ${expected} in ${path}, got ${chainId}`);
  }

  return chainId;
}

function expectLiteral<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) {
    throw new Error(`Expected ${path} to be ${expected}`);
  }

  return expected;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${path} to be a non-empty string`);
  }

  return value;
}

function expectNullableString(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }

  return expectString(value, path);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`Expected ${path} to be an object`);
  }

  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function expectOnlyKeys(value: Record<string, unknown>, path: string, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected ${path} field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`);
  }
}
