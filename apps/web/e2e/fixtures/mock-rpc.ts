import type { Page } from "@playwright/test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, numberToHex, type Address, type Hex } from "viem";

import { erc20Abi, lbFactoryAbi, lbPairAbi, lbQuoterAbi, lbRouterAbi } from "../../../../packages/sdk/src/abi";
import { LB_Q128, quoteAddLiquidityMath, type AddLiquidityMathQuote } from "../../../../packages/sdk/src/liquidity-review";

export const LOCALNET_RPC_URL = "http://127.0.0.1:8545";
export const LOCALNET_INDEXER_URL = "http://127.0.0.1:8000/subgraphs/name/robinhood-lb/localnet";
export const LOCALNET_ANALYTICS_URL = "http://127.0.0.1:8787/graphql";
export const WNATIVE = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const USDC = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
export const USDT = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
export const WETH = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
export const WNATIVE_USDC_PAIR = "0x4A47586912f0e03d9f3DCAa762fB8B659E52604b";
export const SECOND_WNATIVE_USDC_PAIR = "0x2222222222222222222222222222222222222201";
export const ALT_WNATIVE_USDC_PAIR = "0x1111111111111111111111111111111111111101";
export const WNATIVE_USDT_PAIR = "0x1111111111111111111111111111111111111102";
export const USDT_USDC_PAIR = "0x1111111111111111111111111111111111111103";
export const WNATIVE_WETH_PAIR = "0x1111111111111111111111111111111111111104";
export const WETH_USDC_PAIR = "0x1111111111111111111111111111111111111105";
export const CREATED_WETH_USDT_PAIR = "0x3333333333333333333333333333333333333301";
export const LB_ROUTER = "0x0165878A594ca255338adfa4d48449f69242Eb8F";
export const LB_FACTORY = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
export const DEFAULT_ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const LOCALNET_CHAIN_ID = 31_337;
const ACTIVE_ID = 8_388_608;
const DEFAULT_BALANCE = 10_000_000_000_000_000_000n;
const DEFAULT_ALLOWANCE = 10_000_000_000_000_000_000n;
const DEFAULT_BLOCK_NUMBER = 42n;
const DEFAULT_POSITION_LIQUIDITY = 2_000_000_000_000_000_000n;
const TX_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111";
const LB_PAIR_RESERVES_ABI = [{
  type: "function",
  name: "getReserves",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "reserveX", type: "uint128" }, { name: "reserveY", type: "uint128" }]
}] as const;
const RPC_ABI = [...erc20Abi, ...lbFactoryAbi, ...lbPairAbi, ...lbQuoterAbi, ...lbRouterAbi, ...LB_PAIR_RESERVES_ABI] as const;
const ZERO_HOOKS = `0x${"0".repeat(64)}` as Hex;

export interface MockRpcOptions {
  activeId?: number;
  analyticsIncludeOtherOwner?: boolean;
  analyticsMetricTokenMismatch?: boolean;
  analyticsBinCount?: number;
  analyticsCandleGap?: boolean;
  analyticsAsOfBlock?: bigint;
  analyticsMode?: "ready" | "error";
  analyticsOutOfRange?: boolean;
  analyticsPartialHistory?: boolean;
  analyticsTransferred?: boolean;
  analyticsZeroLiquidity?: boolean;
  allowance?: bigint;
  allowanceAfterReceipt?: bigint;
  balance?: bigint;
  balanceAfterReceipt?: bigint;
  binReserveX?: bigint;
  binReserveY?: bigint;
  binTotalSupply?: bigint;
  blockHash?: Hex;
  blockNumber?: bigint;
  blockNumberAfterReceipt?: bigint;
  chainId?: number;
  clearPositionsAfterReceipt?: boolean;
  dashboardPoolLimit?: number;
  estimatedGas?: bigint;
  gasEstimateMode?: "ready" | "error";
  gasEstimateDelayMs?: number;
  gasLimit?: bigint;
  gasPrice?: bigint;
  factoryAddress?: Address;
  factoryLookupIgnored?: boolean;
  factoryLookupPair?: Address;
  createdPairAddress?: Address;
  poolCreationOpenBinSteps?: bigint[];
  poolCreationQuoteAssets?: Address[];
  poolCreationPresetOpen?: boolean;
  hookAddress?: Address;
  hookCode?: Hex;
  hooksParameters?: Hex;
  indexedHooksParameters?: Hex | null;
  pairCode?: Hex;
  pairCodeDelayMs?: number;
  pairFactoryAddress?: Address;
  includePairs?: boolean;
  includePositions?: boolean;
  indexerBlockNumber?: bigint;
  indexerBlockHash?: Hex;
  indexerDelayMs?: number;
  indexerDelayMsAfterReceipt?: number;
  indexerHasErrors?: boolean;
  indexerMode?: "ready" | "error";
  lbApproved?: boolean;
  lbApprovedAfterReceipt?: boolean;
  livePositionBalance?: bigint;
  maxRemoveLiquidityBinsForEstimate?: number;
  maxRemoveLiquidityBinsForSimulation?: number;
  nativeBalance?: bigint;
  nativeBalanceAfterReceipt?: bigint;
  nativeRemoveReceiptMismatch?: "other-token-transfer" | "lp-balance";
  noCodeAddresses?: Address[];
  omitActivePoolBin?: boolean;
  ownerPositionCount?: number;
  ownerPositionsFailAtSkip?: number;
  pairReserveX?: bigint;
  pairReserveXAfterReceipt?: bigint;
  pairReserveY?: bigint;
  pairAddress?: string;
  pairBinStep?: string;
  pairRuntimeBinStep?: number;
  pairRuntimeTokenX?: Address;
  pairRuntimeTokenY?: Address;
  pairTokenX?: string;
  pairTokenXAfterReceipt?: string;
  pairTokenY?: string;
  pairByIdDelayMs?: number;
  pairByIdMode?: "ready" | "error";
  positionOwner?: Address;
  positionPair?: Address;
  positionLiquidity?: bigint;
  priceQ128ByBin?: Readonly<Record<string, bigint>>;
  poolCount?: number;
  poolBinCount?: number;
  poolBinsMode?: "ready" | "error";
  quoteMode?: "ready" | "error" | "no-route";
  quoteDelayMs?: number;
  quoteDelayMsAfterReceipt?: number;
  quotePreferMultiHop?: boolean;
  quoteRate?: bigint;
  quoteRateAfterReceipt?: bigint;
  quoteUseAlternateDirectPool?: boolean;
  quoteVersion?: number;
  receiptStatus?: "success" | "reverted";
  receiptBlockNumber?: bigint;
  receiptDelayMs?: number;
  transactionEffectsByHash?: Readonly<Record<string, "lb-approval" | "remove">>;
  simulationDelayMs?: number;
  simulationMode?: "success" | "error";
  walletReadMode?: "ready" | "error";
  walletReadDelayMs?: number;
}

export interface MockRpcSnapshot {
  ethCalls: Array<{ address: string | null; blockTag: string | null; data: Hex; functionName: string; value: string | null }>;
  gasEstimatesCompleted: number;
  graphQueries: string[];
  graphRequests: Array<{ query: string; variables: GraphRequest["variables"] }>;
  methods: string[];
  rpcHttpRequests: number;
  receiptObserved: boolean;
  creationConfirmed: boolean;
  createdTokenX: Address | null;
  createdTokenY: Address | null;
  createdBinStep: number | null;
  createdActiveId: number | null;
  lastAddLiquidity: {
    functionName: "addLiquidity" | "addLiquidityNATIVE";
    parameters: {
      amountX: bigint;
      amountY: bigint;
      tokenX: Address;
      tokenY: Address;
    };
    quote: AddLiquidityMathQuote;
  } | null;
  lastRemoveLiquidity: {
    amounts: bigint[];
    amountX: bigint;
    amountY: bigint;
    functionName: "removeLiquidity" | "removeLiquidityNATIVE";
    ids: bigint[];
  } | null;
}

export interface InstalledMockRpc {
  snapshot: () => MockRpcSnapshot;
  update: (options: Partial<MockRpcOptions>) => void;
}

interface RpcRequest {
  id?: number | string | null;
  jsonrpc?: string;
  method: string;
  params?: unknown[];
}

interface RpcCall {
  data?: Hex;
  to?: Address;
  value?: string;
}

interface GraphRequest {
  query?: string;
  variables?: {
    after?: string | null;
    asOfTimestamp?: number;
    first?: number;
    fromTimestamp?: number;
    id?: string;
    interval?: "HOUR" | "DAY";
    owner?: string;
    pair?: string;
    skip?: number;
    toTimestamp?: number;
  };
}

