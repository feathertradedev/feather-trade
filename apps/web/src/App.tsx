import { QueryClient, QueryClientProvider, useQuery, type QueryObserverResult } from "@tanstack/react-query";
import { erc20Abi, lbPairAbi, lbRouterAbi } from "@robinhood-lb/sdk/abi";
import { createDexPublicClient } from "@robinhood-lb/sdk/client";
import {
  applyBurnQuoteSlippage,
  applyLiquiditySlippageMin,
  buildLiquidityDistribution,
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
  buildExactInSwapPath,
  calculateAmountOutMin,
  deadlineFromNow,
  estimatePriceImpactBps,
  getBestExactInQuote,
  getQuoteAmountOut,
  getTotalFeeBps,
  quoteToRouteSteps,
  type ExactInQuote
} from "@robinhood-lb/sdk/swap";
import { tokenAllowsAction, type TokenAction, type TokenMetadata } from "@robinhood-lb/sdk/tokens";
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
  Wallet
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { encodeFunctionData, isAddressEqual, keccak256, type Address, type Chain, formatUnits, parseUnits } from "viem";
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
  environmentOptions,
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
  loadPoolBinWindow,
  tokenSymbol,
  type AppSnapshot,
  type BinRow,
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
  parseDeadlineMinutes,
  parseIdSlippage,
  quoteIsStale,
  swapExecutionContextFingerprint,
  type BurnQuoteExecutionBinding,
  type SwapExecutionContext
} from "./transaction-safety";
import { wagmiConfig } from "./wagmi";
import { SUPPORTED_WALLET_RDNS, walletFailure, walletSessionIdentity, type WalletFailure } from "./wallet-lifecycle";
import { TransactionJournalProvider, useTransactionJournal, type TransactionJournalApi } from "./transaction-journal-react";
import { isUserRejectedSubmission, type ReviewedTransactionIntent } from "./transaction-journal";

const queryClient = new QueryClient();
const SNAPSHOT_REFRESH_INTERVAL_MS = 10_000;
const SWAP_QUOTE_REFRESH_INTERVAL_MS = 10_000;

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
  reviewed: ReviewedTransactionIntent;
  send: () => Promise<Address>;
}): Promise<Address | null> {
  const handle = await input.journal.begin(input.reviewed);
  if (!input.isCurrent()) {
    await input.journal.abort(handle);
    return null;
  }
  try {
    const hash = await input.send();
    try {
      await input.journal.submitted(handle, hash);
    } catch {
      throw new Error(`Wallet returned ${formatCompactAddress(hash)}, but durable hash persistence failed; retry remains blocked in this session`);
    }
    return hash;
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("durable hash persistence failed"))) {
      await input.journal.fail(handle, error);
    }
    throw error;
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
  const [environmentKey, setEnvironmentKey] = useState<EnvironmentKey>(defaultEnvironmentKey);
  const [routeKey, setRouteKey, poolDetailId, liquiditySection, actionPoolId, positionDetailId, portfolioAction] = useHashRoute();
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
  const transactionJournal = useTransactionJournal();
  const visibleJournalRecords = account.status === "connected" && account.address
    ? transactionJournal.records.filter((record) =>
        record.reviewed.account.toLowerCase() === account.address!.toLowerCase() &&
        record.reviewed.chainId === walletChainId &&
        record.reviewed.environment === environmentKey &&
        record.reviewed.deploymentEpoch === deploymentEpoch(registry))
    : [];
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
  }, [actionPoolId, liquiditySection, poolDetailId, portfolioAction, positionDetailId, routeKey]);

  if (routeKey === "home") {
    return <LandingView networkName={registry.chain.name} snapshot={snapshot} />;
  }

  return (
    <main className="shell app-shell">
      <header className="app-header">
        <BrandLockup />
        <nav className="nav-list" aria-label="Primary">
          {routes.filter((route) => ["swap", "pools", "positions"].includes(route.key)).map((route) => {
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
        </nav>
        <div className="app-header-actions">
          <a className="operations-quick-link" href="#/liquidity" aria-label="Liquidity" onClick={() => setRouteKey("liquidity")}>Manage</a>
          <details
            className="operations-menu"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.removeAttribute("open");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.removeAttribute("open");
                event.currentTarget.querySelector("summary")?.focus();
              }
            }}
          >
            <summary>Operations</summary>
            <div className="operations-popover">
              <a href="#/activity" onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                setRouteKey("activity");
              }}>Activity</a>
              <span>Runtime health is shown beside the environment selector.</span>
            </div>
          </details>
          <WalletPanel activeChain={registry.chain} key={walletPanelKey} />
        </div>
      </header>

      <section className="workspace">
        <header className="top-bar">
          <EnvironmentSwitch active={environmentKey} onChange={setEnvironmentKey} />
          <div className="top-actions">
            <div className="runtime-statuses" aria-label="Runtime health">
              <StatusPill icon={Network} label={runtimeChainLabel(registry.chainId, snapshot?.runtime.chainId ?? null)} state={snapshot?.runtime.status ?? "loading"} />
              <StatusPill icon={Server} label="Indexer" state={snapshot?.indexer.status ?? "loading"} />
            </div>
            <button
              className="icon-button"
              data-testid="snapshot-refresh-button"
              type="button"
              onClick={() => void snapshotQuery.refetch()}
              title="Refresh state"
            >
              <RefreshCw size={18} />
            </button>
          </div>
        </header>

        <section className="status-strip" aria-live="polite">
          <MetricTile label="Block" value={formatBlock(snapshot)} tone={snapshot?.runtime.status === "ready" ? "good" : "warn"} />
          <MetricTile label="Pools" value={formatPoolsMetric(snapshot)} tone={isPartialPagination(snapshot?.indexer.pagination.pools) ? "warn" : "neutral"} />
          <MetricTile label="Active Bin" value={formatActiveBin(snapshot)} tone="neutral" />
          <MetricTile label="Indexer Head" value={snapshot?.indexer.blockNumber ?? "offline"} tone={snapshot?.indexer.status === "ready" ? "good" : "warn"} />
        </section>
        {visibleJournalRecords.length > 0 ? (
          <details className="transaction-journal" data-testid="submitted-transaction-journal">
            <summary>Transaction history ({visibleJournalRecords.length})</summary>
            <div>
              {visibleJournalRecords.map((transaction) => (
                <span data-transaction-hash={transaction.activeHash ?? undefined} key={transaction.id}>
                  {transaction.reviewed.intent} · {transaction.activeHash ? formatCompactAddress(transaction.activeHash) : "hash pending"} · {transaction.status} · {formatCompactAddress(transaction.reviewed.account)} · {transaction.reviewed.environment} · chain {transaction.reviewed.chainId}
                </span>
              ))}
            </div>
          </details>
        ) : null}
        {snapshot?.indexer.message ? (
          <p
            className={`snapshot-message ${snapshot.indexer.status}`}
            data-testid="indexer-status-message"
            role={snapshot.indexer.status === "error" ? "alert" : "status"}
          >
            {snapshot.indexer.message}
          </p>
        ) : null}

          <ContentView
            key={walletSessionKey}
            environmentKey={environmentKey}
            actionPoolId={actionPoolId}
            liquiditySection={liquiditySection}
            poolDetailId={poolDetailId}
            portfolioAction={portfolioAction}
            positionDetailId={positionDetailId}
            routeKey={routeKey}
            snapshot={snapshot}
            snapshotState={snapshotQuery.isLoading ? "loading" : snapshotQuery.isError ? "error" : snapshot?.indexer.status ?? "loading"}
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

function LandingView({ networkName, snapshot }: { networkName: string; snapshot: AppSnapshot | undefined }) {
  const poolCount = snapshot?.indexer.pairCount;

  return (
    <main className="landing-shell">
      <header className="landing-header">
        <BrandLockup />
        <nav aria-label="Marketing">
          <a href="#/swap">Swap</a>
          <a href="#/pools">Pools</a>
          {brandLinks.filter((link) => link.label === "Docs").map((link) => (
            <a href={link.href} key={link.label} rel="noreferrer" target="_blank">{link.label}</a>
          ))}
        </nav>
        <a className="primary-button landing-launch" href="#/swap">Launch app</a>
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <p className="eyebrow">The featherweight DEX · Built for Robinhood Chain</p>
        <h1 id="landing-title">Weightless<br />liquidity.</h1>
        <p>Concentrated DLMM liquidity with dynamic fees that rise when markets move. Engineered without the weight.</p>
        <div className="hero-actions">
          <a className="primary-button" href="#/swap">Launch app</a>
          {brandLinks.filter((link) => link.label === "Docs").map((link) => (
            <a className="secondary-button" href={link.href} key={link.label} rel="noreferrer" target="_blank">Read the docs</a>
          ))}
        </div>
        <dl className="landing-stats" aria-label="Protocol overview">
          <div><dt>Network</dt><dd>{networkName}</dd></div>
          <div><dt>Indexed pools</dt><dd>{poolCount ?? "—"}</dd></div>
          <div><dt>Liquidity model</dt><dd>DLMM</dd></div>
          <div><dt>LP fees</dt><dd className="positive">Dynamic</dd></div>
        </dl>
      </section>

      <section className="landing-pillars" aria-label="Product pillars">
        <article>
          <BinGlyph mode="spot" />
          <h2>Liquidity in bins</h2>
          <p>Place capital exactly where trading happens. Zero slippage inside the active bin; nothing wasted outside your range.</p>
        </article>
        <article>
          <p className="fee-surge">0.20% → <span>2.41%</span></p>
          <h2>Fees that surge with volatility</h2>
          <p>Dynamic fees climb when price moves fast, paying LPs for the risk they take and settling back when it is quiet.</p>
        </article>
        <article>
          <div className="chain-glyph"><span /></div>
          <h2>Built for Robinhood Chain</h2>
          <p>Built for fast finality, small network fees, and a first-class onchain trading experience.</p>
        </article>
      </section>

      <section className="strategy-band">
        <div>
          <p className="eyebrow">For liquidity providers</p>
          <h2>Three strategies. One slider.</h2>
          <p>Spot, Curve, or Bid-Ask — shape liquidity to your view, set a range, done.</p>
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
        <span>engineered on robinhood chain · 2026</span>
      </footer>
    </main>
  );
}

function BinGlyph({ mode }: { mode: "spot" | "curve" | "bidask" }) {
  const heights = mode === "spot" ? [18, 28, 34, 28, 18] : mode === "curve" ? [12, 20, 34, 20, 12] : [30, 18, 10, 18, 30];
  return <span className={`bin-glyph ${mode}`} aria-hidden="true">{heights.map((height, index) => <i key={index} style={{ height }} />)}</span>;
}

