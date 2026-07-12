import {
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient
} from "viem";

import { lbFactoryAbi, lbPairAbi, lbRouterAbi } from "./abi.js";
import { activeIdFromPriceQ128, priceQ128FromActiveId } from "./liquidity-price.js";

export const MAX_FACTORY_QUOTE_ASSETS = 256n;
/** Maximum contract-documented PriceHelper ID recovery drift at a bin boundary. */
export const MAX_PRICE_ID_ROUND_TRIP_TOLERANCE = 1n;
const MAX_UINT16 = (1n << 16n) - 1n;
const [LB_PAIR_CREATED_TOPIC] = encodeEventTopics({ abi: lbFactoryAbi, eventName: "LBPairCreated" });

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

export interface CreatablePoolPreflight {
  kind: "creatable";
  blockNumber: bigint;
  selection: PoolCreationSelection;
}

export interface ExistingPoolPreflight {
  kind: "existing";
  blockNumber: bigint;
  pair: Address;
  selection: PoolCreationSelection;
}

export type PoolCreationPreflight = CreatablePoolPreflight | ExistingPoolPreflight;

export interface PoolCreationTransaction {
  to: Address;
  data: Hex;
  value: 0n;
}

export interface PoolCreationReceiptLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
}

export interface PoolCreationReceipt {
  blockNumber: bigint;
  status: "success" | "reverted";
  logs: readonly PoolCreationReceiptLog[];
}

export interface ParsedLBPairCreated {
  blockNumber: bigint;
  factory: Address;
  pair: Address;
  pid: bigint;
  selection: PoolCreationSelection;
}

export interface ReconcileCreatedPoolInput {
  created: ParsedLBPairCreated;
  expectedActiveId: bigint;
  expectedPriceQ128: bigint;
}

export interface ReconciledCreatedPool extends ParsedLBPairCreated {
  activeId: bigint;
  priceQ128: bigint;
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
  const { binStep, tokenX, tokenY } = normalizePoolCreationSelection(selection);
  if (!discovery.openBinSteps.includes(binStep)) {
    throw new Error(`Bin step ${binStep} is not an open factory preset at block ${discovery.blockNumber}`);
  }
  if (!discovery.quoteAssets.some((asset) => isAddressEqual(asset, tokenY))) {
    throw new Error("Semantic tokenY is not an allowed factory quote asset");
  }

  return { binStep, tokenX, tokenY };
}

export async function preflightPoolCreation(
  client: PublicClient,
  factory: Address,
  selection: PoolCreationSelection,
  blockNumber: bigint
): Promise<PoolCreationPreflight> {
  const normalizedFactory = normalizeCreationToken(factory, "factory");
  if (blockNumber < 0n) throw new Error("Pool-creation preflight block must be nonnegative");
  const normalizedSelection = normalizePoolCreationSelection(selection);
  const { tokenX, tokenY, binStep } = normalizedSelection;

  const [tokenXCode, tokenYCode, preset, isQuoteAsset, pairInformation] = await Promise.all([
    client.getBytecode({ address: tokenX, blockNumber }),
    client.getBytecode({ address: tokenY, blockNumber }),
    client.readContract({
      address: normalizedFactory,
      abi: lbFactoryAbi,
      functionName: "getPreset",
      args: [binStep],
      blockNumber
    }),
    client.readContract({
      address: normalizedFactory,
      abi: lbFactoryAbi,
      functionName: "isQuoteAsset",
      args: [tokenY],
      blockNumber
    }),
    client.readContract({
      address: normalizedFactory,
      abi: lbFactoryAbi,
      functionName: "getLBPairInformation",
      args: [tokenX, tokenY, binStep],
      blockNumber
    })
  ]);

  assertContractCode(tokenXCode, "tokenX");
  assertContractCode(tokenYCode, "tokenY");
  if (
    !Array.isArray(preset) ||
    preset.length !== 8 ||
    !preset.slice(0, 7).every((value) => typeof value === "bigint" && value >= 0n && value < 1n << 256n) ||
    typeof preset[7] !== "boolean"
  ) {
    throw new Error("Factory returned malformed pool-creation preset data");
  }
  if (preset[7] !== true) throw new Error(`Factory preset ${binStep} is closed at block ${blockNumber}`);
  if (typeof isQuoteAsset !== "boolean") throw new Error("Factory returned malformed quote-asset status");
  if (!isQuoteAsset) throw new Error("Semantic tokenY is not an allowed factory quote asset");

  const existing = normalizePairInformation(pairInformation, binStep);
  if (existing !== undefined) {
    return {
      kind: "existing",
      blockNumber,
      pair: existing,
      selection: normalizedSelection
    };
  }
  return { kind: "creatable", blockNumber, selection: normalizedSelection };
}