export async function installMockRpc(page: Page, options: MockRpcOptions = {}): Promise<InstalledMockRpc> {
  const currentOptions = { ...options };
  const state: MockRpcSnapshot = {
    ethCalls: [],
    gasEstimatesCompleted: 0,
    graphQueries: [],
    graphRequests: [],
    methods: [],
    rpcHttpRequests: 0,
    receiptObserved: false,
    creationConfirmed: false,
    createdTokenX: null,
    createdTokenY: null,
    createdBinStep: null,
    createdActiveId: null,
    lastAddLiquidity: null,
    lastRemoveLiquidity: null
  };

  await page.route(`${LOCALNET_RPC_URL}/`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: corsHeaders(), status: 204 });
      return;
    }

    state.rpcHttpRequests += 1;

    const payload = JSON.parse(request.postData() ?? "null") as RpcRequest | RpcRequest[];
    const response = Array.isArray(payload)
      ? await Promise.all(payload.map((item) => handleRpc(item, currentOptions, state)))
      : await handleRpc(payload, currentOptions, state);

    await route.fulfill({
      body: JSON.stringify(response),
      contentType: "application/json",
      headers: corsHeaders(),
      status: 200
    });
  });
  await page.route(LOCALNET_INDEXER_URL, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: corsHeaders(), status: 204 });
      return;
    }

    const body = JSON.parse(request.postData() ?? "{}") as GraphRequest;
    state.graphQueries.push(body.query ?? "");
    state.graphRequests.push({ query: body.query ?? "", variables: body.variables });
    if (currentOptions.indexerDelayMs !== undefined) {
      await delay(currentOptions.indexerDelayMs);
    }
    if (body.query?.includes("PairById") && currentOptions.pairByIdDelayMs !== undefined) {
      await delay(currentOptions.pairByIdDelayMs);
    }

    await route.fulfill({
      body: JSON.stringify(mockGraphResponse(body, currentOptions)),
      contentType: "application/json",
      headers: corsHeaders(),
      status: 200
    });
  });
  await page.route(LOCALNET_ANALYTICS_URL, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: corsHeaders(), status: 204 });
      return;
    }
    const body = JSON.parse(request.postData() ?? "{}") as GraphRequest;
    state.graphQueries.push(body.query ?? "");
    state.graphRequests.push({ query: body.query ?? "", variables: body.variables });
    let response: Record<string, unknown>;
    try {
      response = mockAnalyticsResponse(body, currentOptions);
    } catch (error) {
      response = { errors: [{ message: error instanceof Error ? error.message : "Mock analytics response failed" }] };
    }
    await route.fulfill({
      body: JSON.stringify(response),
      contentType: "application/json",
      headers: corsHeaders(),
      status: 200
    });
  });

  return {
    snapshot: () => ({
      ethCalls: [...state.ethCalls],
      gasEstimatesCompleted: state.gasEstimatesCompleted,
      graphQueries: [...state.graphQueries],
      graphRequests: state.graphRequests.map((request) => ({ query: request.query, variables: request.variables ? { ...request.variables } : undefined })),
      methods: [...state.methods],
      rpcHttpRequests: state.rpcHttpRequests
    }),
    update: (nextOptions) => Object.assign(currentOptions, nextOptions)
  };
}

function mockAnalyticsResponse(body: GraphRequest, options: MockRpcOptions): Record<string, unknown> {
  if (options.analyticsMode === "error") return { errors: [{ message: "Mock analytics failed" }] };
  const query = body.query ?? "";
  const partial = options.analyticsPartialHistory === true;
  const analyticsStatus = partial ? "PARTIAL" : "READY";
  if (query.includes("WebPoolMetrics")) {
    const pairMetadata = allPairMetadata(options);
    const dashboardPairMetadata = [pairMetadata[0]!, pairMetadata.at(-1)!, ...pairMetadata.slice(1, -1)];
    const nodes = dashboardPairMetadata.slice(0, options.poolCount ?? 1).map((metadata, index) => ({
      pair: metadata.pair.toLowerCase(),
      tokenX: (options.analyticsMetricTokenMismatch ? USDT : metadata.tokenX).toLowerCase(),
      tokenY: metadata.tokenY.toLowerCase(),
      tvlUsdE18: partial ? null : String((500_000n - BigInt(index) * 10_000n) * 10n ** 18n),
      volume24hUsdE18: String((120_000n - BigInt(index) * 1_000n) * 10n ** 18n),
      fees24hUsdE18: String((240n - BigInt(index)) * 10n ** 18n),
      feeToTvlE18: partial ? null : "480000000000000",
      priceUsdE18: "2500000000000000000",
      asOfBlock: String(options.analyticsAsOfBlock ?? options.blockNumber ?? DEFAULT_BLOCK_NUMBER),
      asOfTimestamp: 1_720_000_000,
      status: analyticsStatus,
      missingPriceTokens: partial ? [metadata.tokenX.toLowerCase()] : []
    })).sort((left, right) => left.pair.localeCompare(right.pair));
    return { data: { poolMetrics: { nodes, pageInfo: { endCursor: null, hasNextPage: false, partial } } } };
  }
  if (query.includes("WebPairCandles")) {
    const pair = body.variables?.pair ?? WNATIVE_USDC_PAIR.toLowerCase();
    const from = body.variables?.fromTimestamp ?? 1_719_913_600;
    const to = body.variables?.toTimestamp ?? from + 23 * 3_600;
    const interval = body.variables?.interval ?? "HOUR";
    const seconds = interval === "DAY" ? 86_400 : 3_600;
    const nodes = Array.from({ length: Math.floor((to - from) / seconds) + 1 }, (_, index) => {
      const open = 2_400_000_000_000_000_000n + BigInt(index) * 2_000_000_000_000_000n;
      const close = open + 1_000_000_000_000_000n;
      return {
        pair,
        interval,
        startTimestamp: from + index * seconds,
        endTimestamp: from + (index + 1) * seconds,
        openUsdE18: partial && index === 0 ? null : open.toString(),
        highUsdE18: partial && index === 0 ? null : (close + 2_000_000_000_000_000n).toString(),
        lowUsdE18: partial && index === 0 ? null : (open - 2_000_000_000_000_000n).toString(),
        closeUsdE18: partial && index === 0 ? null : close.toString(),
        volumeUsdE18: String((10_000n + BigInt(index) * 100n) * 10n ** 18n),
        feesUsdE18: String((20n + BigInt(index)) * 10n ** 18n),
        tvlUsdE18: String(500_000n * 10n ** 18n),
        swapCount: 20 + index,
        status: partial && index === 0 ? "PARTIAL" : "READY",
        missingPriceTokens: partial && index === 0 ? [WNATIVE.toLowerCase()] : [],
        firstBlock: String(100 + index),
        lastBlock: String(100 + index)
      };
    }).filter((_, index) => options.analyticsCandleGap !== true || index !== 1);
    return { data: { pairCandles: { nodes, pageInfo: { endCursor: null, hasNextPage: false, partial } } } };
  }
  if (query.includes("WebAnalyticsHealth")) {
    return { data: { analyticsHealth: mockAnalyticsHealth(options, partial) } };
  }
  const owner = body.variables?.owner ?? DEFAULT_ACCOUNT;
  const binId = options.analyticsOutOfRange === true ? activeIdFor(options) + 10 : activeIdFor(options);
  const transferred = options.analyticsTransferred === true;
  const analyticsBins = transferred
    ? []
    : Array.from({ length: options.analyticsBinCount ?? 1 }, (_, index) => ({
        binId: String(binId + index),
        liquidity: options.analyticsZeroLiquidity === true ? "0" : String(options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY),
        amountX: "50000000000000000000",
        amountY: "70000000000000000000",
        costBasisUsdE18: partial ? null : "100000000000000000000",
        currentValueUsdE18: "120000000000000000000",
        realizedPnlUsdE18: partial ? null : "5000000000000000000",
        unrealizedPnlUsdE18: partial ? null : "20000000000000000000",
        asOfBlock: String(options.analyticsAsOfBlock ?? options.blockNumber ?? DEFAULT_BLOCK_NUMBER),
        asOfTimestamp: 1_720_000_000,
        status: partial ? "PARTIAL" : "READY",
        missingPriceTokens: partial ? [WNATIVE.toLowerCase()] : []
      }));
  const position = {
    owner,
    pair: WNATIVE_USDC_PAIR.toLowerCase(),
    costBasisUsdE18: transferred ? "0" : partial ? null : "100000000000000000000",
    currentValueUsdE18: transferred ? "0" : "120000000000000000000",
    realizedPnlUsdE18: partial ? null : "5000000000000000000",
    unrealizedPnlUsdE18: partial ? null : "20000000000000000000",
    status: partial ? "PARTIAL" : "READY",
    missingPriceTokens: partial ? [WNATIVE.toLowerCase()] : [],
    asOfBlock: String(options.analyticsAsOfBlock ?? options.blockNumber ?? DEFAULT_BLOCK_NUMBER),
    asOfTimestamp: 1_720_000_000,
    bins: analyticsBins
  };
  const nodes = options.includePositions === true ? [position] : [];
  if (options.analyticsIncludeOtherOwner === true) {
    nodes.push({ ...position, owner: "0x0000000000000000000000000000000000000001" });
  }
  return {
    data: {
      analyticsHealth: {
        fresh: true,
        headBlock: String(options.analyticsAsOfBlock ?? options.blockNumber ?? DEFAULT_BLOCK_NUMBER),
        status: partial ? "PARTIAL" : "READY"
      },
      walletPositions: { nodes, pageInfo: { endCursor: null, hasNextPage: false, partial } }
    }
  };
}

