export const FULL_EXIT_BATCH_SETTINGS_VERSION = 1 as const;
export const FULL_EXIT_STATE_VERSION = 1 as const;
export const FULL_EXIT_WORKFLOW_VERSION = 1 as const;
export const DEFAULT_FULL_EXIT_GAS_BUFFER_BPS = 12_500n;
export const DEFAULT_FULL_EXIT_MAX_BLOCK_GAS_BPS = 8_000n;
export const FULL_EXIT_BPS_DENOMINATOR = 10_000n;
export const FULL_EXIT_UINT24_MAX = 16_777_215n;

const WORKFLOW_TAG = "feather-full-exit-workflow";
const STATE_TAG = "feather-full-exit-state";
const SETTINGS_TAG = "feather-full-exit-batch";

export type FullExitIntegerInput = bigint | number | string;

export interface FullExitWorkflowIdentityInput {
  account: string;
  chainId: number;
  deploymentEpoch: string;
  environment: string;
  pair: string;
  recipient: string;
  router: string;
}

export interface FullExitWorkflowIdentity {
  account: `0x${string}`;
  chainId: number;
  deploymentEpoch: string;
  environment: string;
  pair: `0x${string}`;
  recipient: `0x${string}`;
  router: `0x${string}`;
  version: typeof FULL_EXIT_WORKFLOW_VERSION;
}

export interface FullExitLiveBinInput {
  binId: FullExitIntegerInput;
  liveBalance: FullExitIntegerInput;
}

export interface FullExitLiveBin {
  binId: bigint;
  liveBalance: bigint;
}

export interface FullExitStateSnapshotInput {
  bins: readonly FullExitLiveBinInput[];
  blockHash: string;
  blockNumber: FullExitIntegerInput;
  observedHeadBlockNumber?: FullExitIntegerInput;
  workflowKey: string;
}

export interface FullExitStateSnapshot {
  bins: FullExitLiveBin[];
  blockHash: `0x${string}`;
  blockNumber: bigint;
  observedHeadBlockNumber: bigint;
  workflowKey: string;
  version: typeof FULL_EXIT_STATE_VERSION;
}

export interface FullExitBatchSettingsInput {
  batchOrdinal: number;
  bins: readonly FullExitLiveBinInput[];
  stateFingerprint: string;
  workflowKey: string;
}

export interface FullExitBatchSettings {
  batchOrdinal: number;
  bins: FullExitLiveBin[];
  stateFingerprint: string;
  version: typeof FULL_EXIT_BATCH_SETTINGS_VERSION;
  workflowKey: string;
}

export type FullExitCandidateProbeResult =
  | { calldataBytes: number; estimatedGas: bigint; status: "success" }
  | { diagnostic: string; status: "capacity" }
  | { diagnostic: string; status: "semantic-failure" }
  | { diagnostic: string; status: "unavailable" };

export interface FullExitCandidateProbeInput {
  bins: readonly FullExitLiveBin[];
  stateFingerprint: string | null;
}

export interface FullExitBatchPlanningLimits {
  blockGasLimit: bigint;
  gasEstimateBufferBps?: bigint;
  maxBlockGasBps?: bigint;
  maxCalldataBytes: number;
  maxCandidateBins: number;
  maxProbeCount: number;
}

export interface FullExitPlannedBatch {
  bins: FullExitLiveBin[];
  bufferedGas: bigint;
  calldataBytes: number;
  estimatedGas: bigint;
}

export interface FullExitBatchPlan {
  batches: FullExitPlannedBatch[];
  limits: Required<FullExitBatchPlanningLimits>;
  positiveBinCount: number;
  probeCount: number;
}

export interface PlanFullExitBatchesInput {
  bins: readonly FullExitLiveBinInput[];
  limits: FullExitBatchPlanningLimits;
  probe: (candidate: FullExitCandidateProbeInput) => Promise<FullExitCandidateProbeResult>;
  stateFingerprint?: string | null;
}