export function buildCreateLBPairTransaction(
  router: Address,
  preflight: CreatablePoolPreflight,
  activeId: bigint
): PoolCreationTransaction {
  const normalizedRouter = normalizeCreationToken(router, "router");
  if (preflight.kind !== "creatable") throw new Error("Pool creation requires a creatable preflight result");
  const selection = normalizePoolCreationSelection(preflight.selection);
  const normalizedActiveId = normalizeActiveId(activeId);
  priceQ128FromActiveId(normalizedActiveId, selection.binStep);

  return {
    to: normalizedRouter,
    data: encodeFunctionData({
      abi: lbRouterAbi,
      functionName: "createLBPair",
      args: [selection.tokenX, selection.tokenY, Number(normalizedActiveId), Number(selection.binStep)]
    }),
    value: 0n
  };
}

export function parseLBPairCreatedReceipt(
  receipt: PoolCreationReceipt,
  factory: Address,
  expectedSelection: PoolCreationSelection
): ParsedLBPairCreated {
  if (receipt.status !== "success") throw new Error("Pool-creation receipt was not successful");
  if (receipt.blockNumber < 0n) throw new Error("Pool-creation receipt block must be nonnegative");
  const normalizedFactory = normalizeCreationToken(factory, "factory");
  const selection = normalizePoolCreationSelection(expectedSelection);
  const decodedEvents: Array<{ tokenX: Address; tokenY: Address; binStep: bigint; pair: Address; pid: bigint }> = [];

  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, normalizedFactory)) continue;
    if (log.topics[0]?.toLowerCase() !== LB_PAIR_CREATED_TOPIC?.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: lbFactoryAbi,
        eventName: "LBPairCreated",
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true
      });
      decodedEvents.push({
        tokenX: decoded.args.tokenX,
        tokenY: decoded.args.tokenY,
        binStep: decoded.args.binStep,
        pair: decoded.args.LBPair,
        pid: decoded.args.pid
      });
    } catch {
      throw new Error("Factory emitted malformed LBPairCreated evidence");
    }
  }

  if (decodedEvents.length !== 1) {
    throw new Error(`Expected exactly one factory LBPairCreated event, received ${decodedEvents.length}`);
  }
  const [event] = decodedEvents;
  if (
    !isAddressEqual(event.tokenX, selection.tokenX) ||
    !isAddressEqual(event.tokenY, selection.tokenY) ||
    event.binStep !== selection.binStep
  ) {
    throw new Error("LBPairCreated fields do not match the reviewed semantic pool identity");
  }
  const pair = normalizeCreationToken(event.pair, "created pair");
  assertUint256(event.pid, "LBPairCreated pid");
  return { blockNumber: receipt.blockNumber, factory: normalizedFactory, pair, pid: event.pid, selection };
}

