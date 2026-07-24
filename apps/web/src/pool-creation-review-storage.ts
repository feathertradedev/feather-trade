import {
  createPoolCreationReview,
  type PoolCreationReview,
  type PoolCreationReviewInput
} from "./pool-creation";

const STORAGE_KEY = "feather.pool-creation-reviews.v1";
const STORAGE_VERSION = 1;
const MAX_REVIEWS = 20;

interface StoredReview {
  binding: EncodedReviewBinding;
  fingerprint: string;
  savedAt: number;
}

interface EncodedReviewBinding {
  environment: string;
  deploymentEpoch: string;
  chainId: number;
  walletChainId: number;
  rpcChainId: number;
  account: string;
  factory: string;
  router: string;
  tokenX: string;
  tokenY: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  binStep: string;
  activeId: string;
  requestedQuotePerBase: string;
  representableQuotePerBase: string;
  representablePriceQ128: string;
  preset: {
    baseFactor: string;
    filterPeriod: string;
    decayPeriod: string;
    reductionFactor: string;
    variableFeeControl: string;
    protocolShare: string;
    maxVolatilityAccumulator: string;
    isOpen: true;
  };
  pinnedHead: { number: string; hash: string };
  mode: string;
  transaction: { to: string; data: string; value: string };
  roundingRiskAcknowledged: true;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function persistPoolCreationReview(
  storage: StorageLike,
  review: PoolCreationReview,
  now = Date.now()
): void {
  const reviews = readEnvelope(storage)
    .filter((candidate) => candidate.fingerprint !== review.fingerprint);
  reviews.push({
    binding: encodeBinding(review.binding),
    fingerprint: review.fingerprint,
    savedAt: now
  });
  reviews.sort((left, right) => right.savedAt - left.savedAt);
  storage.setItem(STORAGE_KEY, JSON.stringify({
    reviews: reviews.slice(0, MAX_REVIEWS),
    version: STORAGE_VERSION
  }));
}

export function loadPoolCreationReview(
  storage: Pick<StorageLike, "getItem">,
  fingerprint: string
): PoolCreationReview | null {
  const candidate = readEnvelope(storage).find((review) => review.fingerprint === fingerprint);
  if (!candidate) return null;
  try {
    const review = createPoolCreationReview(decodeBinding(candidate.binding));
    return review.fingerprint === candidate.fingerprint ? review : null;
  } catch {
    return null;
  }
}

function readEnvelope(storage: Pick<StorageLike, "getItem">): StoredReview[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const envelope = asRecord(JSON.parse(raw));
    if (envelope.version !== STORAGE_VERSION || !Array.isArray(envelope.reviews)) return [];
    return envelope.reviews.flatMap((value) => {
      try {
        const row = asRecord(value);
        const fingerprint = stringValue(row.fingerprint);
        const savedAt = integerValue(row.savedAt);
        const binding = row.binding as EncodedReviewBinding;
        decodeBinding(binding);
        return [{ binding, fingerprint, savedAt }];
      } catch {
        return [];
      }
    }).sort((left, right) => right.savedAt - left.savedAt).slice(0, MAX_REVIEWS);
  } catch {
    return [];
  }
}