export type FullExitBatchPlanningErrorCode =
  | "invalid-input"
  | "probe-exhausted"
  | "probe-unavailable"
  | "semantic-failure"
  | "single-bin-unsafe";

export class FullExitBatchPlanningError extends Error {
  readonly binIds: bigint[];
  readonly code: FullExitBatchPlanningErrorCode;
  readonly probeCount: number;

  constructor(code: FullExitBatchPlanningErrorCode, message: string, binIds: readonly bigint[] = [], probeCount = 0) {
    super(message);
    this.name = "FullExitBatchPlanningError";
    this.binIds = [...binIds];
    this.code = code;
    this.probeCount = probeCount;
  }
}

export type FullExitJournalStatus =
  | "awaiting-wallet"
  | "aborted"
  | "reconciling"
  | "unknown-submission"
  | "rejected"
  | "submitted"
  | "confirming"
  | "canonical"
  | "reverted"
  | "replaced"
  | "orphaned"
  | "timed-out";

export interface FullExitJournalRecordState {
  confirmations: number;
  receiptStatus: "success" | "reverted" | null;
  replacementCompatibility: "matching" | "incompatible" | null;
  replacementFinalized: boolean;
  status: FullExitJournalStatus;
}

export type FullExitJournalDispositionKind =
  | "blocking"
  | "finalized-success"
  | "finalized-failure"
  | "retry";

export interface FullExitJournalDisposition {
  blocksNextBatch: boolean;
  countsCompletedBatch: boolean;
  finalityReached: boolean;
  kind: FullExitJournalDispositionKind;
  shouldReplan: boolean;
}

export function createFullExitWorkflowKey(input: FullExitWorkflowIdentityInput): string {
  const identity = normalizeWorkflowIdentity(input);
  return JSON.stringify([
    WORKFLOW_TAG,
    FULL_EXIT_WORKFLOW_VERSION,
    identity.account,
    identity.chainId,
    identity.environment,
    identity.deploymentEpoch,
    identity.pair,
    identity.router,
    identity.recipient
  ]);
}

export function parseFullExitWorkflowKey(value: string): FullExitWorkflowIdentity {
  const parsed = parseJson(value, "workflow key");
  if (!Array.isArray(parsed) || parsed.length !== 9 || parsed[0] !== WORKFLOW_TAG || parsed[1] !== FULL_EXIT_WORKFLOW_VERSION) {
    throw new Error("Full-exit workflow key has an unsupported format or version");
  }
  const identity = normalizeWorkflowIdentity({
    account: parsed[2],
    chainId: parsed[3],
    environment: parsed[4],
    deploymentEpoch: parsed[5],
    pair: parsed[6],
    router: parsed[7],
    recipient: parsed[8]
  });
  if (createFullExitWorkflowKey(identity) !== value) throw new Error("Full-exit workflow key is not canonical");
  return identity;
}

export function createFullExitStateSnapshot(input: FullExitStateSnapshotInput): FullExitStateSnapshot {
  parseFullExitWorkflowKey(input.workflowKey);
  const blockNumber = parseNonNegativeInteger(input.blockNumber, "state block number");
  const observedHeadBlockNumber = input.observedHeadBlockNumber === undefined
    ? blockNumber
    : parseNonNegativeInteger(input.observedHeadBlockNumber, "observed head block number");
  if (observedHeadBlockNumber < blockNumber) throw new Error("Observed head cannot precede the pinned full-exit state block");
  return {
    bins: normalizeLiveBins(input.bins, true),
    blockHash: normalizeHash(input.blockHash, "state block hash"),
    blockNumber,
    observedHeadBlockNumber,
    workflowKey: input.workflowKey,
    version: FULL_EXIT_STATE_VERSION
  };
}

