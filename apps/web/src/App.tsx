import { QueryClient, QueryClientProvider, useQuery, type QueryObserverResult } from "@tanstack/react-query";
import {
  activeIdFromPriceQ128,
  decimalPriceToQ128,
  formatExactPriceFraction,
  normalizeQ128Price,
  priceQ128FromActiveId,
  readIdFromPrice,
  readPriceFromId
} from "../../../packages/sdk/src/liquidity-price";
import {
  buildCreateLBPairTransaction,
  parseLBPairCreatedReceipt,
  preflightPoolCreation,
  readPoolCreationFactoryDiscovery,
  reconcileCreatedPool,
  type CreatablePoolPreflight,
  type PoolCreationSelection
} from "../../../packages/sdk/src/pool-creation";
import { erc20Abi, lbFactoryAbi, lbPairAbi, lbRouterAbi } from "@robinhood-lb/sdk/abi";
import { createDexPublicClient } from "@robinhood-lb/sdk/client";
import {
  applyBurnQuoteSlippage,
  applyLiquiditySlippageMin,
  buildAddLiquidityNativeTransaction,
  buildAddLiquidityTransaction,
  buildLiquidityDistribution,
  buildRemoveLiquidityNativeTransaction,
  buildRemoveLiquidityTransaction,
  MAX_LIQUIDITY_BINS,
  quoteLiquidityBurn,
  type LiquidityBurnMinimums,
  type LiquidityBurnQuote,
  type LiquidityStrategy
} from "@robinhood-lb/sdk/liquidity";
import type { DexRegistry, LocalnetDexRegistry } from "@robinhood-lb/sdk/registry";
import {
  assertQuoteMatchesExactInRequest,
  buildExactInSwapTransaction,
  buildExactNativeForTokensSwapTransaction,
  buildExactTokensForNativeSwapTransaction,
  calculateAmountOutMin,
  deadlineFromNow,
  estimatePriceImpactBps,
  getBestExactInQuote,
  getSelectedPairExactInQuote,
  getQuoteAmountOut,
  getTotalFeeBps,
  quoteToRouteSteps,
  type ExactInQuote
} from "@robinhood-lb/sdk/swap";
import { tokenAllowsAction, tokenApprovalCapabilityLabel, type TokenAction, type TokenMetadata } from "@robinhood-lb/sdk/tokens";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from "lightweight-charts";
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  CircleDollarSign,
  Droplets,
  Layers3,
  LoaderCircle,
  Network,
  RefreshCw,
  Server,
  Wallet,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { decodeEventLog, encodeFunctionData, isAddress, isAddressEqual, keccak256, zeroAddress, type Address, type Chain, type Hex, type PublicClient, formatUnits } from "viem";
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useReconnect,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
  WagmiProvider
} from "wagmi";

import {
  analyticsEndpointForRegistry,
  brandLinks,
  defaultEnvironmentKey,
  docsHref,
  isLocalnetRegistry,
  registries,
  routes,
  type EnvironmentKey,
  type RouteKey
} from "./config";
import {
  formatCompactAddress,
  formatTokenAmount,
  loadAppSnapshot,
  loadPaginatedPositionsForOwnerPair,
  loadPaginatedPositionsForOwnerPairAtBlock,
  loadPoolById,
  loadPositionHistory,
  loadWalletPortfolio,
  tokenSymbol,
  type AppSnapshot,
  type LoadState,
  type PaginatedRows,
  type PaginationInfo,
  type PoolRow,
  type PositionHistoryRow,
  type PortfolioPositionRow,
  type PositionRow,
  type WalletPortfolioPage
} from "./data";
import {
  buildSelectedPoolDescriptor,
  type SelectedPoolDescriptor,
  type SelectedPoolRuntimeFlags
} from "./pool-selection";
import {
  PairAttestationError,
  attestPairForWrite,
  attestSwapRouteForWrite,
  poolRowToPairClaim,
  type PairAttestation
} from "./pair-attestation";
import {
  classifyLbOperatorApproval,
  observationMatchesGrant,
  type LbOperatorApprovalGrant,
  type LbOperatorApprovalObservation
} from "./lb-operator-approval";
import { LbOperatorApprovalDisclosure } from "./lb-operator-approval-disclosure";
import {
  classifyFullExitJournalRecord,
  createFullExitStateSnapshot,
  createFullExitWorkflowKey,
  encodeFullExitBatchSettings,
  fullExitStateFingerprint,
  parseFullExitBatchSettings,
  planFullExitBatches,
  type FullExitLiveBin
} from "./full-exit-batching";
import { fullExitBatchPolicy } from "./full-exit-policy";
import { buildPositionBurnPlan, type PositionBurnLiveBalanceRow, type PositionBurnPlanResult } from "./position-burn-plan";
import {
  BLOCKING_PRICE_IMPACT_BPS,
  DANGEROUS_SLIPPAGE_BPS,
  QUOTE_STALE_MS,
  approvalDisclosure,
  burnExecutionContextFingerprint,
  burnQuoteExecutionFingerprint,
  evaluateTransactionSafety,
  idSlippageInputError,
  liquidityAddAssetFingerprint,
  nativeSwapSubmissionFingerprint,
  parseDeadlineMinutes,
  parseIdSlippage,
  quoteIsStale,
  reconcileNativeSwapReceipt,
  swapExecutionContextFingerprint,
  type BurnQuoteExecutionBinding,
  type NativeSwapSubmissionBinding,
  type SwapExecutionContext
} from "./transaction-safety";
import { openWalletModal, wagmiConfig, walletModalConfigured, walletModalIsOpen } from "./wagmi";
import { SUPPORTED_WALLET_RDNS, walletFailure, walletSessionIdentity, type WalletFailure } from "./wallet-lifecycle";
import { TransactionJournalProvider, useTransactionJournal, type TransactionJournalApi } from "./transaction-journal-react";
import {
  TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS,
  isUserRejectedSubmission,
  loadTransactionJournal,
  transactionRecordBlocksIntentFamily,
  type ReviewedTransactionIntent,
  type TransactionJournalRecord
} from "./transaction-journal";
import {
  getPinnedBlockIdentity,
  loadPinnedAddLiquidityReview,
  reconcileAddLiquidityReceipt,
  reconcileNativeAddLiquidityReceipt,
  reconcileNativeRemoveLiquidityReceipt,
  samePinnedLiquidityReview,
  type AddLiquidityReceiptReconciliation,
  type NativeAddLiquidityReceiptReconciliation,
  type NativeRemoveLiquidityReceiptReconciliation,
  type PinnedAddLiquidityReview
} from "./liquidity-review";
import { suggestPairedLiquidityAmounts, type PairedFillSide } from "./liquidity-amount-suggestion";
import {
  assertExecutableTokenAction,
  deterministicTokenFallback,
  poolChoiceIdentityLabel,
  maxAmountInput,
  safeMaxAmount,
  parseTokenAmount,
  tokenAmountErrorMessage
} from "./token-safety";
import {
  createPoolCreationReview,
  poolCreationReviewIsCurrent,
  recordAmbiguousCreateSubmission,
  recordCanonicalPoolConfirmation,
  recordCreateMinedRevert,
  recordCreateWalletRejection,
  recordDuplicatePool,
  recordPoolCreationReorg,
  recordPoolIndexingLag,
  recordCreatedPoolEmpty,
  type LiveCreatedPool,
  type PoolCreationPresetReview,
  type PoolCreationRecoveryState,
  type PoolCreationReview,
  type PoolCreationMode
} from "./pool-creation";
import {
  POOL_CREATION_PROGRESS_STEPS,
  formatPoolCreationElapsed,
  poolCreationProgress
} from "./pool-creation-progress";
import {
  TRUSTED_POOL_CREATION_PRICE_CLIENT_TTL_MS,
  loadTrustedPoolCreationPrice,
  trustedPoolCreationPriceIsLocallyFresh,
  trustedPoolCreationPriceLocalAgeSeconds,
  trustedPriceDeviationBps
} from "./pool-creation-price";
import {
  loadPoolCreationReview,
  persistPoolCreationReview
} from "./pool-creation-review-storage";
import {
  loadPoolCreationDraft,
  persistPoolCreationDraft,
  poolCreationWasOpen,
  setPoolCreationOpen
} from "./pool-creation-draft";
import { selectPoolCreationTokenDefaults } from "./pool-creation-defaults";
import { isDeprecatedPool } from "./pool-release-policy";
import {
  DEFAULT_POOL_DISCOVERY_STATE,
  actionHref,
  buildOwnerLiquidityIndex,
  discoveryHref,
  filterPoolPage,
  parsePoolDiscoveryState,
  poolDetailHref,
  returnHrefFromAction,
  type PoolDiscoveryState
} from "./pool-discovery";
import {
  CANDLE_INTERVAL_LABELS,
  CANDLE_LOOKBACK_LABELS,
  CANDLE_LOOKBACK_SECONDS,
  candleBoundary,
  loadPairCandles,
  loadPoolCatalog,
  loadPoolDiscoveryBatches,
  type AnalyticsPage,
  type AnalyticsStatus,
  type CandleInterval,
  type PairCandle,
  type PoolCatalogEntry
} from "./analytics-data";
import {
  buildCenteredBinDistribution,
  type BinDistributionPoint
} from "./pool-workspace";
import {
  buildPoolDiscoveryRequests,
  buildPoolDiscoveryRows,
  type PoolDiscoveryDisplayRow
} from "./pool-discovery-model";
import {
  parsePoolWorkspaceRoute,
  poolWorkspaceHref,
  type PoolWorkspaceTask
} from "./pool-workspace-route";
import {
  useOptionalPoolWorkspace,
  usePoolDraftState,
  type CandleStreamState
} from "./pool-workspace-context";
import { PoolWorkspaceShell, PoolWorkspaceTaskTabs } from "./pool-workspace-shell";
import { PoolWorkspaceOwnerPanel } from "./pool-workspace-owner-panel";
import { useMediaQuery } from "./use-media-query";

const queryClient = new QueryClient();
const SNAPSHOT_REFRESH_INTERVAL_MS = 10_000;
const SWAP_QUOTE_REFRESH_INTERVAL_MS = 10_000;
const CHART_INTERVALS: readonly CandleInterval[] = ["ONE_MINUTE", "FIVE_MINUTES", "FIFTEEN_MINUTES", "HOUR", "FOUR_HOURS", "DAY", "WEEK"];
const MAX_LIQUIDITY_BIN_ID = 16_777_215;
const LB_PAIR_RESERVES_ABI = [{
  type: "function",
  name: "getReserves",
  stateMutability: "view",
  inputs: [],
  outputs: [
    { name: "reserveX", type: "uint128" },
    { name: "reserveY", type: "uint128" }
  ]
}] as const;

interface FullExitUiState {
  batchOrdinal: number;
  completedBatches: number;
  estimatedTransactionsRemaining: number | null;
  message: string;
  remainingBins: number | null;
  status: "idle" | "planning" | "awaiting-review" | "submitted" | "awaiting-finality" | "complete" | "blocked";
  workflowKey: string;
}

interface FullExitBatchReviewState {
  assetMode: "erc20" | "native";
  batchOrdinal: number;
  batchSettings: string;
  binStates: LiveBurnBinState[];
  completedBatches: number;
  estimatedTransactionsRemaining: number;
  estimatedGas: bigint;
  expectedAmountX: bigint;
  expectedAmountY: bigint;
  executionContextFingerprint: string;
  executionFingerprint: string;
  liveBins: FullExitLiveBin[];
  minimumAmountX: bigint;
  minimumAmountY: bigint;
  positions: PositionRow[];
  remainingBins: number;
  sourceBlockHash: string;
  sourceBlockNumber: bigint;
  stateFingerprint: string;
  transaction: ReturnType<typeof buildRemoveLiquidityTransaction>;
  workflowKey: string;
}

interface SerializedExactInQuote {
  route: Address[];
  pairs: Address[];
  binSteps: string[];
  versions: number[];
  amounts: string[];
  virtualAmountsWithoutSlippage: string[];
  fees: string[];
}

interface RouteStepView {
  key: string;
  pair: string;
  binStep: string;
  version: string;
  tokenIn: string;
  tokenOut: string;
}

interface LiquidityDistributionView {
  key: string;
  binId: string;
  delta: string;
  xWeight: string;
  yWeight: string;
  height: string;
}

interface LiveBurnBinState {
  binId: string;
  reserveX: string;
  reserveY: string;
  totalSupply: string;
}

interface LiveBurnSnapshot {
  balances: PositionBurnLiveBalanceRow[];
  binStates: LiveBurnBinState[];
  blockNumber: bigint;
}

interface BurnQuoteView {
  error: string | null;
  minimums: LiquidityBurnMinimums | null;
  quote: LiquidityBurnQuote | null;
}

interface ApprovalRefreshState {
  confirmedAt: number;
  error: string | null;
  generation: number;
  hash: Address;
  intentFingerprint: string;
  refreshedContextFingerprint: string | null;
  snapshotIdentity: string | null;
  status: "refreshing" | "awaiting-render" | "ready" | "error";
}

interface ExactGasReview {
  action: string;
  bufferedWei: bigint;
  executionFingerprint: string;
  gasLimit: bigint;
  gasPrice: bigint;
  requiredWei: bigint;
  transactionValue: bigint;
}

interface LiquidityAddReviewState {
  executionFingerprint: string;
  review: PinnedAddLiquidityReview;
}

interface SubmittedLiquidityAddReview extends LiquidityAddReviewState {
  chainId: number;
  environment: EnvironmentKey;
  submittedAt: number;
}

interface SubmittedNativeRemoveReview {
  account: Address;
  amounts: bigint[];
  chainId: number;
  environment: EnvironmentKey;
  executionFingerprint: string;
  expectedAmountX: bigint;
  expectedAmountY: bigint;
  ids: bigint[];
  minimumAmountX: bigint;
  minimumAmountY: bigint;
  nativeSide: "x" | "y";
  pair: Address;
  submittedAt: number;
  tokenX: Address;
  tokenY: Address;
  transaction: { data: Hex; to: Address; value: bigint };
}

interface ConfirmedPoolOverlay {
  row: PoolRow;
  recovery: Extract<PoolCreationRecoveryState, { kind: "duplicate" | "created-empty" | "indexing-lag" | "canonical-confirmation" }>;
}

interface DuplicatePoolObservation {
  pool: LiveCreatedPool;
  reserveX: bigint;
  reserveY: bigint;
}

interface PoolCreationTokenChoice {
  address: Address;
  decimals: number;
  name: string;
  symbol: string;
  listed: boolean;
}

interface PoolCreationPreparedReview {
  review: PoolCreationReview;
  preflight: CreatablePoolPreflight;
  transaction: ReturnType<typeof buildCreateLBPairTransaction>;
  preset: PoolCreationPresetReview;
  requestedPriceQ128: bigint;
  representedPriceQ128: bigint;
  representedQuotePerBase: string;
  inverseBasePerQuote: string;
  deviationBps: bigint;
  tokenX: PoolCreationTokenChoice;
  tokenY: PoolCreationTokenChoice;
}

const GAS_BUFFER_BPS = 12_500n;

function deploymentEpoch(registry: DexRegistry): string {
  return [
    registry.chainId,
    registry.startBlock,
    registry.endpoints.rpcUrl,
    registry.contracts.lbFactory,
    registry.contracts.lbPairImplementation,
    registry.contracts.lbQuoter,
    registry.contracts.lbRouter
  ].join("|");
}

function sliceBurnPlan(plan: PositionBurnPlanResult, bins: readonly FullExitLiveBin[]): PositionBurnPlanResult {
  const included = new Set(bins.map((bin) => bin.binId.toString()));
  const items = plan.items.filter((item) => included.has(item.binId.toString()));
  return {
    amounts: items.map((item) => item.amount),
    blocked: false,
    blockers: [],
    ids: items.map((item) => item.binId),
    items,
    warnings: [...plan.warnings]
  };
}

function fullExitSettingsForRecord(record: TransactionJournalRecord) {
  try {
    return parseFullExitBatchSettings(record.reviewed.settingsFingerprint);
  } catch {
    return null;
  }
}

function fullExitJournalDisposition(record: TransactionJournalRecord) {
  return classifyFullExitJournalRecord({
    confirmations: record.confirmations,
    receiptStatus: record.canonicalReceipt?.status ?? null,
    replacementCompatibility: record.replacementCompatibility,
    replacementFinalized: record.replacementFinalized,
    status: record.status
  }, TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS);
}

function fullExitReviewedLiveStateFingerprint(
  bins: readonly FullExitLiveBin[],
  binStates: readonly LiveBurnBinState[]
): string {
  const stateByBin = new Map(binStates.map((state) => [BigInt(state.binId).toString(), state]));
  return JSON.stringify([...bins]
    .sort((left, right) => left.binId < right.binId ? -1 : left.binId > right.binId ? 1 : 0)
    .map((bin) => {
      const state = stateByBin.get(bin.binId.toString());
      if (!state) throw new Error(`Full-exit quote state is missing for bin ${bin.binId.toString()}`);
      return [bin.binId.toString(), bin.liveBalance.toString(), state.reserveX, state.reserveY, state.totalSupply];
    }));
}


function reviewedTransactionIntent(
  input: {
    account: Address;
    calldataFingerprint: string;
    chainId: number;
    deploymentEpoch: string;
    environment: EnvironmentKey;
    executionFingerprint: string;
    intent: ReviewedTransactionIntent["intent"];
    target: Address;
    value: bigint;
  },
  binding: { poolId: string | null; recipient: Address | null; refundRecipient: Address | null; settingsFingerprint: string }
): ReviewedTransactionIntent {
  return {
    account: input.account,
    calldataFingerprint: input.calldataFingerprint as `0x${string}`,
    chainId: input.chainId,
    contractsFingerprint: input.deploymentEpoch,
    deploymentEpoch: input.deploymentEpoch,
    environment: input.environment,
    executionFingerprint: input.executionFingerprint,
    intent: input.intent,
    poolId: binding.poolId,
    recipient: binding.recipient,
    refundRecipient: binding.refundRecipient,
    settingsFingerprint: binding.settingsFingerprint,
    target: input.target,
    value: input.value.toString()
  };
}

async function submitJournaledTransaction(input: {
  isCurrent: () => boolean;
  journal: TransactionJournalApi;
  preWalletGuard?: () => Promise<void>;
  reviewed: ReviewedTransactionIntent;
  send: () => Promise<Address>;
}): Promise<Address | null> {
  const handle = await input.journal.begin(input.reviewed);
  if (!input.isCurrent()) {
    await input.journal.abort(handle);
    return null;
  }
  if (input.preWalletGuard) {
    try {
      await input.preWalletGuard();
      if (!input.isCurrent()) throw new PairAttestationError("context-changed", "Transaction context changed during the final pre-wallet guard");
    } catch (error) {
      await input.journal.abort(handle);
      throw error;
    }
  }
  let hash: Address;
  try {
    hash = await input.send();
  } catch (error) {
    await input.journal.fail(handle, error);
    if (isUserRejectedSubmission(error)) throw error;
    throw new AmbiguousWalletSubmissionError(error);
  }
  try {
    await input.journal.submitted(handle, hash);
  } catch {
    throw new Error(`Wallet returned ${formatCompactAddress(hash)}, but durable hash persistence failed; retry remains blocked in this session`);
  }
  return hash;
}

class AmbiguousWalletSubmissionError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Wallet transport failed after submission handoff; a possible broadcast has no returned transaction hash. Retry remains blocked while the durable journal reconciles it.");
    this.name = "AmbiguousWalletSubmissionError";
    this.cause = cause;
  }
}

type SnapshotRefetch = () => Promise<QueryObserverResult<AppSnapshot, Error>>;

const routeIcons: Record<RouteKey, ComponentType<{ size?: number }>> = {
  home: Activity,
  swap: ArrowLeftRight,
  pools: CircleDollarSign,
  liquidity: Droplets,
  positions: Layers3,
  activity: Activity
};

export function App() {
  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <SafeWalletReconnect />
        <TransactionJournalProvider>
          <DexShell />
        </TransactionJournalProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function SafeWalletReconnect() {
  const attempted = useRef(false);
  const account = useAccount();
  const { connectors, reconnect } = useReconnect();

  useEffect(() => {
    if (account.status === "connected") {
      attempted.current = true;
      return;
    }
    if (attempted.current || connectors.length === 0 || account.status !== "disconnected") return;
    const timeout = window.setTimeout(() => {
      if (attempted.current) return;
      attempted.current = true;
      void Promise.resolve(wagmiConfig.storage?.getItem("recentConnectorId") ?? null).then((recentConnectorId) => {
        if (typeof recentConnectorId !== "string" || !SUPPORTED_WALLET_RDNS.has(recentConnectorId)) return;
        const connector = connectors.find((candidate) => candidate.id === recentConnectorId);
        if (connector && wagmiConfig.state.status === "disconnected") reconnect({ connectors: [connector] });
      });
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [account.status, connectors, reconnect]);

  return null;
}

function DexShell() {
  const environmentKey = defaultEnvironmentKey;
  const [routeKey, setRouteKey, poolDetailId, liquiditySection, actionPoolId, positionDetailId, portfolioAction, workspaceTask] = useHashRoute();
  const registry = registries[environmentKey];
  const account = useAccount();
  const walletChainId = useChainId();
  const walletSessionKey = walletSessionIdentity({
    address: account.address,
    chainId: walletChainId,
    connectorUid: account.connector?.uid,
    environment: `${environmentKey}|${deploymentEpoch(registry)}`,
    status: account.status
  });
  const walletPanelKey = account.status === "connected" ? walletSessionKey : `${environmentKey}:disconnected`;
  const previousWalletSessionKey = useRef(walletSessionKey);
  const [confirmedPoolOverlay, setConfirmedPoolOverlay] = useState<ConfirmedPoolOverlay | null>(null);
  const snapshotQuery = useQuery({
    queryKey: [
      "dashboard",
      environmentKey,
      registry.chainId,
      registry.endpoints.rpcUrl,
      registry.endpoints.indexerUrl
    ],
    queryFn: () => loadAppSnapshot(registry),
    refetchInterval: SNAPSHOT_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always"
  });
  const snapshot = snapshotQuery.data;

  useEffect(() => {
    if (routeKey !== "pools" || poolDetailId === null || workspaceTask !== "market") return;
    const workspacePath = window.location.hash.split("?", 1)[0];
    if (!workspacePath.endsWith("/market")) return;
    const returnContext = returnHrefFromAction(window.location.hash) ?? window.location.hash;
    const returnHref = discoveryHref(parsePoolDiscoveryState(returnContext));
    const createHref = actionHref("add", poolDetailId, returnHref);
    if (window.location.hash !== createHref) window.location.replace(createHref);
  }, [poolDetailId, routeKey, workspaceTask]);

  useEffect(() => {
    if (previousWalletSessionKey.current === walletSessionKey) return;
    previousWalletSessionKey.current = walletSessionKey;
    const ownerQueryPrefixes = new Set([
      "liquidityPortfolioIntent",
      "liquidityPositions",
      "liquiditySelectedBurnSnapshot",
      "liquidityWallet",
      "poolDetailPositions",
      "positionHistory",
      "swapWallet",
      "walletPortfolio"
    ]);
    void queryClient.cancelQueries({ predicate: (query) => ownerQueryPrefixes.has(String(query.queryKey[0] ?? "")) });
    queryClient.removeQueries({ predicate: (query) => ownerQueryPrefixes.has(String(query.queryKey[0] ?? "")) });
  }, [walletSessionKey]);

  useEffect(() => {
    window.scrollTo({ behavior: "auto", left: 0, top: 0 });
    document.title = poolDetailId !== null
      ? `Pool ${workspaceTask ?? "market"} | Feather`
      : `${routes.find((route) => route.key === routeKey)?.label ?? "Feather"} | Feather`;
    window.requestAnimationFrame(() => {
      document.getElementById("app-route-content")?.focus({ preventScroll: true });
    });
  }, [actionPoolId, liquiditySection, poolDetailId, portfolioAction, positionDetailId, routeKey, workspaceTask]);

  if (routeKey === "home") {
    return <LandingView networkName={registry.chain.name} snapshot={snapshot} />;
  }

  return (
    <main className="shell app-shell route-focus-target" id="app-route-content" tabIndex={-1}>
      <header className="app-header">
        <BrandLockup />
        <nav className="nav-list" aria-label="Primary">
          {routes.filter((route) => ["pools", "positions"].includes(route.key)).map((route) => {
            const Icon = routeIcons[route.key];
            return (
              <a
                className={routeKey === route.key ? "nav-item active" : "nav-item"}
                href={`#/${route.key}`}
                key={route.key}
                onClick={() => setRouteKey(route.key)}
                aria-label={route.label}
                aria-current={routeKey === route.key ? "page" : undefined}
              >
                <Icon size={16} />
                <span>{route.label}</span>
              </a>
            );
          })}
          <DocsLink className="nav-item" />
        </nav>
        <div className="app-header-actions">
          <WalletPanel activeChain={registry.chain} key={walletPanelKey} />
        </div>
      </header>

      <section className="workspace">
        <header className="workspace-refresh">
          <button
            className="icon-button"
            data-testid="snapshot-refresh-button"
            type="button"
            onClick={() => void snapshotQuery.refetch()}
            title="Refresh state"
          >
            <RefreshCw size={18} />
          </button>
        </header>

        {snapshot?.indexer.message && snapshot.indexer.status !== "unavailable" ? (
          <p
            className={`snapshot-message ${snapshot.indexer.status}`}
            data-testid="indexer-status-message"
            role={snapshot.indexer.status === "error" ? "alert" : "status"}
          >
            {snapshot.indexer.message}
          </p>
        ) : null}

          <ContentView
            key={routeKey === "pools" && poolDetailId === null
              ? `pool-discovery:${environmentKey}`
              : walletSessionKey}
            confirmedPoolOverlay={confirmedPoolOverlay}
            environmentKey={environmentKey}
            actionPoolId={actionPoolId}
            liquiditySection={liquiditySection}
            poolDetailId={poolDetailId}
            portfolioAction={portfolioAction}
            positionDetailId={positionDetailId}
            routeKey={routeKey}
            snapshot={snapshot}
            snapshotState={snapshotQuery.isLoading ? "loading" : snapshotQuery.isError ? "error" : snapshot?.indexer.status ?? "loading"}
            workspaceTask={workspaceTask}
            setConfirmedPoolOverlay={setConfirmedPoolOverlay}
            onRefresh={() => snapshotQuery.refetch()}
          />
      </section>
    </main>
  );
}

function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <a className={compact ? "brand-block compact" : "brand-block"} href="#/" aria-label="Feather Trade home">
      <img className="brand-mark" src="/feather/feather-mark-128.png" alt="" />
      <span className="brand-wordmark">feather{compact ? "" : <span className="brand-trade"> trade</span>}</span>
    </a>
  );
}

function DocsLink({ className }: { className?: string }) {
  const external = /^https?:\/\//.test(docsHref);
  return (
    <a className={className} href={docsHref} rel={external ? "noreferrer" : undefined} target={external ? "_blank" : undefined}>
      <span>Docs</span>
    </a>
  );
}

function LandingView(_: { networkName: string; snapshot: AppSnapshot | undefined }) {
  return (
    <main className="landing-shell">
      <header className="landing-header">
        <BrandLockup />
        <nav aria-label="Marketing">
          <a className="landing-pools-link" href="#/pools">Pools</a>
          <DocsLink />
        </nav>
        <a className="primary-button landing-launch" href="#/pools">Launch app</a>
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="hero-copy">
          <p className="eyebrow">Built for Robinhood Chain</p>
          <h1 id="landing-title">Weightless liquidity.</h1>
          <p>Trade and deploy concentrated liquidity through a DLMM with dynamic fees built for fast-moving markets.</p>
          <div className="hero-actions">
            <a className="primary-button hero-launch" href="#/pools">Launch app <span aria-hidden="true">↗</span></a>
          </div>
        </div>

        <LiquidityBookSimulation />
      </section>

      <section className="landing-pillars" aria-labelledby="liquidity-title">
        <div className="pillar-intro">
          <h2 id="liquidity-title">Capital that works where the market moves.</h2>
          <p>Liquidity Book places capital into discrete price bins, giving LPs precise control without adding complexity for traders.</p>
        </div>
        <div className="pillar-list">
          <article>
            <div><h3>Concentrated by design</h3><p>Choose the range. Keep capital close to active trading.</p></div>
          </article>
          <article>
            <div><h3>Fees respond to volatility</h3><p>Dynamic fees increase when markets move and normalize as activity settles.</p></div>
          </article>
          <article>
            <div><h3>Execution stays lightweight</h3><p>Fast finality and low network costs keep every position practical to manage.</p></div>
          </article>
        </div>
      </section>

      <section className="strategy-band">
        <div>
          <p className="eyebrow">For liquidity providers</p>
          <h2>Three strategies. One slider.</h2>
          <p>Choose Spot, Curve, or Bid-Ask. Shape the range to match your market view.</p>
        </div>
        <div className="strategy-tiles" aria-label="Liquidity strategies">
          <div className="active"><BinGlyph mode="spot" /><span>Spot</span></div>
          <div><BinGlyph mode="curve" /><span>Curve</span></div>
          <div><BinGlyph mode="bidask" /><span>Bid-Ask</span></div>
        </div>
      </section>

      <footer className="landing-footer">
        <BrandLockup compact />
        <nav aria-label="Project links">
          {brandLinks.map((link) => <a href={link.href} key={link.label} rel="noreferrer" target="_blank">{link.label}</a>)}
        </nav>
        <span>Engineered on Robinhood Chain, 2026</span>
      </footer>
    </main>
  );
}

interface SimulatedLiquidityBin {
  capacity: number;
  reserveX: number;
  reserveY: number;
}

interface SimulatedLiquidityState {
  activeIndex: number;
  bins: SimulatedLiquidityBin[];
  crossingsRemaining: number;
  direction: -1 | 1;
}

const simulationBinHeights = [
  34, 48, 29, 57, 43, 66, 38, 54, 72, 47, 63, 41, 76, 58, 69, 45,
  82, 61, 74, 53, 88, 64, 79, 49, 70, 56, 85, 62, 73, 59, 78, 66,
  87, 55, 75, 63, 80, 51, 68, 72, 46, 77, 60, 83, 52, 69, 44, 71,
  57, 65, 50, 74, 42, 61, 48, 67, 39, 58, 45, 53, 36
];
const simulationCenterIndex = 30;
const simulationCenterBinId = 8_388_608;
const simulationBinStep = 10;
const simulationBinPitch = 27;
const simulationCenterPrice = 160;

function LiquidityBookSimulation() {
  const [simulation, setSimulation] = useState<SimulatedLiquidityState>(createLiquiditySimulation);

  useEffect(() => {
    if (simulation.bins.length !== simulationBinHeights.length) setSimulation(createLiquiditySimulation());
  }, [simulation.bins.length]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const interval = window.setInterval(() => setSimulation((current) => advanceLiquiditySimulation(current)), 620);
    return () => window.clearInterval(interval);
  }, []);

  const activeBinId = simulationCenterBinId + simulation.activeIndex - simulationCenterIndex;
  const currentPrice = simulationCenterPrice * Math.pow(1 + simulationBinStep / 10_000, activeBinId - simulationCenterBinId);
  const activeBin = simulation.bins[simulation.activeIndex];
  const activeTotal = Math.max(activeBin.reserveX + activeBin.reserveY, 0.001);
  const activeXShare = Math.round((activeBin.reserveX / activeTotal) * 100);
  const activeYShare = 100 - activeXShare;

  return (
    <aside className="hero-market" aria-label="Illustrative SPCX and USDC Liquidity Book market simulation">
      <div className="hero-market-head">
        <span>Bin liquidity simulation</span>
        <span className="market-state">Illustrative</span>
      </div>
      <div className="hero-pair">
        <span>SPCX / USDC</span>
        <strong>{simulationBinStep} bps per bin</strong>
      </div>
      <div className="market-price">
        <span>Current bin price</span>
        <strong>{currentPrice.toFixed(2)}</strong>
        <small>USDC per SPCX</small>
      </div>
      <div className="hero-bin-field" aria-label="The centered price bin converts one token reserve into the other as the market moves">
        <div
          className="hero-bin-track"
          style={{ transform: `translate3d(-${simulation.activeIndex * simulationBinPitch + 11}px, 0, 0)` }}
        >
          {simulation.bins.map((bin, index) => {
            const total = Math.max(bin.reserveX + bin.reserveY, 0.001);
            return (
              <i key={index} style={{ height: `${simulationBinHeights[index]}%` }}>
                <span className="bin-reserve-x" style={{ height: `${(bin.reserveX / total) * 100}%` }} />
                <span className="bin-reserve-y" style={{ height: `${(bin.reserveY / total) * 100}%` }} />
              </i>
            );
          })}
        </div>
      </div>
      <div className="bin-legend" aria-hidden="true"><span>SPCX</span><span>USDC</span></div>
      <dl className="hero-market-data">
        <div><dt>Bin composition</dt><dd>{activeXShare}% / {activeYShare}%</dd></div>
        <div><dt>Price step</dt><dd>{simulationBinStep} bps</dd></div>
        <div><dt>Bin ID</dt><dd>{activeBinId}</dd></div>
        <div><dt>Trade pressure</dt><dd>{simulation.direction > 0 ? "Buying SPCX" : "Selling SPCX"}</dd></div>
      </dl>
    </aside>
  );
}

function createLiquiditySimulation(): SimulatedLiquidityState {
  return {
    activeIndex: simulationCenterIndex,
    crossingsRemaining: 6,
    direction: 1,
    bins: simulationBinHeights.map((capacity, index) => ({
      capacity,
      reserveX: index > simulationCenterIndex ? capacity : index === simulationCenterIndex ? capacity / 2 : 0,
      reserveY: index < simulationCenterIndex ? capacity : index === simulationCenterIndex ? capacity / 2 : 0
    }))
  };
}

function advanceLiquiditySimulation(current: SimulatedLiquidityState): SimulatedLiquidityState {
  let direction = current.direction;
  let activeIndex = current.activeIndex;
  let crossingsRemaining = current.crossingsRemaining;
  const bins = current.bins.map((bin) => ({ ...bin }));
  let activeBin = bins[activeIndex];

  const convertedShare = direction === 1
    ? activeBin.reserveY / activeBin.capacity
    : activeBin.reserveX / activeBin.capacity;

  if (crossingsRemaining === 0 && convertedShare >= 0.42) {
    direction = direction === 1 ? -1 : 1;
    crossingsRemaining = 3 + Math.floor(Math.random() * 6);
  }

  const outputReserve = direction === 1 ? activeBin.reserveX : activeBin.reserveY;

  if (outputReserve <= 0.5) {
    const nextIndex = activeIndex + direction;
    const nextOffset = nextIndex - simulationCenterIndex;
    const resistanceDistance = Math.max(0, Math.abs(nextOffset) - 10);
    const crossingProbability = resistanceDistance === 0
      ? 1
      : Math.exp(-0.35 * resistanceDistance * resistanceDistance);
    const canCross = Math.abs(nextOffset) <= 15 && Math.random() < crossingProbability;

    if (canCross) {
      activeIndex = nextIndex;
      crossingsRemaining = Math.max(0, crossingsRemaining - 1);
    } else {
      direction = direction === 1 ? -1 : 1;
      crossingsRemaining = 3 + Math.floor(Math.random() * 6);
    }
    activeBin = bins[activeIndex];
  }

  const availableOutput = direction === 1 ? activeBin.reserveX : activeBin.reserveY;
  const amount = Math.min(availableOutput, activeBin.capacity * (0.12 + Math.random() * 0.07));
  const binPrice = Math.pow(1 + simulationBinStep / 10_000, activeIndex - simulationCenterIndex);

  if (direction === 1) {
    activeBin.reserveX = Math.max(0, activeBin.reserveX - amount);
    activeBin.reserveY += amount * binPrice;
  } else {
    activeBin.reserveY = Math.max(0, activeBin.reserveY - amount);
    activeBin.reserveX += amount / binPrice;
  }

  return { activeIndex, bins, crossingsRemaining, direction };
}

function BinGlyph({ mode }: { mode: "spot" | "curve" | "bidask" }) {
  const heights = mode === "spot" ? [18, 28, 34, 28, 18] : mode === "curve" ? [12, 20, 34, 20, 12] : [30, 18, 10, 18, 30];
  return <span className={`bin-glyph ${mode}`} aria-hidden="true">{heights.map((height, index) => <i key={index} style={{ height }} />)}</span>;
}

function WalletPanel({ activeChain }: { activeChain: Chain }) {
  const [localFailure, setLocalFailure] = useState<WalletFailure | null>(null);
  const [discoverySettled, setDiscoverySettled] = useState(false);
  const walletDialogRef = useRef<HTMLDialogElement>(null);
  const account = useAccount();
  const activeWalletChainId = useChainId();
  const { connect, connectors, error: connectError, isPending, reset: resetConnect } = useConnect();
  const { disconnect } = useDisconnect();
  const { error: switchError, switchChain, isPending: isSwitching, reset: resetSwitch } = useSwitchChain();
  const discoveredConnectors = connectors.filter((connector) => connector.id !== "injected");
  const availableConnectors = discoveredConnectors.length > 0
    ? discoveredConnectors.filter((connector, index, all) => all.findIndex((candidate) => candidate.id === connector.id) === index)
    : connectors;
  const connected = account.status === "connected";
  const onWrongChain = connected && activeWalletChainId !== activeChain.id;
  const noProviderFailure: WalletFailure | null = discoverySettled && !walletModalConfigured && connectors.length === 0
    ? { action: "No browser wallet was found. Install a compatible wallet or use a build with mobile wallet connections enabled.", kind: "missing" }
    : null;
  const connectionFailure = localFailure ?? (connectError ? walletFailure(connectError, "connect") : noProviderFailure);
  const switchingFailure = switchError ? walletFailure(switchError, "switch") : null;

  useEffect(() => {
    const timeout = window.setTimeout(() => setDiscoverySettled(true), 100);
    return () => window.clearTimeout(timeout);
  }, []);

  const connectWith = async (connector: (typeof connectors)[number]) => {
    resetConnect();
    setLocalFailure(null);
    const provider = await connector.getProvider().catch(() => undefined) as {
      _metamask?: { isUnlocked?: () => Promise<boolean> };
    } | undefined;
    if (!provider) {
      setLocalFailure({ action: "Install or enable an EIP-1193 wallet, then reload this page.", kind: "missing" });
      return;
    }
    if (provider._metamask?.isUnlocked && !await provider._metamask.isUnlocked().catch(() => true)) {
      setLocalFailure({ action: "Unlock the selected wallet, then connect again.", kind: "locked" });
      return;
    }
    connect({ connector });
  };

  const openConnectionFlow = () => {
    resetConnect();
    setLocalFailure(null);
    if (walletModalConfigured) {
      void openWalletModal().catch(() => {
        setLocalFailure({ action: "The wallet chooser could not open. Reload the page and try again.", kind: "provider-error" });
      });
      return;
    }
    if (availableConnectors.length === 1) {
      void connectWith(availableConnectors[0]);
      return;
    }
    walletDialogRef.current?.showModal();
  };

  if (!connected) {
    return (
      <div className="wallet-cluster" data-testid="wallet-disconnected-state">
        <button
          className="primary-button"
          data-testid="wallet-connect-button"
          disabled={(!walletModalConfigured && availableConnectors.length === 0) || isPending}
          onClick={openConnectionFlow}
          type="button"
        >
          {isPending ? <LoaderCircle className="spin" size={18} /> : <Wallet size={18} />}
          <span>{isPending ? "Connecting" : "Connect wallet"}</span>
        </button>
        {!walletModalConfigured && availableConnectors.length > 1 ? (
          <dialog
            aria-labelledby="wallet-provider-title"
            className="wallet-provider-dialog"
            onClick={(event) => {
              if (event.target === event.currentTarget) event.currentTarget.close();
            }}
            ref={walletDialogRef}
          >
            <div className="wallet-provider-sheet">
              <header>
                <h2 id="wallet-provider-title">Choose a wallet</h2>
                <button aria-label="Close wallet chooser" className="wallet-dialog-close" onClick={() => walletDialogRef.current?.close()} type="button">
                  <X size={18} />
                </button>
              </header>
              <div className="wallet-provider-choices" data-testid="wallet-provider-choices" role="group" aria-label="Choose wallet provider">
                {availableConnectors.map((connector) => (
                  <button
                    className="wallet-provider-option"
                    data-provider-id={connector.id}
                    disabled={isPending}
                    key={connector.uid}
                    onClick={() => {
                      walletDialogRef.current?.close();
                      void connectWith(connector);
                    }}
                    type="button"
                  >
                    <span className="wallet-provider-icon">
                      {connector.icon ? <img alt="" src={connector.icon} /> : <Wallet size={20} />}
                    </span>
                    <span>
                      <strong>{connector.name}</strong>
                      <small>Browser wallet</small>
                    </span>
                  </button>
                ))}
              </div>
              <p>Only wallets announced by your browser are shown in this local build.</p>
            </div>
          </dialog>
        ) : null}
        {connectionFailure ? (
          <span className="inline-error" data-testid="wallet-status" data-wallet-state={connectionFailure.kind} role="alert">
            {connectionFailure.action}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="wallet-cluster">
      {onWrongChain ? (
        <button
          className="warn-button"
          data-testid="wallet-switch-button"
          disabled={isSwitching}
          onClick={() => {
            resetSwitch();
            switchChain({ chainId: activeChain.id });
          }}
          type="button"
        >
          {isSwitching ? <LoaderCircle className="spin" size={18} /> : <Network size={18} />}
          <span>{isSwitching ? "Adding or switching" : "Switch"}</span>
        </button>
      ) : null}
      <button className="secondary-button" data-testid="wallet-account-button" onClick={() => disconnect()} type="button">
        <Wallet size={18} />
        <span>{formatCompactAddress(account.address)}</span>
      </button>
      {onWrongChain ? (
        <span className="wallet-network-state" data-testid="wallet-status" data-wallet-state={switchingFailure?.kind ?? "wrong-chain"} role={switchingFailure ? "alert" : "status"}>
          {switchingFailure?.action ?? `Wallet is on chain ${activeWalletChainId}. Switch to ${activeChain.name} (${activeChain.id}); the wallet may ask to add it first.`}
        </span>
      ) : null}
    </div>
  );
}

function ContentView({
  actionPoolId,
  confirmedPoolOverlay,
  environmentKey,
  liquiditySection,
  poolDetailId,
  portfolioAction,
  positionDetailId,
  routeKey,
  snapshot,
  snapshotState,
  setConfirmedPoolOverlay,
  workspaceTask,
  onRefresh
}: {
  actionPoolId: string | null;
  confirmedPoolOverlay: ConfirmedPoolOverlay | null;
  environmentKey: EnvironmentKey;
  liquiditySection: "add" | "withdraw" | null;
  poolDetailId: string | null;
  portfolioAction: "add" | "partial" | "full" | null;
  positionDetailId: string | null;
  routeKey: RouteKey;
  snapshot: AppSnapshot | undefined;
  snapshotState: LoadState;
  setConfirmedPoolOverlay: (overlay: ConfirmedPoolOverlay | null) => void;
  workspaceTask: PoolWorkspaceTask | null;
  onRefresh: SnapshotRefetch;
}) {
  const activeRegistry = registries[environmentKey];
  const analyticsEndpoint = analyticsEndpointForRegistry(activeRegistry);
  const indexedPools = snapshot?.indexer.pools ?? [];
  const poolCatalogQuery = useQuery({
    queryKey: ["poolCatalog", environmentKey, analyticsEndpoint],
    queryFn: () => loadPoolCatalog(analyticsEndpoint),
    enabled: analyticsEndpoint !== null,
    refetchInterval: SNAPSHOT_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const catalogPools = useMemo(
    () => poolRowsFromCatalog(activeRegistry, poolCatalogQuery.data?.rows ?? [], indexedPools),
    [activeRegistry, indexedPools, poolCatalogQuery.data?.rows]
  );
  const setSafeConfirmedPoolOverlay = (overlay: ConfirmedPoolOverlay | null) => {
    if (overlay !== null && isDeprecatedPool(activeRegistry, overlay.row.address)) {
      setConfirmedPoolOverlay(null);
      return;
    }
    setConfirmedPoolOverlay(overlay);
  };
  const overlayIndexed = confirmedPoolOverlay !== null && catalogPools.some((pool) =>
    isAddressEqual(pool.address, confirmedPoolOverlay.row.address)
  );
  useEffect(() => {
    if (overlayIndexed) setConfirmedPoolOverlay(null);
  }, [overlayIndexed, setConfirmedPoolOverlay]);
  const pools = confirmedPoolOverlay !== null && !overlayIndexed
    ? [confirmedPoolOverlay.row, ...catalogPools.filter((pool) => !isAddressEqual(pool.address, confirmedPoolOverlay.row.address))]
    : catalogPools;
  const refreshPoolCatalog = useCallback(async () => {
    if (analyticsEndpoint === null) return;
    const result = await poolCatalogQuery.refetch();
    if (result.isError) throw result.error;
  }, [analyticsEndpoint, poolCatalogQuery.refetch]);
  const [selectedPoolId, setSelectedPoolId] = useState("");
  const poolIdsKey = pools.map((pool) => pool.id).join("|");
  const poolCatalogState: LoadState = analyticsEndpoint === null
    ? snapshotState
    : poolCatalogQuery.isPending
      ? "loading"
      : poolCatalogQuery.isError || poolCatalogQuery.data?.status === "UNAVAILABLE"
        ? "unavailable"
        : catalogPools.length === 0
          ? "empty"
          : poolCatalogQuery.data?.status === "PARTIAL"
            ? "partial"
            : "ready";
  const preferredPoolAddress = isLocalnetRegistry(activeRegistry)
    ? activeRegistry.seededPools.wethUsdc.pair
    : null;
  const defaultPool = selectDefaultIndexedPool(pools, preferredPoolAddress);
  const dashboardActionPool =
    actionPoolId === null
      ? null
      : pools.find(
          (pool) =>
            pool.id.toLowerCase() === actionPoolId.toLowerCase() ||
            pool.address.toLowerCase() === actionPoolId.toLowerCase()
        ) ?? null;
  const actionPoolIsDeprecated =
    actionPoolId !== null &&
    isAddress(actionPoolId, { strict: false }) &&
    isDeprecatedPool(activeRegistry, actionPoolId as Address);
  const directActionPoolQuery = useQuery({
    queryKey: ["actionPoolById", environmentKey, actionPoolId, registries[environmentKey].endpoints.indexerUrl],
    queryFn: () => {
      if (actionPoolId === null) throw new Error("Action pool ID is unavailable");
      if (actionPoolIsDeprecated) throw new Error("This test pool is deprecated and must remain unfunded");
      return loadPoolById(registries[environmentKey], actionPoolId);
    },
    enabled:
      actionPoolId !== null &&
      !actionPoolIsDeprecated &&
      dashboardActionPool === null &&
      registries[environmentKey].endpoints.indexerUrl !== null,
    refetchInterval:
      actionPoolId !== null && dashboardActionPool === null && registries[environmentKey].endpoints.indexerUrl !== null
        ? SNAPSHOT_REFRESH_INTERVAL_MS
        : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const actionPool = dashboardActionPool ?? directActionPoolQuery.data ?? null;
  const actionPoolOptions = actionPool !== null && !pools.some((pool) => pool.id === actionPool.id) ? [actionPool, ...pools] : pools;
  const selectedPool =
    actionPoolId !== null
      ? actionPool
      : actionPoolOptions.find((pool) => pool.id === selectedPoolId) ?? defaultPool;
  const dashboardDetailPool =
    poolDetailId === null
      ? null
      : pools.find(
          (pool) => pool.id.toLowerCase() === poolDetailId.toLowerCase() || pool.address.toLowerCase() === poolDetailId.toLowerCase()
        ) ?? null;
  const detailPoolIsDeprecated =
    poolDetailId !== null &&
    isAddress(poolDetailId, { strict: false }) &&
    isDeprecatedPool(activeRegistry, poolDetailId as Address);
  const directPoolQuery = useQuery({
    queryKey: ["poolById", environmentKey, poolDetailId, registries[environmentKey].endpoints.indexerUrl],
    queryFn: () => {
      if (poolDetailId === null) throw new Error("Pool ID is unavailable");
      if (detailPoolIsDeprecated) throw new Error("This test pool is deprecated and must remain unfunded");
      return loadPoolById(registries[environmentKey], poolDetailId);
    },
    enabled:
      routeKey === "pools" &&
      poolDetailId !== null &&
      !detailPoolIsDeprecated &&
      dashboardDetailPool === null &&
      registries[environmentKey].endpoints.indexerUrl !== null,
    refetchInterval:
      routeKey === "pools" &&
      poolDetailId !== null &&
      dashboardDetailPool === null &&
      registries[environmentKey].endpoints.indexerUrl !== null
        ? SNAPSHOT_REFRESH_INTERVAL_MS
        : false,
    refetchOnWindowFocus: "always",
    retry: false
  });

  useEffect(() => {
    setSelectedPoolId((currentId) => {
      if (pools.length === 0) return currentId === "" ? currentId : "";
      if (actionPool !== null) return actionPool.id;
      if (pools.some((pool) => pool.id === currentId)) return currentId;

      return selectDefaultIndexedPool(pools, preferredPoolAddress)?.id ?? "";
    });
  }, [actionPool, environmentKey, poolIdsKey, preferredPoolAddress]);

  const handleSelectedPoolChange = (poolId: string) => {
    setSelectedPoolId(poolId);

    if (routeKey === "pools" && workspaceTask !== null) {
      const returnHref = returnHrefFromAction(window.location.hash);
      if (workspaceTask === "market") {
        window.location.hash = poolDetailHref(poolId, parsePoolDiscoveryState(returnHref ?? window.location.hash));
      } else {
        const href = poolWorkspaceHref(poolId, workspaceTask);
        window.location.hash = returnHref === null
          ? href
          : `${href}?${new URLSearchParams({ returnTo: returnHref }).toString()}`;
      }
      return;
    }

    if (actionPoolId === null) return;

    const encodedPoolId = encodeURIComponent(poolId);
    window.location.hash =
      routeKey === "liquidity"
        ? `#/liquidity/${liquiditySection ?? "add"}/${encodedPoolId}`
        : `#/swap/${encodedPoolId}`;
  };

  if ((routeKey === "swap" || routeKey === "liquidity") && actionPoolId !== null && actionPool === null) {
    const actionPoolState: LoadState = actionPoolIsDeprecated
        ? "empty"
        : poolCatalogQuery.isError || directActionPoolQuery.isError
        ? "error"
        : poolCatalogQuery.isLoading || directActionPoolQuery.isLoading
          ? "loading"
          : "empty";
    return (
      <RequestedPoolState
        error={directActionPoolQuery.error}
        poolId={actionPoolId}
        reason={actionPoolIsDeprecated ? "This Sepolia pool is deprecated and must remain unfunded." : null}
        state={actionPoolState}
      />
    );
  }

  if (routeKey === "swap") {
    return (
      <>
        <ActionReturnLink />
        <SwapView
          environmentKey={environmentKey}
          onRefresh={onRefresh}
          onSelectedPoolChange={handleSelectedPoolChange}
          poolOptions={actionPoolOptions}
          primaryPool={selectedPool}
          selectedPoolId={selectedPool?.id ?? ""}
          snapshot={snapshot}
        />
      </>
    );
  }

  if (routeKey === "pools") {
    if (poolDetailId !== null) {
      const detailPool = dashboardDetailPool ?? directPoolQuery.data ?? null;
      const detailState: LoadState = detailPoolIsDeprecated
        ? "empty"
        : detailPool !== null
        ? poolCatalogState
        : poolCatalogQuery.isLoading || directPoolQuery.isLoading
          ? "loading"
          : poolCatalogQuery.isError || directPoolQuery.isError
            ? "error"
            : directPoolQuery.data === null
              ? "empty"
            : snapshotState;

      if (detailPool !== null) {
        const resolvedWorkspaceTask = workspaceTask === "swap" || workspaceTask === "manage" ? workspaceTask : "create";
        const workspacePoolOptions = pools.some((pool) => pool.id === detailPool.id) ? pools : [detailPool, ...pools];
        const workspaceContent = resolvedWorkspaceTask === "swap"
          ? (
              <SwapView
                environmentKey={environmentKey}
                onRefresh={onRefresh}
                onSelectedPoolChange={handleSelectedPoolChange}
                poolOptions={workspacePoolOptions}
                primaryPool={detailPool}
                selectedPoolId={detailPool.id}
                snapshot={snapshot}
              />
            )
          : (
              <LiquidityView
                environmentKey={environmentKey}
                initialSection={resolvedWorkspaceTask === "create" ? "add" : "withdraw"}
                onRefresh={onRefresh}
                onSelectedPoolChange={handleSelectedPoolChange}
                poolOptions={workspacePoolOptions}
                portfolioAction={null}
                primaryPool={detailPool}
                selectedPoolId={detailPool.id}
                snapshot={snapshot}
                snapshotQueryErrored={snapshotState === "error"}
              />
            );

        return (
          <PoolWorkspaceShell environmentKey={environmentKey} key={detailPool.id} pool={detailPool} pools={workspacePoolOptions}>
            {workspaceContent}
          </PoolWorkspaceShell>
        );
      }

      return (
        <RequestedPoolState
          error={directPoolQuery.error}
          poolId={poolDetailId}
          reason={detailPoolIsDeprecated ? "This Sepolia pool is deprecated and must remain unfunded." : null}
          state={detailState}
        />
      );
    }

    return (
      <PoolsView
        catalogPools={catalogPools}
        environmentKey={environmentKey}
        onConfirmedPool={setSafeConfirmedPoolOverlay}
        onCatalogRefresh={refreshPoolCatalog}
        onRefresh={onRefresh}
        pools={pools}
        rpcOverlay={confirmedPoolOverlay !== null && !overlayIndexed ? confirmedPoolOverlay : null}
        snapshot={snapshot}
        snapshotState={poolCatalogState}
      />
    );
  }

  if (routeKey === "liquidity") {
    return (
      <>
        <ActionReturnLink />
        <LiquidityView
          environmentKey={environmentKey}
          initialSection={liquiditySection}
          onRefresh={onRefresh}
          onSelectedPoolChange={handleSelectedPoolChange}
          poolOptions={actionPoolOptions}
          portfolioAction={portfolioAction}
          primaryPool={selectedPool}
          selectedPoolId={selectedPool?.id ?? ""}
          snapshot={snapshot}
          snapshotQueryErrored={snapshotState === "error"}
        />
      </>
    );
  }

  if (routeKey === "positions") {
    return <PositionsView environmentKey={environmentKey} positionDetailId={positionDetailId} snapshot={snapshot} />;
  }

  return <ActivityView snapshot={snapshot} />;
}

function ActionReturnLink() {
  const returnHref = returnHrefFromAction(window.location.hash);
  if (returnHref === null) return null;
  return <a className="back-link action-return-link" data-testid="pool-action-back" href={returnHref}>← Back to pool workspace</a>;
}

function RequestedPoolState({
  error,
  poolId,
  reason,
  state
}: {
  error: Error | null;
  poolId: string;
  reason?: string | null;
  state: LoadState;
}) {
  return (
    <div className="view-grid">
      <section className="table-panel" data-testid="requested-pool-state">
        <div className="panel-heading">
          <span>Resolving requested pool</span>
          <StatusBadge state={state} label={formatCompactAddress(poolId)} />
        </div>
        <EmptyState state={state} />
        {error ? <p className="inline-error">{getWriteError(error) ?? "Requested pool lookup failed"}</p> : null}
        {state === "empty" ? <p className="inline-error">{reason ?? "The requested pool was not found."}</p> : null}
      </section>
    </div>
  );
}

function selectDefaultIndexedPool(pools: PoolRow[], preferredPoolAddress: Address | null = null): PoolRow | null {
  return (
    (preferredPoolAddress === null
      ? null
      : pools.find((pool) => isAddressEqual(pool.address, preferredPoolAddress) && poolSupportsCoreActions(pool))) ??
    pools.find((pool) => poolHasSwapLiquidity(pool) && poolSupportsCoreActions(pool)) ??
    pools.find((pool) => poolSupportsCoreActions(pool)) ??
    pools.find((pool) => poolHasSwapLiquidity(pool)) ??
    pools.at(0) ??
    null
  );
}

function poolRowsFromCatalog(
  registry: DexRegistry,
  catalog: readonly PoolCatalogEntry[],
  legacyPools: readonly PoolRow[]
): PoolRow[] {
  const legacyByAddress = new Map(legacyPools.map((pool) => [pool.address.toLowerCase(), pool]));
  const rows = catalog.flatMap((entry) => {
    if (entry.chainId !== registry.chainId) return [];
    if (isDeprecatedPool(registry, entry.pair)) return [];
    const completeCreationProvenance =
      entry.factoryAddress !== null &&
      entry.createdAtBlock !== null &&
      entry.createdAtBlockHash !== null &&
      entry.creationTransactionHash !== null &&
      entry.creationLogIndex !== null;
    if (!isLocalnetRegistry(registry) && !completeCreationProvenance) return [];
    if (entry.factoryAddress !== null && !isAddressEqual(entry.factoryAddress, registry.contracts.lbFactory)) return [];
    const legacy = legacyByAddress.get(entry.pair.toLowerCase());
    if (legacy !== undefined && (
      !isAddressEqual(legacy.tokenXAddress, entry.tokenX) ||
      !isAddressEqual(legacy.tokenYAddress, entry.tokenY) ||
      legacy.binStep !== String(entry.binStep)
    )) return [];
    const tokenX = registry.tokens[entry.tokenX.toLowerCase()] ?? null;
    const tokenY = registry.tokens[entry.tokenY.toLowerCase()] ?? null;
    return [{
      ...(legacy ?? {
        id: entry.pair,
        address: entry.pair,
        tokenXAddress: entry.tokenX,
        tokenYAddress: entry.tokenY,
        tokenX,
        tokenY,
        volumeX: "0",
        volumeY: "0",
        feesX: "0",
        feesY: "0",
        factoryAddress: entry.factoryAddress ?? registry.contracts.lbFactory,
        hooksParameters: null,
        ignoredForRouting: false,
        swapCount: "0",
        depositCount: "0"
      }),
      activeId: String(entry.activeId),
      binStep: String(entry.binStep),
      reserveX: entry.reserveX,
      reserveY: entry.reserveY,
      updatedAtBlock: entry.asOfBlock
    }];
  });
  const catalogAddresses = new Set(rows.map((pool) => pool.address.toLowerCase()));
  return [
    ...rows,
    ...(isLocalnetRegistry(registry)
      ? legacyPools.filter((pool) =>
          !catalogAddresses.has(pool.address.toLowerCase()) &&
          !isDeprecatedPool(registry, pool.address)
        )
      : [])
  ];
}

function poolSupportsCoreActions(pool: PoolRow): boolean {
  const tokens = [pool.tokenX, pool.tokenY];
  return tokens.every(
    (token) =>
      token !== null &&
      tokenAllowsAction(token, "swap") &&
      tokenAllowsAction(token, "add-liquidity") &&
      tokenAllowsAction(token, "remove-liquidity")
  );
}

function poolHasSwapLiquidity(pool: PoolRow): boolean {
  try {
    return BigInt(pool.reserveX) > 0n || BigInt(pool.reserveY) > 0n;
  } catch {
    return false;
  }
}

interface NativeSwapReceiptReview {
  direction: "native-in" | "native-out";
  gasCost: string;
  nativeAmount: string;
  tokenAmount: string;
  hash: Address;
}

interface SubmittedNativeSwapReceiptContext extends Omit<NativeSwapSubmissionBinding, "account" | "calldataFingerprint" | "hash" | "target" | "token"> {
  account: Address;
  calldataFingerprint: Hex;
  data: Hex;
  hash: Address;
  target: Address;
  token: Address;
}

function SwapView({
  environmentKey,
  onSelectedPoolChange,
  primaryPool,
  poolOptions,
  selectedPoolId,
  snapshot,
  onRefresh
}: {
  environmentKey: EnvironmentKey;
  onSelectedPoolChange: (poolId: string) => void;
  primaryPool: PoolRow | null;
  poolOptions: PoolRow[];
  selectedPoolId: string;
  snapshot: AppSnapshot | undefined;
  onRefresh: SnapshotRefetch;
}) {
  const [amount, setAmount] = usePoolDraftState("swap.amount", "1.0");
  const [routeMode, setRouteMode] = usePoolDraftState<"exact-selected" | "best">("swap.routeMode", "exact-selected");
  const [swapForY, setSwapForY] = usePoolDraftState("swap.swapForY", true);
  const [useNativeWrapper, setUseNativeWrapper] = usePoolDraftState("swap.useNativeWrapper", false);
  const [standaloneCandleInterval, setStandaloneCandleInterval] = useState<CandleInterval>("HOUR");
  const [slippageInput, setSlippageInput] = usePoolDraftState("swap.slippage", "0.5");
  const [deadlineInput, setDeadlineInput] = usePoolDraftState("swap.deadline", "20");
  const [safetyNow, setSafetyNow] = useState(() => Date.now());
  const [approvalSimulationError, setApprovalSimulationError] = useState<string | null>(null);
  const [approvalSimulationPending, setApprovalSimulationPending] = useState(false);
  const [swapSimulationError, setSwapSimulationError] = useState<string | null>(null);
  const [swapSimulationPending, setSwapSimulationPending] = useState(false);
  const [gasReviewError, setGasReviewError] = useState<string | null>(null);
  const [gasReview, setGasReview] = useState<ExactGasReview | null>(null);
  const [approvalConfirmation, setApprovalConfirmation] = useState<{ confirmedAt: number; hash: Address } | null>(null);
  const [approvalRefresh, setApprovalRefresh] = useState<ApprovalRefreshState | null>(null);
  const approvalRefreshGeneration = useRef(0);
  const swapOperationGeneration = useRef(0);
  const approvalSubmitInFlight = useRef(false);
  const swapSubmitInFlight = useRef(false);
  const nativeSwapMaxProbeRef = useRef(false);
  const nativeSwapMaxBindingRef = useRef<{ context: string; value: bigint } | null>(null);
  const latestSwapGasObservationRef = useRef<{ balance: bigint; context: string; reserve: bigint } | null>(null);
  const [nativeSwapMaxPending, setNativeSwapMaxPending] = useState(false);
  const [handledApprovalHash, setHandledApprovalHash] = useState<Address | null>(null);
  const [handledSwapHash, setHandledSwapHash] = useState<Address | null>(null);
  const [submittedApprovalReceiptContext, setSubmittedApprovalReceiptContext] = useState<string | null>(null);
  const [submittedSwapReceiptContext, setSubmittedSwapReceiptContext] = useState<string | null>(null);
  const [nativeReceiptReview, setNativeReceiptReview] = useState<NativeSwapReceiptReview | null>(null);
  const [nativeReceiptError, setNativeReceiptError] = useState<string | null>(null);
  const [submittedNativeSwapReceiptContext, setSubmittedNativeSwapReceiptContext] = useState<SubmittedNativeSwapReceiptContext | null>(null);
  const transactionJournal = useTransactionJournal();
  const registry = registries[environmentKey];
  const poolWorkspace = useOptionalPoolWorkspace();
  const analyticsEndpoint = analyticsEndpointForRegistry(registry);
  const workspaceMatchesPool = poolWorkspace !== null && primaryPool !== null && isAddressEqual(poolWorkspace.pool.address, primaryPool.address);
  const mobileWorkspaceNavigation = useMediaQuery("(max-width: 720px)") && workspaceMatchesPool;
  const candleInterval = workspaceMatchesPool ? poolWorkspace.analytics.candleInterval : standaloneCandleInterval;
  const standaloneCandleWindow = useMemo(() => {
    const end = candleBoundary(Math.floor(Date.now() / 1_000), candleInterval);
    return { end, start: end - CANDLE_LOOKBACK_SECONDS[candleInterval] };
  }, [candleInterval, environmentKey, primaryPool?.address]);
  const candleEnd = standaloneCandleWindow.end;
  const candleStart = standaloneCandleWindow.start;
  const swapCandlesQuery = useQuery({
    queryKey: ["swapCandles", environmentKey, primaryPool?.address, candleInterval, candleStart, candleEnd],
    queryFn: () => {
      if (primaryPool === null) throw new Error("Swap candle target is unavailable");
      return loadPairCandles(analyticsEndpoint, primaryPool.address, candleInterval, candleStart, candleEnd);
    },
    enabled: primaryPool !== null && !workspaceMatchesPool,
    placeholderData: (previous) => previous,
    refetchInterval: primaryPool !== null && !workspaceMatchesPool ? SNAPSHOT_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const localnetRegistry = isLocalnetRegistry(registry) ? registry : null;
  const account = useAccount();
  const activeWalletChainId = useChainId();
  const approvalWrite = useWriteContract();
  const swapWrite = useSendTransaction();
  const approvalReceipt = useWaitForTransactionReceipt({ hash: approvalWrite.data });
  const swapReceipt = useWaitForTransactionReceipt({ hash: swapWrite.data });

  const selectedPool = buildPoolDescriptor({
    action: "swap",
    localnetRegistry,
    pool: primaryPool,
    registry,
    snapshot
  });
  const tokenX = selectedPool.tokenX;
  const tokenY = selectedPool.tokenY;
  const tokenIn = swapForY ? tokenX : tokenY;
  const tokenOut = swapForY ? tokenY : tokenX;
  const tokenInAddress = swapForY ? selectedPool.tokenXAddress : selectedPool.tokenYAddress;
  const tokenOutAddress = swapForY ? selectedPool.tokenYAddress : selectedPool.tokenXAddress;
  const wrappedNativeToken = Object.values(registry.tokens).find((token) =>
    token.tags.includes("wrapped-native") && tokenAllowsAction(token, "swap")
  ) ?? null;
  const selectedPoolHasWrapper = wrappedNativeToken !== null &&
    (tokenX !== null && isAddressEqual(tokenX.address, wrappedNativeToken.address) || tokenY !== null && isAddressEqual(tokenY.address, wrappedNativeToken.address));
  const nativeInput = useNativeWrapper && wrappedNativeToken !== null && tokenInAddress !== null && isAddressEqual(tokenInAddress, wrappedNativeToken.address);
  const nativeOutput = useNativeWrapper && wrappedNativeToken !== null && tokenOutAddress !== null && isAddressEqual(tokenOutAddress, wrappedNativeToken.address);
  const inputAssetMode = nativeInput ? "native" as const : "erc20" as const;
  const outputAssetMode = nativeOutput ? "native" as const : "erc20" as const;
  const inputSymbol = nativeInput ? "ETH" : tokenSymbol(tokenIn);
  const outputSymbol = nativeOutput ? "ETH" : tokenSymbol(tokenOut);
  const parsedAmountResult = parseTokenAmount(amount, tokenIn?.decimals ?? 18);
  const parsedAmount = parsedAmountResult.amount;
  const slippageBps = parseSlippageToBps(slippageInput);
  const deadlineMinutes = parseDeadlineMinutes(deadlineInput);
  const publicClient = useMemo(() => createDexPublicClient(registry.chain, registry.endpoints.rpcUrl), [registry]);
  const connected = account.status === "connected" && account.address !== undefined;
  const onWrongChain = connected && activeWalletChainId !== registry.chainId;
  const rpcReady = runtimeIsReady(snapshot, registry.chainId);
  const swapPairClaim = primaryPool === null ? null : poolRowToPairClaim(primaryPool, "swap");
  const pairAttestationQuery = useQuery({
    queryKey: ["swapPairAttestation", deploymentEpoch(registry), swapPairClaim],
    queryFn: async () => {
      if (swapPairClaim === null) throw new PairAttestationError("unindexed-pair", "Selected pair is not present in the current indexer snapshot");
      return attestPairForWrite(publicClient, registry, swapPairClaim);
    },
    enabled: rpcReady && swapPairClaim !== null,
    refetchInterval: rpcReady && swapPairClaim !== null ? 10_000 : false,
    retry: false
  });
  const swapMarketError = swapMarketReadinessError(selectedPool, rpcReady);
  const swapMarketReady = swapMarketError === null;
  const swapExecutionContext: SwapExecutionContext = {
    activeId: selectedPool.activeId,
    amountIn: parsedAmount?.toString() ?? null,
    binStep: selectedPool.binStep,
    deadlineMinutes,
    environment: environmentKey,
    pair: selectedPool.pair,
    poolId: (primaryPool?.id ?? selectedPoolId) || null,
    registryChainId: registry.chainId,
    reserveX: selectedPool.reserveX?.toString() ?? null,
    reserveY: selectedPool.reserveY?.toString() ?? null,
    routeMode,
    inputAssetMode,
    outputAssetMode,
    rpcChainId: snapshot?.runtime.chainId ?? null,
    slippageBps: slippageBps?.toString() ?? null,
    tokenIn: tokenInAddress,
    tokenOut: tokenOutAddress,
    updatedAtBlock: primaryPool?.updatedAtBlock ?? null,
    walletAddress: account.address ?? null,
    walletChainId: activeWalletChainId
  };
  const swapContextFingerprint = swapExecutionContextFingerprint(swapExecutionContext);
  const swapMaxContextFingerprint = swapExecutionContextFingerprint({ ...swapExecutionContext, amountIn: null });
  const swapOperationContext = useRef(swapContextFingerprint);
  if (swapOperationContext.current !== swapContextFingerprint) {
    swapOperationContext.current = swapContextFingerprint;
    swapOperationGeneration.current += 1;
    approvalSubmitInFlight.current = false;
    swapSubmitInFlight.current = false;
  }
  const latestSwapContextFingerprint = useRef(swapContextFingerprint);
  latestSwapContextFingerprint.current = swapContextFingerprint;
  const approvalIntentFingerprint = swapExecutionContextFingerprint({
    ...swapExecutionContext,
    activeId: null,
    reserveX: null,
    reserveY: null,
    updatedAtBlock: null
  });
  const latestApprovalIntentFingerprint = useRef(approvalIntentFingerprint);
  latestApprovalIntentFingerprint.current = approvalIntentFingerprint;

  useEffect(() => {
    return () => {
      swapOperationGeneration.current += 1;
      approvalSubmitInFlight.current = false;
      swapSubmitInFlight.current = false;
    };
  }, []);

  const approvalRefreshReady =
    approvalConfirmation === null ||
    (approvalRefresh?.status === "ready" &&
      approvalRefresh.hash === approvalConfirmation.hash &&
      approvalRefresh.intentFingerprint === approvalIntentFingerprint);
  const approvalConfirmationKey =
    approvalConfirmation === null
      ? "pre-approval"
      : approvalRefreshReady
        ? `${approvalConfirmation.hash}:${swapContextFingerprint}`
        : `${approvalConfirmation.hash}:refreshing`;
  const canQuote = approvalRefreshReady && swapMarketReady && parsedAmount !== null && parsedAmount > 0n;
  const quoteQuery = useQuery({
    queryKey: ["swapQuote", swapContextFingerprint, approvalConfirmationKey],
    queryFn: async () => {
      if (!swapMarketReady || tokenInAddress === null || tokenOutAddress === null || parsedAmount === null) {
        throw new Error("Swap quote is not available");
      }
      let quote: ExactInQuote;
      if (routeMode === "best") {
        quote = await getBestExactInQuote(publicClient, registry, tokenInAddress, tokenOutAddress, parsedAmount);
      } else {
        const { binStep, pair, tokenXAddress, tokenYAddress } = selectedPool;
        if (pair === null || binStep === null || tokenXAddress === null || tokenYAddress === null) {
          throw new Error("Exact selected-pool identity is unavailable");
        }
        quote = await getSelectedPairExactInQuote(publicClient, registry, {
            amountIn: parsedAmount,
            binStep: BigInt(binStep),
            ...(snapshot?.runtime.blockNumber === null || snapshot?.runtime.blockNumber === undefined
              ? {}
              : { blockNumber: BigInt(snapshot.runtime.blockNumber) }),
            pair,
            tokenIn: tokenInAddress,
            tokenOut: tokenOutAddress,
            tokenX: tokenXAddress,
            tokenY: tokenYAddress
          });
      }

      return {
        approvalHash: approvalConfirmation?.hash ?? null,
        contextFingerprint: swapContextFingerprint,
        quote: serializeExactInQuote(quote),
        reviewedAt: Math.max(Date.now(), (approvalConfirmation?.confirmedAt ?? 0) + 1)
      };
    },
    enabled: canQuote,
    refetchInterval: canQuote ? SWAP_QUOTE_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const walletQuery = useQuery({
    queryKey: ["swapWallet", registry.chainId, tokenInAddress, inputAssetMode, account.address, approvalConfirmationKey],
    queryFn: async () => {
      if (tokenInAddress === null || !account.address) {
        throw new Error("Wallet reads are not available");
      }

      const nativeBalance = await publicClient.getBalance({ address: account.address });
      if (nativeInput) {
        return {
          approvalHash: approvalConfirmation?.hash ?? null,
          balance: nativeBalance.toString(),
          allowance: ((1n << 256n) - 1n).toString(),
          nativeBalance: nativeBalance.toString()
        };
      }
      const [balance, allowance] = await Promise.all([
        publicClient.readContract({
          address: tokenInAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address]
        }),
        publicClient.readContract({
          address: tokenInAddress,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account.address, registry.contracts.lbRouter]
        })
      ]);

      return {
        approvalHash: approvalConfirmation?.hash ?? null,
        balance: balance.toString(),
        allowance: allowance.toString(),
        nativeBalance: nativeBalance.toString()
      };
    },
    enabled: approvalRefreshReady && connected && swapMarketReady && tokenInAddress !== null,
    refetchInterval: approvalRefreshReady && connected && swapMarketReady ? 10_000 : false,
    retry: false
  });
  const contextualQuote = quoteQuery.data;
  const quoteContextMatches =
    approvalRefreshReady &&
    swapMarketReady &&
    contextualQuote?.contextFingerprint === swapContextFingerprint &&
    contextualQuote.approvalHash === (approvalConfirmation?.hash ?? null);
  const quote = quoteContextMatches ? contextualQuote?.quote : undefined;
  const exactQuote = quote ? deserializeExactInQuote(quote) : null;
  const attestCurrentSwapRoute = async () => {
    if (exactQuote === null) throw new PairAttestationError("missing-route", "A current quote is required for live pair attestation");
    return attestSwapRouteForWrite(publicClient, registry, {
      binSteps: exactQuote.binSteps,
      pairs: exactQuote.pairs,
      pools: poolOptions,
      resolvePool: (pair) => {
        if (isDeprecatedPool(registry, pair)) {
          throw new PairAttestationError("pair-mismatch", "The quoted route includes a deprecated pool that must remain unfunded");
        }
        return loadPoolById(registry, pair);
      },
      route: exactQuote.route,
      versions: exactQuote.versions
    });
  };
  const routeAttestationQuery = useQuery({
    queryKey: [
      "swapRouteAttestation",
      deploymentEpoch(registry),
      quote,
      snapshot?.indexer.blockHash ?? null,
      exactQuote?.pairs.map((pair) => {
        const pool = poolOptions.find((candidate) => candidate.address.toLowerCase() === pair.toLowerCase());
        return pool ? [pool.address, pool.factoryAddress, pool.tokenXAddress, pool.tokenYAddress, pool.binStep, pool.hooksParameters, pool.ignoredForRouting, pool.updatedAtBlock] : [pair, "resolved-by-id"];
      }) ?? []
    ],
    queryFn: attestCurrentSwapRoute,
    enabled: rpcReady && exactQuote !== null,
    refetchInterval: rpcReady && exactQuote !== null ? 10_000 : false,
    retry: false
  });
  const amountOut = exactQuote ? getQuoteAmountOut(exactQuote) : null;
  const amountOutMin = exactQuote && amountOut !== null && slippageBps !== null ? calculateAmountOutMin(amountOut, slippageBps) : null;
  const routeSteps = exactQuote ? quoteToRouteStepViews(exactQuote, tokenIn, tokenOut) : [];
  const quoteUpdatedAt = quote !== undefined && quoteContextMatches ? contextualQuote.reviewedAt : null;
  const swapQuoteIdentity = quote !== undefined && quoteUpdatedAt !== null ? `${swapContextFingerprint}:${quoteUpdatedAt}` : null;
  const latestSwapQuoteIdentity = useRef(swapQuoteIdentity);
  latestSwapQuoteIdentity.current = swapQuoteIdentity;
  const priceImpactBps = exactQuote ? estimatePriceImpactBps(exactQuote) ?? 0n : null;
  const walletBalance = walletQuery.data ? BigInt(walletQuery.data.balance) : null;
  const walletAllowance = walletQuery.data ? BigInt(walletQuery.data.allowance) : null;
  const nativeBalance = walletQuery.data ? BigInt(walletQuery.data.nativeBalance) : null;
  const walletReadsMatchApproval = walletQuery.data?.approvalHash === (approvalConfirmation?.hash ?? null);
  const walletReadsReady = walletReadsMatchApproval && walletBalance !== null && walletAllowance !== null && nativeBalance !== null;
  const walletError = walletQuery.error ? `Wallet read failed: ${getWriteError(walletQuery.error) ?? "balance and allowance unavailable"}` : null;
  const walletReadsPending = connected && swapMarketReady && tokenInAddress !== null && !walletReadsReady && walletError === null;
  const needsApproval = !nativeInput && parsedAmount !== null && walletAllowance !== null && walletAllowance < parsedAmount;
  const insufficientBalance = parsedAmount !== null && walletBalance !== null && walletBalance < parsedAmount;
  const expectedOutLabel = amountOut !== null ? nativeOutput ? `${formatUnits(amountOut, 18)} ETH` : formatTokenAmount(amountOut.toString(), tokenOut) : "n/a";
  const feeLabel = exactQuote ? formatBps(getTotalFeeBps(exactQuote)) : "n/a";
  const priceImpactLabel = priceImpactBps !== null ? formatBps(priceImpactBps) : "n/a";
  const quoteFreshnessLabel = formatQuoteFreshness(quoteUpdatedAt, safetyNow);
  const approvalReceiptMatchesCurrentIntent = submittedApprovalReceiptContext === approvalIntentFingerprint;
  const swapReceiptMatchesCurrentIntent = submittedSwapReceiptContext === approvalIntentFingerprint;
  const approvalSuccess = approvalReceiptMatchesCurrentIntent && approvalReceipt.data?.status === "success";
  const approvalReverted = approvalReceiptMatchesCurrentIntent && (approvalReceipt.data?.status === "reverted" || isRevertedReceiptError(approvalReceipt.error));
  const swapSuccess = swapReceiptMatchesCurrentIntent && swapReceipt.data?.status === "success";
  const swapReverted = swapReceiptMatchesCurrentIntent && (swapReceipt.data?.status === "reverted" || isRevertedReceiptError(swapReceipt.error));
  const quoteRequestMismatch =
    exactQuote !== null &&
    (tokenInAddress === null ||
      tokenOutAddress === null ||
      parsedAmount === null ||
      !quoteMatchesSwapRequest(exactQuote, tokenInAddress, tokenOutAddress, parsedAmount));
  const approvalReceiptAwaitingRefresh =
    approvalSuccess && approvalWrite.data !== undefined && approvalWrite.data !== approvalConfirmation?.hash;
  const postApprovalReviewPending =
    approvalReceiptAwaitingRefresh ||
    (approvalConfirmation !== null &&
      (!approvalRefreshReady || quoteUpdatedAt === null || quoteUpdatedAt <= approvalConfirmation.confirmedAt || !walletReadsReady));
  const postApprovalRefreshError =
    approvalConfirmation === null
      ? null
      : approvalRefresh?.error ??
        (approvalRefresh?.intentFingerprint !== approvalIntentFingerprint
          ? "Swap context changed after approval confirmation; return to the reviewed settings and refresh again"
          : null) ??
        walletError ??
        (quoteQuery.error
          ? `Post-approval quote refresh failed: ${getWriteError(quoteQuery.error) ?? "quote unavailable"}`
          : null);
  const approvalRefreshRetryRequired =
    approvalConfirmation !== null &&
    !approvalRefreshReady &&
    (approvalRefresh?.status === "error" || approvalRefresh?.intentFingerprint !== approvalIntentFingerprint);
  const swapSafety = evaluateTransactionSafety(
    {
      connected,
      deadlineMinutes,
      intent: "swap",
      needsApproval,
      onWrongChain,
      priceImpactBps,
      quoteUpdatedAt,
      rpcReady,
      slippageBps
    },
    safetyNow
  );
  const swapSafetyReason = connected && !onWrongChain && quote !== undefined && swapSafety.blocked ? swapSafety.reason : null;
  const swapApprovalDisclosure = approvalDisclosure({
    amount: parsedAmount,
    spender: registry.contracts.lbRouter,
    tokenSymbol: tokenSymbol(tokenIn)
  });
  const inputError =
    parsedAmountResult.error !== null
      ? tokenAmountErrorMessage(parsedAmountResult.error, tokenIn?.decimals ?? 18)
      : slippageBps === null
          ? "Enter slippage between 0% and 100%"
          : slippageBps > DANGEROUS_SLIPPAGE_BPS
            ? "Slippage exceeds 10% safety limit"
            : deadlineMinutes === null
              ? "Enter a deadline from 1 to 120 minutes"
              : priceImpactBps !== null && priceImpactBps >= BLOCKING_PRICE_IMPACT_BPS
                ? "Price impact exceeds 15% safety limit"
                : quoteUpdatedAt !== null && quoteIsStale(quoteUpdatedAt, safetyNow)
                  ? "Quote is stale; refresh before swapping"
                  : quoteRequestMismatch
                    ? "Quoted route does not match the current token pair and amount"
                  : !swapMarketReady
                    ? swapMarketError
                    : postApprovalReviewPending
                      ? postApprovalRefreshError ?? "Refreshing balance, allowance, and quote after approval"
                    : null;
  const canApprove =
    swapMarketReady &&
    connected &&
    !onWrongChain &&
    walletReadsReady &&
    tokenInAddress !== null &&
    parsedAmount !== null &&
    parsedAmount > 0n &&
    needsApproval &&
    quote !== undefined &&
    !quoteRequestMismatch &&
    inputError === null &&
    !swapSafety.blocked &&
    !insufficientBalance &&
    routeAttestationQuery.data !== undefined &&
    routeAttestationQuery.error === null &&
    approvalSimulationError === null &&
    !approvalSimulationPending;
  const canSwap =
    swapMarketReady &&
    connected &&
    !onWrongChain &&
    walletReadsReady &&
    quote !== undefined &&
    !quoteRequestMismatch &&
    parsedAmount !== null &&
    amountOutMin !== null &&
    deadlineMinutes !== null &&
    inputError === null &&
    !swapSafety.blocked &&
    swapSimulationError === null &&
    !swapSimulationPending &&
    !postApprovalReviewPending &&
    !needsApproval &&
    !insufficientBalance &&
    routeAttestationQuery.data !== undefined &&
    routeAttestationQuery.error === null &&
    !swapWrite.isPending &&
    !swapReceipt.isLoading;
  const actionError =
    approvalSimulationError ??
    swapSimulationError ??
    gasReviewError ??
    (approvalReceiptMatchesCurrentIntent ? getWriteError(approvalWrite.error) : null) ??
    (swapReceiptMatchesCurrentIntent ? getWriteError(swapWrite.error) : null) ??
    (approvalReceiptMatchesCurrentIntent ? getWriteError(approvalReceipt.error) : null) ??
    (swapReceiptMatchesCurrentIntent ? getWriteError(swapReceipt.error) : null);
  const startApprovalRefresh = (hash: Address, confirmedAt: number, intentFingerprint: string) => {
    const generation = approvalRefreshGeneration.current + 1;
    approvalRefreshGeneration.current = generation;
    setApprovalRefresh({
      confirmedAt,
      error: null,
      generation,
      hash,
      intentFingerprint,
      refreshedContextFingerprint: null,
      snapshotIdentity: null,
      status: "refreshing"
    });
    void onRefresh()
      .then((result) => {
        setApprovalRefresh((current) => {
          if (
            current?.hash !== hash ||
            current.intentFingerprint !== intentFingerprint ||
            current.generation !== generation ||
            current.status !== "refreshing"
          ) return current;
          if (latestApprovalIntentFingerprint.current !== intentFingerprint) {
            return {
              ...current,
              error: "Swap context changed while refreshing the selected market after approval; restore or review the settings, then refresh again",
              status: "error"
            };
          }
          if (result.isError || result.data === undefined) {
            return {
              ...current,
              error: `Selected-market refresh failed after approval: ${getWriteError(result.error) ?? "snapshot unavailable"}`,
              status: "error"
            };
          }

          return {
            ...current,
            snapshotIdentity: swapSnapshotIdentity(result.data, primaryPool?.id ?? selectedPoolId),
            status: "awaiting-render"
          };
        });
      })
      .catch((error) => {
        setApprovalRefresh((current) =>
          current?.hash === hash &&
          current.intentFingerprint === intentFingerprint &&
          current.generation === generation &&
          current.status === "refreshing"
            ? {
                ...current,
                error: `Selected-market refresh failed after approval: ${getWriteError(error) ?? "snapshot unavailable"}`,
                status: "error"
              }
            : current
        );
      });
  };
  const retryApprovalRefresh = () => {
    if (approvalConfirmation === null) return;
    startApprovalRefresh(approvalConfirmation.hash, approvalConfirmation.confirmedAt, approvalIntentFingerprint);
  };

  useEffect(() => {
    const interval = window.setInterval(() => setSafetyNow(Date.now()), 1_000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setApprovalSimulationError(null);
    setSwapSimulationError(null);
    setGasReviewError(null);
    setGasReview(null);
  }, [swapContextFingerprint, swapQuoteIdentity]);

  useEffect(() => {
    if (approvalSuccess && approvalWrite.data && approvalWrite.data !== handledApprovalHash) {
      const hash = approvalWrite.data;
      const confirmedAt = Date.now();
      const intentFingerprint = approvalIntentFingerprint;
      setApprovalConfirmation({ confirmedAt, hash });
      startApprovalRefresh(hash, confirmedAt, intentFingerprint);
      setHandledApprovalHash(hash);
    }

    if (swapSuccess && swapWrite.data && swapWrite.data !== handledSwapHash) {
      void walletQuery.refetch();
      onRefresh();
      setHandledSwapHash(swapWrite.data);
    }
  }, [
    approvalSuccess,
    approvalIntentFingerprint,
    approvalWrite.data,
    handledApprovalHash,
    handledSwapHash,
    onRefresh,
    primaryPool?.id,
    selectedPoolId,
    swapSuccess,
    swapWrite.data,
    walletQuery
  ]);

  const nativeReceiptIdentity = swapReceipt.data
    ? [swapReceipt.data.transactionHash, swapReceipt.data.blockHash, swapReceipt.data.blockNumber.toString(), swapReceipt.data.status].join(":")
    : null;
  const submittedNativeSwapFingerprint = submittedNativeSwapReceiptContext === null
    ? null
    : nativeSwapSubmissionFingerprint(submittedNativeSwapReceiptContext);
  const activeSwapJournalRecord = submittedNativeSwapReceiptContext === null
    ? null
    : transactionJournal.records.find((record) =>
        record.reviewed.intent === "swap" &&
        (
          record.activeHash?.toLowerCase() === submittedNativeSwapReceiptContext.hash.toLowerCase() ||
          record.hashes.some((candidate) => candidate.hash.toLowerCase() === submittedNativeSwapReceiptContext.hash.toLowerCase())
        )
      ) ?? null;
  useEffect(() => {
    if (submittedNativeSwapReceiptContext === null || !swapReceipt.data || activeSwapJournalRecord === null) return;
    let cancelled = false;
    const receipt = swapReceipt.data;
    const submitted = submittedNativeSwapReceiptContext;
    if (receipt.blockNumber === 0n) return;
    void (async () => {
      try {
        if (receipt.transactionHash.toLowerCase() !== submitted.hash.toLowerCase()) throw new Error("Native swap receipt hash differs from the submitted context");
        if (receipt.status !== "success") throw new Error("Native swap receipt did not succeed");
        if (
          !isAddressEqual(activeSwapJournalRecord.reviewed.account, submitted.account) ||
          !isAddressEqual(activeSwapJournalRecord.reviewed.target, submitted.target) ||
          activeSwapJournalRecord.reviewed.calldataFingerprint.toLowerCase() !== submitted.calldataFingerprint.toLowerCase() ||
          activeSwapJournalRecord.reviewed.executionFingerprint !== submitted.executionFingerprint ||
          activeSwapJournalRecord.reviewed.value.toString() !== submitted.transactionValue
        ) throw new Error("Native swap journal context differs from the immutable submitted context");
        const beforeBlockNumber = receipt.blockNumber - 1n;
        const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
        if (canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("Native swap receipt block is not canonical");
        const canonicalTransaction = await publicClient.getTransaction({ hash: submitted.hash as Address });
        if (
          !isAddressEqual(canonicalTransaction.from, submitted.account) ||
          canonicalTransaction.to === null ||
          !isAddressEqual(canonicalTransaction.to, submitted.target) ||
          canonicalTransaction.input.toLowerCase() !== submitted.data.toLowerCase() ||
          keccak256(canonicalTransaction.input).toLowerCase() !== submitted.calldataFingerprint.toLowerCase() ||
          canonicalTransaction.value.toString() !== submitted.transactionValue
        ) throw new Error("Canonical native swap transaction differs from the immutable submitted context");
        const [nativeBalanceBefore, nativeBalanceAfter, tokenBalanceBefore, tokenBalanceAfter] = await Promise.all([
          publicClient.getBalance({ address: submitted.account as Address, blockNumber: beforeBlockNumber }),
          publicClient.getBalance({ address: submitted.account as Address, blockNumber: receipt.blockNumber }),
          publicClient.readContract({ address: submitted.token as Address, abi: erc20Abi, functionName: "balanceOf", args: [submitted.account as Address], blockNumber: beforeBlockNumber }),
          publicClient.readContract({ address: submitted.token as Address, abi: erc20Abi, functionName: "balanceOf", args: [submitted.account as Address], blockNumber: receipt.blockNumber })
        ]);
        let loggedTokenAmount = 0n;
        for (const log of receipt.logs) {
          if (!isAddressEqual(log.address, submitted.token)) continue;
          try {
            const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
            if (decoded.eventName !== "Transfer") continue;
            const args = decoded.args as { from: Address; to: Address; value: bigint };
            if (submitted.direction === "native-in" && isAddressEqual(args.to, submitted.account)) loggedTokenAmount += args.value;
            if (submitted.direction === "native-out" && isAddressEqual(args.from, submitted.account)) loggedTokenAmount += args.value;
          } catch {
            // Non-Transfer logs from the token do not contribute to received/spent accounting.
          }
        }
        const submittedAmountIn = BigInt(submitted.amountIn);
        const submittedAmountOutMin = BigInt(submitted.amountOutMin);
        const submittedValue = BigInt(submitted.transactionValue);
        if (submitted.direction === "native-in" && loggedTokenAmount < submittedAmountOutMin) throw new Error("Native-input receipt transfer logs are below the reviewed minimum");
        if (submitted.direction === "native-out" && loggedTokenAmount !== submittedAmountIn) throw new Error("Native-output receipt transfer logs differ from the reviewed input");
        const accounting = reconcileNativeSwapReceipt({
          amountIn: submittedAmountIn,
          amountOutMin: submittedAmountOutMin,
          direction: submitted.direction,
          effectiveGasPrice: receipt.effectiveGasPrice,
          gasUsed: receipt.gasUsed,
          nativeBalanceAfter,
          nativeBalanceBefore,
          tokenBalanceAfter,
          tokenBalanceBefore,
          transactionValue: submittedValue
        });
        const postRead = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
        if (postRead.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("Native swap receipt block reorganized during accounting");
        if (!cancelled) {
          setNativeReceiptReview({
            direction: accounting.direction,
            gasCost: accounting.gasCost.toString(),
            nativeAmount: accounting.nativeAmount.toString(),
            tokenAmount: accounting.tokenAmount.toString(),
            hash: submitted.hash as Address
          });
          setNativeReceiptError(null);
        }
      } catch (error) {
        if (!cancelled) {
          const message = getWriteError(error) ?? "unknown accounting error";
          setNativeReceiptReview(null);
          setNativeReceiptError(`Native swap receipt reconciliation failed closed: ${message}`);
          if (/differs from the (?:immutable )?submitted context|journal context differs/i.test(message)) {
            setSubmittedNativeSwapReceiptContext(null);
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeSwapJournalRecord, nativeReceiptIdentity, submittedNativeSwapFingerprint]);

  useEffect(() => {
    if (activeSwapJournalRecord?.status === "orphaned" || activeSwapJournalRecord?.replacementCompatibility === "incompatible") {
      setNativeReceiptReview(null);
      setNativeReceiptError(activeSwapJournalRecord.status === "orphaned"
        ? "Native swap receipt was reorganized; canonical accounting was removed and retry remains journal-blocked"
        : "Native swap replacement differs from the submitted calldata or value; canonical accounting was cleared");
      setSubmittedNativeSwapReceiptContext(null);
    }
  }, [activeSwapJournalRecord?.replacementCompatibility, activeSwapJournalRecord?.status]);

  useEffect(() => {
    if (approvalRefresh?.status !== "awaiting-render") return;
    if (approvalRefresh.intentFingerprint !== approvalIntentFingerprint) {
      setApprovalRefresh((current) =>
        current?.status === "awaiting-render"
          ? {
              ...current,
              error: "Swap context changed while refreshing the selected market after approval; review and try again",
              status: "error"
            }
          : current
      );
      return;
    }
    if (swapSnapshotIdentity(snapshot, primaryPool?.id ?? selectedPoolId) !== approvalRefresh.snapshotIdentity) return;
    if (!swapMarketReady) {
      setApprovalRefresh((current) =>
        current?.status === "awaiting-render"
          ? {
              ...current,
              error: `Selected market is unsafe after approval refresh: ${swapMarketError ?? "market unavailable"}`,
              status: "error"
            }
          : current
      );
      return;
    }

    setApprovalRefresh((current) =>
      current?.status === "awaiting-render"
        ? { ...current, refreshedContextFingerprint: swapContextFingerprint, status: "ready" }
        : current
    );
  }, [
    approvalIntentFingerprint,
    approvalRefresh,
    primaryPool?.id,
    selectedPoolId,
    snapshot,
    swapContextFingerprint,
    swapMarketError,
    swapMarketReady
  ]);

  const handleApprove = async () => {
    if (approvalSubmitInFlight.current || !canApprove || tokenInAddress === null || !account.address || parsedAmount === null) return;
    approvalSubmitInFlight.current = true;
    approvalWrite.reset();
    setSubmittedApprovalReceiptContext(null);
    setGasReviewError(null);
    try {

    try {
      await attestCurrentSwapRoute();
    } catch (error) {
      setApprovalSimulationError(getWriteError(error));
      return;
    }

    try {
      assertExecutableTokenAction([tokenIn], "swap");
    } catch (error) {
      setApprovalSimulationError(getWriteError(error));
      return;
    }

    const simulatedContextFingerprint = swapContextFingerprint;
    const simulatedQuoteIdentity = swapQuoteIdentity;
    const operationGeneration = swapOperationGeneration.current;
    const args = [registry.contracts.lbRouter, parsedAmount] as const;
    const simulated = await runPreSubmitSimulation(
      () =>
        publicClient.simulateContract({
          account: account.address,
          address: tokenInAddress,
          abi: erc20Abi,
          functionName: "approve",
          args
        }),
      setApprovalSimulationError,
      setApprovalSimulationPending
    );

    if (!simulated) return;
    if (simulated.result !== true) {
      setApprovalSimulationError("Approval simulation did not return true; this token is excluded");
      return;
    }
    if (
      latestSwapContextFingerprint.current !== simulatedContextFingerprint ||
      latestSwapQuoteIdentity.current !== simulatedQuoteIdentity ||
      swapOperationGeneration.current !== operationGeneration ||
      quoteIsStale(quoteUpdatedAt, Date.now())
    ) {
      setApprovalSimulationError("Execution context changed during simulation; refresh and try again");
      return;
    }
    const gasReviewIsCurrent = () =>
      swapOperationGeneration.current === operationGeneration &&
      latestSwapContextFingerprint.current === simulatedContextFingerprint &&
      latestSwapQuoteIdentity.current === simulatedQuoteIdentity &&
      !quoteIsStale(quoteUpdatedAt, Date.now());
    const gasApproved = await reviewExactGas({
      action: `${tokenSymbol(tokenIn)} approval`,
      currentReview: gasReview,
      estimateGas: () => publicClient.estimateContractGas(simulated.request),
      executionFingerprint: simulatedContextFingerprint,
      getBalance: () => publicClient.getBalance({ address: account.address }),
      getGasPrice: () => publicClient.getGasPrice(),
      isCurrent: gasReviewIsCurrent,
      setError: setGasReviewError,
      setReview: setGasReview
    });
    if (!gasApproved || !gasReviewIsCurrent()) return;
    try {
      await attestCurrentSwapRoute();
    } catch (error) {
      setApprovalSimulationError(getWriteError(error));
      return;
    }
    const submittedContext = {
      account: account.address,
      calldataFingerprint: keccak256(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args })),
      chainId: activeWalletChainId,
      deploymentEpoch: deploymentEpoch(registry),
      environment: environmentKey,
      executionFingerprint: simulatedContextFingerprint,
      intent: "approval" as const,
      providerId: account.connector?.id ?? "unknown",
      providerUid: account.connector?.uid ?? "unknown",
      submittedAt: Date.now(),
      target: tokenInAddress,
      value: 0n
    };
    try {
      setSubmittedApprovalReceiptContext(approvalIntentFingerprint);
      await submitJournaledTransaction({
        isCurrent: gasReviewIsCurrent,
        journal: transactionJournal,
        reviewed: reviewedTransactionIntent(submittedContext, {
          poolId: (primaryPool?.id ?? selectedPoolId) || null,
          recipient: null,
          refundRecipient: null,
          settingsFingerprint: [account.address, activeWalletChainId, tokenInAddress, registry.contracts.lbRouter, parsedAmount.toString()].join("|")
        }),
        preWalletGuard: async () => {
          await attestCurrentSwapRoute();
          if (!gasReviewIsCurrent()) throw new PairAttestationError("context-changed", "Swap context changed during final pair attestation");
        },
        send: () => approvalWrite.writeContractAsync(simulated.request)
      });
    } catch (error) {
      if (!isUserRejectedSubmission(error)) setApprovalSimulationError(getWriteError(error) ?? "Transaction journal blocked approval submission");
      // The wagmi mutation retains the rejection for the originating mounted session.
    }
    } finally {
      approvalSubmitInFlight.current = false;
    }
  };

  const handleSwap = async () => {
    if (swapSubmitInFlight.current || !canSwap || !account.address || !exactQuote || parsedAmount === null || amountOutMin === null || deadlineMinutes === null) return;
    const nativeMaxProbe = nativeSwapMaxProbeRef.current;
    swapSubmitInFlight.current = true;
    swapWrite.reset();
    setSubmittedSwapReceiptContext(null);
    setGasReviewError(null);
    setNativeReceiptReview(null);
    setNativeReceiptError(null);
    setSubmittedNativeSwapReceiptContext(null);
    try {

    try {
      await attestCurrentSwapRoute();
    } catch (error) {
      setSwapSimulationError(getWriteError(error));
      return;
    }

    try {
      assertExecutableTokenAction([tokenIn, tokenOut], "swap");
    } catch (error) {
      setSwapSimulationError(getWriteError(error));
      return;
    }

    const simulatedContextFingerprint = swapContextFingerprint;
    const simulatedQuoteIdentity = swapQuoteIdentity;
    const operationGeneration = swapOperationGeneration.current;
    const deadline = deadlineFromNow(deadlineMinutes);
    if ((nativeInput || nativeOutput) && wrappedNativeToken === null) {
      setSwapSimulationError("Router wrapped-native identity is unavailable");
      return;
    }
    const transaction = nativeInput
      ? buildExactNativeForTokensSwapTransaction(registry, wrappedNativeToken!.address, exactQuote, parsedAmount, amountOutMin, account.address, deadline)
      : nativeOutput
        ? buildExactTokensForNativeSwapTransaction(registry, wrappedNativeToken!.address, exactQuote, parsedAmount, amountOutMin, account.address, deadline)
        : buildExactInSwapTransaction(registry, exactQuote, parsedAmount, amountOutMin, account.address, deadline);
    const simulated = await runPreSubmitSimulation(
      () => publicClient.call({ account: account.address, ...transaction }),
      setSwapSimulationError,
      setSwapSimulationPending
    );

    if (!simulated) return;
    if (
      latestSwapContextFingerprint.current !== simulatedContextFingerprint ||
      latestSwapQuoteIdentity.current !== simulatedQuoteIdentity ||
      swapOperationGeneration.current !== operationGeneration ||
      quoteIsStale(quoteUpdatedAt, Date.now())
    ) {
      setSwapSimulationError("Execution context changed during simulation; refresh the quote and try again");
      return;
    }
    const gasReviewIsCurrent = () =>
      swapOperationGeneration.current === operationGeneration &&
      latestSwapContextFingerprint.current === simulatedContextFingerprint &&
      latestSwapQuoteIdentity.current === simulatedQuoteIdentity &&
      !quoteIsStale(quoteUpdatedAt, Date.now());
    const gasObservation: { value: { balance: bigint; review: ExactGasReview } | null } = { value: null };
    const gasApproved = await reviewExactGas({
      action: "swap",
      currentReview: gasReview,
      estimateGas: () => publicClient.estimateGas({ account: account.address, ...transaction }),
      executionFingerprint: simulatedContextFingerprint,
      getBalance: () => publicClient.getBalance({ address: account.address }),
      getGasPrice: () => publicClient.getGasPrice(),
      isCurrent: gasReviewIsCurrent,
      setError: setGasReviewError,
      setReview: setGasReview,
      onReview: (review, nativeBalance) => {
        gasObservation.value = { balance: nativeBalance, review };
        latestSwapGasObservationRef.current = { balance: nativeBalance, context: swapMaxContextFingerprint, reserve: review.bufferedWei };
        if (!nativeMaxProbe) return;
        const max = safeMaxAmount({ asset: "native", balance: nativeBalance, gasReserveWei: review.bufferedWei });
        if (max === 0n) {
          setGasReviewError("Native Max is unavailable because the wallet balance does not exceed the reviewed gas reserve");
          return;
        }
        nativeSwapMaxBindingRef.current = { context: swapMaxContextFingerprint, value: max };
        setAmount(maxAmountInput({ asset: "native", balance: nativeBalance, decimals: 18, gasReserveWei: review.bufferedWei }));
      },
      transactionValue: transaction.value
    });
    if (nativeMaxProbe) return;
    const finalGasObservation = gasObservation.value;
    if (nativeInput && nativeSwapMaxBindingRef.current !== null && finalGasObservation !== null) {
      const binding = nativeSwapMaxBindingRef.current;
      const exactMax = safeMaxAmount({ asset: "native", balance: finalGasObservation.balance, gasReserveWei: finalGasObservation.review.bufferedWei });
      if (binding.context !== swapMaxContextFingerprint || parsedAmount !== binding.value || parsedAmount !== exactMax) {
        setGasReviewError("Native Max changed with the latest balance or buffered gas; press Max again before wallet confirmation");
        return;
      }
    }
    if (!gasApproved || !gasReviewIsCurrent()) return;
    try {
      await attestCurrentSwapRoute();
    } catch (error) {
      setSwapSimulationError(getWriteError(error));
      return;
    }
    const submittedContext = {
      account: account.address,
      calldataFingerprint: keccak256(transaction.data),
      chainId: activeWalletChainId,
      deploymentEpoch: deploymentEpoch(registry),
      environment: environmentKey,
      executionFingerprint: simulatedContextFingerprint,
      intent: "swap" as const,
      providerId: account.connector?.id ?? "unknown",
      providerUid: account.connector?.uid ?? "unknown",
      submittedAt: Date.now(),
      target: registry.contracts.lbRouter,
      value: transaction.value
    };
    try {
      setSubmittedSwapReceiptContext(approvalIntentFingerprint);
      const hash = await submitJournaledTransaction({
        isCurrent: gasReviewIsCurrent,
        journal: transactionJournal,
        reviewed: reviewedTransactionIntent(submittedContext, {
          poolId: (primaryPool?.id ?? selectedPoolId) || null,
          recipient: account.address,
          refundRecipient: null,
          settingsFingerprint: approvalIntentFingerprint
        }),
        preWalletGuard: async () => {
          await attestCurrentSwapRoute();
          if (!gasReviewIsCurrent()) throw new PairAttestationError("context-changed", "Swap context changed during final pair attestation");
        },
        send: () => swapWrite.sendTransactionAsync(transaction)
      });
      if (hash !== null && (nativeInput || nativeOutput)) {
        const token = nativeInput ? tokenOutAddress : tokenInAddress;
        if (token === null || simulatedQuoteIdentity === null) throw new Error("Submitted native swap context is incomplete");
        setSubmittedNativeSwapReceiptContext({
          account: account.address,
          amountIn: parsedAmount.toString(),
          amountOutMin: amountOutMin.toString(),
          calldataFingerprint: keccak256(transaction.data),
          data: transaction.data,
          direction: nativeInput ? "native-in" : "native-out",
          executionFingerprint: simulatedContextFingerprint,
          hash,
          inputAssetMode,
          outputAssetMode,
          quoteIdentity: simulatedQuoteIdentity,
          target: transaction.to,
          token,
          transactionValue: transaction.value.toString()
        });
      }
    } catch (error) {
      if (!isUserRejectedSubmission(error)) {
        setSwapSimulationError(getWriteError(error) ?? "Transaction journal blocked swap submission");
      }
      // The wagmi mutation retains the rejection for the originating mounted session.
    }
    } finally {
      swapSubmitInFlight.current = false;
      if (nativeMaxProbe) {
        nativeSwapMaxProbeRef.current = false;
        setNativeSwapMaxPending(false);
      }
    }
  };

  const canReuseNativeSwapMaxObservation = nativeSwapMaxBindingRef.current?.context === swapMaxContextFingerprint && latestSwapGasObservationRef.current?.context === swapMaxContextFingerprint && parsedAmount !== null && parsedAmount > 0n;
  const handleNativeSwapMax = () => {
    if (!nativeInput || nativeSwapMaxPending) return;
    const observation = latestSwapGasObservationRef.current;
    if (gasReview?.action === "swap" && observation !== null && canReuseNativeSwapMaxObservation) {
      const max = safeMaxAmount({ asset: "native", balance: observation.balance, gasReserveWei: observation.reserve });
      if (max === 0n) {
        setGasReviewError("Native Max is unavailable because the wallet balance does not exceed the reviewed gas reserve");
        return;
      }
      setAmount(maxAmountInput({ asset: "native", balance: observation.balance, decimals: 18, gasReserveWei: observation.reserve }));
      nativeSwapMaxBindingRef.current = { context: swapMaxContextFingerprint, value: max };
      return;
    }
    if (!canSwap) return;
    nativeSwapMaxProbeRef.current = true;
    setNativeSwapMaxPending(true);
    void handleSwap();
  };

  const swapCandlePage: AnalyticsPage<PairCandle> = workspaceMatchesPool
    ? poolWorkspace.analytics.candles
    : swapCandlesQuery.data ?? {
        rows: [],
        status: swapCandlesQuery.isError ? "UNAVAILABLE" : "PARTIAL",
        error: swapCandlesQuery.error instanceof Error ? swapCandlesQuery.error.message : null,
        pageInfo: { endCursor: null, hasNextPage: false, partial: true, pagesLoaded: 0 },
        streamCursor: null
      };
  const swapCandlesLoading = workspaceMatchesPool
    ? poolWorkspace.analytics.candlesLoading
    : swapCandlesQuery.isLoading || swapCandlesQuery.isPlaceholderData;

  return (
    <div className="view-grid swap-workspace">
      <div
        aria-labelledby={mobileWorkspaceNavigation ? "pool-mobile-market-tab" : undefined}
        className="swap-market-column"
        id="pool-mobile-market-panel"
        role={mobileWorkspaceNavigation ? "tabpanel" : undefined}
        tabIndex={mobileWorkspaceNavigation ? -1 : undefined}
      >
        <SwapMarketChart
          candles={swapCandlePage.rows}
          error={swapCandlePage.error}
          interval={candleInterval}
          loading={swapCandlesLoading}
          onIntervalChange={workspaceMatchesPool ? poolWorkspace.analytics.setCandleInterval : setStandaloneCandleInterval}
          pairAddress={primaryPool?.address ?? null}
          pairLabel={`${tokenSymbol(tokenX)} / ${tokenSymbol(tokenY)}`}
          status={swapCandlePage.status}
          streamState={workspaceMatchesPool ? poolWorkspace.analytics.candleStreamState : "unavailable"}
        />
      </div>
      {workspaceMatchesPool ? (
        <div
          aria-labelledby={mobileWorkspaceNavigation ? "pool-mobile-positions-tab" : undefined}
          className="pool-positions-column"
          id="pool-mobile-positions-panel"
          role={mobileWorkspaceNavigation ? "tabpanel" : undefined}
          tabIndex={mobileWorkspaceNavigation ? -1 : undefined}
        >
          <PoolWorkspaceOwnerPanel />
        </div>
      ) : null}
      <section
        aria-labelledby={mobileWorkspaceNavigation ? "pool-mobile-trade-tab" : undefined}
        className={`tool-panel swap-task-panel${workspaceMatchesPool ? " pool-task-panel-scoped" : ""}`}
        data-testid="swap-task-panel"
        id={workspaceMatchesPool ? "swap-task-panel" : undefined}
        role={mobileWorkspaceNavigation ? "tabpanel" : undefined}
        tabIndex={mobileWorkspaceNavigation ? -1 : undefined}
      >
        {workspaceMatchesPool ? <PoolWorkspaceTaskTabs task="swap" /> : null}
        <header className="swap-task-header">
          <div>
            <span>Swap</span>
            <strong>{inputSymbol} / {outputSymbol}</strong>
          </div>
          <StatusBadge state={swapMarketReady ? "ready" : "unavailable"} label={swapMarketReady ? routeMode === "exact-selected" ? "exact pool" : "best route" : swapMarketError ?? "unavailable"} />
        </header>

        <div className="swap-task-body">
          {workspaceMatchesPool ? (
            <details className="swap-market-lock swap-route-disclosure" data-testid="swap-route-disclosure">
              <summary data-testid="swap-market-lock">
                <span className="swap-route-pool">
                  <span>Selected pool</span>
                  <strong>{tokenSymbol(tokenX)} / {tokenSymbol(tokenY)}</strong>
                </span>
                <span className="swap-route-context">
                  <small>{selectedPool.binStep ?? "unknown"} bps/bin</small>
                  <strong data-testid="swap-route-mode-summary">{routeMode === "exact-selected" ? "Exact selected pool" : "Best route"}</strong>
                </span>
              </summary>
              <div className="swap-route-disclosure-body">
                <SwapRouteModeControl onChange={setRouteMode} routeMode={routeMode} />
              </div>
            </details>
          ) : (
            <>
              <PoolSelect
                id="swap-pool"
                label="Selected market"
                onChange={onSelectedPoolChange}
                pools={poolOptions}
                selectedPoolId={selectedPoolId}
              />
              <SwapRouteModeControl onChange={setRouteMode} routeMode={routeMode} />
            </>
          )}

          {connected && selectedPoolHasWrapper && wrappedNativeToken ? (
            <fieldset className="routing-mode-control swap-native-mode" data-testid="swap-native-mode">
              <legend>Asset mode</legend>
              <div className="segmented" role="group" aria-label="Wrapped-native asset mode">
                <button aria-pressed={useNativeWrapper} className={useNativeWrapper ? "segment active" : "segment"} onClick={() => { nativeSwapMaxBindingRef.current = null; setUseNativeWrapper(true); setApprovalConfirmation(null); setNativeReceiptReview(null); setNativeReceiptError(null); }} type="button">ETH · native</button>
                <button aria-pressed={!useNativeWrapper} className={!useNativeWrapper ? "segment active" : "segment"} onClick={() => { nativeSwapMaxBindingRef.current = null; setUseNativeWrapper(false); setApprovalConfirmation(null); setNativeReceiptReview(null); setNativeReceiptError(null); }} type="button">{wrappedNativeToken.symbol} · ERC-20</button>
              </div>
              <p data-testid="swap-wrapper-disclosure">ETH uses router native calldata and transaction value. {wrappedNativeToken.symbol} remains ERC-20 {wrappedNativeToken.address} and requires allowance when sold. Native Max requires a current positive probe amount so Feather can review buffered gas before computing spendable ETH.</p>
            </fieldset>
          ) : null}

          <SwapMarketRecovery
            error={swapMarketError}
            onRefresh={onRefresh}
            pool={primaryPool}
            readiness={selectedPool}
          />

          <div className="swap-amount-stack">
            <section className="swap-asset-card">
              <div className="swap-asset-heading">
                <label htmlFor="swap-amount">Sell</label>
                <div className="balance-line">
                  <span>Balance</span>
                  <strong data-testid="swap-balance-value">{walletQuery.data ? nativeInput ? `${formatUnits(BigInt(walletQuery.data.balance), 18)} ETH` : formatTokenAmount(walletQuery.data.balance, tokenIn) : connected ? "loading" : "connect wallet"}</strong>
                </div>
              </div>
              <div className="amount-box">
                <input id="swap-amount" inputMode="decimal" onChange={(event) => { nativeSwapMaxBindingRef.current = null; setAmount(event.target.value); }} value={amount} />
                <span>{inputSymbol}</span>
                <button
                  className="token-max-button"
                  data-testid="swap-max-button"
                  disabled={walletBalance === null || tokenIn === null || (nativeInput && ((!canSwap && !canReuseNativeSwapMaxObservation) || nativeSwapMaxPending))}
                  onClick={() => {
                    if (nativeInput) handleNativeSwapMax();
                    else if (walletBalance !== null && tokenIn !== null) setAmount(maxAmountInput({ asset: "token", balance: walletBalance, decimals: tokenIn.decimals }));
                  }}
                  type="button"
                >Max</button>
              </div>
              {!nativeInput ? <TokenIdentity token={tokenIn} networkName={registry.chain.name} testId="swap-token-in-identity" /> : null}
            </section>

            {nativeInput && (parsedAmount === null || parsedAmount <= 0n) ? <div className="state-row warning" data-testid="swap-native-max-guidance"><AlertTriangle size={16} /><span>Enter a valid positive ETH probe amount before using Native Max; no wallet request is opened for the gas probe.</span></div> : null}

            <button className="flip-button" type="button" title="Flip tokens" onClick={() => { nativeSwapMaxBindingRef.current = null; setSwapForY((value) => !value); }}>
              <ArrowLeftRight size={18} />
            </button>

            <section className="swap-asset-card output">
              <div className="swap-asset-heading">
                <label htmlFor="swap-output">Buy</label>
                <span>Estimated output</span>
              </div>
              <div className="amount-box output">
                <input id="swap-output" readOnly value={formatSwapOutput(quoteQuery.isFetching, amountOut, tokenOut)} />
                <span>{outputSymbol}</span>
              </div>
              {!nativeOutput ? <TokenIdentity token={tokenOut} networkName={registry.chain.name} testId="swap-token-out-identity" /> : null}
            </section>
          </div>

          <section aria-label="Trade quote" className="swap-quote-summary">
            <div className="swap-quote-heading">
              <span>Trade quote</span>
              <small>{quoteFreshnessLabel}</small>
            </div>
            <dl className="swap-quote-list">
              <div><dt>Expected output</dt><dd>{expectedOutLabel}</dd></div>
              <div><dt>Minimum received</dt><dd>{amountOutMin !== null ? nativeOutput ? `${formatUnits(amountOutMin, 18)} ETH` : formatTokenAmount(amountOutMin.toString(), tokenOut) : "n/a"}</dd></div>
              <div><dt>LP fee</dt><dd>{feeLabel}</dd></div>
              <div><dt>Price impact</dt><dd>{priceImpactLabel}</dd></div>
            </dl>
          </section>

          <div className="swap-settings">
            <label htmlFor="swap-slippage">
              <span>Slippage %</span>
              <input id="swap-slippage" inputMode="decimal" value={slippageInput} onChange={(event) => setSlippageInput(event.target.value)} />
            </label>
            <label htmlFor="swap-deadline">
              <span>Deadline min</span>
              <input id="swap-deadline" inputMode="numeric" value={deadlineInput} onChange={(event) => setDeadlineInput(event.target.value)} />
            </label>
          </div>

          <GasReview review={gasReview} />

          {nativeInput ? <div className="state-row success" data-testid="swap-native-no-approval">ETH uses exact transaction value and never requests ERC-20 approval.</div> : null}

          {nativeReceiptReview ? <div className="review-card" data-testid="native-swap-receipt-review"><strong>Canonical native swap accounting</strong><p>{nativeReceiptReview.direction === "native-in" ? "ETH spent" : "ETH received"}: {formatUnits(BigInt(nativeReceiptReview.nativeAmount), 18)} ETH · token amount {nativeReceiptReview.tokenAmount} · gas {formatUnits(BigInt(nativeReceiptReview.gasCost), 18)} ETH</p></div> : null}
          {nativeReceiptError ? <div className="state-row failure" data-testid="native-swap-receipt-error">{nativeReceiptError}</div> : null}

          <details
            className="swap-review-details"
            data-testid="swap-review-details"
            open={needsApproval || routeAttestationQuery.error !== null || pairAttestationQuery.error !== null ? true : undefined}
          >
            <summary>
              <span>Market and approval review</span>
              <small>{routeSteps.length > 0 ? `${routeSteps.length} hop${routeSteps.length === 1 ? "" : "s"}` : "Route pending"}</small>
            </summary>
            <div className="swap-review-body">
              <SwapRouteReview
                primaryPool={primaryPool}
                quote={quote}
                routeMode={routeMode}
                routeSteps={routeSteps}
                selectedPool={selectedPool}
                swapMarketError={swapMarketError}
                swapMarketReady={swapMarketReady}
                tokenIn={tokenIn}
                tokenOut={tokenOut}
              />

              {routeAttestationQuery.error === null && routeAttestationQuery.data?.length ? routeAttestationQuery.data.map((attestation, index) => (
                <PairAttestationReview attestation={attestation} error={null} key={`${attestation.pair}-${index}`} loading={false} />
              )) : (
                <PairAttestationReview
                  attestation={pairAttestationQuery.data ?? null}
                  error={routeAttestationQuery.error ?? pairAttestationQuery.error}
                  loading={routeAttestationQuery.isLoading || routeAttestationQuery.isFetching || pairAttestationQuery.isLoading}
                />
              )}

              {nativeInput ? <div className="state-row" data-testid="swap-token-in-identity">ETH native asset · router wrapper {wrappedNativeToken?.symbol} {wrappedNativeToken?.address}</div> : null}
              {nativeOutput ? <div className="state-row" data-testid="swap-token-out-identity">ETH native asset · router wrapper {wrappedNativeToken?.symbol} {wrappedNativeToken?.address}</div> : null}
              {!nativeInput ? <TokenIdentity token={tokenIn} networkName={registry.chain.name} testId="swap-token-in-review" /> : null}
              {!nativeOutput ? <TokenIdentity token={tokenOut} networkName={registry.chain.name} testId="swap-token-out-review" /> : null}

              <div className="quote-grid swap-account-review">
                <MiniMetric data-testid="swap-allowance-value" label="Allowance" value={nativeInput ? "not required for ETH" : walletQuery.data ? formatTokenAmount(walletQuery.data.allowance, tokenIn) : "n/a"} />
                <MiniMetric data-testid="swap-native-balance" label="ETH for gas" value={nativeBalance !== null ? `${formatUnits(nativeBalance, 18)} ETH` : connected ? "loading" : "connect wallet"} />
              </div>

              {!nativeInput ? <ApprovalDetails
                asset={tokenSymbol(tokenIn)}
                amount={parsedAmount}
                currentState={walletQuery.data ? `${formatTokenAmount(walletQuery.data.allowance, tokenIn)} allowance${needsApproval ? " (approval needed)" : " (sufficient)"}` : "unavailable"}
                id="swap-approval-details"
                requested={parsedAmount !== null ? formatTokenAmount(parsedAmount.toString(), tokenIn) : "invalid amount"}
                scope="Exact token amount for this swap"
                spender={registry.contracts.lbRouter}
                token={tokenIn}
              /> : null}
            </div>
          </details>
        </div>

        <footer className="swap-action-dock">
          <div className="action-stack">
            {!nativeInput ? <button
              className="secondary-button wide"
              data-testid="swap-approve-button"
              type="button"
              aria-describedby="swap-approval-details swap-failure-state"
              disabled={!canApprove || approvalWrite.isPending || approvalReceipt.isLoading || approvalSimulationPending}
              hidden={!connected}
              title={swapApprovalDisclosure}
              onClick={handleApprove}
            >
              {approvalSimulationPending || approvalWrite.isPending || approvalReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <CheckCircle2 size={18} />}
              <span>{needsApproval ? `Approve ${tokenSymbol(tokenIn)}` : "Approved"}</span>
            </button> : null}
            <button aria-describedby="swap-failure-state" className={`primary-button wide${!connected ? " swap-primary-only" : ""}`} data-testid="swap-submit-button" type="button" disabled={!canSwap} onClick={handleSwap}>
              {swapSimulationPending || swapWrite.isPending || swapReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <ArrowLeftRight size={18} />}
              <span>
                {buttonLabel({
                  poolReady: swapMarketReady,
                  connected,
                  onWrongChain,
                  needsApproval,
                  insufficientBalance,
                  insufficientGas: actionError?.startsWith("Insufficient ETH for gas") === true,
                  invalidInput: inputError !== null,
                  quoteLoading: quoteQuery.isFetching,
                  quoteReady: quote !== undefined,
                  safetyReason: swapSafetyReason,
                  walletError: walletError !== null,
                  walletLoading: walletReadsPending
                })}
              </span>
            </button>
            {approvalRefreshRetryRequired ? (
              <button className="secondary-button wide" data-testid="swap-approval-refresh-button" onClick={retryApprovalRefresh} type="button">
                <RefreshCw size={18} />
                <span>Refresh after approval</span>
              </button>
            ) : null}
          </div>

          <SwapStateRows
            amountError={inputError}
            actionError={actionError}
            approvalRefreshPending={postApprovalReviewPending && postApprovalRefreshError === null}
            approvalHash={approvalReceiptMatchesCurrentIntent ? approvalWrite.data : undefined}
            approvalPending={approvalWrite.isPending || (approvalReceiptMatchesCurrentIntent && approvalReceipt.isLoading)}
            approvalReverted={approvalReverted}
            approvalSuccess={approvalSuccess}
            insufficientBalance={insufficientBalance}
            insufficientGas={actionError?.startsWith("Insufficient ETH for gas") === true}
            quoteError={quoteQuery.error}
            swapHash={swapReceiptMatchesCurrentIntent ? swapWrite.data : undefined}
            swapPending={swapWrite.isPending || (swapReceiptMatchesCurrentIntent && swapReceipt.isLoading)}
            swapReverted={swapReverted}
            swapSuccess={swapSuccess}
            walletError={walletError}
          />
        </footer>
      </section>

    </div>
  );
}

function SwapMarketRecovery({
  error,
  onRefresh,
  pool,
  readiness
}: {
  error: string | null;
  onRefresh: SnapshotRefetch;
  pool: PoolRow | null;
  readiness: SelectedPoolDescriptor;
}) {
  if (readiness.ready) return null;

  const emptyPool = readiness.blockers.some((blocker) => blocker.code === "empty-pool");

  return (
    <div className="state-row warning" data-testid="swap-market-recovery" role="status">
      <AlertTriangle size={16} />
      <span>{error ?? "Selected market is not safe for swaps"}</span>
      {emptyPool && pool !== null ? (
        <a className="secondary-button" href={`#/liquidity/add/${encodeURIComponent(pool.id)}`}>
          Create position
        </a>
      ) : (
        <button className="secondary-button" onClick={() => void onRefresh()} type="button">
          Refresh market data
        </button>
      )}
    </div>
  );
}

function SwapRouteModeControl({
  onChange,
  routeMode
}: {
  onChange: (routeMode: "exact-selected" | "best") => void;
  routeMode: "exact-selected" | "best";
}) {
  return (
    <fieldset className="routing-mode-control swap-route-mode">
      <legend>Route</legend>
      <div className="segmented" role="group" aria-label="Swap routing choice">
        <button aria-pressed={routeMode === "exact-selected"} className={routeMode === "exact-selected" ? "segment active" : "segment"} onClick={() => onChange("exact-selected")} type="button">
          Exact selected pool
        </button>
        <button aria-pressed={routeMode === "best"} className={routeMode === "best" ? "segment active" : "segment"} onClick={() => onChange("best")} type="button">
          Best route
        </button>
      </div>
      <p>{routeMode === "exact-selected" ? "Use only this pool and bin step." : "Compare supported direct and one-intermediary V2.2 routes."}</p>
    </fieldset>
  );
}

function SwapMarketChart({
  candles,
  error,
  interval,
  loading,
  onIntervalChange,
  pairAddress,
  pairLabel,
  status,
  streamState
}: {
  candles: PairCandle[];
  error: string | null;
  interval: CandleInterval;
  loading: boolean;
  onIntervalChange: (interval: CandleInterval) => void;
  pairAddress: string | null;
  pairLabel: string;
  status: AnalyticsStatus;
  streamState: CandleStreamState;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fittedDataKeyRef = useRef<string | null>(null);
  const seriesIdentityRef = useRef<string | null>(null);
  const seriesRevisionsRef = useRef(new Map<number, number>());
  const seriesTimesRef = useRef(new Set<number>());
  const intervalCandles = useMemo(() => candles.filter((candle) => candle.interval === interval), [candles, interval]);
  const latestCandle = [...intervalCandles].reverse().find((candle) => candle.closeUsdE18 !== null) ?? null;
  const accessibleCandles = intervalCandles.slice(-24);
  const historyState = loading
    ? "Loading"
    : status === "UNAVAILABLE"
      ? "Analytics unavailable"
      : status === "PARTIAL"
        ? "Partial history"
        : intervalCandles.length === 0
          ? "No activity"
          : "History ready";

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        attributionLogo: true,
        background: { type: ColorType.Solid, color: "#111411" },
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        textColor: "rgba(233, 236, 231, 0.56)"
      },
      grid: {
        horzLines: { color: "rgba(233, 236, 231, 0.06)" },
        vertLines: { color: "rgba(233, 236, 231, 0.045)" }
      },
      crosshair: {
        horzLine: { color: "rgba(233, 236, 231, 0.38)", labelBackgroundColor: "#252925" },
        vertLine: { color: "rgba(233, 236, 231, 0.24)", labelBackgroundColor: "#252925" }
      },
      localization: { priceFormatter: formatTradingChartPrice },
      rightPriceScale: {
        borderColor: "rgba(233, 236, 231, 0.10)",
        scaleMargins: { top: 0.08, bottom: 0.28 }
      },
      timeScale: {
        borderColor: "rgba(233, 236, 231, 0.10)",
        rightOffset: 4,
        barSpacing: 11,
        timeVisible: true,
        secondsVisible: false
      }
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      borderVisible: false,
      downColor: "#e56d70",
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
      upColor: "#4ac57c",
      wickDownColor: "#e56d70",
      wickUpColor: "#4ac57c"
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: "rgba(74, 197, 124, 0.32)",
      priceFormat: { type: "volume" },
      priceScaleId: ""
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      chart.applyOptions({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height)
      });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      seriesIdentityRef.current = null;
      seriesRevisionsRef.current.clear();
      seriesTimesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (candleSeries === null || volumeSeries === null) return;

    if (loading && candles.length > 0 && intervalCandles.length === 0) return;
    const ordered = [...intervalCandles].sort((left, right) => left.startTimestamp - right.startTimestamp);
    const points: Array<{ candle: PairCandle; candleData: CandlestickData<UTCTimestamp>; volumeData: HistogramData<UTCTimestamp> }> = [];
    for (const candle of ordered) {
      const open = tradingChartValue(candle.openUsdE18);
      const high = tradingChartValue(candle.highUsdE18);
      const low = tradingChartValue(candle.lowUsdE18);
      const close = tradingChartValue(candle.closeUsdE18);
      if (open === null || high === null || low === null || close === null) continue;
      const time = candle.startTimestamp as UTCTimestamp;
      points.push({
        candle,
        candleData: { close, high, low, open, time },
        volumeData: {
          color: close >= open ? "rgba(74, 197, 124, 0.32)" : "rgba(229, 109, 112, 0.28)",
          time,
          value: tradingChartValue(candle.volumeUsdE18) ?? 0
        }
      });
    }
    const identity = `${pairAddress ?? "none"}:${interval}`;
    const nextTimes = new Set(points.map((point) => point.candle.startTimestamp));
    const previousTimes = seriesTimesRef.current;
    const previousMaximum = Math.max(...previousTimes, Number.NEGATIVE_INFINITY);
    const requiresReset = seriesIdentityRef.current !== identity
      || [...previousTimes].some((timestamp) => !nextTimes.has(timestamp))
      || [...nextTimes].some((timestamp) => !previousTimes.has(timestamp) && timestamp < previousMaximum);
    if (requiresReset) {
      candleSeries.setData(points.map((point) => point.candleData));
      volumeSeries.setData(points.map((point) => point.volumeData));
    } else {
      for (const point of points) {
        if (seriesRevisionsRef.current.get(point.candle.startTimestamp) === point.candle.revision) continue;
        const historicalUpdate = previousTimes.has(point.candle.startTimestamp);
        candleSeries.update(point.candleData, historicalUpdate);
        volumeSeries.update(point.volumeData, historicalUpdate);
      }
    }
    seriesIdentityRef.current = identity;
    seriesTimesRef.current = nextTimes;
    seriesRevisionsRef.current = new Map(points.map((point) => [point.candle.startTimestamp, point.candle.revision]));

    const fitKey = `${identity}:${points[0]?.candle.startTimestamp ?? "empty"}`;
    if (points.length > 0 && fittedDataKeyRef.current !== fitKey) {
      chartRef.current?.timeScale().fitContent();
      fittedDataKeyRef.current = fitKey;
    }
  }, [candles, interval, intervalCandles, pairAddress]);

  const emptyMessage = loading
    ? "Loading price history"
    : status === "UNAVAILABLE" || error
      ? "Price history is not available yet"
      : "No activity in this time window";

  return (
    <section
      className="info-panel swap-chart-panel"
      data-testid="swap-market-chart"
    >
      <header className="swap-chart-header">
        <div>
          <span>Price chart</span>
          <strong>{pairLabel}</strong>
        </div>
        <div aria-label="Candle interval" className="swap-chart-intervals" role="group">
          {CHART_INTERVALS.map((option) => (
            <button
              aria-pressed={option === interval}
              className={option === interval ? "active" : undefined}
              key={option}
              onClick={() => onIntervalChange(option)}
              type="button"
            >
              {CANDLE_INTERVAL_LABELS[option]}
            </button>
          ))}
        </div>
      </header>
      <div className="swap-chart-summary">
        {latestCandle ? (
          <>
            <span>O {formatUsdE18(latestCandle.openUsdE18)}</span>
            <span>H {formatUsdE18(latestCandle.highUsdE18)}</span>
            <span>L {formatUsdE18(latestCandle.lowUsdE18)}</span>
            <strong>C {formatUsdE18(latestCandle.closeUsdE18)}</strong>
            <span>Vol {formatUsdE18(latestCandle.volumeUsdE18)}</span>
          </>
        ) : <span>{emptyMessage}</span>}
      </div>
      <div className="swap-chart-stage">
        <div aria-describedby="pool-candle-chart-description" aria-label={`${pairLabel} ${CANDLE_INTERVAL_LABELS[interval]} candlestick chart`} className="swap-chart-canvas" ref={containerRef} role="img" />
        {intervalCandles.length === 0 ? <div className="swap-chart-empty"><span>{emptyMessage}</span></div> : null}
      </div>
      <div className="visually-hidden visually-hidden-table" id="pool-candle-chart-description">
        <p>{pairLabel} {CANDLE_INTERVAL_LABELS[interval]} price history. {historyState}. {intervalCandles.length} candles are loaded; the table contains the latest {accessibleCandles.length}.</p>
        <table>
          <caption>Latest {pairLabel} candle data</caption>
          <thead><tr><th>UTC start</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th><th>Status</th></tr></thead>
          <tbody>
            {accessibleCandles.map((candle) => (
              <tr key={`${candle.startTimestamp}-${candle.revision}`}>
                <th>{new Date(candle.startTimestamp * 1_000).toISOString()}</th>
                <td>{formatUsdE18(candle.openUsdE18)}</td>
                <td>{formatUsdE18(candle.highUsdE18)}</td>
                <td>{formatUsdE18(candle.lowUsdE18)}</td>
                <td>{formatUsdE18(candle.closeUsdE18)}</td>
                <td>{formatUsdE18(candle.volumeUsdE18)}</td>
                <td>{candle.status}{candle.finalized ? ", finalized" : ", updating"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="swap-chart-footer">
        <span>{CANDLE_LOOKBACK_LABELS[interval]} · {historyState}</span>
        <span className={`swap-chart-stream ${streamState}`}>{streamState === "live" ? "Live" : streamState === "connecting" ? "Connecting" : streamState === "stale" ? "Stream stale" : "Historical only"}</span>
        <span>{latestCandle?.priceSource === "active-bin-quote-usd" ? "Pool price · trusted USD quote" : "Trusted USD price"}</span>
      </footer>
    </section>
  );
}

function tradingChartValue(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(formatUnits(BigInt(value), 18));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTradingChartPrice(price: number): string {
  if (Math.abs(price) >= 1_000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(price) >= 1) return price.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return price.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

function SwapRouteReview({
  primaryPool,
  quote,
  routeMode,
  routeSteps,
  selectedPool,
  swapMarketError,
  swapMarketReady,
  tokenIn,
  tokenOut
}: {
  primaryPool: PoolRow | null;
  quote: SerializedExactInQuote | undefined;
  routeMode: "exact-selected" | "best";
  routeSteps: RouteStepView[];
  selectedPool: SelectedPoolDescriptor;
  swapMarketError: string | null;
  swapMarketReady: boolean;
  tokenIn: TokenMetadata | null;
  tokenOut: TokenMetadata | null;
}) {
  return (
    <section className="swap-route-review">
      <div className="panel-heading">
        <span>Route</span>
        <StatusBadge
          state={!swapMarketReady ? "unavailable" : quote ? "ready" : primaryPool ? "loading" : "empty"}
          label={!swapMarketReady ? swapMarketError ?? "unavailable" : quote ? routeMode === "exact-selected" ? "Exact selected pool" : "Best V2.2 route" : primaryPool ? "waiting" : "no market"}
        />
      </div>

      {routeSteps.length > 0 ? (
        <div className="route-list" data-testid="swap-route-steps">
          {routeSteps.map((step) => (
            <div className="route-step" key={step.key}>
              <div>
                <strong>
                  {step.tokenIn} &gt; {step.tokenOut}
                </strong>
                <span>{step.pair}</span>
              </div>
              <div>
                <small>Bin {step.binStep}</small>
                <small>{step.version}</small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        swapMarketReady ? <EmptyState state={primaryPool ? "loading" : "empty"} /> : <p className="state-row warning">{swapMarketError}</p>
      )}

      <dl className="contract-list">
        <div>
          <dt>Routing mode</dt>
          <dd>{routeMode === "exact-selected" ? "Exact selected pool" : "Best route"}</dd>
        </div>
        <div>
          <dt>Selected market</dt>
          <dd
            data-reserve-x={selectedPool.reserveX?.toString() ?? "unavailable"}
            data-testid="swap-selected-market-identity"
            data-token-x={selectedPool.tokenXAddress ?? "unavailable"}
            data-token-y={selectedPool.tokenYAddress ?? "unavailable"}
          >
            {selectedPool.pair ? (
              <><code className="approval-address">{selectedPool.pair}</code> · bin step {selectedPool.binStep ?? "unknown"}</>
            ) : "unavailable"}
          </dd>
        </div>
        <div>
          <dt>Input</dt>
          <dd>{tokenSymbol(tokenIn)}</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{tokenSymbol(tokenOut)}</dd>
        </div>
        <div>
          <dt>Hops</dt>
          <dd>{routeSteps.length > 0 ? routeSteps.length : "n/a"}</dd>
        </div>
      </dl>
    </section>
  );
}

function PoolSelect({
  id,
  label,
  onChange,
  pools,
  selectedPoolId
}: {
  id: string;
  label: string;
  onChange: (poolId: string) => void;
  pools: PoolRow[];
  selectedPoolId: string;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredPools = pools.filter((pool) => {
    if (pool.id === selectedPoolId || normalizedQuery.length === 0) return true;
    return [pool.id, pool.address, pool.tokenX?.name, pool.tokenX?.symbol, pool.tokenXAddress, pool.tokenY?.name, pool.tokenY?.symbol, pool.tokenYAddress]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });
  return (
    <>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        aria-label={`${label} search by token name, symbol, or address`}
        className="select-input"
        data-testid={`${id}-search`}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search token name, symbol, token address, or pool address"
        type="search"
        value={query}
      />
      <select className="select-input" id={id} value={selectedPoolId} onChange={(event) => onChange(event.target.value)} disabled={pools.length === 0}>
        {filteredPools.length > 0 ? (
          filteredPools.map((pool) => (
            <option key={pool.id} value={pool.id}>
              {poolChoiceIdentityLabel(pool)}
            </option>
          ))
        ) : (
          <option value="">No matching indexed pools</option>
        )}
      </select>
    </>
  );
}

interface BuildPoolDescriptorInput {
  action: TokenAction;
  localnetRegistry: LocalnetDexRegistry | null;
  pool: PoolRow | null;
  registry: DexRegistry;
  snapshot: AppSnapshot | undefined;
}

interface SelectedExecutionPool {
  activeId: number | null;
  binStep: number;
  pair: Address;
  tokenX: Address;
  tokenY: Address;
}

function buildPoolDescriptor({
  action,
  localnetRegistry,
  pool,
  registry,
  snapshot
}: BuildPoolDescriptorInput): SelectedPoolDescriptor {
  const indexerStatus = snapshot?.indexer.status;
  const runtime = selectedPoolRuntimeFlags(snapshot, registry.chainId);
  const poolSource =
    registry.endpoints.indexerUrl === null && analyticsEndpointForRegistry(registry) !== null
      ? "analytics"
      : "indexed";
  const indexer = {
    empty: indexerStatus === "empty" && (snapshot?.indexer.pools.length ?? 0) === 0,
    emptyMessage: snapshot?.indexer.message ?? "No indexed pools are available yet",
    error: indexerStatus === "error",
    errorMessage: snapshot?.indexer.message,
    partial: isPartialPagination(snapshot?.indexer.pagination.pools),
    partialMessage: snapshot?.indexer.message,
    stale: indexerStatus === "stale",
    staleMessage: snapshot?.indexer.message,
    unavailable: indexerStatus === "unavailable",
    unavailableMessage: snapshot?.indexer.message
  };

  if (pool !== null) {
    return buildSelectedPoolDescriptor({
      action,
      indexer,
      pool,
      registry,
      runtime,
      source: poolSource
    });
  }

  if (localnetRegistry !== null) {
    return buildSelectedPoolDescriptor({
      action,
      poolKey: "wethUsdc",
      registry: localnetRegistry,
      runtime,
      source: "localnet-seeded"
    });
  }

  return buildSelectedPoolDescriptor({
    action,
    indexer,
    pool: null,
    registry,
    runtime,
    source: poolSource
  });
}

function selectedPoolRuntimeFlags(snapshot: AppSnapshot | undefined, expectedChainId: number): SelectedPoolRuntimeFlags {
  if (snapshot === undefined) {
    return { actualChainId: null, expectedChainId, status: "loading" };
  }

  return {
    actualChainId: snapshot.runtime.chainId,
    expectedChainId,
    message: snapshot.runtime.message,
    status: snapshot.runtime.status === "ready" ? "ready" : "error"
  };
}

function runtimeIsReady(snapshot: AppSnapshot | undefined, expectedChainId: number): boolean {
  return snapshot?.runtime.status === "ready" && snapshot.runtime.chainId === expectedChainId;
}

function swapSnapshotIdentity(snapshot: AppSnapshot | undefined, poolId: string): string {
  const pool = snapshot?.indexer.pools.find(
    (candidate) => candidate.id.toLowerCase() === poolId.toLowerCase() || candidate.address.toLowerCase() === poolId.toLowerCase()
  );

  return JSON.stringify({
    indexerBlockHash: snapshot?.indexer.blockHash ?? null,
    indexerBlockNumber: snapshot?.indexer.blockNumber ?? null,
    indexerHasErrors: snapshot?.indexer.hasIndexingErrors ?? null,
    indexerPoolPagination: snapshot?.indexer.pagination.pools ?? null,
    indexerStatus: snapshot?.indexer.status ?? null,
    pool: pool
      ? {
          activeId: pool.activeId,
          address: pool.address,
          binStep: pool.binStep,
          id: pool.id,
          reserveX: pool.reserveX,
          reserveY: pool.reserveY,
          tokenX: pool.tokenX,
          tokenXAddress: pool.tokenXAddress,
          tokenY: pool.tokenY,
          tokenYAddress: pool.tokenYAddress,
          updatedAtBlock: pool.updatedAtBlock
        }
      : null,
    runtimeBlockNumber: snapshot?.runtime.blockNumber ?? null,
    runtimeChainId: snapshot?.runtime.chainId ?? null,
    runtimeStatus: snapshot?.runtime.status ?? null
  });
}

function executionPoolFromDescriptor(pool: SelectedPoolDescriptor): SelectedExecutionPool | null {
  if (
    pool.binStep === null ||
    pool.pair === null ||
    pool.tokenXAddress === null ||
    pool.tokenYAddress === null
  ) {
    return null;
  }

  return {
    activeId: pool.activeId,
    binStep: pool.binStep,
    pair: pool.pair,
    tokenX: pool.tokenXAddress,
    tokenY: pool.tokenYAddress
  };
}

function poolDescriptorError(pool: SelectedPoolDescriptor): string | null {
  return pool.blockers[0]?.message ?? null;
}

function poolDescriptorLabel(pool: SelectedPoolDescriptor): string {
  if (!pool.ready) return poolDescriptorError(pool) ?? "unavailable";

  return pool.source === "localnet-seeded" ? "seeded pair" : "indexed pair";
}

function swapMarketReadinessError(pool: SelectedPoolDescriptor, rpcReady: boolean): string | null {
  if (!rpcReady) {
    return (
      pool.blockers.find((blocker) =>
        ["rpc-chain-mismatch", "rpc-error", "rpc-loading"].includes(blocker.code)
      )?.message ?? "RPC is unavailable"
    );
  }

  if (!pool.ready) {
    return poolDescriptorError(pool) ?? "Selected pool is not safe for swaps";
  }

  if (pool.tokenXAddress === null || pool.tokenYAddress === null || pool.tokenX === null || pool.tokenY === null) {
    return (
      pool.blockers.find((blocker) =>
        ["missing-pool", "missing-pool-field", "missing-token-metadata"].includes(blocker.code)
      )?.message ?? "Select a token pair"
    );
  }

  const unsupportedToken = [pool.tokenX, pool.tokenY].find((token) => !tokenAllowsAction(token, "swap"));
  if (unsupportedToken !== undefined) return `${unsupportedToken.symbol} is not approved for swaps`;
  if (isAddressEqual(pool.tokenXAddress, pool.tokenYAddress)) return "Swap input and output tokens must differ";

  return null;
}

function quoteMatchesSwapRequest(quote: ExactInQuote, tokenIn: Address, tokenOut: Address, amountIn: bigint): boolean {
  try {
    assertQuoteMatchesExactInRequest(quote, { amountIn, tokenIn, tokenOut });
    return true;
  } catch {
    return false;
  }
}

function SwapStateRows({
  actionError,
  amountError,
  approvalRefreshPending,
  approvalHash,
  approvalPending,
  approvalReverted,
  approvalSuccess,
  insufficientBalance,
  insufficientGas,
  quoteError,
  swapHash,
  swapPending,
  swapReverted,
  swapSuccess,
  walletError
}: {
  actionError: string | null;
  amountError: string | null;
  approvalRefreshPending: boolean;
  approvalHash: Address | undefined;
  approvalPending: boolean;
  approvalReverted: boolean;
  approvalSuccess: boolean;
  insufficientBalance: boolean;
  insufficientGas: boolean;
  quoteError: Error | null;
  swapHash: Address | undefined;
  swapPending: boolean;
  swapReverted: boolean;
  swapSuccess: boolean;
  walletError: string | null;
}) {
  const receiptFailure = swapReverted ? "Swap reverted" : approvalReverted ? "Approval reverted" : null;
  const failure =
    receiptFailure ??
    (approvalRefreshPending ? null : amountError) ??
    (insufficientBalance ? "Insufficient token balance" : null) ??
    (insufficientGas ? "Insufficient ETH for gas" : null) ??
    (quoteError ? quoteError.message : null) ??
    walletError ??
    actionError;
  const state = failure
    ? { icon: <AlertTriangle size={16} />, message: failure, tone: "failure" }
    : swapSuccess
      ? { icon: <CheckCircle2 size={16} />, message: "Swap confirmed", tone: "success" }
      : swapPending || swapHash
        ? { icon: <LoaderCircle className="spin" size={16} />, message: swapHash ? `Swap pending ${formatCompactAddress(swapHash)}` : "Awaiting swap wallet confirmation", tone: "pending" }
        : approvalRefreshPending
          ? { icon: <LoaderCircle className="spin" size={16} />, message: "Refreshing balance, allowance, and quote after approval", tone: "pending" }
        : approvalSuccess
          ? { icon: <CheckCircle2 size={16} />, message: "Approval confirmed", tone: "success" }
          : approvalPending || approvalHash
            ? { icon: <LoaderCircle className="spin" size={16} />, message: approvalHash ? `Approval pending ${formatCompactAddress(approvalHash)}` : "Awaiting approval wallet confirmation", tone: "pending" }
            : { icon: <CheckCircle2 size={16} />, message: "Ready for wallet confirmation", tone: "ready" };

  return (
    <div
      aria-atomic="true"
      aria-live={state.tone === "failure" ? "assertive" : "polite"}
      className={`state-row transaction-status ${state.tone}`}
      data-testid="swap-failure-state"
      id="swap-failure-state"
      role={state.tone === "failure" ? "alert" : "status"}
    >
      {state.icon}
      <span>{state.message}</span>
    </div>
  );
}

function MiniMetric({ label, value, "data-testid": dataTestId }: { label: string; value: string; "data-testid"?: string }) {
  return (
    <div className="mini-metric" data-testid={dataTestId}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ApprovalDetails({
  amount,
  asset,
  currentState,
  id,
  requested,
  scope,
  spender,
  token
}: {
  amount: bigint | null;
  asset: string;
  currentState: string;
  id: string;
  requested: string;
  scope: string;
  spender: Address | null;
  token: TokenMetadata | null;
}) {
  return (
    <section className="approval-disclosure" id={id} aria-label={`${asset} approval details`}>
      <strong>Approval details</strong>
      <dl>
        <div><dt>Token / asset</dt><dd>{asset}</dd></div>
        <div><dt>Token address</dt><dd><code className="approval-address">{token?.address ?? "not an ERC-20 token"}</code></dd></div>
        <div><dt>Network</dt><dd>{token ? `Chain ${token.chainId}` : "current wallet network"}</dd></div>
        <div><dt>Decimals / raw amount</dt><dd>{token?.decimals ?? "n/a"} / {amount?.toString() ?? "n/a"}</dd></div>
        <div><dt>Approval behavior</dt><dd>{token ? `${token.approvalBehavior} · ${tokenApprovalCapabilityLabel(token)}` : "special operator approval"}</dd></div>
        <div><dt>Requested</dt><dd>{requested}</dd></div>
        <div><dt>Scope</dt><dd>{scope}</dd></div>
        <div><dt>Current state</dt><dd>{currentState}</dd></div>
        <div><dt>Spender / operator</dt><dd><code className="approval-address" data-testid={`${id}-spender`}>{spender ?? "not configured"}</code></dd></div>
      </dl>
    </section>
  );
}

function rememberLbApprovalGrant(
  grants: readonly LbOperatorApprovalGrant[],
  next: LbOperatorApprovalGrant
): LbOperatorApprovalGrant[] {
  const key = (grant: LbOperatorApprovalGrant) => [
    grant.account.toLowerCase(),
    grant.chainId.toString(),
    grant.pair.toLowerCase(),
    grant.operator.toLowerCase()
  ].join("|");
  return grants.some((grant) => key(grant) === key(next)) ? [...grants] : [...grants, next];
}

function TokenIdentity({ networkName, testId, token }: { networkName: string; testId: string; token: TokenMetadata | null }) {
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [token?.address]);
  if (token === null) return <div className="token-identity warning" data-testid={testId}>Token identity unavailable</div>;
  const fallback = deterministicTokenFallback(token);
  const risk = token.risk.flags.length > 0 ? token.risk.flags.join(", ") : "no listed risk flags";
  const reviewReason = token.risk.notes ? ` · note: ${token.risk.notes}` : "";
  return (
    <div className="token-identity" data-testid={testId}>
      <span className="token-logo-fallback" data-fallback={logoFailed ? "true" : "false"} data-testid={`${testId}-logo`} style={{ background: fallback.color }} aria-hidden="true">
        {logoFailed ? fallback.label : <img alt="" src={token.logoURI} onError={() => setLogoFailed(true)} />}
      </span>
      <span><strong>{token.name} · {token.symbol}</strong><code>{token.address}</code></span>
      <span><strong>{networkName} · chain {token.chainId}</strong><small>Feather allowlist · review: {token.risk.reviewStatus} · {risk} · capability: {token.approvalBehavior}{reviewReason}</small></span>
    </div>
  );
}

function buildBurnQuoteView(
  plan: PositionBurnPlanResult,
  liveBinStates: readonly LiveBurnBinState[] | null,
  slippageBps: bigint | null
): BurnQuoteView {
  if (plan.blocked || plan.ids.length === 0 || liveBinStates === null || slippageBps === null) {
    return { error: null, minimums: null, quote: null };
  }

  try {
    const stateByBin = new Map(liveBinStates.map((state) => [state.binId, state]));
    const quote = quoteLiquidityBurn(
      plan.ids.map((binId, index) => {
        const state = stateByBin.get(binId.toString());
        const amountToBurn = plan.amounts[index];
        if (!state || amountToBurn === undefined) {
          throw new Error(`Live burn state is missing for bin ${binId.toString()}`);
        }

        return {
          binId,
          amountToBurn,
          reserveX: BigInt(state.reserveX),
          reserveY: BigInt(state.reserveY),
          totalSupply: BigInt(state.totalSupply)
        };
      })
    );
    const minimums = applyBurnQuoteSlippage(quote, slippageBps);

    if (minimums.expectedAmountXOut !== quote.amountXOut || minimums.expectedAmountYOut !== quote.amountYOut) {
      throw new Error("Burn minimums are not bound to the displayed expected outputs");
    }

    if ((quote.amountXOut === 0n) !== (minimums.amountXMin === 0n) || (quote.amountYOut === 0n) !== (minimums.amountYMin === 0n)) {
      throw new Error("Burn minimums may be zero only when the corresponding expected output is zero");
    }

    return { error: null, minimums, quote };
  } catch (error) {
    return { error: getWriteError(error) ?? "Burn output quote failed", minimums: null, quote: null };
  }
}

function buildBurnQuoteExecutionBinding(
  snapshot: LiveBurnSnapshot | null,
  plan: PositionBurnPlanResult,
  quoteView: BurnQuoteView
): BurnQuoteExecutionBinding | null {
  if (snapshot === null || plan.blocked || quoteView.quote === null || quoteView.minimums === null) return null;

  const liveBalanceByBin = new Map(snapshot.balances.map((row) => [String(row.binId), String(row.balance ?? "missing")]));

  return {
    balances: snapshot.balances.map((row) => ({ binId: String(row.binId), balance: String(row.balance ?? "missing") })),
    binStates: snapshot.binStates.map((row) => ({ ...row })),
    burnAmounts: plan.ids.map((binId, index) => ({
      binId: binId.toString(),
      amount: plan.amounts[index]?.toString() ?? "missing",
      liveBalance: liveBalanceByBin.get(binId.toString()) ?? "missing"
    })),
    expectedAmountXOut: quoteView.quote.amountXOut.toString(),
    expectedAmountYOut: quoteView.quote.amountYOut.toString(),
    minimumAmountXOut: quoteView.minimums.amountXMin.toString(),
    minimumAmountYOut: quoteView.minimums.amountYMin.toString()
  };
}

function buildBurnQuoteExecutionFingerprint(
  snapshot: LiveBurnSnapshot | null,
  plan: PositionBurnPlanResult,
  quoteView: BurnQuoteView
): string | null {
  const binding = buildBurnQuoteExecutionBinding(snapshot, plan, quoteView);
  return binding === null ? null : burnQuoteExecutionFingerprint(binding);
}

function formatSwapOutput(loading: boolean, amountOut: bigint | null, token: TokenMetadata | null): string {
  if (loading) return "Quoting...";
  if (amountOut === null) return "0";
  return formatTokenAmount(amountOut.toString(), token);
}

function formatBps(value: bigint): string {
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, "0");

  return `${whole}.${fraction}%`;
}

function serializeExactInQuote(quote: ExactInQuote): SerializedExactInQuote {
  return {
    route: [...quote.route],
    pairs: [...quote.pairs],
    binSteps: quote.binSteps.map((value) => value.toString()),
    versions: [...quote.versions],
    amounts: quote.amounts.map((value) => value.toString()),
    virtualAmountsWithoutSlippage: quote.virtualAmountsWithoutSlippage.map((value) => value.toString()),
    fees: quote.fees.map((value) => value.toString())
  };
}

function deserializeExactInQuote(quote: SerializedExactInQuote): ExactInQuote {
  return {
    route: [...quote.route],
    pairs: [...quote.pairs],
    binSteps: quote.binSteps.map((value) => BigInt(value)),
    versions: [...quote.versions],
    amounts: quote.amounts.map((value) => BigInt(value)),
    virtualAmountsWithoutSlippage: quote.virtualAmountsWithoutSlippage.map((value) => BigInt(value)),
    fees: quote.fees.map((value) => BigInt(value))
  };
}

function quoteToRouteStepViews(quote: ExactInQuote, tokenIn: TokenMetadata | null, tokenOut: TokenMetadata | null): RouteStepView[] {
  return quoteToRouteSteps(quote).map((step, index) => ({
    key: `${step.pair}-${index}`,
    pair: formatCompactAddress(step.pair),
    binStep: step.binStep.toString(),
    version: step.version === 3 ? "V2.2" : `V${step.version}`,
    tokenIn: tokenLabelForAddress(step.tokenIn, tokenIn, tokenOut),
    tokenOut: tokenLabelForAddress(step.tokenOut, tokenIn, tokenOut)
  }));
}

function tokenLabelForAddress(address: Address, tokenIn: TokenMetadata | null, tokenOut: TokenMetadata | null): string {
  if (tokenIn && sameAddress(address, tokenIn.address)) return tokenSymbol(tokenIn);
  if (tokenOut && sameAddress(address, tokenOut.address)) return tokenSymbol(tokenOut);

  return formatCompactAddress(address);
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseSlippageToBps(value: string): bigint | null {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return null;
  }

  return BigInt(Math.round(parsed * 100));
}

function formatQuoteFreshness(updatedAt: number | null, now: number): string {
  if (updatedAt === null) return "n/a";

  const ageMs = Math.max(0, now - updatedAt);

  if (quoteIsStale(updatedAt, now)) {
    return "stale";
  }

  return `${Math.ceil((QUOTE_STALE_MS - ageMs) / 1_000)}s valid`;
}

function buttonLabel({
  connected,
  invalidInput,
  insufficientBalance,
  insufficientGas,
  needsApproval,
  onWrongChain,
  poolReady,
  quoteLoading,
  quoteReady,
  safetyReason,
  walletError,
  walletLoading
}: {
  connected: boolean;
  invalidInput: boolean;
  insufficientBalance: boolean;
  insufficientGas: boolean;
  needsApproval: boolean;
  onWrongChain: boolean;
  poolReady: boolean;
  quoteLoading: boolean;
  quoteReady: boolean;
  safetyReason: string | null;
  walletError: boolean;
  walletLoading: boolean;
}): string {
  if (!poolReady) return "Unavailable";
  if (!connected) return "Connect wallet";
  if (onWrongChain) return "Switch network";
  if (walletError) return "Wallet read failed";
  if (walletLoading) return "Loading wallet";
  if (invalidInput) return "Check settings";
  if (insufficientBalance) return "Insufficient balance";
  if (insufficientGas) return "Insufficient ETH for gas";
  if (needsApproval) return "Approve first";
  if (safetyReason) return safetyReason;
  if (quoteLoading) return "Quoting";
  if (!quoteReady) return "No route";

  return "Swap";
}

function getWriteError(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string") {
    return error.shortMessage;
  }
  if (error instanceof Error) return error.message;

  return "Transaction failed";
}

function isRevertedReceiptError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();

  while (current !== null && current !== undefined && !visited.has(current)) {
    visited.add(current);
    const message = getWriteError(current);
    if (message !== null && /revert/i.test(message)) return true;
    current = typeof current === "object" && "cause" in current ? current.cause : null;
  }

  return false;
}

async function runPreSubmitSimulation<T>(
  simulate: () => Promise<T>,
  setError: (message: string | null) => void,
  setPending: (pending: boolean) => void,
  isCurrent: () => boolean = () => true
): Promise<T | null> {
  setError(null);
  setPending(true);

  try {
    const result = await simulate();
    return isCurrent() ? result : null;
  } catch (error) {
    if (isCurrent()) {
      setError(`Simulation failed: ${getWriteError(error) ?? "Transaction simulation failed"}`);
    }
    return null;
  } finally {
    if (isCurrent()) setPending(false);
  }
}

async function reviewExactGas(input: {
  action: string;
  currentReview: ExactGasReview | null;
  estimateGas: () => Promise<bigint>;
  executionFingerprint: string;
  getBalance: () => Promise<bigint>;
  getGasPrice: () => Promise<bigint>;
  isCurrent: () => boolean;
  onReview?: (review: ExactGasReview, nativeBalance: bigint) => void;
  setError: (message: string | null) => void;
  setReview: (review: ExactGasReview | null) => void;
  transactionValue?: bigint;
}): Promise<boolean> {
  try {
    const [gasLimit, gasPrice, nativeBalance] = await Promise.all([input.estimateGas(), input.getGasPrice(), input.getBalance()]);
    if (!input.isCurrent()) return false;
    const bufferedWei = (gasLimit * gasPrice * GAS_BUFFER_BPS + 9_999n) / 10_000n;
    const transactionValue = input.transactionValue ?? 0n;
    const requiredWei = bufferedWei + transactionValue;
    const review = { action: input.action, bufferedWei, executionFingerprint: input.executionFingerprint, gasLimit, gasPrice, requiredWei, transactionValue };
    input.onReview?.(review, nativeBalance);
    if (nativeBalance < requiredWei) {
      input.setReview(review);
      input.setError(`Insufficient ETH for gas and value: exact buffered requirement is ${formatUnits(requiredWei, 18)} ETH, but this wallet has ${formatUnits(nativeBalance, 18)} ETH`);
      return false;
    }
    if (
      input.currentReview === null ||
      input.currentReview.action !== input.action ||
      input.currentReview.executionFingerprint !== input.executionFingerprint ||
      requiredWei > input.currentReview.requiredWei
    ) {
      input.setReview(review);
      input.setError(null);
      return false;
    }
    input.setReview(review);
    input.setError(null);
    return true;
  } catch (error) {
    if (input.isCurrent()) {
      input.setReview(null);
      input.setError(`Gas estimation failed: ${getWriteError(error) ?? "gas limit or gas price unavailable"}`);
    }
    return false;
  }
}

function GasReview({ review }: { review: ExactGasReview | null }) {
  if (review === null) return null;
  return (
    <div className="state-row warning" data-testid="gas-review" role="status">
      <CircleDollarSign size={16} />
      <span>Non-guaranteed gas estimate for {review.action}: limit {review.gasLimit.toString()} × {formatUnits(review.gasPrice, 9)} gwei + 25% gas buffer{review.transactionValue > 0n ? ` + ${formatUnits(review.transactionValue, 18)} ETH value` : ""} = {formatUnits(review.requiredWei, 18)} ETH required. Submit again to re-estimate and open the wallet.</span>
    </div>
  );
}

function LiquidityAddReviewPanel({
  reviewJson,
  tokenX,
  tokenY
}: {
  reviewJson: string | null;
  tokenX: TokenMetadata | null;
  tokenY: TokenMetadata | null;
}) {
  if (reviewJson === null) return null;
  const reviewState = deserializeBigintState<LiquidityAddReviewState>(reviewJson);
  const { math, parameters, simulation, block } = reviewState.review;
  const positionX = simulation.amountXAdded - math.compositionFeeX;
  const positionY = simulation.amountYAdded - math.compositionFeeY;
  return (
    <div className="review-card" data-testid="liquidity-add-review" role="status">
      <div className="panel-heading">
        <span>Pinned liquidity review</span>
        <StatusBadge state="ready" label={`block ${block.number.toString()}`} />
      </div>
      <div className="quote-grid">
        <MiniMetric data-testid="liquidity-review-added-x" label={`${tokenSymbol(tokenX)} added (fee included)`} value={formatTokenAmount(simulation.amountXAdded.toString(), tokenX)} />
        <MiniMetric data-testid="liquidity-review-added-y" label={`${tokenSymbol(tokenY)} added (fee included)`} value={formatTokenAmount(simulation.amountYAdded.toString(), tokenY)} />
        <MiniMetric data-testid="liquidity-review-position-x" label={`${tokenSymbol(tokenX)} after composition fee`} value={formatTokenAmount(positionX.toString(), tokenX)} />
        <MiniMetric data-testid="liquidity-review-position-y" label={`${tokenSymbol(tokenY)} after composition fee`} value={formatTokenAmount(positionY.toString(), tokenY)} />
        <MiniMetric label={`${tokenSymbol(tokenX)} deposited to bins`} value={formatTokenAmount((simulation.amountXAdded - math.protocolFeeX).toString(), tokenX)} />
        <MiniMetric label={`${tokenSymbol(tokenY)} deposited to bins`} value={formatTokenAmount((simulation.amountYAdded - math.protocolFeeY).toString(), tokenY)} />
        <MiniMetric data-testid="liquidity-review-refund-x" label={`${tokenSymbol(tokenX)} refund`} value={formatTokenAmount(simulation.amountXLeft.toString(), tokenX)} />
        <MiniMetric data-testid="liquidity-review-refund-y" label={`${tokenSymbol(tokenY)} refund`} value={formatTokenAmount(simulation.amountYLeft.toString(), tokenY)} />
        <MiniMetric data-testid="liquidity-review-fee-x" label={`${tokenSymbol(tokenX)} composition fee estimate`} value={formatTokenAmount(math.compositionFeeX.toString(), tokenX)} />
        <MiniMetric data-testid="liquidity-review-fee-y" label={`${tokenSymbol(tokenY)} composition fee estimate`} value={formatTokenAmount(math.compositionFeeY.toString(), tokenY)} />
        <MiniMetric label={`${tokenSymbol(tokenX)} protocol fee estimate`} value={formatTokenAmount(math.protocolFeeX.toString(), tokenX)} />
        <MiniMetric label={`${tokenSymbol(tokenY)} protocol fee estimate`} value={formatTokenAmount(math.protocolFeeY.toString(), tokenY)} />
        <MiniMetric label={`${tokenSymbol(tokenX)} minimum`} value={formatTokenAmount(parameters.amountXMin.toString(), tokenX)} />
        <MiniMetric label={`${tokenSymbol(tokenY)} minimum`} value={formatTokenAmount(parameters.amountYMin.toString(), tokenY)} />
        <MiniMetric label="Position recipient" value={formatCompactAddress(parameters.to)} />
        <MiniMetric label="Refund recipient" value={formatCompactAddress(parameters.refundTo)} />
        <MiniMetric label="Projected bins" value={simulation.depositIds.length.toString()} />
        <MiniMetric label="Projected LB shares" value={simulation.liquidityMinted.reduce((total: bigint, shares: bigint) => total + shares, 0n).toString()} />
        <MiniMetric label="Pinned timestamp" value={block.timestamp.toString()} />
        <MiniMetric label="Pinned block hash" value={formatCompactAddress(block.hash)} />
      </div>
      <section className="approval-disclosure" data-testid="liquidity-review-exact-destination" aria-label="Exact liquidity destination and deadline">
        <strong>Exact destination and expiry</strong>
        <dl>
          <div><dt>Position recipient</dt><dd><code className="approval-address">{parameters.to}</code></dd></div>
          <div><dt>Refund recipient</dt><dd><code className="approval-address">{parameters.refundTo}</code></dd></div>
          <div><dt>Unix deadline</dt><dd>{parameters.deadline.toString()}</dd></div>
          <div><dt>Native value</dt><dd>{reviewState.review.assetMode === "native" ? `${formatUnits(reviewState.review.transaction.value, 18)} ETH · addLiquidityNATIVE` : "0 ETH · ERC-20 addLiquidity"}</dd></div>
        </dl>
      </section>
      <details className="review-details" data-testid="liquidity-review-bin-shares">
        <summary>Projected per-bin claims</summary>
        <div className="quote-grid">
          {math.bins.map((bin, index) => (
            <MiniMetric
              key={`${bin.binId.toString()}-${index}`}
              label={`Bin ${bin.binId.toString()} shares`}
              value={`${bin.mintedShares.toString()} · fee ${formatUnits(bin.totalFeeRate, 16)}%`}
            />
          ))}
        </div>
      </details>
      <div className="state-row warning" data-testid="liquidity-review-limitations">
        <AlertTriangle size={16} />
        <span>Composition and protocol fees are pinned estimates, not guarantees. Token minima protect total amounts added, including composition fees; they do not protect fee size or LB shares. Any block, timestamp, volatility, active-bin, recipient, range, amount, or calldata change requires another review.</span>
      </div>
      <div className="state-row" data-testid="liquidity-review-native-scope">
        <CircleDollarSign size={16} />
        <span>{reviewState.review.assetMode === "native" ? "ETH is wrapped by the router and sent to the pair. Any unused native-side amount is refunded as wrapped-native ERC-20, not ETH." : "This review uses ERC-20 addLiquidity with zero transaction value; ETH is used only for gas."}</span>
      </div>
    </div>
  );
}

function LiquidityReceiptReview({
  error,
  hash,
  reconciliationJson,
  tokenX,
  tokenY
}: {
  error: unknown;
  hash: Address | null;
  reconciliationJson: string | null;
  tokenX: TokenMetadata | null;
  tokenY: TokenMetadata | null;
}) {
  if (hash === null) return null;
  if (error !== null && error !== undefined) {
    return <div aria-atomic="true" className="state-row failure" data-testid="liquidity-receipt-review-error" role="alert"><AlertTriangle size={16} /><span>Canonical receipt accounting failed closed: {getWriteError(error)}</span></div>;
  }
  if (reconciliationJson === null) {
    return <div className="state-row" data-testid="liquidity-receipt-review-loading"><LoaderCircle className="spin" size={16} /><span>Reconciling canonical receipt {formatCompactAddress(hash)}</span></div>;
  }
  const reconciliation = deserializeBigintState<AddLiquidityReceiptReconciliation>(reconciliationJson);
  const nativeReconciliation = "nativeValueWei" in reconciliation ? reconciliation as NativeAddLiquidityReceiptReconciliation : null;
  return (
    <div className="review-card" data-testid="liquidity-receipt-review">
      <div className="panel-heading"><span>Canonical receipt accounting</span><StatusBadge state={reconciliation.estimateMatchedActual ? "ready" : "partial"} label={reconciliation.estimateMatchedActual ? "estimate matched" : "execution drift"} /></div>
      <div className="quote-grid">
        <MiniMetric label={`${tokenSymbol(tokenX)} actually added`} value={formatTokenAmount(reconciliation.actualAddedX.toString(), tokenX)} />
        <MiniMetric label={`${tokenSymbol(tokenY)} actually added`} value={formatTokenAmount(reconciliation.actualAddedY.toString(), tokenY)} />
        <MiniMetric label={`${tokenSymbol(tokenX)} actual composition fee`} value={formatTokenAmount(reconciliation.compositionFeeX.toString(), tokenX)} />
        <MiniMetric label={`${tokenSymbol(tokenY)} actual composition fee`} value={formatTokenAmount(reconciliation.compositionFeeY.toString(), tokenY)} />
        <MiniMetric label={`${tokenSymbol(tokenX)} actual protocol fee`} value={formatTokenAmount(reconciliation.protocolFeeX.toString(), tokenX)} />
        <MiniMetric label={`${tokenSymbol(tokenY)} actual protocol fee`} value={formatTokenAmount(reconciliation.protocolFeeY.toString(), tokenY)} />
        <MiniMetric label={`${tokenSymbol(tokenX)} actual refund`} value={reconciliation.refundedX === null ? "unavailable" : formatTokenAmount(reconciliation.refundedX.toString(), tokenX)} />
        <MiniMetric label={`${tokenSymbol(tokenY)} actual refund`} value={reconciliation.refundedY === null ? "unavailable" : formatTokenAmount(reconciliation.refundedY.toString(), tokenY)} />
        <MiniMetric label={`${tokenSymbol(tokenX)} wallet delta`} value={reconciliation.eventObservedNetSpendX === null ? "unavailable from events" : `-${formatTokenAmount(reconciliation.eventObservedNetSpendX.toString(), tokenX)}`} />
        <MiniMetric label={`${tokenSymbol(tokenY)} wallet delta`} value={reconciliation.eventObservedNetSpendY === null ? "unavailable from events" : `-${formatTokenAmount(reconciliation.eventObservedNetSpendY.toString(), tokenY)}`} />
        <MiniMetric label="Actual minted bins" value={reconciliation.mintedIds.join(", ")} />
        <MiniMetric label="Actual LB shares" value={reconciliation.mintedShares.reduce((total, shares) => total + shares, 0n).toString()} />
        <MiniMetric label="Actual gas used" value={reconciliation.actualGasUsed.toString()} />
        <MiniMetric label="Actual gas cost" value={`${formatUnits(reconciliation.actualGasCostWei, 18)} ETH`} />
        {nativeReconciliation ? <MiniMetric label="Exact native value" value={`${formatUnits(nativeReconciliation.nativeValueWei, 18)} ETH`} /> : null}
        {nativeReconciliation ? <MiniMetric label="Wrapped-native refund" value={formatTokenAmount(nativeReconciliation.wrapperRefund.toString(), tokenX?.tags.includes("wrapped-native") ? tokenX : tokenY)} /> : null}
        {nativeReconciliation ? <MiniMetric label="LP balance deltas" value={nativeReconciliation.lpBalanceDeltas.map((row) => `${row.binId.toString()}:${row.delta.toString()}`).join(", ")} /> : null}
      </div>
      <details className="review-details" data-testid="liquidity-receipt-bin-shares">
        <summary>Actual per-bin claims</summary>
        <div className="quote-grid">
          {reconciliation.mintedIds.map((id, index) => <MiniMetric key={`${id.toString()}-${index}`} label={`Bin ${id.toString()} shares`} value={reconciliation.mintedShares[index]?.toString() ?? "unavailable"} />)}
        </div>
      </details>
      {reconciliation.estimateDifferences.length > 0 ? (
        <div className="state-row warning" data-testid="liquidity-receipt-drift"><AlertTriangle size={16} /><span>Estimate versus actual: {reconciliation.estimateDifferences.join("; ")}.</span></div>
      ) : null}
      <div className="state-row"><CheckCircle2 size={16} /><span>Actual fees, deposited amounts, residual transfers, bin IDs, and shares come from the canonical replacement-aware receipt. Wallet delta is shown only when standard direct Transfer evidence reconciles exactly; otherwise it remains unavailable.</span></div>
    </div>
  );
}

function NativeRemoveReceiptReview({
  error,
  hash,
  reconciliation
}: {
  error: unknown;
  hash: Address | null;
  reconciliation: NativeRemoveLiquidityReceiptReconciliation | undefined;
}) {
  if (hash === null) return null;
  if (error !== null && error !== undefined) {
    return <div aria-atomic="true" className="state-row failure" data-testid="remove-receipt-review-error" role="alert"><AlertTriangle size={16} /><span>Canonical native withdrawal accounting failed closed: {getWriteError(error)}</span></div>;
  }
  if (reconciliation === undefined) {
    return <div className="state-row" data-testid="remove-receipt-review-loading"><LoaderCircle className="spin" size={16} /><span>Reconciling canonical native withdrawal {formatCompactAddress(hash)}</span></div>;
  }
  return (
    <div className="review-card" data-testid="remove-receipt-review">
      <div className="panel-heading"><span>Canonical native withdrawal</span><StatusBadge state="ready" label="exactly reconciled" /></div>
      <div className="quote-grid">
        <MiniMetric label="ETH received" value={`${formatUnits(reconciliation.nativeAmount, 18)} ETH`} />
        <MiniMetric label="Other token received" value={reconciliation.otherTokenAmount.toString()} />
        <MiniMetric label="Actual gas cost" value={`${formatUnits(reconciliation.actualGasCostWei, 18)} ETH`} />
        <MiniMetric label="Burned bins" value={reconciliation.burnedBalances.map((row) => `${row.binId.toString()}:${row.delta.toString()}`).join(", ")} />
      </div>
      <div className="state-row"><CheckCircle2 size={16} /><span>Gas-adjusted ETH, the other-token receipt, withdrawal events, burn events, and every per-bin LB decrease match the immutable reviewed transaction.</span></div>
    </div>
  );
}

function serializeBigintState(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value, (_key, candidate) => typeof candidate === "bigint" ? { __featherBigint: candidate.toString() } : candidate);
}

function deserializeBigintState<T>(value: string): T {
  return JSON.parse(value, (_key, candidate) =>
    candidate !== null &&
    typeof candidate === "object" &&
    Object.keys(candidate).length === 1 &&
    typeof candidate.__featherBigint === "string"
      ? BigInt(candidate.__featherBigint)
      : candidate
  ) as T;
}

function PairAttestationReview({
  attestation,
  error,
  loading
}: {
  attestation: PairAttestation | null;
  error: unknown;
  loading: boolean;
}) {
  const message = error instanceof PairAttestationError ? error.message : error ? "Live pair attestation is unavailable" : null;
  return (
    <div className={`state-row ${message ? "failure" : attestation ? "success" : "pending"}`} data-testid="pair-attestation-review" role="status">
      {message ? <AlertTriangle size={16} /> : attestation ? <CheckCircle2 size={16} /> : <LoaderCircle className={loading ? "spin" : undefined} size={16} />}
      <span>
        {message ?? (attestation
          ? `Pair verified · ${attestation.hookIdentity}${attestation.hookAddress ? ` · ${attestation.hookAddress}` : ""} · risk ${attestation.hookRisk} · ${attestation.behavior}${attestation.hookFlags.length ? ` · ${attestation.hookFlags.join(", ")}` : ""}`
          : "Verifying factory, pair implementation, token order, bin step, and hooks")}
      </span>
    </div>
  );
}

function PoolsView({
  catalogPools,
  environmentKey,
  onConfirmedPool,
  onCatalogRefresh,
  onRefresh,
  pools,
  rpcOverlay,
  snapshot,
  snapshotState
}: {
  catalogPools: PoolRow[];
  environmentKey: EnvironmentKey;
  onConfirmedPool: (overlay: ConfirmedPoolOverlay | null) => void;
  onCatalogRefresh: () => Promise<void>;
  onRefresh: SnapshotRefetch;
  pools: PoolRow[];
  rpcOverlay: ConfirmedPoolOverlay | null;
  snapshot: AppSnapshot | undefined;
  snapshotState: LoadState;
}) {
  const registry = registries[environmentKey];
  const account = useAccount();
  const [discoveryState, setDiscoveryState] = useState<PoolDiscoveryState>(() =>
    typeof window === "undefined" ? { ...DEFAULT_POOL_DISCOVERY_STATE } : parsePoolDiscoveryState(window.location.hash)
  );
  const [creationOpen, setCreationOpen] = useState(() =>
    typeof window !== "undefined" && poolCreationWasOpen(window.sessionStorage, environmentKey)
  );
  const creationLaunchRef = useRef<HTMLButtonElement>(null);
  const pageSize = 10;
  const analyticsEndpoint = analyticsEndpointForRegistry(registry);
  const ownerPortfolioQuery = useQuery({
    queryKey: ["poolDiscoveryOwner", environmentKey, account.address, analyticsEndpoint],
    queryFn: async () => {
      if (!account.address || analyticsEndpoint === null) throw new Error("Wallet analytics are unavailable");
      const page = await loadWalletPortfolio(analyticsEndpoint, account.address);
      if (page.positions.some((position) => position.owner.toLowerCase() !== account.address!.toLowerCase())) {
        throw new Error("Wallet analytics returned a position for another owner");
      }
      return page;
    },
    enabled: discoveryState.hasLiquidity && account.address !== undefined && analyticsEndpoint !== null,
    refetchInterval: discoveryState.hasLiquidity ? SNAPSHOT_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const discoveryRequests = useMemo(
    () => buildPoolDiscoveryRequests(pools),
    [pools]
  );
  const discoveryRequestKey = discoveryRequests
    .map((request) => `${request.pair}:${request.preferredQuoteToken ?? "auto"}`)
    .join("|");
  const discoveryQuery = useQuery({
    queryKey: ["poolDiscovery", environmentKey, analyticsEndpoint, discoveryRequestKey],
    queryFn: () => loadPoolDiscoveryBatches(analyticsEndpoint, discoveryRequests),
    enabled: discoveryRequests.length > 0,
    refetchInterval: SNAPSHOT_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const discoveryAnalytics = discoveryQuery.data ?? {
    rows: [],
    status: discoveryQuery.isError ? "UNAVAILABLE" as const : "PARTIAL" as const,
    error: discoveryQuery.error instanceof Error ? discoveryQuery.error.message : null,
    pageInfo: { endCursor: null, hasNextPage: false, partial: true, pagesLoaded: 0 },
    streamCursor: null
  };
  const discoveryRows = useMemo(
    () => buildPoolDiscoveryRows(pools, discoveryAnalytics, analyticsEndpoint),
    [analyticsEndpoint, pools, discoveryAnalytics]
  );
  const ownerLiquidity = ownerPortfolioQuery.data
    ? buildOwnerLiquidityIndex(ownerPortfolioQuery.data.positions, {
        capped: ownerPortfolioQuery.data.pageInfo.hasNextPage,
        failed: ownerPortfolioQuery.data.pageInfo.partial || !ownerPortfolioQuery.data.health.fresh || ownerPortfolioQuery.data.health.status !== "READY"
      })
    : null;
  const filteredPage = useMemo(
    () => filterPoolPage(discoveryRows, discoveryState, ownerLiquidity, pageSize),
    [discoveryRows, discoveryState, ownerLiquidity]
  );

  useEffect(() => {
    const read = () => setDiscoveryState(parsePoolDiscoveryState(window.location.hash));
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const updateDiscovery = (next: Partial<PoolDiscoveryState>, resetPage = true) => {
    const state = { ...discoveryState, ...next, page: resetPage ? 0 : next.page ?? discoveryState.page };
    setDiscoveryState(state);
    window.history.replaceState(null, "", discoveryHref(state));
  };
  const ownerFilterLoading = discoveryState.hasLiquidity && account.address !== undefined && analyticsEndpoint !== null &&
    (ownerPortfolioQuery.isPending || ownerPortfolioQuery.isFetching);
  const closeCreation = useCallback(() => {
    setPoolCreationOpen(window.sessionStorage, environmentKey, false);
    setCreationOpen(false);
    requestAnimationFrame(() => creationLaunchRef.current?.focus());
  }, [environmentKey]);
  const sortPools = (sort: PoolDiscoveryState["sort"]) => {
    updateDiscovery({
      sort,
      direction: discoveryState.sort === sort
        ? discoveryState.direction === "desc" ? "asc" : "desc"
        : "desc"
    });
  };
  const marketFiltersActive = discoveryState.sort !== DEFAULT_POOL_DISCOVERY_STATE.sort ||
    discoveryState.direction !== DEFAULT_POOL_DISCOVERY_STATE.direction ||
    discoveryState.minTvlUsd !== null ||
    discoveryState.minVolume24hUsd !== null ||
    discoveryState.minLpFees24hUsd !== null;

  return (
    <div className="view-grid">
      {creationOpen ? (
        <PoolCreationWizard
          analyticsState={snapshotState}
          environmentKey={environmentKey}
          indexedPools={catalogPools}
          onClose={closeCreation}
          onConfirmedPool={onConfirmedPool}
          onCatalogRefresh={onCatalogRefresh}
          onRefresh={onRefresh}
          snapshot={snapshot}
        />
      ) : null}
      <section aria-labelledby="pools-discovery-title" className="pools-discovery">
        <header className="pools-discovery-header">
          <div className="pools-discovery-heading">
            <h1 id="pools-discovery-title">Pools</h1>
            <span className="pools-discovery-count">
              {pools.length} {pools.length === 1 ? "pool" : "pools"}
            </span>
          </div>
          <div className="pool-heading-actions">
            <button
              className="primary-button"
              data-testid="pool-create-launch"
              onClick={() => {
                setPoolCreationOpen(window.sessionStorage, environmentKey, true);
                setCreationOpen(true);
              }}
              ref={creationLaunchRef}
              type="button"
            >
              Create pool
            </button>
          </div>
        </header>
        {rpcOverlay ? (
          <div className="pools-discovery-warning" data-testid="pool-rpc-overlay" role="status">
            <Server size={16} />
            <span>{rpcOverlay.recovery.kind === "duplicate"
              ? `Resolved from the live factory at block ${rpcOverlay.row.updatedAtBlock}; the exact RPC workspace remains available while indexing catches up.`
              : `Confirmed by RPC at block ${rpcOverlay.row.updatedAtBlock}; indexing is catching up. This empty pool cannot quote swaps.`}</span>
          </div>
        ) : null}
        {!discoveryQuery.isPending && discoveryAnalytics.status === "UNAVAILABLE" && pools.length > 0 ? (
          <p className="pools-discovery-warning" data-testid="pool-discovery-warning" role="alert">
            <AlertTriangle aria-hidden="true" size={15} />
            <span title={discoveryAnalytics.error ?? undefined}>Market analytics could not load. Pool links remain available.</span>
          </p>
        ) : null}
        <div className="pools-discovery-toolbar">
          <label className="pools-discovery-search">
            <span className="visually-hidden">Search pools</span>
            <input
              aria-label="Search pools"
              onChange={(event) => updateDiscovery({ query: event.target.value })}
              placeholder="Pair, token, or address"
              value={discoveryState.query}
            />
          </label>
          <div className="pools-category-tabs" role="group" aria-label="Pool category">
            {(["all", "active", "stables"] as const).map((value) => (
              <button
                className={discoveryState.category === value ? "active" : undefined}
                key={value}
                onClick={() => updateDiscovery({ category: value })}
                type="button"
              >
                {value === "all" ? "All DLMM" : value === "active" ? "Active" : "Stables"}
              </button>
            ))}
            <button
              aria-pressed={discoveryState.hasLiquidity}
              className={discoveryState.hasLiquidity ? "active" : undefined}
              disabled={!account.address && !discoveryState.hasLiquidity}
              onClick={() => updateDiscovery({ hasLiquidity: !discoveryState.hasLiquidity })}
              type="button"
            >
              My liquidity
            </button>
          </div>
          <details className="pools-filter-disclosure">
            <summary>Filters</summary>
            <div className="pools-filter-panel">
              <div className="pools-filter-grid">
                <label>
                  <span>Sort by</span>
                  <select
                    aria-label="Sort pools"
                    onChange={(event) => updateDiscovery({ sort: event.target.value as PoolDiscoveryState["sort"] })}
                    value={discoveryState.sort}
                  >
                    <option value="volume24h">24h volume</option>
                    <option value="priceChange">24h change</option>
                    <option value="marketCap">Market cap</option>
                    <option value="tvl">TVL</option>
                    <option value="lpFees24h">24h LP fees</option>
                  </select>
                </label>
                <label>
                  <span>Direction</span>
                  <select
                    aria-label="Sort direction"
                    onChange={(event) => updateDiscovery({ direction: event.target.value as PoolDiscoveryState["direction"] })}
                    value={discoveryState.direction}
                  >
                    <option value="desc">High to low</option>
                    <option value="asc">Low to high</option>
                  </select>
                </label>
                <label>
                  <span>Minimum TVL</span>
                  <input
                    aria-label="Minimum TVL in USD"
                    inputMode="decimal"
                    onChange={(event) => updateDiscovery({ minTvlUsd: event.target.value || null })}
                    placeholder="USD"
                    value={discoveryState.minTvlUsd ?? ""}
                  />
                </label>
                <label>
                  <span>Minimum volume</span>
                  <input
                    aria-label="Minimum 24 hour volume in USD"
                    inputMode="decimal"
                    onChange={(event) => updateDiscovery({ minVolume24hUsd: event.target.value || null })}
                    placeholder="USD"
                    value={discoveryState.minVolume24hUsd ?? ""}
                  />
                </label>
                <label>
                  <span>Minimum LP fees</span>
                  <input
                    aria-label="Minimum 24 hour LP fees in USD"
                    inputMode="decimal"
                    onChange={(event) => updateDiscovery({ minLpFees24hUsd: event.target.value || null })}
                    placeholder="USD"
                    value={discoveryState.minLpFees24hUsd ?? ""}
                  />
                </label>
                <button
                  className="pools-filter-reset"
                  disabled={!marketFiltersActive}
                  onClick={() => updateDiscovery({
                    sort: DEFAULT_POOL_DISCOVERY_STATE.sort,
                    direction: DEFAULT_POOL_DISCOVERY_STATE.direction,
                    minTvlUsd: null,
                    minVolume24hUsd: null,
                    minLpFees24hUsd: null
                  })}
                  type="button"
                >
                  Reset market filters
                </button>
              </div>
            </div>
          </details>
        </div>
        {pools.length > 0 ? (
          <>
            {filteredPage.rows.length > 0 ? (
              <div className="pools-market-table-wrap">
                <table className="pools-market-table" data-testid="pools-market-table">
                  <caption className="visually-hidden">DLMM pool market data</caption>
                  <colgroup><col /><col /><col /><col /><col /><col /><col /></colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Pair</th>
                      <PoolSortableHeader activeSort={discoveryState.sort} direction={discoveryState.direction} label="24h price trend" onSort={sortPools} sort="priceChange" />
                      <PoolSortableHeader activeSort={discoveryState.sort} direction={discoveryState.direction} label="Market cap" onSort={sortPools} sort="marketCap" />
                      <th scope="col">Pool price</th>
                      <PoolSortableHeader activeSort={discoveryState.sort} direction={discoveryState.direction} label="TVL" onSort={sortPools} sort="tvl" />
                      <PoolSortableHeader activeSort={discoveryState.sort} direction={discoveryState.direction} label="24h LP fees" onSort={sortPools} sort="lpFees24h" />
                      <PoolSortableHeader activeSort={discoveryState.sort} direction={discoveryState.direction} label="24h volume" onSort={sortPools} sort="volume24h" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPage.rows.map((row) => (
                      <PoolDiscoveryTableRow
                        href={poolDetailHref(row.pool.id, discoveryState)}
                        key={row.pool.id}
                        row={row}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="pools-discovery-empty">No pools match these filters.</p>}
            {discoveryState.hasLiquidity && filteredPage.ownerStatus !== "ready" ? (
              <p className="state-row warning pools-discovery-owner-status" data-testid="owner-pool-filter-status">
                {!account.address
                  ? "Connect a wallet to filter pools by your liquidity."
                  : ownerFilterLoading
                    ? "Loading wallet liquidity from application analytics."
                    : filteredPage.ownerStatus === "partial"
                  ? "Wallet liquidity results are partial; only verified loaded pools are shown."
                  : analyticsEndpoint === null
                      ? "Wallet liquidity analytics are not configured for this environment."
                      : "Wallet liquidity analytics are unavailable."
                }
              </p>
            ) : null}
            <div className="pagination-controls" aria-label="Pool pages">
              <button disabled={filteredPage.page === 0} onClick={() => updateDiscovery({ page: Math.max(0, filteredPage.page - 1) }, false)} type="button">Previous</button>
              <span>Page {filteredPage.page + 1} of {filteredPage.pageCount} / {filteredPage.filteredCount} pools</span>
              <button disabled={filteredPage.page + 1 >= filteredPage.pageCount} onClick={() => updateDiscovery({ page: Math.min(filteredPage.pageCount - 1, filteredPage.page + 1) }, false)} type="button">Next</button>
            </div>
          </>
        ) : snapshotState === "unavailable" ? (
          <div className="empty-state" data-testid="pool-discovery-rpc-only" role="status">
            <Server size={22} />
            <span>Pool analytics are temporarily unavailable. Try again in a moment.</span>
          </div>
        ) : snapshotState === "empty" ? (
          <div className="empty-state" data-testid="pool-discovery-empty" role="status">
            <Server size={22} />
            <span>No pools have been created in this deployment yet.</span>
          </div>
        ) : (
          <EmptyState state={snapshotState} />
        )}
      </section>
    </div>
  );
}

function PoolDiscoveryTableRow({ href, row }: { href: string; row: PoolDiscoveryDisplayRow<PoolRow> }) {
  const pairLabel = `${row.baseToken.symbol} / ${row.quoteToken.symbol}`;
  return (
    <tr data-pool-id={row.pool.id} data-testid="pool-discovery-row">
      <th scope="row">
        <a aria-label={`Open ${pairLabel} pool`} className="pool-pair-link" href={href}>
          <span className="pool-token-stack">
            <PoolTokenMark
              address={row.baseToken.address}
              fallbackColor={row.baseToken.logo.fallbackColor}
              fallbackLabel={row.baseToken.logo.fallbackLabel}
              logoUrl={row.baseToken.logo.src}
            />
            <PoolTokenMark
              address={row.quoteToken.address}
              fallbackColor={row.quoteToken.logo.fallbackColor}
              fallbackLabel={row.quoteToken.logo.fallbackLabel}
              logoUrl={row.quoteToken.logo.src}
            />
          </span>
          <span className="pool-pair-copy">
            <span className="pool-pair-symbols">{pairLabel}</span>
            <span className="pool-pair-meta">DLMM · bin step {row.pool.binStep}</span>
          </span>
        </a>
      </th>
      <td className="pool-trend-column">
        <span className="pool-mobile-label">24h price trend</span>
        <PoolSparkline
          ariaLabel={`${pairLabel} 24 hour price trend${row.priceChange24hE18 === null ? "" : `, ${row.priceChange24hPct}`}`}
          change={row.priceChange24hE18 === null ? null : row.priceChange24hPct}
          segments={row.trend.segments}
          title={row.trend.title}
        />
      </td>
      <td>
        <PoolMarketValue
          label="Market cap"
          testId="pool-market-cap"
          unavailableReason={row.marketCap.title}
          value={row.marketCap.available ? row.marketCap.display : null}
        />
      </td>
      <td>
        <PoolMarketValue
          detail={`${row.quoteToken.symbol} per ${row.baseToken.symbol}`}
          label="Pool price"
          unavailableReason={row.poolPrice.title}
          value={row.poolPrice.available ? row.poolPrice.display : null}
        />
      </td>
      <td>
        <PoolMarketValue label="TVL" unavailableReason={row.tvl.title} value={row.tvl.available ? row.tvl.display : null} />
      </td>
      <td>
        <PoolMarketValue label="24h LP fees" unavailableReason={row.lpFees24h.title} value={row.lpFees24h.available ? row.lpFees24h.display : null} />
      </td>
      <td>
        <PoolMarketValue label="24h volume" unavailableReason={row.volume24h.title} value={row.volume24h.available ? row.volume24h.display : null} />
      </td>
    </tr>
  );
}

function PoolTokenMark({
  address,
  fallbackColor,
  fallbackLabel,
  logoUrl
}: {
  address: Address;
  fallbackColor: string;
  fallbackLabel: string;
  logoUrl: string | null;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [address, logoUrl]);
  const showLogo = logoUrl !== null && !logoFailed;
  return (
    <span
      aria-hidden="true"
      className="pool-token-mark"
      data-fallback={showLogo ? "false" : "true"}
      style={{ background: fallbackColor }}
    >
      {showLogo ? <img alt="" onError={() => setLogoFailed(true)} src={logoUrl} /> : fallbackLabel}
    </span>
  );
}

function PoolMarketValue({
  detail,
  label,
  testId,
  unavailableReason,
  value
}: {
  detail?: string | null;
  label: string;
  testId?: string;
  unavailableReason: string;
  value: string | null;
}) {
  return (
    <span className="pool-market-value" data-testid={testId}>
      <span className="pool-mobile-label">{label}</span>
      {value === null ? (
        <span aria-label={`${label} unavailable`} className="pool-value-unavailable" title={unavailableReason}>-</span>
      ) : (
        <span>{value}</span>
      )}
      {value !== null && detail ? <small>{detail}</small> : null}
    </span>
  );
}

function PoolSparkline({
  ariaLabel,
  change,
  segments,
  title
}: {
  ariaLabel: string;
  change: string | null;
  segments: readonly (readonly { x: number; y: number }[])[];
  title: string;
}) {
  if (segments.length === 0) {
    return <span aria-label="24 hour price trend unavailable" className="pool-value-unavailable" title={title}>-</span>;
  }
  const tone = change === null || change === "0%" || change === "0.00%" || change === "+0.00%"
    ? "neutral"
    : change.startsWith("-") ? "negative" : "positive";
  return (
    <span className={`pool-trend-cell ${tone}`}>
      <svg aria-label={ariaLabel} className="pool-sparkline" preserveAspectRatio="none" role="img" viewBox="0 0 104 34">
        <title>{title}</title>
        {segments.map((segment, index) => (
          <polyline
            key={`${index}-${segment[0]?.x ?? 0}`}
            points={segment.map((point) => `${(point.x * 1.04).toFixed(2)},${(point.y * 0.34).toFixed(2)}`).join(" ")}
          />
        ))}
      </svg>
      {change === null
        ? <span aria-label="24 hour price change unavailable" className="pool-value-unavailable" title="At least two canonical hourly closes are required.">-</span>
        : <span className={`pool-trend-value ${tone}`}>{change}</span>}
    </span>
  );
}

function PoolSortableHeader({
  activeSort,
  direction,
  label,
  onSort,
  sort
}: {
  activeSort: PoolDiscoveryState["sort"];
  direction: PoolDiscoveryState["direction"];
  label: string;
  onSort: (sort: PoolDiscoveryState["sort"]) => void;
  sort: PoolDiscoveryState["sort"];
}) {
  const active = activeSort === sort;
  const ariaSort = active ? direction === "asc" ? "ascending" : "descending" : "none";
  return (
    <th aria-sort={ariaSort} scope="col">
      <button
        aria-label={active ? `Sort by ${label}, currently ${ariaSort}` : `Sort by ${label}`}
        className={active ? "pool-sort-button active" : "pool-sort-button"}
        onClick={() => onSort(sort)}
        type="button"
      >
        <span>{label}</span>
        {active ? <span aria-hidden="true" className="pool-sort-indicator">{direction === "asc" ? "↑" : "↓"}</span> : null}
      </button>
    </th>
  );
}

type PoolCreationStep = "tokens" | "configure" | "review" | "create";

function PoolCreationWizard({
  analyticsState,
  environmentKey,
  indexedPools,
  onClose,
  onConfirmedPool,
  onCatalogRefresh,
  onRefresh,
  snapshot
}: {
  analyticsState: LoadState;
  environmentKey: EnvironmentKey;
  indexedPools: PoolRow[];
  onClose: () => void;
  onConfirmedPool: (overlay: ConfirmedPoolOverlay | null) => void;
  onCatalogRefresh: () => Promise<void>;
  onRefresh: SnapshotRefetch;
  snapshot: AppSnapshot | undefined;
}) {
  const registry = registries[environmentKey];
  const account = useAccount();
  const walletChainId = useChainId();
  const {
    error: poolCreationSwitchError,
    isPending: poolCreationSwitchPending,
    reset: resetPoolCreationSwitch,
    switchChain: switchPoolCreationChain
  } = useSwitchChain();
  const transactionJournal = useTransactionJournal();
  const createWrite = useSendTransaction();
  const publicClient = useMemo(() => createDexPublicClient(registry.chain, registry.endpoints.rpcUrl), [registry]);
  const draftAtMount = useRef(
    typeof window === "undefined" ? null : loadPoolCreationDraft(window.sessionStorage, environmentKey)
  );
  const [step, setStep] = useState<PoolCreationStep>("tokens");
  const [tokenXInput, setTokenXInput] = useState(draftAtMount.current?.tokenXInput ?? "");
  const [tokenYAddress, setTokenYAddress] = useState(draftAtMount.current?.tokenYAddress ?? "");
  const [tokenX, setTokenX] = useState<PoolCreationTokenChoice | null>(null);
  const [tokenY, setTokenY] = useState<PoolCreationTokenChoice | null>(null);
  const [binStepInput, setBinStepInput] = useState(draftAtMount.current?.binStepInput ?? "");
  const [priceInput, setPriceInput] = useState(draftAtMount.current?.priceInput ?? "");
  const [mode, setMode] = useState<PoolCreationMode>(draftAtMount.current?.mode ?? "create-only");
  const [riskAcknowledged, setRiskAcknowledged] = useState(draftAtMount.current?.riskAcknowledged ?? false);
  const [prepared, setPrepared] = useState<PoolCreationPreparedReview | null>(null);
  const [gasReview, setGasReview] = useState<ExactGasReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<PoolCreationRecoveryState | null>(null);
  const [submittedFingerprint, setSubmittedFingerprint] = useState<string | null>(null);
  const [canonicalRetryNonce, setCanonicalRetryNonce] = useState(0);
  const [progressNow, setProgressNow] = useState(() => Date.now());
  const handledCanonicalHash = useRef<Hex | null>(null);
  const canonicalReconciliationHash = useRef<Hex | null>(null);
  const handledRevertedHash = useRef<Hex | null>(null);
  const restoringReviewFingerprint = useRef<string | null>(null);
  const restoringDraft = useRef(false);
  const submitInFlight = useRef(false);
  const tokenXInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    tokenXInputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const modalOwnsEscape = event.composedPath().some((target) =>
        target instanceof Element &&
        (target.tagName.startsWith("W3M-") || target.getAttribute("role") === "alertdialog")
      );
      if (modalOwnsEscape || walletModalIsOpen() || document.querySelector("dialog[open]") !== null) return;
      event.preventDefault();
      onClose();
    };
    // Capture before AppKit handles Escape and flips its public `open` state.
    // The wallet chooser owns that keypress; a later bubbling listener would
    // otherwise see the modal as closed and dismiss this wizard too.
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);
  const operationGeneration = useRef(0);
  const deploymentContextIdentity = [
    environmentKey,
    deploymentEpoch(registry)
  ].join("|");
  const walletAuthorityIdentity = [
    account.address?.toLowerCase() ?? "disconnected",
    walletChainId,
    snapshot?.runtime.chainId ?? "rpc-unavailable"
  ].join("|");

  const discoveryQuery = useQuery({
    queryKey: ["poolCreationDiscovery", environmentKey, deploymentEpoch(registry)],
    queryFn: async () => {
      const [rpcChainId, block] = await Promise.all([
        publicClient.getChainId(),
        publicClient.getBlock({ blockTag: "latest" })
      ]);
      if (rpcChainId !== registry.chainId || block.hash === null) throw new Error("Pool-creation RPC chain or canonical head is unavailable");
      const discovery = await readPoolCreationFactoryDiscovery(publicClient, registry.contracts.lbFactory, block.number);
      const canonical = await publicClient.getBlock({ blockNumber: block.number });
      if (canonical.hash === null || canonical.hash.toLowerCase() !== block.hash.toLowerCase()) {
        throw new Error("Pool-creation discovery head reorganized during pinned reads");
      }
      return { blockHash: block.hash, blockNumber: block.number, discovery };
    },
    retry: false,
    staleTime: 0
  });
  const discovery = discoveryQuery.data?.discovery ?? null;
  const trustedPriceQuery = useQuery({
    queryKey: [
      "poolCreationTrustedPrice",
      environmentKey,
      deploymentEpoch(registry),
      tokenX?.address.toLowerCase() ?? null,
      tokenY?.address.toLowerCase() ?? null
    ],
    queryFn: () => loadTrustedPoolCreationPrice(
      analyticsEndpointForRegistry(registry),
      tokenX!.address,
      tokenY!.address
    ),
    enabled: tokenX !== null && tokenY !== null,
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 15_000
  });
  const trustedPriceResponse = trustedPriceQuery.data?.price ?? null;
  const trustedPriceLocallyFresh = trustedPriceResponse !== null && trustedPoolCreationPriceIsLocallyFresh(
    trustedPriceQuery.dataUpdatedAt,
    progressNow,
    TRUSTED_POOL_CREATION_PRICE_CLIENT_TTL_MS
  );
  const trustedPrice = trustedPriceLocallyFresh ? trustedPriceResponse : null;
  const trustedPriceExpired = trustedPriceResponse !== null && !trustedPriceLocallyFresh;
  const trustedPriceAgeSeconds = trustedPrice === null
    ? null
    : trustedPoolCreationPriceLocalAgeSeconds(trustedPrice, trustedPriceQuery.dataUpdatedAt, progressNow);
  const trustedSuggestedInput = trustedPrice === null
    ? null
    : formatUnits(BigInt(trustedPrice.quotePerBaseE18), 18);
  const trustedDeviation = trustedPrice === null
    ? null
    : trustedPriceDeviationBps(priceInput, trustedPrice.quotePerBaseE18);

  useEffect(() => {
    operationGeneration.current += 1;
    restoringReviewFingerprint.current = null;
    setPrepared(null);
    setGasReview(null);
    setRecovery(null);
    setSubmittedFingerprint(null);
    setError(null);
    setNotice(null);
    setStep("tokens");
  }, [deploymentContextIdentity]);

  useEffect(() => {
    operationGeneration.current += 1;
    if (submittedFingerprint === null) {
      setPrepared(null);
      setGasReview(null);
      setError(null);
      if (step === "review") setStep("configure");
    }
  }, [walletAuthorityIdentity]);

  useEffect(() => {
    const interval = window.setInterval(() => setProgressNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    persistPoolCreationDraft(window.sessionStorage, environmentKey, {
      tokenXInput,
      tokenYAddress,
      binStepInput,
      priceInput,
      mode,
      riskAcknowledged,
      configured: step !== "tokens" || draftAtMount.current?.configured === true
    });
  }, [binStepInput, environmentKey, mode, priceInput, riskAcknowledged, step, tokenXInput, tokenYAddress]);

  useEffect(() => () => {
    operationGeneration.current += 1;
    submitInFlight.current = false;
  }, []);

  useEffect(() => {
    if (!discovery) return;
    const defaults = selectPoolCreationTokenDefaults(Object.values(registry.tokens), discovery.quoteAssets);
    if (tokenYAddress === "" && defaults.tokenY) setTokenYAddress(defaults.tokenY);
    if (binStepInput === "" && discovery.openBinSteps[0] !== undefined) setBinStepInput(discovery.openBinSteps[0].toString());
    if (tokenXInput === "" && defaults.tokenX) setTokenXInput(defaults.tokenX);
  }, [binStepInput, discovery, registry.tokens, tokenXInput, tokenYAddress]);

  useEffect(() => {
    const draft = draftAtMount.current;
    if (
      !draft?.configured ||
      restoringDraft.current ||
      tokenX !== null ||
      tokenY !== null ||
      !discoveryQuery.data ||
      !isAddress(tokenXInput) ||
      !isAddress(tokenYAddress)
    ) return;
    restoringDraft.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const selectedY = tokenYAddress as Address;
        if (!discoveryQuery.data.discovery.quoteAssets.some((asset) => isAddressEqual(asset, selectedY))) {
          throw new Error("Saved quote asset is no longer enabled by the factory");
        }
        const [restoredTokenX, restoredTokenY] = await Promise.all([
          readPoolCreationToken(publicClient, registry, tokenXInput as Address, discoveryQuery.data.blockNumber),
          readPoolCreationToken(publicClient, registry, selectedY, discoveryQuery.data.blockNumber)
        ]);
        if (isAddressEqual(restoredTokenX.address, restoredTokenY.address)) throw new Error("Saved pool tokens must be distinct");
        if (cancelled) return;
        setTokenX(restoredTokenX);
        setTokenY(restoredTokenY);
        if (!restoredTokenX.listed || !restoredTokenY.listed) setMode("create-only");
        setStep("configure");
        draftAtMount.current = null;
      } catch (draftError) {
        if (!cancelled) {
          draftAtMount.current = null;
          setError(`Saved pool configuration needs review: ${getWriteError(draftError) ?? "token validation failed"}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [discoveryQuery.data, publicClient, registry, tokenX, tokenXInput, tokenY, tokenYAddress]);

  const pricePreview = useMemo(() => {
    if (!tokenX || !tokenY || !/^\d+$/.test(binStepInput)) return null;
    try {
      const binStep = BigInt(binStepInput);
      const requestedPriceQ128 = decimalPriceToQ128(priceInput, {
        baseDecimals: tokenX.decimals,
        quoteDecimals: tokenY.decimals
      });
      const activeId = activeIdFromPriceQ128(requestedPriceQ128, binStep);
      const representedPriceQ128 = priceQ128FromActiveId(activeId, binStep);
      const representedQuotePerBase = formatExactPriceFraction(normalizeQ128Price(representedPriceQ128, {
        baseDecimals: tokenX.decimals,
        quoteDecimals: tokenY.decimals
      }), 36);
      const inverseBasePerQuote = formatExactPriceFraction(normalizeQ128Price(representedPriceQ128, {
        baseDecimals: tokenX.decimals,
        quoteDecimals: tokenY.decimals,
        inverse: true
      }), 36);
      const delta = representedPriceQ128 > requestedPriceQ128
        ? representedPriceQ128 - requestedPriceQ128
        : requestedPriceQ128 - representedPriceQ128;
      return {
        activeId,
        requestedPriceQ128,
        representedPriceQ128,
        representedQuotePerBase,
        inverseBasePerQuote,
        deviationBps: delta * 10_000n / requestedPriceQ128
      };
    } catch (previewError) {
      return { error: getWriteError(previewError) ?? "Price is outside the representable LB range" };
    }
  }, [binStepInput, priceInput, tokenX, tokenY]);

  const resumableJournalRecord = useMemo(() => {
    const accountAddress = account.address?.toLowerCase() ?? null;
    return transactionJournal.records
      .filter((record) =>
        record.reviewed.intent === "create-pool" &&
        record.reviewed.environment === environmentKey &&
        record.reviewed.deploymentEpoch === deploymentEpoch(registry) &&
        record.reviewed.chainId === registry.chainId &&
        record.reviewed.target.toLowerCase() === registry.contracts.lbRouter.toLowerCase() &&
        (accountAddress === null || record.reviewed.account.toLowerCase() === accountAddress) &&
        ["awaiting-wallet", "unknown-submission", "reconciling", "submitted", "confirming", "canonical", "orphaned", "timed-out", "reverted"].includes(record.status)
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }, [account.address, environmentKey, registry, transactionJournal.records]);
  const journalRecord = submittedFingerprint === null
    ? resumableJournalRecord
    : transactionJournal.records.find((record) =>
      record.reviewed.intent === "create-pool" &&
      record.reviewed.executionFingerprint === submittedFingerprint
    ) ?? resumableJournalRecord;

  useEffect(() => {
    if (submittedFingerprint !== null || resumableJournalRecord === null) return;
    setSubmittedFingerprint(resumableJournalRecord.reviewed.executionFingerprint);
    setStep("create");
  }, [resumableJournalRecord?.id, submittedFingerprint]);

  useEffect(() => {
    if (
      journalRecord === null ||
      prepared !== null ||
      restoringReviewFingerprint.current === journalRecord.reviewed.executionFingerprint
    ) return;
    const restored = loadPoolCreationReview(window.localStorage, journalRecord.reviewed.executionFingerprint);
    if (
      restored === null ||
      restored.binding.environment !== environmentKey ||
      restored.binding.deploymentEpoch !== deploymentEpoch(registry) ||
      restored.binding.chainId !== registry.chainId ||
      restored.binding.account.toLowerCase() !== journalRecord.reviewed.account.toLowerCase() ||
      restored.binding.router.toLowerCase() !== registry.contracts.lbRouter.toLowerCase() ||
      restored.binding.factory.toLowerCase() !== registry.contracts.lbFactory.toLowerCase() ||
      keccak256(restored.binding.transaction.data).toLowerCase() !== journalRecord.reviewed.calldataFingerprint.toLowerCase()
    ) return;

    restoringReviewFingerprint.current = restored.fingerprint;
    let cancelled = false;
    void (async () => {
      try {
        const block = await publicClient.getBlock({ blockTag: "latest" });
        if (block.hash === null) throw new Error("Current canonical head is unavailable");
        const [restoredTokenX, restoredTokenY] = await Promise.all([
          readPoolCreationToken(publicClient, registry, restored.binding.tokenX, block.number),
          readPoolCreationToken(publicClient, registry, restored.binding.tokenY, block.number)
        ]);
        if (
          restoredTokenX.decimals !== restored.binding.tokenXDecimals ||
          restoredTokenY.decimals !== restored.binding.tokenYDecimals
        ) {
          throw new Error("Stored pool-creation token decimals no longer match live metadata");
        }
        const requestedPriceQ128 = decimalPriceToQ128(restored.binding.requestedQuotePerBase, {
          baseDecimals: restored.binding.tokenXDecimals,
          quoteDecimals: restored.binding.tokenYDecimals
        });
        const delta = restored.binding.representablePriceQ128 > requestedPriceQ128
          ? restored.binding.representablePriceQ128 - requestedPriceQ128
          : requestedPriceQ128 - restored.binding.representablePriceQ128;
        const inverseBasePerQuote = formatExactPriceFraction(normalizeQ128Price(
          restored.binding.representablePriceQ128,
          {
            baseDecimals: restored.binding.tokenXDecimals,
            quoteDecimals: restored.binding.tokenYDecimals,
            inverse: true
          }
        ), 36);
        const restoredPrepared: PoolCreationPreparedReview = {
          review: restored,
          preflight: {
            kind: "creatable",
            blockNumber: restored.binding.pinnedHead.number,
            selection: {
              tokenX: restored.binding.tokenX,
              tokenY: restored.binding.tokenY,
              binStep: restored.binding.binStep
            }
          },
          transaction: restored.binding.transaction,
          preset: restored.binding.preset,
          requestedPriceQ128,
          representedPriceQ128: restored.binding.representablePriceQ128,
          representedQuotePerBase: restored.binding.representableQuotePerBase,
          inverseBasePerQuote,
          deviationBps: delta * 10_000n / requestedPriceQ128,
          tokenX: restoredTokenX,
          tokenY: restoredTokenY
        };
        if (cancelled) return;
        setTokenX(restoredTokenX);
        setTokenY(restoredTokenY);
        setTokenXInput(restoredTokenX.address);
        setTokenYAddress(restoredTokenY.address);
        setBinStepInput(restored.binding.binStep.toString());
        setPriceInput(restored.binding.requestedQuotePerBase);
        setMode(restored.binding.mode);
        setRiskAcknowledged(true);
        setPrepared(restoredPrepared);
        setStep("create");
      } catch (restoreError) {
        if (!cancelled) setError(`Saved creation status could not restore its exact review: ${getWriteError(restoreError) ?? "invalid saved review"}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentKey, journalRecord?.id, journalRecord?.reviewed.executionFingerprint, prepared, publicClient, registry]);

  const reviewIsCurrent = (review: PoolCreationReview): boolean => poolCreationReviewIsCurrent(review, {
    ...review.binding,
    account: account.address ?? zeroAddress,
    walletChainId,
    rpcChainId: snapshot?.runtime.chainId ?? -1
  });

  const resolveTokenStage = async () => {
    if (!discoveryQuery.data) return;
    setBusy(true);
    setError(null);
    try {
      if (!isAddress(tokenXInput) || !isAddress(tokenYAddress)) throw new Error("Enter valid token addresses");
      const selectedY = tokenYAddress as Address;
      if (!discoveryQuery.data.discovery.quoteAssets.some((asset) => isAddressEqual(asset, selectedY))) {
        throw new Error("Semantic token Y must be a current factory quote asset");
      }
      const [resolvedX, resolvedY] = await Promise.all([
        readPoolCreationToken(publicClient, registry, tokenXInput as Address, discoveryQuery.data.blockNumber),
        readPoolCreationToken(publicClient, registry, selectedY, discoveryQuery.data.blockNumber)
      ]);
      if (isAddressEqual(resolvedX.address, resolvedY.address)) throw new Error("Semantic token X and token Y must be distinct");
      setTokenX(resolvedX);
      setTokenY(resolvedY);
      if (!resolvedX.listed || !resolvedY.listed) setMode("create-only");
      setStep("configure");
    } catch (tokenError) {
      setError(getWriteError(tokenError) ?? "Token validation failed");
    } finally {
      setBusy(false);
    }
  };

  const applyDuplicateRecovery = async (
    review: PoolCreationReview,
    pair: Address,
    selection: PoolCreationSelection,
    blockNumber: bigint,
    blockHash: Hex,
    source: "preexisting" | "race-winner",
    reviewedTokenX: PoolCreationTokenChoice,
    reviewedTokenY: PoolCreationTokenChoice
  ) => {
    const observation = await readDuplicatePoolIdentity(
      publicClient,
      registry.contracts.lbFactory,
      pair,
      selection,
      blockNumber,
      blockHash
    );
    if (isDeprecatedPool(registry, observation.pool.pair)) {
      onConfirmedPool(null);
      throw new Error(
        "The matching Sepolia pool is deprecated because it was initialized at an unsafe price. " +
        "It must remain unfunded; choose the approved replacement preset."
      );
    }
    const duplicate = recordDuplicatePool(review, observation.pool, source);
    setRecovery(duplicate);
    setPrepared(null);
    setGasReview(null);
    setStep("create");
    const indexed = indexedPools.find((pool) => isAddressEqual(pool.address, pair));
    const row = duplicatePoolOverlayRow(observation, reviewedTokenX, reviewedTokenY, registry);
    onConfirmedPool({ row, recovery: duplicate });
    setNotice(indexed
      ? `The exact pool already exists. Live reserves were refreshed as ${observation.reserveX.toString()} X / ${observation.reserveY.toString()} Y; no wallet request was sent.`
      : `The exact live pool won the race. RPC reserves are ${observation.reserveX.toString()} X / ${observation.reserveY.toString()} Y; active ID and price were refreshed and any position requires a new explicit review.`);
  };

  const buildCurrentReview = async (): Promise<PoolCreationPreparedReview | null> => {
    if (!tokenX || !tokenY || !pricePreview || "error" in pricePreview) throw new Error("Enter and verify the token pair, bin step, and initial price");
    if (!account.address) throw new Error("Connect a wallet before preparing the exact creation review");
    if (walletChainId !== registry.chainId) throw new Error(`Switch the wallet to ${registry.chain.name} (${registry.chainId}) before review`);
    if (snapshot?.runtime.chainId !== registry.chainId) throw new Error("The application RPC does not match this deployment; pool creation is unavailable");
    if (!riskAcknowledged) throw new Error("Acknowledge the initial-price arbitrage and loss risk before review");
    const capturedGeneration = operationGeneration.current;
    const [rpcChainId, block] = await Promise.all([publicClient.getChainId(), publicClient.getBlock({ blockTag: "latest" })]);
    if (capturedGeneration !== operationGeneration.current) throw new Error("Pool-creation context changed during pinned reads");
    if (rpcChainId !== registry.chainId || block.hash === null) throw new Error("Pool-creation canonical RPC head is unavailable");
    const freshDiscovery = await readPoolCreationFactoryDiscovery(publicClient, registry.contracts.lbFactory, block.number);
    if (capturedGeneration !== operationGeneration.current) throw new Error("Pool-creation context changed during factory discovery");
    const selection: PoolCreationSelection = {
      tokenX: tokenX.address,
      tokenY: tokenY.address,
      binStep: BigInt(binStepInput)
    };
    if (!freshDiscovery.openBinSteps.includes(selection.binStep)) throw new Error("The reviewed factory preset is no longer open");
    if (!freshDiscovery.quoteAssets.some((asset) => isAddressEqual(asset, selection.tokenY))) {
      throw new Error("Semantic token Y is no longer a factory quote asset");
    }
    const [freshTokenX, freshTokenY, preflight, rawPreset] = await Promise.all([
      readPoolCreationToken(publicClient, registry, selection.tokenX, block.number),
      readPoolCreationToken(publicClient, registry, selection.tokenY, block.number),
      preflightPoolCreation(publicClient, registry.contracts.lbFactory, selection, block.number),
      publicClient.readContract({
        address: registry.contracts.lbFactory,
        abi: lbFactoryAbi,
        functionName: "getPreset",
        args: [selection.binStep],
        blockNumber: block.number
      })
    ]);
    if (capturedGeneration !== operationGeneration.current) throw new Error("Pool-creation context changed during preflight");
    if (freshTokenX.decimals !== tokenX.decimals || freshTokenY.decimals !== tokenY.decimals) {
      throw new Error("Token decimal metadata changed during pool-creation review");
    }
    const canonical = await publicClient.getBlock({ blockNumber: block.number });
    if (canonical.hash === null || canonical.hash.toLowerCase() !== block.hash.toLowerCase()) {
      throw new Error("Pool-creation review head reorganized during pinned reads");
    }
    if (preflight.kind === "existing") {
      const duplicateReview = prepared?.review ?? createDuplicateReviewFallback({
        account: account.address,
        activeId: pricePreview.activeId,
        blockHash: block.hash,
        blockNumber: block.number,
        environmentKey,
        mode,
        priceInput,
        pricePreview,
        preset: normalizePoolCreationPreset(rawPreset),
        registry,
        riskAcknowledged,
        selection,
        tokenX: freshTokenX,
        tokenY: freshTokenY
      });
      await applyDuplicateRecovery(
        duplicateReview,
        preflight.pair,
        selection,
        block.number,
        block.hash,
        prepared ? "race-winner" : "preexisting",
        freshTokenX,
        freshTokenY
      );
      return null;
    }
    const preset = normalizePoolCreationPreset(rawPreset);
    const transaction = buildCreateLBPairTransaction(registry.contracts.lbRouter, preflight, pricePreview.activeId);
    const review = createPoolCreationReview({
      environment: environmentKey,
      deploymentEpoch: deploymentEpoch(registry),
      chainId: registry.chainId,
      walletChainId,
      rpcChainId,
      account: account.address,
      factory: registry.contracts.lbFactory,
      router: registry.contracts.lbRouter,
      tokenX: selection.tokenX,
      tokenY: selection.tokenY,
      tokenXDecimals: freshTokenX.decimals,
      tokenYDecimals: freshTokenY.decimals,
      binStep: selection.binStep,
      activeId: pricePreview.activeId,
      requestedQuotePerBase: priceInput,
      representableQuotePerBase: pricePreview.representedQuotePerBase,
      representablePriceQ128: pricePreview.representedPriceQ128,
      preset,
      pinnedHead: { number: block.number, hash: block.hash },
      mode,
      transaction,
      roundingRiskAcknowledged: true
    });
    return {
      review,
      preflight,
      transaction,
      preset,
      requestedPriceQ128: pricePreview.requestedPriceQ128,
      representedPriceQ128: pricePreview.representedPriceQ128,
      representedQuotePerBase: pricePreview.representedQuotePerBase,
      inverseBasePerQuote: pricePreview.inverseBasePerQuote,
      deviationBps: pricePreview.deviationBps,
      tokenX: freshTokenX,
      tokenY: freshTokenY
    };
  };

  const recheckPreparedAuthority = async (reviewed: PoolCreationPreparedReview) => {
    const reviewedHead = await publicClient.getBlock({ blockNumber: reviewed.review.binding.pinnedHead.number });
    if (
      reviewedHead.hash === null ||
      reviewedHead.hash.toLowerCase() !== reviewed.review.binding.pinnedHead.hash.toLowerCase()
    ) {
      throw new Error("The pinned pool-creation review head is no longer canonical");
    }
    const [rpcChainId, latest] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock({ blockTag: "latest" })
    ]);
    if (rpcChainId !== registry.chainId || latest.hash === null) throw new Error("Current pool-creation RPC authority is unavailable");
    const selection = reviewed.preflight.selection;
    const freshDiscovery = await readPoolCreationFactoryDiscovery(publicClient, registry.contracts.lbFactory, latest.number);
    if (!freshDiscovery.openBinSteps.includes(selection.binStep)) throw new Error("The reviewed factory preset is no longer open");
    if (!freshDiscovery.quoteAssets.some((asset) => isAddressEqual(asset, selection.tokenY))) {
      throw new Error("Semantic token Y is no longer a factory quote asset");
    }
    const [freshTokenX, freshTokenY, preflight, rawPreset] = await Promise.all([
      readPoolCreationToken(publicClient, registry, selection.tokenX, latest.number),
      readPoolCreationToken(publicClient, registry, selection.tokenY, latest.number),
      preflightPoolCreation(publicClient, registry.contracts.lbFactory, selection, latest.number),
      publicClient.readContract({
        address: registry.contracts.lbFactory,
        abi: lbFactoryAbi,
        functionName: "getPreset",
        args: [selection.binStep],
        blockNumber: latest.number
      })
    ]);
    const freshPreset = normalizePoolCreationPreset(rawPreset);
    if (
      freshTokenX.decimals !== reviewed.tokenX.decimals ||
      freshTokenY.decimals !== reviewed.tokenY.decimals ||
      freshTokenX.symbol !== reviewed.tokenX.symbol ||
      freshTokenY.symbol !== reviewed.tokenY.symbol ||
      !samePoolCreationPreset(freshPreset, reviewed.preset)
    ) {
      throw new Error("Pool-creation token metadata or fee preset changed after review");
    }
    const canonical = await publicClient.getBlock({ blockNumber: latest.number });
    if (canonical.hash === null || canonical.hash.toLowerCase() !== latest.hash.toLowerCase()) {
      throw new Error("Latest pool-creation authority head reorganized during recheck");
    }
    return { blockHash: latest.hash, blockNumber: latest.number, freshTokenX, freshTokenY, preflight };
  };

  const handlePrepareReview = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const displayedTrustedPrice = trustedPrice;
      const refreshedTrustedPrice = (await trustedPriceQuery.refetch({ cancelRefetch: true })).data?.price ?? null;
      if (displayedTrustedPrice === null && refreshedTrustedPrice !== null) {
        setNotice("A current trusted oracle suggestion is now available. Feather did not alter your input; inspect the suggestion and deviation, then review again.");
        return;
      }
      if (displayedTrustedPrice !== null && refreshedTrustedPrice === null) {
        setNotice("The trusted oracle suggestion became unavailable before review. Feather kept your value as explicit input; verify it independently, then review again.");
        return;
      }
      if (
        displayedTrustedPrice !== null &&
        refreshedTrustedPrice !== null &&
        displayedTrustedPrice.quotePerBaseE18 !== refreshedTrustedPrice.quotePerBaseE18
      ) {
        setNotice("The trusted oracle suggestion changed before review. Feather did not alter your input; inspect the updated deviation, then review again.");
        return;
      }
      const next = await buildCurrentReview();
      if (next) {
        setPrepared(next);
        setGasReview(null);
        setRecovery(null);
        setStep("review");
      }
    } catch (reviewError) {
      setError(getWriteError(reviewError) ?? "Pool-creation review failed");
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    if (!prepared || !account.address || submitInFlight.current) return;
    submitInFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const capturedGeneration = operationGeneration.current;
      const authority = await recheckPreparedAuthority(prepared);
      if (authority.preflight.kind === "existing") {
        await applyDuplicateRecovery(
          prepared.review,
          authority.preflight.pair,
          prepared.preflight.selection,
          authority.blockNumber,
          authority.blockHash,
          "race-winner",
          authority.freshTokenX,
          authority.freshTokenY
        );
        return;
      }
      if (!reviewIsCurrent(prepared.review)) throw new Error("Pool-creation review is stale for the current account, chain, or deployment");
      const gasCurrent = () => reviewIsCurrent(prepared.review) && operationGeneration.current === capturedGeneration;
      const gasApproved = await reviewExactGas({
        action: "Create LB pool",
        currentReview: gasReview,
        estimateGas: () => publicClient.estimateGas({
          account: account.address,
          to: prepared.transaction.to,
          data: prepared.transaction.data,
          value: prepared.transaction.value
        }),
        executionFingerprint: prepared.review.fingerprint,
        getBalance: () => publicClient.getBalance({ address: account.address! }),
        getGasPrice: () => publicClient.getGasPrice(),
        isCurrent: gasCurrent,
        setError,
        setReview: setGasReview
      });
      if (!gasApproved) {
        setNotice("Exact gas and balance are pinned below. Submit again to re-preflight, simulate, and open the wallet.");
        return;
      }
      const simulationAuthority = await recheckPreparedAuthority(prepared);
      if (simulationAuthority.preflight.kind === "existing") {
        await applyDuplicateRecovery(
          prepared.review,
          simulationAuthority.preflight.pair,
          prepared.preflight.selection,
          simulationAuthority.blockNumber,
          simulationAuthority.blockHash,
          "race-winner",
          simulationAuthority.freshTokenX,
          simulationAuthority.freshTokenY
        );
        return;
      }
      await publicClient.simulateContract({
        account: account.address,
        address: prepared.transaction.to,
        abi: lbRouterAbi,
        functionName: "createLBPair",
        args: [
          prepared.review.binding.tokenX,
          prepared.review.binding.tokenY,
          Number(prepared.review.binding.activeId),
          Number(prepared.review.binding.binStep)
        ]
      });
      if (!gasCurrent()) throw new Error("Pool-creation context changed during exact simulation");
      const reviewed = reviewedTransactionIntent({
        account: account.address,
        calldataFingerprint: keccak256(prepared.transaction.data),
        chainId: registry.chainId,
        deploymentEpoch: deploymentEpoch(registry),
        environment: environmentKey,
        executionFingerprint: prepared.review.fingerprint,
        intent: "create-pool",
        target: prepared.transaction.to,
        value: 0n
      }, {
        poolId: null,
        recipient: null,
        refundRecipient: null,
        settingsFingerprint: [
          environmentKey,
          deploymentEpoch(registry),
          registry.contracts.lbFactory.toLowerCase(),
          ...[
            prepared.review.binding.tokenX.toLowerCase(),
            prepared.review.binding.tokenY.toLowerCase()
          ].sort(),
          prepared.review.binding.binStep.toString()
        ].join("|")
      });
      persistPoolCreationReview(window.localStorage, prepared.review);
      setSubmittedFingerprint(prepared.review.fingerprint);
      setStep("create");
      const hash = await submitJournaledTransaction({
        isCurrent: gasCurrent,
        journal: transactionJournal,
        reviewed,
        preWalletGuard: async () => {
          const finalAuthority = await recheckPreparedAuthority(prepared);
          if (finalAuthority.preflight.kind === "existing") {
            await applyDuplicateRecovery(
              prepared.review,
              finalAuthority.preflight.pair,
              prepared.preflight.selection,
              finalAuthority.blockNumber,
              finalAuthority.blockHash,
              "race-winner",
              finalAuthority.freshTokenX,
              finalAuthority.freshTokenY
            );
            throw new Error("Exact pool was created by another actor before wallet submission");
          }
          if (!gasCurrent()) throw new Error("Exact pool identity changed before wallet submission");
        },
        send: () => createWrite.sendTransactionAsync(prepared.transaction)
      });
      if (hash) setNotice(`Transaction ${formatCompactAddress(hash)} was submitted. Feather is tracking confirmation, pool identity, and discovery without sending another transaction.`);
    } catch (submitError) {
      if (isUserRejectedSubmission(submitError)) {
        setRecovery(recordCreateWalletRejection(prepared.review));
        setNotice("Wallet rejected pool creation. No pool was created and retry requires a fresh review.");
      } else {
        setError(getWriteError(submitError) ?? "Pool-creation submission failed or remains ambiguous");
      }
    } finally {
      setBusy(false);
      submitInFlight.current = false;
    }
  };

  useEffect(() => {
    if (!journalRecord || !prepared) return;
    if (journalRecord.status === "rejected") {
      setRecovery(recordCreateWalletRejection(prepared.review));
      return;
    }
    if (["unknown-submission", "reconciling", "timed-out", "awaiting-wallet"].includes(journalRecord.status)) {
      setRecovery(recordAmbiguousCreateSubmission(prepared.review, journalRecord.activeHash));
      return;
    }
    if (journalRecord.status === "reverted" && journalRecord.canonicalReceipt) {
      const revertedReceipt = journalRecord.canonicalReceipt;
      if (handledRevertedHash.current === revertedReceipt.hash) return;
      handledRevertedHash.current = revertedReceipt.hash;
      void (async () => {
        try {
          const authority = await recheckPreparedAuthority(prepared);
          if (authority.preflight.kind === "existing") {
            await applyDuplicateRecovery(
              prepared.review,
              authority.preflight.pair,
              prepared.preflight.selection,
              authority.blockNumber,
              authority.blockHash,
              "race-winner",
              authority.freshTokenX,
              authority.freshTokenY
            );
            return;
          }
          setRecovery(recordCreateMinedRevert(prepared.review, revertedReceipt.hash, {
            number: BigInt(revertedReceipt.blockNumber),
            hash: revertedReceipt.blockHash
          }));
        } catch (revertRecoveryError) {
          setRecovery(recordCreateMinedRevert(prepared.review, revertedReceipt.hash, {
            number: BigInt(revertedReceipt.blockNumber),
            hash: revertedReceipt.blockHash
          }));
          setError(`Creation reverted; exact race-winner recovery is unavailable: ${getWriteError(revertRecoveryError) ?? "live factory lookup failed"}`);
        }
      })();
      return;
    }
    if (journalRecord.status === "orphaned" && recovery && ["canonical-confirmation", "indexing-lag", "created-empty"].includes(recovery.kind)) {
      const poolState = recovery as Extract<PoolCreationRecoveryState, { kind: "canonical-confirmation" | "indexing-lag" | "created-empty" }>;
      void publicClient.getBlock({ blockTag: "latest" }).then((head) => {
        if (head.hash === null) return;
        setRecovery(recordPoolCreationReorg(poolState, { number: head.number, hash: head.hash }));
        onConfirmedPool(null);
      }).catch(() => setError("Creation receipt was orphaned; waiting for the current canonical head before recovery"));
      return;
    }
    if (
      journalRecord.status !== "canonical" ||
      !journalRecord.activeHash ||
      handledCanonicalHash.current === journalRecord.activeHash ||
      canonicalReconciliationHash.current === journalRecord.activeHash
    ) return;
    canonicalReconciliationHash.current = journalRecord.activeHash;
    const reconciliationHash = journalRecord.activeHash;
    let cancelled = false;
    void (async () => {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: journalRecord.activeHash! });
        const canonicalBlock = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
        if (canonicalBlock.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("Pool-creation receipt block was reorganized");
        const created = parseLBPairCreatedReceipt({
          blockNumber: receipt.blockNumber,
          status: receipt.status,
          logs: receipt.logs.map((log) => ({ address: log.address, data: log.data, topics: log.topics as readonly Hex[] }))
        }, registry.contracts.lbFactory, prepared.preflight.selection);
        const reconciled = await reconcileCreatedPool(publicClient, {
          created,
          expectedActiveId: prepared.review.binding.activeId,
          expectedPriceQ128: prepared.review.binding.representablePriceQ128
        });
        const livePool: LiveCreatedPool = {
          pair: reconciled.pair,
          factory: reconciled.factory,
          tokenX: reconciled.selection.tokenX,
          tokenY: reconciled.selection.tokenY,
          binStep: reconciled.selection.binStep,
          activeId: reconciled.activeId,
          priceQ128: reconciled.priceQ128,
          observedHead: { number: reconciled.blockNumber, hash: receipt.blockHash }
        };
        const confirmation = recordCanonicalPoolConfirmation(prepared.review, receipt.transactionHash, livePool);
        const [activeBin, activeSupply, pairReserves] = await Promise.all([
          publicClient.readContract({ address: reconciled.pair, abi: lbPairAbi, functionName: "getBin", args: [Number(reconciled.activeId)], blockNumber: reconciled.blockNumber }),
          publicClient.readContract({ address: reconciled.pair, abi: lbPairAbi, functionName: "totalSupply", args: [reconciled.activeId], blockNumber: reconciled.blockNumber }),
          publicClient.readContract({ address: reconciled.pair, abi: LB_PAIR_RESERVES_ABI, functionName: "getReserves", blockNumber: reconciled.blockNumber })
        ]);
        if (activeBin[0] !== 0n || activeBin[1] !== 0n || activeSupply !== 0n || pairReserves[0] !== 0n || pairReserves[1] !== 0n) {
          throw new Error("Created pool was not empty at its canonical creation receipt block");
        }
        const postReadCanonicalBlock = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
        if (postReadCanonicalBlock.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
          throw new Error("Pool-creation receipt block reorganized during live reconciliation");
        }
        if (isDeprecatedPool(registry, reconciled.pair)) {
          onConfirmedPool(null);
          throw new Error("The reconciled pool is a deprecated Sepolia release and cannot be promoted or funded.");
        }
        const empty = recordCreatedPoolEmpty(confirmation, livePool, true);
        const indexed = indexedPools.some((pool) => isAddressEqual(pool.address, reconciled.pair));
        const indexerHead = snapshot?.indexer.blockNumber === null || snapshot?.indexer.blockNumber === undefined
          ? null
          : BigInt(snapshot.indexer.blockNumber);
        const runtimeBlock = await publicClient.getBlock({ blockTag: "latest" });
        if (runtimeBlock.hash === null) throw new Error("Runtime canonical head is unavailable after pool creation");
        const currentHead = runtimeBlock.number;
        const currentHash = runtimeBlock.hash;
        const indexerBehind = indexerHead === null || indexerHead < reconciled.blockNumber;
        const resolvedRecovery = !indexed && indexerBehind
          ? recordPoolIndexingLag(confirmation, { number: currentHead, hash: currentHash }, indexerHead)
          : empty;
        if (cancelled) return;
        handledCanonicalHash.current = reconciliationHash;
        canonicalReconciliationHash.current = null;
        setRecovery(resolvedRecovery);
        const row = poolOverlayRow(reconciled.pair, prepared, reconciled.blockNumber, registry);
        onConfirmedPool({ row, recovery: resolvedRecovery });
        if (!indexed && !indexerBehind) {
          setError("Indexer inconsistency: it processed through the creation block but omitted the confirmed pair. RPC identity remains visible; indexed actions stay blocked.");
          setNotice("Pool creation is canonical by RPC, but the indexer is inconsistent rather than merely behind.");
        } else {
          setNotice(indexed ? "Pool creation is canonical and indexed." : "Pool creation is canonical by RPC. The empty-pool workspace is available while indexing catches up; swaps remain disabled.");
        }
        void Promise.all([onRefresh(), onCatalogRefresh()]).catch((refreshError) => {
          if (!cancelled) {
            setNotice(`Pool creation remains canonically reconciled. Indexed-data refresh failed and can be retried from the pool list: ${getWriteError(refreshError) ?? "unknown refresh error"}`);
          }
        });
      } catch (receiptError) {
        if (!cancelled) {
          canonicalReconciliationHash.current = null;
          setError(getWriteError(receiptError) ?? "Canonical pool receipt reconciliation failed");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (canonicalReconciliationHash.current === reconciliationHash && handledCanonicalHash.current !== reconciliationHash) {
        canonicalReconciliationHash.current = null;
      }
    };
  }, [
    canonicalRetryNonce,
    journalRecord?.activeHash,
    journalRecord?.canonicalReceipt?.hash,
    journalRecord?.id,
    journalRecord?.status,
    onCatalogRefresh,
    onRefresh,
    prepared?.review.fingerprint
  ]);

  const configured = tokenX !== null && tokenY !== null && pricePreview !== null && !("error" in pricePreview) && riskAcknowledged;
  const walletConnected = account.address !== undefined;
  const walletOnCreationChain = walletConnected && walletChainId === registry.chainId;
  const rpcOnCreationChain = snapshot?.runtime.chainId === registry.chainId;
  const reviewActionLabel = !walletConnected
    ? "Connect wallet to review"
    : !walletOnCreationChain
      ? `Switch to ${registry.chain.name}`
      : !rpcOnCreationChain
        ? "Creation RPC unavailable"
        : trustedPriceQuery.isFetching
          ? "Refreshing trusted price…"
        : busy
          ? "Pinning review…"
          : "Review exact creation";
  const handleReviewAction = () => {
    setError(null);
    if (!walletConnected) {
      if (!walletModalConfigured) {
        setError("Use Connect wallet in the application header before reviewing pool creation.");
        return;
      }
      void openWalletModal().catch(() => setError("The wallet chooser could not open. Reload the page and try again."));
      return;
    }
    if (!walletOnCreationChain) {
      resetPoolCreationSwitch();
      switchPoolCreationChain({ chainId: registry.chainId });
      return;
    }
    if (!rpcOnCreationChain) {
      setError("The application RPC does not match this deployment. Pool creation is disabled until the deployment configuration is corrected.");
      return;
    }
    void handlePrepareReview();
  };
  const existingPool = recovery?.kind === "duplicate" ? recovery.pool : null;
  const confirmedPool = recovery && ["canonical-confirmation", "indexing-lag", "created-empty"].includes(recovery.kind)
    ? (recovery as Extract<PoolCreationRecoveryState, { kind: "canonical-confirmation" | "indexing-lag" | "created-empty" }>).pool
    : null;
  const canonicalRecoveryResolved = confirmedPool !== null;
  const existingLiveTokenX = existingPool && tokenX && tokenY
    ? (isAddressEqual(existingPool.tokenX, tokenX.address) ? tokenX : tokenY)
    : tokenX;
  const existingLiveTokenY = existingPool && tokenX && tokenY
    ? (isAddressEqual(existingPool.tokenY, tokenY.address) ? tokenY : tokenX)
    : tokenY;
  const resultPool = confirmedPool ?? existingPool;
  const resultPoolDiscovered = resultPool !== null && indexedPools.some((pool) => isAddressEqual(pool.address, resultPool.pair));
  const baseCreationProgress = poolCreationProgress(journalRecord, recovery, resultPoolDiscovered);
  const progressHash = journalRecord?.activeHash ??
    (recovery?.kind === "ambiguous-submission" ? recovery.transactionHash : null) ??
    (recovery?.kind === "mined-revert" || recovery?.kind === "canonical-confirmation" ? recovery.transactionHash : null);
  const explorerTransactionUrl = progressHash && registry.chain.blockExplorers?.default.url
    ? `${registry.chain.blockExplorers.default.url.replace(/\/+$/, "")}/tx/${progressHash}`
    : null;
  const progressStartedAt = journalRecord?.submittedAt ?? journalRecord?.createdAt ?? null;
  const discoveryWaitMs = progressStartedAt === null ? 0 : Math.max(0, progressNow - progressStartedAt);
  const pendingDiscoveryProgress = resultPool !== null && !resultPoolDiscovered
    ? {
        ...baseCreationProgress,
        verifiedStep: baseCreationProgress.verifiedStep === 6 ? 5 as const : baseCreationProgress.verifiedStep,
        terminal: false,
        canCheckStatus: true
      }
    : baseCreationProgress;
  const creationProgress = resultPool !== null && !resultPoolDiscovered &&
    (analyticsState === "error" || analyticsState === "unavailable")
    ? {
        ...pendingDiscoveryProgress,
        title: `${baseCreationProgress.title} · analytics temporarily unavailable`,
        detail: `${baseCreationProgress.detail} Feather cannot verify durable discovery right now and will not resubmit creation; retry the status check when analytics recovers.`,
        tone: "warning" as const,
      }
    : resultPool !== null && !resultPoolDiscovered && discoveryWaitMs >= 120_000
      ? {
          ...pendingDiscoveryProgress,
          title: `${baseCreationProgress.title} · discovery is taking longer than usual`,
          detail: `${baseCreationProgress.detail} The pool is still absent from the durable catalog. Check status safely; Feather will never resubmit creation automatically.`,
          tone: "warning" as const,
        }
      : pendingDiscoveryProgress;
  const handleProgressCheck = async () => {
    setError(null);
    setNotice("Checking the existing transaction and discovery state. No new transaction will be submitted.");
    try {
      if (journalRecord) await transactionJournal.recheck(journalRecord.id);
      setCanonicalRetryNonce((value) => value + 1);
      await Promise.all([onRefresh(), onCatalogRefresh()]);
      setNotice("Status refreshed from the current chain and application data.");
    } catch (statusError) {
      setError(getWriteError(statusError) ?? "Status check failed. The existing transaction remains unchanged.");
    }
  };
  const startFreshCreationReview = () => {
    setPrepared(null);
    setGasReview(null);
    setRecovery(null);
    setError(null);
    setNotice(null);
    setRiskAcknowledged(false);
    setStep(tokenX && tokenY ? "configure" : "tokens");
  };

  return (
    <section className="pool-creation-panel" data-testid="pool-creation-wizard" aria-label="Create permissionless LB pool">
      <div className="panel-heading">
        <span>Create permissionless pool</span>
        <button className="icon-button" aria-label="Close pool creation" onClick={onClose} type="button">×</button>
      </div>
      <div className="pool-creation-steps" aria-label="Pool creation progress">
        {(["tokens", "configure", "review", "create"] as const).map((candidate, index) => (
          <span className={step === candidate ? "active" : ""} key={candidate}>{index + 1}. {candidate === "create" ? "Create / indexing" : candidate}</span>
        ))}
      </div>
      {step === "tokens" ? (
        <div className="pool-creation-grid">
          <label><span className="field-label">Token X · semantic base</span><input data-testid="pool-create-token-x" ref={tokenXInputRef} value={tokenXInput} onChange={(event) => setTokenXInput(event.target.value)} placeholder="ERC-20 address" /></label>
          <label><span className="field-label">Token Y · factory quote asset</span><select data-testid="pool-create-token-y" value={tokenYAddress} onChange={(event) => setTokenYAddress(event.target.value)}>
            <option value="">Select quote asset</option>
            {(discovery?.quoteAssets ?? []).map((address) => {
              const metadata = registry.tokens[address.toLowerCase()];
              return <option key={address} value={address}>{metadata ? `${metadata.symbol} · ` : ""}{address}</option>;
            })}
          </select></label>
          <p className="pool-creation-copy">X is preserved as base and Y as quote even when their addresses sort in the opposite order. X may be any code-bearing ERC-20 with bounded decimals; Y must be live-whitelisted by this factory.</p>
          <button className="primary-button" disabled={busy || discoveryQuery.isLoading || discoveryQuery.isError} onClick={() => void resolveTokenStage()} type="button">{busy ? "Validating…" : "Continue to configure"}</button>
        </div>
      ) : null}
      {step === "configure" && tokenX && tokenY ? (
        <div className="pool-creation-grid">
          <div className="pool-creation-token-summary"><strong>{tokenX.symbol} / {tokenY.symbol}</strong><span>{tokenX.address}</span><span>{tokenY.address}</span></div>
          <label><span className="field-label">Open bin-step preset</span><select data-testid="pool-create-bin-step" value={binStepInput} onChange={(event) => { setBinStepInput(event.target.value); setPrepared(null); }}>
            {(discovery?.openBinSteps ?? []).map((value) => <option key={value.toString()} value={value.toString()}>{value.toString()} bps step</option>)}
          </select></label>
          <label>
            <span className="field-label">Initial price · {tokenY.symbol} per {tokenX.symbol}</span>
            <input
              aria-describedby="pool-create-price-guidance"
              data-testid="pool-create-price"
              inputMode="decimal"
              placeholder={`Enter ${tokenY.symbol} per ${tokenX.symbol}`}
              value={priceInput}
              onChange={(event) => {
                setPriceInput(event.target.value);
                setPrepared(null);
                setGasReview(null);
              }}
            />
          </label>
          <div className={`pool-creation-price-source ${trustedPrice ? "ready" : "unavailable"}`} id="pool-create-price-guidance" data-testid="pool-create-trusted-price">
            {trustedPrice && trustedSuggestedInput ? (
              <>
                <div>
                  <strong>Trusted oracle suggestion</strong>
                  <span>{trustedSuggestedInput} {tokenY.symbol} per {tokenX.symbol}</span>
                </div>
                <p>
                  {poolCreationPriceSourceLabel(trustedPrice.baseSource, trustedPrice.quoteSource)}
                  {" · "}
                  samples {formatPoolCreationPriceAge(trustedPriceAgeSeconds ?? Math.max(trustedPrice.baseAgeSeconds, trustedPrice.quoteAgeSeconds))} old
                  {" · "}
                  analytics block {trustedPrice.asOfBlock}
                </p>
                <button
                  className="secondary-button"
                  data-testid="pool-create-use-trusted-price"
                  onClick={() => {
                    setPriceInput(trustedSuggestedInput);
                    setPrepared(null);
                    setGasReview(null);
                  }}
                  type="button"
                >
                  Use trusted price
                </button>
              </>
            ) : trustedPriceQuery.isLoading || trustedPriceQuery.isFetching ? (
              <p><LoaderCircle className="spin" size={14} /> {trustedPriceExpired ? "Refreshing an expired trusted oracle suggestion…" : "Checking trusted oracle pricing…"}</p>
            ) : trustedPriceExpired ? (
              <p>The prior trusted oracle suggestion expired locally. Feather will refresh it before review; enter a price explicitly if it remains unavailable.</p>
            ) : (
              <p>{trustedPriceQuery.data?.detail ?? "No current trusted oracle suggestion is available. Enter a price explicitly and verify it independently."}</p>
            )}
          </div>
          {trustedDeviation !== null ? (
            <p className={trustedDeviation >= 100n ? "inline-error" : "pool-creation-copy"} data-testid="pool-create-trusted-deviation">
              Entered price differs from the trusted oracle suggestion by {formatBps(trustedDeviation)}.
              {trustedDeviation >= 100n ? " Recheck the price orientation before review." : ""}
            </p>
          ) : null}
          {pricePreview && !("error" in pricePreview) ? (
            <dl className="pool-creation-preview" data-testid="pool-create-price-preview">
              <div><dt>Derived active ID</dt><dd>{pricePreview.activeId.toString()}</dd></div>
              <div><dt>Representable quote/base</dt><dd>{pricePreview.representedQuotePerBase}</dd></div>
              <div><dt>Inverse base/quote</dt><dd>{pricePreview.inverseBasePerQuote}</dd></div>
              <div><dt>Deviation</dt><dd>{formatBps(pricePreview.deviationBps)}</dd></div>
            </dl>
          ) : pricePreview && "error" in pricePreview ? <p className="inline-error">{pricePreview.error}</p> : null}
          <label className="check-row"><input checked={mode === "create-and-add"} disabled={!tokenX.listed || !tokenY.listed} onChange={(event) => setMode(event.target.checked ? "create-and-add" : "create-only")} type="checkbox" /><span>{tokenX.listed && tokenY.listed ? "After canonical creation, offer a separate fresh Create Position review" : "Create Position handoff requires both tokens in the supported Feather token registry; permissionless pool creation remains available in create-only mode"}</span></label>
          <label className="check-row risk-ack"><input data-testid="pool-create-risk-ack" checked={riskAcknowledged} onChange={(event) => setRiskAcknowledged(event.target.checked)} type="checkbox" /><span>I understand an incorrect initial price can cause immediate arbitrage and permanent loss. The representable rounded price—not my typed decimal—will initialize the pool.</span></label>
          {!walletConnected ? (
            <p className="pool-creation-prerequisite" role="status"><Wallet size={16} /> Connect a wallet to bind the exact review. Your pair and price will stay here while you connect.</p>
          ) : !walletOnCreationChain ? (
            <p className="pool-creation-prerequisite warning" role="status"><Network size={16} /> Wallet is on chain {walletChainId}. Switch to {registry.chain.name} ({registry.chainId}) before review.</p>
          ) : null}
          {poolCreationSwitchError ? <p className="inline-error" role="alert">{walletFailure(poolCreationSwitchError, "switch").action}</p> : null}
          <div className="wizard-actions">
            <button className="secondary-button" onClick={() => setStep("tokens")} type="button">Back</button>
            <button
              className={!walletConnected || !walletOnCreationChain ? "warn-button" : "primary-button"}
              data-testid="pool-create-review-action"
              disabled={!configured || busy || trustedPriceQuery.isFetching || poolCreationSwitchPending || (!rpcOnCreationChain && walletOnCreationChain)}
              onClick={handleReviewAction}
              type="button"
            >
              {poolCreationSwitchPending ? "Switching…" : reviewActionLabel}
            </button>
          </div>
        </div>
      ) : null}
      {step === "review" && prepared ? (
        <div className="pool-creation-review" data-testid="pool-create-review">
          <div className="state-row warning"><AlertTriangle size={16} /><span>Initial price is irreversible at creation and can invite immediate arbitrage. Transaction value is exactly zero; gas is not guaranteed until mined.</span></div>
          <dl className="review-grid">
            <div><dt>Semantic pair</dt><dd>{prepared.tokenX.symbol} (X/base) → {prepared.tokenY.symbol} (Y/quote)</dd></div>
            <div><dt>Factory</dt><dd>{registry.contracts.lbFactory}</dd></div>
            <div><dt>Router</dt><dd>{prepared.transaction.to}</dd></div>
            <div><dt>Pinned head</dt><dd>{prepared.review.binding.pinnedHead.number.toString()} · {formatCompactAddress(prepared.review.binding.pinnedHead.hash)}</dd></div>
            <div><dt>Preset / active ID</dt><dd>{prepared.review.binding.binStep.toString()} / {prepared.review.binding.activeId.toString()}</dd></div>
            <div><dt>Requested → representable</dt><dd>{prepared.review.binding.requestedQuotePerBase} → {prepared.representedQuotePerBase}</dd></div>
            <div><dt>Inverse / deviation</dt><dd>{prepared.inverseBasePerQuote} / {formatBps(prepared.deviationBps)}</dd></div>
            <div><dt>Fees</dt><dd>base {prepared.preset.baseFactor.toString()} · variable {prepared.preset.variableFeeControl.toString()} · protocol {prepared.preset.protocolShare.toString()}</dd></div>
            <div><dt>Preset timing</dt><dd>filter {prepared.preset.filterPeriod.toString()} · decay {prepared.preset.decayPeriod.toString()} · reduction {prepared.preset.reductionFactor.toString()} · max volatility {prepared.preset.maxVolatilityAccumulator.toString()}</dd></div>
            <div><dt>Mode</dt><dd>{prepared.review.binding.mode === "create-and-add" ? "Create, then separately review position" : "Create empty pool only"}</dd></div>
          </dl>
          <GasReview review={gasReview} />
          <div className="wizard-actions"><button className="secondary-button" onClick={() => { setStep("configure"); setPrepared(null); setGasReview(null); }} type="button">Back</button><button className="primary-button" data-testid="pool-create-submit" disabled={busy || !reviewIsCurrent(prepared.review)} onClick={() => void handleCreate()} type="button">{busy ? "Checking…" : gasReview ? "Create pool" : "Review gas"}</button></div>
        </div>
      ) : null}
      {step === "create" ? (
        <div className={`pool-creation-result ${creationProgress.tone}`} data-testid="pool-create-result" aria-live="polite">
          <div className="pool-creation-result-heading">
            <div>
              <span className="eyebrow">Latest verified stage</span>
              <strong>{creationProgress.title}</strong>
            </div>
            {progressStartedAt !== null ? <span className="pool-creation-elapsed">{formatPoolCreationElapsed(progressStartedAt, progressNow)}</span> : null}
          </div>
          <p>{creationProgress.detail}</p>
          <ol className="pool-creation-progress-track" aria-label="Pool creation transaction progress">
            {POOL_CREATION_PROGRESS_STEPS.map((label, index) => {
              const stepNumber = index + 1;
              const verified = stepNumber <= creationProgress.verifiedStep;
              const current = stepNumber === Math.min(6, creationProgress.verifiedStep + 1) && !creationProgress.terminal;
              return (
                <li className={verified ? "verified" : current ? "current" : ""} key={label} aria-current={current ? "step" : undefined}>
                  <span aria-hidden="true">{verified ? "✓" : stepNumber}</span>
                  <small>{label}</small>
                </li>
              );
            })}
          </ol>
          {progressHash ? (
            <dl className="pool-creation-transaction">
              <div>
                <dt>Transaction</dt>
                <dd><span>{formatCompactAddress(progressHash)}</span><code>{progressHash}</code></dd>
              </div>
              {journalRecord?.canonicalReceipt ? (
                <div><dt>Canonical receipt</dt><dd>block {journalRecord.canonicalReceipt.blockNumber} · {journalRecord.confirmations} confirmation{journalRecord.confirmations === 1 ? "" : "s"}</dd></div>
              ) : null}
            </dl>
          ) : (
            <p className="pool-creation-hashless">No authoritative transaction hash has been returned yet.</p>
          )}
          {existingPool ? (
            <dl className="review-grid"><div><dt>Winning pair</dt><dd>{existingPool.pair}</dd></div><div><dt>Fresh live X/Y</dt><dd>{existingLiveTokenX?.symbol ?? existingPool.tokenX} / {existingLiveTokenY?.symbol ?? existingPool.tokenY}</dd></div><div><dt>Fresh live ID / price</dt><dd>{existingPool.activeId.toString()} / {formatExactPriceFraction(normalizeQ128Price(existingPool.priceQ128, { baseDecimals: existingLiveTokenX?.decimals ?? 18, quoteDecimals: existingLiveTokenY?.decimals ?? 18 }), 24)}</dd></div></dl>
          ) : null}
          <div className="wizard-actions pool-creation-result-actions">
            {explorerTransactionUrl ? <a className="secondary-button" href={explorerTransactionUrl} rel="noreferrer" target="_blank">View transaction</a> : null}
            {creationProgress.canCheckStatus ? <button className="secondary-button" data-testid="pool-create-status-retry" disabled={busy} onClick={() => void handleProgressCheck()} type="button">Check status now</button> : null}
            {resultPool ? <a className="secondary-button" href={`#/pools/${encodeURIComponent(resultPool.pair)}`} onClick={() => setPoolCreationOpen(window.sessionStorage, environmentKey, false)}>Open confirmed pool</a> : null}
            <button className="secondary-button" onClick={onClose} type="button">Return to pools</button>
            {creationProgress.canStartFreshReview ? <button className="secondary-button" data-testid="pool-create-fresh-review" onClick={startFreshCreationReview} type="button">Start a fresh creation review</button> : null}
            {resultPool && mode === "create-and-add" ? <a className="primary-button" data-testid="pool-create-position" href={`#/liquidity/add/${encodeURIComponent(resultPool.pair)}`} onClick={() => setPoolCreationOpen(window.sessionStorage, environmentKey, false)}>Create Position · fresh review</a> : null}
          </div>
        </div>
      ) : null}
      {notice ? <p className="state-row warning" role="status">{notice}</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {error && journalRecord?.status === "canonical" && !canonicalRecoveryResolved ? <button className="secondary-button" data-testid="pool-create-reconcile-retry" onClick={() => { setError(null); setCanonicalRetryNonce((value) => value + 1); }} type="button">Retry canonical reconciliation</button> : null}
      {discoveryQuery.isError ? <p className="inline-error" role="alert">{getWriteError(discoveryQuery.error) ?? "Factory discovery failed"}</p> : null}
    </section>
  );
}

async function readPoolCreationToken(
  client: PublicClient,
  registry: DexRegistry,
  address: Address,
  blockNumber: bigint
): Promise<PoolCreationTokenChoice> {
  if (!isAddress(address) || isAddressEqual(address, zeroAddress)) throw new Error("Pool-creation token must be a nonzero address");
  const listed = registry.tokens[address.toLowerCase()] ?? null;
  if (listed?.risk.reviewStatus === "blocked") throw new Error(`${listed.symbol} is blocked by the Feather token policy`);
  const [code, decimals, symbol] = await Promise.all([
    client.getBytecode({ address, blockNumber }),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber }),
    client.readContract({ address, abi: erc20Abi, functionName: "symbol", blockNumber })
  ]);
  if (code === undefined || code === "0x") throw new Error(`Token ${address} has no code at the pinned block`);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`Token ${address} decimals must be from 0 to 36`);
  const normalizedSymbol = symbol.trim();
  if (normalizedSymbol.length === 0 || normalizedSymbol.length > 32 || /[\u0000-\u001f\u007f]/.test(normalizedSymbol)) {
    throw new Error(`Token ${address} returned an unsafe symbol`);
  }
  if (listed && (listed.decimals !== decimals || listed.symbol !== normalizedSymbol)) {
    throw new Error(`Token ${address} live metadata differs from the supported token registry`);
  }
  return {
    address,
    decimals,
    name: listed?.name ?? normalizedSymbol,
    symbol: normalizedSymbol,
    listed: listed !== null
  };
}

function normalizePoolCreationPreset(value: unknown): PoolCreationPresetReview {
  if (!Array.isArray(value) || value.length !== 8 || value[7] !== true || value.slice(0, 7).some((item) => typeof item !== "bigint" || item < 0n)) {
    throw new Error("Factory returned a malformed or closed pool-creation preset");
  }
  return {
    baseFactor: value[0] as bigint,
    filterPeriod: value[1] as bigint,
    decayPeriod: value[2] as bigint,
    reductionFactor: value[3] as bigint,
    variableFeeControl: value[4] as bigint,
    protocolShare: value[5] as bigint,
    maxVolatilityAccumulator: value[6] as bigint,
    isOpen: true
  };
}

function samePoolCreationPreset(left: PoolCreationPresetReview, right: PoolCreationPresetReview): boolean {
  return left.isOpen === right.isOpen &&
    left.baseFactor === right.baseFactor &&
    left.filterPeriod === right.filterPeriod &&
    left.decayPeriod === right.decayPeriod &&
    left.reductionFactor === right.reductionFactor &&
    left.variableFeeControl === right.variableFeeControl &&
    left.protocolShare === right.protocolShare &&
    left.maxVolatilityAccumulator === right.maxVolatilityAccumulator;
}

async function readDuplicatePoolIdentity(
  client: PublicClient,
  factory: Address,
  pair: Address,
  selection: PoolCreationSelection,
  blockNumber: bigint,
  blockHash: Hex
): Promise<DuplicatePoolObservation> {
  const [code, liveFactory, tokenX, tokenY, binStep, activeId, reserves] = await Promise.all([
    client.getBytecode({ address: pair, blockNumber }),
    client.readContract({ address: pair, abi: lbPairAbi, functionName: "getFactory", blockNumber }),
    client.readContract({ address: pair, abi: lbPairAbi, functionName: "getTokenX", blockNumber }),
    client.readContract({ address: pair, abi: lbPairAbi, functionName: "getTokenY", blockNumber }),
    client.readContract({ address: pair, abi: lbPairAbi, functionName: "getBinStep", blockNumber }),
    client.readContract({ address: pair, abi: lbPairAbi, functionName: "getActiveId", blockNumber }),
    client.readContract({ address: pair, abi: LB_PAIR_RESERVES_ABI, functionName: "getReserves", blockNumber })
  ]);
  if (code === undefined || code === "0x") throw new Error("Factory duplicate lookup resolved a pair with no code");
  if (!isAddressEqual(liveFactory, factory)) throw new Error("Duplicate pair factory does not match the selected deployment");
  const exactOrientation = isAddressEqual(tokenX, selection.tokenX) && isAddressEqual(tokenY, selection.tokenY);
  const reverseOrientation = isAddressEqual(tokenX, selection.tokenY) && isAddressEqual(tokenY, selection.tokenX);
  if (!exactOrientation && !reverseOrientation) {
    throw new Error("Duplicate pair token identity differs from the requested normalized pair");
  }
  if (BigInt(binStep) !== selection.binStep) throw new Error("Duplicate pair bin step differs from the requested preset");
  const normalizedActiveId = BigInt(activeId);
  const priceQ128 = await client.readContract({
    address: pair,
    abi: lbPairAbi,
    functionName: "getPriceFromId",
    args: [Number(normalizedActiveId)],
    blockNumber
  });
  const recoveredId = await client.readContract({
    address: pair,
    abi: lbPairAbi,
    functionName: "getIdFromPrice",
    args: [priceQ128],
    blockNumber
  });
  const idDelta = BigInt(recoveredId) > normalizedActiveId
    ? BigInt(recoveredId) - normalizedActiveId
    : normalizedActiveId - BigInt(recoveredId);
  if (idDelta > 1n || priceQ128FromActiveId(normalizedActiveId, selection.binStep) !== priceQ128) {
    throw new Error("Duplicate pair live price and active ID failed exact reconciliation");
  }
  const canonical = await client.getBlock({ blockNumber });
  if (canonical.hash === null || canonical.hash.toLowerCase() !== blockHash.toLowerCase()) {
    throw new Error("Duplicate pair observation reorganized during pinned reads");
  }
  return {
    pool: {
      pair,
      factory,
      tokenX,
      tokenY,
      binStep: selection.binStep,
      activeId: normalizedActiveId,
      priceQ128,
      observedHead: { number: blockNumber, hash: blockHash }
    },
    reserveX: reserves[0],
    reserveY: reserves[1]
  };
}

function createDuplicateReviewFallback(input: {
  account: Address;
  activeId: bigint;
  blockHash: Hex;
  blockNumber: bigint;
  environmentKey: EnvironmentKey;
  mode: PoolCreationMode;
  priceInput: string;
  pricePreview: {
    inverseBasePerQuote: string;
    representedPriceQ128: bigint;
    representedQuotePerBase: string;
  };
  preset: PoolCreationPresetReview;
  registry: DexRegistry;
  riskAcknowledged: boolean;
  selection: PoolCreationSelection;
  tokenX: PoolCreationTokenChoice;
  tokenY: PoolCreationTokenChoice;
}): PoolCreationReview {
  if (!input.riskAcknowledged) throw new Error("Pool-creation risk acknowledgement is missing");
  const preflight: CreatablePoolPreflight = {
    kind: "creatable",
    blockNumber: input.blockNumber,
    selection: input.selection
  };
  const transaction = buildCreateLBPairTransaction(input.registry.contracts.lbRouter, preflight, input.activeId);
  return createPoolCreationReview({
    environment: input.environmentKey,
    deploymentEpoch: deploymentEpoch(input.registry),
    chainId: input.registry.chainId,
    walletChainId: input.registry.chainId,
    rpcChainId: input.registry.chainId,
    account: input.account,
    factory: input.registry.contracts.lbFactory,
    router: input.registry.contracts.lbRouter,
    tokenX: input.selection.tokenX,
    tokenY: input.selection.tokenY,
    tokenXDecimals: input.tokenX.decimals,
    tokenYDecimals: input.tokenY.decimals,
    binStep: input.selection.binStep,
    activeId: input.activeId,
    requestedQuotePerBase: input.priceInput,
    representableQuotePerBase: input.pricePreview.representedQuotePerBase,
    representablePriceQ128: input.pricePreview.representedPriceQ128,
    preset: input.preset,
    pinnedHead: { number: input.blockNumber, hash: input.blockHash },
    mode: input.mode,
    transaction,
    roundingRiskAcknowledged: true
  });
}

function poolOverlayRow(
  pair: Address,
  prepared: PoolCreationPreparedReview,
  blockNumber: bigint,
  registry: DexRegistry
): PoolRow {
  return {
    id: pair,
    address: pair,
    tokenXAddress: prepared.review.binding.tokenX,
    tokenYAddress: prepared.review.binding.tokenY,
    tokenX: prepared.tokenX.listed ? registry.tokens[prepared.tokenX.address.toLowerCase()] ?? null : null,
    tokenY: prepared.tokenY.listed ? registry.tokens[prepared.tokenY.address.toLowerCase()] ?? null : null,
    activeId: prepared.review.binding.activeId.toString(),
    binStep: prepared.review.binding.binStep.toString(),
    reserveX: "0",
    reserveY: "0",
    volumeX: "0",
    volumeY: "0",
    feesX: "0",
    feesY: "0",
    factoryAddress: registry.contracts.lbFactory,
    hooksParameters: null,
    ignoredForRouting: false,
    swapCount: "0",
    depositCount: "0",
    updatedAtBlock: blockNumber.toString()
  };
}

function duplicatePoolOverlayRow(
  observation: DuplicatePoolObservation,
  tokenX: PoolCreationTokenChoice,
  tokenY: PoolCreationTokenChoice,
  registry: DexRegistry
): PoolRow {
  const pool = observation.pool;
  const liveTokenX = isAddressEqual(pool.tokenX, tokenX.address) ? tokenX : tokenY;
  const liveTokenY = isAddressEqual(pool.tokenY, tokenY.address) ? tokenY : tokenX;
  return {
    id: pool.pair,
    address: pool.pair,
    tokenXAddress: pool.tokenX,
    tokenYAddress: pool.tokenY,
    tokenX: liveTokenX.listed ? registry.tokens[liveTokenX.address.toLowerCase()] ?? null : null,
    tokenY: liveTokenY.listed ? registry.tokens[liveTokenY.address.toLowerCase()] ?? null : null,
    activeId: pool.activeId.toString(),
    binStep: pool.binStep.toString(),
    reserveX: observation.reserveX.toString(),
    reserveY: observation.reserveY.toString(),
    volumeX: "0",
    volumeY: "0",
    feesX: "0",
    feesY: "0",
    factoryAddress: pool.factory,
    hooksParameters: null,
    ignoredForRouting: false,
    swapCount: "0",
    depositCount: "0",
    updatedAtBlock: pool.observedHead.number.toString()
  };
}

function poolCreationPriceSourceLabel(baseSource: string, quoteSource: string): string {
  const label = (source: string) => source === "chainlink-data-feeds"
    ? "Chainlink Data Feeds"
    : source === "chainlink-data-streams"
      ? "Chainlink Data Streams"
      : source === "fixed-test"
        ? "Verified local test feed"
        : source;
  const base = label(baseSource);
  const quote = label(quoteSource);
  return base === quote ? base : `${base} / ${quote}`;
}

function formatPoolCreationPriceAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${ageSeconds}s`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function LiquidityView({
  environmentKey,
  initialSection,
  onSelectedPoolChange,
  primaryPool,
  poolOptions,
  portfolioAction,
  selectedPoolId,
  snapshot,
  snapshotQueryErrored,
  onRefresh
}: {
  environmentKey: EnvironmentKey;
  initialSection: "add" | "withdraw" | null;
  onSelectedPoolChange: (poolId: string) => void;
  primaryPool: PoolRow | null;
  poolOptions: PoolRow[];
  portfolioAction: "add" | "partial" | "full" | null;
  selectedPoolId: string;
  snapshot: AppSnapshot | undefined;
  snapshotQueryErrored: boolean;
  onRefresh: SnapshotRefetch;
}) {
  const [amountXInput, setAmountXInput] = usePoolDraftState("liquidity.amountX", "0.01");
  const [amountYInput, setAmountYInput] = usePoolDraftState("liquidity.amountY", "1");
  const [lowerDeltaInput, setLowerDeltaInput] = usePoolDraftState("liquidity.lowerDelta", "-1");
  const [upperDeltaInput, setUpperDeltaInput] = usePoolDraftState("liquidity.upperDelta", "1");
  const [lowerBinInput, setLowerBinInput] = usePoolDraftState("liquidity.lowerBin", "");
  const [upperBinInput, setUpperBinInput] = usePoolDraftState("liquidity.upperBin", "");
  const [lowerBinId, setLowerBinId] = usePoolDraftState<number | null>("liquidity.lowerBinId", null);
  const [upperBinId, setUpperBinId] = usePoolDraftState<number | null>("liquidity.upperBinId", null);
  const [lowerPriceInput, setLowerPriceInput] = usePoolDraftState("liquidity.lowerPrice", "");
  const [upperPriceInput, setUpperPriceInput] = usePoolDraftState("liquidity.upperPrice", "");
  const [rangeEditError, setRangeEditError] = useState<string | null>(null);
  const [narrowPresetInput, setNarrowPresetInput] = usePoolDraftState("liquidity.narrowPreset", "3");
  const [widePresetInput, setWidePresetInput] = usePoolDraftState("liquidity.widePreset", "21");
  const [liquidityStrategy, setLiquidityStrategy] = usePoolDraftState<LiquidityStrategy>("liquidity.strategy", "spot");
  const [liquidityAssetMode, setLiquidityAssetMode] = usePoolDraftState<"erc20" | "native">("liquidity.assetMode", "erc20");
  const [removeAssetMode, setRemoveAssetMode] = usePoolDraftState<"erc20" | "native">("liquidity.removeAssetMode", "erc20");
  const [slippageInput, setSlippageInput] = usePoolDraftState("liquidity.slippage", "0.5");
  const [idSlippageInput, setIdSlippageInput] = usePoolDraftState("liquidity.idSlippage", "2");
  const [deadlineInput, setDeadlineInput] = usePoolDraftState("liquidity.deadline", "20");
  const [liquiditySimulationError, setLiquiditySimulationError] = useState<string | null>(null);
  const [liquiditySimulationPending, setLiquiditySimulationPending] = useState(false);
  const [gasReviewError, setGasReviewError] = useState<string | null>(null);
  const [gasReview, setGasReview] = useState<ExactGasReview | null>(null);
  const [liquidityAddReview, setLiquidityAddReview] = useState<LiquidityAddReviewState | null>(null);
  const [submittedLiquidityAddReview, setSubmittedLiquidityAddReview] = useState<SubmittedLiquidityAddReview | null>(null);
  const [submittedNativeRemoveReview, setSubmittedNativeRemoveReview] = useState<SubmittedNativeRemoveReview | null>(null);
  const [nativeRemoveOrphanNotice, setNativeRemoveOrphanNotice] = useState<string | null>(null);
  const [liquidityReviewNotice, setLiquidityReviewNotice] = useState<string | null>(null);
  const [removeQuoteReviewRequired, setRemoveQuoteReviewRequired] = useState<string | null>(null);
  const [fullExitUi, setFullExitUi] = useState<FullExitUiState | null>(null);
  const [fullExitBatchReview, setFullExitBatchReview] = useState<FullExitBatchReviewState | null>(null);
  const latestFullExitBatchReviewRef = useRef<FullExitBatchReviewState | null>(fullExitBatchReview);
  latestFullExitBatchReviewRef.current = fullExitBatchReview;
  const [selectedPositionIds, setSelectedPositionIds] = usePoolDraftState<string[]>("liquidity.selectedPositionIds", []);
  const [removePercentInput, setRemovePercentInput] = usePoolDraftState("liquidity.removePercent", "100");
  const [explicitFullExitRequested, setExplicitFullExitRequested] = useState(false);
  const [liquidityReceiptPhase, setLiquidityReceiptPhase] = useState<"idle" | "lb-approval" | "remove">("idle");
  const [submittedRemoveReceiptContext, setSubmittedRemoveReceiptContext] = useState<string | null>(null);
  const [submittedFullExitHash, setSubmittedFullExitHash] = useState<Address | null>(null);
  const [submittedApproveXReceiptContext, setSubmittedApproveXReceiptContext] = useState<string | null>(null);
  const [submittedApproveYReceiptContext, setSubmittedApproveYReceiptContext] = useState<string | null>(null);
  const [submittedLbApprovalReceiptContext, setSubmittedLbApprovalReceiptContext] = useState<string | null>(null);
  const [submittedAddReceiptContext, setSubmittedAddReceiptContext] = useState<string | null>(null);
  const intentionalEmptySelectionRef = useRef(false);
  const portfolioPrefillKeyRef = useRef<string | null>(null);
  const rangePoolKeyRef = useRef<string | null>(null);
  const rangeEditGenerationRef = useRef(0);
  const liquidityOperationGenerationRef = useRef(0);
  const approveXSubmitInFlightRef = useRef<number | null>(null);
  const approveYSubmitInFlightRef = useRef<number | null>(null);
  const approveLbSubmitInFlightRef = useRef<number | null>(null);
  const addSubmitInFlightRef = useRef<number | null>(null);
  const nativeAddMaxProbeRef = useRef<"x" | "y" | null>(null);
  const nativeAddMaxBindingRef = useRef<{ balance: bigint; context: string; gasPrice: bigint; reserve: bigint; side: "x" | "y"; value: bigint } | null>(null);
  const latestAddGasObservationRef = useRef<{ balance: bigint; context: string; gasPrice: bigint; reserve: bigint } | null>(null);
  const [nativeAddMaxPending, setNativeAddMaxPending] = useState(false);
  const [pairedFillSourceSide, setPairedFillSourceSide] = useState<PairedFillSide>("x");
  const [pairedFillApplication, setPairedFillApplication] = useState<{
    amountX: string;
    amountY: string;
    contextFingerprint: string;
    pairedAmount: string;
    pairedSide: PairedFillSide;
    sourceAmount: string;
    sourceSide: PairedFillSide;
  } | null>(null);
  const pairedFillContextRef = useRef<string | null>(null);
  const latestLiquidityAddReviewRef = useRef<LiquidityAddReviewState | null>(null);
  const removeSubmitInFlightRef = useRef<number | null>(null);
  const [handledApproveXHash, setHandledApproveXHash] = useState<Address | null>(null);
  const [handledApproveYHash, setHandledApproveYHash] = useState<Address | null>(null);
  const [handledLbApprovalHash, setHandledLbApprovalHash] = useState<Address | null>(null);
  const [handledAddHash, setHandledAddHash] = useState<Address | null>(null);
  const [handledRemoveHash, setHandledRemoveHash] = useState<Address | null>(null);
  const registry = registries[environmentKey];
  const poolWorkspace = useOptionalPoolWorkspace();
  const workspaceMatchesPool = poolWorkspace !== null && primaryPool !== null && isAddressEqual(poolWorkspace.pool.address, primaryPool.address);
  const mobileWorkspaceNavigation = useMediaQuery("(max-width: 720px)") && workspaceMatchesPool;
  const portfolioEndpoint = analyticsEndpointForRegistry(registry);
  const localnetRegistry = isLocalnetRegistry(registry) ? registry : null;
  const account = useAccount();
  const activeWalletChainId = useChainId();
  const approveXWrite = useWriteContract();
  const approveYWrite = useWriteContract();
  const approveLbWrite = useWriteContract();
  const addWrite = useSendTransaction();
  const removeWrite = useSendTransaction();
  const approveXReceipt = useWaitForTransactionReceipt({ hash: approveXWrite.data });
  const approveYReceipt = useWaitForTransactionReceipt({ hash: approveYWrite.data });
  const approveLbReceipt = useWaitForTransactionReceipt({ hash: approveLbWrite.data });
  const addReceipt = useWaitForTransactionReceipt({ hash: addWrite.data });
  const removeReceipt = useWaitForTransactionReceipt({ hash: removeWrite.data });
  const transactionJournal = useTransactionJournal();
  const publicClient = useMemo(() => createDexPublicClient(registry.chain, registry.endpoints.rpcUrl), [registry]);
  const [lbApprovalObservation, setLbApprovalObservation] = useState<LbOperatorApprovalObservation | null>(null);
  const [observedApprovedLbGrants, setObservedApprovedLbGrants] = useState<LbOperatorApprovalGrant[]>([]);
  const latestLbApprovalObservationRef = useRef<LbOperatorApprovalObservation | null>(lbApprovalObservation);
  const latestObservedApprovedLbGrantsRef = useRef<readonly LbOperatorApprovalGrant[]>(observedApprovedLbGrants);
  latestLbApprovalObservationRef.current = lbApprovalObservation;
  latestObservedApprovedLbGrantsRef.current = observedApprovedLbGrants;

  useEffect(() => {
    if (initialSection === null || workspaceMatchesPool) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(initialSection === "withdraw" ? "liquidity-withdraw" : "liquidity-add")?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialSection, selectedPoolId, workspaceMatchesPool]);
  const selectedPool = buildPoolDescriptor({
    action: "add-liquidity",
    localnetRegistry,
    pool: primaryPool,
    registry,
    snapshot
  });
  const removeSelectedPool = buildPoolDescriptor({
    action: "remove-liquidity",
    localnetRegistry,
    pool: primaryPool,
    registry,
    snapshot
  });
  const pool = executionPoolFromDescriptor(selectedPool) ?? executionPoolFromDescriptor(removeSelectedPool);
  const tokenX = selectedPool.tokenX ?? removeSelectedPool.tokenX;
  const tokenY = selectedPool.tokenY ?? removeSelectedPool.tokenY;
  const liquidityWrappedNativeCandidates = [tokenX, tokenY].filter((token): token is TokenMetadata =>
    token !== null && token.tags.includes("wrapped-native") && tokenAllowsAction(token, "add-liquidity")
  );
  const liquidityWrappedNative = liquidityWrappedNativeCandidates.length === 1 ? liquidityWrappedNativeCandidates[0] : null;
  const liquidityWrappedNativeSide: "x" | "y" | null =
    liquidityWrappedNative === null || pool === null
      ? null
      : isAddressEqual(liquidityWrappedNative.address, pool.tokenX)
        ? "x"
        : isAddressEqual(liquidityWrappedNative.address, pool.tokenY)
          ? "y"
          : null;
  const removeWrappedNativeCandidates = [tokenX, tokenY].filter((token): token is TokenMetadata =>
    token !== null && token.tags.includes("wrapped-native") && tokenAllowsAction(token, "remove-liquidity")
  );
  const removeWrappedNative = removeWrappedNativeCandidates.length === 1 ? removeWrappedNativeCandidates[0] : null;
  const removeWrappedNativeSide: "x" | "y" | null =
    removeWrappedNative === null || pool === null
      ? null
      : isAddressEqual(removeWrappedNative.address, pool.tokenX)
        ? "x"
        : isAddressEqual(removeWrappedNative.address, pool.tokenY)
          ? "y"
          : null;
  const connected = account.status === "connected" && account.address !== undefined;
  const onWrongChain = connected && activeWalletChainId !== registry.chainId;
  const liquidityLifecycleKey = [
    environmentKey,
    registry.chainId.toString(),
    registry.endpoints.rpcUrl,
    registry.endpoints.indexerUrl ?? "",
    registry.contracts.lbRouter,
    account.address ?? "",
    activeWalletChainId?.toString() ?? "",
    selectedPoolId,
    pool?.pair ?? "",
    pool?.tokenX ?? "",
    pool?.tokenY ?? "",
    pool?.binStep.toString() ?? "",
    initialSection ?? "",
    portfolioAction ?? ""
  ].join("|");

  const rpcReady = runtimeIsReady(snapshot, registry.chainId);
  const liquidityPairClaim = primaryPool === null ? null : poolRowToPairClaim(primaryPool, "add-liquidity");
  const liquidityAttestationQuery = useQuery({
    queryKey: ["liquidityPairAttestation", deploymentEpoch(registry), liquidityPairClaim],
    queryFn: async () => {
      if (liquidityPairClaim === null) throw new PairAttestationError("unindexed-pair", "Selected pair is not present in the current indexer snapshot");
      return attestPairForWrite(publicClient, registry, liquidityPairClaim);
    },
    enabled: rpcReady && liquidityPairClaim !== null,
    refetchInterval: rpcReady && liquidityPairClaim !== null ? 10_000 : false,
    retry: false
  });
  const liquidityExitAttestationQuery = useQuery({
    queryKey: ["liquidityExitPairAttestation", deploymentEpoch(registry), primaryPool],
    queryFn: async () => {
      if (primaryPool === null) throw new PairAttestationError("unindexed-pair", "Selected pair is not present in the current indexer snapshot");
      return attestPairForWrite(publicClient, registry, poolRowToPairClaim(primaryPool, "remove-liquidity"));
    },
    enabled: rpcReady && primaryPool !== null,
    refetchInterval: rpcReady && primaryPool !== null ? 10_000 : false,
    retry: false
  });
  const attestLiquidityPair = async (operation: "add-liquidity" | "remove-liquidity", blockNumber?: bigint) => {
    if (primaryPool === null) throw new PairAttestationError("unindexed-pair", "Selected pair is not present in the current indexer snapshot");
    return attestPairForWrite(publicClient, registry, poolRowToPairClaim(primaryPool, operation), blockNumber);
  };
  const activeBin =
    selectedPool.activeId ??
    pool?.activeId ??
    (primaryPool?.activeId !== null && primaryPool?.activeId !== undefined
      ? Number(primaryPool.activeId)
      : localnetRegistry !== null
        ? snapshot?.runtime.seededActiveId ?? null
        : null);
  const rangePoolKey = [environmentKey, pool?.pair ?? "", pool?.tokenX ?? "", pool?.tokenY ?? "", pool?.binStep.toString() ?? ""].join("|");
  const commitAbsoluteRange = (nextLowerBin: number, nextUpperBin: number): boolean => {
    if (
      !Number.isSafeInteger(nextLowerBin) ||
      !Number.isSafeInteger(nextUpperBin) ||
      nextLowerBin < 0 ||
      nextUpperBin > MAX_LIQUIDITY_BIN_ID
    ) {
      setRangeEditError("Range bin IDs must fit uint24");
      return false;
    }
    if (nextUpperBin < nextLowerBin) {
      setRangeEditError("Lower range must not exceed upper range");
      return false;
    }
    if (nextUpperBin - nextLowerBin + 1 > MAX_LIQUIDITY_BINS) {
      setRangeEditError(`Liquidity range must include between 1 and ${MAX_LIQUIDITY_BINS} bins`);
      return false;
    }

    rangeEditGenerationRef.current += 1;
    setLowerBinId(nextLowerBin);
    setUpperBinId(nextUpperBin);
    setLowerBinInput(String(nextLowerBin));
    setUpperBinInput(String(nextUpperBin));
    if (activeBin !== null) {
      setLowerDeltaInput(String(nextLowerBin - activeBin));
      setUpperDeltaInput(String(nextUpperBin - activeBin));
    }
    setRangeEditError(null);
    return true;
  };
  useEffect(() => {
    if (activeBin === null) return;
    if (rangePoolKeyRef.current !== rangePoolKey || lowerBinId === null || upperBinId === null) {
      rangePoolKeyRef.current = rangePoolKey;
      const nextLowerBin = Math.max(0, activeBin - 1);
      const nextUpperBin = Math.min(MAX_LIQUIDITY_BIN_ID, activeBin + 1);
      commitAbsoluteRange(nextLowerBin, nextUpperBin);
      return;
    }

    setLowerDeltaInput(String(lowerBinId - activeBin));
    setUpperDeltaInput(String(upperBinId - activeBin));
  }, [activeBin, rangePoolKey]);
  const parsedAmountXResult = parseTokenAmount(amountXInput, tokenX?.decimals ?? 18);
  const parsedAmountYResult = parseTokenAmount(amountYInput, tokenY?.decimals ?? 18);
  const parsedAmountX = parsedAmountXResult.amount;
  const parsedAmountY = parsedAmountYResult.amount;
  const lowerDelta =
    rangeEditError === null && lowerBinId !== null && activeBin !== null
      ? lowerBinId - activeBin
      : rangeEditError === null
        ? parseIntegerInput(lowerDeltaInput)
        : null;
  const upperDelta =
    rangeEditError === null && upperBinId !== null && activeBin !== null
      ? upperBinId - activeBin
      : rangeEditError === null
        ? parseIntegerInput(upperDeltaInput)
        : null;
  const rangePriceOptions =
    tokenX === null || tokenY === null
      ? null
      : { baseDecimals: tokenX.decimals, quoteDecimals: tokenY.decimals };
  const rangePriceQuery = useQuery({
    queryKey: ["liquidityRangePrices", environmentKey, pool?.pair, lowerBinId, upperBinId],
    queryFn: async () => {
      if (pool === null || lowerBinId === null || upperBinId === null) throw new Error("Liquidity range is unavailable");
      const [lowerPriceQ128, upperPriceQ128] = await Promise.all([
        readPriceFromId(publicClient, pool.pair, lowerBinId),
        readPriceFromId(publicClient, pool.pair, upperBinId)
      ]);
      return { lowerPriceQ128, upperPriceQ128 };
    },
    enabled: pool !== null && lowerBinId !== null && upperBinId !== null,
    retry: false
  });
  useEffect(() => {
    if (rangePriceQuery.data === undefined || rangePriceOptions === null) return;
    setLowerPriceInput(formatExactPriceFraction(normalizeQ128Price(rangePriceQuery.data.lowerPriceQ128, rangePriceOptions)));
    setUpperPriceInput(formatExactPriceFraction(normalizeQ128Price(rangePriceQuery.data.upperPriceQ128, rangePriceOptions)));
  }, [rangePriceOptions?.baseDecimals, rangePriceOptions?.quoteDecimals, rangePriceQuery.data]);
  const slippageBps = parseSlippageToBps(slippageInput);
  const idSlippage = parseIdSlippage(idSlippageInput);
  const idSlippageError = idSlippageInputError(idSlippageInput);
  const deadlineMinutes = parseDeadlineMinutes(deadlineInput);
  const removePercentBps = parsePercentToBps(removePercentInput);
  const distributionResult = buildLiquidityDistributionForView(activeBin, lowerDelta, upperDelta, liquidityStrategy);
  const rangeBackdrop = useMemo<{ error: string | null; points: BinDistributionPoint[] | null; state: LoadState }>(() => {
    if (!workspaceMatchesPool || poolWorkspace === null) {
      return { error: "Open a pool workspace to compare this position with indexed reserves.", points: null, state: "unavailable" };
    }
    if (poolWorkspace.binsState !== "ready") {
      return { error: poolWorkspace.binsError, points: null, state: poolWorkspace.binsState };
    }
    if (activeBin === null || tokenX === null || tokenY === null) {
      return { error: "Pool bin identity or token decimals are unavailable.", points: null, state: "unavailable" };
    }
    try {
      return {
        error: null,
        points: buildCenteredBinDistribution(poolWorkspace.bins, String(activeBin), tokenX.decimals, tokenY.decimals, 40),
        state: "ready"
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Indexed liquidity is unavailable.", points: null, state: "error" };
    }
  }, [activeBin, poolWorkspace, tokenX, tokenY, workspaceMatchesPool]);
  const liquidityMode = distributionResult.distribution?.mode ?? null;
  const amountX = liquidityMode === "token-y" ? 0n : parsedAmountX;
  const amountY = liquidityMode === "token-x" ? 0n : parsedAmountY;
  const nativeSideAmount = liquidityWrappedNativeSide === "x" ? amountX : liquidityWrappedNativeSide === "y" ? amountY : null;
  const nativeAdd = liquidityAssetMode === "native" && nativeSideAmount !== null && nativeSideAmount > 0n;
  const effectiveAddAssetMode: "erc20" | "native" = nativeAdd ? "native" : "erc20";
  const addTransactionValue = nativeAdd ? nativeSideAmount : 0n;
  const addAssetFingerprint = liquidityAddAssetFingerprint({
    assetMode: effectiveAddAssetMode,
    selectedMode: liquidityAssetMode,
    transactionValue: addTransactionValue.toString(),
    wrappedNative: liquidityWrappedNative?.address ?? null,
    wrappedNativeSide: liquidityWrappedNativeSide
  });
  const nativeRemove = removeAssetMode === "native" && removeWrappedNative !== null && removeWrappedNativeSide !== null;
  const effectiveRemoveAssetMode: "erc20" | "native" = nativeRemove ? "native" : "erc20";
  const buildExactRemoveTransaction = (input: Parameters<typeof buildRemoveLiquidityTransaction>[1]) =>
    nativeRemove
      ? buildRemoveLiquidityNativeTransaction(registry, input)
      : buildRemoveLiquidityTransaction(registry, input);
  const rangeControlError =
    rangeEditError ??
    (rangePriceQuery.error ? `Range price read failed: ${getWriteError(rangePriceQuery.error) ?? "price unavailable"}` : null) ??
    (pool !== null && lowerBinId !== null && upperBinId !== null && rangePriceQuery.data === undefined
      ? "Loading exact range prices"
      : null);
  const updateLowerDelta = (value: string) => {
    setLowerDeltaInput(value);
    const nextLowerDelta = parseIntegerInput(value);
    const nextUpperDelta = parseIntegerInput(upperDeltaInput);
    if (activeBin === null || nextLowerDelta === null || nextUpperDelta === null) {
      setRangeEditError("Enter integer bin deltas");
      return;
    }
    commitAbsoluteRange(activeBin + nextLowerDelta, activeBin + nextUpperDelta);
  };
  const updateUpperDelta = (value: string) => {
    setUpperDeltaInput(value);
    const nextLowerDelta = parseIntegerInput(lowerDeltaInput);
    const nextUpperDelta = parseIntegerInput(value);
    if (activeBin === null || nextLowerDelta === null || nextUpperDelta === null) {
      setRangeEditError("Enter integer bin deltas");
      return;
    }
    commitAbsoluteRange(activeBin + nextLowerDelta, activeBin + nextUpperDelta);
  };
  const updateLowerBin = (value: string) => {
    setLowerBinInput(value);
    const nextLowerBin = parseIntegerInput(value);
    const nextUpperBin = parseIntegerInput(upperBinInput);
    if (nextLowerBin === null || nextUpperBin === null) {
      setRangeEditError("Enter integer bin IDs");
      return;
    }
    commitAbsoluteRange(nextLowerBin, nextUpperBin);
  };
  const updateUpperBin = (value: string) => {
    setUpperBinInput(value);
    const nextLowerBin = parseIntegerInput(lowerBinInput);
    const nextUpperBin = parseIntegerInput(value);
    if (nextLowerBin === null || nextUpperBin === null) {
      setRangeEditError("Enter integer bin IDs");
      return;
    }
    commitAbsoluteRange(nextLowerBin, nextUpperBin);
  };
  const updatePriceBoundary = async (boundary: "lower" | "upper", value: string) => {
    if (pool === null || rangePriceOptions === null || lowerBinId === null || upperBinId === null) {
      setRangeEditError("Liquidity price conversion is unavailable");
      return;
    }
    const generation = rangeEditGenerationRef.current + 1;
    rangeEditGenerationRef.current = generation;
    try {
      const requestedQ128 = decimalPriceToQ128(value, rangePriceOptions);
      const mappedBin = Number(await readIdFromPrice(publicClient, pool.pair, requestedQ128));
      if (rangeEditGenerationRef.current !== generation) return;
      const mappedPriceQ128 = await readPriceFromId(publicClient, pool.pair, mappedBin);
      if (rangeEditGenerationRef.current !== generation) return;
      const committed = boundary === "lower"
        ? commitAbsoluteRange(mappedBin, upperBinId)
        : commitAbsoluteRange(lowerBinId, mappedBin);
      if (!committed) return;
      const mappedPrice = formatExactPriceFraction(normalizeQ128Price(mappedPriceQ128, rangePriceOptions));
      if (boundary === "lower") setLowerPriceInput(mappedPrice);
      else setUpperPriceInput(mappedPrice);
    } catch (error) {
      if (rangeEditGenerationRef.current !== generation) return;
      setRangeEditError(error instanceof Error ? error.message : "Price cannot be represented by an LB bin");
    }
  };
  const applyRangePreset = (value: string) => {
    const width = parseIntegerInput(value);
    if (activeBin === null || width === null || width < 1 || width > MAX_LIQUIDITY_BINS) {
      setRangeEditError(`Preset width must include between 1 and ${MAX_LIQUIDITY_BINS} bins`);
      return;
    }
    const nextLowerBin = activeBin - Math.floor((width - 1) / 2);
    commitAbsoluteRange(nextLowerBin, nextLowerBin + width - 1);
  };
  const addExecutionFingerprint = [
    environmentKey,
    registry.chainId.toString(),
    activeWalletChainId?.toString() ?? "",
    registry.endpoints.rpcUrl,
    registry.contracts.lbRouter,
    account.address ?? "",
    pool?.pair ?? "",
    pool?.tokenX ?? "",
    pool?.tokenY ?? "",
    pool?.binStep.toString() ?? "",
    activeBin?.toString() ?? "",
    amountX?.toString() ?? "",
    amountY?.toString() ?? "",
    slippageBps?.toString() ?? "",
    idSlippage?.toString() ?? "",
    deadlineMinutes?.toString() ?? "",
    liquidityStrategy,
    distributionResult.distribution?.deltaIds.join(",") ?? "",
    distributionResult.distribution?.distributionX.join(",") ?? "",
    distributionResult.distribution?.distributionY.join(",") ?? "",
    addAssetFingerprint
  ].join("|");
  const addMaxContextFingerprint = [
    environmentKey,
    registry.chainId.toString(),
    activeWalletChainId?.toString() ?? "",
    registry.endpoints.rpcUrl,
    registry.contracts.lbRouter,
    account.address ?? "",
    pool?.pair ?? "",
    pool?.tokenX ?? "",
    pool?.tokenY ?? "",
    pool?.binStep.toString() ?? "",
    activeBin?.toString() ?? "",
    slippageBps?.toString() ?? "",
    idSlippage?.toString() ?? "",
    deadlineMinutes?.toString() ?? "",
    liquidityStrategy,
    distributionResult.distribution?.deltaIds.join(",") ?? "",
    distributionResult.distribution?.distributionX.join(",") ?? "",
    distributionResult.distribution?.distributionY.join(",") ?? "",
    liquidityWrappedNativeSide === "x" ? amountY?.toString() ?? "" : amountX?.toString() ?? "",
    liquidityAssetMode,
    liquidityWrappedNative?.address ?? "",
    liquidityWrappedNativeSide ?? ""
  ].join("|");
  const addRetrySettingsFingerprint = [
    environmentKey,
    registry.chainId.toString(),
    activeWalletChainId?.toString() ?? "",
    account.address ?? "",
    pool?.pair ?? "",
    amountX?.toString() ?? "",
    amountY?.toString() ?? "",
    slippageBps?.toString() ?? "",
    idSlippage?.toString() ?? "",
    deadlineMinutes?.toString() ?? "",
    liquidityStrategy,
    lowerDelta?.toString() ?? "",
    upperDelta?.toString() ?? "",
    addAssetFingerprint
  ].join("|");
  const latestAddExecutionFingerprint = useRef(addExecutionFingerprint);
  latestAddExecutionFingerprint.current = addExecutionFingerprint;
  latestLiquidityAddReviewRef.current = liquidityAddReview;
  useEffect(() => {
    if (liquidityAddReview !== null && liquidityAddReview.executionFingerprint !== addExecutionFingerprint) {
      latestLiquidityAddReviewRef.current = null;
      setLiquidityAddReview(null);
      setGasReview(null);
      setGasReviewError(null);
    }
  }, [addExecutionFingerprint, liquidityAddReview]);
  const canonicalAddRecord = useMemo(() => {
    if (
      submittedLiquidityAddReview === null ||
      account.address === undefined ||
      pool === null ||
      submittedLiquidityAddReview.chainId !== registry.chainId ||
      submittedLiquidityAddReview.environment !== environmentKey ||
      !isAddressEqual(submittedLiquidityAddReview.review.pair, pool.pair) ||
      !isAddressEqual(submittedLiquidityAddReview.review.router, registry.contracts.lbRouter)
    ) return null;
    const exactCalldataFingerprint = keccak256(submittedLiquidityAddReview.review.transaction.data);
    return transactionJournal.records
      .filter((record) =>
        record.reviewed.intent === "add-liquidity" &&
        record.reviewed.calldataFingerprint.toLowerCase() === exactCalldataFingerprint.toLowerCase() &&
        record.reviewed.executionFingerprint === submittedLiquidityAddReview.executionFingerprint &&
        record.reviewed.poolId !== null &&
        isAddressEqual(record.reviewed.poolId as Address, submittedLiquidityAddReview.review.pair) &&
        isAddressEqual(record.reviewed.account, account.address!) &&
        record.createdAt >= submittedLiquidityAddReview.submittedAt &&
        record.status === "canonical" &&
        record.activeHash !== null &&
        record.canonicalReceipt?.status === "success" &&
        record.canonicalReceipt.hash.toLowerCase() === record.activeHash.toLowerCase() &&
        record.replacementCompatibility !== "incompatible"
      )
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  }, [account.address, environmentKey, pool, registry.chainId, registry.contracts.lbRouter, submittedLiquidityAddReview, transactionJournal.records]);
  const canonicalAddHash = canonicalAddRecord?.canonicalReceipt?.hash ?? null;
  const activeAddJournalRecord = addWrite.data
    ? transactionJournal.records.find((record) => record.reviewed.intent === "add-liquidity" && record.activeHash?.toLowerCase() === addWrite.data!.toLowerCase()) ?? null
    : null;
  useEffect(() => {
    if (activeAddJournalRecord?.status === "orphaned") {
      setLiquidityReviewNotice("Add-liquidity receipt was reorganized; canonical accounting was removed and retry remains journal-blocked.");
    }
  }, [activeAddJournalRecord?.status]);
  const addReceiptReconciliationQuery = useQuery<AddLiquidityReceiptReconciliation | NativeAddLiquidityReceiptReconciliation>({
    queryKey: ["canonicalAddLiquidityReceipt", registry.chainId, canonicalAddHash],
    queryFn: async () => {
      if (canonicalAddHash === null || submittedLiquidityAddReview === null || account.address === undefined) {
        throw new Error("Canonical add-liquidity receipt is unavailable");
      }
      const owner = account.address;
      const receipt = await publicClient.getTransactionReceipt({ hash: canonicalAddHash });
      if (receipt.status !== "success" || receipt.blockHash.toLowerCase() !== canonicalAddRecord?.canonicalReceipt?.blockHash.toLowerCase()) {
        throw new Error("Canonical add-liquidity receipt changed during reconciliation");
      }
      const parameters = submittedLiquidityAddReview.review.parameters;
      if (submittedLiquidityAddReview.review.assetMode === "native") {
        if (receipt.blockNumber === 0n || liquidityWrappedNative === null || liquidityWrappedNativeSide === null) {
          throw new Error("Canonical native add-liquidity balance evidence is unavailable");
        }
        const beforeBlockNumber = receipt.blockNumber - 1n;
        const otherToken = liquidityWrappedNativeSide === "x" ? parameters.tokenY : parameters.tokenX;
        const transaction = await publicClient.getTransaction({ hash: canonicalAddHash });
        if (
          !isAddressEqual(transaction.from, owner) ||
          transaction.to === null ||
          !isAddressEqual(transaction.to, submittedLiquidityAddReview.review.transaction.to) ||
          transaction.input.toLowerCase() !== submittedLiquidityAddReview.review.transaction.data.toLowerCase() ||
          transaction.value !== submittedLiquidityAddReview.review.transaction.value
        ) throw new Error("Canonical native add-liquidity transaction differs from the reviewed request");
        const canonicalBefore = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
        if (canonicalBefore.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("Canonical native add-liquidity receipt block changed before balance reads");
        const [nativeBalanceBefore, nativeBalanceAfter, wrapperBalanceBefore, wrapperBalanceAfter, otherTokenBalanceBefore, otherTokenBalanceAfter, ...lpValues] = await Promise.all([
          publicClient.getBalance({ address: owner, blockNumber: beforeBlockNumber }),
          publicClient.getBalance({ address: owner, blockNumber: receipt.blockNumber }),
          publicClient.readContract({ address: liquidityWrappedNative.address, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: beforeBlockNumber }),
          publicClient.readContract({ address: liquidityWrappedNative.address, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: receipt.blockNumber }),
          publicClient.readContract({ address: otherToken, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: beforeBlockNumber }),
          publicClient.readContract({ address: otherToken, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: receipt.blockNumber }),
          ...submittedLiquidityAddReview.review.simulation.depositIds.flatMap((binId) => [
            publicClient.readContract({ address: submittedLiquidityAddReview.review.pair, abi: lbPairAbi, functionName: "balanceOf", args: [owner, binId], blockNumber: beforeBlockNumber }),
            publicClient.readContract({ address: submittedLiquidityAddReview.review.pair, abi: lbPairAbi, functionName: "balanceOf", args: [owner, binId], blockNumber: receipt.blockNumber })
          ])
        ]);
        const canonicalAfter = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
        if (canonicalAfter.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("Canonical native add-liquidity receipt block reorganized during accounting");
        return reconcileNativeAddLiquidityReceipt({
          account: owner,
          effectiveGasPrice: receipt.effectiveGasPrice,
          expectedReview: submittedLiquidityAddReview.review,
          gasUsed: receipt.gasUsed,
          logs: receipt.logs,
          lpBalances: submittedLiquidityAddReview.review.simulation.depositIds.map((binId, index) => {
            const before = lpValues[index * 2];
            const after = lpValues[index * 2 + 1];
            if (before === undefined || after === undefined) throw new Error("Canonical LP balance evidence is incomplete");
            return { after, before, binId };
          }),
          nativeBalanceAfter,
          nativeBalanceBefore,
          nativeSide: liquidityWrappedNativeSide,
          otherTokenBalanceAfter,
          otherTokenBalanceBefore,
          pair: submittedLiquidityAddReview.review.pair,
          recipient: parameters.to,
          refundRecipient: parameters.refundTo,
          router: registry.contracts.lbRouter,
          tokenX: parameters.tokenX,
          tokenY: parameters.tokenY,
          transactionValue: submittedLiquidityAddReview.review.transaction.value,
          wrapperBalanceAfter,
          wrapperBalanceBefore
        });
      }
      return reconcileAddLiquidityReceipt({
        account: account.address,
        effectiveGasPrice: receipt.effectiveGasPrice,
        expectedReview: submittedLiquidityAddReview.review,
        gasUsed: receipt.gasUsed,
        logs: receipt.logs,
        pair: submittedLiquidityAddReview.review.pair,
        recipient: parameters.to,
        refundRecipient: parameters.refundTo,
        router: registry.contracts.lbRouter,
        tokenX: parameters.tokenX,
        tokenY: parameters.tokenY
      });
    },
    enabled: canonicalAddHash !== null && submittedLiquidityAddReview !== null && account.address !== undefined,
    retry: false
  });
  const canonicalNativeRemoveRecord = useMemo(() => {
    if (
      submittedNativeRemoveReview === null ||
      submittedNativeRemoveReview.chainId !== registry.chainId ||
      submittedNativeRemoveReview.environment !== environmentKey
    ) return null;
    const calldataFingerprint = keccak256(submittedNativeRemoveReview.transaction.data);
    return transactionJournal.records
      .filter((record) =>
        record.reviewed.intent === "remove-liquidity" &&
        record.reviewed.calldataFingerprint.toLowerCase() === calldataFingerprint.toLowerCase() &&
        record.reviewed.executionFingerprint === submittedNativeRemoveReview.executionFingerprint &&
        record.reviewed.chainId === submittedNativeRemoveReview.chainId &&
        record.reviewed.environment === submittedNativeRemoveReview.environment &&
        isAddressEqual(record.reviewed.target, submittedNativeRemoveReview.transaction.to) &&
        record.reviewed.value === submittedNativeRemoveReview.transaction.value.toString() &&
        isAddressEqual(record.reviewed.account, submittedNativeRemoveReview.account) &&
        record.reviewed.poolId !== null && isAddressEqual(record.reviewed.poolId as Address, submittedNativeRemoveReview.pair) &&
        record.createdAt >= submittedNativeRemoveReview.submittedAt &&
        record.status === "canonical" &&
        record.activeHash !== null &&
        record.canonicalReceipt?.status === "success" &&
        record.canonicalReceipt.hash.toLowerCase() === record.activeHash.toLowerCase() &&
        record.replacementCompatibility !== "incompatible"
      )
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  }, [environmentKey, registry.chainId, submittedNativeRemoveReview, transactionJournal.records]);
  const canonicalNativeRemoveHash = canonicalNativeRemoveRecord?.canonicalReceipt?.hash ?? null;
  const activeNativeRemoveRecord = useMemo(() => {
    if (submittedNativeRemoveReview === null) return null;
    const calldataFingerprint = keccak256(submittedNativeRemoveReview.transaction.data);
    return transactionJournal.records
      .filter((record) =>
        record.reviewed.intent === "remove-liquidity" &&
        record.reviewed.calldataFingerprint.toLowerCase() === calldataFingerprint.toLowerCase() &&
        record.reviewed.executionFingerprint === submittedNativeRemoveReview.executionFingerprint
      )
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  }, [submittedNativeRemoveReview, transactionJournal.records]);
  useEffect(() => {
    if (activeNativeRemoveRecord?.status !== "orphaned") return;
    setSubmittedNativeRemoveReview(null);
    setLiquidityReceiptPhase("idle");
    setSubmittedRemoveReceiptContext(null);
    setNativeRemoveOrphanNotice("Native withdrawal receipt was reorganized; canonical accounting was removed and retry remains journal-blocked.");
  }, [activeNativeRemoveRecord?.status]);
  const nativeRemoveReceiptReconciliationQuery = useQuery<NativeRemoveLiquidityReceiptReconciliation>({
    queryKey: ["canonicalNativeRemoveLiquidityReceipt", registry.chainId, canonicalNativeRemoveHash],
    queryFn: async () => {
      if (canonicalNativeRemoveHash === null || submittedNativeRemoveReview === null) throw new Error("Canonical native removal receipt is unavailable");
      const review = submittedNativeRemoveReview;
      const receipt = await publicClient.getTransactionReceipt({ hash: canonicalNativeRemoveHash });
      if (receipt.status !== "success" || receipt.blockNumber === 0n || receipt.blockHash.toLowerCase() !== canonicalNativeRemoveRecord?.canonicalReceipt?.blockHash.toLowerCase()) {
        throw new Error("Canonical native removal receipt changed during reconciliation");
      }
      const transaction = await publicClient.getTransaction({ hash: canonicalNativeRemoveHash });
      if (
        !isAddressEqual(transaction.from, review.account) || transaction.to === null ||
        !isAddressEqual(transaction.to, review.transaction.to) ||
        transaction.input.toLowerCase() !== review.transaction.data.toLowerCase() ||
        transaction.value !== review.transaction.value
      ) throw new Error("Canonical native removal transaction differs from the reviewed request");
      const receiptBlock = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      if (receiptBlock.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("Canonical native removal block changed before balance reads");
      const beforeBlockNumber = receipt.blockNumber - 1n;
      const otherToken = review.nativeSide === "x" ? review.tokenY : review.tokenX;
      const [nativeBalanceBefore, nativeBalanceAfter, otherTokenBalanceBefore, otherTokenBalanceAfter, ...lpValues] = await Promise.all([
        publicClient.getBalance({ address: review.account, blockNumber: beforeBlockNumber }),
        publicClient.getBalance({ address: review.account, blockNumber: receipt.blockNumber }),
        publicClient.readContract({ address: otherToken, abi: erc20Abi, functionName: "balanceOf", args: [review.account], blockNumber: beforeBlockNumber }),
        publicClient.readContract({ address: otherToken, abi: erc20Abi, functionName: "balanceOf", args: [review.account], blockNumber: receipt.blockNumber }),
        ...review.ids.flatMap((binId) => [
          publicClient.readContract({ address: review.pair, abi: lbPairAbi, functionName: "balanceOf", args: [review.account, binId], blockNumber: beforeBlockNumber }),
          publicClient.readContract({ address: review.pair, abi: lbPairAbi, functionName: "balanceOf", args: [review.account, binId], blockNumber: receipt.blockNumber })
        ])
      ]);
      const canonicalAfter = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      if (canonicalAfter.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("Canonical native removal block reorganized during accounting");
      return reconcileNativeRemoveLiquidityReceipt({
        account: review.account,
        burnAmounts: review.amounts,
        effectiveGasPrice: receipt.effectiveGasPrice,
        expectedAmountX: review.expectedAmountX,
        expectedAmountY: review.expectedAmountY,
        gasUsed: receipt.gasUsed,
        ids: review.ids,
        logs: receipt.logs,
        lpBalances: review.ids.map((binId, index) => {
          const before = lpValues[index * 2];
          const after = lpValues[index * 2 + 1];
          if (before === undefined || after === undefined) throw new Error("Canonical native removal LP evidence is incomplete");
          return { after, before, binId };
        }),
        minimumAmountX: review.minimumAmountX,
        minimumAmountY: review.minimumAmountY,
        nativeBalanceAfter,
        nativeBalanceBefore,
        nativeSide: review.nativeSide,
        otherTokenBalanceAfter,
        otherTokenBalanceBefore,
        pair: review.pair,
        router: registry.contracts.lbRouter,
        tokenX: review.tokenX,
        tokenY: review.tokenY,
        transactionValue: review.transaction.value
      });
    },
    enabled: canonicalNativeRemoveHash !== null && submittedNativeRemoveReview !== null,
    retry: false
  });
  const rangeSliderMin = Math.min(-MAX_LIQUIDITY_BINS, lowerDelta ?? 0, (upperDelta ?? 0) - MAX_LIQUIDITY_BINS + 1);
  const rangeSliderMax = Math.max(MAX_LIQUIDITY_BINS, upperDelta ?? 0, (lowerDelta ?? 0) + MAX_LIQUIDITY_BINS - 1);
  const walletQuery = useQuery({
    queryKey: ["liquidityWallet", registry.chainId, account.address, pool?.pair, pool?.tokenX, pool?.tokenY, registry.contracts.lbRouter],
    queryFn: async () => {
      if (!account.address || !pool) {
        throw new Error("Liquidity wallet reads are not available");
      }

      const [balanceX, balanceY, allowanceX, allowanceY, lbApproved, nativeBalance] = await Promise.all([
        publicClient.readContract({
          address: pool.tokenX,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address]
        }),
        publicClient.readContract({
          address: pool.tokenY,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address]
        }),
        publicClient.readContract({
          address: pool.tokenX,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account.address, registry.contracts.lbRouter]
        }),
        publicClient.readContract({
          address: pool.tokenY,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account.address, registry.contracts.lbRouter]
        }),
        publicClient.readContract({
          address: pool.pair,
          abi: lbPairAbi,
          functionName: "isApprovedForAll",
          args: [account.address, registry.contracts.lbRouter]
        }),
        publicClient.getBalance({ address: account.address })
      ]);

      return {
        approvalAccount: account.address,
        approvalChainId: registry.chainId,
        approvalOperator: registry.contracts.lbRouter,
        approvalPair: pool.pair,
        balanceX: balanceX.toString(),
        balanceY: balanceY.toString(),
        allowanceX: allowanceX.toString(),
        allowanceY: allowanceY.toString(),
        lbApproved,
        nativeBalance: nativeBalance.toString()
      };
    },
    enabled: rpcReady && connected && pool !== null && (selectedPool.ready || removeSelectedPool.ready),
    refetchInterval:
      rpcReady && connected && pool !== null && (selectedPool.ready || removeSelectedPool.ready)
        ? 10_000
        : false,
    retry: false
  });
  const walletData = walletQuery.data && !walletQuery.isError ? walletQuery.data : null;
  const currentLbApprovalGrant = useMemo<LbOperatorApprovalGrant | null>(() =>
    account.address && pool
      ? {
          account: account.address,
          chainId: registry.chainId,
          operator: registry.contracts.lbRouter,
          pair: pool.pair
        }
      : null,
    [account.address, pool?.pair, registry.chainId, registry.contracts.lbRouter]
  );
  useEffect(() => {
    if (!walletQuery.isError || currentLbApprovalGrant === null) return;
    setLbApprovalObservation((current) =>
      observationMatchesGrant(current, currentLbApprovalGrant) ? null : current
    );
    setGasReview(null);
  }, [currentLbApprovalGrant, walletQuery.isError]);
  useEffect(() => {
    if (walletData === null) return;
    const observation: LbOperatorApprovalObservation = {
      account: walletData.approvalAccount,
      approved: walletData.lbApproved,
      chainId: walletData.approvalChainId,
      operator: walletData.approvalOperator,
      pair: walletData.approvalPair
    };
    if (!observationMatchesGrant(observation, currentLbApprovalGrant)) return;
    const previousObservation = latestLbApprovalObservationRef.current;
    const hasExactPriorGrant = latestObservedApprovedLbGrantsRef.current.some((grant) =>
      observationMatchesGrant({ ...grant, approved: true }, observation)
    );
    const previousIsExact = observationMatchesGrant(previousObservation, observation);
    const externallyRevoked =
      !observation.approved &&
      (
        (previousIsExact && previousObservation.approved) ||
        (!previousIsExact && hasExactPriorGrant)
      );
    if (externallyRevoked) {
      setLiquiditySimulationError(null);
      setGasReview(null);
      setGasReviewError(null);
      setRemoveQuoteReviewRequired("LB operator approval was revoked by an external on-chain change. Re-approve this exact pair and router before withdrawing.");
    }
    setLbApprovalObservation((current) =>
      observationMatchesGrant(current, observation) && current.approved === observation.approved
        ? current
        : observation
    );
    if (observation.approved) {
      setObservedApprovedLbGrants((current) => rememberLbApprovalGrant(current, observation));
    }
  }, [
    currentLbApprovalGrant,
    walletQuery.dataUpdatedAt,
    walletData?.approvalAccount,
    walletData?.approvalChainId,
    walletData?.approvalOperator,
    walletData?.approvalPair,
    walletData?.lbApproved
  ]);
  const lbApprovalState = classifyLbOperatorApproval({
    approvedGrants: observedApprovedLbGrants,
    current: currentLbApprovalGrant,
    observation: lbApprovalObservation
  });
  const liveLbApproved = lbApprovalState === "approved";
  useEffect(() => {
    if (!liveLbApproved) return;
    setRemoveQuoteReviewRequired((current) => current?.startsWith("LB operator") ? null : current);
  }, [liveLbApproved]);
  const recordLiveLbApproval = (approved: boolean): LbOperatorApprovalObservation => {
    if (currentLbApprovalGrant === null) throw new Error("Exact LB pair/operator approval context is unavailable");
    const observation = { ...currentLbApprovalGrant, approved };
    setLbApprovalObservation(observation);
    if (approved) {
      setObservedApprovedLbGrants((current) => rememberLbApprovalGrant(current, currentLbApprovalGrant));
    }
    return observation;
  };
  const readLiveLbApproval = async (): Promise<boolean> => {
    if (currentLbApprovalGrant === null) throw new Error("Exact LB pair/operator approval context is unavailable");
    const approved = await publicClient.readContract({
      address: currentLbApprovalGrant.pair,
      abi: lbPairAbi,
      functionName: "isApprovedForAll",
      args: [currentLbApprovalGrant.account, currentLbApprovalGrant.operator]
    });
    recordLiveLbApproval(approved);
    return approved;
  };
  const walletReadsReady = walletData !== null;
  const walletBalanceX = walletData ? BigInt(walletData.balanceX) : null;
  const walletBalanceY = walletData ? BigInt(walletData.balanceY) : null;
  const walletAllowanceX = walletData ? BigInt(walletData.allowanceX) : null;
  const walletAllowanceY = walletData ? BigInt(walletData.allowanceY) : null;
  const nativeBalance = walletData ? BigInt(walletData.nativeBalance) : null;
  const nativeModeX = liquidityAssetMode === "native" && liquidityWrappedNativeSide === "x";
  const nativeModeY = liquidityAssetMode === "native" && liquidityWrappedNativeSide === "y";
  const pairedFillNativeBlockedSide =
    nativeModeX && liquidityMode !== "token-y"
      ? "x"
      : nativeModeY && liquidityMode !== "token-x"
        ? "y"
        : null;
  const pairedFillSourceAmount = pairedFillSourceSide === "x" ? parsedAmountX : parsedAmountY;
  const pairedFillSourceInput = pairedFillSourceSide === "x" ? amountXInput : amountYInput;
  const pairedFillSuggestion = useMemo(
    () => suggestPairedLiquidityAmounts({
      balanceX: nativeModeX ? null : walletBalanceX,
      balanceY: nativeModeY ? null : walletBalanceY,
      binStep: pool?.binStep ?? -1,
      distribution: distributionResult.distribution,
      sourceAmount: pairedFillSourceAmount,
      sourceSide: pairedFillSourceSide
    }),
    [
      activeBin,
      liquidityStrategy,
      lowerDelta,
      nativeModeX,
      nativeModeY,
      pairedFillSourceAmount,
      pairedFillSourceSide,
      pool?.binStep,
      upperDelta,
      walletBalanceX,
      walletBalanceY
    ]
  );
  const pairedFillContextFingerprint = [
    environmentKey,
    registry.chainId.toString(),
    account.address ?? "",
    activeWalletChainId?.toString() ?? "",
    pool?.pair ?? "",
    pool?.binStep.toString() ?? "",
    tokenX?.address ?? "",
    tokenX?.decimals.toString() ?? "",
    tokenY?.address ?? "",
    tokenY?.decimals.toString() ?? "",
    liquidityWrappedNative?.address ?? "",
    liquidityWrappedNativeSide ?? "",
    activeBin?.toString() ?? "",
    liquidityStrategy,
    liquidityAssetMode,
    liquidityMode ?? "",
    pairedFillSourceSide,
    pairedFillSourceInput,
    pairedFillSourceAmount?.toString() ?? "invalid",
    distributionResult.distribution?.deltaIds.join(",") ?? "",
    distributionResult.distribution?.distributionX.join(",") ?? "",
    distributionResult.distribution?.distributionY.join(",") ?? "",
    walletData?.balanceX ?? "",
    walletData?.balanceY ?? "",
    walletData?.nativeBalance ?? "",
    pairedFillSuggestion.pairedSide,
    pairedFillSuggestion.pairedAmount.toString(),
    pairedFillSuggestion.requiredPairedAmount?.toString() ?? "",
    pairedFillSuggestion.clamped ? "clamped" : "exact"
  ].join("|");
  const pairedFillCurrentSourceAmount = pairedFillSourceSide === "x" ? amountX : amountY;
  const pairedFillCurrentPairedAmount = pairedFillSourceSide === "x" ? amountY : amountX;
  const pairedFillApplied =
    pairedFillApplication?.contextFingerprint === pairedFillContextFingerprint &&
    pairedFillApplication.sourceSide === pairedFillSourceSide &&
    pairedFillApplication.pairedSide === pairedFillSuggestion.pairedSide &&
    pairedFillCurrentSourceAmount?.toString() === pairedFillApplication.sourceAmount &&
    pairedFillCurrentPairedAmount?.toString() === pairedFillApplication.pairedAmount &&
    amountX?.toString() === pairedFillApplication.amountX &&
    amountY?.toString() === pairedFillApplication.amountY;
  useEffect(() => {
    if (pairedFillContextRef.current === null) {
      pairedFillContextRef.current = pairedFillContextFingerprint;
      return;
    }
    if (pairedFillContextRef.current === pairedFillContextFingerprint) return;
    pairedFillContextRef.current = pairedFillContextFingerprint;
    setPairedFillApplication(null);
  }, [pairedFillContextFingerprint]);
  const nativeX = nativeAdd && liquidityWrappedNativeSide === "x";
  const nativeY = nativeAdd && liquidityWrappedNativeSide === "y";
  const spendableBalanceX = nativeX ? nativeBalance : walletBalanceX;
  const spendableBalanceY = nativeY ? nativeBalance : walletBalanceY;
  const needsXApproval = !nativeX && amountX !== null && amountX > 0n && walletAllowanceX !== null && walletAllowanceX < amountX;
  const needsYApproval = !nativeY && amountY !== null && amountY > 0n && walletAllowanceY !== null && walletAllowanceY < amountY;
  const insufficientX = amountX !== null && amountX > 0n && spendableBalanceX !== null && spendableBalanceX < amountX;
  const insufficientY = amountY !== null && amountY > 0n && spendableBalanceY !== null && spendableBalanceY < amountY;
  const approveXExecutionFingerprint = [
    addExecutionFingerprint,
    "token-x",
    pool?.tokenX ?? "",
    registry.contracts.lbRouter,
    amountX?.toString() ?? "",
    walletAllowanceX?.toString() ?? "",
    needsXApproval ? "approval-required" : "approval-not-required"
  ].join("|");
  const approveYExecutionFingerprint = [
    addExecutionFingerprint,
    "token-y",
    pool?.tokenY ?? "",
    registry.contracts.lbRouter,
    amountY?.toString() ?? "",
    walletAllowanceY?.toString() ?? "",
    needsYApproval ? "approval-required" : "approval-not-required"
  ].join("|");
  const latestApproveXExecutionFingerprint = useRef(approveXExecutionFingerprint);
  latestApproveXExecutionFingerprint.current = approveXExecutionFingerprint;
  const latestApproveYExecutionFingerprint = useRef(approveYExecutionFingerprint);
  latestApproveYExecutionFingerprint.current = approveYExecutionFingerprint;
  const walletPositionsQuery = useQuery({
    queryKey: ["liquidityPositions", registry.chainId, account.address, pool?.pair],
    queryFn: async () => {
      if (!account.address || !pool) {
        throw new Error("Wallet positions are not available");
      }

      return loadPaginatedPositionsForOwnerPair(registry, account.address, pool.pair);
    },
    enabled: rpcReady && connected && pool !== null && registry.endpoints.indexerUrl !== null,
    refetchInterval: rpcReady && connected && registry.endpoints.indexerUrl !== null ? 10_000 : false
  });
  const walletPositions = walletPositionsQuery.data?.rows ?? [];
  const walletPositionsPageInfo = walletPositionsQuery.data?.pageInfo ?? null;
  const portfolioExitRequested = portfolioAction === "partial" || portfolioAction === "full";
  const portfolioIntentQuery = useQuery({
    queryKey: ["liquidityPortfolioIntent", registry.chainId, portfolioEndpoint, account.address, pool?.pair],
    queryFn: async () => {
      if (!account.address || !portfolioEndpoint) throw new Error("Portfolio exit intent is unavailable");
      return loadWalletPortfolio(portfolioEndpoint, account.address);
    },
    enabled: portfolioExitRequested && connected && !onWrongChain && pool !== null && portfolioEndpoint !== null,
    refetchInterval: portfolioExitRequested && connected && !onWrongChain && pool !== null && portfolioEndpoint !== null ? 10_000 : false,
    retry: false
  });
  const selectedPositionIdSet = useMemo(() => new Set(selectedPositionIds), [selectedPositionIds]);
  const selectedPositions = useMemo(
    () => walletPositions.filter((position) => selectedPositionIdSet.has(position.id)),
    [selectedPositionIdSet, walletPositions]
  );
  const selectedPositionsKey = useMemo(() => positionSelectionKey(selectedPositions), [selectedPositions]);
  const lbApprovalExecutionFingerprint = [
    account.address ?? "",
    pool?.pair ?? "",
    registry.chain.id.toString(),
    activeWalletChainId?.toString() ?? "",
    registry.contracts.lbRouter,
    selectedPositionsKey,
    liveLbApproved ? "approval-not-required" : "approval-required"
  ].join("|");
  const lbApprovalFormFingerprint = [
    account.address ?? "",
    pool?.pair ?? "",
    registry.chain.id.toString(),
    activeWalletChainId?.toString() ?? "",
    registry.contracts.lbRouter,
    selectedPositionsKey
  ].join("|");
  const latestLbApprovalExecutionFingerprint = useRef(lbApprovalExecutionFingerprint);
  latestLbApprovalExecutionFingerprint.current = lbApprovalExecutionFingerprint;
  const removeExecutionContextFingerprint = burnExecutionContextFingerprint({
    account: account.address ?? null,
    assetMode: effectiveRemoveAssetMode,
    binStep: pool?.binStep ?? null,
    burnBps: removePercentBps?.toString() ?? null,
    deadlineMinutes,
    environment: environmentKey,
    mode: "remove",
    pair: pool?.pair ?? null,
    registryChainId: registry.chainId,
    router: registry.contracts.lbRouter,
    selectedAssetMode: removeAssetMode,
    selectedPositionsKey,
    slippageBps: slippageBps?.toString() ?? null,
    tokenX: pool?.tokenX ?? null,
    tokenY: pool?.tokenY ?? null,
    transactionValue: "0",
    walletChainId: activeWalletChainId,
    wrappedNative: removeWrappedNative?.address ?? null,
    wrappedNativeSide: removeWrappedNativeSide
  });
  const latestRemoveExecutionContextFingerprint = useRef(removeExecutionContextFingerprint);
  latestRemoveExecutionContextFingerprint.current = removeExecutionContextFingerprint;
  const removeReviewFingerprint = [
    account.address ?? "",
    pool?.pair ?? "",
    registry.chainId.toString(),
    activeWalletChainId?.toString() ?? "",
    removePercentBps?.toString() ?? "invalid",
    slippageBps?.toString() ?? "invalid",
    deadlineMinutes?.toString() ?? "invalid",
    [...selectedPositionIds].sort().join(",")
  ].join("|");
  const readSelectedBurnSnapshot = async (
    positions: readonly PositionRow[],
    requestedBlockNumber: bigint | null = null
  ): Promise<LiveBurnSnapshot> => {
    if (!account.address || !pool || positions.length === 0) {
      throw new Error("Selected position burn snapshot is not available");
    }

    const owner = account.address;
    const blockNumber = requestedBlockNumber ?? await publicClient.getBlockNumber();
    const rows = await Promise.all(
      positions.map(async (position) => {
        const binId = BigInt(position.binId);
        const [liveBalance, [reserveX, reserveY], totalSupply] = await Promise.all([
          publicClient.readContract({
            address: pool.pair,
            abi: lbPairAbi,
            functionName: "balanceOf",
            args: [owner, binId],
            blockNumber
          }),
          publicClient.readContract({
            address: pool.pair,
            abi: lbPairAbi,
            functionName: "getBin",
            args: [Number(binId)],
            blockNumber
          }),
          publicClient.readContract({
            address: pool.pair,
            abi: lbPairAbi,
            functionName: "totalSupply",
            args: [binId],
            blockNumber
          })
        ]);

        return {
          balance: { binId: position.binId, balance: liveBalance.toString() },
          binState: {
            binId: binId.toString(),
            reserveX: reserveX.toString(),
            reserveY: reserveY.toString(),
            totalSupply: totalSupply.toString()
          }
        };
      })
    );

    return {
      balances: rows.map((row) => row.balance),
      binStates: rows.map((row) => row.binState),
      blockNumber
    };
  };
  const readRpcBlockHash = async (blockNumber: bigint): Promise<string> => {
    const block = await publicClient.request({
      method: "eth_getBlockByNumber",
      params: [`0x${blockNumber.toString(16)}`, false]
    });
    const hash = (block as { hash?: string } | null)?.hash;
    if (!hash) throw new Error(`RPC block ${blockNumber.toString()} has no hash`);
    return hash.toLowerCase();
  };
  const readRpcHeadBlockNumber = async (): Promise<bigint> => {
    const blockNumber = await publicClient.request({ method: "eth_blockNumber" });
    return BigInt(blockNumber);
  };
  const selectedBurnSnapshotQuery = useQuery({
    queryKey: ["liquiditySelectedBurnSnapshot", registry.chainId, account.address, pool?.pair, selectedPositionsKey],
    queryFn: () => readSelectedBurnSnapshot(selectedPositions),
    enabled: rpcReady && connected && pool !== null && selectedPositions.length > 0,
    refetchInterval: rpcReady && connected && pool !== null && selectedPositions.length > 0 ? 10_000 : false
  });
  const positionBurnFreshness = {
    indexerStale: snapshot?.indexer.status === "stale",
    liveReadError: selectedBurnSnapshotQuery.isError,
    liveReadLoading: selectedBurnSnapshotQuery.isLoading,
    positionDataCapped: walletPositionsPageInfo?.capped === true,
    positionDataPartial: walletPositionsPageInfo?.failed === true || walletPositionsQuery.isError
  };
  const removeDataFreshnessIssue =
    indexerSubmissionFreshnessError(snapshot, snapshotQueryErrored) ??
    ownerPositionPaginationError(walletPositionsQuery.data, walletPositionsQuery.isError) ??
    portfolioExitIntentError({
      action: portfolioAction,
      owner: account.address ?? null,
      pair: pool?.pair ?? null,
      portfolio: portfolioIntentQuery.data,
      portfolioQueryError: portfolioIntentQuery.isError,
      portfolioQueryLoading: portfolioIntentQuery.isLoading,
      positions: walletPositionsQuery.data,
      removePercentBps,
      selectedPositions,
      snapshot
    });
  const latestRemoveDataFreshnessIssue = useRef(removeDataFreshnessIssue);
  latestRemoveDataFreshnessIssue.current = removeDataFreshnessIssue;
  const refreshPositionSubmissionPreflight = async (): Promise<{ snapshot: AppSnapshot; positions: PaginatedRows<PositionRow> }> => {
    const [snapshotResult, positionsResult] = await Promise.all([
      onRefresh(),
      walletPositionsQuery.refetch({ cancelRefetch: true })
    ]);
    if (snapshotResult.isError || snapshotResult.error || !snapshotResult.data) {
      throw snapshotResult.error ?? new Error("indexer freshness snapshot unavailable");
    }
    if (positionsResult.isError || positionsResult.error || !positionsResult.data) {
      throw positionsResult.error ?? new Error("owner position pagination unavailable");
    }

    return { snapshot: snapshotResult.data, positions: positionsResult.data };
  };
  const removeBurnPlan = buildPositionBurnPlan({
    burnBps: removePercentBps,
    freshness: positionBurnFreshness,
    liveBalancesByBin: selectedBurnSnapshotQuery.data?.balances ?? [],
    selectedPositions
  });
  const removeBurnQuoteView = buildBurnQuoteView(removeBurnPlan, selectedBurnSnapshotQuery.data?.binStates ?? null, slippageBps);
  const removeBurnQuoteExecutionFingerprint = buildBurnQuoteExecutionFingerprint(
    selectedBurnSnapshotQuery.data ?? null,
    removeBurnPlan,
    removeBurnQuoteView
  );
  const latestRemoveBurnQuoteExecutionFingerprint = useRef(removeBurnQuoteExecutionFingerprint);
  latestRemoveBurnQuoteExecutionFingerprint.current = removeBurnQuoteExecutionFingerprint;
  const selectedIndexedLiquidityTotal = sumPositionLiquidity(selectedPositions);
  const selectedLiveBalanceTotal = selectedBurnSnapshotQuery.data ? sumLiveBalanceRows(selectedBurnSnapshotQuery.data.balances) : null;
  const removeAmount = removeBurnPlan.blocked ? null : sumBigints(removeBurnPlan.amounts);
  const liveBalanceBelowIndexed = removeBurnPlan.warnings.length > 0;
  const hasSelectedPositions = selectedPositions.length > 0;
  const selectedBinSummary =
    selectedPositions.length === 0
      ? "n/a"
      : selectedPositions.length === 1
        ? `Bin ${selectedPositions[0].binId}`
        : `${selectedPositions.length} bins`;
  const selectedBinIds = selectedPositions.map((position) => BigInt(position.binId)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const selectedMinBin = selectedBinIds.at(0) ?? null;
  const selectedMaxBin = selectedBinIds.at(-1) ?? null;
  const selectedCoversAllWalletBins =
    walletPositions.length > 0 &&
    selectedPositions.length === walletPositions.length &&
    walletPositions.every((position) => selectedPositionIdSet.has(position.id));
  const selectedRangeStatus =
    activeBin === null || selectedMinBin === null || selectedMaxBin === null
      ? "range unavailable"
      : BigInt(activeBin) >= selectedMinBin && BigInt(activeBin) <= selectedMaxBin
        ? "in range"
        : "out of range";
  const removePercentValue = removePercentBps === null ? 0 : Number(removePercentBps) / 100;
  const currentFullExitWorkflowKey = account.address && pool
    ? createFullExitWorkflowKey({
        account: account.address,
        chainId: registry.chainId,
        deploymentEpoch: deploymentEpoch(registry),
        environment: environmentKey,
        pair: pool.pair,
        recipient: account.address,
        router: registry.contracts.lbRouter
      })
    : null;
  const currentFullExitRecords = currentFullExitWorkflowKey === null
    ? []
    : transactionJournal.records.filter((record) =>
        fullExitSettingsForRecord(record)?.workflowKey === currentFullExitWorkflowKey
      );
  const currentRemoveFamilyConflict = account.address && pool
    ? transactionJournal.records.find((record) =>
        record.reviewed.intent === "remove-liquidity" &&
        record.reviewed.account.toLowerCase() === account.address!.toLowerCase() &&
        record.reviewed.chainId === registry.chainId &&
        record.reviewed.environment === environmentKey &&
        record.reviewed.deploymentEpoch === deploymentEpoch(registry) &&
        record.reviewed.poolId?.toLowerCase() === pool.pair.toLowerCase() &&
        record.reviewed.target.toLowerCase() === registry.contracts.lbRouter.toLowerCase() &&
        transactionRecordBlocksIntentFamily(record)
      ) ?? null
    : null;
  const fullExitHasHistory = currentFullExitRecords.length > 0;
  const fullExit = removePercentBps === 10_000n && selectedCoversAllWalletBins && (
    explicitFullExitRequested ||
    portfolioAction === "full"
  );
  useEffect(() => {
    if (fullExitUi === null || fullExitUi.status === "complete" || fullExitUi.workflowKey !== currentFullExitWorkflowKey) return;
    const finalized = currentFullExitRecords
      .filter((record) => fullExitJournalDisposition(record).countsCompletedBatch)
      .sort((left, right) => right.createdAt - left.createdAt);
    const latest = finalized[0];
    if (!latest) return;
    const settings = fullExitSettingsForRecord(latest);
    if (!settings || settings.batchOrdinal < fullExitUi.batchOrdinal) return;
    const completedBatches = new Set(finalized.map((record) => fullExitSettingsForRecord(record)?.batchOrdinal).filter((value) => value !== undefined)).size;
    if (fullExitUi.status === "idle" && fullExitUi.completedBatches === completedBatches) return;
    setFullExitUi((current) => current === null ? null : {
      ...current,
      completedBatches,
      message: `Batch ${settings.batchOrdinal} reached ${TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS}-confirmation finality. Resume explicitly to re-enumerate all live owner bins before the next transaction or completion check.`,
      status: "idle"
    });
  }, [currentFullExitRecords, currentFullExitWorkflowKey, fullExitUi]);
  const removeBurnPlanIssue = positionBurnSubmissionError(removeBurnPlan);
  const addInputError =
    rangeControlError ??
    distributionResult.error ??
    (liquidityMode !== "token-y" && parsedAmountXResult.error !== null
      ? tokenAmountErrorMessage(parsedAmountXResult.error, tokenX?.decimals ?? 18)
      : liquidityMode !== "token-x" && parsedAmountYResult.error !== null
        ? tokenAmountErrorMessage(parsedAmountYResult.error, tokenY?.decimals ?? 18)
      : amountX === null
        ? "Enter a valid X amount"
        : amountY === null
          ? "Enter a valid Y amount"
        : liquidityMode === "token-x" && amountX <= 0n
          ? "Enter a positive token X amount for this above-active one-sided range"
          : liquidityMode === "token-y" && amountY <= 0n
            ? "Enter a positive token Y amount for this below-active one-sided range"
            : liquidityMode === "balanced" && (amountX <= 0n || amountY <= 0n)
              ? "Enter positive amounts for both tokens when the range includes the active bin"
          : slippageBps === null
            ? "Enter slippage between 0% and 100%"
            : slippageBps > DANGEROUS_SLIPPAGE_BPS
              ? "Slippage exceeds 10% safety limit"
              : idSlippageError !== null
                ? idSlippageError
                : deadlineMinutes === null
                  ? "Enter a deadline from 1 to 120 minutes"
                  : !selectedPool.ready
                    ? poolDescriptorError(selectedPool)
                    : null);
  const removeInputError =
    removePercentBps === null || removePercentBps <= 0n
      ? "Enter a remove percent from 0% to 100%"
      : slippageBps === null
        ? "Enter slippage between 0% and 100%"
      : slippageBps > DANGEROUS_SLIPPAGE_BPS
        ? "Slippage exceeds 10% safety limit"
        : deadlineMinutes === null
          ? "Enter a deadline from 1 to 120 minutes"
          : currentRemoveFamilyConflict !== null
            ? `A prior withdrawal is ${currentRemoveFamilyConflict.status} at ${currentRemoveFamilyConflict.confirmations}/${TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS} confirmations; no sibling partial or full exit may start before finality`
          : removeDataFreshnessIssue ??
            (!removeSelectedPool.ready
              ? poolDescriptorError(removeSelectedPool)
              : removeBurnPlanIssue ??
              (selectedBurnSnapshotQuery.isError
                ? `Burn output quote failed: ${getWriteError(selectedBurnSnapshotQuery.error) ?? "pinned burn snapshot unavailable"}`
                : selectedBurnSnapshotQuery.isLoading
                  ? "Burn output quote is loading"
                  : removeBurnQuoteView.error));
  const approveXSuccess = submittedApproveXReceiptContext === approveXExecutionFingerprint && approveXReceipt.data?.status === "success";
  const approveYSuccess = submittedApproveYReceiptContext === approveYExecutionFingerprint && approveYReceipt.data?.status === "success";
  const approveLbSuccess = submittedLbApprovalReceiptContext === lbApprovalFormFingerprint && approveLbReceipt.data?.status === "success";
  const addSuccess = submittedAddReceiptContext === addExecutionFingerprint && addReceipt.data?.status === "success";
  const nativeAddAccountingRequired = submittedLiquidityAddReview?.review.assetMode === "native" && submittedLiquidityAddReview.executionFingerprint === submittedAddReceiptContext;
  const addSuccessReconciled = addSuccess && (!nativeAddAccountingRequired || addReceiptReconciliationQuery.data !== undefined);
  const removeSuccess = removeReceipt.data?.status === "success";
  const approveXReverted = submittedApproveXReceiptContext === approveXExecutionFingerprint && (approveXReceipt.data?.status === "reverted" || isRevertedReceiptError(approveXReceipt.error));
  const approveYReverted = submittedApproveYReceiptContext === approveYExecutionFingerprint && (approveYReceipt.data?.status === "reverted" || isRevertedReceiptError(approveYReceipt.error));
  const approveLbReverted = submittedLbApprovalReceiptContext === lbApprovalFormFingerprint && (approveLbReceipt.data?.status === "reverted" || isRevertedReceiptError(approveLbReceipt.error));
  const addReverted = submittedAddReceiptContext === addExecutionFingerprint && (addReceipt.data?.status === "reverted" || isRevertedReceiptError(addReceipt.error));
  const removeReverted = removeReceipt.data?.status === "reverted" || isRevertedReceiptError(removeReceipt.error);
  const removeReceiptMatchesCurrentIntent =
    liquidityReceiptPhase === "remove" && submittedRemoveReceiptContext === liquidityLifecycleKey;
  const nativeRemoveAccountingRequired = submittedNativeRemoveReview !== null && removeReceiptMatchesCurrentIntent;
  const currentRemoveOrphaned = currentRemoveFamilyConflict?.status === "orphaned";
  const currentRemoveSuccess = removeReceiptMatchesCurrentIntent && removeSuccess && !currentRemoveOrphaned && (!nativeRemoveAccountingRequired || nativeRemoveReceiptReconciliationQuery.data !== undefined);
  const currentRemoveReverted = removeReceiptMatchesCurrentIntent && removeReverted;
  const currentLbApprovalSuccess = liquidityReceiptPhase === "lb-approval" && approveLbSuccess;
  const currentLbApprovalReverted = liquidityReceiptPhase === "lb-approval" && approveLbReverted;
  const liquidityActionError =
    liquiditySimulationError ??
    gasReviewError ??
    (submittedApproveXReceiptContext === approveXExecutionFingerprint ? getWriteError(approveXWrite.error) : null) ??
    (submittedApproveYReceiptContext === approveYExecutionFingerprint ? getWriteError(approveYWrite.error) : null) ??
    (submittedLbApprovalReceiptContext === lbApprovalFormFingerprint ? getWriteError(approveLbWrite.error) : null) ??
    (submittedAddReceiptContext === addExecutionFingerprint ? getWriteError(addWrite.error) : null) ??
    (removeReceiptMatchesCurrentIntent ? getWriteError(removeWrite.error) : null) ??
    (submittedApproveXReceiptContext === approveXExecutionFingerprint ? getWriteError(approveXReceipt.error) : null) ??
    (submittedApproveYReceiptContext === approveYExecutionFingerprint ? getWriteError(approveYReceipt.error) : null) ??
    (submittedLbApprovalReceiptContext === lbApprovalFormFingerprint ? getWriteError(approveLbReceipt.error) : null) ??
    (submittedAddReceiptContext === addExecutionFingerprint ? getWriteError(addReceipt.error) : null) ??
    (removeReceiptMatchesCurrentIntent ? getWriteError(removeReceipt.error) : null);
  const addPoolReady = selectedPool.ready && pool !== null;
  const removePoolReady = removeSelectedPool.ready && pool !== null;
  const addReady =
    addPoolReady &&
    connected &&
    !onWrongChain &&
    amountX !== null &&
    amountY !== null &&
    slippageBps !== null &&
    idSlippage !== null &&
    deadlineMinutes !== null &&
    distributionResult.distribution !== null &&
    addInputError === null &&
    walletReadsReady &&
    liquiditySimulationError === null &&
    !liquiditySimulationPending &&
    !needsXApproval &&
    !needsYApproval &&
    !insufficientX &&
    !insufficientY &&
    liquidityAttestationQuery.data !== undefined &&
    liquidityAttestationQuery.error === null &&
    !addWrite.isPending &&
    !addReceipt.isLoading;
  const addButtonLabel = liquidityButtonLabel({
    poolReady: addPoolReady,
    connected,
    onWrongChain,
    walletReadsReady,
    walletReadErrored: walletQuery.isError,
    invalidInput: addInputError !== null,
    needsApproval: needsXApproval || needsYApproval,
    insufficientBalance: insufficientX || insufficientY,
    insufficientGas: liquiditySimulationError?.startsWith("Insufficient ETH for gas") === true,
    ready: distributionResult.distribution !== null
  });
  const removeReady =
    removePoolReady &&
    connected &&
    !onWrongChain &&
    hasSelectedPositions &&
    removeAmount !== null &&
    removeAmount > 0n &&
    removeBurnQuoteView.quote !== null &&
    removeBurnQuoteView.minimums !== null &&
    deadlineMinutes !== null &&
    removeInputError === null &&
    liquidityExitAttestationQuery.data !== undefined &&
    liquidityExitAttestationQuery.error === null &&
    liveLbApproved &&
    !removeBurnPlan.blocked &&
    (liquiditySimulationError === null || liquiditySimulationError.startsWith("Simulation failed:")) &&
    !liquiditySimulationPending &&
    !removeWrite.isPending &&
    !removeReceipt.isLoading;
  const canApproveX =
    addPoolReady &&
    connected &&
    !onWrongChain &&
    needsXApproval &&
    addInputError === null &&
    !insufficientX &&
    liquidityAttestationQuery.data !== undefined &&
    liquidityAttestationQuery.error === null &&
    liquiditySimulationError === null &&
    !liquiditySimulationPending &&
    !approveXWrite.isPending &&
    !approveXReceipt.isLoading;
  const canApproveY =
    addPoolReady &&
    connected &&
    !onWrongChain &&
    needsYApproval &&
    addInputError === null &&
    !insufficientY &&
    liquidityAttestationQuery.data !== undefined &&
    liquidityAttestationQuery.error === null &&
    liquiditySimulationError === null &&
    !liquiditySimulationPending &&
    !approveYWrite.isPending &&
    !approveYReceipt.isLoading;
  const canApproveLb =
    removePoolReady &&
    connected &&
    !onWrongChain &&
    hasSelectedPositions &&
    !liveLbApproved &&
    lbApprovalState !== "unavailable" &&
    removeInputError === null &&
    liquidityExitAttestationQuery.data !== undefined &&
    liquidityExitAttestationQuery.error === null &&
    liquiditySimulationError === null &&
    !liquiditySimulationPending &&
    !approveLbWrite.isPending &&
    !approveLbReceipt.isLoading;
  useEffect(() => {
    intentionalEmptySelectionRef.current = false;
  }, [account.address, pool?.pair, registry.chainId]);

  useEffect(() => {
    const generation = liquidityOperationGenerationRef.current + 1;
    liquidityOperationGenerationRef.current = generation;
    approveXSubmitInFlightRef.current = null;
    approveYSubmitInFlightRef.current = null;
    approveLbSubmitInFlightRef.current = null;
    addSubmitInFlightRef.current = null;
    removeSubmitInFlightRef.current = null;
    setLiquiditySimulationPending(false);

    return () => {
      if (liquidityOperationGenerationRef.current === generation) {
        liquidityOperationGenerationRef.current = generation + 1;
      }
      approveXSubmitInFlightRef.current = null;
      approveYSubmitInFlightRef.current = null;
      approveLbSubmitInFlightRef.current = null;
      addSubmitInFlightRef.current = null;
      removeSubmitInFlightRef.current = null;
    };
  }, [liquidityLifecycleKey]);

  useEffect(() => {
    if (approveXSubmitInFlightRef.current === null) return;

    if (approveXWrite.error || approveXWrite.data || approveXReceipt.data || approveXReceipt.error) {
      approveXSubmitInFlightRef.current = null;
    }
  }, [approveXReceipt.data, approveXReceipt.error, approveXWrite.data, approveXWrite.error]);

  useEffect(() => {
    if (approveYSubmitInFlightRef.current === null) return;

    if (approveYWrite.error || approveYWrite.data || approveYReceipt.data || approveYReceipt.error) {
      approveYSubmitInFlightRef.current = null;
    }
  }, [approveYReceipt.data, approveYReceipt.error, approveYWrite.data, approveYWrite.error]);

  useEffect(() => {
    setLiquidityReceiptPhase("idle");
    setSubmittedRemoveReceiptContext(null);
    setSubmittedNativeRemoveReview(null);
    setNativeRemoveOrphanNotice(null);
    setSubmittedFullExitHash(null);
    setFullExitUi((current) => current !== null && current.workflowKey === currentFullExitWorkflowKey ? current : null);
    setFullExitBatchReview((current) => current !== null && current.workflowKey === currentFullExitWorkflowKey ? current : null);
    setExplicitFullExitRequested(portfolioAction === "full");
  }, [account.address, activeWalletChainId, currentFullExitWorkflowKey, environmentKey, initialSection, pool?.pair, portfolioAction, selectedPoolId]);

  useEffect(() => {
    if (approveLbSubmitInFlightRef.current === null) return;

    if (approveLbWrite.error || approveLbWrite.data || approveLbReceipt.data || approveLbReceipt.error) {
      approveLbSubmitInFlightRef.current = null;
    }
  }, [approveLbReceipt.data, approveLbReceipt.error, approveLbWrite.data, approveLbWrite.error]);

  useEffect(() => {
    if (removeSubmitInFlightRef.current === null) return;

    if (removeWrite.error || removeReceipt.data || removeReceipt.error) {
      removeSubmitInFlightRef.current = null;
      setLiquiditySimulationPending(false);
    }
  }, [removeReceipt.data, removeReceipt.error, removeWrite.error]);

  useEffect(() => {
    if (addSubmitInFlightRef.current === null) return;

    if (addWrite.error || addWrite.data || addReceipt.data || addReceipt.error) {
      addSubmitInFlightRef.current = null;
    }
  }, [addReceipt.data, addReceipt.error, addWrite.data, addWrite.error]);

  useEffect(() => {
    const prefillKey = `${portfolioAction ?? "none"}:${pool?.pair ?? "none"}:${walletPositions.map((position) => position.id).join("|")}`;
    if ((portfolioAction === "partial" || portfolioAction === "full") && walletPositions.length > 0 && portfolioPrefillKeyRef.current !== prefillKey) {
      portfolioPrefillKeyRef.current = prefillKey;
      intentionalEmptySelectionRef.current = false;
      setExplicitFullExitRequested(portfolioAction === "full");
      setRemovePercentInput(portfolioAction === "partial" ? "50" : "100");
      setSelectedPositionIds(walletPositions.map((position) => position.id));
      return;
    }
    setSelectedPositionIds((currentIds) => {
      if (walletPositions.length === 0) {
        if (walletPositionsQuery.isLoading || walletPositionsQuery.isFetching) return currentIds;
        return currentIds.length === 0 ? currentIds : [];
      }

      const availableIds = new Set(walletPositions.map((position) => position.id));
      const nextIds = currentIds.filter((positionId) => availableIds.has(positionId));
      if (nextIds.length === 0) {
        if (intentionalEmptySelectionRef.current) {
          return currentIds.length === 0 ? currentIds : [];
        }

        return [walletPositions[0].id];
      }

      intentionalEmptySelectionRef.current = false;

      return sameStringArray(currentIds, nextIds) ? currentIds : nextIds;
    });
  }, [pool?.pair, portfolioAction, walletPositions, walletPositionsQuery.isFetching, walletPositionsQuery.isLoading]);

  useEffect(() => {
    setLiquiditySimulationError(null);
    setGasReviewError(null);
    setGasReview(null);
    setLiquidityReviewNotice(null);
    setRemoveQuoteReviewRequired(null);
    setFullExitBatchReview(null);
  }, [
    account.address,
    amountXInput,
    amountYInput,
    deadlineInput,
    environmentKey,
    idSlippageInput,
    lowerDeltaInput,
    liquidityStrategy,
    pool?.pair,
    removePercentInput,
    selectedPositionsKey,
    slippageInput,
    upperDeltaInput
  ]);

  useEffect(() => {
    if (approveXSuccess && approveXWrite.data && approveXWrite.data !== handledApproveXHash) {
      void walletQuery.refetch();
      setHandledApproveXHash(approveXWrite.data);
    }

    if (approveYSuccess && approveYWrite.data && approveYWrite.data !== handledApproveYHash) {
      void walletQuery.refetch();
      setHandledApproveYHash(approveYWrite.data);
    }

    if (approveLbSuccess && approveLbWrite.data && approveLbWrite.data !== handledLbApprovalHash) {
      if (currentLbApprovalGrant !== null) {
        setLbApprovalObservation({ ...currentLbApprovalGrant, approved: true });
        setObservedApprovedLbGrants((current) => rememberLbApprovalGrant(current, currentLbApprovalGrant));
      }
      void walletQuery.refetch();
      setHandledLbApprovalHash(approveLbWrite.data);
    }

    if (addSuccess && addWrite.data && addWrite.data !== handledAddHash) {
      void walletQuery.refetch();
      void walletPositionsQuery.refetch();
      void selectedBurnSnapshotQuery.refetch();
      onRefresh();
      setHandledAddHash(addWrite.data);
    }

    if (removeSuccess && removeWrite.data && removeWrite.data !== handledRemoveHash) {
      void walletQuery.refetch();
      void walletPositionsQuery.refetch();
      void selectedBurnSnapshotQuery.refetch();
      onRefresh();
      if (submittedFullExitHash === removeWrite.data) {
        setFullExitUi((current) => current === null ? null : {
          ...current,
          message: `Batch ${current.batchOrdinal} mined successfully but is not final. Wait for ${TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS} confirmations, then resume to re-enumerate live bins.`,
          status: "awaiting-finality"
        });
      }
      setHandledRemoveHash(removeWrite.data);
    }

  }, [
    addSuccess,
    addWrite.data,
    approveLbSuccess,
    approveLbWrite.data,
    approveXSuccess,
    approveXWrite.data,
    approveYSuccess,
    approveYWrite.data,
    currentLbApprovalGrant,
    handledAddHash,
    handledApproveXHash,
    handledApproveYHash,
    handledLbApprovalHash,
    handledRemoveHash,
    onRefresh,
    removeSuccess,
    removeWrite.data,
    submittedFullExitHash,
    selectedBurnSnapshotQuery,
    walletPositionsQuery,
    walletQuery
  ]);

  const handleApproveX = async () => {
    if (approveXSubmitInFlightRef.current !== null || !canApproveX || !pool || !account.address || amountX === null) return;

    const submittedOperationGeneration = liquidityOperationGenerationRef.current;
    const submittedExecutionFingerprint = approveXExecutionFingerprint;
    const token = pool.tokenX;
    const args = [registry.contracts.lbRouter, amountX] as const;
    approveXSubmitInFlightRef.current = submittedOperationGeneration;
    approveXWrite.reset();
    setSubmittedApproveXReceiptContext(null);
    setGasReviewError(null);
    const operationIsCurrent = () =>
      liquidityOperationGenerationRef.current === submittedOperationGeneration &&
      approveXSubmitInFlightRef.current === submittedOperationGeneration;
    let submitted = false;
    try {
      try {
        await attestLiquidityPair("add-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      try {
        assertExecutableTokenAction([tokenX], "add-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      const simulated = await runPreSubmitSimulation(
        () =>
          publicClient.simulateContract({
            account: account.address,
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args
          }),
        setLiquiditySimulationError,
        setLiquiditySimulationPending,
        operationIsCurrent
      );

      if (!simulated) return;
      if (simulated.result !== true) {
        setLiquiditySimulationError("Approval simulation did not return true; this token is excluded");
        return;
      }
      if (liquidityOperationGenerationRef.current !== submittedOperationGeneration) return;
      if (latestApproveXExecutionFingerprint.current !== submittedExecutionFingerprint) {
        setLiquiditySimulationError("Token X approval context, amount, strategy, range, or composition changed during simulation; review the current approval and try again");
        return;
      }
      const gasReviewIsCurrent = () =>
        operationIsCurrent() &&
        latestApproveXExecutionFingerprint.current === submittedExecutionFingerprint;
      const gasApproved = await reviewExactGas({
        action: `${tokenSymbol(tokenX)} approval`,
        currentReview: gasReview,
        estimateGas: () => publicClient.estimateContractGas(simulated.request),
        executionFingerprint: submittedExecutionFingerprint,
        getBalance: () => publicClient.getBalance({ address: account.address }),
        getGasPrice: () => publicClient.getGasPrice(),
        isCurrent: gasReviewIsCurrent,
        setError: setGasReviewError,
        setReview: setGasReview
      });
      if (!gasApproved || !gasReviewIsCurrent()) return;
      try {
        await attestLiquidityPair("add-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      const submittedContext = {
        account: account.address,
        calldataFingerprint: keccak256(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args })),
        chainId: activeWalletChainId,
        deploymentEpoch: deploymentEpoch(registry),
        environment: environmentKey,
        executionFingerprint: submittedExecutionFingerprint,
        intent: "approval" as const,
        providerId: account.connector?.id ?? "unknown",
        providerUid: account.connector?.uid ?? "unknown",
        submittedAt: Date.now(),
        target: token,
        value: 0n
      };
      try {
        setSubmittedApproveXReceiptContext(submittedExecutionFingerprint);
        const hash = await submitJournaledTransaction({
          isCurrent: gasReviewIsCurrent,
          journal: transactionJournal,
          reviewed: reviewedTransactionIntent(submittedContext, {
            poolId: pool.pair,
            recipient: null,
            refundRecipient: null,
            settingsFingerprint: [account.address, activeWalletChainId, token, registry.contracts.lbRouter, amountX.toString()].join("|")
          }),
          preWalletGuard: async () => {
            await attestLiquidityPair("add-liquidity");
            if (!gasReviewIsCurrent()) throw new PairAttestationError("context-changed", "Liquidity context changed during final pair attestation");
          },
          send: () => approveXWrite.writeContractAsync(simulated.request)
        });
        submitted = hash !== null;
      } catch (error) {
        if (!isUserRejectedSubmission(error)) setLiquiditySimulationError(getWriteError(error) ?? "Transaction journal blocked token approval submission");
        // The wagmi mutation retains the rejection for the originating mounted session.
      }
    } finally {
      if (!submitted && approveXSubmitInFlightRef.current === submittedOperationGeneration) {
        approveXSubmitInFlightRef.current = null;
      }
    }
  };

  const handleApproveY = async () => {
    if (approveYSubmitInFlightRef.current !== null || !canApproveY || !pool || !account.address || amountY === null) return;

    const submittedOperationGeneration = liquidityOperationGenerationRef.current;
    const submittedExecutionFingerprint = approveYExecutionFingerprint;
    const token = pool.tokenY;
    const args = [registry.contracts.lbRouter, amountY] as const;
    approveYSubmitInFlightRef.current = submittedOperationGeneration;
    approveYWrite.reset();
    setSubmittedApproveYReceiptContext(null);
    setGasReviewError(null);
    const operationIsCurrent = () =>
      liquidityOperationGenerationRef.current === submittedOperationGeneration &&
      approveYSubmitInFlightRef.current === submittedOperationGeneration;
    let submitted = false;
    try {
      try {
        await attestLiquidityPair("add-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      try {
        assertExecutableTokenAction([tokenY], "add-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      const simulated = await runPreSubmitSimulation(
        () =>
          publicClient.simulateContract({
            account: account.address,
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args
          }),
        setLiquiditySimulationError,
        setLiquiditySimulationPending,
        operationIsCurrent
      );

      if (!simulated) return;
      if (simulated.result !== true) {
        setLiquiditySimulationError("Approval simulation did not return true; this token is excluded");
        return;
      }
      if (liquidityOperationGenerationRef.current !== submittedOperationGeneration) return;
      if (latestApproveYExecutionFingerprint.current !== submittedExecutionFingerprint) {
        setLiquiditySimulationError("Token Y approval context, amount, strategy, range, or composition changed during simulation; review the current approval and try again");
        return;
      }
      const gasReviewIsCurrent = () =>
        operationIsCurrent() &&
        latestApproveYExecutionFingerprint.current === submittedExecutionFingerprint;
      const gasApproved = await reviewExactGas({
        action: `${tokenSymbol(tokenY)} approval`,
        currentReview: gasReview,
        estimateGas: () => publicClient.estimateContractGas(simulated.request),
        executionFingerprint: submittedExecutionFingerprint,
        getBalance: () => publicClient.getBalance({ address: account.address }),
        getGasPrice: () => publicClient.getGasPrice(),
        isCurrent: gasReviewIsCurrent,
        setError: setGasReviewError,
        setReview: setGasReview
      });
      if (!gasApproved || !gasReviewIsCurrent()) return;
      try {
        await attestLiquidityPair("add-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      const submittedContext = {
        account: account.address,
        calldataFingerprint: keccak256(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args })),
        chainId: activeWalletChainId,
        deploymentEpoch: deploymentEpoch(registry),
        environment: environmentKey,
        executionFingerprint: submittedExecutionFingerprint,
        intent: "approval" as const,
        providerId: account.connector?.id ?? "unknown",
        providerUid: account.connector?.uid ?? "unknown",
        submittedAt: Date.now(),
        target: token,
        value: 0n
      };
      try {
        setSubmittedApproveYReceiptContext(submittedExecutionFingerprint);
        const hash = await submitJournaledTransaction({
          isCurrent: gasReviewIsCurrent,
          journal: transactionJournal,
          reviewed: reviewedTransactionIntent(submittedContext, {
            poolId: pool.pair,
            recipient: null,
            refundRecipient: null,
            settingsFingerprint: [account.address, activeWalletChainId, token, registry.contracts.lbRouter, amountY.toString()].join("|")
          }),
          preWalletGuard: async () => {
            await attestLiquidityPair("add-liquidity");
            if (!gasReviewIsCurrent()) throw new PairAttestationError("context-changed", "Liquidity context changed during final pair attestation");
          },
          send: () => approveYWrite.writeContractAsync(simulated.request)
        });
        submitted = hash !== null;
      } catch (error) {
        if (!isUserRejectedSubmission(error)) setLiquiditySimulationError(getWriteError(error) ?? "Transaction journal blocked token approval submission");
        // The wagmi mutation retains the rejection for the originating mounted session.
      }
    } finally {
      if (!submitted && approveYSubmitInFlightRef.current === submittedOperationGeneration) {
        approveYSubmitInFlightRef.current = null;
      }
    }
  };

  const handleApproveLb = async () => {
    if (approveLbSubmitInFlightRef.current !== null || !canApproveLb || !pool || !account.address) return;

    const submittedOperationGeneration = liquidityOperationGenerationRef.current;
    const submittedExecutionFingerprint = lbApprovalExecutionFingerprint;
    const args = [registry.contracts.lbRouter, true] as const;
    approveLbSubmitInFlightRef.current = submittedOperationGeneration;
    approveLbWrite.reset();
    setSubmittedLbApprovalReceiptContext(null);
    setGasReviewError(null);
    setRemoveQuoteReviewRequired(null);
    const operationIsCurrent = () =>
      liquidityOperationGenerationRef.current === submittedOperationGeneration &&
      approveLbSubmitInFlightRef.current === submittedOperationGeneration;
    let submitted = false;
    try {
      try {
        await attestLiquidityPair("remove-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      try {
        if (await readLiveLbApproval()) {
          setLiquiditySimulationError(null);
          setGasReview(null);
          return;
        }
      } catch (error) {
        setLiquiditySimulationError(`Live LB operator approval preflight failed: ${getWriteError(error) ?? "approval state unavailable"}`);
        return;
      }
      setLiquiditySimulationError(null);
      setLiquiditySimulationPending(true);
      let freshPreflight: { snapshot: AppSnapshot; positions: PaginatedRows<PositionRow> };
      try {
        freshPreflight = await refreshPositionSubmissionPreflight();
      } catch (error) {
        if (!operationIsCurrent()) return;
        setLiquiditySimulationError(`Mandatory indexer refresh failed: ${getWriteError(error) ?? "freshness unavailable"}`);
        return;
      } finally {
        if (operationIsCurrent()) setLiquiditySimulationPending(false);
      }
      if (!operationIsCurrent()) return;

      const preflightIssue =
        indexerSubmissionFreshnessError(freshPreflight.snapshot) ?? ownerPositionPaginationError(freshPreflight.positions, false);
      if (preflightIssue !== null) {
        setLiquiditySimulationError(preflightIssue);
        return;
      }
      const freshSelectionKey = positionSelectionKey(
        freshPreflight.positions.rows.filter((position) => selectedPositionIdSet.has(position.id))
      );
      if (freshSelectionKey !== selectedPositionsKey) {
        setLiquiditySimulationError("Indexed position data changed during the mandatory refresh; review the current positions and try again");
        return;
      }

      const simulated = await runPreSubmitSimulation(
        () =>
          publicClient.simulateContract({
            account: account.address,
            address: pool.pair,
            abi: lbPairAbi,
            functionName: "approveForAll",
            args
          }),
        setLiquiditySimulationError,
        setLiquiditySimulationPending,
        operationIsCurrent
      );
      if (!simulated) return;
      if (!operationIsCurrent()) return;

      if (latestLbApprovalExecutionFingerprint.current !== submittedExecutionFingerprint) {
        setLiquiditySimulationError("LB approval context changed during simulation; review the current positions and try again");
        return;
      }

      let postSimulationPreflight: { snapshot: AppSnapshot; positions: PaginatedRows<PositionRow> };
      try {
        postSimulationPreflight = await refreshPositionSubmissionPreflight();
      } catch (error) {
        if (!operationIsCurrent()) return;
        setLiquiditySimulationError(`Mandatory indexer refresh failed: ${getWriteError(error) ?? "freshness unavailable"}`);
        return;
      }
      if (!operationIsCurrent()) return;
      const postSimulationIssue =
        indexerSubmissionFreshnessError(postSimulationPreflight.snapshot) ??
        ownerPositionPaginationError(postSimulationPreflight.positions, false);
      if (postSimulationIssue !== null) {
        setLiquiditySimulationError(postSimulationIssue);
        return;
      }
      const postSimulationSelectionKey = positionSelectionKey(
        postSimulationPreflight.positions.rows.filter((position) => selectedPositionIdSet.has(position.id))
      );
      if (
        latestLbApprovalExecutionFingerprint.current !== submittedExecutionFingerprint ||
        postSimulationSelectionKey !== selectedPositionsKey
      ) {
        setLiquiditySimulationError("LB approval context changed during simulation; review the current positions and try again");
        return;
      }

      try {
        if (await readLiveLbApproval()) {
          setLiquiditySimulationError(null);
          setGasReview(null);
          return;
        }
      } catch (error) {
        setLiquiditySimulationError(`Live LB operator approval recheck failed: ${getWriteError(error) ?? "approval state unavailable"}`);
        return;
      }

      if (!operationIsCurrent()) return;
      const gasReviewIsCurrent = () =>
        operationIsCurrent() &&
        latestLbApprovalExecutionFingerprint.current === submittedExecutionFingerprint;
      const gasApproved = await reviewExactGas({
        action: "LB operator approval",
        currentReview: gasReview,
        estimateGas: () => publicClient.estimateContractGas(simulated.request),
        executionFingerprint: submittedExecutionFingerprint,
        getBalance: () => publicClient.getBalance({ address: account.address }),
        getGasPrice: () => publicClient.getGasPrice(),
        isCurrent: gasReviewIsCurrent,
        setError: setGasReviewError,
        setReview: setGasReview
      });
      if (!gasApproved || !gasReviewIsCurrent()) return;
      try {
        await attestLiquidityPair("remove-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      setLiquidityReceiptPhase("lb-approval");
      setSubmittedLbApprovalReceiptContext(lbApprovalFormFingerprint);
      const submittedContext = {
        account: account.address,
        calldataFingerprint: keccak256(encodeFunctionData({ abi: lbPairAbi, functionName: "approveForAll", args })),
        chainId: activeWalletChainId,
        deploymentEpoch: deploymentEpoch(registry),
        environment: environmentKey,
        executionFingerprint: submittedExecutionFingerprint,
        intent: "approval" as const,
        providerId: account.connector?.id ?? "unknown",
        providerUid: account.connector?.uid ?? "unknown",
        submittedAt: Date.now(),
        target: pool.pair,
        value: 0n
      };
      try {
        const hash = await submitJournaledTransaction({
          isCurrent: gasReviewIsCurrent,
          journal: transactionJournal,
          reviewed: reviewedTransactionIntent(submittedContext, {
            poolId: pool.pair,
            recipient: null,
            refundRecipient: null,
            settingsFingerprint: [account.address, activeWalletChainId, pool.pair, registry.contracts.lbRouter, "true"].join("|")
          }),
          preWalletGuard: async () => {
            await attestLiquidityPair("remove-liquidity");
            if (await readLiveLbApproval()) {
              throw new PairAttestationError("context-changed", "LB operator access is already approved; the redundant approval was not opened in the wallet");
            }
            if (!gasReviewIsCurrent()) throw new PairAttestationError("context-changed", "Withdrawal context changed during final pair attestation");
          },
          send: () => approveLbWrite.writeContractAsync(simulated.request)
        });
        submitted = hash !== null;
      } catch (error) {
        if (error instanceof PairAttestationError && error.message.includes("already approved")) {
          setLiquiditySimulationError(null);
          setGasReview(null);
        } else if (!isUserRejectedSubmission(error)) {
          setLiquiditySimulationError(getWriteError(error) ?? "Transaction journal blocked LB approval submission");
        }
        // The wagmi mutation retains the rejection for the originating mounted session.
      }
    } finally {
      if (!submitted && approveLbSubmitInFlightRef.current === submittedOperationGeneration) {
        approveLbSubmitInFlightRef.current = null;
        setLiquiditySimulationPending(false);
      }
    }
  };

  const handleAddLiquidity = async () => {
    if (addSubmitInFlightRef.current !== null || !addReady || !pool || !account.address || amountX === null || amountY === null || slippageBps === null || idSlippage === null || deadlineMinutes === null || distributionResult.distribution === null || activeBin === null) return;

    const nativeMaxProbeSide = nativeAddMaxProbeRef.current;
    const submittedOperationGeneration = liquidityOperationGenerationRef.current;
    const submittedExecutionFingerprint = addExecutionFingerprint;
    const previousReview = latestLiquidityAddReviewRef.current?.executionFingerprint === submittedExecutionFingerprint
      ? latestLiquidityAddReviewRef.current.review
      : null;
    const parameters = previousReview?.parameters ?? {
        tokenX: pool.tokenX,
        tokenY: pool.tokenY,
        binStep: BigInt(pool.binStep),
        amountX,
        amountY,
        amountXMin: applyLiquiditySlippageMin(amountX, slippageBps),
        amountYMin: applyLiquiditySlippageMin(amountY, slippageBps),
        activeIdDesired: BigInt(activeBin),
        idSlippage: BigInt(idSlippage),
        deltaIds: distributionResult.distribution.deltaIds,
        distributionX: distributionResult.distribution.distributionX,
        distributionY: distributionResult.distribution.distributionY,
        to: account.address,
        refundTo: account.address,
        deadline: deadlineFromNow(deadlineMinutes)
      };
    const builderParameters = {
      ...parameters,
      deltaIds: [...parameters.deltaIds],
      distributionX: [...parameters.distributionX],
      distributionY: [...parameters.distributionY]
    };
    const transaction = effectiveAddAssetMode === "native"
      ? buildAddLiquidityNativeTransaction(registry, builderParameters)
      : buildAddLiquidityTransaction(registry, builderParameters);
    addSubmitInFlightRef.current = submittedOperationGeneration;
    addWrite.reset();
    setSubmittedAddReceiptContext(null);
    setGasReviewError(null);
    setLiquidityReviewNotice(null);
    const operationIsCurrent = () =>
      liquidityOperationGenerationRef.current === submittedOperationGeneration &&
      addSubmitInFlightRef.current === submittedOperationGeneration;
    let submitted = false;
    try {
      try {
        assertExecutableTokenAction([tokenX, tokenY], "add-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      const exactReview = await runPreSubmitSimulation(
        async () => {
          const block = await getPinnedBlockIdentity(publicClient);
          await attestLiquidityPair("add-liquidity", block.number);
          if (
            previousReview !== null &&
            previousReview.block.number === block.number &&
            previousReview.block.hash.toLowerCase() === block.hash.toLowerCase() &&
            previousReview.block.timestamp === block.timestamp
          ) {
            return previousReview;
          }
          return loadPinnedAddLiquidityReview(publicClient, {
            account: account.address,
            assetMode: effectiveAddAssetMode,
            block,
            pair: pool.pair,
            parameters,
            router: registry.contracts.lbRouter,
            transaction
          });
        },
        setLiquiditySimulationError,
        setLiquiditySimulationPending,
        operationIsCurrent
      );

      if (!exactReview) return;
      if (liquidityOperationGenerationRef.current !== submittedOperationGeneration) return;
      if (latestAddExecutionFingerprint.current !== submittedExecutionFingerprint) {
        setLiquiditySimulationError("Liquidity execution context, safety settings, strategy, range, or composition changed during simulation; review the projected bins and try again");
        return;
      }
      const reviewUnchanged = samePinnedLiquidityReview(previousReview, exactReview);
      const nextReviewState = { executionFingerprint: submittedExecutionFingerprint, review: exactReview };
      latestLiquidityAddReviewRef.current = nextReviewState;
      setLiquidityAddReview(nextReviewState);
      const pinnedExecutionFingerprint = [
        submittedExecutionFingerprint,
        exactReview.block.number.toString(),
        exactReview.block.hash,
        exactReview.block.timestamp.toString()
      ].join("|");
      const gasReviewIsCurrent = () =>
        operationIsCurrent() &&
        latestAddExecutionFingerprint.current === submittedExecutionFingerprint &&
        latestLiquidityAddReviewRef.current?.review.block.hash.toLowerCase() === exactReview.block.hash.toLowerCase();
      const gasObservation: { value: { balance: bigint; review: ExactGasReview } | null } = { value: null };
      const gasApproved = await reviewExactGas({
        action: "add liquidity",
        currentReview: gasReview,
        estimateGas: () => publicClient.estimateGas({ account: account.address, blockNumber: exactReview.block.number, ...transaction }),
        executionFingerprint: pinnedExecutionFingerprint,
        getBalance: () => publicClient.getBalance({ address: account.address }),
        getGasPrice: () => publicClient.getGasPrice(),
        isCurrent: gasReviewIsCurrent,
        setError: setGasReviewError,
        setReview: setGasReview,
        onReview: (review, latestNativeBalance) => {
          gasObservation.value = { balance: latestNativeBalance, review };
          latestAddGasObservationRef.current = { balance: latestNativeBalance, context: addMaxContextFingerprint, gasPrice: review.gasPrice, reserve: review.bufferedWei };
          if (nativeMaxProbeSide === null) return;
          const max = safeMaxAmount({ asset: "native", balance: latestNativeBalance, gasReserveWei: review.bufferedWei });
          if (max === 0n) {
            setGasReviewError("Native Max is unavailable because the wallet balance does not exceed the reviewed gas reserve");
            return;
          }
          const value = maxAmountInput({ asset: "native", balance: latestNativeBalance, decimals: 18, gasReserveWei: review.bufferedWei });
          nativeAddMaxBindingRef.current = { balance: latestNativeBalance, context: addMaxContextFingerprint, gasPrice: review.gasPrice, reserve: review.bufferedWei, side: nativeMaxProbeSide, value: max };
          if (nativeMaxProbeSide === "x") setAmountXInput(value);
          else setAmountYInput(value);
        },
        transactionValue: transaction.value
      });
      if (nativeMaxProbeSide !== null) return;
      const finalGasObservation = gasObservation.value;
      if (effectiveAddAssetMode === "native" && nativeAddMaxBindingRef.current !== null && finalGasObservation !== null) {
        const binding = nativeAddMaxBindingRef.current;
        const submittedNativeAmount = binding.side === "x" ? amountX : amountY;
        const exactMax = safeMaxAmount({ asset: "native", balance: finalGasObservation.balance, gasReserveWei: finalGasObservation.review.bufferedWei });
        if (
          binding.side !== liquidityWrappedNativeSide ||
          binding.context !== addMaxContextFingerprint ||
          binding.balance !== finalGasObservation.balance ||
          binding.gasPrice !== finalGasObservation.review.gasPrice ||
          submittedNativeAmount !== binding.value ||
          submittedNativeAmount > exactMax ||
          finalGasObservation.review.bufferedWei > binding.reserve
        ) {
          setGasReviewError("Native Max changed with the latest balance or buffered gas; press Max again before wallet confirmation");
          return;
        }
      }
      if (!reviewUnchanged || !gasApproved || !gasReviewIsCurrent()) return;
      const submittedContext = {
        account: account.address,
        calldataFingerprint: keccak256(transaction.data),
        chainId: activeWalletChainId,
        deploymentEpoch: deploymentEpoch(registry),
        environment: environmentKey,
        executionFingerprint: submittedExecutionFingerprint,
        intent: "add-liquidity" as const,
        providerId: account.connector?.id ?? "unknown",
        providerUid: account.connector?.uid ?? "unknown",
        submittedAt: Date.now(),
        target: registry.contracts.lbRouter,
        value: transaction.value
      };
      try {
        setSubmittedAddReceiptContext(submittedExecutionFingerprint);
        const submittedAt = Date.now();
        setSubmittedLiquidityAddReview({
          ...nextReviewState,
          chainId: registry.chainId,
          environment: environmentKey,
          submittedAt
        });
        const hash = await submitJournaledTransaction({
          isCurrent: gasReviewIsCurrent,
          journal: transactionJournal,
          reviewed: reviewedTransactionIntent(submittedContext, { poolId: pool.pair, recipient: account.address, refundRecipient: account.address, settingsFingerprint: addRetrySettingsFingerprint }),
          preWalletGuard: async () => {
            const finalBlock = await getPinnedBlockIdentity(publicClient);
            if (
              finalBlock.number !== exactReview.block.number ||
              finalBlock.hash.toLowerCase() !== exactReview.block.hash.toLowerCase() ||
              finalBlock.timestamp !== exactReview.block.timestamp
            ) {
              throw new PairAttestationError("context-changed", "Pinned liquidity block advanced; review the updated fees, refunds, and shares before opening the wallet");
            }
            await attestLiquidityPair("add-liquidity", finalBlock.number);
            if (!gasReviewIsCurrent()) throw new PairAttestationError("context-changed", "Liquidity context changed during final pair attestation");
          },
          send: () => addWrite.sendTransactionAsync({ account: account.address, ...transaction })
        });
        submitted = hash !== null;
      } catch (error) {
        if (error instanceof PairAttestationError && error.code === "context-changed") {
          latestLiquidityAddReviewRef.current = null;
          setLiquidityAddReview(null);
          setGasReview(null);
          setGasReviewError(null);
          setLiquiditySimulationError(null);
          setLiquidityReviewNotice(`${error.message}. Review again; no wallet request was sent.`);
        } else if (!isUserRejectedSubmission(error)) {
          setLiquiditySimulationError(getWriteError(error) ?? "Transaction journal blocked add-liquidity submission");
        }
        // The wagmi mutation retains the rejection for the originating mounted session.
      }
    } finally {
      if (!submitted && addSubmitInFlightRef.current === submittedOperationGeneration) {
        addSubmitInFlightRef.current = null;
      }
      if (nativeMaxProbeSide !== null) {
        nativeAddMaxProbeRef.current = null;
        setNativeAddMaxPending(false);
      }
    }
  };

  const handleNativeAddMax = (side: "x" | "y") => {
    if (nativeAddMaxPending || liquidityWrappedNativeSide !== side || nativeBalance === null) return;
    const observation = latestAddGasObservationRef.current;
    const binding = nativeAddMaxBindingRef.current;
    const canReuseObservation = binding?.side === side && binding.context === addMaxContextFingerprint && observation?.context === addMaxContextFingerprint && nativeSideAmount !== null && nativeSideAmount > 0n;
    if (gasReview?.action === "add liquidity" && observation !== null && canReuseObservation) {
      const max = safeMaxAmount({ asset: "native", balance: observation.balance, gasReserveWei: observation.reserve });
      if (max === 0n) {
        setGasReviewError("Native Max is unavailable because the wallet balance does not exceed the reviewed gas reserve");
        return;
      }
      const value = maxAmountInput({ asset: "native", balance: observation.balance, decimals: 18, gasReserveWei: observation.reserve });
      nativeAddMaxBindingRef.current = { balance: observation.balance, context: addMaxContextFingerprint, gasPrice: observation.gasPrice, reserve: observation.reserve, side, value: max };
      if (side === "x") setAmountXInput(value);
      else setAmountYInput(value);
      return;
    }
    if (!nativeAdd || !addReady) return;
    nativeAddMaxProbeRef.current = side;
    setNativeAddMaxPending(true);
    void handleAddLiquidity();
  };
  const canReuseNativeAddMaxObservation = (side: "x" | "y") => {
    const binding = nativeAddMaxBindingRef.current;
    const observation = latestAddGasObservationRef.current;
    return binding?.side === side && binding.context === addMaxContextFingerprint && observation?.context === addMaxContextFingerprint && nativeSideAmount !== null && nativeSideAmount > 0n;
  };

  const handleFullExitBatch = async (workflowKeyOverride: string | null = null) => {
    if (
      removeSubmitInFlightRef.current !== null ||
      !pool ||
      !account.address ||
      slippageBps === null ||
      deadlineMinutes === null ||
      activeWalletChainId !== registry.chainId
    ) return;
    const workflowKey = workflowKeyOverride ?? currentFullExitWorkflowKey;
    if (workflowKey === null) return;
    const expectedWorkflowKey = createFullExitWorkflowKey({
      account: account.address,
      chainId: registry.chainId,
      deploymentEpoch: deploymentEpoch(registry),
      environment: environmentKey,
      pair: pool.pair,
      recipient: account.address,
      router: registry.contracts.lbRouter
    });
    if (workflowKey !== expectedWorkflowKey) {
      setLiquiditySimulationError("The resumable full-exit identity does not match the current owner, chain, deployment, pair, and router");
      return;
    }
    if (!navigator.locks) {
      setLiquiditySimulationError("This browser cannot provide the exclusive lock required for safe full-exit batching");
      return;
    }

    const submittedOperationGeneration = liquidityOperationGenerationRef.current;
    const submittedExecutionContextFingerprint = removeExecutionContextFingerprint;
    removeSubmitInFlightRef.current = submittedOperationGeneration;
    const operationIsCurrent = () =>
      liquidityOperationGenerationRef.current === submittedOperationGeneration &&
      removeSubmitInFlightRef.current === submittedOperationGeneration;
    removeWrite.reset();
    setLiquidityReceiptPhase("idle");
    setSubmittedRemoveReceiptContext(null);
    setSubmittedFullExitHash(null);
    setNativeRemoveOrphanNotice(null);
    setLiquiditySimulationError(null);
    setGasReviewError(null);
    setRemoveQuoteReviewRequired(null);
    setLiquiditySimulationPending(true);
    setFullExitUi({
      batchOrdinal: 1,
      completedBatches: 0,
      estimatedTransactionsRemaining: null,
      message: "Re-enumerating every owner bin at a complete pinned indexer block before planning the next transaction.",
      remainingBins: null,
      status: "planning",
      workflowKey
    });
    let submitted = false;
    try {
      await navigator.locks.request(`feather.full-exit:${workflowKey}`, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
        if (lock === null) throw new Error("Another tab is already planning or submitting this exact full exit");
        const durableJournal = loadTransactionJournal(window.localStorage);
        const familyRecords = durableJournal.records.filter((record) =>
          record.reviewed.intent === "remove-liquidity" &&
          record.reviewed.account.toLowerCase() === account.address!.toLowerCase() &&
          record.reviewed.chainId === registry.chainId &&
          record.reviewed.environment === environmentKey &&
          record.reviewed.deploymentEpoch === deploymentEpoch(registry) &&
          record.reviewed.poolId?.toLowerCase() === pool.pair.toLowerCase() &&
          record.reviewed.target.toLowerCase() === registry.contracts.lbRouter.toLowerCase()
        );
        const conflictingRecord = familyRecords.find(transactionRecordBlocksIntentFamily) ?? null;
        if (conflictingRecord !== null) {
          const settings = fullExitSettingsForRecord(conflictingRecord);
          setFullExitUi({
            batchOrdinal: settings?.batchOrdinal ?? 1,
            completedBatches: familyRecords.filter((record) => {
              const recordSettings = fullExitSettingsForRecord(record);
              return recordSettings?.workflowKey === workflowKey && fullExitJournalDisposition(record).countsCompletedBatch;
            }).length,
            estimatedTransactionsRemaining: null,
            message: `Prior remove transaction is ${conflictingRecord.status} with ${conflictingRecord.confirmations}/${TRANSACTION_JOURNAL_MONITOR_CONFIRMATIONS} confirmations. Reconciliation and finality must finish before replanning.`,
            remainingBins: null,
            status: "awaiting-finality",
            workflowKey
          });
          throw new Error("A prior withdrawal for this owner and pair is not yet finalized; resume remains blocked until journal reconciliation reaches 12 confirmations");
        }
        const workflowRecords = familyRecords.filter((record) => fullExitSettingsForRecord(record)?.workflowKey === workflowKey);
        const completedBatches = new Set(workflowRecords
          .filter((record) => fullExitJournalDisposition(record).countsCompletedBatch)
          .map((record) => fullExitSettingsForRecord(record)!.batchOrdinal)).size;
        const batchOrdinal = completedBatches + 1;

        const submitPreparedBatch = async (prepared: FullExitBatchReviewState) => {
          const gasReviewIsCurrent = () =>
            operationIsCurrent() &&
            latestRemoveExecutionContextFingerprint.current === prepared.executionContextFingerprint &&
            latestFullExitBatchReviewRef.current?.executionFingerprint === prepared.executionFingerprint;
          const gasApproved = await reviewExactGas({
            action: "full liquidity exit",
            currentReview: gasReview,
            estimateGas: () => publicClient.estimateGas({
              account: account.address!,
              to: prepared.transaction.to,
              data: prepared.transaction.data,
              value: prepared.transaction.value
            }),
            executionFingerprint: prepared.executionFingerprint,
            getBalance: () => publicClient.getBalance({ address: account.address! }),
            getGasPrice: () => publicClient.getGasPrice(),
            isCurrent: gasReviewIsCurrent,
            setError: setGasReviewError,
            setReview: setGasReview,
            transactionValue: prepared.transaction.value
          });
          if (!gasApproved || !gasReviewIsCurrent()) return;
          const assertPreparedLiveState = async () => {
            if (await readRpcBlockHash(prepared.sourceBlockNumber) !== prepared.sourceBlockHash) {
              throw new Error("The reviewed full-exit state block was reorganized; discard this review and re-enumerate");
            }
            const latest = await readSelectedBurnSnapshot(prepared.positions);
            const balanceByBin = new Map(latest.balances.map((row) => [BigInt(row.binId).toString(), BigInt(row.balance ?? 0)]));
            const latestBins = prepared.liveBins.map((bin) => ({ binId: bin.binId, liveBalance: balanceByBin.get(bin.binId.toString()) ?? 0n }));
            const latestStates = latest.binStates.filter((state) => latestBins.some((bin) => bin.binId === BigInt(state.binId)));
            if (
              fullExitReviewedLiveStateFingerprint(latestBins, latestStates) !==
              fullExitReviewedLiveStateFingerprint(prepared.liveBins, prepared.binStates)
            ) {
              throw new Error("Reviewed full-exit balances or quote state changed; re-enumerate and review the exact batch again");
            }
          };
          await assertPreparedLiveState();
          if (!(await readLiveLbApproval())) throw new Error("LB operator access was revoked before the full-exit wallet request");
          await publicClient.call({ account: account.address!, to: prepared.transaction.to, data: prepared.transaction.data, value: prepared.transaction.value });
          await attestLiquidityPair("remove-liquidity");
          setLiquidityReceiptPhase("remove");
          setSubmittedRemoveReceiptContext(liquidityLifecycleKey);
          const submittedContext = {
            account: account.address!,
            calldataFingerprint: keccak256(prepared.transaction.data),
            chainId: activeWalletChainId,
            deploymentEpoch: deploymentEpoch(registry),
            environment: environmentKey,
            executionFingerprint: prepared.executionFingerprint,
            intent: "remove-liquidity" as const,
            providerId: account.connector?.id ?? "unknown",
            providerUid: account.connector?.uid ?? "unknown",
            submittedAt: Date.now(),
            target: prepared.transaction.to,
            value: prepared.transaction.value
          };
          const hash = await submitJournaledTransaction({
            isCurrent: gasReviewIsCurrent,
            journal: transactionJournal,
            reviewed: reviewedTransactionIntent(submittedContext, {
              poolId: pool.pair,
              recipient: account.address!,
              refundRecipient: null,
              settingsFingerprint: prepared.batchSettings
            }),
            preWalletGuard: async () => {
              await assertPreparedLiveState();
              if (!(await readLiveLbApproval())) throw new PairAttestationError("context-changed", "LB operator access was revoked before wallet confirmation");
              await publicClient.call({ account: account.address!, to: prepared.transaction.to, data: prepared.transaction.data, value: prepared.transaction.value });
              await attestLiquidityPair("remove-liquidity");
              if (!gasReviewIsCurrent()) throw new PairAttestationError("context-changed", "Full-exit context changed before wallet confirmation");
            },
            send: () => removeWrite.sendTransactionAsync(prepared.transaction)
          });
          submitted = hash !== null;
          if (submitted) {
            if (prepared.assetMode === "native" && removeWrappedNativeSide !== null) {
              setSubmittedNativeRemoveReview({
                account: account.address!,
                amounts: prepared.liveBins.map((bin) => bin.liveBalance),
                chainId: registry.chainId,
                environment: environmentKey,
                executionFingerprint: prepared.executionFingerprint,
                expectedAmountX: prepared.expectedAmountX,
                expectedAmountY: prepared.expectedAmountY,
                ids: prepared.liveBins.map((bin) => bin.binId),
                minimumAmountX: prepared.minimumAmountX,
                minimumAmountY: prepared.minimumAmountY,
                nativeSide: removeWrappedNativeSide,
                pair: pool.pair,
                submittedAt: submittedContext.submittedAt,
                tokenX: pool.tokenX,
                tokenY: pool.tokenY,
                transaction: { ...prepared.transaction }
              });
            }
            setSubmittedFullExitHash(hash);
            latestFullExitBatchReviewRef.current = null;
            setFullExitBatchReview(null);
            setFullExitUi({
              batchOrdinal: prepared.batchOrdinal,
              completedBatches: prepared.completedBatches,
              estimatedTransactionsRemaining: prepared.estimatedTransactionsRemaining,
              message: `Batch ${prepared.batchOrdinal} submitted for ${prepared.liveBins.length} bins. This is not a completed full exit; wait for 12-confirmation finality, then explicitly resume to re-enumerate every remaining owner bin.`,
              remainingBins: prepared.remainingBins,
              status: "submitted",
              workflowKey
            });
          }
        };

        if (
          fullExitBatchReview !== null &&
          fullExitBatchReview.workflowKey === workflowKey &&
          fullExitBatchReview.batchOrdinal === batchOrdinal &&
          fullExitBatchReview.executionContextFingerprint === submittedExecutionContextFingerprint
        ) {
          try {
            await submitPreparedBatch(fullExitBatchReview);
            return;
          } catch (error) {
            if (!/Reviewed full-exit balances or quote state changed/i.test(getWriteError(error) ?? "")) throw error;
            latestFullExitBatchReviewRef.current = null;
            setFullExitBatchReview(null);
            setGasReview(null);
            setFullExitUi({
              batchOrdinal,
              completedBatches,
              estimatedTransactionsRemaining: null,
              message: "Live balances or quote state changed after review. Re-enumerating now; a new exact gas review is required before any wallet request.",
              remainingBins: null,
              status: "planning",
              workflowKey
            });
          }
        }

        try {
          await attestLiquidityPair("remove-liquidity");
        } catch (error) {
          throw new Error(`Full-exit pair attestation failed: ${getWriteError(error) ?? "pair identity unavailable"}`);
        }
        const snapshotResult = await onRefresh();
        if (snapshotResult.isError || snapshotResult.error || !snapshotResult.data) {
          throw snapshotResult.error ?? new Error("exact full-exit snapshot unavailable");
        }
        const freshSnapshot = snapshotResult.data;
        const freshnessError = indexerSubmissionFreshnessError(freshSnapshot);
        if (freshnessError !== null) throw new Error(freshnessError);
        if (
          freshSnapshot.runtime.blockNumber === null ||
          freshSnapshot.indexer.blockNumber === null ||
          freshSnapshot.indexer.blockHash === null ||
          BigInt(freshSnapshot.runtime.blockNumber) < BigInt(freshSnapshot.indexer.blockNumber)
        ) throw new Error("Full exit requires a complete indexer block that does not exceed the observed RPC head");
        const pinnedBlockNumber = BigInt(freshSnapshot.indexer.blockNumber);
        const pinnedBlockHash = freshSnapshot.indexer.blockHash.toLowerCase();
        if (await readRpcBlockHash(pinnedBlockNumber) !== pinnedBlockHash) {
          throw new Error("Full exit requires the pinned indexer block hash to remain canonical on RPC");
        }
        const freshPositionsPage = await loadPaginatedPositionsForOwnerPairAtBlock(
          registry,
          account.address!,
          pool.pair,
          pinnedBlockNumber
        );
        const positionDataError = ownerPositionPaginationError(freshPositionsPage, false);
        if (positionDataError !== null) throw new Error(positionDataError);
        const finalizedPriorBatch = workflowRecords.some((record) => fullExitJournalDisposition(record).countsCompletedBatch);
        let burnSnapshot: LiveBurnSnapshot | null = null;
        let livePositivePositions: PositionRow[] = [];
        if (freshPositionsPage.rows.length > 0) {
          burnSnapshot = await readSelectedBurnSnapshot(freshPositionsPage.rows, pinnedBlockNumber);
          const balanceByBin = new Map(burnSnapshot.balances.map((row) => [BigInt(row.binId).toString(), BigInt(row.balance ?? 0)]));
          livePositivePositions = freshPositionsPage.rows.filter((position) => (balanceByBin.get(BigInt(position.binId).toString()) ?? 0n) > 0n);
        }
        if (livePositivePositions.length === 0) {
          if (!finalizedPriorBatch) throw new Error("No positive owner bins were found, but there is no finalized full-exit batch to verify");
          if (await readRpcBlockHash(pinnedBlockNumber) !== pinnedBlockHash) {
            throw new Error("The zero-position verification block was reorganized; retry after reconciliation");
          }
          setLiquiditySimulationPending(false);
          setFullExitUi({
            batchOrdinal,
            completedBatches,
            estimatedTransactionsRemaining: 0,
            message: `Full exit verified complete: zero positive owner bins at canonical block ${pinnedBlockNumber.toString()} (${formatCompactAddress(pinnedBlockHash)}).`,
            remainingBins: 0,
            status: "complete",
            workflowKey
          });
          return;
        }
        if (burnSnapshot === null) throw new Error("Pinned live owner-bin state is unavailable");
        const livePositiveIds = new Set(livePositivePositions.map((position) => BigInt(position.binId).toString()));
        burnSnapshot = {
          ...burnSnapshot,
          balances: burnSnapshot.balances.filter((row) => livePositiveIds.has(BigInt(row.binId).toString())),
          binStates: burnSnapshot.binStates.filter((row) => livePositiveIds.has(BigInt(row.binId).toString()))
        };
        const freshPlan = buildPositionBurnPlan({
          burnBps: 10_000n,
          freshness: {
            indexerStale: false,
            liveReadError: false,
            liveReadLoading: false,
            positionDataCapped: false,
            positionDataPartial: false
          },
          liveBalancesByBin: burnSnapshot.balances,
          selectedPositions: livePositivePositions
        });
        if (freshPlan.blocked) throw new Error(positionBurnSubmissionError(freshPlan) ?? "Exact live full-exit burn plan is blocked");
        const observedHeadBlockNumber = await readRpcHeadBlockNumber();
        const stateSnapshot = createFullExitStateSnapshot({
          bins: freshPlan.items.map((item) => ({ binId: item.binId, liveBalance: item.liveBalance })),
          blockHash: pinnedBlockHash,
          blockNumber: pinnedBlockNumber,
          observedHeadBlockNumber,
          workflowKey
        });
        const stateFingerprint = fullExitStateFingerprint(stateSnapshot);
        const pinnedBlock = await publicClient.getBlock({ blockNumber: pinnedBlockNumber });
        const policy = fullExitBatchPolicy(environmentKey);
        const reviewedDeadline = deadlineFromNow(deadlineMinutes);
        const plan = await planFullExitBatches({
          bins: stateSnapshot.bins,
          limits: {
            blockGasLimit: pinnedBlock.gasLimit,
            maxBlockGasBps: policy.maxBlockGasBps,
            maxCalldataBytes: policy.maxCalldataBytes,
            maxCandidateBins: policy.maxCandidateBins,
            maxProbeCount: policy.maxProbeCount
          },
          stateFingerprint,
          probe: async ({ bins }) => {
            const candidatePlan = sliceBurnPlan(freshPlan, bins);
            const quoteView = buildBurnQuoteView(candidatePlan, burnSnapshot.binStates, slippageBps);
            if (quoteView.error !== null || quoteView.minimums === null) {
              return { diagnostic: quoteView.error ?? "burn minimums unavailable", status: "semantic-failure" as const };
            }
            const candidate = buildExactRemoveTransaction({
              tokenX: pool.tokenX,
              tokenY: pool.tokenY,
              binStep: pool.binStep,
              minimums: quoteView.minimums,
              ids: candidatePlan.ids,
              amounts: candidatePlan.amounts,
              to: account.address!,
              deadline: reviewedDeadline
            });
            const calldataBytes = Math.max(0, (candidate.data.length - 2) / 2);
            try {
              await publicClient.call({ account: account.address!, blockNumber: pinnedBlockNumber, to: candidate.to, data: candidate.data, value: candidate.value });
            } catch (error) {
              const diagnostic = getWriteError(error) ?? "exact candidate simulation failed";
              return /(?:out of gas|gas limit|intrinsic gas|calldata|payload|batch exceeds|transaction too large|request entity too large)/i.test(diagnostic)
                ? { diagnostic, status: "capacity" as const }
                : { diagnostic, status: "semantic-failure" as const };
            }
            try {
              const estimatedGas = await publicClient.estimateGas({ account: account.address!, blockNumber: pinnedBlockNumber, to: candidate.to, data: candidate.data, value: candidate.value });
              return { calldataBytes, estimatedGas, status: "success" as const };
            } catch (error) {
              const diagnostic = getWriteError(error) ?? "exact candidate gas estimate unavailable";
              return /(?:out of gas|gas limit|intrinsic gas|calldata|payload|batch exceeds|transaction too large|request entity too large)/i.test(diagnostic)
                ? { diagnostic, status: "capacity" as const }
                : { diagnostic, status: "unavailable" as const };
            }
          }
        });
        const firstBatch = plan.batches[0];
        if (!firstBatch) throw new Error("Full-exit planner returned no safe transaction for positive live bins");
        if (await readRpcBlockHash(pinnedBlockNumber) !== pinnedBlockHash) {
          throw new Error("The pinned full-exit planning block was reorganized; re-enumerate before reviewing a batch");
        }
        const batchPlan = sliceBurnPlan(freshPlan, firstBatch.bins);
        const batchQuote = buildBurnQuoteView(batchPlan, burnSnapshot.binStates, slippageBps);
        if (batchQuote.error !== null || batchQuote.minimums === null || batchQuote.quote === null) {
          throw new Error(`Full-exit batch quote failed: ${batchQuote.error ?? "minimums unavailable"}`);
        }
        const transaction = buildExactRemoveTransaction({
          tokenX: pool.tokenX,
          tokenY: pool.tokenY,
          binStep: pool.binStep,
          minimums: batchQuote.minimums,
          ids: batchPlan.ids,
          amounts: batchPlan.amounts,
          to: account.address!,
          deadline: reviewedDeadline
        });
        const batchSettings = encodeFullExitBatchSettings({
          batchOrdinal,
          bins: firstBatch.bins,
          stateFingerprint,
          workflowKey
        });
        const batchReviewFingerprint = JSON.stringify([
          workflowKey,
          stateFingerprint,
          batchSettings,
          keccak256(transaction.data),
          transaction.value.toString()
        ]);
        const firstBatchIds = new Set(firstBatch.bins.map((bin) => bin.binId.toString()));
        const prepared: FullExitBatchReviewState = {
          assetMode: effectiveRemoveAssetMode,
          batchOrdinal,
          batchSettings,
          binStates: burnSnapshot.binStates.filter((state) => firstBatchIds.has(BigInt(state.binId).toString())),
          completedBatches,
          estimatedTransactionsRemaining: plan.batches.length,
          estimatedGas: firstBatch.estimatedGas,
          expectedAmountX: batchQuote.quote.amountXOut,
          expectedAmountY: batchQuote.quote.amountYOut,
          executionContextFingerprint: submittedExecutionContextFingerprint,
          executionFingerprint: batchReviewFingerprint,
          liveBins: firstBatch.bins.map((bin) => ({ ...bin })),
          minimumAmountX: batchQuote.minimums.amountXMin,
          minimumAmountY: batchQuote.minimums.amountYMin,
          positions: livePositivePositions.filter((position) => firstBatchIds.has(BigInt(position.binId).toString())),
          remainingBins: stateSnapshot.bins.length,
          sourceBlockHash: pinnedBlockHash,
          sourceBlockNumber: pinnedBlockNumber,
          stateFingerprint,
          transaction,
          workflowKey
        };
        latestFullExitBatchReviewRef.current = prepared;
        setFullExitBatchReview(prepared);
        setFullExitUi({
          batchOrdinal,
          completedBatches,
          estimatedTransactionsRemaining: plan.batches.length,
          message: `Safe serial plan: ${stateSnapshot.bins.length} live bins require ${plan.batches.length} non-atomic transaction${plan.batches.length === 1 ? "" : "s"}. Batch ${batchOrdinal} burns ${firstBatch.bins.length} bins; each later batch requires fresh enumeration, finality, and explicit review.`,
          remainingBins: stateSnapshot.bins.length,
          status: "awaiting-review",
          workflowKey
        });
        await submitPreparedBatch(prepared);
      });
    } catch (error) {
      const errorMessage = getWriteError(error) ?? "Full-exit batch planning or submission failed";
      const approvalRevoked = /LB operator access was revoked/i.test(errorMessage);
      if (approvalRevoked) {
        latestFullExitBatchReviewRef.current = null;
        setFullExitBatchReview(null);
        setGasReview(null);
        setGasReviewError(null);
        setLiquiditySimulationError(null);
        setRemoveQuoteReviewRequired("LB operator access was revoked during full-exit review. Re-approve this exact pair and router; no full-exit wallet request was sent.");
      } else if (!isUserRejectedSubmission(error)) {
        latestFullExitBatchReviewRef.current = null;
        setFullExitBatchReview(null);
        setGasReview(null);
        setLiquiditySimulationError(errorMessage);
      }
      setFullExitUi((current) => current === null || current.status === "awaiting-finality" ? current : {
        ...current,
        message: approvalRevoked
          ? "Pair-wide LB operator access was revoked. Re-approve before replanning this batch."
          : errorMessage,
        status: "blocked"
      });
    } finally {
      if (!submitted && removeSubmitInFlightRef.current === submittedOperationGeneration) {
        removeSubmitInFlightRef.current = null;
      }
      setLiquiditySimulationPending(false);
    }
  };

  const handleRemoveLiquidity = async () => {
    if (fullExit) {
      await handleFullExitBatch();
      return;
    }
    if (removeSubmitInFlightRef.current !== null) return;
    if (
      !removeReady ||
      !pool ||
      !account.address ||
      slippageBps === null ||
      deadlineMinutes === null ||
      removeBurnQuoteExecutionFingerprint === null
    ) return;

    const submittedOperationGeneration = liquidityOperationGenerationRef.current;
    const submittedExecutionContextFingerprint = removeExecutionContextFingerprint;
    const submittedBurnQuoteExecutionFingerprint = removeBurnQuoteExecutionFingerprint;
    removeSubmitInFlightRef.current = submittedOperationGeneration;
    const operationIsCurrent = () =>
      liquidityOperationGenerationRef.current === submittedOperationGeneration &&
      removeSubmitInFlightRef.current === submittedOperationGeneration;
    removeWrite.reset();
    setLiquidityReceiptPhase("idle");
    setSubmittedRemoveReceiptContext(null);
    setSubmittedFullExitHash(null);
    setNativeRemoveOrphanNotice(null);
    setLiquiditySimulationError(null);
    setGasReviewError(null);
    setRemoveQuoteReviewRequired(null);
    let submitted = false;
    try {
      try {
        await attestLiquidityPair("remove-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      try {
        if (!(await readLiveLbApproval())) {
          setLiquiditySimulationError(null);
          setGasReview(null);
          setRemoveQuoteReviewRequired("LB operator access was revoked or does not match this exact pair and router. Approve the current pair-wide operator before retrying; no remove simulation or wallet request was sent.");
          return;
        }
      } catch (error) {
        setLiquiditySimulationError(`Live LB operator approval preflight failed: ${getWriteError(error) ?? "approval state unavailable"}`);
        return;
      }
      setLiquiditySimulationPending(true);
      let freshPlan: PositionBurnPlanResult;
      let freshBurnSnapshot: LiveBurnSnapshot;
      let freshPositionsPage: PaginatedRows<PositionRow>;
      let freshSnapshot: AppSnapshot;
      let exactFullExitBlockNumber: bigint | null = null;
      let exactFullExitBlockHash: string | null = null;
      try {
        if (fullExit) {
          const snapshotResult = await onRefresh();
          if (snapshotResult.isError || snapshotResult.error || !snapshotResult.data) {
            throw snapshotResult.error ?? new Error("exact-head snapshot unavailable");
          }
          freshSnapshot = snapshotResult.data;
          if (
            freshSnapshot.runtime.blockNumber === null ||
            freshSnapshot.indexer.blockNumber === null ||
            freshSnapshot.indexer.blockHash === null ||
            BigInt(freshSnapshot.runtime.blockNumber) !== BigInt(freshSnapshot.indexer.blockNumber)
          ) {
            throw new Error("Full exit requires the indexer and RPC to reconcile at the exact same block");
          }
          exactFullExitBlockNumber = BigInt(freshSnapshot.indexer.blockNumber);
          exactFullExitBlockHash = freshSnapshot.indexer.blockHash.toLowerCase();
          const rpcBlockHash = await readRpcBlockHash(exactFullExitBlockNumber);
          if (rpcBlockHash !== exactFullExitBlockHash) {
            throw new Error("Full exit requires the indexer and RPC block hashes to match");
          }
          freshPositionsPage = await loadPaginatedPositionsForOwnerPairAtBlock(
            registry,
            account.address,
            pool.pair,
            exactFullExitBlockNumber
          );
        } else {
          const freshPreflight = await refreshPositionSubmissionPreflight();
          freshSnapshot = freshPreflight.snapshot;
          freshPositionsPage = freshPreflight.positions;
        }
      } catch (error) {
        if (!operationIsCurrent()) return;
        setLiquiditySimulationError(`Mandatory indexer refresh failed: ${getWriteError(error) ?? "freshness unavailable"}`);
        return;
      }
      if (!operationIsCurrent()) return;

      const freshDataIssue =
        indexerSubmissionFreshnessError(freshSnapshot) ?? ownerPositionPaginationError(freshPositionsPage, false);
      if (freshDataIssue !== null) {
        setLiquiditySimulationError(freshDataIssue);
        return;
      }

      const freshSelectedPositions = freshPositionsPage.rows.filter((position) => selectedPositionIdSet.has(position.id));
      if (fullExit && freshSelectedPositions.length !== freshPositionsPage.rows.length) {
        setRemoveQuoteReviewRequired(
          "The exact-head owner position set changed. Review every current bin before retrying the full exit."
        );
        return;
      }
      if (portfolioExitRequested) {
        const freshPortfolioResult = await portfolioIntentQuery.refetch({ cancelRefetch: true });
        if (!operationIsCurrent()) return;
        const freshPortfolioIssue = portfolioExitIntentError({
          action: portfolioAction,
          owner: account.address,
          pair: pool.pair,
          portfolio: freshPortfolioResult.data,
          portfolioQueryError: freshPortfolioResult.isError || freshPortfolioResult.error !== null,
          portfolioQueryLoading: false,
          positions: freshPositionsPage,
          removePercentBps,
          selectedPositions: freshSelectedPositions,
          snapshot: freshSnapshot
        });
        if (freshPortfolioIssue !== null) {
          setLiquiditySimulationError(freshPortfolioIssue);
          return;
        }
      }

      if (positionSelectionKey(freshSelectedPositions) !== selectedPositionsKey) {
        setRemoveQuoteReviewRequired(
          "Indexed position data changed during the mandatory refresh. Review the current positions and submit again."
        );
        return;
      }

      try {
        if (exactFullExitBlockNumber !== null) {
          freshBurnSnapshot = await readSelectedBurnSnapshot(freshSelectedPositions, exactFullExitBlockNumber);
          queryClient.setQueryData(
            ["liquiditySelectedBurnSnapshot", registry.chainId, account.address, pool.pair, selectedPositionsKey],
            freshBurnSnapshot
          );
        } else {
          const refreshed = await selectedBurnSnapshotQuery.refetch({ cancelRefetch: true });
          if (!operationIsCurrent()) return;
          if (refreshed.error || !refreshed.data) {
            throw refreshed.error ?? new Error("same-block reads unavailable");
          }
          freshBurnSnapshot = refreshed.data;
        }
        if (!operationIsCurrent()) return;
        freshPlan = buildPositionBurnPlan({
          burnBps: removePercentBps,
          freshness: {
            indexerStale: freshSnapshot.indexer.status === "stale",
            liveReadError: false,
            liveReadLoading: false,
            positionDataCapped: freshPositionsPage.pageInfo.capped,
            positionDataPartial: freshPositionsPage.pageInfo.failed
          },
          liveBalancesByBin: freshBurnSnapshot.balances,
          selectedPositions: freshSelectedPositions
        });
      } catch (error) {
        if (!operationIsCurrent()) return;
        setLiquiditySimulationError(`Pinned burn snapshot failed: ${getWriteError(error) ?? "same-block reads unavailable"}`);
        return;
      }

      const freshPlanError = positionBurnSubmissionError(freshPlan);
      if (freshPlanError !== null) {
        setLiquiditySimulationError(freshPlanError);
        return;
      }

      let freshBurnQuote: BurnQuoteView;
      try {
        freshBurnQuote = buildBurnQuoteView(freshPlan, freshBurnSnapshot.binStates, slippageBps);
      } catch (error) {
        setLiquiditySimulationError(`Fresh burn output quote failed: ${getWriteError(error) ?? "bin state unavailable"}`);
        return;
      }
      if (freshBurnQuote.error !== null || freshBurnQuote.minimums === null || freshBurnQuote.quote === null) {
        setLiquiditySimulationError(`Fresh burn output quote failed: ${freshBurnQuote.error ?? "minimums unavailable"}`);
        return;
      }

      const freshBurnQuoteExecutionFingerprint = buildBurnQuoteExecutionFingerprint(freshBurnSnapshot, freshPlan, freshBurnQuote);
      if (freshBurnQuoteExecutionFingerprint !== submittedBurnQuoteExecutionFingerprint) {
        setRemoveQuoteReviewRequired(
          "Burn quote changed during the mandatory live refresh. Expected outputs, minimums, balances, or burn amounts were refreshed; review them and submit again."
        );
        return;
      }

      const transaction = buildExactRemoveTransaction({
        tokenX: pool.tokenX,
        tokenY: pool.tokenY,
        binStep: pool.binStep,
        minimums: freshBurnQuote.minimums,
        ids: freshPlan.ids,
        amounts: freshPlan.amounts,
        to: account.address,
        deadline: deadlineFromNow(deadlineMinutes)
      });
      try {
        await publicClient.call({
          account: account.address,
          to: transaction.to,
          data: transaction.data,
          value: transaction.value
        });
      } catch (error) {
        if (!operationIsCurrent()) return;
        setLiquiditySimulationError(`Simulation failed: ${getWriteError(error) ?? "Transaction simulation failed"}`);
        return;
      }
      try {
        if (!(await readLiveLbApproval())) {
          setLiquiditySimulationError(null);
          setGasReview(null);
          setRemoveQuoteReviewRequired("LB operator access changed during review. Re-approve this exact pair and router before retrying; no wallet request was sent.");
          return;
        }
      } catch (error) {
        setLiquiditySimulationError(`Live LB operator approval recheck failed: ${getWriteError(error) ?? "approval state unavailable"}`);
        return;
      }
      if (!operationIsCurrent()) return;
      if (latestRemoveExecutionContextFingerprint.current !== submittedExecutionContextFingerprint) {
        setLiquiditySimulationError("Remove execution context changed during live reads or simulation; review the current inputs and try again");
        return;
      }
      if (latestRemoveBurnQuoteExecutionFingerprint.current !== submittedBurnQuoteExecutionFingerprint) {
        setRemoveQuoteReviewRequired(
          "Burn quote changed during simulation. Expected outputs, minimums, balances, or burn amounts were refreshed; review them and submit again."
        );
        return;
      }
      if (latestRemoveDataFreshnessIssue.current !== null) {
        setLiquiditySimulationError(latestRemoveDataFreshnessIssue.current);
        return;
      }
      if (exactFullExitBlockNumber !== null && exactFullExitBlockHash !== null) {
        const currentBlockHash = await readRpcBlockHash(exactFullExitBlockNumber);
        if (!operationIsCurrent()) return;
        if (currentBlockHash !== exactFullExitBlockHash) {
          setLiquiditySimulationError("The full-exit validation block was reorganized; refresh the position set and try again");
          return;
        }
        const currentHead = await readRpcHeadBlockNumber();
        if (!operationIsCurrent()) return;
        if (currentHead !== exactFullExitBlockNumber) {
          setLiquiditySimulationError("The chain advanced during full-exit validation; refresh the exact-head position set and try again");
          return;
        }
      }

      if (!operationIsCurrent()) return;
      const gasReviewIsCurrent = () =>
        operationIsCurrent() &&
        latestRemoveExecutionContextFingerprint.current === submittedExecutionContextFingerprint &&
        latestRemoveBurnQuoteExecutionFingerprint.current === submittedBurnQuoteExecutionFingerprint &&
        latestRemoveDataFreshnessIssue.current === null;
      const gasApproved = await reviewExactGas({
        action: fullExit ? "full liquidity exit" : "liquidity withdrawal",
        currentReview: gasReview,
        estimateGas: () => publicClient.estimateGas({ account: account.address, to: transaction.to, data: transaction.data, value: transaction.value }),
        executionFingerprint: submittedExecutionContextFingerprint,
        getBalance: () => publicClient.getBalance({ address: account.address }),
        getGasPrice: () => publicClient.getGasPrice(),
        isCurrent: gasReviewIsCurrent,
        setError: setGasReviewError,
        setReview: setGasReview,
        transactionValue: transaction.value
      });
      if (!gasApproved || !gasReviewIsCurrent()) return;
      try {
        await attestLiquidityPair("remove-liquidity");
      } catch (error) {
        setLiquiditySimulationError(getWriteError(error));
        return;
      }
      setLiquidityReceiptPhase("remove");
      setSubmittedRemoveReceiptContext(liquidityLifecycleKey);
      const submittedContext = {
        account: account.address,
        calldataFingerprint: keccak256(transaction.data),
        chainId: activeWalletChainId,
        deploymentEpoch: deploymentEpoch(registry),
        environment: environmentKey,
        executionFingerprint: submittedExecutionContextFingerprint,
        intent: "remove-liquidity" as const,
        providerId: account.connector?.id ?? "unknown",
        providerUid: account.connector?.uid ?? "unknown",
        submittedAt: Date.now(),
        target: transaction.to,
        value: transaction.value
      };
      try {
        const hash = await submitJournaledTransaction({
          isCurrent: gasReviewIsCurrent,
          journal: transactionJournal,
          reviewed: reviewedTransactionIntent(submittedContext, { poolId: pool.pair, recipient: account.address, refundRecipient: null, settingsFingerprint: removeReviewFingerprint }),
          preWalletGuard: async () => {
            await attestLiquidityPair("remove-liquidity");
            if (!(await readLiveLbApproval())) {
              throw new PairAttestationError("context-changed", "LB operator access was revoked before wallet confirmation");
            }
            if (!gasReviewIsCurrent()) throw new PairAttestationError("context-changed", "Withdrawal context changed during final pair attestation");
          },
          send: () => removeWrite.sendTransactionAsync(transaction)
        });
        submitted = hash !== null;
        if (submitted && effectiveRemoveAssetMode === "native" && removeWrappedNativeSide !== null) {
          setSubmittedNativeRemoveReview({
            account: account.address,
            amounts: [...freshPlan.amounts],
            chainId: registry.chainId,
            environment: environmentKey,
            executionFingerprint: submittedExecutionContextFingerprint,
            expectedAmountX: freshBurnQuote.quote.amountXOut,
            expectedAmountY: freshBurnQuote.quote.amountYOut,
            ids: [...freshPlan.ids],
            minimumAmountX: freshBurnQuote.minimums.amountXMin,
            minimumAmountY: freshBurnQuote.minimums.amountYMin,
            nativeSide: removeWrappedNativeSide,
            pair: pool.pair,
            submittedAt: submittedContext.submittedAt,
            tokenX: pool.tokenX,
            tokenY: pool.tokenY,
            transaction: { ...transaction }
          });
        }
      } catch (error) {
        if (error instanceof PairAttestationError && error.message.includes("LB operator access was revoked")) {
          setLiquiditySimulationError(null);
          setGasReview(null);
          setRemoveQuoteReviewRequired("LB operator access was revoked before wallet confirmation. Re-approve this exact pair and router; no wallet request was sent.");
        } else if (!isUserRejectedSubmission(error)) {
          setLiquiditySimulationError(getWriteError(error) ?? "Transaction journal blocked withdrawal submission");
        }
        // The wagmi mutation retains the rejection for the originating mounted session.
      }
    } finally {
      if (!submitted && removeSubmitInFlightRef.current === submittedOperationGeneration) {
        removeSubmitInFlightRef.current = null;
        setLiquiditySimulationPending(false);
      }
    }
  };

  const clearSubmittedRemoveReceipt = () => {
    setLiquidityReceiptPhase((currentPhase) => currentPhase === "remove" ? "idle" : currentPhase);
    setSubmittedRemoveReceiptContext(null);
    setSubmittedFullExitHash(null);
    setSubmittedNativeRemoveReview(null);
  };
  const updateRemovePercentInput = (value: string, requestFullExit = false) => {
    clearSubmittedRemoveReceipt();
    setExplicitFullExitRequested(requestFullExit);
    setRemovePercentInput(value);
  };
  const toggleSelectedPosition = (positionId: string) => {
    clearSubmittedRemoveReceipt();
    setSelectedPositionIds((currentIds) => {
      const nextIds = currentIds.includes(positionId)
        ? currentIds.filter((currentId) => currentId !== positionId)
        : [...currentIds, positionId];
      intentionalEmptySelectionRef.current = nextIds.length === 0;

      return nextIds;
    });
  };
  const selectAllLoadedPositions = () => {
    clearSubmittedRemoveReceipt();
    intentionalEmptySelectionRef.current = false;
    setSelectedPositionIds(walletPositions.map((position) => position.id));
  };
  const clearSelectedPositions = () => {
    clearSubmittedRemoveReceipt();
    intentionalEmptySelectionRef.current = true;
    setSelectedPositionIds([]);
  };
  const walletBalanceReadPending = walletQuery.isLoading || walletQuery.isFetching;
  const pairedFillWalletReady = walletData !== null && !walletBalanceReadPending && !walletQuery.isError;
  const amountCardBalance = (side: PairedFillSide) => {
    if (!connected) return "connect wallet";
    if (walletQuery.isError) return "unavailable";
    if (walletBalanceReadPending) return "loading";
    if (walletData === null) return "unavailable";
    if (side === "x") {
      return nativeModeX
        ? `${formatTokenAmount(walletData.nativeBalance, null)} ETH`
        : `${formatTokenAmount(walletData.balanceX, tokenX)} ${tokenSymbol(tokenX)}`;
    }
    return nativeModeY
      ? `${formatTokenAmount(walletData.nativeBalance, null)} ETH`
      : `${formatTokenAmount(walletData.balanceY, tokenY)} ${tokenSymbol(tokenY)}`;
  };
  const amountCardBalanceX = amountCardBalance("x");
  const amountCardBalanceY = amountCardBalance("y");
  const pairedFillPairedToken = pairedFillSuggestion.pairedSide === "x" ? tokenX : tokenY;
  const pairedFillSourceToken = pairedFillSourceSide === "x" ? tokenX : tokenY;
  const pairedFillPairedSymbol = pairedFillSuggestion.pairedSide === "x" ? (nativeModeX ? "ETH" : tokenSymbol(tokenX)) : (nativeModeY ? "ETH" : tokenSymbol(tokenY));
  const pairedFillSourceSymbol = pairedFillSourceSide === "x" ? (nativeModeX ? "ETH" : tokenSymbol(tokenX)) : (nativeModeY ? "ETH" : tokenSymbol(tokenY));
  const pairedFillInput = pairedFillPairedToken === null ? "0" : formatUnits(pairedFillSuggestion.pairedAmount, pairedFillPairedToken.decimals);
  const pairedFillFormattedSource = pairedFillSuggestion.sourceAmount === null ? "invalid" : formatTokenAmount(pairedFillSuggestion.sourceAmount, pairedFillSourceToken);
  const pairedFillFormattedPaired = formatTokenAmount(pairedFillSuggestion.pairedAmount, pairedFillPairedToken);
  const pairedFillState = pairedFillNativeBlockedSide !== null
    ? "native-review-required"
    : liquidityMode === "token-x" || liquidityMode === "token-y"
      ? "one-sided"
      : pairedFillApplied
        ? "applied"
        : pairedFillSuggestion.status === "unavailable"
      ? "unavailable"
      : "ready";
  const pairedFillMessage = pairedFillNativeBlockedSide !== null
    ? `Paired fill will not spend the full ETH balance. Use Native Max for a gas-reserved ${pairedFillNativeBlockedSide.toUpperCase()} amount, or switch to ERC-20 mode.`
    : !connected
      ? "Connect a wallet to calculate a suggestion from current balances."
      : walletQuery.isError
        ? "Wallet balances are unavailable. Retry the wallet read before applying a paired amount."
      : walletBalanceReadPending
        ? "Reading current wallet balances."
        : liquidityMode === "token-x"
          ? `${tokenSymbol(tokenY)} stays at exact zero for this one-sided ${tokenSymbol(tokenX)} range. No paired amount or swap is needed.`
          : liquidityMode === "token-y"
            ? `${tokenSymbol(tokenX)} stays at exact zero for this one-sided ${tokenSymbol(tokenY)} range. No paired amount or swap is needed.`
        : pairedFillSuggestion.status === "unavailable"
          ? pairedFillSuggestion.reason === "invalid-source-amount"
            ? `Enter a positive ${pairedFillSourceSymbol} source amount first.`
            : pairedFillSuggestion.reason === "source-balance-exceeded"
              ? `The ${pairedFillSourceSymbol} source amount exceeds its current wallet balance.`
              : pairedFillSuggestion.reason === "empty-paired-balance"
                ? `The ${pairedFillPairedSymbol} wallet balance is empty, so it cannot be paired.`
                : pairedFillSuggestion.reason === "missing-source-balance" || pairedFillSuggestion.reason === "missing-paired-balance"
                  ? "Current wallet balances are unavailable."
            : pairedFillSuggestion.reason === "rounding-underflow"
              ? "Current balances are too small for a nonzero paired amount at this range."
              : "A paired amount is unavailable until the current range, distribution, and balances are valid."
            : pairedFillApplied
              ? `Kept ${pairedFillFormattedSource} ${pairedFillSourceSymbol} and filled ${pairedFillFormattedPaired} ${pairedFillPairedSymbol} for this exact context. No swap or Zap was performed.`
              : `Keep ${pairedFillFormattedSource} ${pairedFillSourceSymbol}; fill ${pairedFillFormattedPaired} ${pairedFillPairedSymbol}${pairedFillSuggestion.clamped ? " (clamped to its wallet balance)" : ""}. Nothing changes until you apply it.`;
  const pairedFillCanApply =
    connected &&
    !onWrongChain &&
    tokenX !== null &&
    tokenY !== null &&
    liquidityMode === "balanced" &&
    pairedFillWalletReady &&
    pairedFillNativeBlockedSide === null &&
    pairedFillSuggestion.status === "ready" &&
    !pairedFillApplied;
  const pairedFillButtonLabel = liquidityMode === "token-x" || liquidityMode === "token-y"
    ? "No pair needed"
    : pairedFillApplied
      ? `${pairedFillPairedSymbol} filled`
      : pairedFillSuggestion.status !== "ready"
        ? "Pair unavailable"
        : `Fill ${pairedFillPairedSymbol}${pairedFillSuggestion.clamped ? " to balance" : ""}`;
  const applyPairedFill = () => {
    if (!pairedFillCanApply || tokenX === null || tokenY === null) return;
    nativeAddMaxBindingRef.current = null;
    pairedFillContextRef.current = pairedFillContextFingerprint;
    if (pairedFillSuggestion.pairedSide === "x") setAmountXInput(pairedFillInput);
    else setAmountYInput(pairedFillInput);
    setPairedFillApplication({
      amountX: pairedFillSuggestion.amountX.toString(),
      amountY: pairedFillSuggestion.amountY.toString(),
      contextFingerprint: pairedFillContextFingerprint,
      pairedAmount: pairedFillSuggestion.pairedAmount.toString(),
      pairedSide: pairedFillSuggestion.pairedSide,
      sourceAmount: pairedFillSuggestion.sourceAmount!.toString(),
      sourceSide: pairedFillSourceSide
    });
  };
  const updateLiquidityAmountInput = (side: PairedFillSide, value: string) => {
    nativeAddMaxBindingRef.current = null;
    setPairedFillApplication(null);
    setPairedFillSourceSide(side);
    if (side === "x") setAmountXInput(value);
    else setAmountYInput(value);
  };

  return (
    <div className={`view-grid two-col${workspaceMatchesPool ? " liquidity-task-workspace" : ""}`}>
      {portfolioAction ? (
        <section className="snapshot-message ready portfolio-action-banner" data-testid="portfolio-action-handoff">
          {portfolioAction === "add"
            ? "Adding liquidity to the selected portfolio pair."
            : portfolioAction === "partial"
              ? "Partial withdrawal prefilled at 50% across every loaded bin in this position."
              : "Full exit prefilled at 100% across every loaded bin in this position."}
        </section>
      ) : null}
      {workspaceMatchesPool ? (
        <div
          aria-labelledby={mobileWorkspaceNavigation ? "pool-mobile-market-tab" : undefined}
          className="liquidity-market-column"
          id="pool-mobile-market-panel"
          role={mobileWorkspaceNavigation ? "tabpanel" : undefined}
          tabIndex={mobileWorkspaceNavigation ? -1 : undefined}
        >
          <SwapMarketChart
            candles={poolWorkspace?.analytics.candles.rows ?? []}
            error={poolWorkspace?.analytics.candles.error ?? null}
            interval={poolWorkspace?.analytics.candleInterval ?? "HOUR"}
            loading={poolWorkspace?.analytics.candlesLoading ?? false}
            onIntervalChange={poolWorkspace?.analytics.setCandleInterval ?? (() => undefined)}
            pairAddress={primaryPool?.address ?? null}
            pairLabel={`${tokenSymbol(tokenX)} / ${tokenSymbol(tokenY)}`}
            status={poolWorkspace?.analytics.candles.status ?? "UNAVAILABLE"}
            streamState={poolWorkspace?.analytics.candleStreamState ?? "unavailable"}
          />
        </div>
      ) : null}
      {workspaceMatchesPool ? (
        <div
          aria-labelledby={mobileWorkspaceNavigation ? "pool-mobile-positions-tab" : undefined}
          className="pool-positions-column"
          id="pool-mobile-positions-panel"
          role={mobileWorkspaceNavigation ? "tabpanel" : undefined}
          tabIndex={mobileWorkspaceNavigation ? -1 : undefined}
        >
          <PoolWorkspaceOwnerPanel />
        </div>
      ) : null}
      {!workspaceMatchesPool || initialSection !== "withdraw" ? (
      <section
        aria-labelledby={mobileWorkspaceNavigation ? "pool-mobile-trade-tab" : undefined}
        className={workspaceMatchesPool ? "tool-panel liquidity-task-panel" : "tool-panel"}
        id="liquidity-add"
        role={mobileWorkspaceNavigation ? "tabpanel" : undefined}
        tabIndex={mobileWorkspaceNavigation ? -1 : undefined}
      >
        {workspaceMatchesPool ? <PoolWorkspaceTaskTabs task="create" /> : null}
        <LiquidityTaskBody compact={workspaceMatchesPool}>
        {!workspaceMatchesPool ? (
          <div className="panel-heading">
            <span>Add Liquidity</span>
            <StatusBadge state={addPoolReady ? "ready" : "unavailable"} label={poolDescriptorLabel(selectedPool)} />
          </div>
        ) : null}

        {workspaceMatchesPool ? (
          <span className="field-label liquidity-task-amount-label">Amount</span>
        ) : (
          <PoolSelect
            id="liquidity-pair"
            label="Pool"
            onChange={onSelectedPoolChange}
            pools={poolOptions}
            selectedPoolId={selectedPoolId}
          />
        )}

        {connected && liquidityWrappedNative !== null && liquidityWrappedNativeSide !== null ? (
          <fieldset className="routing-mode-control" data-testid="liquidity-native-mode">
            <legend>Wrapped-native deposit mode</legend>
            <div className="segmented" role="group" aria-label="Wrapped-native deposit mode">
              <button aria-pressed={liquidityAssetMode === "native"} className={liquidityAssetMode === "native" ? "segment active" : "segment"} onClick={() => { nativeAddMaxBindingRef.current = null; setPairedFillApplication(null); setLiquidityAssetMode("native"); }} type="button">ETH · native</button>
              <button aria-pressed={liquidityAssetMode === "erc20"} className={liquidityAssetMode === "erc20" ? "segment active" : "segment"} onClick={() => { nativeAddMaxBindingRef.current = null; setPairedFillApplication(null); setLiquidityAssetMode("erc20"); }} type="button">{liquidityWrappedNative.symbol} · ERC-20</button>
            </div>
            <p data-testid="liquidity-wrapper-disclosure">ETH deposits use exact router transaction value and never approve {liquidityWrappedNative.symbol}. Unused native-side input is refunded as {liquidityWrappedNative.symbol} ERC-20 at {liquidityWrappedNative.address}. Native Max reserves a freshly reviewed 25%-buffered gas estimate and the final value is revalidated before wallet confirmation.</p>
          </fieldset>
        ) : null}

        <div className="liquidity-rows">
          <div className="amount-box compact liquidity-amount-card" data-source={pairedFillSourceSide === "x" ? "true" : "false"} data-unused={liquidityMode === "token-y" ? "true" : "false"}>
            <div className="liquidity-amount-card-meta">
              <span>Balance</span>
              <strong data-testid="liquidity-balance-x">{amountCardBalanceX}</strong>
            </div>
            <input
              aria-label={`${nativeModeX ? "ETH" : tokenSymbol(tokenX)} liquidity amount`}
              data-testid="liquidity-amount-x"
              disabled={liquidityMode === "token-y"}
              inputMode="decimal"
              value={liquidityMode === "token-y" ? "0" : amountXInput}
              onChange={(event) => updateLiquidityAmountInput("x", event.target.value)}
            />
            <span className="liquidity-amount-token">{nativeModeX ? "ETH" : tokenSymbol(tokenX)}</span>
            <button aria-label={`Use maximum ${nativeModeX ? "ETH" : tokenSymbol(tokenX)} balance`} className="token-max-button" data-testid="liquidity-max-x" disabled={nativeModeX ? ((!nativeAdd || !addReady) && !canReuseNativeAddMaxObservation("x")) || nativeAddMaxPending : walletBalanceX === null || tokenX === null || liquidityMode === "token-y"} onClick={() => {
              setPairedFillApplication(null);
              setPairedFillSourceSide("x");
              if (nativeModeX) handleNativeAddMax("x");
              else if (walletBalanceX !== null && tokenX !== null) { nativeAddMaxBindingRef.current = null; setAmountXInput(maxAmountInput({ asset: "token", balance: walletBalanceX, decimals: tokenX.decimals })); }
            }} type="button">Max</button>
          </div>
          <div className="amount-box compact liquidity-amount-card" data-source={pairedFillSourceSide === "y" ? "true" : "false"} data-unused={liquidityMode === "token-x" ? "true" : "false"}>
            <div className="liquidity-amount-card-meta">
              <span>Balance</span>
              <strong data-testid="liquidity-balance-y">{amountCardBalanceY}</strong>
            </div>
            <input
              aria-label={`${nativeModeY ? "ETH" : tokenSymbol(tokenY)} liquidity amount`}
              data-testid="liquidity-amount-y"
              disabled={liquidityMode === "token-x"}
              inputMode="decimal"
              value={liquidityMode === "token-x" ? "0" : amountYInput}
              onChange={(event) => updateLiquidityAmountInput("y", event.target.value)}
            />
            <span className="liquidity-amount-token">{nativeModeY ? "ETH" : tokenSymbol(tokenY)}</span>
            <button aria-label={`Use maximum ${nativeModeY ? "ETH" : tokenSymbol(tokenY)} balance`} className="token-max-button" data-testid="liquidity-max-y" disabled={nativeModeY ? ((!nativeAdd || !addReady) && !canReuseNativeAddMaxObservation("y")) || nativeAddMaxPending : walletBalanceY === null || tokenY === null || liquidityMode === "token-x"} onClick={() => {
              setPairedFillApplication(null);
              setPairedFillSourceSide("y");
              if (nativeModeY) handleNativeAddMax("y");
              else if (walletBalanceY !== null && tokenY !== null) { nativeAddMaxBindingRef.current = null; setAmountYInput(maxAmountInput({ asset: "token", balance: walletBalanceY, decimals: tokenY.decimals })); }
            }} type="button">Max</button>
          </div>
        </div>
        <section aria-label="Liquidity amount suggestion" className="liquidity-paired-fill" data-state={pairedFillState} data-testid="liquidity-paired-fill">
          <div className="liquidity-paired-fill-heading">
            <strong>Suggested composition</strong>
            {pairedFillSuggestion.status === "ready" && pairedFillNativeBlockedSide === null ? (
              <span data-testid="liquidity-paired-fill-preview">
                Keep {pairedFillFormattedSource} {pairedFillSourceSymbol} → fill {pairedFillFormattedPaired} {pairedFillPairedSymbol}{pairedFillSuggestion.clamped ? " · clamped" : ""}
              </span>
            ) : <span>{liquidityMode === "token-x" || liquidityMode === "token-y" ? "Pair not required" : "Unavailable"}</span>}
          </div>
          <p aria-live="polite" data-testid="liquidity-paired-fill-status" id="liquidity-paired-fill-status" role="status">{pairedFillMessage}</p>
          <button aria-describedby="liquidity-paired-fill-status" className="secondary-button" data-testid="liquidity-paired-fill-apply" disabled={!pairedFillCanApply} onClick={applyPairedFill} type="button">
            {pairedFillButtonLabel}
          </button>
        </section>
        <LiquidityRangeEditor
          advancedOpenByDefault={!workspaceMatchesPool}
          activeBin={activeBin}
          bins={distributionResult.preview}
          compact={workspaceMatchesPool}
          liveBins={rangeBackdrop.points}
          liveBinsError={rangeBackdrop.error}
          liveBinsState={rangeBackdrop.state}
          lowerBinId={lowerBinId}
          lowerBinInput={lowerBinInput}
          lowerDelta={lowerDelta}
          lowerDeltaInput={lowerDeltaInput}
          lowerPriceInput={lowerPriceInput}
          maxBins={MAX_LIQUIDITY_BINS}
          narrowPresetInput={narrowPresetInput}
          onApplyPreset={applyRangePreset}
          onLowerBinInput={updateLowerBin}
          onLowerDeltaInput={updateLowerDelta}
          onLowerHandleChange={(next) => {
            if (activeBin === null || upperBinId === null) return;
            const nextLowerBin = activeBin + next;
            commitAbsoluteRange(nextLowerBin, Math.min(upperBinId, nextLowerBin + MAX_LIQUIDITY_BINS - 1));
          }}
          onLowerPriceCommit={() => void updatePriceBoundary("lower", lowerPriceInput)}
          onLowerPriceInput={(value) => {
            setLowerPriceInput(value);
            setRangeEditError("Review the edited minimum price");
          }}
          onNarrowPresetInput={setNarrowPresetInput}
          onReset={() => applyRangePreset("3")}
          onStrategyChange={(value) => { setPairedFillApplication(null); setLiquidityStrategy(value); }}
          onUpperBinInput={updateUpperBin}
          onUpperDeltaInput={updateUpperDelta}
          onUpperHandleChange={(next) => {
            if (activeBin === null || lowerBinId === null) return;
            const nextUpperBin = activeBin + next;
            commitAbsoluteRange(Math.max(lowerBinId, nextUpperBin - MAX_LIQUIDITY_BINS + 1), nextUpperBin);
          }}
          onUpperPriceCommit={() => void updatePriceBoundary("upper", upperPriceInput)}
          onUpperPriceInput={(value) => {
            setUpperPriceInput(value);
            setRangeEditError("Review the edited maximum price");
          }}
          onWidePresetInput={setWidePresetInput}
          rangeError={rangeControlError}
          rangeSliderMax={rangeSliderMax}
          rangeSliderMin={rangeSliderMin}
          strategy={liquidityStrategy}
          tokenXSymbol={tokenSymbol(tokenX)}
          tokenYSymbol={tokenSymbol(tokenY)}
          upperBinId={upperBinId}
          upperBinInput={upperBinInput}
          upperDelta={upperDelta}
          upperDeltaInput={upperDeltaInput}
          upperPriceInput={upperPriceInput}
          widePresetInput={widePresetInput}
        />
        <div className={workspaceMatchesPool ? "state-row liquidity-position-summary" : "state-row"} data-testid="liquidity-range-mode">
          <Droplets size={16} />
          <span>{liquidityModeDescription(liquidityMode, tokenSymbol(tokenX), tokenSymbol(tokenY))}</span>
        </div>
        {liquidityMode === "token-x" || liquidityMode === "token-y" ? (
          <div className="state-row warning" data-testid="one-sided-liquidity-notice">
            <AlertTriangle size={16} />
            <span>One-sided liquidity deposits one token directly into the selected bins. It does not perform a swap; use the Swap screen separately if you want to rebalance first.</span>
          </div>
        ) : null}
        {liquidityMode === "balanced" ? (
          <div className={workspaceMatchesPool ? "state-row liquidity-composition-note" : "state-row"} data-testid="liquidity-composition-guidance">
            <CircleDollarSign size={16} />
            <span>Balanced ranges require both tokens. Amounts stay user-controlled; Feather does not silently swap or auto-Zap composition.</span>
          </div>
        ) : null}

        <LiquidityTransactionReview
          compact={workspaceMatchesPool}
          status={liquidityAddReview !== null ? "Pinned review ready" : connected && (needsXApproval || needsYApproval) ? "Approval required" : "Limits and approvals"}
        >
        {nativeModeX ? <div className="state-row" data-testid="liquidity-token-x-identity">ETH native asset · router wrapper {liquidityWrappedNative?.symbol} {liquidityWrappedNative?.address}</div> : <TokenIdentity token={tokenX} networkName={registry.chain.name} testId="liquidity-token-x-identity" />}
        {nativeModeY ? <div className="state-row" data-testid="liquidity-token-y-identity">ETH native asset · router wrapper {liquidityWrappedNative?.symbol} {liquidityWrappedNative?.address}</div> : <TokenIdentity token={tokenY} networkName={registry.chain.name} testId="liquidity-token-y-identity" />}
        {liquidityAssetMode === "native" && !nativeAdd ? (
          <div className="state-row" data-testid="liquidity-native-unused-range"><CircleDollarSign size={16} /><span>This range uses only the non-wrapper token. Submission remains ERC-20 addLiquidity with 0 ETH value.</span></div>
        ) : null}
        {liquidityAssetMode === "native" && liquidityWrappedNativeSide !== null && (nativeSideAmount === null || nativeSideAmount <= 0n) && ((liquidityWrappedNativeSide === "x" && liquidityMode !== "token-y") || (liquidityWrappedNativeSide === "y" && liquidityMode !== "token-x")) ? (
          <div className="state-row warning" data-testid="liquidity-native-max-guidance"><AlertTriangle size={16} /><span>Enter a valid positive ETH probe amount before using Native Max; no wallet request is opened for the gas probe.</span></div>
        ) : null}
        <div className="quote-grid">
          <MiniMetric label={`${nativeModeX ? "ETH" : tokenSymbol(tokenX)} balance`} value={nativeModeX ? nativeBalance !== null ? `${formatUnits(nativeBalance, 18)} ETH` : connected ? "loading" : "connect" : walletData ? formatTokenAmount(walletData.balanceX, tokenX) : connected ? "loading" : "connect"} />
          <MiniMetric label={`${nativeModeY ? "ETH" : tokenSymbol(tokenY)} balance`} value={nativeModeY ? nativeBalance !== null ? `${formatUnits(nativeBalance, 18)} ETH` : connected ? "loading" : "connect" : walletData ? formatTokenAmount(walletData.balanceY, tokenY) : connected ? "loading" : "connect"} />
          <MiniMetric data-testid="liquidity-native-balance" label={nativeAdd ? "ETH for value and gas" : "ETH for gas"} value={nativeBalance !== null ? `${formatUnits(nativeBalance, 18)} ETH` : connected ? "loading" : "connect"} />
        </div>

        <GasReview review={gasReview} />

        {liquidityReviewNotice ? <div className="state-row warning" data-testid="liquidity-review-notice"><AlertTriangle size={16} /><span>{liquidityReviewNotice}</span></div> : null}

        <LiquidityAddReviewPanel reviewJson={serializeBigintState(liquidityAddReview)} tokenX={tokenX} tokenY={tokenY} />

        <LiquidityReceiptReview
          error={addReceiptReconciliationQuery.error}
          hash={canonicalAddHash}
          reconciliationJson={serializeBigintState(addReceiptReconciliationQuery.data)}
          tokenX={tokenX}
          tokenY={tokenY}
        />

        <PairAttestationReview
          attestation={liquidityAttestationQuery.data ?? null}
          error={liquidityAttestationQuery.error}
          loading={liquidityAttestationQuery.isLoading || liquidityAttestationQuery.isFetching}
        />

        <div className="state-row warning liquidity-range-risk" data-testid="liquidity-range-risk">
          <AlertTriangle size={16} />
          <span>Narrow ranges concentrate liquidity and can move out of range sooner. Only the active portion trades; above- or below-active ranges become one-sided, and out-of-range liquidity may stop earning trading fees until price returns. Returns are not guaranteed.</span>
        </div>

        <div className="swap-settings">
          <label htmlFor="liquidity-slippage">
            <span>Slippage</span>
            <input id="liquidity-slippage" inputMode="decimal" value={slippageInput} onChange={(event) => {
              clearSubmittedRemoveReceipt();
              setSlippageInput(event.target.value);
            }} />
          </label>
          <label htmlFor="id-slippage">
            <span>ID Slippage</span>
            <input id="id-slippage" inputMode="numeric" value={idSlippageInput} onChange={(event) => setIdSlippageInput(event.target.value)} />
          </label>
          <label htmlFor="liquidity-deadline">
            <span>Deadline</span>
            <input id="liquidity-deadline" inputMode="numeric" value={deadlineInput} onChange={(event) => {
              clearSubmittedRemoveReceipt();
              setDeadlineInput(event.target.value);
            }} />
          </label>
        </div>

        <div className="quote-grid">
          {!workspaceMatchesPool ? <MiniMetric label="Active Bin" value={activeBin?.toString() ?? "n/a"} /> : null}
          {!workspaceMatchesPool ? <MiniMetric label="Min Bin" value={activeBin !== null && lowerDelta !== null ? String(activeBin + lowerDelta) : "n/a"} /> : null}
          {!workspaceMatchesPool ? <MiniMetric label="Max Bin" value={activeBin !== null && upperDelta !== null ? String(activeBin + upperDelta) : "n/a"} /> : null}
          <MiniMetric label="Liquidity Mode" value={liquidityMode ?? "n/a"} />
          <MiniMetric label="Bin Step" value={pool?.binStep.toString() ?? primaryPool?.binStep ?? "n/a"} />
          <MiniMetric label={`${nativeModeX ? "ETH" : tokenSymbol(tokenX)} allowance`} value={nativeModeX ? "not required for ETH" : walletData ? formatTokenAmount(walletData.allowanceX, tokenX) : "n/a"} />
          <MiniMetric label={`${nativeModeY ? "ETH" : tokenSymbol(tokenY)} allowance`} value={nativeModeY ? "not required for ETH" : walletData ? formatTokenAmount(walletData.allowanceY, tokenY) : "n/a"} />
          <MiniMetric label={`${tokenSymbol(tokenX)} approve`} value={needsXApproval && amountX !== null ? formatTokenAmount(amountX.toString(), tokenX) : "none"} />
          <MiniMetric label={`${tokenSymbol(tokenY)} approve`} value={needsYApproval && amountY !== null ? formatTokenAmount(amountY.toString(), tokenY) : "none"} />
        </div>

        {!nativeModeX ? <ApprovalDetails
          amount={amountX}
          asset={tokenSymbol(tokenX)}
          currentState={walletData ? `${formatTokenAmount(walletData.allowanceX, tokenX)} allowance${needsXApproval ? " (approval needed)" : " (sufficient)"}` : "unavailable"}
          id="liquidity-x-approval-details"
          requested={amountX !== null ? formatTokenAmount(amountX.toString(), tokenX) : "invalid amount"}
          scope="Exact token amount for this add-liquidity action"
          spender={registry.contracts.lbRouter}
          token={tokenX}
        /> : <div className="state-row success" data-testid="liquidity-native-no-approval">ETH uses exact transaction value and never requests wrapper approval.</div>}
        {!nativeModeY ? <ApprovalDetails
          amount={amountY}
          asset={tokenSymbol(tokenY)}
          currentState={walletData ? `${formatTokenAmount(walletData.allowanceY, tokenY)} allowance${needsYApproval ? " (approval needed)" : " (sufficient)"}` : "unavailable"}
          id="liquidity-y-approval-details"
          requested={amountY !== null ? formatTokenAmount(amountY.toString(), tokenY) : "invalid amount"}
          scope="Exact token amount for this add-liquidity action"
          spender={registry.contracts.lbRouter}
          token={tokenY}
        /> : <div className="state-row success" data-testid="liquidity-native-no-approval">ETH uses exact transaction value and never requests wrapper approval.</div>}

        </LiquidityTransactionReview>
        </LiquidityTaskBody>

        <div className={workspaceMatchesPool ? "liquidity-action-dock" : undefined}>
        {workspaceMatchesPool ? (
          <dl className="liquidity-action-summary" data-testid="liquidity-action-summary">
            <div>
              <dt>Position</dt>
              <dd>
                {liquidityStrategy === "bid-ask" ? "Bid-Ask" : liquidityStrategy[0].toUpperCase() + liquidityStrategy.slice(1)}
                {lowerBinId !== null && upperBinId !== null && upperBinId >= lowerBinId ? ` · ${upperBinId - lowerBinId + 1} bins` : " · range unavailable"}
                {liquidityMode === "balanced" ? " · Two-sided" : liquidityMode === "token-x" ? ` · ${tokenSymbol(tokenX)} only` : ` · ${tokenSymbol(tokenY)} only`}
              </dd>
            </div>
            <div>
              <dt>Deposit</dt>
              <dd>
                {liquidityMode === "token-y" ? "0" : amountXInput || "0"} {nativeModeX ? "ETH" : tokenSymbol(tokenX)}
                {" + "}
                {liquidityMode === "token-x" ? "0" : amountYInput || "0"} {nativeModeY ? "ETH" : tokenSymbol(tokenY)}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="action-stack">
          {!nativeModeX ? <button
            className="secondary-button wide"
            data-testid="liquidity-approve-x-button"
            hidden={workspaceMatchesPool && !needsXApproval}
            type="button"
            aria-describedby="liquidity-x-approval-details liquidity-add-status"
            disabled={!canApproveX}
            title={approvalDisclosure({ amount: amountX, spender: registry.contracts.lbRouter, tokenSymbol: tokenSymbol(tokenX) })}
            onClick={handleApproveX}
          >
            {liquiditySimulationPending || approveXWrite.isPending || approveXReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <CheckCircle2 size={18} />}
            <span>{needsXApproval ? `Approve ${tokenSymbol(tokenX)}` : `${tokenSymbol(tokenX)} approved`}</span>
          </button> : null}
          {!nativeModeY ? <button
            className="secondary-button wide"
            data-testid="liquidity-approve-y-button"
            hidden={workspaceMatchesPool && !needsYApproval}
            type="button"
            aria-describedby="liquidity-y-approval-details liquidity-add-status"
            disabled={!canApproveY}
            title={approvalDisclosure({ amount: amountY, spender: registry.contracts.lbRouter, tokenSymbol: tokenSymbol(tokenY) })}
            onClick={handleApproveY}
          >
            {liquiditySimulationPending || approveYWrite.isPending || approveYReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <CheckCircle2 size={18} />}
            <span>{needsYApproval ? `Approve ${tokenSymbol(tokenY)}` : `${tokenSymbol(tokenY)} approved`}</span>
          </button> : null}
          <button aria-describedby="liquidity-add-status" className="primary-button wide" data-testid="liquidity-add-button" type="button" disabled={!addReady} onClick={handleAddLiquidity}>
            {liquiditySimulationPending || addWrite.isPending || addReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <Droplets size={18} />}
            <span>{addButtonLabel === "Add liquidity" ? (liquidityAddReview?.executionFingerprint === addExecutionFingerprint ? "Confirm add liquidity" : "Review add liquidity") : addButtonLabel}</span>
          </button>
        </div>

        <LiquidityStateRows
          actionError={liquidityActionError}
          finalActionPending={addWrite.isPending || (
            submittedAddReceiptContext === addExecutionFingerprint &&
            addWrite.data !== undefined &&
            !addSuccessReconciled &&
            !addReverted
          )}
          finalSuccessText={addSuccessReconciled ? "Liquidity added" : null}
          inputError={addInputError}
          insufficientBalance={insufficientX || insufficientY}
          idleText={!connected ? "Connect wallet to continue" : undefined}
          pendingHash={submittedAddReceiptContext === addExecutionFingerprint
            ? addWrite.data
            : submittedApproveXReceiptContext === approveXExecutionFingerprint
              ? approveXWrite.data
              : submittedApproveYReceiptContext === approveYExecutionFingerprint
                ? approveYWrite.data
                : undefined}
          prerequisitePending={approveXWrite.isPending || approveYWrite.isPending ||
            (submittedApproveXReceiptContext === approveXExecutionFingerprint && approveXReceipt.isLoading) ||
            (submittedApproveYReceiptContext === approveYExecutionFingerprint && approveYReceipt.isLoading)}
          prerequisiteSuccessText={approveXSuccess || approveYSuccess ? "Token approval confirmed" : null}
          revertedText={addReverted ? "Add liquidity reverted" : approveXReverted ? `${tokenSymbol(tokenX)} approval reverted` : approveYReverted ? `${tokenSymbol(tokenY)} approval reverted` : null}
          testId="liquidity-add-status"
        />
        </div>
      </section>
      ) : null}

      {!workspaceMatchesPool || initialSection === "withdraw" ? (
      <section
        aria-labelledby={mobileWorkspaceNavigation ? "pool-mobile-trade-tab" : undefined}
        className={workspaceMatchesPool ? "info-panel liquidity-task-panel" : "info-panel"}
        id="liquidity-withdraw"
        role={mobileWorkspaceNavigation ? "tabpanel" : undefined}
        tabIndex={mobileWorkspaceNavigation ? -1 : undefined}
      >
        {workspaceMatchesPool ? <PoolWorkspaceTaskTabs task="manage" /> : null}
        <LiquidityTaskBody compact={workspaceMatchesPool}>
        <div className="panel-heading">
          <span>{fullExit ? "Full exit" : "Partial withdrawal"}</span>
          <StatusBadge
            state={
              isPartialPagination(walletPositionsPageInfo)
                ? "partial"
                : walletPositions.length > 0
                  ? "ready"
                  : connected && walletPositionsQuery.isLoading
                    ? "loading"
                    : connected
                      ? "empty"
                      : "loading"
            }
            label={walletPositionsPageInfo ? paginationBadgeLabel(walletPositions.length, walletPositionsPageInfo, "bins") : `${walletPositions.length} bins`}
          />
        </div>

        {connected && removeWrappedNative !== null && removeWrappedNativeSide !== null ? (
          <fieldset className="routing-mode-control" data-testid="liquidity-remove-native-mode">
            <legend>Wrapped-native withdrawal mode</legend>
            <div className="segmented" role="group" aria-label="Wrapped-native withdrawal mode">
              <button aria-pressed={removeAssetMode === "native"} className={removeAssetMode === "native" ? "segment active" : "segment"} onClick={() => { clearSubmittedRemoveReceipt(); setRemoveAssetMode("native"); }} type="button">ETH · native output</button>
              <button aria-pressed={removeAssetMode === "erc20"} className={removeAssetMode === "erc20" ? "segment active" : "segment"} onClick={() => { clearSubmittedRemoveReceipt(); setRemoveAssetMode("erc20"); }} type="button">{removeWrappedNative.symbol} · ERC-20 output</button>
            </div>
            <p data-testid="liquidity-remove-wrapper-disclosure">ETH withdrawals use router-native unwrapping with zero transaction value. The other pool token remains an ERC-20 receipt. Pair-wide LB approval scope is unchanged.</p>
          </fieldset>
        ) : null}

        <span className="field-label" id="position-select-label">
          Positions
        </span>
        <PositionMultiSelect
          labelledBy="position-select-label"
          onClear={clearSelectedPositions}
          onSelectAll={selectAllLoadedPositions}
          onToggle={toggleSelectedPosition}
          positions={walletPositions}
          selectedIds={selectedPositionIds}
        />

        <div className="quote-grid">
          <MiniMetric label="Selected Bins" value={selectedBinSummary} />
          <MiniMetric label="Selected Range" value={selectedMinBin === null ? "n/a" : `${selectedMinBin.toString()}–${selectedMaxBin?.toString()}`} />
          <MiniMetric label="Range Status" value={selectedRangeStatus} />
          <MiniMetric label="Indexed Liquidity" value={hasSelectedPositions ? formatTokenAmount(selectedIndexedLiquidityTotal.toString(), null) : "n/a"} />
          <MiniMetric label="Live Balance" value={selectedLiveBalanceTotal !== null ? formatTokenAmount(selectedLiveBalanceTotal.toString(), null) : selectedBurnSnapshotQuery.isLoading ? "loading" : "n/a"} />
          <MiniMetric label="Remove Amount" value={removeAmount !== null ? formatTokenAmount(removeAmount.toString(), null) : "n/a"} />
          <MiniMetric label="Index Freshness" value={liveBalanceBelowIndexed ? "live below index" : selectedBurnSnapshotQuery.data ? `block ${selectedBurnSnapshotQuery.data.blockNumber.toString()}` : "n/a"} />
        </div>
        <BurnPlanWarnings plan={removeBurnPlan} />

        {currentFullExitWorkflowKey !== null && (fullExitHasHistory || fullExitUi?.workflowKey === currentFullExitWorkflowKey) ? (
          <section className={`snapshot-message ${fullExitUi?.status === "complete" ? "ready" : "warning"}`} data-testid="full-exit-workflow-status" role="status">
            <strong>{fullExitUi?.status === "complete" ? "Full exit verified" : "Resumable serial full exit"}</strong>
            <span>{fullExitUi?.message ?? "A durable full-exit batch exists for this exact owner, chain, deployment, pair, and router. Resume performs a fresh uncapped exact-block enumeration; journal history is never treated as proof that balances are gone."}</span>
            {fullExitUi?.status !== "complete" ? (
              <button
                className="secondary-button"
                data-testid="resume-full-exit-button"
                disabled={liquiditySimulationPending || removeWrite.isPending || removeReceipt.isLoading}
                onClick={() => void handleFullExitBatch(currentFullExitWorkflowKey)}
                type="button"
              >
                {currentRemoveFamilyConflict !== null ? "Check finality before resume" : "Resume full exit"}
              </button>
            ) : null}
          </section>
        ) : null}

        <div className="withdraw-percent-controls">
          <label htmlFor="remove-percent-slider">
            <span>Burn percentage</span>
            <input id="remove-percent-slider" max="100" min="0.01" step="0.01" type="range" value={removePercentValue} onChange={(event) => updateRemovePercentInput(event.target.value, event.target.value === "100")} />
          </label>
          <div className="withdraw-quick-actions" aria-label="Withdrawal percentage presets" role="group">
            {[25, 50, 75, 100].map((percent) => (
              <button aria-pressed={removePercentValue === percent} key={percent} onClick={() => updateRemovePercentInput(String(percent), percent === 100)} type="button">
                {percent === 100 ? "Max" : `${percent}%`}
              </button>
            ))}
          </div>
          <label htmlFor="remove-percent">
            <span>Exact %</span>
            <input id="remove-percent" inputMode="decimal" value={removePercentInput} onChange={(event) => updateRemovePercentInput(event.target.value, parsePercentToBps(event.target.value) === 10_000n)} />
          </label>
        </div>

        <div className="quote-grid">
          <MiniMetric data-testid="remove-expected-x" label={`Expected ${tokenSymbol(tokenX)}`} value={removeBurnQuoteView.quote ? formatTokenAmount(removeBurnQuoteView.quote.amountXOut.toString(), tokenX) : "n/a"} />
          <MiniMetric data-testid="remove-expected-y" label={`Expected ${tokenSymbol(tokenY)}`} value={removeBurnQuoteView.quote ? formatTokenAmount(removeBurnQuoteView.quote.amountYOut.toString(), tokenY) : "n/a"} />
          <MiniMetric data-testid="remove-min-x" label={`Minimum ${tokenSymbol(tokenX)}`} value={removeBurnQuoteView.minimums ? formatTokenAmount(removeBurnQuoteView.minimums.amountXMin.toString(), tokenX) : "n/a"} />
          <MiniMetric data-testid="remove-min-y" label={`Minimum ${tokenSymbol(tokenY)}`} value={removeBurnQuoteView.minimums ? formatTokenAmount(removeBurnQuoteView.minimums.amountYMin.toString(), tokenY) : "n/a"} />
        </div>

        <section className="withdraw-review" data-testid="withdraw-transaction-review">
          <strong>Transaction review · {fullExit ? "Full exit" : "Partial withdrawal"}</strong>
          <span>{removePercentValue || 0}% of live balances across {selectedBinSummary}.</span>
          <span>{selectedRangeStatus}; same-block claims at {selectedBurnSnapshotQuery.data ? `block ${selectedBurnSnapshotQuery.data.blockNumber.toString()}` : "a pending head"}.</span>
          <span>Expected receipts include proportional principal and accrued fee growth. There is no separate fee claim or rent refund.</span>
          <span>Minimum receipts apply {slippageInput}% slippage protection before wallet confirmation.</span>
          <span data-testid="withdraw-asset-mode">{nativeRemove ? `Native receipt: the ${removeWrappedNativeSide === "x" ? tokenSymbol(tokenX) : tokenSymbol(tokenY)} side is delivered as ETH; transaction value is 0 ETH.` : `ERC-20 receipt: ${tokenSymbol(tokenX)} and ${tokenSymbol(tokenY)} remain token transfers; ETH is used only for gas.`}</span>
          {fullExitUi?.workflowKey === currentFullExitWorkflowKey ? <span>{fullExitUi.message}</span> : null}
        </section>

        {workspaceMatchesPool ? <GasReview review={gasReview} /> : null}

        <PairAttestationReview
          attestation={liquidityExitAttestationQuery.error === null ? liquidityExitAttestationQuery.data ?? null : null}
          error={liquidityExitAttestationQuery.error}
          loading={liquidityExitAttestationQuery.isLoading || liquidityExitAttestationQuery.isFetching}
        />

        <TokenIdentity token={tokenX} networkName={registry.chain.name} testId="withdraw-token-x-identity" />
        <TokenIdentity token={tokenY} networkName={registry.chain.name} testId="withdraw-token-y-identity" />

        <LbOperatorApprovalDisclosure
          account={account.address ?? null}
          approvedGrants={observedApprovedLbGrants}
          chainId={registry.chainId}
          networkName={registry.chain.name}
          observation={lbApprovalObservation}
          operator={registry.contracts.lbRouter}
          pair={pool?.pair ?? null}
        />

        <dl className="contract-list">
          <div>
            <dt>Pair</dt>
            <dd>{formatCompactAddress(pool?.pair ?? primaryPool?.address)}</dd>
          </div>
          <div>
            <dt>Deposits Indexed</dt>
            <dd>{primaryPool?.depositCount ?? "0"}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>Block {primaryPool?.updatedAtBlock ?? "n/a"}</dd>
          </div>
        </dl>
        </LiquidityTaskBody>

        <div className={workspaceMatchesPool ? "liquidity-action-dock" : undefined}>
        <div className="action-stack">
          <button
            className="secondary-button wide"
            data-testid="liquidity-approve-lb-button"
            type="button"
            aria-describedby="remove-lb-approval-details liquidity-remove-status"
            disabled={!canApproveLb}
            title={`Approve every LB token ID in pair ${pool?.pair ?? "not selected"} for operator ${registry.contracts.lbRouter}`}
            onClick={handleApproveLb}
          >
            {liquiditySimulationPending || approveLbWrite.isPending || approveLbReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <CheckCircle2 size={18} />}
            <span>{liveLbApproved ? "Pair-wide LB operator approved" : "Approve pair-wide LB operator"}</span>
          </button>
          <button aria-describedby="liquidity-remove-status" className="primary-button wide" data-testid="liquidity-remove-button" type="button" disabled={!removeReady} onClick={handleRemoveLiquidity}>
            {liquiditySimulationPending || removeWrite.isPending || removeReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <Droplets size={18} />}
            <span>{removeButtonLabel({ poolReady: removePoolReady, connected, fullExit, onWrongChain, invalidInput: removeInputError !== null, hasPosition: hasSelectedPositions, needsApproval: !liveLbApproved, insufficientGas: liquiditySimulationError?.startsWith("Insufficient ETH for gas") === true })}</span>
          </button>
        </div>

        <LiquidityStateRows
          actionError={currentRemoveOrphaned ? "Native withdrawal receipt was reorganized; canonical accounting was removed and retry remains journal-blocked." : nativeRemoveOrphanNotice ?? removeQuoteReviewRequired ?? liquidityActionError}
          finalActionPending={liquidityReceiptPhase === "remove" && (
            removeWrite.isPending || (
              removeWrite.data !== undefined &&
              !currentRemoveSuccess &&
              !currentRemoveReverted &&
              !currentRemoveOrphaned
            )
          )}
          finalSuccessText={currentRemoveSuccess
            ? submittedFullExitHash !== null && submittedFullExitHash === removeWrite.data
              ? "Full-exit batch mined; the full exit is not complete until 12-confirmation finality and a fresh zero-bin verification"
              : "Liquidity removed"
            : null}
          inputError={currentRemoveSuccess
            ? null
            : liquidityReceiptPhase === "remove" && removeInputError?.startsWith("A prior withdrawal is ")
              ? null
              : removeInputError}
          insufficientBalance={false}
          pendingHash={liquidityReceiptPhase === "remove" ? removeWrite.data : liquidityReceiptPhase === "lb-approval" ? approveLbWrite.data : undefined}
          prerequisitePending={liquidityReceiptPhase === "lb-approval" && (approveLbWrite.isPending || approveLbReceipt.isLoading)}
          prerequisiteSuccessText={currentLbApprovalSuccess ? "LB approval confirmed" : null}
          revertedText={currentRemoveReverted ? "Remove liquidity reverted" : currentLbApprovalReverted ? "LB approval reverted" : null}
          testId="liquidity-remove-status"
        />
        <NativeRemoveReceiptReview
          error={nativeRemoveReceiptReconciliationQuery.error}
          hash={canonicalNativeRemoveHash}
          reconciliation={nativeRemoveReceiptReconciliationQuery.data}
        />
        </div>
      </section>
      ) : null}

    </div>
  );
}

function PositionMultiSelect({
  labelledBy,
  onClear,
  onSelectAll,
  onToggle,
  positions,
  selectedIds
}: {
  labelledBy: string;
  onClear: () => void;
  onSelectAll: () => void;
  onToggle: (positionId: string) => void;
  positions: PositionRow[];
  selectedIds: string[];
}) {
  const selectedIdSet = new Set(selectedIds);

  if (positions.length === 0) {
    return (
      <div className="position-picker empty" role="group" aria-labelledby={labelledBy}>
        <span>No wallet position</span>
      </div>
    );
  }

  return (
    <div className="position-picker" role="group" aria-labelledby={labelledBy}>
      <div className="position-picker-actions">
        <button type="button" onClick={onSelectAll}>
          All
        </button>
        <button type="button" onClick={onClear}>
          Clear
        </button>
      </div>
      {positions.map((position) => (
        <label className="position-option" key={`${labelledBy}-${position.id}`}>
          <input type="checkbox" checked={selectedIdSet.has(position.id)} onChange={() => onToggle(position.id)} />
          <span>Bin {position.binId}</span>
          <strong>{formatTokenAmount(position.liquidity, null)}</strong>
        </label>
      ))}
    </div>
  );
}

function BurnPlanWarnings({ plan }: { plan: PositionBurnPlanResult }) {
  if (plan.warnings.length === 0) return null;

  const warningText =
    plan.warnings.length > 2 ? `${plan.warnings.slice(0, 2).join(" | ")} | ${plan.warnings.length - 2} more` : plan.warnings.join(" | ");

  return (
    <div className="state-row pending">
      <AlertTriangle size={16} />
      <span>{warningText}</span>
    </div>
  );
}

function LiquidityTransactionReview({
  children,
  compact,
  status
}: {
  children: ReactNode;
  compact: boolean;
  status: string;
}) {
  if (!compact) return <>{children}</>;

  return (
    <details className="liquidity-review-details" data-testid="liquidity-transaction-review">
      <summary>
        <span>
          <strong>Transaction review</strong>
          <small>Safety, limits, balances and approvals</small>
        </span>
        <span>{status}</span>
      </summary>
      <div className="liquidity-review-body">{children}</div>
    </details>
  );
}

function LiquidityTaskBody({ children, compact }: { children: ReactNode; compact: boolean }) {
  return compact ? <div className="liquidity-task-body">{children}</div> : <>{children}</>;
}

const RANGE_EDITOR_RADII = [8, 16, 24, 40, 69] as const;

function LiquidityRangeEditor({
  advancedOpenByDefault,
  activeBin,
  bins,
  compact,
  liveBins,
  liveBinsError,
  liveBinsState,
  lowerBinId,
  lowerBinInput,
  lowerDelta,
  lowerDeltaInput,
  lowerPriceInput,
  maxBins,
  narrowPresetInput,
  onApplyPreset,
  onLowerBinInput,
  onLowerDeltaInput,
  onLowerHandleChange,
  onLowerPriceCommit,
  onLowerPriceInput,
  onNarrowPresetInput,
  onReset,
  onStrategyChange,
  onUpperBinInput,
  onUpperDeltaInput,
  onUpperHandleChange,
  onUpperPriceCommit,
  onUpperPriceInput,
  onWidePresetInput,
  rangeError,
  rangeSliderMax,
  rangeSliderMin,
  strategy,
  tokenXSymbol,
  tokenYSymbol,
  upperBinId,
  upperBinInput,
  upperDelta,
  upperDeltaInput,
  upperPriceInput,
  widePresetInput
}: {
  advancedOpenByDefault: boolean;
  activeBin: number | null;
  bins: LiquidityDistributionView[];
  compact: boolean;
  liveBins: BinDistributionPoint[] | null;
  liveBinsError: string | null;
  liveBinsState: LoadState;
  lowerBinId: number | null;
  lowerBinInput: string;
  lowerDelta: number | null;
  lowerDeltaInput: string;
  lowerPriceInput: string;
  maxBins: number;
  narrowPresetInput: string;
  onApplyPreset: (value: string) => void;
  onLowerBinInput: (value: string) => void;
  onLowerDeltaInput: (value: string) => void;
  onLowerHandleChange: (value: number) => void;
  onLowerPriceCommit: () => void;
  onLowerPriceInput: (value: string) => void;
  onNarrowPresetInput: (value: string) => void;
  onReset: () => void;
  onStrategyChange: (strategy: LiquidityStrategy) => void;
  onUpperBinInput: (value: string) => void;
  onUpperDeltaInput: (value: string) => void;
  onUpperHandleChange: (value: number) => void;
  onUpperPriceCommit: () => void;
  onUpperPriceInput: (value: string) => void;
  onWidePresetInput: (value: string) => void;
  rangeError: string | null;
  rangeSliderMax: number;
  rangeSliderMin: number;
  strategy: LiquidityStrategy;
  tokenXSymbol: string;
  tokenYSymbol: string;
  upperBinId: number | null;
  upperBinInput: string;
  upperDelta: number | null;
  upperDeltaInput: string;
  upperPriceInput: string;
  widePresetInput: string;
}) {
  const [radiusIndex, setRadiusIndex] = useState(1);
  const rangeTrackRef = useRef<HTMLDivElement>(null);
  const radius = RANGE_EDITOR_RADII[radiusIndex]!;
  const selectedById = new Map(bins.map((bin) => [Number(bin.binId), bin]));
  const liveById = new Map((liveBins ?? []).map((bin) => [Number(bin.binId), bin]));
  const selectedBinCount = lowerBinId !== null && upperBinId !== null && upperBinId >= lowerBinId
    ? upperBinId - lowerBinId + 1
    : null;
  const sliderControlMin = Math.max(rangeSliderMin, Math.min(-radius, lowerDelta ?? 0));
  const sliderControlMax = Math.min(rangeSliderMax, Math.max(radius, upperDelta ?? 0));
  const sliderSpan = Math.max(1, sliderControlMax - sliderControlMin);
  const lowerPosition = Math.max(0, Math.min(100, (((lowerDelta ?? sliderControlMin) - sliderControlMin) / sliderSpan) * 100));
  const upperPosition = Math.max(0, Math.min(100, (((upperDelta ?? sliderControlMax) - sliderControlMin) / sliderSpan) * 100));
  const activeViewportStart = activeBin === null ? lowerBinId ?? 0 : Math.max(0, activeBin - radius);
  const activeViewportEnd = activeBin === null ? upperBinId ?? activeViewportStart : Math.min(MAX_LIQUIDITY_BIN_ID, activeBin + radius);
  const unionStart = lowerBinId === null ? activeViewportStart : Math.min(activeViewportStart, lowerBinId);
  const unionEnd = upperBinId === null ? activeViewportEnd : Math.max(activeViewportEnd, upperBinId);
  const selectionIsFarFromActive = unionEnd - unionStart + 1 > 109;
  const visualStart = selectionIsFarFromActive && lowerBinId !== null ? lowerBinId : unionStart;
  const visualEnd = selectionIsFarFromActive && upperBinId !== null ? upperBinId : unionEnd;
  const visualBinIds = Array.from({ length: Math.max(0, visualEnd - visualStart + 1) }, (_, index) => visualStart + index);
  const selectedExtendsPastBackdrop = lowerBinId !== null && upperBinId !== null && liveBins !== null && (
    !liveById.has(lowerBinId) || !liveById.has(upperBinId)
  );
  const handlesAreClose = Math.abs(upperPosition - lowerPosition) < 8;

  const updateHandleFromPointer = (boundary: "lower" | "upper", clientX: number) => {
    const track = rangeTrackRef.current;
    if (track === null) return;

    const bounds = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width)));
    const nextValue = Math.round(sliderControlMin + ratio * sliderSpan);
    if (boundary === "lower") {
      onLowerHandleChange(Math.min(nextValue, upperDelta ?? nextValue));
      return;
    }
    onUpperHandleChange(Math.max(nextValue, lowerDelta ?? nextValue));
  };

  const updateHandleFromKey = (boundary: "lower" | "upper", key: string) => {
    const direction = key === "ArrowLeft" || key === "ArrowDown" ? -1 : key === "ArrowRight" || key === "ArrowUp" ? 1 : 0;
    if (direction === 0) return false;

    if (boundary === "lower") {
      const current = lowerDelta ?? 0;
      onLowerHandleChange(Math.max(sliderControlMin, Math.min(current + direction, upperDelta ?? sliderControlMax)));
    } else {
      const current = upperDelta ?? 0;
      onUpperHandleChange(Math.min(sliderControlMax, Math.max(current + direction, lowerDelta ?? sliderControlMin)));
    }
    return true;
  };

  return (
    <section className={`liquidity-range-editor${compact ? " compact" : ""}`} data-testid="liquidity-range-editor">
      <div className="range-editor-heading">
        <div>
          <strong>Price range</strong>
          <span>{tokenYSymbol} per {tokenXSymbol}</span>
        </div>
        <div className="range-editor-heading-actions">
          <button onClick={onReset} type="button">Reset</button>
          <div className="range-editor-zoom" role="group" aria-label="Position range chart zoom">
            <button aria-label="Zoom into position range chart" disabled={radiusIndex === 0} onClick={() => setRadiusIndex((current) => Math.max(0, current - 1))} type="button">−</button>
            <button aria-label="Zoom out of position range chart" disabled={radiusIndex === RANGE_EDITOR_RADII.length - 1} onClick={() => setRadiusIndex((current) => Math.min(RANGE_EDITOR_RADII.length - 1, current + 1))} type="button">+</button>
          </div>
        </div>
      </div>

      <fieldset className="strategy-picker" aria-label="Liquidity strategy">
        <legend>Strategy</legend>
        {(["spot", "curve", "bid-ask"] as const).map((value) => (
          <button
            aria-pressed={strategy === value}
            className={strategy === value ? "selected" : ""}
            data-testid={`liquidity-strategy-${value}`}
            key={value}
            onClick={() => onStrategyChange(value)}
            type="button"
          >
            <strong>{value === "bid-ask" ? "Bid-Ask" : value[0].toUpperCase() + value.slice(1)}</strong>
            <span>{value === "spot" ? "Even" : value === "curve" ? "Near price" : "Range edges"}</span>
          </button>
        ))}
      </fieldset>

      <div className="range-editor-legend" aria-hidden="true">
        <span><i className="live-x" />Pool {tokenXSymbol}</span>
        <span><i className="live-y" />Pool {tokenYSymbol}</span>
        <span><i className="selected" />New position</span>
      </div>

      <div className="range-editor-plot">
        <div aria-describedby="liquidity-range-chart-description" className="range-editor-chart" aria-label="Liquidity bin distribution" role="img">
          {visualBinIds.map((binId) => {
            const live = liveById.get(binId);
            const selected = selectedById.get(binId);
            const boundary = binId === lowerBinId ? "lower" : binId === upperBinId ? "upper" : null;
            const boundaryPrice = boundary === "lower" ? lowerPriceInput : boundary === "upper" ? upperPriceInput : null;
            return (
              <span
                className={[
                  "range-editor-bin",
                  binId === activeBin ? "active" : "",
                  boundary ? `boundary ${boundary}` : "",
                  live === undefined ? "outside-backdrop" : ""
                ].filter(Boolean).join(" ")}
                data-bin-id={binId}
                key={binId}
              >
                {live ? <i className="live-x" style={{ height: `${live.tokenX === "0" ? 0 : Math.max(4, live.tokenXHeight)}%` }} /> : null}
                {live ? <i className="live-y" style={{ height: `${live.tokenY === "0" ? 0 : Math.max(4, live.tokenYHeight)}%` }} /> : null}
                {selected ? (
                  <b
                    aria-label={`Selected bin${binId === activeBin ? "; active bin" : ""}${boundary ? `; ${boundary} boundary${boundaryPrice ? `; ${boundaryPrice}` : ""}` : ""}`}
                    className="selected-distribution"
                    role="img"
                    style={{ height: selected.height }}
                  />
                ) : null}
              </span>
            );
          })}
          {liveBinsState === "loading" ? <span className="range-editor-chart-state">Loading pool reserves</span> : null}
        </div>
        <p className="visually-hidden" id="liquidity-range-chart-description">
          Pool reserves and the proposed {strategy} position across bins {visualStart} through {visualEnd}. The active bin is {activeBin ?? "unavailable"}; the selected range is {lowerBinId ?? "invalid"} through {upperBinId ?? "invalid"}.
        </p>
        <div className="visually-hidden visually-hidden-table">
          <table aria-label="Exact liquidity distribution data">
            <caption>Pool reserves and proposed position weights by visible bin</caption>
            <thead>
              <tr><th>Bin</th><th>Pool {tokenXSymbol}</th><th>Pool {tokenYSymbol}</th><th>New {tokenXSymbol} weight</th><th>New {tokenYSymbol} weight</th></tr>
            </thead>
            <tbody>
              {visualBinIds.map((binId) => {
                const live = liveById.get(binId);
                const selected = selectedById.get(binId);
                return (
                  <tr key={`${binId}-accessible`}>
                    <th>{binId}{binId === activeBin ? " (active)" : ""}</th>
                    <td>{live?.tokenX ?? "Outside indexed window"}</td>
                    <td>{live?.tokenY ?? "Outside indexed window"}</td>
                    <td>{selected?.xWeight ?? "0%"}</td>
                    <td>{selected?.yWeight ?? "0%"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div
          className={["range-editor-axis-control", handlesAreClose ? "handles-close" : ""].filter(Boolean).join(" ")}
          data-testid="liquidity-range-sliders"
          ref={rangeTrackRef}
        >
          <span className="range-editor-track-selection" aria-hidden="true" style={{ left: `${Math.min(lowerPosition, upperPosition)}%`, width: `${Math.max(0, Math.abs(upperPosition - lowerPosition))}%` }} />
          {(["lower", "upper"] as const).map((boundary) => {
            const isLower = boundary === "lower";
            const value = isLower ? lowerDelta ?? 0 : upperDelta ?? 0;
            const position = isLower ? lowerPosition : upperPosition;
            return (
              <button
                aria-describedby={rangeError ? "liquidity-range-error" : undefined}
                aria-invalid={rangeError ? true : undefined}
                aria-label={`${isLower ? "Lower" : "Upper"} range handle`}
                aria-valuemax={isLower ? upperDelta ?? sliderControlMax : sliderControlMax}
                aria-valuemin={isLower ? sliderControlMin : lowerDelta ?? sliderControlMin}
                aria-valuenow={value}
                aria-valuetext={`${isLower ? "Minimum" : "Maximum"} ${isLower ? lowerPriceInput : upperPriceInput} ${tokenYSymbol} per ${tokenXSymbol}`}
                className={`range-editor-thumb ${boundary}`}
                key={boundary}
                onKeyDown={(event) => {
                  if (updateHandleFromKey(boundary, event.key)) event.preventDefault();
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) updateHandleFromPointer(boundary, event.clientX);
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                role="slider"
                style={{ left: `${position}%` }}
                type="button"
              >
                <i aria-hidden="true" />
                <span>{isLower ? "Min" : "Max"}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="range-editor-range-meta" aria-live="polite">
        <strong>{selectedBinCount === null ? "Invalid range" : `${selectedBinCount} bins selected`}</strong>
        <span>Maximum {maxBins}</span>
      </div>
      {liveBinsState !== "ready" ? (
        <p className="range-editor-data-note" role="status">Existing pool liquidity is {liveBinsState}. {liveBinsError ?? "The exact new-position distribution remains available."}</p>
      ) : selectedExtendsPastBackdrop ? (
        <p className="range-editor-data-note">Part of the selected range is outside the indexed ±40-bin reserve backdrop. The new-position weights shown there are still exact.</p>
      ) : selectionIsFarFromActive ? (
        <p className="range-editor-data-note">The selected range is outside the current-price viewport, so this view is focused on the selected bins.</p>
      ) : null}

      <div className="liquidity-range-fields" data-testid="liquidity-range-fields">
        <div className="range-editor-price-grid">
          <label htmlFor="range-min-price">
            <span>Min {tokenYSymbol} per {tokenXSymbol}</span>
            <input aria-errormessage={rangeError ? "liquidity-range-error" : undefined} aria-invalid={rangeError ? true : undefined} aria-label={`Min ${tokenYSymbol} per ${tokenXSymbol}`} id="range-min-price" inputMode="decimal" value={lowerPriceInput} onChange={(event) => onLowerPriceInput(event.target.value)} onBlur={onLowerPriceCommit} />
          </label>
          <label htmlFor="range-max-price">
            <span>Max {tokenYSymbol} per {tokenXSymbol}</span>
            <input aria-errormessage={rangeError ? "liquidity-range-error" : undefined} aria-invalid={rangeError ? true : undefined} aria-label={`Max ${tokenYSymbol} per ${tokenXSymbol}`} id="range-max-price" inputMode="decimal" value={upperPriceInput} onChange={(event) => onUpperPriceInput(event.target.value)} onBlur={onUpperPriceCommit} />
          </label>
        </div>

        {rangeError ? <p aria-atomic="true" className="range-editor-validation" id="liquidity-range-error" role="alert">{rangeError}</p> : null}

        <details className="range-editor-advanced" open={advancedOpenByDefault ? true : undefined}>
          <summary>Advanced range controls</summary>
          <div className="range-editor-exact-grid">
            <label htmlFor="range-lower">
              <span>Lower delta</span>
              <input aria-errormessage={rangeError ? "liquidity-range-error" : undefined} aria-invalid={rangeError ? true : undefined} id="range-lower" inputMode="numeric" value={lowerDeltaInput} onChange={(event) => onLowerDeltaInput(event.target.value)} />
            </label>
            <label htmlFor="range-upper">
              <span>Upper delta</span>
              <input aria-errormessage={rangeError ? "liquidity-range-error" : undefined} aria-invalid={rangeError ? true : undefined} id="range-upper" inputMode="numeric" value={upperDeltaInput} onChange={(event) => onUpperDeltaInput(event.target.value)} />
            </label>
            {!compact ? (
              <>
                <label htmlFor="range-lower-bin">
                  <span>Lower bin</span>
                  <input aria-errormessage={rangeError ? "liquidity-range-error" : undefined} aria-invalid={rangeError ? true : undefined} id="range-lower-bin" inputMode="numeric" value={lowerBinInput} onChange={(event) => onLowerBinInput(event.target.value)} />
                </label>
                <label htmlFor="range-upper-bin">
                  <span>Upper bin</span>
                  <input aria-errormessage={rangeError ? "liquidity-range-error" : undefined} aria-invalid={rangeError ? true : undefined} id="range-upper-bin" inputMode="numeric" value={upperBinInput} onChange={(event) => onUpperBinInput(event.target.value)} />
                </label>
              </>
            ) : null}
          </div>
          <fieldset className="range-presets" aria-label="Liquidity range presets">
            <legend>Editable presets</legend>
            <label>
              <span>Narrow bins</span>
              <input aria-label="Narrow preset bin count" inputMode="numeric" value={narrowPresetInput} onChange={(event) => onNarrowPresetInput(event.target.value)} />
              <button data-testid="liquidity-preset-narrow" onClick={() => onApplyPreset(narrowPresetInput)} type="button">Apply narrow</button>
            </label>
            <label>
              <span>Wide bins</span>
              <input aria-label="Wide preset bin count" inputMode="numeric" value={widePresetInput} onChange={(event) => onWidePresetInput(event.target.value)} />
              <button data-testid="liquidity-preset-wide" onClick={() => onApplyPreset(widePresetInput)} type="button">Apply wide</button>
            </label>
          </fieldset>
        </details>
      </div>

      {!compact ? <details className="distribution-details">
        <summary>Per-bin weights ({bins.length})</summary>
        <div className="distribution-table">
          {bins.map((bin) => (
            <div className="distribution-row" key={`${bin.key}-row`}>
              <span>{bin.delta} / {bin.binId}</span>
              <span>X {bin.xWeight}</span>
              <span>Y {bin.yWeight}</span>
            </div>
          ))}
        </div>
      </details> : null}
    </section>
  );
}

function LiquidityStateRows({
  actionError,
  finalActionPending,
  finalSuccessText,
  idleText,
  inputError,
  insufficientBalance,
  pendingHash,
  prerequisitePending,
  prerequisiteSuccessText,
  revertedText,
  testId
}: {
  actionError: string | null;
  finalActionPending: boolean;
  finalSuccessText: string | null;
  idleText?: string;
  inputError: string | null;
  insufficientBalance: boolean;
  pendingHash: Address | undefined;
  prerequisitePending: boolean;
  prerequisiteSuccessText: string | null;
  revertedText: string | null;
  testId: string;
}) {
  const failure = revertedText ?? inputError ?? (insufficientBalance ? "Insufficient token balance" : null) ?? actionError;
  const state = failure
    ? { icon: <AlertTriangle size={16} />, message: failure, tone: "failure" }
    : finalSuccessText
      ? { icon: <CheckCircle2 size={16} />, message: finalSuccessText, tone: "success" }
      : finalActionPending
        ? { icon: <LoaderCircle className="spin" size={16} />, message: pendingHash ? `Pending ${formatCompactAddress(pendingHash)}` : "Awaiting action wallet confirmation", tone: "pending" }
        : prerequisiteSuccessText
          ? { icon: <CheckCircle2 size={16} />, message: prerequisiteSuccessText, tone: "success" }
          : prerequisitePending || pendingHash
            ? { icon: <LoaderCircle className="spin" size={16} />, message: pendingHash ? `Pending ${formatCompactAddress(pendingHash)}` : "Awaiting approval wallet confirmation", tone: "pending" }
          : idleText
            ? { icon: <Wallet size={16} />, message: idleText, tone: "ready" }
            : { icon: <CheckCircle2 size={16} />, message: "Ready for wallet confirmation", tone: "ready" };

  return (
    <div
      aria-atomic="true"
      aria-live={state.tone === "failure" ? "assertive" : "polite"}
      className={`state-row transaction-status ${state.tone}`}
      data-testid={testId}
      id={testId}
      role={state.tone === "failure" ? "alert" : "status"}
    >
      {state.icon}
      <span>{state.message}</span>
    </div>
  );
}

function buildLiquidityDistributionForView(
  activeBin: number | null,
  lowerDelta: number | null,
  upperDelta: number | null,
  strategy: LiquidityStrategy
): {
  distribution: ReturnType<typeof buildLiquidityDistribution> | null;
  error: string | null;
  preview: LiquidityDistributionView[];
} {
  if (activeBin === null) {
    return { distribution: null, error: "Active bin unavailable", preview: [] };
  }

  if (lowerDelta === null || upperDelta === null) {
    return { distribution: null, error: "Enter integer bin deltas", preview: [] };
  }

  try {
    const distribution = buildLiquidityDistribution(activeBin, lowerDelta, upperDelta, strategy);

    return {
      distribution,
      error: null,
      preview: distribution.bins.map((bin) => {
        const combined = bin.distributionX + bin.distributionY;
        const percent = Number((combined * 100n) / 1_000_000_000_000_000_000n);

        return {
          key: `${bin.binId}-${bin.deltaId}`,
          binId: bin.binId.toString(),
          delta: formatSignedDelta(bin.deltaId),
          xWeight: formatDistributionPercent(bin.distributionX),
          yWeight: formatDistributionPercent(bin.distributionY),
          height: `${Math.max(18, Math.min(96, 18 + percent))}px`
        };
      })
    };
  } catch (error) {
    return { distribution: null, error: error instanceof Error ? error.message : "Invalid liquidity range", preview: [] };
  }
}

function liquidityModeDescription(
  mode: "balanced" | "token-x" | "token-y" | null,
  tokenXSymbol: string,
  tokenYSymbol: string
): string {
  if (mode === "token-x") return `One-sided ${tokenXSymbol}: every selected bin is above the active bin`;
  if (mode === "token-y") return `One-sided ${tokenYSymbol}: every selected bin is below the active bin`;
  if (mode === "balanced") return "Two-sided liquidity: the selected range includes the active bin";
  return "Select a valid bin range to determine which token sides are required";
}

function formatDistributionPercent(value: bigint): string {
  return formatBps((value * 10_000n) / 1_000_000_000_000_000_000n);
}

function formatSignedDelta(value: bigint): string {
  if (value > 0n) return `+${value.toString()}`;
  return value.toString();
}

function parseIntegerInput(value: string): number | null {
  const trimmed = value.trim();

  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);

  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePercentToBps(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return bps <= 10_000n ? bps : null;
}

function sumBigints(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function sumPositionLiquidity(positions: readonly PositionRow[]): bigint {
  return positions.reduce((total, position) => total + BigInt(position.liquidity), 0n);
}

function sumLiveBalanceRows(rows: readonly PositionBurnLiveBalanceRow[]): bigint {
  return rows.reduce((total, row) => {
    if (row.balance === null || row.balance === undefined) return total;

    return total + BigInt(row.balance);
  }, 0n);
}

function positionSelectionKey(positions: readonly PositionRow[]): string {
  return positions.map((position) => `${position.id}:${position.binId}:${position.liquidity}`).join("|");
}

function indexerSubmissionFreshnessError(snapshot: AppSnapshot | undefined, queryErrored = false): string | null {
  if (queryErrored) return "Indexer freshness check failed";
  if (snapshot?.indexer.hasIndexingErrors) return "Indexer reports indexing errors";
  if (snapshot?.indexer.status === "error") return snapshot.indexer.message ?? "Indexer freshness check failed";
  if (snapshot?.indexer.status === "stale") return "Indexer is stale";

  return null;
}

function ownerPositionPaginationError(
  positions: PaginatedRows<PositionRow> | undefined,
  queryErrored: boolean
): string | null {
  if (queryErrored || positions?.pageInfo.failed) return "Position data is partial";
  if (positions?.pageInfo.capped) return "Position data is capped";

  return null;
}

function portfolioExitIntentError({
  action,
  owner,
  pair,
  portfolio,
  portfolioQueryError,
  portfolioQueryLoading,
  positions,
  removePercentBps,
  selectedPositions,
  snapshot
}: {
  action: "add" | "partial" | "full" | null;
  owner: Address | null;
  pair: Address | null;
  portfolio: WalletPortfolioPage | undefined;
  portfolioQueryError: boolean;
  portfolioQueryLoading: boolean;
  positions: PaginatedRows<PositionRow> | undefined;
  removePercentBps: bigint | null;
  selectedPositions: readonly PositionRow[];
  snapshot: AppSnapshot | undefined;
}): string | null {
  if (action !== "partial" && action !== "full") return null;
  if (portfolioQueryError) return "Portfolio exit verification failed";
  if (portfolioQueryLoading || portfolio === undefined || positions === undefined) return "Verifying the exact portfolio exit bin set";
  if (owner === null || pair === null) return "Portfolio exit identity is unavailable";
  const head = snapshot?.runtime.blockNumber ?? null;
  if (
    head === null ||
    snapshot?.runtime.status !== "ready" ||
    snapshot.indexer.hasIndexingErrors ||
    snapshot.indexer.status === "error" ||
    snapshot.indexer.status === "stale" ||
    snapshot.indexer.status === "loading" ||
    snapshot.indexer.status === "unavailable" ||
    snapshot.indexer.blockNumber !== head ||
    !portfolio.health.fresh ||
    portfolio.health.headBlock !== head
  ) {
    return "Portfolio exits require analytics, indexer, and RPC at the exact same head";
  }
  if (portfolio.pageInfo.hasNextPage) return "Portfolio exit verification is capped";
  const intended = portfolio.positions.find(
    (position) => position.owner.toLowerCase() === owner.toLowerCase() && position.pair.toLowerCase() === pair.toLowerCase()
  );
  if (intended === undefined || intended.asOfBlock !== head) {
    return "The exact head-pinned portfolio position is unavailable";
  }
  if (intended.bins.some((bin) => BigInt(bin.liquidity) > 0n && bin.asOfBlock !== head)) {
    return "The portfolio contains bins that are not pinned at the exact analytics head";
  }
  const intendedBins = intended.bins
    .filter((bin) => BigInt(bin.liquidity) > 0n)
    .map((bin) => `${BigInt(bin.binId).toString()}:${BigInt(bin.liquidity).toString()}`)
    .sort();
  const indexedBins = positions.rows
    .filter((position) => BigInt(position.liquidity) > 0n)
    .map((position) => `${BigInt(position.binId).toString()}:${BigInt(position.liquidity).toString()}`)
    .sort();
  if (!sameStringArray(intendedBins, indexedBins)) {
    return "Portfolio exit bin set does not match the exact analytics position; refresh indexing before withdrawing";
  }
  const selectedBins = selectedPositions
    .filter((position) => BigInt(position.liquidity) > 0n)
    .map((position) => `${BigInt(position.binId).toString()}:${BigInt(position.liquidity).toString()}`)
    .sort();
  if (!sameStringArray(intendedBins, selectedBins)) {
    return "Portfolio exits must keep every intended position bin selected";
  }
  if (action === "full" && removePercentBps !== 10_000n) {
    return "Full exit requires removing exactly 100% of every intended bin";
  }
  return null;
}

function positionBurnSubmissionError(plan: PositionBurnPlanResult): string | null {
  if (plan.blocked) return plan.blockers[0]?.message ?? "Selected position burn plan is blocked";

  return plan.warnings[0] ?? null;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function liquidityButtonLabel({
  connected,
  insufficientBalance,
  insufficientGas,
  invalidInput,
  needsApproval,
  onWrongChain,
  poolReady,
  ready,
  walletReadErrored,
  walletReadsReady
}: {
  connected: boolean;
  insufficientBalance: boolean;
  insufficientGas: boolean;
  invalidInput: boolean;
  needsApproval: boolean;
  onWrongChain: boolean;
  poolReady: boolean;
  ready: boolean;
  walletReadErrored: boolean;
  walletReadsReady: boolean;
}): string {
  if (!poolReady) return "Unavailable";
  if (!connected) return "Connect wallet";
  if (onWrongChain) return "Switch network";
  if (invalidInput) return "Check range";
  if (walletReadErrored) return "Wallet read failed";
  if (!walletReadsReady) return "Loading wallet";
  if (insufficientBalance) return "Insufficient balance";
  if (insufficientGas) return "Insufficient ETH for gas";
  if (needsApproval) return "Approve first";
  if (!ready) return "Invalid range";

  return "Add liquidity";
}

function removeButtonLabel({
  connected,
  fullExit,
  hasPosition,
  insufficientGas,
  invalidInput,
  needsApproval,
  onWrongChain,
  poolReady
}: {
  connected: boolean;
  fullExit: boolean;
  hasPosition: boolean;
  insufficientGas: boolean;
  invalidInput: boolean;
  needsApproval: boolean;
  onWrongChain: boolean;
  poolReady: boolean;
}): string {
  if (!poolReady) return "Unavailable";
  if (!connected) return "Connect wallet";
  if (onWrongChain) return "Switch network";
  if (!hasPosition) return "No position";
  if (invalidInput) return "Check remove";
  if (needsApproval) return "Approve LB first";
  if (insufficientGas) return "Insufficient ETH for gas";

  return fullExit ? "Full exit" : "Withdraw liquidity";
}

function PositionsView({
  environmentKey,
  positionDetailId,
  snapshot
}: {
  environmentKey: EnvironmentKey;
  positionDetailId: string | null;
  snapshot: AppSnapshot | undefined;
}) {
  const account = useAccount();
  const walletChainId = useChainId();
  const registry = registries[environmentKey];
  const portfolioEndpoint = analyticsEndpointForRegistry(registry);
  const connected = account.status === "connected" && account.address !== undefined;
  const onWrongChain = connected && walletChainId !== registry.chainId;
  const portfolioQuery = useQuery({
    queryKey: ["walletPortfolio", environmentKey, registry.chainId, portfolioEndpoint, account.address],
    queryFn: () => {
      if (!account.address || !portfolioEndpoint) throw new Error("Analytics portfolio is unavailable");
      return loadWalletPortfolio(portfolioEndpoint, account.address);
    },
    enabled: connected && !onWrongChain && portfolioEndpoint !== null,
    refetchInterval: connected && !onWrongChain && portfolioEndpoint !== null ? SNAPSHOT_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always"
  });
  const positions = (portfolioQuery.data?.positions ?? []).filter(
    (position) => account.address !== undefined && position.owner.toLowerCase() === account.address.toLowerCase()
  );
  const selectedPosition = positionDetailId === null
    ? null
    : positions.find((position) => portfolioPositionId(position) === positionDetailId) ?? null;
  const positionHistoryQuery = useQuery({
    queryKey: ["positionHistory", environmentKey, registry.endpoints.indexerUrl, account.address, selectedPosition?.pair],
    queryFn: () => {
      if (!account.address || !selectedPosition) throw new Error("Position history is unavailable");
      return loadPositionHistory(registry, account.address, selectedPosition.pair as Address);
    },
    enabled: connected && !onWrongChain && selectedPosition !== null && registry.endpoints.indexerUrl !== null,
    retry: false
  });

  if (!connected) {
    return <PortfolioState title="Connect your wallet" body="Your Feather positions are owner-scoped. Connect a wallet to load them; no global holder balances are shown." />;
  }
  if (onWrongChain) {
    return <PortfolioState title="Switch network" body={`Your wallet must be on chain ${registry.chainId} before portfolio balances can be pinned and valued.`} />;
  }
  if (portfolioEndpoint === null) {
    return <PortfolioState title="Portfolio analytics unavailable" body="This environment has no configured analytics endpoint. Raw global indexer positions are intentionally not shown as your portfolio." />;
  }
  if (portfolioQuery.isLoading) {
    return <PortfolioState title="Loading your portfolio" body="Pinning owner balances and per-bin claims at the current analytics head." />;
  }
  if (portfolioQuery.isError) {
    return <PortfolioState title="Portfolio request failed" body={portfolioQuery.error.message} tone="error" />;
  }
  if (positionDetailId !== null && selectedPosition === null) {
    return <PortfolioState title="Position not found" body="This owner-scoped position is unavailable, transferred, or outside complete indexed history." backHref="#/positions" />;
  }

  const displayed = selectedPosition ? [selectedPosition] : positions;
  const analyticsHeadPinned =
    portfolioQuery.data?.health.status === "READY" &&
    portfolioQuery.data.health.fresh &&
    portfolioQuery.data.health.headBlock !== null &&
    portfolioQuery.data.health.headBlock === snapshot?.runtime.blockNumber;
  const historyPartial =
    selectedPosition !== null &&
    (positionHistoryQuery.isError ||
      positionHistoryQuery.data?.pageInfo.failed === true ||
      positionHistoryQuery.data?.pageInfo.capped === true);
  const portfolioPartial =
    portfolioQuery.data?.pageInfo.partial === true ||
    portfolioQuery.data?.pageInfo.hasNextPage === true ||
    displayed.some((position) => position.status !== "READY") ||
    !analyticsHeadPinned ||
    displayed.some((position) => !portfolioPositionHeadPinned(position, snapshot, portfolioQuery.data?.health.headBlock ?? null)) ||
    historyPartial ||
    snapshot?.indexer.status === "partial" ||
    snapshot?.indexer.status === "stale";

  return (
    <div className="view-grid portfolio-view" data-testid="wallet-portfolio">
      <section className="table-panel">
        <div className="panel-heading">
          <span>{selectedPosition ? "Position detail" : "Your portfolio"}</span>
          <StatusBadge
            state={portfolioPartial ? "partial" : displayed.length > 0 ? "ready" : "empty"}
            label={portfolioPartial ? "partial data" : `${displayed.length} ${displayed.length === 1 ? "position" : "positions"}`}
          />
        </div>
        {selectedPosition ? <a className="text-link" href="#/positions">← All positions</a> : null}
        {portfolioPartial ? (
          <p className="portfolio-warning" role="status">
            Some history, pricing, or head-pinned claims are partial. Known values remain visible; unavailable P&amp;L is never displayed as zero.
          </p>
        ) : null}
        {displayed.length > 0 ? (
          <div className="portfolio-list">
            {displayed.map((position) => (
              <PortfolioPositionCard
                detail={selectedPosition !== null}
                headPinned={portfolioPositionHeadPinned(position, snapshot, portfolioQuery.data?.health.headBlock ?? null)}
                history={selectedPosition !== null ? positionHistoryQuery.data?.rows ?? [] : []}
                historyError={selectedPosition !== null && positionHistoryQuery.isError ? positionHistoryQuery.error.message : positionHistoryQuery.data?.pageInfo.error ?? null}
                historyLoading={selectedPosition !== null && positionHistoryQuery.isLoading}
                historyPartial={selectedPosition !== null && (positionHistoryQuery.data?.pageInfo.capped === true || positionHistoryQuery.data?.pageInfo.failed === true)}
                key={portfolioPositionId(position)}
                pool={snapshot?.indexer.pools.find((pool) => pool.id.toLowerCase() === position.pair.toLowerCase() || pool.address.toLowerCase() === position.pair.toLowerCase()) ?? null}
                position={position}
                rangePinned={position.asOfBlock !== null && position.asOfBlock === snapshot?.indexer.blockNumber && snapshot?.indexer.status === "ready"}
              />
            ))}
          </div>
        ) : (
          <PortfolioState title="No positions yet" body="This connected wallet has no indexed LB balances. Add liquidity to create a position." />
        )}
      </section>
    </div>
  );
}

function PortfolioPositionCard({
  detail,
  headPinned,
  history,
  historyError,
  historyLoading,
  historyPartial,
  pool,
  position,
  rangePinned
}: {
  detail: boolean;
  headPinned: boolean;
  history: PositionHistoryRow[];
  historyError: string | null;
  historyLoading: boolean;
  historyPartial: boolean;
  pool: PoolRow | null;
  position: PortfolioPositionRow;
  rangePinned: boolean;
}) {
  const binIds = position.bins.map((bin) => BigInt(bin.binId)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const minBin = binIds.at(0) ?? null;
  const maxBin = binIds.at(-1) ?? null;
  const activeId = pool?.activeId === null || pool?.activeId === undefined ? null : BigInt(pool.activeId);
  const inRange = rangePinned && activeId !== null && minBin !== null && maxBin !== null ? activeId >= minBin && activeId <= maxBin : null;
  const amountX = sumNullablePortfolioAmounts(position.bins.map((bin) => bin.amountX));
  const amountY = sumNullablePortfolioAmounts(position.bins.map((bin) => bin.amountY));
  const id = portfolioPositionId(position);
  const transferredOrPartial = position.costBasisUsdE18 === null;
  const hasBalance = position.bins.some((bin) => BigInt(bin.liquidity) > 0n);

  return (
    <article className="portfolio-card" data-testid="portfolio-position-card">
      <div className="portfolio-card-heading">
        <div>
          <strong>{pool ? `${tokenSymbol(pool.tokenX)} / ${tokenSymbol(pool.tokenY)}` : formatCompactAddress(position.pair)}</strong>
          <span>{position.bins.length} bins · {minBin === null ? "range unavailable" : `${minBin.toString()}–${maxBin?.toString()}`}</span>
        </div>
        <StatusBadge state={position.status === "READY" ? "ready" : "partial"} label={inRange === null ? "range unknown" : inRange ? "in range" : "out of range"} />
      </div>

      <dl className="portfolio-metrics">
        <div><dt>Current value</dt><dd>{formatUsdE18(position.currentValueUsdE18)}</dd></div>
        <div><dt>Cost basis</dt><dd>{formatUsdE18(position.costBasisUsdE18)}</dd></div>
        <div><dt>Unrealized P&amp;L</dt><dd>{formatUsdE18(position.unrealizedPnlUsdE18)}</dd></div>
        <div><dt>Realized P&amp;L</dt><dd>{formatUsdE18(position.realizedPnlUsdE18)}</dd></div>
        <div><dt>{tokenSymbol(pool?.tokenX ?? null)} claim</dt><dd>{formatPortfolioTokenAmount(amountX, pool?.tokenX ?? null)}</dd></div>
        <div><dt>{tokenSymbol(pool?.tokenY ?? null)} claim</dt><dd>{formatPortfolioTokenAmount(amountY, pool?.tokenY ?? null)}</dd></div>
      </dl>

      {detail ? (
        <div className="position-bin-history">
          <h3>Bin balances</h3>
          {position.bins.map((bin) => (
            <div className="position-bin-row" key={bin.binId}>
              <span>Bin {bin.binId}</span>
              <span>{formatPortfolioTokenAmount(bin.amountX, pool?.tokenX ?? null)}</span>
              <span>{formatPortfolioTokenAmount(bin.amountY, pool?.tokenY ?? null)}</span>
              <span>{formatUsdE18(bin.currentValueUsdE18)}</span>
            </div>
          ))}
          <h3>Liquidity history</h3>
          {historyLoading ? <p>Loading owner/pair deposits and withdrawals…</p> : null}
          {historyError ? <p className="portfolio-warning">History is partial: {historyError}</p> : null}
          {historyPartial ? <p className="portfolio-warning">Only the available indexed history is shown.</p> : null}
          {!historyLoading && historyError === null && history.length === 0 ? <p>No indexed deposits or withdrawals were found for this owner and pair.</p> : null}
          {history.map((event) => (
            <div className="position-history-row" data-testid="position-history-row" key={event.id}>
              <strong>{event.type}</strong>
              <span>{formatPortfolioHistoryTime(event.timestamp)}</span>
              <span>{event.amountX === null && event.amountY === null
                ? `Bins ${event.binIds.join(", ")}`
                : `${formatPortfolioTokenAmount(event.amountX, pool?.tokenX ?? null)} · ${formatPortfolioTokenAmount(event.amountY, pool?.tokenY ?? null)}`}</span>
              <span>Block {event.blockNumber} · {formatCompactAddress(event.transactionHash)}</span>
            </div>
          ))}
          <h3>Accounting summary</h3>
          <p>Deposited cost basis: {formatUsdE18(position.costBasisUsdE18)} · Realized P&amp;L: {formatUsdE18(position.realizedPnlUsdE18)}.</p>
        </div>
      ) : null}

      <p className="position-accounting-note">
        {!hasBalance
          ? "This position has no remaining LB balance and may have been fully transferred or exited."
          : transferredOrPartial
          ? "Cost basis is unavailable because the position was transferred or its history is partial."
          : "Fee growth is already reflected in the position's token claims and value; there is no separate fee-claim action."}
      </p>
      <p className="position-freshness">Claims pinned at {position.asOfBlock ? `block ${position.asOfBlock}` : "an unavailable head"}. {headPinned ? "Analytics, indexer, and RPC heads match." : "Analytics, indexer, and RPC heads are reconciling; withdrawal actions are disabled."}</p>

      <div className="portfolio-actions">
        {!detail ? <a className="secondary-button" href={`#/positions/${encodeURIComponent(id)}`}>Details</a> : null}
        <a className="secondary-button" href={`#/liquidity/add/${encodeURIComponent(position.pair)}`}>Add liquidity</a>
        {headPinned && hasBalance ? <a className="secondary-button" href={`#/liquidity/partial/${encodeURIComponent(position.pair)}`}>Partial withdraw</a> : null}
        {headPinned && hasBalance ? <a className="primary-button" href={`#/liquidity/full/${encodeURIComponent(position.pair)}`}>Full exit</a> : null}
      </div>
    </article>
  );
}

function PortfolioState({ title, body, tone = "neutral", backHref }: { title: string; body: string; tone?: "neutral" | "error"; backHref?: string }) {
  return (
    <section className={`table-panel portfolio-state ${tone}`} data-testid="portfolio-state" role={tone === "error" ? "alert" : "status"}>
      <div className="panel-heading"><span>Positions</span><StatusBadge state={tone === "error" ? "error" : "empty"} label={tone === "error" ? "error" : "wallet scoped"} /></div>
      <strong>{title}</strong>
      <span>{body}</span>
      {backHref ? <a className="secondary-button" href={backHref}>Back to portfolio</a> : null}
    </section>
  );
}

function portfolioPositionId(position: Pick<PortfolioPositionRow, "owner" | "pair">): string {
  return `${position.owner.toLowerCase()}:${position.pair.toLowerCase()}`;
}

function portfolioPositionHeadPinned(
  position: PortfolioPositionRow,
  snapshot: AppSnapshot | undefined,
  analyticsHeadBlock: string | null
): boolean {
  return (
    position.asOfBlock !== null &&
    analyticsHeadBlock === position.asOfBlock &&
    snapshot?.runtime.status === "ready" &&
    snapshot.runtime.blockNumber === position.asOfBlock &&
    snapshot.indexer.status === "ready" &&
    snapshot.indexer.blockNumber === position.asOfBlock
  );
}

function formatPortfolioHistoryTime(timestamp: string): string {
  const milliseconds = Number(timestamp) * 1_000;
  if (!Number.isFinite(milliseconds)) return "Time unavailable";
  return new Date(milliseconds).toLocaleString();
}

function sumNullablePortfolioAmounts(values: Array<string | null>): string | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce((sum, value) => sum + BigInt(value ?? "0"), 0n).toString();
}

function formatPortfolioTokenAmount(value: string | null, token: TokenMetadata | null): string {
  return value === null ? "Unavailable" : `${formatTokenAmount(value, token)} ${tokenSymbol(token)}`;
}

function formatUsdE18(value: string | null): string {
  if (value === null) return "Unavailable";
  const formatted = formatUnits(BigInt(value), 18);
  const numeric = Number(formatted);
  return Number.isFinite(numeric) ? numeric.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }) : `$${formatted}`;
}

function ActivityView({ snapshot }: { snapshot: AppSnapshot | undefined }) {
  const activity = snapshot?.indexer.activity ?? [];

  return (
    <div className="view-grid">
      <section className="table-panel">
        <div className="panel-heading">
          <span>Activity</span>
          <StatusBadge
            state={hasPartialActivity(snapshot) ? "partial" : activity.length > 0 ? "ready" : snapshot?.indexer.status ?? "loading"}
            label={activityBadgeLabel(snapshot, activity.length)}
          />
        </div>
        {activity.length > 0 ? (
          <div className="activity-list">
            {activity.map((item) => (
              <div className="activity-item" key={item.id}>
                <div>
                  <strong>{item.type}</strong>
                  <span>{formatCompactAddress(item.transactionHash)}</span>
                </div>
                <div>
                  <small>Block {item.blockNumber}</small>
                  <small>{formatCompactAddress(item.account)}</small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState state={snapshot?.indexer.status ?? "loading"} />
        )}
      </section>
    </div>
  );
}

function StatusBadge({ state, label }: { state: LoadState; label: string }) {
  return <span className={`status-badge ${state}`}>{label}</span>;
}

function EmptyState({ state }: { state: LoadState }) {
  const Icon = state === "error" ? AlertTriangle : state === "loading" ? LoaderCircle : Server;
  const label =
    state === "unavailable"
      ? "No indexer configured"
      : state === "error"
        ? "Data unavailable"
        : state === "loading"
          ? "Loading"
          : state === "stale"
            ? "Indexer stale"
            : state === "partial"
              ? "Partial data"
              : state === "empty"
                ? "No indexed rows"
                : "No rows yet";

  return (
    <div className="empty-state">
      <Icon className={state === "loading" ? "spin" : undefined} size={22} />
      <span>{label}</span>
    </div>
  );
}

function paginationBadgeLabel(count: number, pageInfo: PaginationInfo, unit: string): string {
  return isPartialPagination(pageInfo) ? `${count}+ ${unit}` : `${count} ${unit}`;
}

function hasPartialActivity(snapshot: AppSnapshot | undefined): boolean {
  return Boolean(isPartialPagination(snapshot?.indexer.pagination.swaps) || isPartialPagination(snapshot?.indexer.pagination.liquidityEvents));
}

function activityBadgeLabel(snapshot: AppSnapshot | undefined, count: number): string {
  if (hasPartialActivity(snapshot)) return `${count}+ events`;
  const windowed = snapshot?.indexer.pagination.swaps.windowed || snapshot?.indexer.pagination.liquidityEvents.windowed;
  return windowed ? `Latest ${count} events` : `${count} events`;
}

function isPartialPagination(pageInfo: PaginationInfo | null | undefined): boolean {
  return Boolean(pageInfo?.capped || pageInfo?.failed);
}

function useHashRoute(): [
  RouteKey,
  (route: RouteKey) => void,
  string | null,
  "add" | "withdraw" | null,
  string | null,
  string | null,
  "add" | "partial" | "full" | null,
  PoolWorkspaceTask | null
] {
  const routeParts = () => window.location.hash.replace("#/", "").split("?", 1)[0].split("/");
  const readRoute = () => {
    const [next] = routeParts();
    if (next === "" && (window.location.hash === "" || window.location.hash === "#/")) return "home";
    return routes.some((route) => route.key === next) ? (next as RouteKey) : "swap";
  };
  const decodeRoutePart = (value: string | undefined): string | null => {
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  };
  const readPoolDetailId = () => {
    const [route, encodedPoolId] = routeParts();
    return route === "pools" ? decodeRoutePart(encodedPoolId) : null;
  };
  const readPositionDetailId = () => {
    const [route, encodedId] = routeParts();
    return route === "positions" ? decodeRoutePart(encodedId) : null;
  };
  const readLiquiditySection = (): "add" | "withdraw" | null => {
    const [route, section] = routeParts();
    if (route !== "liquidity") return null;
    return section === "add" ? "add" : section === "withdraw" || section === "partial" || section === "full" ? "withdraw" : null;
  };
  const readActionPoolId = () => {
    const [route, sectionOrPool, liquidityPool] = routeParts();
    const knownSection = sectionOrPool === "add" || sectionOrPool === "withdraw" || sectionOrPool === "partial" || sectionOrPool === "full";
    const encodedPoolId = route === "swap"
      ? sectionOrPool
      : route === "liquidity"
        ? liquidityPool ?? (knownSection ? undefined : sectionOrPool)
        : undefined;
    return decodeRoutePart(encodedPoolId);
  };
  const readPortfolioAction = (): "add" | "partial" | "full" | null => {
    const [route, action] = routeParts();
    return route === "liquidity" && (action === "add" || action === "partial" || action === "full") ? action : null;
  };
  const readWorkspaceTask = (): PoolWorkspaceTask | null => {
    const workspaceRoute = parsePoolWorkspaceRoute(window.location.hash);
    return workspaceRoute?.source === "canonical" ? workspaceRoute.task : null;
  };
  const [routeKey, setRouteKeyState] = useState<RouteKey>(readRoute);
  const [poolDetailId, setPoolDetailId] = useState<string | null>(readPoolDetailId);
  const [liquiditySection, setLiquiditySection] = useState<"add" | "withdraw" | null>(readLiquiditySection);
  const [actionPoolId, setActionPoolId] = useState<string | null>(readActionPoolId);
  const [positionDetailId, setPositionDetailId] = useState<string | null>(readPositionDetailId);
  const [portfolioAction, setPortfolioAction] = useState<"add" | "partial" | "full" | null>(readPortfolioAction);
  const [workspaceTask, setWorkspaceTask] = useState<PoolWorkspaceTask | null>(readWorkspaceTask);

  useEffect(() => {
    const listener = () => {
      setRouteKeyState(readRoute());
      setPoolDetailId(readPoolDetailId());
      setLiquiditySection(readLiquiditySection());
      setActionPoolId(readActionPoolId());
      setPositionDetailId(readPositionDetailId());
      setPortfolioAction(readPortfolioAction());
      setWorkspaceTask(readWorkspaceTask());
    };
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);

  const setRouteKey = (route: RouteKey) => {
    setRouteKeyState(route);
    setPoolDetailId(null);
    setLiquiditySection(null);
    setActionPoolId(null);
    setPositionDetailId(null);
    setPortfolioAction(null);
    setWorkspaceTask(null);
  };

  return [routeKey, setRouteKey, poolDetailId, liquiditySection, actionPoolId, positionDetailId, portfolioAction, workspaceTask];
}
