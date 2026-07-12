import { erc20Abi, lbPairAbi, lbRouterAbi } from "@robinhood-lb/sdk/abi";
import {
  quoteAddLiquidityMathFromSimulation,
  type AddLiquidityMathQuote,
  type AddLiquiditySimulationResult
} from "@robinhood-lb/sdk/liquidity-review";
import {
  decodeFunctionData,
  decodeFunctionResult,
  decodeEventLog,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient
} from "viem";

export interface AddLiquidityParameters {
  tokenX: Address;
  tokenY: Address;
  binStep: bigint;
  amountX: bigint;
  amountY: bigint;
  amountXMin: bigint;
  amountYMin: bigint;
  activeIdDesired: bigint;
  idSlippage: bigint;
  deltaIds: readonly bigint[];
  distributionX: readonly bigint[];
  distributionY: readonly bigint[];
  to: Address;
  refundTo: Address;
  deadline: bigint;
}

export interface PinnedBlockIdentity {
  hash: Hex;
  number: bigint;
  timestamp: bigint;
}

export interface PinnedAddLiquidityReview {
  account: Address;
  activeId: bigint;
  assetMode: "erc20" | "native";
  block: PinnedBlockIdentity;
  math: AddLiquidityMathQuote;
  parameters: AddLiquidityParameters;
  pair: Address;
  router: Address;
  simulation: AddLiquiditySimulationResult;
  transaction: { data: Hex; to: Address; value: bigint };
}

export interface AddLiquidityReceiptReconciliation {
  actualGasCostWei: bigint;
  actualGasPrice: bigint;
  actualGasUsed: bigint;
  actualAddedX: bigint;
  actualAddedY: bigint;
  compositionFeeX: bigint;
  compositionFeeY: bigint;
  depositedX: bigint;
  depositedY: bigint;
  eventObservedGrossX: bigint | null;
  eventObservedGrossY: bigint | null;
  eventObservedNetSpendX: bigint | null;
  eventObservedNetSpendY: bigint | null;
  estimateDifferences: string[];
  estimateMatchedActual: boolean;
  mintedIds: bigint[];
  mintedShares: bigint[];
  positionAmountAfterFeeX: bigint;
  positionAmountAfterFeeY: bigint;
  protocolFeeX: bigint;
  protocolFeeY: bigint;
  refundedX: bigint | null;
  refundedY: bigint | null;
}

export interface NativeAddLiquidityReceiptReconciliation extends AddLiquidityReceiptReconciliation {
  nativeValueWei: bigint;
  otherTokenNetSpend: bigint;
  wrapperRefund: bigint;
  lpBalanceDeltas: ReadonlyArray<{ binId: bigint; delta: bigint }>;
}

export async function getPinnedBlockIdentity(publicClient: PublicClient): Promise<PinnedBlockIdentity> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  if (block.hash === null) throw new Error("Latest block has no canonical hash");
  return { hash: block.hash, number: block.number, timestamp: block.timestamp };
}