function mockAnalyticsHealth(options: MockRpcOptions, partial: boolean): Record<string, unknown> {
  return {
    status: partial ? "PARTIAL" : "READY",
    headBlock: String(options.analyticsAsOfBlock ?? options.blockNumber ?? DEFAULT_BLOCK_NUMBER),
    headHash: options.blockHash ?? "0x2222222222222222222222222222222222222222222222222222222222222222",
    headTimestamp: 1_720_000_000,
    canonicalBlockCount: 42,
    reorgCount: 0,
    partialEventCount: partial ? 1 : 0,
    missingPriceTokens: partial ? [WNATIVE.toLowerCase()] : [],
    fresh: !partial,
    headLagSeconds: partial ? 120 : 0,
    maxHeadLagSeconds: 60,
    backfillStatus: partial ? "partial" : "complete",
    backfillCursor: null,
    backfillError: null,
    coverageStartTimestamp: "1719913600",
    coverageThroughTimestamp: "1720000000",
    prices: [{ token: WNATIVE.toLowerCase(), source: "mock", feedId: "wnative-usd", status: partial ? "missing" : "available", observedAt: 1_720_000_000, ageSeconds: 0 }]
  };
}

function mockGraphResponse(body: GraphRequest, options: MockRpcOptions): Record<string, unknown> {
  const query = body.query ?? "";

  if (query.includes("DashboardSummary")) {
    if (options.indexerMode === "error") {
      return { errors: [{ message: "Mock indexer summary failed" }] };
    }

    return {
      data: {
        _meta: {
          block: {
            hash: options.indexerBlockHash ?? options.blockHash ?? "0x2222222222222222222222222222222222222222222222222222222222222222",
            number: Number(options.indexerBlockNumber ?? DEFAULT_BLOCK_NUMBER)
          },
          hasIndexingErrors: options.indexerHasErrors ?? false
        },
        factory: {
          pairCount: options.includePairs === true ? String(options.poolCount ?? 1) : "0"
        }
      }
    };
  }

  if (query.includes("PairById")) {
    if (options.pairByIdMode === "error") return { errors: [{ message: "Mock pair lookup failed" }] };
    const pair = typeof body.variables?.id === "string" ? mockPairByAddress(options, body.variables.id) : null;
    return { data: { pair } };
  }
  if (query.includes("PairsPage")) {
    return {
      data: {
        pairs: options.includePairs === true
          ? Array.from({ length: options.poolCount ?? 1 }, (_, index) => mockPair(options, index)).slice(0, options.dashboardPoolLimit)
          : []
      }
    };
  }
  if (query.includes("PairBinWindow")) {
    if (options.poolBinsMode === "error") return { errors: [{ message: "Mock pool bin window failed" }] };
    const count = options.poolBinCount ?? 5;
    const bins = Array.from({ length: count }, (_, index) => mockBin(options, index, count)).filter(
      (bin) => options.omitActivePoolBin !== true || bin.binId !== activeIdFor(options).toString()
    );
    return { data: { bins } };
  }
  if (query.includes("PairBins")) {
    const skip = body.variables?.skip ?? 0;
    const count = options.poolBinCount ?? 5;
    const first = body.variables?.first ?? count;
    const bins = Array.from({ length: Math.max(0, Math.min(first, count - skip)) }, (_, index) =>
      mockBin(options, skip + index, count)
    );
    return { data: { bins } };
  }
  if (query.includes("SwapsPage")) return { data: { swaps: [] } };
  if (query.includes("LiquidityEventsPage")) return { data: { liquidityEvents: [] } };
  if (query.includes("PositionLiquidityHistory")) {
    const owner = body.variables?.owner ?? DEFAULT_ACCOUNT;
    return {
      data: {
        liquidityEvents: options.includePositions === true
          ? [
              {
                id: "deposit-1",
                type: "DEPOSIT",
                transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                blockNumber: "40",
                timestamp: "1720000000",
                amountX: "10000000000000000000",
                amountY: "20000000000000000000",
                ids: [String(activeIdFor(options))],
                sender: owner,
                to: owner
              },
              {
                id: "withdraw-1",
                type: "WITHDRAW",
                transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                blockNumber: "41",
                timestamp: "1720000100",
                amountX: "1000000000000000000",
                amountY: "2000000000000000000",
                ids: [String(activeIdFor(options))],
                sender: owner,
                to: owner
              }
            ]
          : [],
        transferBatchEvents: options.analyticsTransferred === true
          ? [{
              id: "transfer-out-1",
              transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              blockNumber: "42",
              timestamp: "1720000200",
              sender: owner,
              from: owner,
              to: "0x0000000000000000000000000000000000000002",
              ids: [String(activeIdFor(options))]
            }]
          : []
      }
    };
  }
  if (query.includes("OwnerPairPositions")) {
    const skip = body.variables?.skip ?? 0;
    if (options.ownerPositionsFailAtSkip !== undefined && skip >= options.ownerPositionsFailAtSkip) {
      return { errors: [{ message: "Mock owner positions page failed" }] };
    }

    const count = shouldIncludeOwnerPairPosition(body, options) ? options.ownerPositionCount ?? 1 : 0;
    const first = body.variables?.first ?? count;
    const positions = Array.from({ length: Math.max(0, Math.min(first, count - skip)) }, (_, index) =>
      mockPosition(options, skip + index)
    );

    return { data: { positions } };
  }
  if (query.includes("PositionsPage")) {
    return { data: { positions: options.includePositions === true ? [mockPosition(options)] : [] } };
  }

  return { errors: [{ message: "Unhandled mock GraphQL query" }] };
}

