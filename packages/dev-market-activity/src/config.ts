import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  findTokenMetadata,
  readDeploymentManifest,
  registryFromLocalnetManifest,
  registryFromRobinhoodManifest,
  type DexRegistry,
  type TokenMetadata
} from "@robinhood-lb/sdk";
import { getAddress, parseUnits, type Address, type Hex } from "viem";

import { assertNonMainnetEnvironment } from "./policy.js";

export interface MarketActivityPool {
  pair: Address;
  tokenX: Address;
  tokenY: Address;
  binStep: number;
}

export interface MarketActivityConfig {
  environment: "localnet" | "testnet";
  rpcUrl: string;
  privateKey: Hex;
  manifestPath: string;
  registry: DexRegistry;
  pool: MarketActivityPool;
  weth: TokenMetadata;
  usdc: TokenMetadata;
  intervalMs: number;
  randomSeed: number | null;
  slippageBps: bigint;
  hardRadius: number;
  turnaroundRadius: number;
  baseAmounts: { weth: bigint; usdc: bigint };
  caps: { weth: bigint; usdc: bigint };
  budgets: { weth: bigint; usdc: bigint };
}

export function loadMarketActivityConfig(env: NodeJS.ProcessEnv = process.env): MarketActivityConfig {
  const rpcUrl = required(env, "MARKET_ACTIVITY_RPC_URL");
  const privateKey = privateKeyValue(required(env, "MARKET_ACTIVITY_PRIVATE_KEY"));
  const manifestPath = resolve(env.MARKET_ACTIVITY_MANIFEST_PATH || defaultManifestPath());
  const manifest = readDeploymentManifest(manifestPath);
  assertNonMainnetEnvironment(manifest.environment);

  let registry: DexRegistry;
  let environment: "localnet" | "testnet";
  let pool: MarketActivityPool;
  if (manifest.schemaVersion === "lb.localnet.v1") {
    registry = registryFromLocalnetManifest(manifest);
    environment = "localnet";
    const configured = manifest.seededPools.wethUsdc;
    if (configured === undefined) throw new Error("Localnet manifest does not define seededPools.wethUsdc");
    pool = configured;
  } else {
    if (manifest.environment !== "testnet") throw new Error("Development market activity rejects mainnet unconditionally");
    registry = registryFromRobinhoodManifest(manifest);
    environment = "testnet";
    pool = {
      pair: address(required(env, "MARKET_ACTIVITY_POOL"), "MARKET_ACTIVITY_POOL"),
      tokenX: address(required(env, "MARKET_ACTIVITY_WETH"), "MARKET_ACTIVITY_WETH"),
      tokenY: address(required(env, "MARKET_ACTIVITY_USDC"), "MARKET_ACTIVITY_USDC"),
      binStep: positiveInteger(env.MARKET_ACTIVITY_BIN_STEP, 10, "MARKET_ACTIVITY_BIN_STEP")
    };
  }

  const weth = findTokenMetadata(registry.tokens, pool.tokenX);
  const usdc = findTokenMetadata(registry.tokens, pool.tokenY);
  if (weth === null || weth.symbol.toUpperCase() !== "WETH") {
    throw new Error("Configured WETH is not an allowlisted WETH token");
  }
  if (usdc === null || usdc.symbol.toUpperCase() !== "USDC") {
    throw new Error("Configured USDC is not an allowlisted USDC token; testnet market activity remains fail-closed");
  }

  const baseWeth = parsePositiveAmount(env.MARKET_ACTIVITY_WETH_AMOUNT ?? "1.5", weth.decimals, "MARKET_ACTIVITY_WETH_AMOUNT");
  const baseUsdc = parsePositiveAmount(env.MARKET_ACTIVITY_USDC_AMOUNT ?? "3000", usdc.decimals, "MARKET_ACTIVITY_USDC_AMOUNT");
  const capWeth = parsePositiveAmount(env.MARKET_ACTIVITY_WETH_CAP ?? "2.5", weth.decimals, "MARKET_ACTIVITY_WETH_CAP");
  const capUsdc = parsePositiveAmount(env.MARKET_ACTIVITY_USDC_CAP ?? "5000", usdc.decimals, "MARKET_ACTIVITY_USDC_CAP");
  const budgetWeth = parsePositiveAmount(env.MARKET_ACTIVITY_WETH_BUDGET ?? "5000", weth.decimals, "MARKET_ACTIVITY_WETH_BUDGET");
  const budgetUsdc = parsePositiveAmount(env.MARKET_ACTIVITY_USDC_BUDGET ?? "5000000", usdc.decimals, "MARKET_ACTIVITY_USDC_BUDGET");
  if (baseWeth > capWeth || capWeth > budgetWeth) throw new Error("WETH amount must be <= cap <= session budget");
  if (baseUsdc > capUsdc || capUsdc > budgetUsdc) throw new Error("USDC amount must be <= cap <= session budget");

  return {
    environment,
    rpcUrl,
    privateKey,
    manifestPath,
    registry,
    pool,
    weth,
    usdc,
    intervalMs: positiveInteger(env.MARKET_ACTIVITY_INTERVAL_MS, 10_000, "MARKET_ACTIVITY_INTERVAL_MS"),
    randomSeed: optionalUint32(env.MARKET_ACTIVITY_RANDOM_SEED, "MARKET_ACTIVITY_RANDOM_SEED"),
    slippageBps: BigInt(nonNegativeInteger(env.MARKET_ACTIVITY_SLIPPAGE_BPS, 100, "MARKET_ACTIVITY_SLIPPAGE_BPS")),
    hardRadius: positiveInteger(env.MARKET_ACTIVITY_HARD_RADIUS, 8, "MARKET_ACTIVITY_HARD_RADIUS"),
    turnaroundRadius: positiveInteger(env.MARKET_ACTIVITY_TURNAROUND_RADIUS, 6, "MARKET_ACTIVITY_TURNAROUND_RADIUS"),
    baseAmounts: { weth: baseWeth, usdc: baseUsdc },
    caps: { weth: capWeth, usdc: capUsdc },
    budgets: { weth: budgetWeth, usdc: budgetUsdc }
  };
}

function defaultManifestPath(): string {
  const candidates = [
    resolve(process.cwd(), "deployments/localnet/latest.json"),
    resolve(process.cwd(), "../../deployments/localnet/latest.json")
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function privateKeyValue(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("MARKET_ACTIVITY_PRIVATE_KEY must be a 32-byte hex private key");
  return value as Hex;
}

function address(value: string, label: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} must be an EVM address`);
  }
}

function parsePositiveAmount(value: string, decimals: number, label: string): bigint {
  try {
    const amount = parseUnits(value, decimals);
    if (amount <= 0n) throw new Error();
    return amount;
  } catch {
    throw new Error(`${label} must be a positive token amount`);
  }
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function optionalUint32(value: string | undefined, label: string): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error(`${label} must be an unsigned 32-bit integer`);
  }
  return parsed;
}