function EnvironmentSwitch({
  active,
  onChange
}: {
  active: EnvironmentKey;
  onChange: (environment: EnvironmentKey) => void;
}) {
  return (
    <div className="segmented" role="tablist" aria-label="Environment">
      {environmentOptions.map((option) => (
        <button
          className={active === option.key ? "segment active" : "segment"}
          key={option.key}
          onClick={() => onChange(option.key)}
          type="button"
        >
          <span>{option.label}</span>
          <span className={option.tone === "ready" ? "dot ready" : "dot dry"} />
        </button>
      ))}
    </div>
  );
}

function WalletPanel({ activeChain }: { activeChain: Chain }) {
  const [localFailure, setLocalFailure] = useState<WalletFailure | null>(null);
  const [discoverySettled, setDiscoverySettled] = useState(false);
  const account = useAccount();
  const activeWalletChainId = useChainId();
  const { connect, connectors, error: connectError, isPending, reset: resetConnect } = useConnect();
  const { disconnect } = useDisconnect();
  const { error: switchError, switchChain, isPending: isSwitching, reset: resetSwitch } = useSwitchChain();
  const discoveredConnectors = connectors.filter((connector) => connector.id !== "injected");
  const supportedDiscoveredConnectors = discoveredConnectors.filter(
    (connector, index, all) => SUPPORTED_WALLET_RDNS.has(connector.id) && all.findIndex((candidate) => candidate.id === connector.id) === index
  );
  const availableConnectors = discoveredConnectors.length > 0 ? supportedDiscoveredConnectors : connectors;
  const injectedConnector = availableConnectors[0];
  const connected = account.status === "connected";
  const onWrongChain = connected && activeWalletChainId !== activeChain.id;
  const unsupportedProviderFailure: WalletFailure | null =
    discoveredConnectors.length > 0 && supportedDiscoveredConnectors.length === 0
      ? { action: "No supported wallet was found. Enable MetaMask or Brave Wallet, then reload this page.", kind: "missing" }
      : null;
  const noProviderFailure: WalletFailure | null = discoverySettled && connectors.length === 0
    ? { action: "No wallet provider was found. Enable MetaMask or Brave Wallet, then reload this page.", kind: "missing" }
    : null;
  const connectionFailure = localFailure ?? (connectError ? walletFailure(connectError, "connect") : unsupportedProviderFailure ?? noProviderFailure);
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

  if (!connected) {
    return (
      <div className="wallet-cluster" data-testid="wallet-disconnected-state">
        {availableConnectors.length > 1 ? (
          <div className="wallet-provider-choices" data-testid="wallet-provider-choices" role="group" aria-label="Choose wallet provider">
            {availableConnectors.map((connector) => (
              <button
                className="secondary-button"
                data-provider-id={connector.id}
                disabled={isPending}
                key={connector.uid}
                onClick={() => void connectWith(connector)}
                type="button"
              >
                <Wallet size={18} />
                <span>{isPending ? "Connecting" : connector.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <button
            className="primary-button"
            data-testid="wallet-connect-button"
            disabled={!injectedConnector || isPending}
            onClick={() => injectedConnector && void connectWith(injectedConnector)}
            type="button"
          >
            {isPending ? <LoaderCircle className="spin" size={18} /> : <Wallet size={18} />}
            <span>{injectedConnector ? "Connect" : "No wallet"}</span>
          </button>
        )}
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
  environmentKey,
  liquiditySection,
  poolDetailId,
  portfolioAction,
  positionDetailId,
  routeKey,
  snapshot,
  snapshotState,
  onRefresh
}: {
  actionPoolId: string | null;
  environmentKey: EnvironmentKey;
  liquiditySection: "add" | "withdraw" | null;
  poolDetailId: string | null;
  portfolioAction: "add" | "partial" | "full" | null;
  positionDetailId: string | null;
  routeKey: RouteKey;
  snapshot: AppSnapshot | undefined;
  snapshotState: LoadState;
  onRefresh: SnapshotRefetch;
}) {
  const pools = snapshot?.indexer.pools ?? [];
  const [selectedPoolId, setSelectedPoolId] = useState("");
  const poolIdsKey = pools.map((pool) => pool.id).join("|");
  const defaultPool = selectDefaultIndexedPool(pools);
  const dashboardActionPool =
    actionPoolId === null
      ? null
      : pools.find(
          (pool) =>
            pool.id.toLowerCase() === actionPoolId.toLowerCase() ||
            pool.address.toLowerCase() === actionPoolId.toLowerCase()
        ) ?? null;
  const directActionPoolQuery = useQuery({
    queryKey: ["actionPoolById", environmentKey, actionPoolId, registries[environmentKey].endpoints.indexerUrl],
    queryFn: () => {
      if (actionPoolId === null) throw new Error("Action pool ID is unavailable");
      return loadPoolById(registries[environmentKey], actionPoolId);
    },
    enabled:
      actionPoolId !== null && dashboardActionPool === null && registries[environmentKey].endpoints.indexerUrl !== null,
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
  const directPoolQuery = useQuery({
    queryKey: ["poolById", environmentKey, poolDetailId, registries[environmentKey].endpoints.indexerUrl],
    queryFn: () => {
      if (poolDetailId === null) throw new Error("Pool ID is unavailable");
      return loadPoolById(registries[environmentKey], poolDetailId);
    },
    enabled:
      routeKey === "pools" &&
      poolDetailId !== null &&
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

      return selectDefaultIndexedPool(pools)?.id ?? "";
    });
  }, [actionPool, environmentKey, poolIdsKey]);

  const handleSelectedPoolChange = (poolId: string) => {
    setSelectedPoolId(poolId);

    if (actionPoolId === null) return;

    const encodedPoolId = encodeURIComponent(poolId);
    window.location.hash =
      routeKey === "liquidity"
        ? `#/liquidity/${liquiditySection ?? "add"}/${encodedPoolId}`
        : `#/swap/${encodedPoolId}`;
  };

  if ((routeKey === "swap" || routeKey === "liquidity") && actionPoolId !== null && actionPool === null) {
    const actionPoolState: LoadState = registries[environmentKey].endpoints.indexerUrl === null
      ? "unavailable"
      : directActionPoolQuery.isError
        ? "error"
        : directActionPoolQuery.isLoading
          ? "loading"
          : "empty";
    return (
      <RequestedPoolState
        error={directActionPoolQuery.error}
        poolId={actionPoolId}
        state={actionPoolState}
      />
    );
  }

  if (routeKey === "swap") {
    return (
      <SwapView
        environmentKey={environmentKey}
        onRefresh={onRefresh}
        onSelectedPoolChange={handleSelectedPoolChange}
        poolOptions={actionPoolOptions}
        primaryPool={selectedPool}
        selectedPoolId={selectedPool?.id ?? ""}
        snapshot={snapshot}
      />
    );
  }

  if (routeKey === "pools") {
    if (poolDetailId !== null) {
      const detailPool = dashboardDetailPool ?? directPoolQuery.data ?? null;
      const detailState: LoadState = detailPool !== null
        ? snapshotState
        : directPoolQuery.isLoading
          ? "loading"
          : directPoolQuery.isError
            ? "error"
            : directPoolQuery.data === null
              ? "empty"
              : snapshotState;
      return (
        <PoolDetailView
          environmentKey={environmentKey}
          onSelectPool={setSelectedPoolId}
          pool={detailPool ?? null}
          poolDetailId={poolDetailId}
          snapshotState={detailState}
        />
      );
    }

    return <PoolsView pools={pools} snapshot={snapshot} snapshotState={snapshotState} />;
  }

  if (routeKey === "liquidity") {
    return (
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
    );
  }

  if (routeKey === "positions") {
    return <PositionsView environmentKey={environmentKey} positionDetailId={positionDetailId} snapshot={snapshot} />;
  }

  return <ActivityView snapshot={snapshot} />;
}

function RequestedPoolState({ error, poolId, state }: { error: Error | null; poolId: string; state: LoadState }) {
  return (
    <div className="view-grid">
      <section className="table-panel" data-testid="requested-pool-state">
        <div className="panel-heading">
          <span>Resolving requested pool</span>
          <StatusBadge state={state} label={formatCompactAddress(poolId)} />
        </div>
        <EmptyState state={state} />
        {error ? <p className="inline-error">{getWriteError(error) ?? "Requested pool lookup failed"}</p> : null}
        {state === "empty" ? <p className="inline-error">The requested pool was not found.</p> : null}
      </section>
    </div>
  );
}

function selectDefaultIndexedPool(pools: PoolRow[]): PoolRow | null {
  return (
    pools.find((pool) => poolHasSwapLiquidity(pool) && poolSupportsCoreActions(pool)) ??
    pools.find((pool) => poolSupportsCoreActions(pool)) ??
    pools.find((pool) => poolHasSwapLiquidity(pool)) ??
    pools.at(0) ??
    null
  );
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
  const [amount, setAmount] = useState("1.0");
  const [swapForY, setSwapForY] = useState(true);
  const [slippageInput, setSlippageInput] = useState("0.5");
  const [deadlineInput, setDeadlineInput] = useState("20");
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
  const [handledApprovalHash, setHandledApprovalHash] = useState<Address | null>(null);
  const [handledSwapHash, setHandledSwapHash] = useState<Address | null>(null);
  const [submittedApprovalReceiptContext, setSubmittedApprovalReceiptContext] = useState<string | null>(null);
  const [submittedSwapReceiptContext, setSubmittedSwapReceiptContext] = useState<string | null>(null);
  const transactionJournal = useTransactionJournal();
  const registry = registries[environmentKey];
  const localnetRegistry = isLocalnetRegistry(registry) ? registry : null;
  const account = useAccount();
  const activeWalletChainId = useChainId();
  const approvalWrite = useWriteContract();
  const swapWrite = useWriteContract();
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
  const parsedAmount = parseTokenAmountInput(amount, tokenIn?.decimals ?? 18);
  const slippageBps = parseSlippageToBps(slippageInput);
  const deadlineMinutes = parseDeadlineMinutes(deadlineInput);
  const publicClient = useMemo(() => createDexPublicClient(registry.chain, registry.endpoints.rpcUrl), [registry]);
  const connected = account.status === "connected" && account.address !== undefined;
  const onWrongChain = connected && activeWalletChainId !== registry.chainId;
  const rpcReady = runtimeIsReady(snapshot, registry.chainId);
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
    rpcChainId: snapshot?.runtime.chainId ?? null,
    slippageBps: slippageBps?.toString() ?? null,
    tokenIn: tokenInAddress,
    tokenOut: tokenOutAddress,
    updatedAtBlock: primaryPool?.updatedAtBlock ?? null,
    walletAddress: account.address ?? null,
    walletChainId: activeWalletChainId
  };
  const swapContextFingerprint = swapExecutionContextFingerprint(swapExecutionContext);
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

      const quote = await getBestExactInQuote(publicClient, registry, tokenInAddress, tokenOutAddress, parsedAmount);

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
    queryKey: ["swapWallet", registry.chainId, tokenInAddress, account.address, approvalConfirmationKey],
    queryFn: async () => {
      if (tokenInAddress === null || !account.address) {
        throw new Error("Wallet reads are not available");
      }

      const [balance, allowance, nativeBalance] = await Promise.all([
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
        }),
        publicClient.getBalance({ address: account.address })
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
  const needsApproval = parsedAmount !== null && walletAllowance !== null && walletAllowance < parsedAmount;
  const insufficientBalance = parsedAmount !== null && walletBalance !== null && walletBalance < parsedAmount;
  const expectedOutLabel = amountOut !== null ? formatTokenAmount(amountOut.toString(), tokenOut) : "n/a";
  const feeLabel = exactQuote ? formatBps(getTotalFeeBps(exactQuote)) : "n/a";
  const priceImpactLabel = priceImpactBps !== null ? formatBps(priceImpactBps) : "n/a";
  const quoteFreshnessLabel = formatQuoteFreshness(quoteUpdatedAt, safetyNow);
  const approvalReceiptMatchesCurrentIntent = submittedApprovalReceiptContext === approvalIntentFingerprint;
  const swapReceiptMatchesCurrentIntent = submittedSwapReceiptContext === swapContextFingerprint;
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
    amount.trim().length > 0 && parsedAmount === null
      ? "Enter a valid token amount"
      : parsedAmount === 0n
        ? "Enter an amount greater than zero"
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
    swapSubmitInFlight.current = true;
    swapWrite.reset();
    setSubmittedSwapReceiptContext(null);
    setGasReviewError(null);
    try {

    const simulatedContextFingerprint = swapContextFingerprint;
    const simulatedQuoteIdentity = swapQuoteIdentity;
    const operationGeneration = swapOperationGeneration.current;
    const deadline = deadlineFromNow(deadlineMinutes);
    const args = [
      parsedAmount,
      amountOutMin,
      buildExactInSwapPath(exactQuote),
      account.address,
      deadline
    ] as const;
    const simulated = await runPreSubmitSimulation(
      () =>
        publicClient.simulateContract({
          account: account.address,
          address: registry.contracts.lbRouter,
          abi: lbRouterAbi,
          functionName: "swapExactTokensForTokens",
          args
        }),
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
    const gasApproved = await reviewExactGas({
      action: "swap",
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
    const submittedContext = {
      account: account.address,
      calldataFingerprint: keccak256(encodeFunctionData({ abi: lbRouterAbi, functionName: "swapExactTokensForTokens", args })),
      chainId: activeWalletChainId,
      deploymentEpoch: deploymentEpoch(registry),
      environment: environmentKey,
      executionFingerprint: simulatedContextFingerprint,
      intent: "swap" as const,
      providerId: account.connector?.id ?? "unknown",
      providerUid: account.connector?.uid ?? "unknown",
      submittedAt: Date.now(),
      target: registry.contracts.lbRouter,
      value: 0n
    };
    try {
      setSubmittedSwapReceiptContext(simulatedContextFingerprint);
      await submitJournaledTransaction({
        isCurrent: gasReviewIsCurrent,
        journal: transactionJournal,
        reviewed: reviewedTransactionIntent(submittedContext, {
          poolId: (primaryPool?.id ?? selectedPoolId) || null,
          recipient: account.address,
          refundRecipient: null,
          settingsFingerprint: approvalIntentFingerprint
        }),
        send: () => swapWrite.writeContractAsync(simulated.request)
      });
    } catch (error) {
      if (!isUserRejectedSubmission(error)) setSwapSimulationError(getWriteError(error) ?? "Transaction journal blocked swap submission");
      // The wagmi mutation retains the rejection for the originating mounted session.
    }
    } finally {
      swapSubmitInFlight.current = false;
    }
  };

  return (
    <div className="view-grid two-col">
      <section className="tool-panel">
        <div className="panel-heading">
          <span>Swap</span>
          <StatusBadge state={swapMarketReady ? "ready" : "unavailable"} label={swapMarketReady ? "best route" : swapMarketError ?? "unavailable"} />
        </div>

        <PoolSelect
          id="swap-pool"
          label="Selected market (Best V2.2 route)"
          onChange={onSelectedPoolChange}
          pools={poolOptions}
          selectedPoolId={selectedPoolId}
        />

        <SwapMarketRecovery
          error={swapMarketError}
          onRefresh={onRefresh}
          pool={primaryPool}
          readiness={selectedPool}
        />

        <label className="field-label" htmlFor="swap-amount">
          Sell
        </label>
        <div className="amount-box">
          <input id="swap-amount" inputMode="decimal" onChange={(event) => setAmount(event.target.value)} value={amount} />
          <span>{tokenSymbol(tokenIn)}</span>
        </div>
        <div className="balance-line">
          <span>Balance</span>
          <strong data-testid="swap-balance-value">{walletQuery.data ? formatTokenAmount(walletQuery.data.balance, tokenIn) : connected ? "loading" : "connect wallet"}</strong>
        </div>

        <button className="flip-button" type="button" title="Flip tokens" onClick={() => setSwapForY((value) => !value)}>
          <ArrowLeftRight size={18} />
        </button>

        <label className="field-label" htmlFor="swap-output">
          Buy
        </label>
        <div className="amount-box output">
          <input id="swap-output" readOnly value={formatSwapOutput(quoteQuery.isFetching, amountOut, tokenOut)} />
          <span>{tokenSymbol(tokenOut)}</span>
        </div>

        <div className="swap-settings">
          <label htmlFor="swap-slippage">
            <span>Slippage</span>
            <input id="swap-slippage" inputMode="decimal" value={slippageInput} onChange={(event) => setSlippageInput(event.target.value)} />
          </label>
          <label htmlFor="swap-deadline">
            <span>Deadline</span>
            <input id="swap-deadline" inputMode="numeric" value={deadlineInput} onChange={(event) => setDeadlineInput(event.target.value)} />
          </label>
        </div>

        <div className="quote-grid">
          <MiniMetric label="Minimum received" value={amountOutMin !== null ? formatTokenAmount(amountOutMin.toString(), tokenOut) : "n/a"} />
          <MiniMetric label="Quote freshness" value={quoteFreshnessLabel} />
          <MiniMetric data-testid="swap-allowance-value" label="Allowance" value={walletQuery.data ? formatTokenAmount(walletQuery.data.allowance, tokenIn) : "n/a"} />
          <MiniMetric data-testid="swap-native-balance" label="ETH for gas" value={nativeBalance !== null ? `${formatUnits(nativeBalance, 18)} ETH` : connected ? "loading" : "connect wallet"} />
        </div>

        <GasReview review={gasReview} />

        <ApprovalDetails
          asset={tokenSymbol(tokenIn)}
          currentState={walletQuery.data ? `${formatTokenAmount(walletQuery.data.allowance, tokenIn)} allowance${needsApproval ? " (approval needed)" : " (sufficient)"}` : "unavailable"}
          id="swap-approval-details"
          requested={parsedAmount !== null ? formatTokenAmount(parsedAmount.toString(), tokenIn) : "invalid amount"}
          scope="Exact token amount for this swap"
          spender={registry.contracts.lbRouter}
        />

        <div className="action-stack">
          <button
            className="secondary-button wide"
            data-testid="swap-approve-button"
            type="button"
            aria-describedby="swap-approval-details"
            disabled={!canApprove || approvalWrite.isPending || approvalReceipt.isLoading || approvalSimulationPending}
            title={swapApprovalDisclosure}
            onClick={handleApprove}
          >
            {approvalSimulationPending || approvalWrite.isPending || approvalReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <CheckCircle2 size={18} />}
            <span>{needsApproval ? `Approve ${tokenSymbol(tokenIn)}` : "Approved"}</span>
          </button>
          <button className="primary-button wide" data-testid="swap-submit-button" type="button" disabled={!canSwap} onClick={handleSwap}>
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
          approvalHash={approvalWrite.data}
          approvalReverted={approvalReverted}
          approvalSuccess={approvalSuccess}
          insufficientBalance={insufficientBalance}
          insufficientGas={actionError?.startsWith("Insufficient ETH for gas") === true}
          quoteError={quoteQuery.error}
          swapHash={swapWrite.data}
          swapReverted={swapReverted}
          swapSuccess={swapSuccess}
          walletError={walletError}
        />
      </section>

      <SwapDetailsCard
        expectedOutLabel={expectedOutLabel}
        feeLabel={feeLabel}
        primaryPool={primaryPool}
        quote={quote}
        priceImpactLabel={priceImpactLabel}
        routeSteps={routeSteps}
        selectedPool={selectedPool}
        swapMarketError={swapMarketError}
        swapMarketReady={swapMarketReady}
        tokenIn={tokenIn}
        tokenOut={tokenOut}
      />
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

function SwapDetailsCard({
  expectedOutLabel,
  feeLabel,
  primaryPool,
  quote,
  priceImpactLabel,
  routeSteps,
  selectedPool,
  swapMarketError,
  swapMarketReady,
  tokenIn,
  tokenOut
}: {
  expectedOutLabel: string;
  feeLabel: string;
  primaryPool: PoolRow | null;
  quote: SerializedExactInQuote | undefined;
  priceImpactLabel: string;
  routeSteps: RouteStepView[];
  selectedPool: SelectedPoolDescriptor;
  swapMarketError: string | null;
  swapMarketReady: boolean;
  tokenIn: TokenMetadata | null;
  tokenOut: TokenMetadata | null;
}) {
  return (
    <section className="info-panel">
      <div className="panel-heading">
        <span>Route</span>
        <StatusBadge
          state={!swapMarketReady ? "unavailable" : quote ? "ready" : primaryPool ? "loading" : "empty"}
          label={!swapMarketReady ? swapMarketError ?? "unavailable" : quote ? "Best V2.2 route" : primaryPool ? "waiting" : "no market"}
        />
      </div>

      <div className="quote-grid">
        <MiniMetric label="Expected out" value={expectedOutLabel} />
        <MiniMetric label="Fee" value={feeLabel} />
        <MiniMetric label="Price impact" value={priceImpactLabel} />
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
          <dd>Best V2.2 route</dd>
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
  return (
    <>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select className="select-input" id={id} value={selectedPoolId} onChange={(event) => onChange(event.target.value)} disabled={pools.length === 0}>
        {pools.length > 0 ? (
          pools.map((pool) => (
            <option key={pool.id} value={pool.id}>
              {tokenSymbol(pool.tokenX)} / {tokenSymbol(pool.tokenY)} - {formatCompactAddress(pool.address)}
            </option>
          ))
        ) : (
          <option value="">No indexed pools</option>
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
      source: "indexed"
    });
  }

  if (localnetRegistry !== null) {
    return buildSelectedPoolDescriptor({
      action,
      poolKey: "wnativeUsdc",
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
    source: "indexed"
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

function runtimeChainLabel(expectedChainId: number, actualChainId: number | null): string {
  if (actualChainId === null || actualChainId === expectedChainId) return `Chain ${expectedChainId}`;
  return `Expected ${expectedChainId}, RPC ${actualChainId}`;
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
  approvalHash,
  approvalReverted,
  approvalSuccess,
  insufficientBalance,
  insufficientGas,
  quoteError,
  swapHash,
  swapReverted,
  swapSuccess,
  walletError
}: {
  actionError: string | null;
  amountError: string | null;
  approvalHash: Address | undefined;
  approvalReverted: boolean;
  approvalSuccess: boolean;
  insufficientBalance: boolean;
  insufficientGas: boolean;
  quoteError: Error | null;
  swapHash: Address | undefined;
  swapReverted: boolean;
  swapSuccess: boolean;
  walletError: string | null;
}) {
  const receiptFailure = swapReverted ? "Swap reverted" : approvalReverted ? "Approval reverted" : null;
  const failure =
    receiptFailure ??
    amountError ??
    (insufficientBalance ? "Insufficient token balance" : null) ??
    (insufficientGas ? "Insufficient ETH for gas" : null) ??
    (quoteError ? quoteError.message : null) ??
    walletError ??
    actionError;

  return (
    <>
      <div className="state-row pending">
        <LoaderCircle size={16} />
        <span>{swapHash ? `Swap pending ${formatCompactAddress(swapHash)}` : approvalHash ? `Approval pending ${formatCompactAddress(approvalHash)}` : "Ready for wallet confirmation"}</span>
      </div>
      <div className="state-row success">
        <CheckCircle2 size={16} />
        <span>{swapSuccess ? "Swap confirmed" : approvalSuccess ? "Approval confirmed" : "Receipt state will appear here"}</span>
      </div>
      <div className="state-row failure" data-testid="swap-failure-state">
        <AlertTriangle size={16} />
        <span>{failure ?? "Rejected, reverted, and no-route errors appear here"}</span>
      </div>
    </>
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
  asset,
  currentState,
  id,
  requested,
  scope,
  spender
}: {
  asset: string;
  currentState: string;
  id: string;
  requested: string;
  scope: string;
  spender: Address | null;
}) {
  return (
    <section className="approval-disclosure" id={id} aria-label={`${asset} approval details`}>
      <strong>Approval details</strong>
      <dl>
        <div><dt>Token / asset</dt><dd>{asset}</dd></div>
        <div><dt>Requested</dt><dd>{requested}</dd></div>
        <div><dt>Scope</dt><dd>{scope}</dd></div>
        <div><dt>Current state</dt><dd>{currentState}</dd></div>
        <div><dt>Spender / operator</dt><dd><code className="approval-address" data-testid={`${id}-spender`}>{spender ?? "not configured"}</code></dd></div>
      </dl>
    </section>
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

function parseTokenAmountInput(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();

  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed.length === 0 || trimmed === ".") {
    return null;
  }

  try {
    return parseUnits(trimmed, decimals);
  } catch {
    return null;
  }
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
      <span>Gas review for {review.action}: limit {review.gasLimit.toString()} × {formatUnits(review.gasPrice, 9)} gwei + 25% gas buffer{review.transactionValue > 0n ? ` + ${formatUnits(review.transactionValue, 18)} ETH value` : ""} = {formatUnits(review.requiredWei, 18)} ETH required. Submit again to re-estimate and open the wallet.</span>
    </div>
  );
}

type PoolCategory = "all" | "active" | "stables";
type PoolSort = "swaps" | "deposits" | "updated";

function PoolsView({ pools, snapshot, snapshotState }: { pools: PoolRow[]; snapshot: AppSnapshot | undefined; snapshotState: LoadState }) {
  const poolState = isPartialPagination(snapshot?.indexer.pagination.pools) ? "partial" : pools.length > 0 ? "ready" : snapshotState;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PoolCategory>("all");
  const [sort, setSort] = useState<PoolSort>("swaps");
  const [page, setPage] = useState(0);
  const pageSize = 10;
  const filteredPools = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return pools
      .filter((pool) => {
        if (category === "active" && !poolHasSwapLiquidity(pool)) return false;
        if (
          category === "stables" &&
          !(pool.tokenX?.tags.includes("stablecoin") && pool.tokenY?.tags.includes("stablecoin"))
        ) {
          return false;
        }
        if (normalizedQuery.length === 0) return true;

        return [tokenSymbol(pool.tokenX), tokenSymbol(pool.tokenY), pool.address, pool.id]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .sort((left, right) => comparePoolMetric(right, left, sort));
  }, [category, pools, query, sort]);
  const pageCount = Math.max(1, Math.ceil(filteredPools.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visiblePools = filteredPools.slice(safePage * pageSize, (safePage + 1) * pageSize);

  useEffect(() => setPage(0), [category, query, sort]);

  return (
    <div className="view-grid">
      <section className="table-panel">
        <div className="panel-heading">
          <span>Liquidity pools</span>
          <StatusBadge
            state={poolState}
            label={snapshot?.indexer.pagination.pools ? paginationBadgeLabel(pools.length, snapshot.indexer.pagination.pools, "pools") : snapshotState}
          />
        </div>
        <div className="pool-controls">
          <label>
            <span className="field-label">Search</span>
            <input
              aria-label="Search pools"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Pair, token, or address"
              value={query}
            />
          </label>
          <div className="pool-filter-chips" role="group" aria-label="Pool category">
            {(["all", "active", "stables"] as const).map((value) => (
              <button
                className={category === value ? "filter-chip active" : "filter-chip"}
                key={value}
                onClick={() => setCategory(value)}
                type="button"
              >
                {value === "all" ? "All DLMM" : value === "active" ? "Active" : "Stables"}
              </button>
            ))}
          </div>
          <label>
            <span className="field-label">Sort</span>
            <select aria-label="Sort pools" onChange={(event) => setSort(event.target.value as PoolSort)} value={sort}>
              <option value="swaps">Swap count</option>
              <option value="deposits">Deposit count</option>
              <option value="updated">Recently updated</option>
            </select>
          </label>
        </div>
        {pools.length > 0 ? (
          <>
            <div className="pool-table discovery-table">
              <div className="table-row header">
                <span>Pool</span>
                <span>Token reserves</span>
                <span>Lifetime volume</span>
                <span>Lifetime fees</span>
                <span>Action</span>
              </div>
              {visiblePools.map((pool) => (
                <div className="table-row" key={pool.id}>
                  <a className="pair-name" href={`#/pools/${encodeURIComponent(pool.id)}`}>
                    {tokenSymbol(pool.tokenX)} / {tokenSymbol(pool.tokenY)}
                    <small>DLMM · bin step {pool.binStep} · {formatCompactAddress(pool.address)}</small>
                  </a>
                  <span>
                    {formatTokenAmount(pool.reserveX, pool.tokenX)} {tokenSymbol(pool.tokenX)} · {formatTokenAmount(pool.reserveY, pool.tokenY)} {tokenSymbol(pool.tokenY)}
                  </span>
                  <span>
                    {formatTokenAmount(pool.volumeX, pool.tokenX)} / {formatTokenAmount(pool.volumeY, pool.tokenY)}
                  </span>
                  <span>
                    {formatTokenAmount(pool.feesX, pool.tokenX)} / {formatTokenAmount(pool.feesY, pool.tokenY)}
                  </span>
                  <a className="secondary-button" href={`#/pools/${encodeURIComponent(pool.id)}`}>
                    View
                  </a>
                </div>
              ))}
            </div>
            {visiblePools.length === 0 ? <p className="inline-empty">No pools match these filters.</p> : null}
            <div className="pagination-controls" aria-label="Pool pages">
              <button disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} type="button">Previous</button>
              <span>Page {safePage + 1} of {pageCount} · {filteredPools.length} pools</span>
              <button disabled={safePage + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} type="button">Next</button>
            </div>
          </>
        ) : (
          <EmptyState state={snapshotState} />
        )}
      </section>
    </div>
  );
}

function PoolDetailView({
  environmentKey,
  onSelectPool,
  pool,
  poolDetailId,
  snapshotState
}: {
  environmentKey: EnvironmentKey;
  onSelectPool: (poolId: string) => void;
  pool: PoolRow | null;
  poolDetailId: string;
  snapshotState: LoadState;
}) {
  const registry = registries[environmentKey];
  const account = useAccount();
  const binsQuery = useQuery({
    queryKey: ["poolBinWindow", environmentKey, pool?.address, pool?.activeId, registry.endpoints.indexerUrl],
    queryFn: () => {
      if (pool === null || pool.activeId === null) throw new Error("Pool active bin is unavailable");
      return loadPoolBinWindow(registry, pool.address, Number(pool.activeId));
    },
    enabled: pool !== null && pool.activeId !== null && registry.endpoints.indexerUrl !== null,
    refetchInterval: pool !== null && pool.activeId !== null && registry.endpoints.indexerUrl !== null ? SNAPSHOT_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: "always",
    retry: false
  });
  const walletPositionsQuery = useQuery({
    queryKey: ["poolDetailPositions", environmentKey, account.address, pool?.address, registry.endpoints.indexerUrl],
    queryFn: () => {
      if (pool === null || !account.address) throw new Error("Wallet pool position is unavailable");
      return loadPaginatedPositionsForOwnerPair(registry, account.address, pool.address);
    },
    enabled: pool !== null && account.address !== undefined && registry.endpoints.indexerUrl !== null,
    refetchInterval:
      pool !== null && account.address !== undefined && registry.endpoints.indexerUrl !== null
        ? SNAPSHOT_REFRESH_INTERVAL_MS
        : false,
    refetchOnWindowFocus: "always",
    retry: false
  });

  if (pool === null) {
    const lookupResolved = !["loading", "error", "unavailable"].includes(snapshotState);
    return (
      <div className="view-grid">
        <section className="table-panel">
          <a className="back-link" href="#/pools">← All pools</a>
          <EmptyState state={lookupResolved ? "empty" : snapshotState} />
          {lookupResolved ? (
            <p className="inline-error">Pool {formatCompactAddress(poolDetailId)} was not found in the current environment.</p>
          ) : null}
        </section>
      </div>
    );
  }

  const indexedBins = binsQuery.data ?? [];
  const bins = withActiveBin(indexedBins, pool.activeId);
  const walletPositions = walletPositionsQuery.data?.rows ?? [];
  const positionsPartial = isPartialPagination(walletPositionsQuery.data?.pageInfo);
  const binsState: LoadState = registry.endpoints.indexerUrl === null
    ? "unavailable"
    : pool.activeId === null
      ? "unavailable"
    : binsQuery.isError
      ? "error"
      : binsQuery.isLoading
        ? "loading"
        : binsQuery.data
          ? "ready"
          : "empty";
  const positionsState: LoadState = !account.address
    ? "loading"
    : registry.endpoints.indexerUrl === null
      ? "unavailable"
      : walletPositionsQuery.isError
        ? "error"
        : positionsPartial
          ? "partial"
          : walletPositionsQuery.isLoading
            ? "loading"
            : walletPositions.length > 0
              ? "ready"
              : "empty";
  const positionsLabel = !account.address
    ? "connect wallet"
    : positionsState === "partial"
      ? `${walletPositions.length} loaded · partial`
      : positionsState === "ready" || positionsState === "empty"
        ? `${walletPositions.length} bins`
        : positionsState;
  const selectPool = () => onSelectPool(pool.id);

  return (
    <div className="view-grid pool-detail">
      <section className="table-panel pool-detail-header">
        <a className="back-link" href="#/pools">← All pools</a>
        <div className="pool-title-row">
          <div>
            <h2>{tokenSymbol(pool.tokenX)} / {tokenSymbol(pool.tokenY)}</h2>
            <p>{formatCompactAddress(pool.address)} · DLMM · bin step {pool.binStep}</p>
          </div>
          <div className="pool-actions">
            <a className="secondary-button" href={`#/swap/${encodeURIComponent(pool.id)}`} onClick={selectPool}>Swap</a>
            <a className="secondary-button" href={`#/liquidity/withdraw/${encodeURIComponent(pool.id)}`} onClick={selectPool}>Withdraw</a>
            <a className="primary-button" href={`#/liquidity/add/${encodeURIComponent(pool.id)}`} onClick={selectPool}>Deposit</a>
          </div>
        </div>
      </section>

      <section className="pool-detail-metrics">
        <MetricTile label="Token reserves" value={`${formatTokenAmount(pool.reserveX, pool.tokenX)} / ${formatTokenAmount(pool.reserveY, pool.tokenY)}`} tone="neutral" />
        <MetricTile label="Lifetime volume" value={`${formatTokenAmount(pool.volumeX, pool.tokenX)} / ${formatTokenAmount(pool.volumeY, pool.tokenY)}`} tone="neutral" />
        <MetricTile label="Lifetime fees" value={`${formatTokenAmount(pool.feesX, pool.tokenX)} / ${formatTokenAmount(pool.feesY, pool.tokenY)}`} tone="good" />
        <MetricTile label="Swaps / active bin" value={`${pool.swapCount} / ${pool.activeId ?? "n/a"}`} tone="neutral" />
      </section>

      <section className="info-panel">
        <div className="panel-heading">
          <span>Live liquidity bins</span>
          <StatusBadge state={binsState} label={binsQuery.data ? `${indexedBins.length} indexed bins` : binsState} />
        </div>
        <PoolBinChart activeId={pool.activeId} bins={bins} state={binsState} />
        {binsQuery.error ? <p className="inline-error">{getWriteError(binsQuery.error) ?? "Pool bins unavailable"}</p> : null}
      </section>

      <section className="table-panel">
        <div className="panel-heading">
          <span>Your bins</span>
          <StatusBadge
            state={positionsState}
            label={positionsLabel}
          />
        </div>
        {walletPositions.length > 0 ? (
          <>
            <div className="wallet-bin-list">
              {walletPositions.map((position) => (
                <div key={position.id}>
                  <span>Bin {position.binId}</span>
                  <strong>{formatTokenAmount(position.liquidity, null)} LB</strong>
                </div>
              ))}
            </div>
            {positionsPartial ? <p className="state-row warning">The owner/pair position query is partial; destructive actions remain blocked.</p> : null}
          </>
        ) : account.address && ["loading", "error", "unavailable"].includes(positionsState) ? (
          <>
            <EmptyState state={positionsState} />
            {walletPositionsQuery.error ? <p className="inline-error">{getWriteError(walletPositionsQuery.error) ?? "Wallet pool positions are unavailable."}</p> : null}
          </>
        ) : (
          <p className="inline-empty">
            {account.address
              ? positionsState === "unavailable"
                ? "Indexer access is required to load wallet pool balances."
                : walletPositionsQuery.isError
                ? getWriteError(walletPositionsQuery.error) ?? "Wallet pool positions are unavailable."
                : positionsPartial
                  ? "The owner/pair position query is partial; destructive actions remain blocked."
                : "No indexed balances in this pool."
              : "Connect a wallet to view your pool balances."}
          </p>
        )}
      </section>
    </div>
  );
}

function PoolBinChart({ activeId, bins, state }: { activeId: string | null; bins: BinRow[]; state: LoadState }) {
  const maxLiquidity = bins.reduce((maximum, bin) => {
    const supply = BigInt(bin.totalSupply);
    return supply > maximum ? supply : maximum;
  }, 0n);

  if (bins.length === 0 || state !== "ready") return <EmptyState state={state} />;

  return (
    <div className="pool-bin-chart" aria-label="Indexed pool liquidity by bin">
      {bins.map((bin) => {
        const liquidity = BigInt(bin.totalSupply);
        const height = maxLiquidity === 0n ? 8 : 8 + Number((liquidity * 92n) / maxLiquidity);
        return (
          <span
            aria-label={`Bin ${bin.binId}; LB supply ${bin.totalSupply}; token X reserve ${bin.reserveX}; token Y reserve ${bin.reserveY}${bin.binId === activeId ? "; active bin" : ""}`}
            className={bin.binId === activeId ? "pool-bin active" : "pool-bin"}
            key={bin.id}
            role="img"
            style={{ height: `${height}%` }}
            tabIndex={0}
            title={`Bin ${bin.binId} · X ${bin.reserveX} · Y ${bin.reserveY}`}
          />
        );
      })}
    </div>
  );
}

function withActiveBin(bins: BinRow[], activeId: string | null): BinRow[] {
  if (activeId === null || bins.some((bin) => bin.binId === activeId)) return bins;

  return [...bins, { id: `active-${activeId}`, binId: activeId, reserveX: "0", reserveY: "0", totalSupply: "0", updatedAtBlock: "0" }]
    .sort((left, right) => Number(left.binId) - Number(right.binId));
}

function comparePoolMetric(left: PoolRow, right: PoolRow, sort: PoolSort): number {
  const leftValue = poolMetric(left, sort);
  const rightValue = poolMetric(right, sort);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : left.id.localeCompare(right.id);
}

function poolMetric(pool: PoolRow, sort: PoolSort): bigint {
  if (sort === "deposits") return BigInt(pool.depositCount);
  if (sort === "updated") return BigInt(pool.updatedAtBlock);
  return BigInt(pool.swapCount);
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
  const [amountXInput, setAmountXInput] = useState("0.01");
  const [amountYInput, setAmountYInput] = useState("1");
  const [lowerDeltaInput, setLowerDeltaInput] = useState("-1");
  const [upperDeltaInput, setUpperDeltaInput] = useState("1");
  const [liquidityStrategy, setLiquidityStrategy] = useState<LiquidityStrategy>("spot");
  const [slippageInput, setSlippageInput] = useState("0.5");
  const [idSlippageInput, setIdSlippageInput] = useState("2");
  const [deadlineInput, setDeadlineInput] = useState("20");
  const [liquiditySimulationError, setLiquiditySimulationError] = useState<string | null>(null);
  const [liquiditySimulationPending, setLiquiditySimulationPending] = useState(false);
  const [gasReviewError, setGasReviewError] = useState<string | null>(null);
  const [gasReview, setGasReview] = useState<ExactGasReview | null>(null);
  const [removeQuoteReviewRequired, setRemoveQuoteReviewRequired] = useState<string | null>(null);
  const [selectedPositionIds, setSelectedPositionIds] = useState<string[]>([]);
  const [removePercentInput, setRemovePercentInput] = useState("100");
  const [liquidityReceiptPhase, setLiquidityReceiptPhase] = useState<"idle" | "lb-approval" | "remove">("idle");
  const [submittedRemoveReceiptContext, setSubmittedRemoveReceiptContext] = useState<string | null>(null);
  const [submittedApproveXReceiptContext, setSubmittedApproveXReceiptContext] = useState<string | null>(null);
  const [submittedApproveYReceiptContext, setSubmittedApproveYReceiptContext] = useState<string | null>(null);
  const [submittedLbApprovalReceiptContext, setSubmittedLbApprovalReceiptContext] = useState<string | null>(null);
  const [submittedAddReceiptContext, setSubmittedAddReceiptContext] = useState<string | null>(null);
  const intentionalEmptySelectionRef = useRef(false);
  const portfolioPrefillKeyRef = useRef<string | null>(null);
  const liquidityOperationGenerationRef = useRef(0);
  const approveXSubmitInFlightRef = useRef<number | null>(null);
  const approveYSubmitInFlightRef = useRef<number | null>(null);
  const approveLbSubmitInFlightRef = useRef<number | null>(null);
  const addSubmitInFlightRef = useRef<number | null>(null);
  const removeSubmitInFlightRef = useRef<number | null>(null);
  const [handledApproveXHash, setHandledApproveXHash] = useState<Address | null>(null);
  const [handledApproveYHash, setHandledApproveYHash] = useState<Address | null>(null);
  const [handledLbApprovalHash, setHandledLbApprovalHash] = useState<Address | null>(null);
  const [handledAddHash, setHandledAddHash] = useState<Address | null>(null);
  const [handledRemoveHash, setHandledRemoveHash] = useState<Address | null>(null);
  const registry = registries[environmentKey];
  const portfolioEndpoint = analyticsEndpointForRegistry(registry);
  const localnetRegistry = isLocalnetRegistry(registry) ? registry : null;
  const account = useAccount();
  const activeWalletChainId = useChainId();
  const approveXWrite = useWriteContract();
  const approveYWrite = useWriteContract();
  const approveLbWrite = useWriteContract();
  const addWrite = useWriteContract();
  const removeWrite = useSendTransaction();
  const approveXReceipt = useWaitForTransactionReceipt({ hash: approveXWrite.data });
  const approveYReceipt = useWaitForTransactionReceipt({ hash: approveYWrite.data });
  const approveLbReceipt = useWaitForTransactionReceipt({ hash: approveLbWrite.data });
  const addReceipt = useWaitForTransactionReceipt({ hash: addWrite.data });
  const removeReceipt = useWaitForTransactionReceipt({ hash: removeWrite.data });
  const transactionJournal = useTransactionJournal();
  const publicClient = useMemo(() => createDexPublicClient(registry.chain, registry.endpoints.rpcUrl), [registry]);

  useEffect(() => {
    if (initialSection === null) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(initialSection === "withdraw" ? "liquidity-withdraw" : "liquidity-add")?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialSection, selectedPoolId]);
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
  const activeBin =
    selectedPool.activeId ??
    pool?.activeId ??
    (primaryPool?.activeId !== null && primaryPool?.activeId !== undefined
      ? Number(primaryPool.activeId)
      : localnetRegistry !== null
        ? snapshot?.runtime.seededActiveId ?? null
        : null);
  const parsedAmountX = parseTokenAmountInput(amountXInput, tokenX?.decimals ?? 18);
  const parsedAmountY = parseTokenAmountInput(amountYInput, tokenY?.decimals ?? 18);
  const lowerDelta = parseIntegerInput(lowerDeltaInput);
  const upperDelta = parseIntegerInput(upperDeltaInput);
  const slippageBps = parseSlippageToBps(slippageInput);
  const idSlippage = parseIdSlippage(idSlippageInput);
  const idSlippageError = idSlippageInputError(idSlippageInput);
  const deadlineMinutes = parseDeadlineMinutes(deadlineInput);
  const removePercentBps = parsePercentToBps(removePercentInput);
  const distributionResult = buildLiquidityDistributionForView(activeBin, lowerDelta, upperDelta, liquidityStrategy);
  const liquidityMode = distributionResult.distribution?.mode ?? null;
  const amountX = liquidityMode === "token-y" ? 0n : parsedAmountX;
  const amountY = liquidityMode === "token-x" ? 0n : parsedAmountY;
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
    distributionResult.distribution?.distributionY.join(",") ?? ""
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
    upperDelta?.toString() ?? ""
  ].join("|");
  const latestAddExecutionFingerprint = useRef(addExecutionFingerprint);
  latestAddExecutionFingerprint.current = addExecutionFingerprint;
  const rangeSliderMin = Math.min(-MAX_LIQUIDITY_BINS, lowerDelta ?? 0, (upperDelta ?? 0) - MAX_LIQUIDITY_BINS + 1);
  const rangeSliderMax = Math.max(MAX_LIQUIDITY_BINS, upperDelta ?? 0, (lowerDelta ?? 0) + MAX_LIQUIDITY_BINS - 1);
  const walletQuery = useQuery({
    queryKey: ["liquidityWallet", registry.chainId, account.address, pool?.pair, pool?.tokenX, pool?.tokenY],
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
        : false
  });
  const walletData = walletQuery.data && !walletQuery.isError ? walletQuery.data : null;
  const walletReadsReady = walletData !== null;
  const walletBalanceX = walletData ? BigInt(walletData.balanceX) : null;
  const walletBalanceY = walletData ? BigInt(walletData.balanceY) : null;
  const walletAllowanceX = walletData ? BigInt(walletData.allowanceX) : null;
  const walletAllowanceY = walletData ? BigInt(walletData.allowanceY) : null;
  const nativeBalance = walletData ? BigInt(walletData.nativeBalance) : null;
  const needsXApproval = amountX !== null && amountX > 0n && walletAllowanceX !== null && walletAllowanceX < amountX;
  const needsYApproval = amountY !== null && amountY > 0n && walletAllowanceY !== null && walletAllowanceY < amountY;
  const insufficientX = amountX !== null && amountX > 0n && walletBalanceX !== null && walletBalanceX < amountX;
  const insufficientY = amountY !== null && amountY > 0n && walletBalanceY !== null && walletBalanceY < amountY;
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
      return loadWalletPortfolio(`${portfolioEndpoint}/graphql`, account.address);
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
    walletData?.lbApproved === false ? "approval-required" : "approval-not-required"
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
    binStep: pool?.binStep ?? null,
    burnBps: removePercentBps?.toString() ?? null,
    deadlineMinutes,
    environment: environmentKey,
    mode: "remove",
    pair: pool?.pair ?? null,
    registryChainId: registry.chainId,
    router: registry.contracts.lbRouter,
    selectedPositionsKey,
    slippageBps: slippageBps?.toString() ?? null,
    tokenX: pool?.tokenX ?? null,
    tokenY: pool?.tokenY ?? null,
    walletChainId: activeWalletChainId
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
  const fullExit = removePercentBps === 10_000n && selectedCoversAllWalletBins;
  const removeBurnPlanIssue = positionBurnSubmissionError(removeBurnPlan);
  const addInputError =
    distributionResult.error ??
    (amountX === null
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
  const removeSuccess = removeReceipt.data?.status === "success";
  const approveXReverted = submittedApproveXReceiptContext === approveXExecutionFingerprint && (approveXReceipt.data?.status === "reverted" || isRevertedReceiptError(approveXReceipt.error));
  const approveYReverted = submittedApproveYReceiptContext === approveYExecutionFingerprint && (approveYReceipt.data?.status === "reverted" || isRevertedReceiptError(approveYReceipt.error));
  const approveLbReverted = submittedLbApprovalReceiptContext === lbApprovalFormFingerprint && (approveLbReceipt.data?.status === "reverted" || isRevertedReceiptError(approveLbReceipt.error));
  const addReverted = submittedAddReceiptContext === addExecutionFingerprint && (addReceipt.data?.status === "reverted" || isRevertedReceiptError(addReceipt.error));
  const removeReverted = removeReceipt.data?.status === "reverted" || isRevertedReceiptError(removeReceipt.error);
  const removeReceiptMatchesCurrentIntent =
    liquidityReceiptPhase === "remove" && submittedRemoveReceiptContext === liquidityLifecycleKey;
  const currentRemoveSuccess = removeReceiptMatchesCurrentIntent && removeSuccess;
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
    !addWrite.isPending &&
    !addReceipt.isLoading;
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
    walletData?.lbApproved === true &&
    !removeBurnPlan.blocked &&
    liquiditySimulationError === null &&
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
    liquiditySimulationError === null &&
    !liquiditySimulationPending &&
    !approveYWrite.isPending &&
    !approveYReceipt.isLoading;
  const canApproveLb =
    removePoolReady &&
    connected &&
    !onWrongChain &&
    hasSelectedPositions &&
    walletData?.lbApproved === false &&
    removeInputError === null &&
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
  }, [account.address, activeWalletChainId, environmentKey, initialSection, pool?.pair, portfolioAction, selectedPoolId]);

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
      setRemovePercentInput(portfolioAction === "partial" ? "50" : "100");
      setSelectedPositionIds(walletPositions.map((position) => position.id));
      return;
    }
    setSelectedPositionIds((currentIds) => {
      if (walletPositions.length === 0) {
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
  }, [pool?.pair, portfolioAction, walletPositions]);

  useEffect(() => {
    setLiquiditySimulationError(null);
    setGasReviewError(null);
    setGasReview(null);
    setRemoveQuoteReviewRequired(null);
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
    handledAddHash,
    handledApproveXHash,
    handledApproveYHash,
    handledLbApprovalHash,
    handledRemoveHash,
    onRefresh,
    removeSuccess,
    removeWrite.data,
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
    const operationIsCurrent = () =>
      liquidityOperationGenerationRef.current === submittedOperationGeneration &&
      approveLbSubmitInFlightRef.current === submittedOperationGeneration;
    let submitted = false;
    try {
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
          send: () => approveLbWrite.writeContractAsync(simulated.request)
        });
        submitted = hash !== null;
      } catch (error) {
        if (!isUserRejectedSubmission(error)) setLiquiditySimulationError(getWriteError(error) ?? "Transaction journal blocked LB approval submission");
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

    const submittedOperationGeneration = liquidityOperationGenerationRef.current;
    const submittedExecutionFingerprint = addExecutionFingerprint;
    const args = [
      {
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
      }
    ] as const;
    addSubmitInFlightRef.current = submittedOperationGeneration;
    addWrite.reset();
    setSubmittedAddReceiptContext(null);
    setGasReviewError(null);
    const operationIsCurrent = () =>
      liquidityOperationGenerationRef.current === submittedOperationGeneration &&
      addSubmitInFlightRef.current === submittedOperationGeneration;
    let submitted = false;
    try {
      const simulated = await runPreSubmitSimulation(
        () =>
          publicClient.simulateContract({
            account: account.address,
            address: registry.contracts.lbRouter,
            abi: lbRouterAbi,
            functionName: "addLiquidity",
            args
          }),
        setLiquiditySimulationError,
        setLiquiditySimulationPending,
        operationIsCurrent
      );

      if (!simulated) return;
      if (liquidityOperationGenerationRef.current !== submittedOperationGeneration) return;
      if (latestAddExecutionFingerprint.current !== submittedExecutionFingerprint) {
        setLiquiditySimulationError("Liquidity execution context, safety settings, strategy, range, or composition changed during simulation; review the projected bins and try again");
        return;
      }
      const gasReviewIsCurrent = () =>
        operationIsCurrent() &&
        latestAddExecutionFingerprint.current === submittedExecutionFingerprint;
      const gasApproved = await reviewExactGas({
        action: "add liquidity",
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
      const submittedContext = {
        account: account.address,
        calldataFingerprint: keccak256(encodeFunctionData({ abi: lbRouterAbi, functionName: "addLiquidity", args })),
        chainId: activeWalletChainId,
        deploymentEpoch: deploymentEpoch(registry),
        environment: environmentKey,
        executionFingerprint: submittedExecutionFingerprint,
        intent: "add-liquidity" as const,
        providerId: account.connector?.id ?? "unknown",
        providerUid: account.connector?.uid ?? "unknown",
        submittedAt: Date.now(),
        target: registry.contracts.lbRouter,
        value: 0n
      };
      try {
        setSubmittedAddReceiptContext(submittedExecutionFingerprint);
        const hash = await submitJournaledTransaction({
          isCurrent: gasReviewIsCurrent,
          journal: transactionJournal,
          reviewed: reviewedTransactionIntent(submittedContext, { poolId: pool.pair, recipient: account.address, refundRecipient: account.address, settingsFingerprint: addRetrySettingsFingerprint }),
          send: () => addWrite.writeContractAsync(simulated.request)
        });
        submitted = hash !== null;
      } catch (error) {
        if (!isUserRejectedSubmission(error)) setLiquiditySimulationError(getWriteError(error) ?? "Transaction journal blocked add-liquidity submission");
        // The wagmi mutation retains the rejection for the originating mounted session.
      }
    } finally {
      if (!submitted && addSubmitInFlightRef.current === submittedOperationGeneration) {
        addSubmitInFlightRef.current = null;
      }
    }
  };

  const handleRemoveLiquidity = async () => {
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
    setLiquiditySimulationError(null);
    setGasReviewError(null);
    setRemoveQuoteReviewRequired(null);
    let submitted = false;
    try {
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

      const transaction = buildRemoveLiquidityTransaction(registry, {
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
          send: () => removeWrite.sendTransactionAsync(transaction)
        });
        submitted = hash !== null;
      } catch (error) {
        if (!isUserRejectedSubmission(error)) setLiquiditySimulationError(getWriteError(error) ?? "Transaction journal blocked withdrawal submission");
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
  };
  const updateRemovePercentInput = (value: string) => {
    clearSubmittedRemoveReceipt();
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

  return (
    <div className="view-grid two-col">
      {portfolioAction ? (
        <section className="snapshot-message ready portfolio-action-banner" data-testid="portfolio-action-handoff">
          {portfolioAction === "add"
            ? "Adding liquidity to the selected portfolio pair."
            : portfolioAction === "partial"
              ? "Partial withdrawal prefilled at 50% across every loaded bin in this position."
              : "Full exit prefilled at 100% across every loaded bin in this position."}
        </section>
      ) : null}
      <section className="tool-panel" id="liquidity-add">
        <div className="panel-heading">
          <span>Add Liquidity</span>
          <StatusBadge state={addPoolReady ? "ready" : "unavailable"} label={poolDescriptorLabel(selectedPool)} />
        </div>

        <PoolSelect
          id="liquidity-pair"
          label="Pool"
          onChange={onSelectedPoolChange}
          pools={poolOptions}
          selectedPoolId={selectedPoolId}
        />

        <div className="liquidity-rows">
          <div className="amount-box compact">
            <input
              data-testid="liquidity-amount-x"
              disabled={liquidityMode === "token-y"}
              inputMode="decimal"
              value={liquidityMode === "token-y" ? "0" : amountXInput}
              onChange={(event) => setAmountXInput(event.target.value)}
            />
            <span>{tokenSymbol(tokenX)}</span>
          </div>
          <div className="amount-box compact">
            <input
              data-testid="liquidity-amount-y"
              disabled={liquidityMode === "token-x"}
              inputMode="decimal"
              value={liquidityMode === "token-x" ? "0" : amountYInput}
              onChange={(event) => setAmountYInput(event.target.value)}
            />
            <span>{tokenSymbol(tokenY)}</span>
          </div>
        </div>
        <div className="state-row" data-testid="liquidity-range-mode">
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
          <div className="state-row" data-testid="liquidity-composition-guidance">
            <CircleDollarSign size={16} />
            <span>Balanced ranges require both tokens. Amounts stay user-controlled; Feather does not silently swap or auto-Zap composition.</span>
          </div>
        ) : null}
        <div className="quote-grid">
          <MiniMetric label={`${tokenSymbol(tokenX)} balance`} value={walletData ? formatTokenAmount(walletData.balanceX, tokenX) : connected ? "loading" : "connect"} />
          <MiniMetric label={`${tokenSymbol(tokenY)} balance`} value={walletData ? formatTokenAmount(walletData.balanceY, tokenY) : connected ? "loading" : "connect"} />
          <MiniMetric data-testid="liquidity-native-balance" label="ETH for gas" value={nativeBalance !== null ? `${formatUnits(nativeBalance, 18)} ETH` : connected ? "loading" : "connect"} />
        </div>

        <GasReview review={gasReview} />

        <fieldset className="strategy-picker" aria-label="Liquidity strategy">
          <legend>Volatility strategy</legend>
          {(["spot", "curve", "bid-ask"] as const).map((strategy) => (
            <button
              aria-pressed={liquidityStrategy === strategy}
              className={liquidityStrategy === strategy ? "selected" : ""}
              data-testid={`liquidity-strategy-${strategy}`}
              key={strategy}
              onClick={() => setLiquidityStrategy(strategy)}
              type="button"
            >
              <strong>{strategy === "bid-ask" ? "Bid-Ask" : strategy[0].toUpperCase() + strategy.slice(1)}</strong>
              <span>{strategy === "spot" ? "Even" : strategy === "curve" ? "Near price" : "Range edges"}</span>
            </button>
          ))}
        </fieldset>

        <div className="range-sliders" data-testid="liquidity-range-sliders">
          <label>Lower handle<input aria-label="Lower range handle" max={rangeSliderMax} min={rangeSliderMin} step="1" type="range" value={lowerDelta ?? 0} onChange={(event) => {
            const next = Number(event.target.value);
            setLowerDeltaInput(String(next));
            if (upperDelta !== null && upperDelta - next + 1 > MAX_LIQUIDITY_BINS) setUpperDeltaInput(String(next + MAX_LIQUIDITY_BINS - 1));
          }} /></label>
          <label>Upper handle<input aria-label="Upper range handle" max={rangeSliderMax} min={rangeSliderMin} step="1" type="range" value={upperDelta ?? 0} onChange={(event) => {
            const next = Number(event.target.value);
            setUpperDeltaInput(String(next));
            if (lowerDelta !== null && next - lowerDelta + 1 > MAX_LIQUIDITY_BINS) setLowerDeltaInput(String(next - MAX_LIQUIDITY_BINS + 1));
          }} /></label>
          <p>{lowerDelta !== null && upperDelta !== null && upperDelta >= lowerDelta ? `${upperDelta - lowerDelta + 1} bins` : "Invalid range"} · max {MAX_LIQUIDITY_BINS}. Every exact distribution is simulated before wallet submission.</p>
        </div>

        <div className="swap-settings">
          <label htmlFor="range-lower">
            <span>Lower Delta</span>
            <input id="range-lower" inputMode="numeric" value={lowerDeltaInput} onChange={(event) => setLowerDeltaInput(event.target.value)} />
          </label>
          <label htmlFor="range-upper">
            <span>Upper Delta</span>
            <input id="range-upper" inputMode="numeric" value={upperDeltaInput} onChange={(event) => setUpperDeltaInput(event.target.value)} />
          </label>
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
          <MiniMetric label="Active Bin" value={activeBin?.toString() ?? "n/a"} />
          <MiniMetric label="Min Bin" value={activeBin !== null && lowerDelta !== null ? String(activeBin + lowerDelta) : "n/a"} />
          <MiniMetric label="Max Bin" value={activeBin !== null && upperDelta !== null ? String(activeBin + upperDelta) : "n/a"} />
          <MiniMetric label="Liquidity Mode" value={liquidityMode ?? "n/a"} />
          <MiniMetric label="Bin Step" value={pool?.binStep.toString() ?? primaryPool?.binStep ?? "n/a"} />
          <MiniMetric label={`${tokenSymbol(tokenX)} allowance`} value={walletData ? formatTokenAmount(walletData.allowanceX, tokenX) : "n/a"} />
          <MiniMetric label={`${tokenSymbol(tokenY)} allowance`} value={walletData ? formatTokenAmount(walletData.allowanceY, tokenY) : "n/a"} />
          <MiniMetric label={`${tokenSymbol(tokenX)} approve`} value={needsXApproval && amountX !== null ? formatTokenAmount(amountX.toString(), tokenX) : "none"} />
          <MiniMetric label={`${tokenSymbol(tokenY)} approve`} value={needsYApproval && amountY !== null ? formatTokenAmount(amountY.toString(), tokenY) : "none"} />
        </div>

        <ApprovalDetails
          asset={tokenSymbol(tokenX)}
          currentState={walletData ? `${formatTokenAmount(walletData.allowanceX, tokenX)} allowance${needsXApproval ? " (approval needed)" : " (sufficient)"}` : "unavailable"}
          id="liquidity-x-approval-details"
          requested={amountX !== null ? formatTokenAmount(amountX.toString(), tokenX) : "invalid amount"}
          scope="Exact token amount for this add-liquidity action"
          spender={registry.contracts.lbRouter}
        />
        <ApprovalDetails
          asset={tokenSymbol(tokenY)}
          currentState={walletData ? `${formatTokenAmount(walletData.allowanceY, tokenY)} allowance${needsYApproval ? " (approval needed)" : " (sufficient)"}` : "unavailable"}
          id="liquidity-y-approval-details"
          requested={amountY !== null ? formatTokenAmount(amountY.toString(), tokenY) : "invalid amount"}
          scope="Exact token amount for this add-liquidity action"
          spender={registry.contracts.lbRouter}
        />

        <LiquidityDistributionPreview bins={distributionResult.preview} />

        <div className="action-stack">
          <button
            className="secondary-button wide"
            data-testid="liquidity-approve-x-button"
            type="button"
            aria-describedby="liquidity-x-approval-details"
            disabled={!canApproveX}
            title={approvalDisclosure({ amount: amountX, spender: registry.contracts.lbRouter, tokenSymbol: tokenSymbol(tokenX) })}
            onClick={handleApproveX}
          >
            {liquiditySimulationPending || approveXWrite.isPending || approveXReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <CheckCircle2 size={18} />}
            <span>{needsXApproval ? `Approve ${tokenSymbol(tokenX)}` : `${tokenSymbol(tokenX)} approved`}</span>
          </button>
          <button
            className="secondary-button wide"
            data-testid="liquidity-approve-y-button"
            type="button"
            aria-describedby="liquidity-y-approval-details"
            disabled={!canApproveY}
            title={approvalDisclosure({ amount: amountY, spender: registry.contracts.lbRouter, tokenSymbol: tokenSymbol(tokenY) })}
            onClick={handleApproveY}
          >
            {liquiditySimulationPending || approveYWrite.isPending || approveYReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <CheckCircle2 size={18} />}
            <span>{needsYApproval ? `Approve ${tokenSymbol(tokenY)}` : `${tokenSymbol(tokenY)} approved`}</span>
          </button>
          <button className="primary-button wide" data-testid="liquidity-add-button" type="button" disabled={!addReady} onClick={handleAddLiquidity}>
            {liquiditySimulationPending || addWrite.isPending || addReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <Droplets size={18} />}
            <span>{liquidityButtonLabel({ poolReady: addPoolReady, connected, onWrongChain, walletReadsReady, walletReadErrored: walletQuery.isError, invalidInput: addInputError !== null, needsApproval: needsXApproval || needsYApproval, insufficientBalance: insufficientX || insufficientY, insufficientGas: liquiditySimulationError?.startsWith("Insufficient ETH for gas") === true, ready: distributionResult.distribution !== null })}</span>
          </button>
        </div>

        <LiquidityStateRows
          actionError={liquidityActionError}
          inputError={addInputError}
          insufficientBalance={insufficientX || insufficientY}
          pendingHash={addWrite.data ?? approveXWrite.data ?? approveYWrite.data}
          successText={addSuccess ? "Liquidity added" : approveXSuccess || approveYSuccess ? "Token approval confirmed" : null}
          revertedText={addReverted ? "Add liquidity reverted" : approveXReverted ? `${tokenSymbol(tokenX)} approval reverted` : approveYReverted ? `${tokenSymbol(tokenY)} approval reverted` : null}
        />
      </section>

      <section className="info-panel" id="liquidity-withdraw">
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

        <div className="withdraw-percent-controls">
          <label htmlFor="remove-percent-slider">
            <span>Burn percentage</span>
            <input id="remove-percent-slider" max="100" min="0.01" step="0.01" type="range" value={removePercentValue} onChange={(event) => updateRemovePercentInput(event.target.value)} />
          </label>
          <div className="withdraw-quick-actions" aria-label="Withdrawal percentage presets" role="group">
            {[25, 50, 75, 100].map((percent) => (
              <button aria-pressed={removePercentValue === percent} key={percent} onClick={() => updateRemovePercentInput(String(percent))} type="button">
                {percent === 100 ? "Max" : `${percent}%`}
              </button>
            ))}
          </div>
          <label htmlFor="remove-percent">
            <span>Exact %</span>
            <input id="remove-percent" inputMode="decimal" value={removePercentInput} onChange={(event) => updateRemovePercentInput(event.target.value)} />
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
        </section>

        <ApprovalDetails
          asset={`LB pair ${pool?.pair ?? "not selected"}`}
          currentState={walletData ? (walletData.lbApproved ? "Approved" : "Not approved") : "unavailable"}
          id="remove-lb-approval-details"
          requested={`Operator access for ${selectedBinSummary}`}
          scope="All LB token IDs for this pair"
          spender={registry.contracts.lbRouter}
        />

        <div className="action-stack">
          <button
            className="secondary-button wide"
            data-testid="liquidity-approve-lb-button"
            type="button"
            aria-describedby="remove-lb-approval-details"
            disabled={!canApproveLb}
            title={`Approve all LB positions to ${registry.contracts.lbRouter}`}
            onClick={handleApproveLb}
          >
            {liquiditySimulationPending || approveLbWrite.isPending || approveLbReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <CheckCircle2 size={18} />}
            <span>{walletData?.lbApproved ? "LB approved" : "Approve LB tokens"}</span>
          </button>
          <button className="primary-button wide" data-testid="liquidity-remove-button" type="button" disabled={!removeReady} onClick={handleRemoveLiquidity}>
            {liquiditySimulationPending || removeWrite.isPending || removeReceipt.isLoading ? <LoaderCircle className="spin" size={18} /> : <Droplets size={18} />}
            <span>{removeButtonLabel({ poolReady: removePoolReady, connected, fullExit, onWrongChain, invalidInput: removeInputError !== null, hasPosition: hasSelectedPositions, needsApproval: walletData?.lbApproved === false, insufficientGas: liquiditySimulationError?.startsWith("Insufficient ETH for gas") === true })}</span>
          </button>
        </div>

        <LiquidityStateRows
          actionError={removeQuoteReviewRequired ?? liquidityActionError}
          inputError={removeInputError}
          insufficientBalance={false}
          pendingHash={liquidityReceiptPhase === "remove" ? removeWrite.data : liquidityReceiptPhase === "lb-approval" ? approveLbWrite.data : undefined}
          successText={currentRemoveSuccess ? "Liquidity removed" : currentLbApprovalSuccess ? "LB approval confirmed" : null}
          revertedText={currentRemoveReverted ? "Remove liquidity reverted" : currentLbApprovalReverted ? "LB approval reverted" : null}
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
      </section>

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

function LiquidityDistributionPreview({ bins }: { bins: LiquidityDistributionView[] }) {
  if (bins.length === 0) {
    return <EmptyState state="empty" />;
  }

  return (
    <div className="distribution-panel">
      <div className="range-map" aria-label="Liquidity bin distribution">
        {bins.map((bin) => (
          <span className={bin.delta === "0" ? "bin active" : "bin"} key={bin.key} style={{ height: bin.height }} title={`Bin ${bin.binId}`} />
        ))}
      </div>
      <details className="distribution-details" open={bins.length <= 15 ? true : undefined}>
        <summary>Per-bin weights ({bins.length})</summary>
        <div className="distribution-table">
          {bins.map((bin) => (
            <div className="distribution-row" key={`${bin.key}-row`}>
              <span>
                {bin.delta} / {bin.binId}
              </span>
              <span>X {bin.xWeight}</span>
              <span>Y {bin.yWeight}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function LiquidityStateRows({
  actionError,
  inputError,
  insufficientBalance,
  pendingHash,
  revertedText,
  successText
}: {
  actionError: string | null;
  inputError: string | null;
  insufficientBalance: boolean;
  pendingHash: Address | undefined;
  revertedText: string | null;
  successText: string | null;
}) {
  const failure = revertedText ?? inputError ?? (insufficientBalance ? "Insufficient token balance" : null) ?? actionError;
  const transactionState = revertedText
    ? "Transaction failed"
    : successText
      ? "Transaction finalized"
      : actionError
        ? "Transaction not submitted"
        : pendingHash
          ? `Pending ${formatCompactAddress(pendingHash)}`
          : "Ready for wallet confirmation";

  return (
    <>
      <div className="state-row pending">
        <LoaderCircle size={16} />
        <span>{transactionState}</span>
      </div>
      <div className="state-row success">
        <CheckCircle2 size={16} />
        <span>{successText ?? "Receipt state will appear here"}</span>
      </div>
      <div className="state-row failure">
        <AlertTriangle size={16} />
        <span>{failure ?? "Rejected, reverted, and range errors appear here"}</span>
      </div>
    </>
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
      return loadWalletPortfolio(`${portfolioEndpoint}/graphql`, account.address);
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
      <p className="position-freshness">Claims pinned at {position.asOfBlock ? `block ${position.asOfBlock}` : "an unavailable head"}. {headPinned ? "RPC head matches." : "RPC head does not match; withdrawal actions are disabled."}</p>

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
    snapshot.runtime.blockNumber === position.asOfBlock
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

function PoolFocusCard({ pool }: { pool: PoolRow | null }) {
  const bars = useMemo(() => {
    if (!pool) return [];
    const reserveX = Number(formatUnits(BigInt(pool.reserveX), pool.tokenX?.decimals ?? 18));
    const reserveY = Number(formatUnits(BigInt(pool.reserveY), pool.tokenY?.decimals ?? 18));
    const base = Math.max(reserveX, reserveY, 1);
    return [
      { label: tokenSymbol(pool.tokenX), value: Math.max(12, (reserveX / base) * 100) },
      { label: tokenSymbol(pool.tokenY), value: Math.max(12, (reserveY / base) * 100) }
    ];
  }, [pool]);

  return (
    <section className="info-panel">
      <div className="panel-heading">
        <span>Pool State</span>
        <StatusBadge state={pool ? "ready" : "empty"} label={pool ? formatCompactAddress(pool.address) : "no pool"} />
      </div>

      {pool ? (
        <>
          <div className="reserve-bars">
            {bars.map((bar) => (
              <div className="bar-row" key={bar.label}>
                <span>{bar.label}</span>
                <div className="bar-track">
                  <span style={{ width: `${bar.value}%` }} />
                </div>
              </div>
            ))}
          </div>
          <dl className="contract-list">
            <div>
              <dt>Factory Pair</dt>
              <dd>{formatCompactAddress(pool.address)}</dd>
            </div>
            <div>
              <dt>Active ID</dt>
              <dd>{pool.activeId ?? "n/a"}</dd>
            </div>
            <div>
              <dt>Fees</dt>
              <dd>
                {formatTokenAmount(pool.feesX, pool.tokenX)} / {formatTokenAmount(pool.feesY, pool.tokenY)}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <EmptyState state="empty" />
      )}
    </section>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "neutral" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({
  icon: Icon,
  label,
  state
}: {
  icon: ComponentType<{ size?: number }>;
  label: string;
  state: LoadState;
}) {
  return (
    <div className={`status-pill ${state}`}>
      <Icon size={16} />
      <span>{label}</span>
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

function formatBlock(snapshot: AppSnapshot | undefined): string {
  if (snapshot?.runtime.blockNumber === null || snapshot?.runtime.blockNumber === undefined) return "offline";
  return snapshot.runtime.blockNumber.toString();
}

function formatPoolsMetric(snapshot: AppSnapshot | undefined): string {
  if (!snapshot) return "0";

  const pairCount = snapshot.indexer.pairCount ?? snapshot.indexer.pools.length.toString();
  return isPartialPagination(snapshot.indexer.pagination.pools) ? `${snapshot.indexer.pools.length}+ / ${pairCount}` : pairCount;
}

function paginationBadgeLabel(count: number, pageInfo: PaginationInfo, unit: string): string {
  return isPartialPagination(pageInfo) ? `${count}+ ${unit}` : `${count} ${unit}`;
}

function hasPartialActivity(snapshot: AppSnapshot | undefined): boolean {
  return Boolean(isPartialPagination(snapshot?.indexer.pagination.swaps) || isPartialPagination(snapshot?.indexer.pagination.liquidityEvents));
}

function activityBadgeLabel(snapshot: AppSnapshot | undefined, count: number): string {
  return hasPartialActivity(snapshot) ? `${count}+ events` : `${count} events`;
}

function isPartialPagination(pageInfo: PaginationInfo | null | undefined): boolean {
  return Boolean(pageInfo?.capped || pageInfo?.failed);
}

function formatActiveBin(snapshot: AppSnapshot | undefined): string {
  if (snapshot?.runtime.seededActiveId !== null && snapshot?.runtime.seededActiveId !== undefined) {
    return snapshot.runtime.seededActiveId.toString();
  }

  return snapshot?.indexer.pools[0]?.activeId ?? "n/a";
}

function useHashRoute(): [
  RouteKey,
  (route: RouteKey) => void,
  string | null,
  "add" | "withdraw" | null,
  string | null,
  string | null,
  "add" | "partial" | "full" | null
] {
  const readRoute = () => {
    const [next] = window.location.hash.replace("#/", "").split("/");
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
    const [route, encodedPoolId] = window.location.hash.replace("#/", "").split("/");
    return route === "pools" ? decodeRoutePart(encodedPoolId) : null;
  };
  const readPositionDetailId = () => {
    const [route, encodedId] = window.location.hash.replace("#/", "").split("/");
    return route === "positions" ? decodeRoutePart(encodedId) : null;
  };
  const readLiquiditySection = (): "add" | "withdraw" | null => {
    const [route, section] = window.location.hash.replace("#/", "").split("/");
    if (route !== "liquidity") return null;
    return section === "add" ? "add" : section === "withdraw" || section === "partial" || section === "full" ? "withdraw" : null;
  };
  const readActionPoolId = () => {
    const [route, sectionOrPool, liquidityPool] = window.location.hash.replace("#/", "").split("/");
    const knownSection = sectionOrPool === "add" || sectionOrPool === "withdraw" || sectionOrPool === "partial" || sectionOrPool === "full";
    const encodedPoolId = route === "swap"
      ? sectionOrPool
      : route === "liquidity"
        ? liquidityPool ?? (knownSection ? undefined : sectionOrPool)
        : undefined;
    return decodeRoutePart(encodedPoolId);
  };
  const readPortfolioAction = (): "add" | "partial" | "full" | null => {
    const [route, action] = window.location.hash.replace("#/", "").split("/");
    return route === "liquidity" && (action === "add" || action === "partial" || action === "full") ? action : null;
  };
  const [routeKey, setRouteKeyState] = useState<RouteKey>(readRoute);
  const [poolDetailId, setPoolDetailId] = useState<string | null>(readPoolDetailId);
  const [liquiditySection, setLiquiditySection] = useState<"add" | "withdraw" | null>(readLiquiditySection);
  const [actionPoolId, setActionPoolId] = useState<string | null>(readActionPoolId);
  const [positionDetailId, setPositionDetailId] = useState<string | null>(readPositionDetailId);
  const [portfolioAction, setPortfolioAction] = useState<"add" | "partial" | "full" | null>(readPortfolioAction);

  useEffect(() => {
    const listener = () => {
      setRouteKeyState(readRoute());
      setPoolDetailId(readPoolDetailId());
      setLiquiditySection(readLiquiditySection());
      setActionPoolId(readActionPoolId());
      setPositionDetailId(readPositionDetailId());
      setPortfolioAction(readPortfolioAction());
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
  };

  return [routeKey, setRouteKey, poolDetailId, liquiditySection, actionPoolId, positionDetailId, portfolioAction];
}