export function fullExitStateFingerprint(snapshot: FullExitStateSnapshotInput | FullExitStateSnapshot): string {
  const normalized = createFullExitStateSnapshot(snapshot);
  return JSON.stringify([
    STATE_TAG,
    FULL_EXIT_STATE_VERSION,
    normalized.workflowKey,
    normalized.blockNumber.toString(),
    normalized.blockHash,
    encodeBins(normalized.bins)
  ]);
}

export function parseFullExitStateFingerprint(value: string): FullExitStateSnapshot {
  const parsed = parseJson(value, "state fingerprint");
  if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== STATE_TAG || parsed[1] !== FULL_EXIT_STATE_VERSION) {
    throw new Error("Full-exit state fingerprint has an unsupported format or version");
  }
  if (typeof parsed[2] !== "string" || typeof parsed[3] !== "string" || !Array.isArray(parsed[5])) {
    throw new Error("Full-exit state fingerprint is malformed");
  }
  const snapshot = createFullExitStateSnapshot({
    workflowKey: parsed[2],
    blockNumber: parsed[3],
    blockHash: parsed[4],
    bins: decodeCanonicalBins(parsed[5], "state fingerprint"),
    observedHeadBlockNumber: parsed[3]
  });
  if (fullExitStateFingerprint(snapshot) !== value) throw new Error("Full-exit state fingerprint is not canonical");
  return snapshot;
}

export function fullExitPinnedStateMatches(
  left: FullExitStateSnapshotInput | FullExitStateSnapshot,
  right: FullExitStateSnapshotInput | FullExitStateSnapshot
): boolean {
  return fullExitStateFingerprint(left) === fullExitStateFingerprint(right);
}

export function encodeFullExitBatchSettings(input: FullExitBatchSettingsInput): string {
  const workflow = parseFullExitWorkflowKey(input.workflowKey);
  const state = parseFullExitStateFingerprint(input.stateFingerprint);
  if (state.workflowKey !== input.workflowKey) throw new Error("Full-exit batch workflow does not match its pinned state");
  const batchOrdinal = parseSafeInteger(input.batchOrdinal, "batch ordinal", 1);
  const bins = normalizeLiveBins(input.bins, false);
  if (bins.length === 0) throw new Error("Full-exit batch must contain at least one positive bin");
  const stateBalances = new Map(state.bins.map((bin) => [bin.binId.toString(), bin.liveBalance]));
  for (const bin of bins) {
    if (stateBalances.get(bin.binId.toString()) !== bin.liveBalance) {
      throw new Error(`Full-exit batch bin ${bin.binId.toString()} does not match the exact pinned live balance`);
    }
  }
  void workflow;
  return JSON.stringify([
    SETTINGS_TAG,
    FULL_EXIT_BATCH_SETTINGS_VERSION,
    input.workflowKey,
    input.stateFingerprint,
    batchOrdinal,
    encodeBins(bins)
  ]);
}

export function parseFullExitBatchSettings(value: string): FullExitBatchSettings {
  const parsed = parseJson(value, "batch settings");
  if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== SETTINGS_TAG || parsed[1] !== FULL_EXIT_BATCH_SETTINGS_VERSION) {
    throw new Error("Full-exit batch settings have an unsupported format or version");
  }
  if (typeof parsed[2] !== "string" || typeof parsed[3] !== "string" || !Array.isArray(parsed[5])) {
    throw new Error("Full-exit batch settings are malformed");
  }
  const bins = decodeCanonicalBins(parsed[5], "batch settings");
  const normalized: FullExitBatchSettings = {
    batchOrdinal: parseSafeInteger(parsed[4], "batch ordinal", 1),
    bins,
    stateFingerprint: parsed[3],
    version: FULL_EXIT_BATCH_SETTINGS_VERSION,
    workflowKey: parsed[2]
  };
  if (encodeFullExitBatchSettings(normalized) !== value) throw new Error("Full-exit batch settings are not canonical");
  return normalized;
}

