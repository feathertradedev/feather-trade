import { BigInt, ethereum } from "@graphprotocol/graph-ts";

import {
  CollectedProtocolFees,
  CompositionFees,
  DepositedToBins,
  HooksParametersSet,
  LBPair as LBPairContract,
  StaticFeeParametersSet,
  Swap as SwapEvent,
  TransferBatch,
  WithdrawnFromBins
} from "../generated/templates/LBPair/LBPair";
import { Bin, FeeEvent, LiquidityEvent, Pair, StaticFeeParametersEvent, Swap, TransferBatchEvent } from "../generated/schema";
import { getOrCreateBin, getOrCreatePosition, saveActivity } from "./entities";
import { eventId } from "./id";
import { ONE_BI, ZERO_ADDRESS, ZERO_BI } from "./constants";
import { decodePackedAmounts } from "./packed";

function updatePairReserves(pair: Pair, event: ethereum.Event): void {
  const pairContract = LBPairContract.bind(event.address);
  const reserves = pairContract.try_getReserves();

  if (!reserves.reverted) {
    pair.reserveX = reserves.value.getReserveX();
    pair.reserveY = reserves.value.getReserveY();
  }
}

function updateBinReserves(bin: Bin, event: ethereum.Event): void {
  const pairContract = LBPairContract.bind(event.address);
  const reserves = pairContract.try_getBin(bin.binId.toI32());

  if (!reserves.reverted) {
    bin.reserveX = reserves.value.getBinReserveX();
    bin.reserveY = reserves.value.getBinReserveY();
  }
}

export function handleSwap(event: SwapEvent): void {
  const pair = Pair.load(event.address.toHexString());
  if (pair == null) return;

  const swap = new Swap(eventId(event));
  swap.pair = pair.id;
  swap.sender = event.params.sender;
  swap.to = event.params.to;
  swap.activeId = BigInt.fromI32(event.params.id);
  swap.amountsIn = event.params.amountsIn;
  const amountsIn = decodePackedAmounts(event.params.amountsIn);
  swap.amountInX = amountsIn.x;
  swap.amountInY = amountsIn.y;
  swap.amountsOut = event.params.amountsOut;
  const amountsOut = decodePackedAmounts(event.params.amountsOut);
  swap.amountOutX = amountsOut.x;
  swap.amountOutY = amountsOut.y;
  swap.volatilityAccumulator = BigInt.fromI32(event.params.volatilityAccumulator);
  swap.totalFees = event.params.totalFees;
  const totalFees = decodePackedAmounts(event.params.totalFees);
  swap.totalFeeX = totalFees.x;
  swap.totalFeeY = totalFees.y;
  swap.protocolFees = event.params.protocolFees;
  const protocolFees = decodePackedAmounts(event.params.protocolFees);
  swap.protocolFeeX = protocolFees.x;
  swap.protocolFeeY = protocolFees.y;
  swap.blockNumber = event.block.number;
  swap.timestamp = event.block.timestamp;
  swap.transactionHash = event.transaction.hash;
  swap.save();

  pair.activeId = BigInt.fromI32(event.params.id);
  pair.totalVolumeX = pair.totalVolumeX.plus(amountsIn.x).plus(amountsOut.x);
  pair.totalVolumeY = pair.totalVolumeY.plus(amountsIn.y).plus(amountsOut.y);
  pair.totalFeesX = pair.totalFeesX.plus(totalFees.x);
  pair.totalFeesY = pair.totalFeesY.plus(totalFees.y);
  pair.protocolFeesX = pair.protocolFeesX.plus(protocolFees.x);
  pair.protocolFeesY = pair.protocolFeesY.plus(protocolFees.y);
  pair.swapCount = pair.swapCount.plus(ONE_BI);
  pair.updatedAtBlock = event.block.number;
  updatePairReserves(pair, event);
  pair.save();

  const activeBin = getOrCreateBin(pair, BigInt.fromI32(event.params.id), event);
  updateBinReserves(activeBin, event);
  activeBin.save();

  saveActivity(event, "SWAP", pair, event.params.sender);
}