export async function loadPinnedAddLiquidityReview(
  publicClient: PublicClient,
  input: {
    account: Address;
    assetMode: "erc20" | "native";
    block: PinnedBlockIdentity;
    pair: Address;
    parameters: AddLiquidityParameters;
    router: Address;
    transaction: { data: Hex; to: Address; value: bigint };
  }
): Promise<PinnedAddLiquidityReview> {
  const { block, parameters } = input;
  if (!isAddressEqual(input.transaction.to, input.router)) throw new Error("Reviewed liquidity transaction targets the wrong router");
  const decodedTransaction = decodeFunctionData({ abi: lbRouterAbi, data: input.transaction.data });
  const expectedFunction = input.assetMode === "native" ? "addLiquidityNATIVE" : "addLiquidity";
  if (decodedTransaction.functionName !== expectedFunction || parametersKey(decodedTransaction.args[0]) !== parametersKey(parameters)) {
    throw new Error("Reviewed liquidity transaction calldata differs from its parameters or asset mode");
  }
  if ((input.assetMode === "erc20" && input.transaction.value !== 0n) || (input.assetMode === "native" && input.transaction.value <= 0n)) {
    throw new Error("Reviewed liquidity transaction value differs from its asset mode");
  }
  const [activeIdRaw, binStepRaw, staticFeesRaw, variableFeesRaw, simulation] = await Promise.all([
    publicClient.readContract({ address: input.pair, abi: lbPairAbi, functionName: "getActiveId", blockNumber: block.number }),
    publicClient.readContract({ address: input.pair, abi: lbPairAbi, functionName: "getBinStep", blockNumber: block.number }),
    publicClient.readContract({ address: input.pair, abi: lbPairAbi, functionName: "getStaticFeeParameters", blockNumber: block.number }),
    publicClient.readContract({ address: input.pair, abi: lbPairAbi, functionName: "getVariableFeeParameters", blockNumber: block.number }),
    publicClient.call({
      account: input.account,
      to: input.transaction.to,
      data: input.transaction.data,
      value: input.transaction.value,
      blockNumber: block.number
    })
  ]);
  const activeId = BigInt(activeIdRaw);
  const binStep = BigInt(binStepRaw);
  if (binStep !== parameters.binStep) throw new Error("Pinned pair bin step differs from reviewed calldata");
  const binIds = parameters.deltaIds.map((deltaId) => activeId + deltaId);
  const binStates = await Promise.all(binIds.map(async (binId) => {
    if (binId < 0n || binId > 16_777_215n) throw new Error(`Reviewed bin ${binId.toString()} is outside uint24`);
    const [reserves, totalSupply, priceQ128] = await Promise.all([
      publicClient.readContract({ address: input.pair, abi: lbPairAbi, functionName: "getBin", args: [Number(binId)], blockNumber: block.number }),
      publicClient.readContract({ address: input.pair, abi: lbPairAbi, functionName: "totalSupply", args: [binId], blockNumber: block.number }),
      publicClient.readContract({ address: input.pair, abi: lbPairAbi, functionName: "getPriceFromId", args: [Number(binId)], blockNumber: block.number })
    ]);
    return {
      binId,
      priceQ128,
      reserveX: reserves[0],
      reserveY: reserves[1],
      totalSupply
    };
  }));
  const canonicalBlock = await publicClient.getBlock({ blockNumber: block.number });
  if (canonicalBlock.hash === null || canonicalBlock.hash.toLowerCase() !== block.hash.toLowerCase() || canonicalBlock.timestamp !== block.timestamp) {
    throw new Error("Pinned liquidity review block changed during RPC reads");
  }
  if (simulation.data === undefined) throw new Error("Pinned liquidity simulation returned no result data");
  const simulationTuple = decodeFunctionResult({ abi: lbRouterAbi, functionName: expectedFunction, data: simulation.data });
  const math = quoteAddLiquidityMathFromSimulation({
    activeId,
    binStep,
    bins: binStates,
    blockTimestamp: block.timestamp,
    deltaIds: parameters.deltaIds,
    distributionX: parameters.distributionX,
    distributionY: parameters.distributionY,
    staticFees: {
      baseFactor: BigInt(staticFeesRaw[0]),
      filterPeriod: BigInt(staticFeesRaw[1]),
      decayPeriod: BigInt(staticFeesRaw[2]),
      reductionFactor: BigInt(staticFeesRaw[3]),
      variableFeeControl: BigInt(staticFeesRaw[4]),
      protocolShare: BigInt(staticFeesRaw[5]),
      maxVolatilityAccumulator: BigInt(staticFeesRaw[6])
    },
    variableFees: {
      volatilityAccumulator: BigInt(variableFeesRaw[0]),
      volatilityReference: BigInt(variableFeesRaw[1]),
      idReference: BigInt(variableFeesRaw[2]),
      timeOfLastUpdate: BigInt(variableFeesRaw[3])
    }
  }, simulationTuple);
  return {
    account: input.account,
    activeId,
    assetMode: input.assetMode,
    block,
    math,
    pair: input.pair,
    parameters,
    simulation: {
      amountXAdded: simulationTuple[0],
      amountYAdded: simulationTuple[1],
      amountXLeft: simulationTuple[2],
      amountYLeft: simulationTuple[3],
      depositIds: [...simulationTuple[4]],
      liquidityMinted: [...simulationTuple[5]]
    },
    router: input.router,
    transaction: { ...input.transaction }
  };
}