function encodeBinding(binding: Readonly<PoolCreationReviewInput>): EncodedReviewBinding {
  return {
    environment: binding.environment,
    deploymentEpoch: binding.deploymentEpoch,
    chainId: binding.chainId,
    walletChainId: binding.walletChainId,
    rpcChainId: binding.rpcChainId,
    account: binding.account,
    factory: binding.factory,
    router: binding.router,
    tokenX: binding.tokenX,
    tokenY: binding.tokenY,
    tokenXDecimals: binding.tokenXDecimals,
    tokenYDecimals: binding.tokenYDecimals,
    binStep: binding.binStep.toString(),
    activeId: binding.activeId.toString(),
    requestedQuotePerBase: binding.requestedQuotePerBase,
    representableQuotePerBase: binding.representableQuotePerBase,
    representablePriceQ128: binding.representablePriceQ128.toString(),
    preset: {
      baseFactor: binding.preset.baseFactor.toString(),
      filterPeriod: binding.preset.filterPeriod.toString(),
      decayPeriod: binding.preset.decayPeriod.toString(),
      reductionFactor: binding.preset.reductionFactor.toString(),
      variableFeeControl: binding.preset.variableFeeControl.toString(),
      protocolShare: binding.preset.protocolShare.toString(),
      maxVolatilityAccumulator: binding.preset.maxVolatilityAccumulator.toString(),
      isOpen: true
    },
    pinnedHead: {
      number: binding.pinnedHead.number.toString(),
      hash: binding.pinnedHead.hash
    },
    mode: binding.mode,
    transaction: {
      to: binding.transaction.to,
      data: binding.transaction.data,
      value: binding.transaction.value.toString()
    },
    roundingRiskAcknowledged: true
  };
}

function decodeBinding(value: EncodedReviewBinding): PoolCreationReviewInput {
  const row = asRecord(value);
  const preset = asRecord(row.preset);
  const pinnedHead = asRecord(row.pinnedHead);
  const transaction = asRecord(row.transaction);
  if (row.roundingRiskAcknowledged !== true || preset.isOpen !== true || transaction.value !== "0") {
    throw new Error("Stored pool-creation review is incomplete");
  }
  return {
    environment: stringValue(row.environment),
    deploymentEpoch: stringValue(row.deploymentEpoch),
    chainId: integerValue(row.chainId),
    walletChainId: integerValue(row.walletChainId),
    rpcChainId: integerValue(row.rpcChainId),
    account: stringValue(row.account) as PoolCreationReviewInput["account"],
    factory: stringValue(row.factory) as PoolCreationReviewInput["factory"],
    router: stringValue(row.router) as PoolCreationReviewInput["router"],
    tokenX: stringValue(row.tokenX) as PoolCreationReviewInput["tokenX"],
    tokenY: stringValue(row.tokenY) as PoolCreationReviewInput["tokenY"],
    tokenXDecimals: integerValue(row.tokenXDecimals),
    tokenYDecimals: integerValue(row.tokenYDecimals),
    binStep: unsignedBigInt(row.binStep),
    activeId: unsignedBigInt(row.activeId),
    requestedQuotePerBase: stringValue(row.requestedQuotePerBase),
    representableQuotePerBase: stringValue(row.representableQuotePerBase),
    representablePriceQ128: unsignedBigInt(row.representablePriceQ128),
    preset: {
      baseFactor: unsignedBigInt(preset.baseFactor),
      filterPeriod: unsignedBigInt(preset.filterPeriod),
      decayPeriod: unsignedBigInt(preset.decayPeriod),
      reductionFactor: unsignedBigInt(preset.reductionFactor),
      variableFeeControl: unsignedBigInt(preset.variableFeeControl),
      protocolShare: unsignedBigInt(preset.protocolShare),
      maxVolatilityAccumulator: unsignedBigInt(preset.maxVolatilityAccumulator),
      isOpen: true
    },
    pinnedHead: {
      number: unsignedBigInt(pinnedHead.number),
      hash: stringValue(pinnedHead.hash) as PoolCreationReviewInput["pinnedHead"]["hash"]
    },
    mode: stringValue(row.mode) as PoolCreationReviewInput["mode"],
    transaction: {
      to: stringValue(transaction.to) as PoolCreationReviewInput["transaction"]["to"],
      data: stringValue(transaction.data) as PoolCreationReviewInput["transaction"]["data"],
      value: 0n
    },
    roundingRiskAcknowledged: true
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 10_000) throw new Error("Expected a bounded string");
  return value;
}

function integerValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Expected a nonnegative integer");
  return value as number;
}

function unsignedBigInt(value: unknown): bigint {
  const parsed = stringValue(value);
  if (!/^(0|[1-9]\d*)$/.test(parsed)) throw new Error("Expected an unsigned decimal");
  return BigInt(parsed);
}