export function handleDepositedToBins(event: DepositedToBins): void {
  const pair = Pair.load(event.address.toHexString());
  if (pair == null) return;

  const liquidityEvent = new LiquidityEvent(eventId(event));
  liquidityEvent.pair = pair.id;
  liquidityEvent.type = "DEPOSIT";
  liquidityEvent.sender = event.params.sender;
  liquidityEvent.to = event.params.to;
  liquidityEvent.ids = event.params.ids;
  liquidityEvent.amounts = event.params.amounts;
  liquidityEvent.amountX = ZERO_BI;
  liquidityEvent.amountY = ZERO_BI;
  liquidityEvent.blockNumber = event.block.number;
  liquidityEvent.timestamp = event.block.timestamp;
  liquidityEvent.transactionHash = event.transaction.hash;

  for (let i = 0; i < event.params.ids.length; i++) {
    const amounts = decodePackedAmounts(event.params.amounts[i]);
    liquidityEvent.amountX = liquidityEvent.amountX.plus(amounts.x);
    liquidityEvent.amountY = liquidityEvent.amountY.plus(amounts.y);

    const bin = getOrCreateBin(pair, event.params.ids[i], event);
    updateBinReserves(bin, event);
    bin.save();
  }
  liquidityEvent.save();

  pair.depositCount = pair.depositCount.plus(ONE_BI);
  pair.updatedAtBlock = event.block.number;
  updatePairReserves(pair, event);
  pair.save();

  saveActivity(event, "DEPOSIT", pair, event.params.sender);
}

export function handleWithdrawnFromBins(event: WithdrawnFromBins): void {
  const pair = Pair.load(event.address.toHexString());
  if (pair == null) return;

  const liquidityEvent = new LiquidityEvent(eventId(event));
  liquidityEvent.pair = pair.id;
  liquidityEvent.type = "WITHDRAW";
  liquidityEvent.sender = event.params.sender;
  liquidityEvent.to = event.params.to;
  liquidityEvent.ids = event.params.ids;
  liquidityEvent.amounts = event.params.amounts;
  liquidityEvent.amountX = ZERO_BI;
  liquidityEvent.amountY = ZERO_BI;
  liquidityEvent.blockNumber = event.block.number;
  liquidityEvent.timestamp = event.block.timestamp;
  liquidityEvent.transactionHash = event.transaction.hash;

  for (let i = 0; i < event.params.ids.length; i++) {
    const amounts = decodePackedAmounts(event.params.amounts[i]);
    liquidityEvent.amountX = liquidityEvent.amountX.plus(amounts.x);
    liquidityEvent.amountY = liquidityEvent.amountY.plus(amounts.y);

    const bin = getOrCreateBin(pair, event.params.ids[i], event);
    updateBinReserves(bin, event);
    bin.save();
  }
  liquidityEvent.save();

  pair.withdrawCount = pair.withdrawCount.plus(ONE_BI);
  pair.updatedAtBlock = event.block.number;
  updatePairReserves(pair, event);
  pair.save();

  saveActivity(event, "WITHDRAW", pair, event.params.sender);
}

export function handleTransferBatch(event: TransferBatch): void {
  const pair = Pair.load(event.address.toHexString());
  if (pair == null) return;

  const transfer = new TransferBatchEvent(eventId(event));
  transfer.pair = pair.id;
  transfer.sender = event.params.sender;
  transfer.from = event.params.from;
  transfer.to = event.params.to;
  transfer.ids = event.params.ids;
  transfer.amounts = event.params.amounts;
  transfer.blockNumber = event.block.number;
  transfer.timestamp = event.block.timestamp;
  transfer.transactionHash = event.transaction.hash;
  transfer.save();

  for (let i = 0; i < event.params.ids.length; i++) {
    const bin = getOrCreateBin(pair, event.params.ids[i], event);
    const amount = event.params.amounts[i];

    if (event.params.from.notEqual(ZERO_ADDRESS)) {
      const fromPosition = getOrCreatePosition(pair, event.params.from, bin, event);
      fromPosition.liquidity = amount.gt(fromPosition.liquidity) ? ZERO_BI : fromPosition.liquidity.minus(amount);
      fromPosition.updatedAtBlock = event.block.number;
      fromPosition.save();

      bin.totalSupply = amount.gt(bin.totalSupply) ? ZERO_BI : bin.totalSupply.minus(amount);
    }

    if (event.params.to.notEqual(ZERO_ADDRESS)) {
      const toPosition = getOrCreatePosition(pair, event.params.to, bin, event);
      toPosition.liquidity = toPosition.liquidity.plus(amount);
      toPosition.updatedAtBlock = event.block.number;
      toPosition.save();

      bin.totalSupply = bin.totalSupply.plus(amount);
    }

    updateBinReserves(bin, event);
    bin.updatedAtBlock = event.block.number;
    bin.save();
  }

  pair.transferCount = pair.transferCount.plus(ONE_BI);
  pair.updatedAtBlock = event.block.number;
  updatePairReserves(pair, event);
  pair.save();

  saveActivity(event, "TRANSFER_BATCH", pair, event.params.sender);
}