async function handleRpc(request: RpcRequest, options: MockRpcOptions, state: MockRpcSnapshot): Promise<unknown> {
  state.methods.push(request.method);

  try {
    switch (request.method) {
      case "eth_chainId":
        return rpcResult(request, numberToHex(options.chainId ?? LOCALNET_CHAIN_ID));
      case "eth_blockNumber":
        return rpcResult(request, numberToHex(options.blockNumber ?? DEFAULT_BLOCK_NUMBER));
      case "eth_getTransactionCount":
        return rpcResult(request, "0x0");
      case "eth_getBlockByNumber":
        return rpcResult(request, {
          gasLimit: numberToHex(options.gasLimit ?? 30_000_000n),
          hash: options.blockHash ?? "0x2222222222222222222222222222222222222222222222222222222222222222",
          number: typeof request.params?.[0] === "string" && request.params[0].startsWith("0x")
            ? request.params[0]
            : numberToHex(options.blockNumber ?? DEFAULT_BLOCK_NUMBER),
          timestamp: numberToHex(1_720_000_000n)
        });
      case "eth_estimateGas":
        if (options.gasEstimateDelayMs !== undefined) await delay(options.gasEstimateDelayMs);
        state.gasEstimatesCompleted += 1;
        if (options.gasEstimateMode === "error") return rpcError(request, -32_000, "Mock gas estimation failed");
        if (
          options.maxRemoveLiquidityBinsForEstimate !== undefined &&
          removeLiquidityBinCount((request.params?.[0] as RpcCall | undefined)?.data) > options.maxRemoveLiquidityBinsForEstimate
        ) return rpcError(request, -32_000, "Mock remove-liquidity batch exceeds the gas-safe bin bound");
        return rpcResult(request, numberToHex(options.estimatedGas ?? 500_000n));
      case "eth_gasPrice":
        return rpcResult(request, numberToHex(options.gasPrice ?? 1_000_000_000n));
      case "eth_getTransactionReceipt": {
        if (options.receiptDelayMs !== undefined) await delay(options.receiptDelayMs);
        const receiptBlockNumber = options.receiptBlockNumber ?? options.blockNumber ?? DEFAULT_BLOCK_NUMBER;
        const transactionHash = typeof request.params?.[0] === "string" ? request.params[0] as Hex : TX_HASH;
        const transactionEffect = options.transactionEffectsByHash?.[transactionHash.toLowerCase()] ?? "default";
        if (transactionEffect !== "lb-approval") state.receiptObserved = true;
        if ((options.receiptStatus ?? "success") === "success") {
          if (transactionEffect !== "lb-approval") {
            if (options.clearPositionsAfterReceipt === true) options.includePositions = false;
            if (options.allowanceAfterReceipt !== undefined) options.allowance = options.allowanceAfterReceipt;
            if (options.indexerDelayMsAfterReceipt !== undefined) options.indexerDelayMs = options.indexerDelayMsAfterReceipt;
          }
          if (options.lbApprovedAfterReceipt !== undefined) options.lbApproved = options.lbApprovedAfterReceipt;
          if (transactionEffect !== "lb-approval") {
            if (options.pairReserveXAfterReceipt !== undefined) options.pairReserveX = options.pairReserveXAfterReceipt;
            if (options.pairTokenXAfterReceipt !== undefined) options.pairTokenX = options.pairTokenXAfterReceipt;
            if (options.quoteDelayMsAfterReceipt !== undefined) options.quoteDelayMs = options.quoteDelayMsAfterReceipt;
            if (options.quoteRateAfterReceipt !== undefined) options.quoteRate = options.quoteRateAfterReceipt;
            if (options.blockNumberAfterReceipt !== undefined) options.blockNumber = options.blockNumberAfterReceipt;
          }
          const createCall = transactionEffect === "default"
            ? state.ethCalls.findLast((call) => call.functionName === "createLBPair")
            : undefined;
          if (createCall !== undefined) {
            const decoded = decodeFunctionData({ abi: lbRouterAbi, data: createCall.data });
            const [tokenX, tokenY, activeId, binStep] = decoded.args as readonly [Address, Address, number, number];
            state.creationConfirmed = true;
            state.createdTokenX = tokenX;
            state.createdTokenY = tokenY;
            state.createdActiveId = activeId;
            state.createdBinStep = binStep;
          }
        }
        return rpcResult(request, transactionReceipt(receiptBlockNumber, options.receiptStatus ?? "success", options, state, transactionHash, transactionEffect));
      }
      case "eth_getTransactionByHash": {
        const transactionHash = typeof request.params?.[0] === "string" ? request.params[0] as Hex : TX_HASH;
        const transactionEffect = options.transactionEffectsByHash?.[transactionHash.toLowerCase()] ?? "default";
        return rpcResult(request, transactionByHash(options.receiptBlockNumber ?? options.blockNumber ?? DEFAULT_BLOCK_NUMBER, state, transactionHash, transactionEffect));
      }
      case "eth_getBalance": {
        const requestedBlock = request.params?.[1];
        const receiptBlock = numberToHex(options.receiptBlockNumber ?? options.blockNumber ?? DEFAULT_BLOCK_NUMBER);
        const nativeAddValue = state.lastAddLiquidity?.functionName === "addLiquidityNATIVE"
          ? addressEquals(state.lastAddLiquidity.parameters.tokenX, WNATIVE)
            ? state.lastAddLiquidity.parameters.amountX
            : state.lastAddLiquidity.parameters.amountY
          : null;
        const nativeRemoveAmount = state.lastRemoveLiquidity?.functionName === "removeLiquidityNATIVE"
          ? state.lastRemoveLiquidity.amountX
          : null;
        const balance = requestedBlock === receiptBlock
          ? options.nativeBalanceAfterReceipt ?? (nativeRemoveAmount !== null
            ? (options.nativeBalance ?? DEFAULT_BALANCE) + nativeRemoveAmount - 100_000n
            : nativeAddValue === null ? options.nativeBalance ?? DEFAULT_BALANCE : (options.nativeBalance ?? DEFAULT_BALANCE) - nativeAddValue - 100_000n)
          : options.nativeBalance ?? DEFAULT_BALANCE;
        return rpcResult(request, numberToHex(balance));
      }
      case "eth_getCode": {
        const address = String(request.params?.[0] ?? "").toLowerCase();
        if (options.noCodeAddresses?.some((candidate) => candidate.toLowerCase() === address)) {
          return rpcResult(request, "0x");
        }
        if (options.hookAddress && address === options.hookAddress.toLowerCase()) {
          return rpcResult(request, options.hookCode ?? "0x6001600055");
        }
        if (allPairMetadata(options).some((item) => item.pair.toLowerCase() === address)) {
          if (options.pairCodeDelayMs) await delay(options.pairCodeDelayMs);
          return rpcResult(request, options.pairCode ?? "0x6001600055");
        }
        return rpcResult(request, "0x6001600055");
      }
      case "eth_call":
        if (
          options.receiptStatus === "reverted" &&
          typeof request.params?.[1] === "object" &&
          request.params?.[1] !== null &&
          "blockHash" in request.params[1]
        ) {
          throw new Error("execution reverted: Mock transaction reverted");
        }
        return rpcResult(
          request,
          await handleEthCall(
            request.params?.[0] as RpcCall | undefined,
            typeof request.params?.[1] === "string" ? request.params[1] : null,
            options,
            state
          )
        );
      default:
        return rpcError(request, -32_601, `Unhandled mock RPC method: ${request.method}`);
    }
  } catch (error) {
    return rpcError(request, -32_000, error instanceof Error ? error.message : "Mock RPC request failed");
  }
}