export function samePinnedLiquidityReview(
  left: PinnedAddLiquidityReview | null,
  right: PinnedAddLiquidityReview
): boolean {
  return left !== null &&
    isAddressEqual(left.account, right.account) &&
    isAddressEqual(left.pair, right.pair) &&
    isAddressEqual(left.router, right.router) &&
    left.assetMode === right.assetMode &&
    isAddressEqual(left.transaction.to, right.transaction.to) &&
    left.transaction.data.toLowerCase() === right.transaction.data.toLowerCase() &&
    left.transaction.value === right.transaction.value &&
    parametersKey(left.parameters) === parametersKey(right.parameters) &&
    left.block.number === right.block.number &&
    left.block.hash.toLowerCase() === right.block.hash.toLowerCase() &&
    left.block.timestamp === right.block.timestamp &&
    reviewOutcomeKey(left) === reviewOutcomeKey(right);
}

export function reconcileAddLiquidityReceipt(input: {
  account: Address;
  effectiveGasPrice: bigint;
  expectedReview: PinnedAddLiquidityReview;
  logs: readonly Log[];
  pair: Address;
  recipient: Address;
  refundRecipient: Address;
  router: Address;
  gasUsed: bigint;
  tokenX: Address;
  tokenY: Address;
  nativeSide?: "x" | "y" | null;
}): AddLiquidityReceiptReconciliation {
  let compositionFeeX = 0n;
  let compositionFeeY = 0n;
  let protocolFeeX = 0n;
  let protocolFeeY = 0n;
  let depositedX = 0n;
  let depositedY = 0n;
  let mintedIds: bigint[] | null = null;
  let mintedShares: bigint[] | null = null;
  let grossX: bigint | null = null;
  let grossY: bigint | null = null;
  let refundX: bigint | null = null;
  let refundY: bigint | null = null;
  let walletIncomingX = 0n;
  let walletIncomingY = 0n;
  let walletOutgoingX = 0n;
  let walletOutgoingY = 0n;
  let depositedIds: bigint[] | null = null;
  let depositEventCount = 0;
  let mintEventCount = 0;
  const compositionFeeIds: bigint[] = [];

  for (const log of input.logs) {
    if (isAddressEqual(log.address, input.pair)) {
      try {
        const event = decodeEventLog({ abi: lbPairAbi, data: log.data, topics: log.topics, strict: true });
        if (event.eventName === "CompositionFees") {
          if (!isAddressEqual(event.args.sender, input.router)) throw new Error("Composition fee sender is not the reviewed router");
          const total = decodePackedAmounts(event.args.totalFees);
          const protocol = decodePackedAmounts(event.args.protocolFees);
          if (protocol.x > total.x || protocol.y > total.y) throw new Error("Protocol composition fee exceeds the total fee");
          compositionFeeIds.push(BigInt(event.args.id));
          compositionFeeX += total.x;
          compositionFeeY += total.y;
          protocolFeeX += protocol.x;
          protocolFeeY += protocol.y;
        } else if (event.eventName === "DepositedToBins") {
          if (!isAddressEqual(event.args.sender, input.router) || !isAddressEqual(event.args.to, input.recipient)) {
            throw new Error("Deposit event does not match the reviewed router and recipient");
          }
          depositEventCount += 1;
          if (depositEventCount > 1 || event.args.ids.length !== event.args.amounts.length) {
            throw new Error("Canonical receipt has ambiguous LB deposit evidence");
          }
          depositedIds = [...event.args.ids];
          for (const amount of event.args.amounts) {
            const decoded = decodePackedAmounts(amount);
            depositedX += decoded.x;
            depositedY += decoded.y;
          }
        } else if (event.eventName === "TransferBatch") {
          if (
            !isAddressEqual(event.args.sender, input.router) ||
            !isAddressEqual(event.args.from, zeroAddress) ||
            !isAddressEqual(event.args.to, input.recipient)
          ) {
            throw new Error("LB mint event does not match the reviewed router and recipient");
          }
          mintEventCount += 1;
          if (mintEventCount > 1 || event.args.ids.length !== event.args.amounts.length) {
            throw new Error("Canonical receipt has ambiguous LB mint evidence");
          }
          mintedIds = [...event.args.ids];
          mintedShares = [...event.args.amounts];
        }
      } catch (error) {
        if (error instanceof Error && /reviewed router|ambiguous LB|composition fee exceeds/.test(error.message)) throw error;
        // A pair may emit hook-defined events. Only exact known LB events are evidence here.
      }
      continue;
    }
    if (isAddressEqual(log.address, input.tokenX)) {
      const transfer = decodeRelevantTransfer(log, input.account, input.pair, input.refundRecipient, input.nativeSide === "x" ? input.router : input.account);
      if (transfer?.kind === "gross") grossX = (grossX ?? 0n) + transfer.value;
      if (transfer?.kind === "refund") refundX = (refundX ?? 0n) + transfer.value;
      walletIncomingX += transfer?.walletIncoming ?? 0n;
      walletOutgoingX += transfer?.walletOutgoing ?? 0n;
    } else if (isAddressEqual(log.address, input.tokenY)) {
      const transfer = decodeRelevantTransfer(log, input.account, input.pair, input.refundRecipient, input.nativeSide === "y" ? input.router : input.account);
      if (transfer?.kind === "gross") grossY = (grossY ?? 0n) + transfer.value;
      if (transfer?.kind === "refund") refundY = (refundY ?? 0n) + transfer.value;
      walletIncomingY += transfer?.walletIncoming ?? 0n;
      walletOutgoingY += transfer?.walletOutgoing ?? 0n;
    }
  }

  if (depositEventCount !== 1 || mintEventCount !== 1 || depositedIds === null || mintedIds === null || mintedShares === null) {
    throw new Error("Canonical receipt is missing exact LB deposit or mint evidence");
  }
  if (!sameBigintArray(depositedIds, mintedIds)) {
    throw new Error("Canonical deposited bin ids differ from minted bin ids");
  }
  if (compositionFeeIds.some((id) => !mintedIds!.includes(id))) {
    throw new Error("Canonical composition fee references a bin that was not minted");
  }
  const actualAddedX = depositedX + protocolFeeX;
  const actualAddedY = depositedY + protocolFeeY;
  if (compositionFeeX > actualAddedX || compositionFeeY > actualAddedY) {
    throw new Error("Canonical composition fees exceed the actual added token amount");
  }
  if (input.gasUsed < 0n || input.effectiveGasPrice < 0n) throw new Error("Canonical receipt contains invalid gas accounting");
  const actualRefundX = refundX ?? (grossX !== null && grossX === actualAddedX ? 0n : null);
  const actualRefundY = refundY ?? (grossY !== null && grossY === actualAddedY ? 0n : null);
  const estimateDifferences = compareReceiptToEstimate(input.expectedReview, {
    actualAddedX,
    actualAddedY,
    compositionFeeX,
    compositionFeeY,
    mintedIds,
    mintedShares,
    protocolFeeX,
    protocolFeeY,
    refundedX: actualRefundX,
    refundedY: actualRefundY
  });
  return {
    actualGasCostWei: input.gasUsed * input.effectiveGasPrice,
    actualGasPrice: input.effectiveGasPrice,
    actualGasUsed: input.gasUsed,
    actualAddedX,
    actualAddedY,
    compositionFeeX,
    compositionFeeY,
    depositedX,
    depositedY,
    eventObservedGrossX: grossX,
    eventObservedGrossY: grossY,
    eventObservedNetSpendX: eventNetSpend(grossX, actualRefundX, walletOutgoingX, walletIncomingX, actualAddedX),
    eventObservedNetSpendY: eventNetSpend(grossY, actualRefundY, walletOutgoingY, walletIncomingY, actualAddedY),
    estimateDifferences,
    estimateMatchedActual: estimateDifferences.length === 0,
    mintedIds,
    mintedShares,
    positionAmountAfterFeeX: actualAddedX - compositionFeeX,
    positionAmountAfterFeeY: actualAddedY - compositionFeeY,
    protocolFeeX,
    protocolFeeY,
    refundedX: actualRefundX,
    refundedY: actualRefundY
  };
}

