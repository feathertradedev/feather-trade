import { decodeFunctionData, isAddress, isAddressEqual, isHex, zeroAddress, type Address, type Hex } from "viem";

import { lbRouterAbi } from "@robinhood-lb/sdk/abi";

const MAX_UINT16 = (1n << 16n) - 1n;
const MAX_UINT24 = (1n << 24n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

export type PoolCreationMode = "create-only" | "create-and-add";

export interface PoolCreationPresetReview {
  baseFactor: bigint;
  filterPeriod: bigint;
  decayPeriod: bigint;
  reductionFactor: bigint;
  variableFeeControl: bigint;
  protocolShare: bigint;
  maxVolatilityAccumulator: bigint;
  isOpen: true;
}

export interface PinnedPoolCreationHead {
  number: bigint;
  hash: Hex;
}

export interface ReviewedPoolCreationTransaction {
  to: Address;
  data: Hex;
  value: 0n;
}

export interface PoolCreationReviewInput {
  environment: string;
  deploymentEpoch: string;
  chainId: number;
  walletChainId: number;
  rpcChainId: number;
  account: Address;
  factory: Address;
  router: Address;
  tokenX: Address;
  tokenY: Address;
  tokenXDecimals: number;
  tokenYDecimals: number;
  binStep: bigint;
  activeId: bigint;
  requestedQuotePerBase: string;
  representableQuotePerBase: string;
  representablePriceQ128: bigint;
  preset: PoolCreationPresetReview;
  pinnedHead: PinnedPoolCreationHead;
  mode: PoolCreationMode;
  transaction: ReviewedPoolCreationTransaction;
  roundingRiskAcknowledged: true;
}

export interface PoolCreationReview {
  binding: Readonly<PoolCreationReviewInput>;
  fingerprint: string;
}

export interface LiveCreatedPool {
  pair: Address;
  factory: Address;
  tokenX: Address;
  tokenY: Address;
  binStep: bigint;
  activeId: bigint;
  priceQ128: bigint;
  observedHead: PinnedPoolCreationHead;
}

interface ReviewBoundState {
  review: PoolCreationReview;
}

export interface DuplicatePoolState extends ReviewBoundState {
  kind: "duplicate";
  source: "preexisting" | "race-winner";
  pool: Readonly<LiveCreatedPool>;
  freshAddReviewRequired: boolean;
  canAutoSeed: false;
}

export interface WalletRejectionState extends ReviewBoundState {
  kind: "wallet-rejection";
  retryRequiresReview: true;
}

export interface AmbiguousSubmissionState extends ReviewBoundState {
  kind: "ambiguous-submission";
  transactionHash: Hex | null;
  retryBlocked: true;
}

export interface MinedRevertState extends ReviewBoundState {
  kind: "mined-revert";
  transactionHash: Hex;
  receiptHead: PinnedPoolCreationHead;
  retryRequiresReview: true;
}

export interface CanonicalConfirmationState extends ReviewBoundState {
  kind: "canonical-confirmation";
  transactionHash: Hex;
  pool: Readonly<LiveCreatedPool>;
}

export interface ReorgState extends ReviewBoundState {
  kind: "reorg";
  orphanedPool: Readonly<LiveCreatedPool>;
  detectedHead: PinnedPoolCreationHead;
  canSeed: false;
  retryRequiresReview: true;
}

export interface IndexingLagState extends ReviewBoundState {
  kind: "indexing-lag";
  pool: Readonly<LiveCreatedPool>;
  runtimeHead: PinnedPoolCreationHead;
  indexerHead: bigint | null;
  swapEnabled: false;
  canAutoSeed: false;
}

export interface CreatedEmptyState extends ReviewBoundState {
  kind: "created-empty";
  pool: Readonly<LiveCreatedPool>;
  swapEnabled: false;
  canAutoSeed: false;
  freshAddReviewRequired: boolean;
  emptyVerified: true;
}

export interface AddRejectedState extends ReviewBoundState {
  kind: "add-rejected";
  pool: Readonly<LiveCreatedPool>;
  failedAddReviewFingerprint: string;
  poolPreserved: true;
  freshAddReviewRequired: true;
}

export interface AddRevertedState extends ReviewBoundState {
  kind: "add-reverted";
  pool: Readonly<LiveCreatedPool>;
  failedAddReviewFingerprint: string;
  poolPreserved: true;
  freshAddReviewRequired: true;
}

export interface AddAmbiguousSubmissionState extends ReviewBoundState {
  kind: "add-ambiguous-submission";
  pool: Readonly<LiveCreatedPool>;
  transactionHash: Hex | null;
  addReviewFingerprint: string;
  poolPreserved: true;
  retryBlocked: true;
}

export type PoolCreationRecoveryState =
  | DuplicatePoolState
  | WalletRejectionState
  | AmbiguousSubmissionState
  | MinedRevertState
  | CanonicalConfirmationState
  | ReorgState
  | IndexingLagState
  | CreatedEmptyState
  | AddRejectedState
  | AddRevertedState
  | AddAmbiguousSubmissionState;

export type PoolStateEligibleForAddReview =
  | DuplicatePoolState
  | CreatedEmptyState
  | AddRejectedState
  | AddRevertedState;

export interface FreshPoolAddReview {
  fingerprint: string;
  creationReviewFingerprint: string;
  pool: Readonly<LiveCreatedPool>;
  desiredActiveId: bigint;
  representablePriceQ128: bigint;
  reviewedHead: PinnedPoolCreationHead;
  reusedCreationDesiredId: false;
}

export function createPoolCreationReview(input: PoolCreationReviewInput): PoolCreationReview {
  const binding = freezeReviewBinding(input);
  return Object.freeze({ binding, fingerprint: poolCreationReviewFingerprint(binding) });
}

export function poolCreationReviewFingerprint(input: PoolCreationReviewInput): string {
  const normalized = normalizeReviewBinding(input);
  return JSON.stringify([
    "feather-pool-create-review-v1",
    normalized.environment,
    normalized.deploymentEpoch,
    normalized.chainId,
    normalized.walletChainId,
    normalized.rpcChainId,
    normalized.account.toLowerCase(),
    normalized.factory.toLowerCase(),
    normalized.router.toLowerCase(),
    normalized.tokenX.toLowerCase(),
    normalized.tokenY.toLowerCase(),
    normalized.tokenXDecimals,
    normalized.tokenYDecimals,
    normalized.binStep.toString(),
    normalized.activeId.toString(),
    normalized.requestedQuotePerBase,
    normalized.representableQuotePerBase,
    normalized.representablePriceQ128.toString(),
    presetFingerprintFields(normalized.preset),
    normalized.pinnedHead.number.toString(),
    normalized.pinnedHead.hash.toLowerCase(),
    normalized.mode,
    normalized.transaction.to.toLowerCase(),
    normalized.transaction.data.toLowerCase(),
    normalized.transaction.value.toString(),
    normalized.roundingRiskAcknowledged
  ]);
}

export function poolCreationReviewIsCurrent(
  review: PoolCreationReview,
  current: PoolCreationReviewInput
): boolean {
  try {
    return review.fingerprint === poolCreationReviewFingerprint(current);
  } catch {
    return false;
  }
}

export function recordDuplicatePool(
  review: PoolCreationReview,
  pool: LiveCreatedPool,
  source: DuplicatePoolState["source"]
): DuplicatePoolState {
  return Object.freeze({
    kind: "duplicate",
    source,
    review,
    pool: normalizeLivePool(review, pool, false, true),
    freshAddReviewRequired: review.binding.mode === "create-and-add",
    canAutoSeed: false
  });
}

export function recordCreateWalletRejection(review: PoolCreationReview): WalletRejectionState {
  return Object.freeze({ kind: "wallet-rejection", review, retryRequiresReview: true });
}

export function recordAmbiguousCreateSubmission(
  review: PoolCreationReview,
  transactionHash: Hex | null
): AmbiguousSubmissionState {
  if (transactionHash !== null) assertTransactionHash(transactionHash);
  return Object.freeze({ kind: "ambiguous-submission", review, transactionHash, retryBlocked: true });
}

export function recordCreateMinedRevert(
  review: PoolCreationReview,
  transactionHash: Hex,
  receiptHead: PinnedPoolCreationHead
): MinedRevertState {
  assertTransactionHash(transactionHash);
  const head = freezeHead(receiptHead, "receipt");
  if (head.number < review.binding.pinnedHead.number) {
    throw new Error("Mined-revert receipt predates the reviewed pinned head");
  }
  return Object.freeze({
    kind: "mined-revert",
    review,
    transactionHash,
    receiptHead: head,
    retryRequiresReview: true
  });
}

export function recordCanonicalPoolConfirmation(
  review: PoolCreationReview,
  transactionHash: Hex,
  pool: LiveCreatedPool
): CanonicalConfirmationState {
  assertTransactionHash(transactionHash);
  const normalizedPool = normalizeLivePool(review, pool, true);
  if (normalizedPool.observedHead.number < review.binding.pinnedHead.number) {
    throw new Error("Canonical pool confirmation predates the reviewed pinned head");
  }
  return Object.freeze({ kind: "canonical-confirmation", review, transactionHash, pool: normalizedPool });
}

export function recordPoolCreationReorg(
  state:
    | CanonicalConfirmationState
    | IndexingLagState
    | CreatedEmptyState
    | AddRejectedState
    | AddRevertedState
    | AddAmbiguousSubmissionState,
  detectedHead: PinnedPoolCreationHead
): ReorgState {
  const head = freezeHead(detectedHead, "reorg detection");
  if (head.number < state.pool.observedHead.number) {
    throw new Error("Reorg detection head predates the observed created pool");
  }
  return Object.freeze({
    kind: "reorg",
    review: state.review,
    orphanedPool: state.pool,
    detectedHead: head,
    canSeed: false,
    retryRequiresReview: true
  });
}

export function recordPoolIndexingLag(
  confirmation: CanonicalConfirmationState,
  runtimeHead: PinnedPoolCreationHead,
  indexerHead: bigint | null
): IndexingLagState {
  const head = freezeHead(runtimeHead, "runtime");
  if (head.number < confirmation.pool.observedHead.number) {
    throw new Error("Runtime head predates the confirmed created pool");
  }
  if (
    indexerHead !== null &&
    (indexerHead < 0n || indexerHead > head.number || indexerHead >= confirmation.pool.observedHead.number)
  ) {
    throw new Error("Indexer lag requires a nonnegative head behind the created-pool observation and no newer than runtime");
  }
  return Object.freeze({
    kind: "indexing-lag",
    review: confirmation.review,
    pool: confirmation.pool,
    runtimeHead: head,
    indexerHead,
    swapEnabled: false,
    canAutoSeed: false
  });
}

export function recordCreatedPoolEmpty(
  confirmation: CanonicalConfirmationState,
  livePool: LiveCreatedPool,
  emptyVerified: true
): CreatedEmptyState {
  if (emptyVerified !== true) throw new Error("Created-empty state requires explicit live empty-pool evidence");
  const pool = normalizeLivePool(confirmation.review, livePool, true);
  assertSameLivePool(confirmation.pool, pool, "Created-empty verification");
  assertObservationNotOlder(confirmation.pool, pool, "Created-empty verification");
  return Object.freeze({
    kind: "created-empty",
    review: confirmation.review,
    pool,
    swapEnabled: false,
    canAutoSeed: false,
    freshAddReviewRequired: confirmation.review.binding.mode === "create-and-add",
    emptyVerified: true
  });
}

export function prepareFreshPoolAddReview(
  state: PoolStateEligibleForAddReview,
  livePool: LiveCreatedPool,
  addReviewFingerprint: string
): FreshPoolAddReview {
  if (addReviewFingerprint.trim().length === 0) throw new Error("Fresh add review fingerprint is required");
  const pool = normalizeLivePool(state.review, livePool, false);
  assertSamePoolContract(state.pool, pool, "Fresh add review");
  assertObservationNotOlder(state.pool, pool, "Fresh add review");
  if (pool.observedHead.number === state.pool.observedHead.number) {
    assertSameLivePool(state.pool, pool, "Fresh add review at the same pinned head");
  }
  return Object.freeze({
    fingerprint: addReviewFingerprint,
    creationReviewFingerprint: state.review.fingerprint,
    pool,
    desiredActiveId: pool.activeId,
    representablePriceQ128: pool.priceQ128,
    reviewedHead: pool.observedHead,
    reusedCreationDesiredId: false
  });
}

export function recordPoolAddFailure(
  state: PoolStateEligibleForAddReview,
  addReview: FreshPoolAddReview,
  failure: "wallet-rejected" | "mined-revert"
): AddRejectedState | AddRevertedState {
  const pool = assertFreshPoolAddReview(state, addReview, "Failed add review");
  const shared = {
    review: state.review,
    pool,
    failedAddReviewFingerprint: addReview.fingerprint,
    poolPreserved: true as const,
    freshAddReviewRequired: true as const
  };
  return failure === "wallet-rejected"
    ? Object.freeze({ kind: "add-rejected", ...shared })
    : Object.freeze({ kind: "add-reverted", ...shared });
}

export function recordAmbiguousPoolAddSubmission(
  state: PoolStateEligibleForAddReview,
  addReview: FreshPoolAddReview,
  transactionHash: Hex | null
): AddAmbiguousSubmissionState {
  const pool = assertFreshPoolAddReview(state, addReview, "Ambiguous add review");
  if (transactionHash !== null) assertTransactionHash(transactionHash);
  return Object.freeze({
    kind: "add-ambiguous-submission",
    review: state.review,
    pool,
    transactionHash,
    addReviewFingerprint: addReview.fingerprint,
    poolPreserved: true,
    retryBlocked: true
  });
}

function freezeReviewBinding(input: PoolCreationReviewInput): Readonly<PoolCreationReviewInput> {
  const normalized = normalizeReviewBinding(input);
  return Object.freeze({
    ...normalized,
    preset: Object.freeze({ ...normalized.preset }),
    pinnedHead: Object.freeze({ ...normalized.pinnedHead }),
    transaction: Object.freeze({ ...normalized.transaction })
  });
}

function normalizeReviewBinding(input: PoolCreationReviewInput): PoolCreationReviewInput {
  if (input.environment.trim().length === 0) throw new Error("Pool-creation environment is required");
  if (input.deploymentEpoch.trim().length === 0) throw new Error("Pool-creation deployment epoch is required");
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("Pool-creation chainId must be positive");
  if (input.walletChainId !== input.chainId || input.rpcChainId !== input.chainId) {
    throw new Error("Pool-creation wallet and RPC chains must match the reviewed registry chain");
  }
  const account = normalizeAddress(input.account, "account");
  const factory = normalizeAddress(input.factory, "factory");
  const router = normalizeAddress(input.router, "router");
  const tokenX = normalizeAddress(input.tokenX, "tokenX");
  const tokenY = normalizeAddress(input.tokenY, "tokenY");
  if (isAddressEqual(tokenX, tokenY)) throw new Error("Pool-creation semantic tokens must be distinct");
  assertTokenDecimals(input.tokenXDecimals, "tokenXDecimals");
  assertTokenDecimals(input.tokenYDecimals, "tokenYDecimals");
  assertUint(input.binStep, MAX_UINT16, "binStep", false);
  assertUint(input.activeId, MAX_UINT24, "activeId", true);
  assertPositiveDecimal(input.requestedQuotePerBase, "requested quote-per-base price");
  assertPositiveDecimal(input.representableQuotePerBase, "representable quote-per-base price");
  assertUint(input.representablePriceQ128, MAX_UINT256, "representablePriceQ128", false);
  const preset = normalizePreset(input.preset);
  const pinnedHead = freezeHead(input.pinnedHead, "review");
  if (input.mode !== "create-only" && input.mode !== "create-and-add") {
    throw new Error("Pool-creation mode is unsupported");
  }
  const transactionTo = normalizeAddress(input.transaction.to, "pool-creation transaction target");
  if (!isAddressEqual(transactionTo, router)) throw new Error("Pool-creation transaction target must be the reviewed router");
  if (!isHex(input.transaction.data) || input.transaction.data.length < 10) {
    throw new Error("Pool-creation transaction calldata must include a function selector");
  }
  if (input.transaction.value !== 0n) throw new Error("Pool-creation transaction value must be zero");
  try {
    const decoded = decodeFunctionData({ abi: lbRouterAbi, data: input.transaction.data });
    if (decoded.functionName !== "createLBPair") {
      throw new Error("wrong function");
    }
    const [transactionTokenX, transactionTokenY, transactionActiveId, transactionBinStep] = decoded.args;
    if (
      !isAddressEqual(transactionTokenX, tokenX) ||
      !isAddressEqual(transactionTokenY, tokenY) ||
      BigInt(transactionActiveId) !== input.activeId ||
      BigInt(transactionBinStep) !== input.binStep
    ) {
      throw new Error("wrong arguments");
    }
  } catch {
    throw new Error("Pool-creation transaction calldata does not match the reviewed semantic pool creation");
  }
  if (input.roundingRiskAcknowledged !== true) {
    throw new Error("Pool-creation rounding and arbitrage risk must be acknowledged");
  }
  return {
    ...input,
    environment: input.environment.trim(),
    deploymentEpoch: input.deploymentEpoch.trim(),
    account,
    factory,
    router,
    tokenX,
    tokenY,
    preset,
    pinnedHead,
    transaction: { to: transactionTo, data: input.transaction.data, value: 0n }
  };
}

function normalizePreset(preset: PoolCreationPresetReview): PoolCreationPresetReview {
  for (const [label, value] of Object.entries(preset)) {
    if (label === "isOpen") continue;
    assertUint(value, MAX_UINT256, `preset ${label}`, true);
  }
  if (preset.isOpen !== true) throw new Error("Reviewed pool-creation preset must be open");
  return { ...preset };
}

function presetFingerprintFields(preset: PoolCreationPresetReview): string[] {
  return [
    preset.baseFactor,
    preset.filterPeriod,
    preset.decayPeriod,
    preset.reductionFactor,
    preset.variableFeeControl,
    preset.protocolShare,
    preset.maxVolatilityAccumulator
  ].map((value) => value.toString());
}

function normalizeLivePool(
  review: PoolCreationReview,
  input: LiveCreatedPool,
  requireReviewedPrice: boolean,
  acceptNormalizedTokenPair = false
): Readonly<LiveCreatedPool> {
  const pair = normalizeAddress(input.pair, "live pair");
  const factory = normalizeAddress(input.factory, "live factory");
  const tokenX = normalizeAddress(input.tokenX, "live tokenX");
  const tokenY = normalizeAddress(input.tokenY, "live tokenY");
  if (!isAddressEqual(factory, review.binding.factory)) throw new Error("Live pool factory differs from the reviewed factory");
  const exactOrientation = isAddressEqual(tokenX, review.binding.tokenX) && isAddressEqual(tokenY, review.binding.tokenY);
  const reverseOrientation = isAddressEqual(tokenX, review.binding.tokenY) && isAddressEqual(tokenY, review.binding.tokenX);
  if (!exactOrientation && !(acceptNormalizedTokenPair && reverseOrientation)) {
    throw new Error("Live pool semantic X/Y differs from the reviewed token order");
  }
  if (input.binStep !== review.binding.binStep) throw new Error("Live pool bin step differs from the reviewed preset");
  assertUint(input.activeId, MAX_UINT24, "live activeId", true);
  assertUint(input.priceQ128, MAX_UINT256, "live priceQ128", false);
  if (
    requireReviewedPrice &&
    (input.activeId !== review.binding.activeId || input.priceQ128 !== review.binding.representablePriceQ128)
  ) {
    throw new Error("Canonical created pool price differs from the reviewed active ID and representable price");
  }
  const observedHead = freezeHead(input.observedHead, "live pool");
  if (observedHead.number < review.binding.pinnedHead.number) {
    throw new Error("Live pool observation predates the reviewed pinned head");
  }
  return Object.freeze({
    pair,
    factory,
    tokenX,
    tokenY,
    binStep: input.binStep,
    activeId: input.activeId,
    priceQ128: input.priceQ128,
    observedHead
  });
}

function assertSamePoolContract(left: LiveCreatedPool, right: LiveCreatedPool, label: string): void {
  if (
    !isAddressEqual(left.pair, right.pair) ||
    !isAddressEqual(left.factory, right.factory) ||
    !isAddressEqual(left.tokenX, right.tokenX) ||
    !isAddressEqual(left.tokenY, right.tokenY) ||
    left.binStep !== right.binStep
  ) {
    throw new Error(`${label} does not match the preserved created pool identity`);
  }
}

function assertSameLivePool(left: LiveCreatedPool, right: LiveCreatedPool, label: string): void {
  assertSamePoolContract(left, right, label);
  if (left.activeId !== right.activeId || left.priceQ128 !== right.priceQ128) {
    throw new Error(`${label} does not match the freshly reviewed live active ID and price`);
  }
}

function assertObservationNotOlder(previous: LiveCreatedPool, current: LiveCreatedPool, label: string): void {
  if (current.observedHead.number < previous.observedHead.number) {
    throw new Error(`${label} cannot use an older live pool head`);
  }
  if (
    current.observedHead.number === previous.observedHead.number &&
    current.observedHead.hash !== previous.observedHead.hash
  ) {
    throw new Error(`${label} detected a conflicting hash at the preserved pool head`);
  }
}

function assertFreshPoolAddReview(
  state: PoolStateEligibleForAddReview,
  addReview: FreshPoolAddReview,
  label: string
): Readonly<LiveCreatedPool> {
  if (typeof addReview.fingerprint !== "string" || addReview.fingerprint.trim().length === 0) {
    throw new Error(`${label} requires a nonempty add-review fingerprint`);
  }
  const pool = normalizeLivePool(state.review, addReview.pool, false);
  assertSamePoolContract(state.pool, pool, label);
  assertObservationNotOlder(state.pool, pool, label);
  const reviewedHead = freezeHead(addReview.reviewedHead, `${label} reviewed`);
  if (
    addReview.creationReviewFingerprint !== state.review.fingerprint ||
    reviewedHead.number !== pool.observedHead.number ||
    reviewedHead.hash !== pool.observedHead.hash ||
    addReview.desiredActiveId !== pool.activeId ||
    addReview.representablePriceQ128 !== pool.priceQ128 ||
    addReview.reusedCreationDesiredId !== false
  ) {
    throw new Error(`${label} does not match the exact freshly reviewed live pool state`);
  }
  return pool;
}

function freezeHead(head: PinnedPoolCreationHead, label: string): PinnedPoolCreationHead {
  if (typeof head.number !== "bigint" || head.number < 0n) throw new Error(`${label} head must be nonnegative`);
  if (!isHex(head.hash) || head.hash.length !== 66) throw new Error(`${label} head hash must be bytes32`);
  return Object.freeze({ number: head.number, hash: head.hash.toLowerCase() as Hex });
}

function normalizeAddress(value: Address, label: string): Address {
  if (!isAddress(value) || isAddressEqual(value, zeroAddress)) throw new Error(`${label} must be a nonzero address`);
  return value;
}

function assertPositiveDecimal(value: string, label: string): void {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || /^0(?:\.0+)?$/.test(value)) {
    throw new Error(`${label} must be a canonical positive decimal string`);
  }
}

function assertTokenDecimals(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 36) {
    throw new Error(`${label} must be an integer from 0 to 36`);
  }
}

function assertUint(value: unknown, maximum: bigint, label: string, allowZero: boolean): asserts value is bigint {
  if (typeof value !== "bigint" || value < (allowZero ? 0n : 1n) || value > maximum) {
    throw new Error(`${label} must fit the reviewed integer domain`);
  }
}

function assertTransactionHash(value: Hex): void {
  if (!isHex(value) || value.length !== 66) throw new Error("Pool-creation transaction hash must be bytes32");
}
