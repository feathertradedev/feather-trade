import { isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from "viem";

import { lbFactoryAbi } from "./abi.js";

export const MAX_FACTORY_QUOTE_ASSETS = 256n;
const MAX_UINT16 = (1n << 16n) - 1n;

export interface PoolCreationFactoryDiscovery {
  blockNumber: bigint;
  openBinSteps: bigint[];
  quoteAssets: Address[];
}

export interface PoolCreationSelection {
  binStep: bigint;
  tokenX: Address;
  tokenY: Address;
}

export async function readPoolCreationFactoryDiscovery(
  client: PublicClient,
  factory: Address,
  blockNumber: bigint
): Promise<PoolCreationFactoryDiscovery> {
  if (!isAddress(factory) || isAddressEqual(factory, zeroAddress)) {
    throw new Error("Pool-creation factory must be a nonzero address");
  }
  if (blockNumber < 0n) throw new Error("Pool-creation discovery block must be nonnegative");

  const [rawOpenBinSteps, rawQuoteAssetCount] = await Promise.all([
    client.readContract({
      address: factory,
      abi: lbFactoryAbi,
      functionName: "getOpenBinSteps",
      blockNumber
    }),
    client.readContract({
      address: factory,
      abi: lbFactoryAbi,
      functionName: "getNumberOfQuoteAssets",
      blockNumber
    })
  ]);
  const openBinSteps = normalizeOpenBinSteps(rawOpenBinSteps);
  const quoteAssetCount = normalizeQuoteAssetCount(rawQuoteAssetCount);
  const quoteAssets = await Promise.all(
    Array.from({ length: Number(quoteAssetCount) }, (_, index) =>
      client.readContract({
        address: factory,
        abi: lbFactoryAbi,
        functionName: "getQuoteAssetAtIndex",
        args: [BigInt(index)],
        blockNumber
      })
    )
  );

  return {
    blockNumber,
    openBinSteps,
    quoteAssets: normalizeQuoteAssets(quoteAssets)
  };
}

export function validatePoolCreationSelection(
  discovery: PoolCreationFactoryDiscovery,
  selection: PoolCreationSelection
): PoolCreationSelection {
  const tokenX = normalizeCreationToken(selection.tokenX, "tokenX");
  const tokenY = normalizeCreationToken(selection.tokenY, "tokenY");
  if (isAddressEqual(tokenX, tokenY)) throw new Error("Pool-creation tokens must be distinct");
  const binStep = normalizeOpenBinStep(selection.binStep);
  if (!discovery.openBinSteps.includes(binStep)) {
    throw new Error(`Bin step ${binStep} is not an open factory preset at block ${discovery.blockNumber}`);
  }
  if (!discovery.quoteAssets.some((asset) => isAddressEqual(asset, tokenY))) {
    throw new Error("Semantic tokenY is not an allowed factory quote asset");
  }

  return { binStep, tokenX, tokenY };
}

function normalizeOpenBinSteps(values: readonly bigint[]): bigint[] {
  const seen = new Set<string>();
  const normalized = values.map((value) => {
    const binStep = normalizeOpenBinStep(value);
    const key = binStep.toString();
    if (seen.has(key)) throw new Error(`Factory returned duplicate open bin step ${key}`);
    seen.add(key);
    return binStep;
  });
  return normalized.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function normalizeOpenBinStep(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_UINT16) {
    throw new Error("Open factory bin step must fit a nonzero uint16");
  }
  return value;
}

function normalizeQuoteAssetCount(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_FACTORY_QUOTE_ASSETS) {
    throw new Error(`Factory quote-asset count must be between 0 and ${MAX_FACTORY_QUOTE_ASSETS}`);
  }
  return value;
}

function normalizeQuoteAssets(values: readonly Address[]): Address[] {
  const seen = new Set<string>();
  const normalized = values.map((value) => {
    const asset = normalizeCreationToken(value, "quote asset");
    const key = asset.toLowerCase();
    if (seen.has(key)) throw new Error(`Factory returned duplicate quote asset ${asset}`);
    seen.add(key);
    return asset;
  });
  return normalized.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
}

function normalizeCreationToken(value: Address, label: string): Address {
  if (!isAddress(value) || isAddressEqual(value, zeroAddress)) {
    throw new Error(`Pool-creation ${label} must be a nonzero address`);
  }
  return value;
}