async function handleEthCall(
  call: RpcCall | undefined,
  blockTag: string | null,
  options: MockRpcOptions,
  state: MockRpcSnapshot
): Promise<Hex> {
  if (!call?.data) throw new Error("Missing eth_call data");

  const decoded = decodeFunctionData({
    abi: RPC_ABI,
    data: call.data
  });
  const functionName = decoded.functionName;
  state.ethCalls.push({ address: call.to ?? null, blockTag, data: call.data, functionName, value: call.value ?? null });

  if (
    options.simulationDelayMs !== undefined &&
    ["addLiquidity", "addLiquidityNATIVE", "approve", "approveForAll", "createLBPair", "removeLiquidity", "removeLiquidityNATIVE", "swapExactTokensForTokens", "swapExactNATIVEForTokens", "swapExactTokensForNATIVE"].includes(
      functionName
    )
  ) {
    await delay(options.simulationDelayMs);
  }

  if ((functionName === "balanceOf" || functionName === "allowance" || functionName === "isApprovedForAll") && options.walletReadDelayMs !== undefined) {
    await delay(options.walletReadDelayMs);
  }

  if ((functionName === "balanceOf" || functionName === "allowance" || functionName === "isApprovedForAll") && options.walletReadMode === "error") {
    throw new Error("Mock wallet read failed");
  }

  if (functionName === "decimals") {
    return encodeFunctionResult({ abi: erc20Abi, functionName, result: 18 });
  }

  if (functionName === "symbol") {
    const symbol = addressEquals(call.to ?? "", WNATIVE)
      ? "WNATIVE"
      : addressEquals(call.to ?? "", USDC)
        ? "USDC"
        : addressEquals(call.to ?? "", USDT)
          ? "USDT"
          : addressEquals(call.to ?? "", WETH)
            ? "WETH"
            : "MOCK";
    return encodeFunctionResult({ abi: erc20Abi, functionName, result: symbol });
  }

  if (functionName === "getOpenBinSteps") {
    return encodeFunctionResult({ abi: lbFactoryAbi, functionName, result: options.poolCreationOpenBinSteps ?? [10n, 25n] });
  }

  if (functionName === "getNumberOfQuoteAssets") {
    return encodeFunctionResult({ abi: lbFactoryAbi, functionName, result: BigInt((options.poolCreationQuoteAssets ?? [USDC, USDT]).length) });
  }

  if (functionName === "getQuoteAssetAtIndex") {
    const [index] = decoded.args as readonly [bigint];
    const quote = (options.poolCreationQuoteAssets ?? [USDC, USDT])[Number(index)];
    if (!quote) throw new Error("Missing mock quote asset");
    return encodeFunctionResult({ abi: lbFactoryAbi, functionName, result: quote });
  }

  if (functionName === "isQuoteAsset") {
    const [token] = decoded.args as readonly [Address];
    return encodeFunctionResult({
      abi: lbFactoryAbi,
      functionName,
      result: (options.poolCreationQuoteAssets ?? [USDC, USDT]).some((asset) => addressEquals(asset, token))
    });
  }

  if (functionName === "getPreset") {
    return encodeFunctionResult({
      abi: lbFactoryAbi,
      functionName,
      result: [20n, 30n, 600n, 5_000n, 40_000n, 1_000n, 350_000n, options.poolCreationPresetOpen ?? true]
    });
  }

  if (functionName === "getTokenX") {
    const createdPair = options.createdPairAddress ?? CREATED_WETH_USDT_PAIR;
    const result = state.creationConfirmed && addressEquals(call.to ?? "", createdPair)
      ? state.createdTokenX!
      : options.pairRuntimeTokenX ?? pairMetadata(call.to, options).tokenX;
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result });
  }

  if (functionName === "getTokenY") {
    const createdPair = options.createdPairAddress ?? CREATED_WETH_USDT_PAIR;
    const result = state.creationConfirmed && addressEquals(call.to ?? "", createdPair)
      ? state.createdTokenY!
      : options.pairRuntimeTokenY ?? pairMetadata(call.to, options).tokenY;
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result });
  }

  if (functionName === "getFactory") {
    const pairCall = allPairMetadata(options).some((item) => addressEquals(item.pair, call.to ?? "")) ||
      (state.creationConfirmed && addressEquals(call.to ?? "", options.createdPairAddress ?? CREATED_WETH_USDT_PAIR));
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result: pairCall ? options.pairFactoryAddress ?? options.factoryAddress ?? LB_FACTORY : options.factoryAddress ?? LB_FACTORY });
  }

  if (functionName === "getFactoryV2_2") {
    return encodeFunctionResult({ abi: lbQuoterAbi, functionName, result: options.factoryAddress ?? LB_FACTORY });
  }

  if (functionName === "getRouterV2_2") {
    return encodeFunctionResult({ abi: lbQuoterAbi, functionName, result: LB_ROUTER });
  }

  if (functionName === "implementation" || functionName === "getLBPairImplementation") {
    const implementation = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707" as Address;
    return encodeFunctionResult({ abi: functionName === "implementation" ? lbPairAbi : lbFactoryAbi, functionName, result: implementation });
  }

  if (functionName === "getBinStep") {
    const createdPair = options.createdPairAddress ?? CREATED_WETH_USDT_PAIR;
    const result = state.creationConfirmed && addressEquals(call.to ?? "", createdPair)
      ? state.createdBinStep!
      : options.pairRuntimeBinStep ?? pairMetadata(call.to, options).binStep;
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result });
  }

  if (functionName === "getLBHooksParameters") {
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result: options.hooksParameters ?? ZERO_HOOKS });
  }

  if (functionName === "getLBPairInformation") {
    const [tokenX, tokenY, requestedBinStep] = decoded.args as readonly [Address, Address, bigint];
    const metadata = allPairMetadata(options).find((item) =>
      item.binStep === Number(requestedBinStep) && tokenPairKey(item.tokenX, item.tokenY) === tokenPairKey(tokenX, tokenY)
    );
    const createdPair = options.createdPairAddress ?? CREATED_WETH_USDT_PAIR;
    const createdMatch = state.creationConfirmed && state.createdTokenX && state.createdTokenY && state.createdBinStep === Number(requestedBinStep) &&
      tokenPairKey(state.createdTokenX, state.createdTokenY) === tokenPairKey(tokenX, tokenY);
    const resolvedPair = options.factoryLookupPair ?? (createdMatch ? createdPair : metadata?.pair) ?? "0x0000000000000000000000000000000000000000";
    return encodeFunctionResult({
      abi: lbFactoryAbi,
      functionName,
      result: {
        LBPair: resolvedPair,
        binStep: addressEquals(resolvedPair, "0x0000000000000000000000000000000000000000")
          ? 0
          : options.pairRuntimeBinStep ?? (createdMatch ? state.createdBinStep! : metadata?.binStep) ?? Number(requestedBinStep),
        createdByOwner: false,
        ignoredForRouting: options.factoryLookupIgnored ?? false
      }
    });
  }

  if (functionName === "getActiveId") {
    const createdPair = options.createdPairAddress ?? CREATED_WETH_USDT_PAIR;
    const result = state.creationConfirmed && addressEquals(call.to ?? "", createdPair) ? state.createdActiveId! : activeIdFor(options);
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result });
  }

  if (functionName === "getPriceFromId") {
    const [requestedId] = decoded.args as readonly [bigint];
    return encodeFunctionResult({
      abi: lbPairAbi,
      functionName,
      result: options.priceQ128ByBin?.[requestedId.toString()] ?? LB_Q128
    });
  }

  if (functionName === "getIdFromPrice") {
    const [requestedPrice] = decoded.args as readonly [bigint];
    const match = Object.entries(options.priceQ128ByBin ?? {}).find(([, price]) => price === requestedPrice);
    if (match === undefined) throw new Error("Mock price does not map to a configured LB bin");
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result: Number(match[0]) });
  }

  if (functionName === "getStaticFeeParameters") {
    return encodeFunctionResult({
      abi: lbPairAbi,
      functionName,
      result: [1, 10, 20, 5_000, 0, 0, 100_000]
    });
  }

  if (functionName === "getVariableFeeParameters") {
    return encodeFunctionResult({
      abi: lbPairAbi,
      functionName,
      result: [0, 0, activeIdFor(options), 1_720_000_000]
    });
  }

  if (functionName === "findBestPathFromAmountIn") {
    if (options.quoteDelayMs !== undefined) await delay(options.quoteDelayMs);
    if (options.quoteMode === "error") throw new Error("Mock quote failed");

    const requestedRoute = decoded.args[0] as readonly Address[] | undefined;
    const route = requestedRoute !== undefined && requestedRoute.length >= 2 ? [...requestedRoute] : [WNATIVE, USDC];
    const amountIn = (decoded.args[1] as bigint | undefined) ?? 1_000_000_000_000_000_000n;
    const hopRate = options.quoteRate ?? (options.quotePreferMultiHop === true && route.length > 2 ? 1_001n : route.length > 2 ? 998n : 999n);
    const amounts = [amountIn];
    for (let index = 1; index < route.length; index += 1) {
      amounts.push(options.quoteMode === "no-route" ? 0n : (amounts[index - 1] * hopRate) / 1_000n);
    }
    const hopCount = route.length - 1;
    const pairs = Array.from({ length: hopCount }, (_, index) =>
      options.quoteMode === "no-route"
        ? "0x0000000000000000000000000000000000000000"
        : quotePairForLeg(route[index], route[index + 1], options.quoteUseAlternateDirectPool === true)
    );
    const binSteps = Array.from({ length: hopCount }, (_, index) =>
      quoteBinStepForLeg(route[index], route[index + 1], options.quoteUseAlternateDirectPool === true)
    );

    return encodeFunctionResult({
      abi: lbQuoterAbi,
      functionName,
      result: {
        route,
        pairs,
        binSteps,
        versions: Array.from({ length: hopCount }, () => options.quoteVersion ?? 3),
        amounts,
        virtualAmountsWithoutSlippage: [...amounts],
        fees: Array.from({ length: hopCount }, () => 1_000_000_000_000_000n)
      }
    });
  }

  if (functionName === "getSwapOut") {
    if (options.quoteDelayMs !== undefined) await delay(options.quoteDelayMs);
    if (options.quoteMode === "error") throw new Error("Mock quote failed");

    const [, amountIn] = decoded.args as readonly [Address, bigint, boolean];
    const fee = amountIn / 1_000n;
    const amountOut = options.quoteMode === "no-route"
      ? 0n
      : (amountIn * (options.quoteRate ?? 999n)) / 1_000n;

    return encodeFunctionResult({
      abi: lbRouterAbi,
      functionName,
      result: options.quoteMode === "no-route" ? [amountIn, 0n, 0n] : [0n, amountOut, fee]
    });
  }

  if (functionName === "getBin") {
    return encodeFunctionResult({
      abi: lbPairAbi,
      functionName,
      result: [options.binReserveX ?? 4n * DEFAULT_POSITION_LIQUIDITY, options.binReserveY ?? 2n * DEFAULT_POSITION_LIQUIDITY]
    });
  }

  if (functionName === "getReserves") {
    return encodeFunctionResult({
      abi: LB_PAIR_RESERVES_ABI,
      functionName,
      result: [options.pairReserveX ?? 0n, options.pairReserveY ?? 0n]
    });
  }

  if (functionName === "totalSupply") {
    return encodeFunctionResult({
      abi: lbPairAbi,
      functionName,
      result: options.binTotalSupply ?? options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY
    });
  }

  if (functionName === "allowance") {
    return encodeFunctionResult({ abi: erc20Abi, functionName, result: options.allowance ?? DEFAULT_ALLOWANCE });
  }

  if (functionName === "balanceOf") {
    if (decoded.args.length === 2) {
      const binId = decoded.args[1] as bigint;
      const receiptBlock = numberToHex(options.receiptBlockNumber ?? options.blockNumber ?? DEFAULT_BLOCK_NUMBER);
      const removedIndex = state.lastRemoveLiquidity?.ids.findIndex((id) => id === binId) ?? -1;
      const mintedIndex = state.lastAddLiquidity?.quote.bins.findIndex((bin) => bin.binId === binId) ?? -1;
      const base = options.livePositionBalance ?? options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY;
      return encodeFunctionResult({
        abi: lbPairAbi,
        functionName,
        result: state.receiptObserved && blockTag === receiptBlock && removedIndex >= 0
          ? base - state.lastRemoveLiquidity!.amounts[removedIndex]! + (options.nativeRemoveReceiptMismatch === "lp-balance" ? 1n : 0n)
          : blockTag === receiptBlock && mintedIndex >= 0 ? base + state.lastAddLiquidity!.quote.bins[mintedIndex]!.mintedShares : base
      });
    }

    const receiptBlock = numberToHex(options.receiptBlockNumber ?? options.blockNumber ?? DEFAULT_BLOCK_NUMBER);
    const base = options.balance ?? DEFAULT_BALANCE;
    let derivedAfter = options.balanceAfterReceipt;
    if (derivedAfter === undefined && blockTag === receiptBlock && state.lastAddLiquidity?.functionName === "addLiquidityNATIVE") {
      const { parameters, quote } = state.lastAddLiquidity;
      if (addressEquals(call.to ?? "", WNATIVE)) {
        derivedAfter = base + (addressEquals(parameters.tokenX, WNATIVE) ? quote.amountXLeft : quote.amountYLeft);
      } else {
        derivedAfter = base - (addressEquals(parameters.tokenX, WNATIVE)
          ? parameters.amountY - quote.amountYLeft
          : parameters.amountX - quote.amountXLeft);
      }
    }
    if (derivedAfter === undefined && state.receiptObserved && blockTag === receiptBlock && state.lastRemoveLiquidity?.functionName === "removeLiquidityNATIVE") {
      const otherTokenAmount = state.lastRemoveLiquidity.amountY;
      if (!addressEquals(call.to ?? "", WNATIVE)) derivedAfter = base + otherTokenAmount;
    }
    return encodeFunctionResult({
      abi: erc20Abi,
      functionName,
      result: blockTag === receiptBlock && derivedAfter !== undefined ? derivedAfter : base
    });
  }

  if (functionName === "isApprovedForAll") {
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result: options.lbApproved ?? true });
  }

  if (functionName === "approve") {
    if (options.simulationMode === "error") throw new Error("Mock approval simulation failed");
    return encodeFunctionResult({ abi: erc20Abi, functionName, result: true });
  }

  if (functionName === "approveForAll") {
    if (options.simulationMode === "error") throw new Error("Mock LB approval simulation failed");
    return "0x";
  }

  if (functionName === "createLBPair") {
    if (options.simulationMode === "error") throw new Error("Mock pool creation simulation failed");
    return encodeFunctionResult({
      abi: lbRouterAbi,
      functionName,
      result: options.createdPairAddress ?? CREATED_WETH_USDT_PAIR
    });
  }

  if (functionName === "swapExactTokensForTokens") {
    if (options.simulationMode === "error") throw new Error("Mock swap simulation failed");
    const path = decoded.args[2];
    for (let index = 0; index < path.tokenPath.length - 1; index += 1) {
      const expectedBinStep = quoteBinStepForLeg(
        path.tokenPath[index],
        path.tokenPath[index + 1],
        options.quoteUseAlternateDirectPool === true
      );
      if (path.pairBinSteps[index] !== expectedBinStep || path.versions[index] !== 3) {
        throw new Error("Mock swap path does not match an executable V2.2 pair leg");
      }
    }
    return encodeFunctionResult({ abi: lbRouterAbi, functionName, result: decoded.args[1] as bigint });
  }

  if (functionName === "swapExactNATIVEForTokens" || functionName === "swapExactTokensForNATIVE") {
    if (options.simulationMode === "error") throw new Error("Mock native swap simulation failed");
    const path = functionName === "swapExactNATIVEForTokens" ? decoded.args[1] : decoded.args[2];
    for (let index = 0; index < path.tokenPath.length - 1; index += 1) {
      const expectedBinStep = quoteBinStepForLeg(path.tokenPath[index], path.tokenPath[index + 1], options.quoteUseAlternateDirectPool === true);
      if (path.pairBinSteps[index] !== expectedBinStep || path.versions[index] !== 3) throw new Error("Mock native swap path does not match an executable V2.2 pair leg");
    }
    const minimum = (functionName === "swapExactNATIVEForTokens" ? decoded.args[0] : decoded.args[1]) as bigint;
    return encodeFunctionResult({ abi: lbRouterAbi, functionName, result: minimum });
  }

  if (functionName === "addLiquidity" || functionName === "addLiquidityNATIVE") {
    if (options.simulationMode === "error") throw new Error("Mock add-liquidity simulation failed");
    const params = decoded.args[0] as {
      amountX: bigint;
      amountY: bigint;
      binStep: bigint;
      deltaIds: readonly bigint[];
      distributionX: readonly bigint[];
      distributionY: readonly bigint[];
    };
    const quote = quoteAddLiquidityMath({
      activeId: BigInt(activeIdFor(options)),
      amountXReceived: params.amountX,
      amountYReceived: params.amountY,
      binStep: params.binStep,
      blockTimestamp: 1_720_000_000n,
      deltaIds: params.deltaIds,
      distributionX: params.distributionX,
      distributionY: params.distributionY,
      bins: params.deltaIds.map((deltaId) => ({
        binId: BigInt(activeIdFor(options)) + deltaId,
        priceQ128: options.priceQ128ByBin?.[(BigInt(activeIdFor(options)) + deltaId).toString()] ?? LB_Q128,
        reserveX: options.binReserveX ?? 4n * DEFAULT_POSITION_LIQUIDITY,
        reserveY: options.binReserveY ?? 2n * DEFAULT_POSITION_LIQUIDITY,
        totalSupply: options.binTotalSupply ?? options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY
      })),
      staticFees: {
        baseFactor: 1n,
        filterPeriod: 10n,
        decayPeriod: 20n,
        reductionFactor: 5_000n,
        variableFeeControl: 0n,
        protocolShare: 0n,
        maxVolatilityAccumulator: 100_000n
      },
      variableFees: {
        volatilityAccumulator: 0n,
        volatilityReference: 0n,
        idReference: BigInt(activeIdFor(options)),
        timeOfLastUpdate: 1_720_000_000n
      }
    });
    state.lastAddLiquidity = {
      functionName,
      parameters: { amountX: params.amountX, amountY: params.amountY, tokenX: (decoded.args[0] as { tokenX: Address }).tokenX, tokenY: (decoded.args[0] as { tokenY: Address }).tokenY },
      quote
    };

    return encodeFunctionResult({
      abi: lbRouterAbi,
      functionName,
      result: [
        quote.amountXAdded,
        quote.amountYAdded,
        quote.amountXLeft,
        quote.amountYLeft,
        quote.bins.map((bin) => bin.binId),
        quote.bins.map((bin) => bin.mintedShares)
      ]
    });
  }

  if (functionName === "removeLiquidity" || functionName === "removeLiquidityNATIVE") {
    if (options.simulationMode === "error") throw new Error("Mock remove-liquidity simulation failed");
    state.receiptObserved = false;
    const args = decoded.args as readonly unknown[];
    const idsIndex = functionName === "removeLiquidityNATIVE" ? 4 : 5;
    if (
      options.maxRemoveLiquidityBinsForSimulation !== undefined &&
      Array.isArray(args[idsIndex]) &&
      args[idsIndex].length > options.maxRemoveLiquidityBinsForSimulation
    ) throw new Error("Mock remove-liquidity batch exceeds the simulation-safe bin bound");

    const ids = args[idsIndex] as bigint[];
    const amounts = args[idsIndex + 1] as bigint[];
    const totalSupply = options.binTotalSupply ?? options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY;
    const amountX = amounts.reduce((sum, amount) => sum + amount * (options.binReserveX ?? 4n * DEFAULT_POSITION_LIQUIDITY) / totalSupply, 0n);
    const amountY = amounts.reduce((sum, amount) => sum + amount * (options.binReserveY ?? 2n * DEFAULT_POSITION_LIQUIDITY) / totalSupply, 0n);
    state.lastRemoveLiquidity = { amounts: [...amounts], amountX, amountY, functionName, ids: [...ids] };
    return encodeFunctionResult({
      abi: lbRouterAbi,
      functionName,
      result: functionName === "removeLiquidityNATIVE" ? [amountY, amountX] : [amountX, amountY]
    });
  }

  throw new Error(`Unhandled mock eth_call function: ${functionName}`);
}