export function reconcileNativeAddLiquidityReceipt(input: {
  account: Address;
  effectiveGasPrice: bigint;
  expectedReview: PinnedAddLiquidityReview;
  gasUsed: bigint;
  logs: readonly Log[];
  lpBalances: ReadonlyArray<{ after: bigint; before: bigint; binId: bigint }>;
  nativeBalanceAfter: bigint;
  nativeBalanceBefore: bigint;
  nativeSide: "x" | "y";
  otherTokenBalanceAfter: bigint;
  otherTokenBalanceBefore: bigint;
  pair: Address;
  recipient: Address;
  refundRecipient: Address;
  router: Address;
  tokenX: Address;
  tokenY: Address;
  transactionValue: bigint;
  wrapperBalanceAfter: bigint;
  wrapperBalanceBefore: bigint;
}): NativeAddLiquidityReceiptReconciliation {
  if (!isAddressEqual(input.account, input.recipient) || !isAddressEqual(input.account, input.refundRecipient)) {
    throw new Error("Native liquidity reconciliation requires the wallet as position and refund recipient");
  }
  const base = reconcileAddLiquidityReceipt({ ...input, nativeSide: input.nativeSide });
  if (input.transactionValue <= 0n || input.expectedReview.assetMode !== "native" || input.expectedReview.transaction.value !== input.transactionValue) {
    throw new Error("Native liquidity receipt value differs from the reviewed transaction");
  }
  const gasCost = input.gasUsed * input.effectiveGasPrice;
  if (input.nativeBalanceBefore < input.nativeBalanceAfter + gasCost) throw new Error("Canonical ETH balance delta cannot fund native value and gas");
  const nativeSpend = input.nativeBalanceBefore - input.nativeBalanceAfter - gasCost;
  if (nativeSpend !== input.transactionValue) throw new Error("Canonical gas-adjusted ETH spend differs from transaction value");
  const wrapperRefund = input.nativeSide === "x" ? base.refundedX : base.refundedY;
  const wrapperGross = input.nativeSide === "x" ? base.eventObservedGrossX : base.eventObservedGrossY;
  if (wrapperRefund === null || wrapperGross !== input.transactionValue) {
    throw new Error("Canonical WNATIVE funding or refund evidence differs from native value");
  }
  if (input.wrapperBalanceAfter < input.wrapperBalanceBefore || input.wrapperBalanceAfter - input.wrapperBalanceBefore !== wrapperRefund) {
    throw new Error("Canonical wallet WNATIVE delta differs from the pair refund");
  }
  const observedOtherTokenNetSpend = input.nativeSide === "x" ? base.eventObservedNetSpendY : base.eventObservedNetSpendX;
  const requestedOtherTokenAmount = input.nativeSide === "x" ? input.expectedReview.parameters.amountY : input.expectedReview.parameters.amountX;
  const otherTokenNetSpend = requestedOtherTokenAmount === 0n ? 0n : observedOtherTokenNetSpend;
  if (
    otherTokenNetSpend === null ||
    input.otherTokenBalanceBefore < input.otherTokenBalanceAfter ||
    input.otherTokenBalanceBefore - input.otherTokenBalanceAfter !== otherTokenNetSpend
  ) throw new Error("Canonical other-token balance delta differs from transfer evidence");
  if (input.lpBalances.length !== base.mintedIds.length) throw new Error("Canonical LP balance evidence does not cover every minted bin");
  const lpBalanceDeltas = input.lpBalances.map((balance, index) => {
    if (balance.binId !== base.mintedIds[index] || balance.after < balance.before) throw new Error("Canonical LP balance evidence differs from minted bin order");
    const delta = balance.after - balance.before;
    if (delta !== base.mintedShares[index]) throw new Error("Canonical LP balance delta differs from minted shares");
    return { binId: balance.binId, delta };
  });
  return { ...base, nativeValueWei: input.transactionValue, otherTokenNetSpend, wrapperRefund, lpBalanceDeltas };
}