export async function planFullExitBatches(input: PlanFullExitBatchesInput): Promise<FullExitBatchPlan> {
  const bins = normalizeLiveBins(input.bins, true);
  const limits = normalizeLimits(input.limits);
  if (input.stateFingerprint !== undefined && input.stateFingerprint !== null) {
    const state = parseFullExitStateFingerprint(input.stateFingerprint);
    if (!sameBins(state.bins, bins)) throw new FullExitBatchPlanningError("invalid-input", "Planner bins do not match the pinned state fingerprint");
  }
  let probeCount = 0;
  const batches: FullExitPlannedBatch[] = [];
  const gasCap = (limits.blockGasLimit * limits.maxBlockGasBps) / FULL_EXIT_BPS_DENOMINATOR;

  const probeRange = async (candidate: readonly FullExitLiveBin[]): Promise<void> => {
    if (candidate.length === 0) return;
    if (probeCount >= limits.maxProbeCount) {
      throw new FullExitBatchPlanningError("probe-exhausted", `Full-exit probe budget ${limits.maxProbeCount} was exhausted`, candidate.map((bin) => bin.binId), probeCount);
    }
    probeCount += 1;
    let result: FullExitCandidateProbeResult;
    try {
      result = await input.probe({ bins: candidate.map(copyBin), stateFingerprint: input.stateFingerprint ?? null });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown probe error";
      throw new FullExitBatchPlanningError("probe-unavailable", `Exact full-exit candidate probe failed: ${detail}`, candidate.map((bin) => bin.binId), probeCount);
    }
    if (result.status === "semantic-failure") {
      throw new FullExitBatchPlanningError("semantic-failure", `Full-exit candidate has a semantic failure and cannot be shrunk or skipped: ${result.diagnostic}`, candidate.map((bin) => bin.binId), probeCount);
    }
    if (result.status === "unavailable") {
      throw new FullExitBatchPlanningError("probe-unavailable", `Exact full-exit candidate probe is unavailable: ${result.diagnostic}`, candidate.map((bin) => bin.binId), probeCount);
    }

    let capacityDiagnostic = result.status === "capacity" ? result.diagnostic : null;
    let safeResult: Extract<FullExitCandidateProbeResult, { status: "success" }> | null = null;
    let bufferedGas = 0n;
    if (result.status === "success") {
      if (result.estimatedGas <= 0n || !Number.isSafeInteger(result.calldataBytes) || result.calldataBytes <= 0) {
        throw new FullExitBatchPlanningError("probe-unavailable", "Exact full-exit candidate probe returned malformed gas or calldata evidence", candidate.map((bin) => bin.binId), probeCount);
      }
      bufferedGas = ceilDiv(result.estimatedGas * limits.gasEstimateBufferBps, FULL_EXIT_BPS_DENOMINATOR);
      if (result.calldataBytes > limits.maxCalldataBytes) {
        capacityDiagnostic = `calldata ${result.calldataBytes} bytes exceeds cap ${limits.maxCalldataBytes}`;
      } else if (bufferedGas > gasCap) {
        capacityDiagnostic = `buffered gas ${bufferedGas.toString()} exceeds cap ${gasCap.toString()}`;
      } else {
        safeResult = result;
      }
    }

    if (safeResult !== null) {
      batches.push({
        bins: candidate.map(copyBin),
        bufferedGas,
        calldataBytes: safeResult.calldataBytes,
        estimatedGas: safeResult.estimatedGas
      });
      return;
    }
    if (candidate.length === 1) {
      const binId = candidate[0].binId;
      throw new FullExitBatchPlanningError("single-bin-unsafe", `Full-exit bin ${binId.toString()} cannot fit a safe transaction: ${capacityDiagnostic ?? "unknown capacity failure"}`, [binId], probeCount);
    }
    const midpoint = Math.ceil(candidate.length / 2);
    await probeRange(candidate.slice(0, midpoint));
    await probeRange(candidate.slice(midpoint));
  };

  for (let offset = 0; offset < bins.length; offset += limits.maxCandidateBins) {
    await probeRange(bins.slice(offset, offset + limits.maxCandidateBins));
  }

  return { batches, limits, positiveBinCount: bins.length, probeCount };
}

