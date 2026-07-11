import type { Page } from "@playwright/test";
import { decodeFunctionData, encodeFunctionResult, numberToHex, type Address, type Hex } from "viem";

import { erc20Abi, lbPairAbi, lbQuoterAbi, lbRouterAbi } from "../../../../packages/sdk/src/abi";

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
export const LB_ROUTER = "0x0165878A594ca255338adfa4d48449f69242Eb8F";
export const DEFAULT_ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const LOCALNET_CHAIN_ID = 31_337;
const ACTIVE_ID = 8_388_608;
const DEFAULT_BALANCE = 10_000_000_000_000_000_000n;
const DEFAULT_ALLOWANCE = 10_000_000_000_000_000_000n;
const DEFAULT_BLOCK_NUMBER = 42n;
const DEFAULT_POSITION_LIQUIDITY = 2_000_000_000_000_000_000n;
const TX_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111";
const RPC_ABI = [...erc20Abi, ...lbPairAbi, ...lbQuoterAbi, ...lbRouterAbi] as const;

export interface MockRpcOptions {
  analyticsIncludeOtherOwner?: boolean;
  analyticsBinCount?: number;
  analyticsAsOfBlock?: bigint;
  analyticsMode?: "ready" | "error";
  analyticsOutOfRange?: boolean;
  analyticsPartialHistory?: boolean;
  analyticsTransferred?: boolean;
  allowance?: bigint;
  balance?: bigint;
  binReserveX?: bigint;
  binReserveY?: bigint;
  binTotalSupply?: bigint;
  blockHash?: Hex;
  blockNumber?: bigint;
  chainId?: number;
  dashboardPoolLimit?: number;
  includePairs?: boolean;
  includePositions?: boolean;
  indexerBlockNumber?: bigint;
  indexerDelayMs?: number;
  indexerHasErrors?: boolean;
  indexerMode?: "ready" | "error";
  lbApproved?: boolean;
  livePositionBalance?: bigint;
  nativeBalance?: bigint;
  omitActivePoolBin?: boolean;
  ownerPositionCount?: number;
  ownerPositionsFailAtSkip?: number;
  pairReserveX?: bigint;
  pairReserveY?: bigint;
  pairByIdDelayMs?: number;
  pairByIdMode?: "ready" | "error";
  positionOwner?: Address;
  positionPair?: Address;
  positionLiquidity?: bigint;
  poolCount?: number;
  poolBinCount?: number;
  poolBinsMode?: "ready" | "error";
  quoteMode?: "ready" | "error" | "no-route";
  quotePreferMultiHop?: boolean;
  quoteUseAlternateDirectPool?: boolean;
  quoteVersion?: number;
  receiptStatus?: "success" | "reverted";
  simulationDelayMs?: number;
  simulationMode?: "success" | "error";
  walletReadMode?: "ready" | "error";
  walletReadDelayMs?: number;
}

export interface MockRpcSnapshot {
  ethCalls: Array<{ address: string | null; blockTag: string | null; data: Hex; functionName: string; value: string | null }>;
  graphQueries: string[];
  methods: string[];
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
    first?: number;
    id?: string;
    owner?: string;
    pair?: string;
    skip?: number;
  };
}

export async function installMockRpc(page: Page, options: MockRpcOptions = {}): Promise<InstalledMockRpc> {
  const currentOptions = { ...options };
  const state: MockRpcSnapshot = {
    ethCalls: [],
    graphQueries: [],
    methods: []
  };

  await page.route(`${LOCALNET_RPC_URL}/`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: corsHeaders(), status: 204 });
      return;
    }

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
    await route.fulfill({
      body: JSON.stringify(mockAnalyticsResponse(body, currentOptions)),
      contentType: "application/json",
      headers: corsHeaders(),
      status: 200
    });
  });

  return {
    snapshot: () => ({
      ethCalls: [...state.ethCalls],
      graphQueries: [...state.graphQueries],
      methods: [...state.methods]
    }),
    update: (nextOptions) => Object.assign(currentOptions, nextOptions)
  };
}