function removeLiquidityBinCount(data: Hex | undefined): number {
  if (!data || data === "0x") return 0;
  try {
    const decoded = decodeFunctionData({ abi: lbRouterAbi, data });
    if (decoded.functionName !== "removeLiquidity" && decoded.functionName !== "removeLiquidityNATIVE") return 0;
    const args = decoded.args as readonly unknown[];
    const idsIndex = decoded.functionName === "removeLiquidityNATIVE" ? 4 : 5;
    return Array.isArray(args[idsIndex]) ? args[idsIndex].length : 0;
  } catch {
    return 0;
  }
}

function quotePairForLeg(tokenIn: Address, tokenOut: Address, alternateDirect: boolean): Address {
  const key = tokenPairKey(tokenIn, tokenOut);
  const pairs: Record<string, Address> = {
    [tokenPairKey(WNATIVE, USDC)]: alternateDirect ? ALT_WNATIVE_USDC_PAIR : WNATIVE_USDC_PAIR,
    [tokenPairKey(WNATIVE, USDT)]: WNATIVE_USDT_PAIR,
    [tokenPairKey(USDT, USDC)]: USDT_USDC_PAIR,
    [tokenPairKey(WNATIVE, WETH)]: WNATIVE_WETH_PAIR,
    [tokenPairKey(WETH, USDC)]: WETH_USDC_PAIR
  };
  const pair = pairs[key];
  if (pair === undefined) throw new Error(`No mock pair for ${tokenIn}/${tokenOut}`);

  return pair;
}