export async function reconcileCreatedPool(
  client: PublicClient,
  input: ReconcileCreatedPoolInput
): Promise<ReconciledCreatedPool> {
  if (input.created.blockNumber < 0n) throw new Error("Created-pool reconciliation block must be nonnegative");
  const factory = normalizeCreationToken(input.created.factory, "factory");
  const pair = normalizeCreationToken(input.created.pair, "created pair");
  assertUint256(input.created.pid, "LBPairCreated pid");
  const selection = normalizePoolCreationSelection(input.created.selection);
  const expectedActiveId = normalizeActiveId(input.expectedActiveId);
  assertUint256(input.expectedPriceQ128, "expectedPriceQ128");
  if (input.expectedPriceQ128 === 0n) throw new Error("expectedPriceQ128 must be nonzero");
  const exactExpectedPrice = priceQ128FromActiveId(expectedActiveId, selection.binStep);
  if (input.expectedPriceQ128 !== exactExpectedPrice) {
    throw new Error("Reviewed price does not match the exact reviewed active ID");
  }

  const blockNumber = input.created.blockNumber;
  const [pairInformation, pairCode, liveFactory, tokenX, tokenY, binStep, activeId] = await Promise.all([
    client.readContract({
      address: factory,
      abi: lbFactoryAbi,
      functionName: "getLBPairInformation",
      args: [selection.tokenX, selection.tokenY, selection.binStep],
      blockNumber
    }),
    client.getBytecode({ address: pair, blockNumber }),
    client.readContract({ address: pair, abi: lbPairAbi, functionName: "getFactory", blockNumber }),
    client.readContract({ address: pair, abi: lbPairAbi, functionName: "getTokenX", blockNumber }),
    client.readContract({ address: pair, abi: lbPairAbi, functionName: "getTokenY", blockNumber }),
    client.readContract({ address: pair, abi: lbPairAbi, functionName: "getBinStep", blockNumber }),
    client.readContract({ address: pair, abi: lbPairAbi, functionName: "getActiveId", blockNumber })
  ]);

  const registeredPair = normalizePairInformation(pairInformation, selection.binStep);
  if (registeredPair === undefined || !isAddressEqual(registeredPair, pair)) {
    throw new Error("Live factory lookup does not match the receipt-created pair");
  }
  assertContractCode(pairCode, "created pair");
  if (!isAddressEqual(liveFactory, factory)) throw new Error("Live pair factory does not match the receipt factory");
  if (!isAddressEqual(tokenX, selection.tokenX) || !isAddressEqual(tokenY, selection.tokenY)) {
    throw new Error("Live pair token order does not match the reviewed semantic X/Y identity");
  }
  const liveBinStep = normalizeOpenBinStep(BigInt(binStep));
  if (liveBinStep !== selection.binStep) throw new Error("Live pair bin step does not match the reviewed bin step");
  const liveActiveId = normalizeActiveId(BigInt(activeId));
  if (liveActiveId !== expectedActiveId) throw new Error("Live pair active ID does not match the reviewed active ID");

  const [livePriceQ128, liveIdFromPrice] = await Promise.all([
    client.readContract({
      address: pair,
      abi: lbPairAbi,
      functionName: "getPriceFromId",
      args: [Number(liveActiveId)],
      blockNumber
    }),
    client.readContract({
      address: pair,
      abi: lbPairAbi,
      functionName: "getIdFromPrice",
      args: [input.expectedPriceQ128],
      blockNumber
    })
  ]);
  assertUint256(livePriceQ128, "live priceQ128");
  if (livePriceQ128 !== exactExpectedPrice) throw new Error("Live pair price does not match exact local PriceHelper math");
  const normalizedLiveIdFromPrice = normalizeActiveId(BigInt(liveIdFromPrice));
  assertIdTolerance(normalizedLiveIdFromPrice, liveActiveId, "Live pair price-to-ID");
  assertIdTolerance(activeIdFromPriceQ128(livePriceQ128, liveBinStep), liveActiveId, "Local price-to-ID");

  return {
    ...input.created,
    factory,
    pair,
    selection,
    activeId: liveActiveId,
    blockNumber,
    priceQ128: livePriceQ128
  };
}

function normalizePoolCreationSelection(selection: PoolCreationSelection): PoolCreationSelection {
  const tokenX = normalizeCreationToken(selection.tokenX, "tokenX");
  const tokenY = normalizeCreationToken(selection.tokenY, "tokenY");
  if (isAddressEqual(tokenX, tokenY)) throw new Error("Pool-creation tokens must be distinct");
  return { binStep: normalizeOpenBinStep(selection.binStep), tokenX, tokenY };
}

function normalizePairInformation(value: unknown, expectedBinStep: bigint): Address | undefined {
  if (typeof value !== "object" || value === null) {
    throw new Error("Factory returned malformed LB pair information");
  }
  const information = value as Record<string, unknown>;
  const rawBinStep = information.binStep;
  const rawPair = information.LBPair;
  if (
    typeof rawBinStep !== "number" ||
    !Number.isSafeInteger(rawBinStep) ||
    rawBinStep < 0 ||
    rawBinStep > Number(MAX_UINT16) ||
    typeof rawPair !== "string" ||
    !isAddress(rawPair) ||
    typeof information.createdByOwner !== "boolean" ||
    typeof information.ignoredForRouting !== "boolean"
  ) {
    throw new Error("Factory returned malformed LB pair information");
  }

  const pair = rawPair as Address;
  if (isAddressEqual(pair, zeroAddress)) {
    if (rawBinStep !== 0) throw new Error("Factory returned inconsistent empty LB pair information");
    return undefined;
  }
  if (BigInt(rawBinStep) !== expectedBinStep) {
    throw new Error("Factory returned an LB pair with the wrong bin step");
  }
  return pair;
}

function assertContractCode(code: Hex | undefined, label: string): asserts code is Hex {
  if (code === undefined || code === "0x") {
    throw new Error(`Pool-creation ${label} has no code at the pinned block`);
  }
}

function normalizeActiveId(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 24n) {
    throw new Error("Pool-creation activeId must fit uint24");
  }
  return value;
}

function assertUint256(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 256n) {
    throw new Error(`${label} must fit uint256`);
  }
}

function assertIdTolerance(actual: bigint, expected: bigint, label: string): void {
  const delta = actual > expected ? actual - expected : expected - actual;
  if (delta > MAX_PRICE_ID_ROUND_TRIP_TOLERANCE) {
    throw new Error(`${label} differs from the live active ID by more than one bin`);
  }
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