function mockAnalyticsResponse(body: GraphRequest, options: MockRpcOptions): Record<string, unknown> {
  if (options.analyticsMode === "error") return { errors: [{ message: "Mock analytics failed" }] };
  const owner = body.variables?.owner ?? DEFAULT_ACCOUNT;
  const partial = options.analyticsPartialHistory === true;
  const binId = options.analyticsOutOfRange === true ? ACTIVE_ID + 10 : ACTIVE_ID;
  const transferred = options.analyticsTransferred === true;
  const analyticsBins = transferred
    ? []
    : Array.from({ length: options.analyticsBinCount ?? 1 }, (_, index) => ({
        binId: String(binId + index),
        liquidity: String(options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY),
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
            hash: options.blockHash ?? "0x2222222222222222222222222222222222222222222222222222222222222222",
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
    const pair = Array.from({ length: options.poolCount ?? 1 }, (_, index) => mockPair(options, index)).find(
      (candidate) => candidate.id === body.variables?.id?.toLowerCase()
    ) ?? null;
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
    const bins = Array.from({ length: count }, (_, index) => mockBin(index, count)).filter(
      (bin) => options.omitActivePoolBin !== true || bin.binId !== ACTIVE_ID.toString()
    );
    return { data: { bins } };
  }
  if (query.includes("PairBins")) {
    const skip = body.variables?.skip ?? 0;
    const count = options.poolBinCount ?? 5;
    const first = body.variables?.first ?? count;
    const bins = Array.from({ length: Math.max(0, Math.min(first, count - skip)) }, (_, index) =>
      mockBin(skip + index, count)
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
                ids: [String(ACTIVE_ID)],
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
                ids: [String(ACTIVE_ID)],
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
              ids: [String(ACTIVE_ID)]
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
      case "eth_getBlockByNumber":
        return rpcResult(request, {
          hash: options.blockHash ?? "0x2222222222222222222222222222222222222222222222222222222222222222",
          number: request.params?.[0] ?? numberToHex(options.blockNumber ?? DEFAULT_BLOCK_NUMBER)
        });
      case "eth_estimateGas":
        return rpcResult(request, numberToHex(500_000n));
      case "eth_getTransactionReceipt":
        return rpcResult(request, transactionReceipt(options.blockNumber ?? DEFAULT_BLOCK_NUMBER, options.receiptStatus ?? "success"));
      case "eth_getTransactionByHash":
        return rpcResult(request, transactionByHash(options.blockNumber ?? DEFAULT_BLOCK_NUMBER, state));
      case "eth_getBalance":
        return rpcResult(request, numberToHex(options.nativeBalance ?? DEFAULT_BALANCE));
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
    ["addLiquidity", "approve", "approveForAll", "removeLiquidity", "swapExactTokensForTokens"].includes(
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

  if (functionName === "getTokenX") {
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result: WNATIVE });
  }

  if (functionName === "getTokenY") {
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result: USDC });
  }

  if (functionName === "getActiveId") {
    return encodeFunctionResult({ abi: lbPairAbi, functionName, result: ACTIVE_ID });
  }

  if (functionName === "findBestPathFromAmountIn") {
    if (options.quoteMode === "error") throw new Error("Mock quote failed");

    const requestedRoute = decoded.args[0] as readonly Address[] | undefined;
    const route = requestedRoute !== undefined && requestedRoute.length >= 2 ? [...requestedRoute] : [WNATIVE, USDC];
    const amountIn = (decoded.args[1] as bigint | undefined) ?? 1_000_000_000_000_000_000n;
    const hopRate = options.quotePreferMultiHop === true && route.length > 2 ? 1_001n : route.length > 2 ? 998n : 999n;
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

  if (functionName === "getBin") {
    return encodeFunctionResult({
      abi: lbPairAbi,
      functionName,
      result: [options.binReserveX ?? 4n * DEFAULT_POSITION_LIQUIDITY, options.binReserveY ?? 2n * DEFAULT_POSITION_LIQUIDITY]
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
      return encodeFunctionResult({
        abi: lbPairAbi,
        functionName,
        result: options.livePositionBalance ?? options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY
      });
    }

    return encodeFunctionResult({ abi: erc20Abi, functionName, result: options.balance ?? DEFAULT_BALANCE });
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

  if (functionName === "addLiquidity") {
    if (options.simulationMode === "error") throw new Error("Mock add-liquidity simulation failed");
    const params = decoded.args[0] as { amountX: bigint; amountY: bigint };

    return encodeFunctionResult({
      abi: lbRouterAbi,
      functionName,
      result: [params.amountX, params.amountY, 0n, 0n, [BigInt(ACTIVE_ID)], [options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY]]
    });
  }

  if (functionName === "removeLiquidity") {
    if (options.simulationMode === "error") throw new Error("Mock remove-liquidity simulation failed");

    return encodeFunctionResult({
      abi: lbRouterAbi,
      functionName,
      result: [1n, 1n]
    });
  }

  throw new Error(`Unhandled mock eth_call function: ${functionName}`);
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
    activeId: (ACTIVE_ID + index).toString(),
    address,
    binStep: String(10 + index),
    depositCount: "1",
    id: address.toLowerCase(),
    reserveX: (options.pairReserveX ?? 50n * DEFAULT_POSITION_LIQUIDITY).toString(),
    reserveY: (options.pairReserveY ?? 50n * DEFAULT_POSITION_LIQUIDITY).toString(),
    swapCount: "1",
    tokenX: { address: WNATIVE },
    tokenY: { address: USDC },
    totalFeesX: "0",
    totalFeesY: "0",
    totalVolumeX: "0",
    totalVolumeY: "0",
    updatedAtBlock: (options.indexerBlockNumber ?? DEFAULT_BLOCK_NUMBER).toString()
  };
}

function mockBin(index: number, count: number): Record<string, unknown> {
  const binId = ACTIVE_ID - Math.floor(count / 2) + index;
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
  const binId = ACTIVE_ID + (options.analyticsOutOfRange === true ? 10 : 0) + index;

  return {
    bin: { binId: binId.toString() },
    id: `${pair.toLowerCase()}-${binId}`,
    liquidity: (options.positionLiquidity ?? DEFAULT_POSITION_LIQUIDITY).toString(),
    owner: options.positionOwner ?? DEFAULT_ACCOUNT,
    pair: { id: pair.toLowerCase() },
    updatedAtBlock: (options.indexerBlockNumber ?? DEFAULT_BLOCK_NUMBER).toString()
  };
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

function transactionReceipt(blockNumber: bigint, status: "success" | "reverted"): Record<string, unknown> {
  return {
    blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    blockNumber: numberToHex(blockNumber),
    contractAddress: null,
    cumulativeGasUsed: numberToHex(100_000n),
    effectiveGasPrice: numberToHex(1n),
    from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    gasUsed: numberToHex(100_000n),
    logs: [],
    logsBloom: `0x${"0".repeat(512)}`,
    status: status === "success" ? "0x1" : "0x0",
    to: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
    type: "0x2"
  };
}

function transactionByHash(blockNumber: bigint, state: MockRpcSnapshot): Record<string, unknown> {
  const simulatedTransaction = state.ethCalls.findLast((call) =>
    ["addLiquidity", "approve", "approveForAll", "removeLiquidity", "swapExactTokensForTokens"].includes(
      call.functionName
    )
  );

  return {
    blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    blockNumber: numberToHex(blockNumber),
    chainId: numberToHex(LOCALNET_CHAIN_ID),
    from: DEFAULT_ACCOUNT,
    gas: numberToHex(500_000n),
    gasPrice: numberToHex(1n),
    hash: TX_HASH,
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