function reviewOutcomeKey(review: PinnedAddLiquidityReview): string {
  return [
    review.activeId,
    review.simulation.amountXAdded,
    review.simulation.amountYAdded,
    review.simulation.amountXLeft,
    review.simulation.amountYLeft,
    review.simulation.depositIds.join(","),
    review.simulation.liquidityMinted.join(","),
    review.math.compositionFeeX,
    review.math.compositionFeeY,
    review.math.protocolFeeX,
    review.math.protocolFeeY
  ].join("|");
}

function parametersKey(parameters: AddLiquidityParameters): string {
  return [
    parameters.tokenX.toLowerCase(),
    parameters.tokenY.toLowerCase(),
    parameters.binStep,
    parameters.amountX,
    parameters.amountY,
    parameters.amountXMin,
    parameters.amountYMin,
    parameters.activeIdDesired,
    parameters.idSlippage,
    parameters.deltaIds.join(","),
    parameters.distributionX.join(","),
    parameters.distributionY.join(","),
    parameters.to.toLowerCase(),
    parameters.refundTo.toLowerCase(),
    parameters.deadline
  ].join("|");
}

function decodePackedAmounts(value: Hex): { x: bigint; y: bigint } {
  const packed = BigInt(value);
  const mask = (1n << 128n) - 1n;
  return { x: packed & mask, y: packed >> 128n };
}