export function handleCompositionFees(event: CompositionFees): void {
  const pair = Pair.load(event.address.toHexString());
  if (pair == null) return;

  const fee = new FeeEvent(eventId(event));
  fee.pair = pair.id;
  fee.type = "COMPOSITION";
  fee.sender = event.params.sender;
  fee.binId = BigInt.fromI32(event.params.id);
  fee.totalFees = event.params.totalFees;
  const totalFees = decodePackedAmounts(event.params.totalFees);
  fee.totalFeeX = totalFees.x;
  fee.totalFeeY = totalFees.y;
  fee.protocolFees = event.params.protocolFees;
  const protocolFees = decodePackedAmounts(event.params.protocolFees);
  fee.protocolFeeX = protocolFees.x;
  fee.protocolFeeY = protocolFees.y;
  fee.blockNumber = event.block.number;
  fee.timestamp = event.block.timestamp;
  fee.transactionHash = event.transaction.hash;
  fee.save();

  pair.totalFeesX = pair.totalFeesX.plus(totalFees.x);
  pair.totalFeesY = pair.totalFeesY.plus(totalFees.y);
  pair.protocolFeesX = pair.protocolFeesX.plus(protocolFees.x);
  pair.protocolFeesY = pair.protocolFeesY.plus(protocolFees.y);
  pair.updatedAtBlock = event.block.number;
  pair.save();

  saveActivity(event, "COMPOSITION_FEES", pair, event.params.sender);
}

export function handleCollectedProtocolFees(event: CollectedProtocolFees): void {
  const pair = Pair.load(event.address.toHexString());
  if (pair == null) return;

  const fee = new FeeEvent(eventId(event));
  fee.pair = pair.id;
  fee.type = "PROTOCOL_COLLECTED";
  fee.sender = event.params.feeRecipient;
  fee.binId = null;
  fee.totalFees = null;
  fee.totalFeeX = null;
  fee.totalFeeY = null;
  fee.protocolFees = event.params.protocolFees;
  const protocolFees = decodePackedAmounts(event.params.protocolFees);
  fee.protocolFeeX = protocolFees.x;
  fee.protocolFeeY = protocolFees.y;
  fee.blockNumber = event.block.number;
  fee.timestamp = event.block.timestamp;
  fee.transactionHash = event.transaction.hash;
  fee.save();

  saveActivity(event, "COLLECTED_PROTOCOL_FEES", pair, event.params.feeRecipient);
}

export function handleStaticFeeParametersSet(event: StaticFeeParametersSet): void {
  const pair = Pair.load(event.address.toHexString());
  if (pair == null) return;

  const staticFees = new StaticFeeParametersEvent(eventId(event));
  staticFees.pair = pair.id;
  staticFees.sender = event.params.sender;
  staticFees.baseFactor = BigInt.fromI32(event.params.baseFactor);
  staticFees.filterPeriod = BigInt.fromI32(event.params.filterPeriod);
  staticFees.decayPeriod = BigInt.fromI32(event.params.decayPeriod);
  staticFees.reductionFactor = BigInt.fromI32(event.params.reductionFactor);
  staticFees.variableFeeControl = BigInt.fromI32(event.params.variableFeeControl);
  staticFees.protocolShare = BigInt.fromI32(event.params.protocolShare);
  staticFees.maxVolatilityAccumulator = BigInt.fromI32(event.params.maxVolatilityAccumulator);
  staticFees.blockNumber = event.block.number;
  staticFees.timestamp = event.block.timestamp;
  staticFees.transactionHash = event.transaction.hash;
  staticFees.save();

  pair.baseFactor = staticFees.baseFactor;
  pair.filterPeriod = staticFees.filterPeriod;
  pair.decayPeriod = staticFees.decayPeriod;
  pair.reductionFactor = staticFees.reductionFactor;
  pair.variableFeeControl = staticFees.variableFeeControl;
  pair.protocolShare = staticFees.protocolShare;
  pair.maxVolatilityAccumulator = staticFees.maxVolatilityAccumulator;
  pair.updatedAtBlock = event.block.number;
  pair.save();

  saveActivity(event, "STATIC_FEE_PARAMETERS_SET", pair, event.params.sender);
}

export function handleHooksParametersSet(event: HooksParametersSet): void {
  const pair = Pair.load(event.address.toHexString());
  if (pair == null) return;

  pair.hooksParameters = event.params.hooksParameters;
  pair.updatedAtBlock = event.block.number;
  pair.save();

  saveActivity(event, "HOOKS_PARAMETERS_SET", pair, event.params.sender);
}