export function classifyFullExitJournalRecord(
  record: FullExitJournalRecordState,
  requiredFinalityConfirmations = 12
): FullExitJournalDisposition {
  const confirmations = parseSafeInteger(record.confirmations, "journal confirmations", 0);
  const finality = parseSafeInteger(requiredFinalityConfirmations, "required finality confirmations", 1);
  if (record.status === "rejected" || record.status === "aborted") {
    return { blocksNextBatch: false, countsCompletedBatch: false, finalityReached: true, kind: "retry", shouldReplan: true };
  }
  if (record.status === "canonical") {
    if (record.receiptStatus !== "success") throw new Error("Canonical full-exit journal state requires a successful receipt");
    if (confirmations >= finality) {
      return { blocksNextBatch: false, countsCompletedBatch: true, finalityReached: true, kind: "finalized-success", shouldReplan: true };
    }
    return blockingDisposition();
  }
  if (record.status === "reverted") {
    if (record.receiptStatus !== "reverted") throw new Error("Reverted full-exit journal state requires a reverted receipt");
    if (confirmations >= finality) {
      return { blocksNextBatch: false, countsCompletedBatch: false, finalityReached: true, kind: "finalized-failure", shouldReplan: true };
    }
    return blockingDisposition();
  }
  if (record.status === "replaced" && record.replacementCompatibility === "incompatible") {
    if (record.replacementFinalized && confirmations >= finality) {
      return { blocksNextBatch: false, countsCompletedBatch: false, finalityReached: true, kind: "finalized-failure", shouldReplan: true };
    }
    return blockingDisposition();
  }
  return blockingDisposition();
}

function blockingDisposition(): FullExitJournalDisposition {
  return { blocksNextBatch: true, countsCompletedBatch: false, finalityReached: false, kind: "blocking", shouldReplan: false };
}

function normalizeWorkflowIdentity(input: FullExitWorkflowIdentityInput): FullExitWorkflowIdentity {
  const account = normalizeAddress(input.account, "workflow account");
  const recipient = normalizeAddress(input.recipient, "workflow recipient");
  if (recipient !== account) throw new Error("Full-exit workflow recipient must equal the owner account");
  return {
    account,
    chainId: parseSafeInteger(input.chainId, "workflow chain id", 1),
    deploymentEpoch: normalizeText(input.deploymentEpoch, "workflow deployment epoch"),
    environment: normalizeText(input.environment, "workflow environment"),
    pair: normalizeAddress(input.pair, "workflow pair"),
    recipient,
    router: normalizeAddress(input.router, "workflow router"),
    version: FULL_EXIT_WORKFLOW_VERSION
  };
}

function normalizeLiveBins(input: readonly FullExitLiveBinInput[], allowZero: boolean): FullExitLiveBin[] {
  if (!Array.isArray(input)) throw new Error("Full-exit bins must be an array");
  const seen = new Set<string>();
  const bins: FullExitLiveBin[] = [];
  for (const item of input) {
    if (item === null || typeof item !== "object") throw new Error("Full-exit bin entry is malformed");
    const binId = parseNonNegativeInteger(item.binId, "bin id");
    if (binId > FULL_EXIT_UINT24_MAX) throw new Error(`Full-exit bin id ${binId.toString()} exceeds uint24`);
    const key = binId.toString();
    if (seen.has(key)) throw new Error(`Duplicate full-exit bin id ${key}`);
    seen.add(key);
    const liveBalance = parseNonNegativeInteger(item.liveBalance, `live balance for bin ${key}`);
    if (liveBalance === 0n) {
      if (allowZero) continue;
      throw new Error(`Full-exit batch bin ${key} must have a positive live balance`);
    }
    bins.push({ binId, liveBalance });
  }
  return bins.sort((left, right) => left.binId < right.binId ? -1 : left.binId > right.binId ? 1 : 0);
}