function decodeRelevantTransfer(
  log: Log,
  account: Address,
  pair: Address,
  refundRecipient: Address,
  grossSender: Address
): { kind: "gross" | "refund" | null; value: bigint; walletIncoming: bigint; walletOutgoing: bigint } | null {
  try {
    const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, strict: true });
    if (event.eventName !== "Transfer") return null;
    const kind = isAddressEqual(event.args.from, grossSender) && isAddressEqual(event.args.to, pair)
      ? "gross"
      : isAddressEqual(event.args.from, pair) && isAddressEqual(event.args.to, refundRecipient)
        ? "refund"
        : null;
    return {
      kind,
      value: event.args.value,
      walletIncoming: isAddressEqual(event.args.to, account) ? event.args.value : 0n,
      walletOutgoing: isAddressEqual(event.args.from, account) ? event.args.value : 0n
    };
  } catch {
    return null;
  }
}

function eventNetSpend(
  gross: bigint | null,
  refund: bigint | null,
  walletOutgoing: bigint,
  walletIncoming: bigint,
  actualAdded: bigint
): bigint | null {
  if (gross === null) return null;
  if (refund === null) return null;
  if (refund > gross) throw new Error("Canonical refund transfer exceeds the observed gross transfer");
  if (gross !== actualAdded + refund) return null;
  if (walletIncoming > walletOutgoing) return null;
  return walletOutgoing - walletIncoming;
}

function compareReceiptToEstimate(
  review: PinnedAddLiquidityReview,
  actual: {
    actualAddedX: bigint;
    actualAddedY: bigint;
    compositionFeeX: bigint;
    compositionFeeY: bigint;
    mintedIds: readonly bigint[];
    mintedShares: readonly bigint[];
    protocolFeeX: bigint;
    protocolFeeY: bigint;
    refundedX: bigint | null;
    refundedY: bigint | null;
  }
): string[] {
  const differences: string[] = [];
  const compare = (label: string, expected: bigint, actualValue: bigint | null) => {
    if (actualValue === null) differences.push(`${label} actual is unavailable`);
    else if (actualValue !== expected) differences.push(`${label} changed from ${expected.toString()} to ${actualValue.toString()}`);
  };
  compare("token X added", review.simulation.amountXAdded, actual.actualAddedX);
  compare("token Y added", review.simulation.amountYAdded, actual.actualAddedY);
  compare("token X refund", review.simulation.amountXLeft, actual.refundedX);
  compare("token Y refund", review.simulation.amountYLeft, actual.refundedY);
  compare("token X composition fee", review.math.compositionFeeX, actual.compositionFeeX);
  compare("token Y composition fee", review.math.compositionFeeY, actual.compositionFeeY);
  compare("token X protocol fee", review.math.protocolFeeX, actual.protocolFeeX);
  compare("token Y protocol fee", review.math.protocolFeeY, actual.protocolFeeY);
  if (!sameBigintArray(review.simulation.depositIds, actual.mintedIds)) differences.push("minted bin ids changed");
  if (!sameBigintArray(review.simulation.liquidityMinted, actual.mintedShares)) differences.push("minted shares changed");
  return differences;
}

function sameBigintArray(left: readonly bigint[], right: readonly bigint[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