function quoteBinStepForLeg(tokenIn: Address, tokenOut: Address, alternateDirect: boolean): bigint {
  const key = tokenPairKey(tokenIn, tokenOut);
  const binSteps: Record<string, bigint> = {
    [tokenPairKey(WNATIVE, USDC)]: alternateDirect ? 20n : 10n,
    [tokenPairKey(WNATIVE, USDT)]: 11n,
    [tokenPairKey(USDT, USDC)]: 12n,
    [tokenPairKey(WNATIVE, WETH)]: 13n,
    [tokenPairKey(WETH, USDC)]: 14n
  };
  const binStep = binSteps[key];
  if (binStep === undefined) throw new Error(`No mock bin step for ${tokenIn}/${tokenOut}`);

  return binStep;
}

function tokenPairKey(left: Address, right: Address): string {
  return [left.toLowerCase(), right.toLowerCase()].sort().join(":");
}

function mockPair(options: MockRpcOptions, index = 0): Record<string, unknown> {
  const address = index === 0 ? WNATIVE_USDC_PAIR : SECOND_WNATIVE_USDC_PAIR;
  return {
    activeId: (activeIdFor(options) + index).toString(),
    address: index === 0 ? options.pairAddress ?? address : address,
    binStep: index === 0 ? options.pairBinStep ?? String(10 + index) : String(10 + index),
    depositCount: "1",
    hooksParameters: options.indexedHooksParameters === undefined ? options.hooksParameters ?? ZERO_HOOKS : options.indexedHooksParameters,
    ignoredForRouting: options.factoryLookupIgnored ?? false,
    factory: { id: LB_FACTORY.toLowerCase() },
    id: address.toLowerCase(),
    reserveX: (options.pairReserveX ?? 50n * DEFAULT_POSITION_LIQUIDITY).toString(),
    reserveY: (options.pairReserveY ?? 50n * DEFAULT_POSITION_LIQUIDITY).toString(),
    swapCount: "1",
    tokenX: { address: index === 0 ? options.pairTokenX ?? WNATIVE : WNATIVE },
    tokenY: { address: index === 0 ? options.pairTokenY ?? USDC : USDC },
    totalFeesX: "0",
    totalFeesY: "0",
    totalVolumeX: "0",
    totalVolumeY: "0",
    updatedAtBlock: (options.indexerBlockNumber ?? DEFAULT_BLOCK_NUMBER).toString()
  };
}

function mockPairByAddress(options: MockRpcOptions, requested: string): Record<string, unknown> | null {
  const metadata = allPairMetadata(options).find((item) => item.pair.toLowerCase() === requested.toLowerCase());
  if (!metadata) return null;
  return {
    activeId: activeIdFor(options).toString(),
    address: metadata.pair,
    binStep: metadata.binStep.toString(),
    depositCount: "1",
    factory: { id: LB_FACTORY.toLowerCase() },
    hooksParameters: options.indexedHooksParameters === undefined ? options.hooksParameters ?? ZERO_HOOKS : options.indexedHooksParameters,
    id: metadata.pair.toLowerCase(),
    ignoredForRouting: options.factoryLookupIgnored ?? false,
    reserveX: (options.pairReserveX ?? 50n * DEFAULT_POSITION_LIQUIDITY).toString(),
    reserveY: (options.pairReserveY ?? 50n * DEFAULT_POSITION_LIQUIDITY).toString(),
    swapCount: "1",
    tokenX: { address: metadata.tokenX },
    tokenY: { address: metadata.tokenY },
    totalFeesX: "0",
    totalFeesY: "0",
    totalVolumeX: "0",
    totalVolumeY: "0",
    updatedAtBlock: (options.indexerBlockNumber ?? DEFAULT_BLOCK_NUMBER).toString()
  };
}

function pairMetadata(address: Address | undefined, options: MockRpcOptions) {
  return allPairMetadata(options).find((item) => addressEquals(item.pair, address ?? "")) ?? allPairMetadata(options)[0];
}

function allPairMetadata(options: MockRpcOptions) {
  return [
    { pair: (options.pairAddress ?? WNATIVE_USDC_PAIR) as Address, tokenX: (options.pairTokenX ?? WNATIVE) as Address, tokenY: (options.pairTokenY ?? USDC) as Address, binStep: Number(options.pairBinStep ?? 10) },
    { pair: ALT_WNATIVE_USDC_PAIR as Address, tokenX: WNATIVE as Address, tokenY: USDC as Address, binStep: 20 },
    { pair: WNATIVE_USDT_PAIR as Address, tokenX: WNATIVE as Address, tokenY: USDT as Address, binStep: 11 },
    { pair: USDT_USDC_PAIR as Address, tokenX: USDT as Address, tokenY: USDC as Address, binStep: 12 },
    { pair: WNATIVE_WETH_PAIR as Address, tokenX: WNATIVE as Address, tokenY: WETH as Address, binStep: 13 },
    { pair: WETH_USDC_PAIR as Address, tokenX: WETH as Address, tokenY: USDC as Address, binStep: 14 },
    { pair: SECOND_WNATIVE_USDC_PAIR as Address, tokenX: WNATIVE as Address, tokenY: USDC as Address, binStep: 11 }
  ];
}

function mockBin(options: MockRpcOptions, index: number, count: number): Record<string, unknown> {
  const binId = activeIdFor(options) - Math.floor(count / 2) + index;
  const scale = BigInt(index + 1);
  return {
    id: `${WNATIVE_USDC_PAIR.toLowerCase()}-${binId}`,
    binId: binId.toString(),
    reserveX: (scale * DEFAULT_POSITION_LIQUIDITY).toString(),
    reserveY: ((BigInt(count) - BigInt(index)) * DEFAULT_POSITION_LIQUIDITY).toString(),
    totalSupply: (2n * DEFAULT_POSITION_LIQUIDITY).toString(),
    updatedAtBlock: DEFAULT_BLOCK_NUMBER.toString()
  };
}

function mockPosition(options: MockRpcOptions, index = 0): Record<string, unknown> {
  const pair = options.positionPair ?? WNATIVE_USDC_PAIR;
  const binId = activeIdFor(options) + (options.analyticsOutOfRange === true ? 10 : 0) + index;

  return {
    bin: { binId: binId.toString() },
    id: `${pair.toLowerCase()}-${binId}`,
    liquidity: (options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY).toString(),
    owner: options.positionOwner ?? DEFAULT_ACCOUNT,
    pair: { id: pair.toLowerCase() },
    updatedAtBlock: (options.indexerBlockNumber ?? DEFAULT_BLOCK_NUMBER).toString()
  };
}

function activeIdFor(options: MockRpcOptions): number {
  return options.activeId ?? ACTIVE_ID;
}

function shouldIncludeOwnerPairPosition(body: GraphRequest, options: MockRpcOptions): boolean {
  if (options.includePositions !== true) return false;

  const owner = body.variables?.owner;
  const pair = body.variables?.pair;
  if (typeof owner !== "string" || typeof pair !== "string") return false;

  return addressEquals(owner, options.positionOwner ?? DEFAULT_ACCOUNT) && addressEquals(pair, options.positionPair ?? WNATIVE_USDC_PAIR);
}

function addressEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function transactionReceipt(
  blockNumber: bigint,
  status: "success" | "reverted",
  options: MockRpcOptions,
  state: MockRpcSnapshot,
  transactionHash: Hex,
  transactionEffect: "default" | "lb-approval" | "remove"
): Record<string, unknown> {
  const logs: Record<string, unknown>[] = [];
  if (status === "success" && transactionEffect === "default" && state.creationConfirmed && state.createdTokenX && state.createdTokenY && state.createdBinStep !== null) {
    logs.push({
        address: options.factoryAddress ?? LB_FACTORY,
        blockHash: options.blockHash ?? "0x2222222222222222222222222222222222222222222222222222222222222222",
        blockNumber: numberToHex(blockNumber),
        data: encodeAbiParameters(
          [{ name: "LBPair", type: "address" }, { name: "pid", type: "uint256" }],
          [options.createdPairAddress ?? CREATED_WETH_USDT_PAIR, 6n]
        ),
        logIndex: "0x0",
        removed: false,
        topics: encodeEventTopics({
          abi: lbFactoryAbi,
          eventName: "LBPairCreated",
          args: { tokenX: state.createdTokenX, tokenY: state.createdTokenY, binStep: BigInt(state.createdBinStep) }
        }),
        transactionHash,
        transactionIndex: "0x0"
      });
  }
  if (status === "success" && transactionEffect === "default" && state.lastAddLiquidity) {
    const add = state.lastAddLiquidity;
    const pair = options.pairAddress ?? WNATIVE_USDC_PAIR;
    const blockHash = options.blockHash ?? "0x2222222222222222222222222222222222222222222222222222222222222222";
    const pushEvent = (address: Address, abi: typeof lbPairAbi | typeof erc20Abi, eventName: string, indexedArgs: Record<string, unknown>, dataTypes: readonly Record<string, unknown>[], dataValues: readonly unknown[]) => {
      logs.push({
        address,
        blockHash,
        blockNumber: numberToHex(blockNumber),
        data: encodeAbiParameters(dataTypes as never, dataValues as never),
        logIndex: numberToHex(BigInt(logs.length)),
        removed: false,
        topics: encodeEventTopics({ abi, eventName: eventName as never, args: indexedArgs as never }),
        transactionHash,
        transactionIndex: "0x0"
      });
    };
    for (const bin of add.quote.bins) {
      if (bin.compositionFeeX > 0n || bin.compositionFeeY > 0n) {
        pushEvent(pair as Address, lbPairAbi, "CompositionFees", { sender: LB_ROUTER },
          [{ type: "uint24" }, { type: "bytes32" }, { type: "bytes32" }],
          [bin.binId, packedAmounts(bin.compositionFeeX, bin.compositionFeeY), packedAmounts(bin.protocolFeeX, bin.protocolFeeY)]);
      }
    }
    pushEvent(pair as Address, lbPairAbi, "DepositedToBins", { sender: LB_ROUTER, to: DEFAULT_ACCOUNT },
      [{ type: "uint256[]" }, { type: "bytes32[]" }],
      [add.quote.bins.map((bin) => bin.binId), add.quote.bins.map((bin) => packedAmounts(bin.depositedX, bin.depositedY))]);
    pushEvent(pair as Address, lbPairAbi, "TransferBatch", { sender: LB_ROUTER, from: "0x0000000000000000000000000000000000000000", to: DEFAULT_ACCOUNT },
      [{ type: "uint256[]" }, { type: "uint256[]" }],
      [add.quote.bins.map((bin) => bin.binId), add.quote.bins.map((bin) => bin.mintedShares)]);
    const nativeX = add.functionName === "addLiquidityNATIVE" && addressEquals(add.parameters.tokenX, WNATIVE);
    const nativeY = add.functionName === "addLiquidityNATIVE" && addressEquals(add.parameters.tokenY, WNATIVE);
    const transfer = (token: Address, from: Address, to: Address, value: bigint) => {
      if (value === 0n) return;
      pushEvent(token, erc20Abi, "Transfer", { from, to }, [{ type: "uint256" }], [value]);
    };
    transfer(add.parameters.tokenX, nativeX ? LB_ROUTER : DEFAULT_ACCOUNT, pair as Address, add.parameters.amountX);
    transfer(add.parameters.tokenY, nativeY ? LB_ROUTER : DEFAULT_ACCOUNT, pair as Address, add.parameters.amountY);
    transfer(add.parameters.tokenX, pair as Address, DEFAULT_ACCOUNT, add.quote.amountXLeft);
    transfer(add.parameters.tokenY, pair as Address, DEFAULT_ACCOUNT, add.quote.amountYLeft);
  }
  if (status === "success" && transactionEffect !== "lb-approval" && state.lastRemoveLiquidity?.functionName === "removeLiquidityNATIVE") {
    const remove = state.lastRemoveLiquidity;
    const pair = (options.pairAddress ?? WNATIVE_USDC_PAIR) as Address;
    const blockHash = options.blockHash ?? "0x2222222222222222222222222222222222222222222222222222222222222222";
    const pushEvent = (address: Address, abi: typeof lbPairAbi | typeof erc20Abi, eventName: string, indexedArgs: Record<string, unknown>, dataTypes: readonly Record<string, unknown>[], dataValues: readonly unknown[]) => {
      logs.push({
        address,
        blockHash,
        blockNumber: numberToHex(blockNumber),
        data: encodeAbiParameters(dataTypes as never, dataValues as never),
        logIndex: numberToHex(BigInt(logs.length)),
        removed: false,
        topics: encodeEventTopics({ abi, eventName: eventName as never, args: indexedArgs as never }),
        transactionHash,
        transactionIndex: "0x0"
      });
    };
    const totalSupply = options.binTotalSupply ?? options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY;
    pushEvent(pair, lbPairAbi, "WithdrawnFromBins", { sender: LB_ROUTER, to: LB_ROUTER },
      [{ type: "uint256[]" }, { type: "bytes32[]" }],
      [remove.ids, remove.amounts.map((amount) => packedAmounts(
        amount * (options.binReserveX ?? 4n * DEFAULT_POSITION_LIQUIDITY) / totalSupply,
        amount * (options.binReserveY ?? 2n * DEFAULT_POSITION_LIQUIDITY) / totalSupply
      ))]);
    pushEvent(pair, lbPairAbi, "TransferBatch", { sender: LB_ROUTER, from: DEFAULT_ACCOUNT, to: "0x0000000000000000000000000000000000000000" },
      [{ type: "uint256[]" }, { type: "uint256[]" }], [remove.ids, remove.amounts]);
    const transferAmount = options.nativeRemoveReceiptMismatch === "other-token-transfer" ? remove.amountY - 1n : remove.amountY;
    pushEvent(USDC, erc20Abi, "Transfer", { from: LB_ROUTER, to: DEFAULT_ACCOUNT }, [{ type: "uint256" }], [transferAmount]);
  }
  const nativeSwapCall = state.ethCalls.findLast((call) => call.functionName === "swapExactNATIVEForTokens" || call.functionName === "swapExactTokensForNATIVE");
  if (status === "success" && transactionEffect === "default" && nativeSwapCall) {
    const decoded = decodeFunctionData({ abi: lbRouterAbi, data: nativeSwapCall.data });
    const nativeIn = decoded.functionName === "swapExactNATIVEForTokens";
    const path = (nativeIn ? decoded.args[1] : decoded.args[2]) as { tokenPath: readonly Address[] };
    const token = nativeIn ? path.tokenPath[path.tokenPath.length - 1] : path.tokenPath[0];
    const amount = nativeIn
      ? (options.balanceAfterReceipt ?? DEFAULT_BALANCE) - (options.balance ?? DEFAULT_BALANCE)
      : decoded.args[0] as bigint;
    const from = nativeIn ? WNATIVE_USDC_PAIR : DEFAULT_ACCOUNT;
    const to = nativeIn ? DEFAULT_ACCOUNT : WNATIVE_USDC_PAIR;
    logs.push({
      address: token,
      blockHash: options.blockHash ?? "0x2222222222222222222222222222222222222222222222222222222222222222",
      blockNumber: numberToHex(blockNumber),
      data: encodeAbiParameters([{ name: "value", type: "uint256" }], [amount]),
      logIndex: numberToHex(BigInt(logs.length)),
      removed: false,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
      transactionHash,
      transactionIndex: "0x0"
    });
  }
  return {
    blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    blockNumber: numberToHex(blockNumber),
    contractAddress: null,
    cumulativeGasUsed: numberToHex(100_000n),
    effectiveGasPrice: numberToHex(1n),
    from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    gasUsed: numberToHex(100_000n),
    logs,
    logsBloom: `0x${"0".repeat(512)}`,
    status: status === "success" ? "0x1" : "0x0",
    to: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
    transactionHash,
    transactionIndex: "0x0",
    type: "0x2"
  };
}

function packedAmounts(x: bigint, y: bigint): Hex {
  return `0x${((y << 128n) | x).toString(16).padStart(64, "0")}`;
}

function transactionByHash(
  blockNumber: bigint,
  state: MockRpcSnapshot,
  transactionHash: Hex,
  transactionEffect: "default" | "lb-approval" | "remove"
): Record<string, unknown> {
  const functions = transactionEffect === "lb-approval"
    ? ["approveForAll"]
    : transactionEffect === "remove"
      ? ["removeLiquidity", "removeLiquidityNATIVE"]
      : ["addLiquidity", "addLiquidityNATIVE", "approve", "approveForAll", "createLBPair", "removeLiquidity", "removeLiquidityNATIVE", "swapExactTokensForTokens", "swapExactNATIVEForTokens", "swapExactTokensForNATIVE"];
  const simulatedTransaction = state.ethCalls.findLast((call) =>
    functions.includes(call.functionName)
  );

  return {
    blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    blockNumber: numberToHex(blockNumber),
    chainId: numberToHex(LOCALNET_CHAIN_ID),
    from: DEFAULT_ACCOUNT,
    gas: numberToHex(500_000n),
    gasPrice: numberToHex(1n),
    hash: transactionHash,
    input: simulatedTransaction?.data ?? "0x",
    nonce: "0x0",
    r: `0x${"1".padStart(64, "0")}`,
    s: `0x${"2".padStart(64, "0")}`,
    to: simulatedTransaction?.address ?? LB_ROUTER,
    transactionIndex: "0x0",
    type: "0x0",
    v: "0x1b",
    value: simulatedTransaction?.value ?? "0x0"
  };
}

function rpcResult(request: RpcRequest, result: unknown): Record<string, unknown> {
  return { id: request.id ?? null, jsonrpc: "2.0", result };
}

function rpcError(request: RpcRequest, code: number, message: string): Record<string, unknown> {
  return {
    error: { code, message },
    id: request.id ?? null,
    jsonrpc: "2.0"
  };
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": "*"
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