function normalizeLimits(input: FullExitBatchPlanningLimits): Required<FullExitBatchPlanningLimits> {
  if (input === null || typeof input !== "object") throw new FullExitBatchPlanningError("invalid-input", "Full-exit planning limits are required");
  const blockGasLimit = parsePositiveBigint(input.blockGasLimit, "block gas limit");
  const gasEstimateBufferBps = input.gasEstimateBufferBps ?? DEFAULT_FULL_EXIT_GAS_BUFFER_BPS;
  const maxBlockGasBps = input.maxBlockGasBps ?? DEFAULT_FULL_EXIT_MAX_BLOCK_GAS_BPS;
  if (gasEstimateBufferBps < FULL_EXIT_BPS_DENOMINATOR || gasEstimateBufferBps > 100_000n) throw new FullExitBatchPlanningError("invalid-input", "Gas estimate buffer BPS must be between 10000 and 100000");
  if (maxBlockGasBps <= 0n || maxBlockGasBps > FULL_EXIT_BPS_DENOMINATOR) throw new FullExitBatchPlanningError("invalid-input", "Block gas cap BPS must be between 1 and 10000");
  return {
    blockGasLimit,
    gasEstimateBufferBps,
    maxBlockGasBps,
    maxCalldataBytes: parseSafeInteger(input.maxCalldataBytes, "maximum calldata bytes", 1),
    maxCandidateBins: parseSafeInteger(input.maxCandidateBins, "maximum candidate bins", 1),
    maxProbeCount: parseSafeInteger(input.maxProbeCount, "maximum probe count", 1)
  };
}

function encodeBins(bins: readonly FullExitLiveBin[]): string[][] {
  return bins.map((bin) => [bin.binId.toString(), bin.liveBalance.toString()]);
}

function decodeCanonicalBins(value: unknown[], label: string): FullExitLiveBin[] {
  const raw = value.map((row) => {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string" || !/^\d+$/.test(row[0]) || !/^\d+$/.test(row[1])) {
      throw new Error(`Full-exit ${label} bin encoding is malformed`);
    }
    return { binId: row[0], liveBalance: row[1] };
  });
  const bins = normalizeLiveBins(raw, false);
  if (JSON.stringify(encodeBins(bins)) !== JSON.stringify(value)) throw new Error(`Full-exit ${label} bins are not canonical`);
  return bins;
}

function sameBins(left: readonly FullExitLiveBin[], right: readonly FullExitLiveBin[]): boolean {
  return left.length === right.length && left.every((bin, index) =>
    bin.binId === right[index]?.binId && bin.liveBalance === right[index]?.liveBalance
  );
}

function copyBin(bin: FullExitLiveBin): FullExitLiveBin {
  return { binId: bin.binId, liveBalance: bin.liveBalance };
}

function parseNonNegativeInteger(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${label} must be a non-negative integer`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${label} must be a non-negative integer`);
}

function parsePositiveBigint(value: unknown, label: string): bigint {
  const parsed = parseNonNegativeInteger(value, label);
  if (parsed === 0n) throw new Error(`${label} must be positive`);
  return parsed;
}

function parseSafeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be a safe integer of at least ${minimum}`);
  return value as number;
}

function normalizeAddress(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an EVM address`);
  return value.toLowerCase() as `0x${string}`;
}

function normalizeHash(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be a 32-byte hash`);
  return value.toLowerCase() as `0x${string}`;
}

function normalizeText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) throw new Error(`${label} must be a non-empty bounded string`);
  return value;
}

function parseJson(value: string, label: string): unknown {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000_000) throw new Error(`Full-exit ${label} must be a bounded JSON string`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Full-exit ${label} is not valid JSON`);
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
