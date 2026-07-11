import { BigInt } from "@graphprotocol/graph-ts";

import {
  LBPairCreated,
  LBPairIgnoredStateChanged,
  PresetOpenStateChanged,
  PresetRemoved,
  PresetSet,
  QuoteAssetAdded,
  QuoteAssetRemoved
} from "../generated/LBFactory/LBFactory";
import { LBPair as LBPairContract } from "../generated/LBFactory/LBPair";
import { LBPair as LBPairTemplate } from "../generated/templates";
import { FactoryPreset, Pair } from "../generated/schema";
import { getOrCreateFactory, getOrCreateToken, saveActivity } from "./entities";
import { ONE_BI, ZERO_BI } from "./constants";

export function handleLBPairCreated(event: LBPairCreated): void {
  const factory = getOrCreateFactory(event.address, event);
  const tokenX = getOrCreateToken(event.params.tokenX, event);
  const tokenY = getOrCreateToken(event.params.tokenY, event);

  tokenX.pairCount = tokenX.pairCount.plus(ONE_BI);
  tokenX.updatedAtBlock = event.block.number;
  tokenX.save();

  tokenY.pairCount = tokenY.pairCount.plus(ONE_BI);
  tokenY.updatedAtBlock = event.block.number;
  tokenY.save();

  const pair = new Pair(event.params.LBPair.toHexString());
  pair.address = event.params.LBPair;
  pair.factory = factory.id;
  pair.tokenX = tokenX.id;
  pair.tokenY = tokenY.id;
  pair.binStep = event.params.binStep;
  pair.pid = event.params.pid;

  const pairContract = LBPairContract.bind(event.params.LBPair);
  const activeId = pairContract.try_getActiveId();
  pair.activeId = activeId.reverted ? null : BigInt.fromI32(activeId.value);

  const staticFees = pairContract.try_getStaticFeeParameters();
  if (staticFees.reverted) {
    pair.baseFactor = null;
    pair.filterPeriod = null;
    pair.decayPeriod = null;
    pair.reductionFactor = null;
    pair.variableFeeControl = null;
    pair.protocolShare = null;
    pair.maxVolatilityAccumulator = null;
  } else {
    pair.baseFactor = BigInt.fromI32(staticFees.value.getBaseFactor());
    pair.filterPeriod = BigInt.fromI32(staticFees.value.getFilterPeriod());
    pair.decayPeriod = BigInt.fromI32(staticFees.value.getDecayPeriod());
    pair.reductionFactor = BigInt.fromI32(staticFees.value.getReductionFactor());
    pair.variableFeeControl = BigInt.fromI32(staticFees.value.getVariableFeeControl());
    pair.protocolShare = BigInt.fromI32(staticFees.value.getProtocolShare());
    pair.maxVolatilityAccumulator = BigInt.fromI32(staticFees.value.getMaxVolatilityAccumulator());
  }

  const hooksParameters = pairContract.try_getLBHooksParameters();
  pair.hooksParameters = hooksParameters.reverted ? null : hooksParameters.value;

  const reserves = pairContract.try_getReserves();
  if (reserves.reverted) {
    pair.reserveX = ZERO_BI;
    pair.reserveY = ZERO_BI;
  } else {
    pair.reserveX = reserves.value.getReserveX();
    pair.reserveY = reserves.value.getReserveY();
  }

  pair.totalVolumeX = ZERO_BI;
  pair.totalVolumeY = ZERO_BI;
  pair.totalFeesX = ZERO_BI;
  pair.totalFeesY = ZERO_BI;
  pair.protocolFeesX = ZERO_BI;
  pair.protocolFeesY = ZERO_BI;
  pair.ignoredForRouting = false;
  pair.swapCount = ZERO_BI;
  pair.depositCount = ZERO_BI;
  pair.withdrawCount = ZERO_BI;
  pair.transferCount = ZERO_BI;
  pair.createdAtBlock = event.block.number;
  pair.createdAtTimestamp = event.block.timestamp;
  pair.updatedAtBlock = event.block.number;
  pair.save();

  factory.pairCount = factory.pairCount.plus(ONE_BI);
  factory.updatedAtBlock = event.block.number;
  factory.save();

  LBPairTemplate.create(event.params.LBPair);
  saveActivity(event, "PAIR_CREATED", pair, event.params.LBPair);
}

export function handleLBPairIgnoredStateChanged(event: LBPairIgnoredStateChanged): void {
  const pair = Pair.load(event.params.LBPair.toHexString());
  if (pair == null) return;

  pair.ignoredForRouting = event.params.ignored;
  pair.updatedAtBlock = event.block.number;
  pair.save();

  saveActivity(event, "PAIR_IGNORED_STATE_CHANGED", pair, event.params.LBPair);
}

export function handlePresetSet(event: PresetSet): void {
  const factory = getOrCreateFactory(event.address, event);
  const id = event.address.toHexString() + "-" + event.params.binStep.toString();
  let preset = FactoryPreset.load(id);
  const isNew = preset == null;

  if (preset == null) {
    preset = new FactoryPreset(id);
    preset.factory = factory.id;
    preset.binStep = event.params.binStep;
    preset.open = false;
  }

  preset.baseFactor = event.params.baseFactor;
  preset.filterPeriod = event.params.filterPeriod;
  preset.decayPeriod = event.params.decayPeriod;
  preset.reductionFactor = event.params.reductionFactor;
  preset.variableFeeControl = event.params.variableFeeControl;
  preset.protocolShare = event.params.protocolShare;
  preset.maxVolatilityAccumulator = event.params.maxVolatilityAccumulator;
  preset.removed = false;
  preset.updatedAtBlock = event.block.number;
  preset.save();

  if (isNew) {
    factory.presetCount = factory.presetCount.plus(ONE_BI);
    factory.updatedAtBlock = event.block.number;
    factory.save();
  }

  saveActivity(event, "PRESET_SET");
}

export function handlePresetOpenStateChanged(event: PresetOpenStateChanged): void {
  const factory = getOrCreateFactory(event.address, event);
  const id = event.address.toHexString() + "-" + event.params.binStep.toString();
  let preset = FactoryPreset.load(id);

  if (preset == null) {
    preset = new FactoryPreset(id);
    preset.factory = factory.id;
    preset.binStep = event.params.binStep;
    preset.baseFactor = ZERO_BI;
    preset.filterPeriod = ZERO_BI;
    preset.decayPeriod = ZERO_BI;
    preset.reductionFactor = ZERO_BI;
    preset.variableFeeControl = ZERO_BI;
    preset.protocolShare = ZERO_BI;
    preset.maxVolatilityAccumulator = ZERO_BI;
    preset.removed = false;
  }

  preset.open = event.params.isOpen;
  preset.updatedAtBlock = event.block.number;
  preset.save();

  saveActivity(event, "PRESET_OPEN_STATE_CHANGED");
}

export function handlePresetRemoved(event: PresetRemoved): void {
  const factory = getOrCreateFactory(event.address, event);
  const id = event.address.toHexString() + "-" + event.params.binStep.toString();
  const preset = FactoryPreset.load(id);

  if (preset != null) {
    preset.removed = true;
    preset.updatedAtBlock = event.block.number;
    preset.save();
  }

  saveActivity(event, "PRESET_REMOVED");
}

export function handleQuoteAssetAdded(event: QuoteAssetAdded): void {
  const factory = getOrCreateFactory(event.address, event);
  const token = getOrCreateToken(event.params.quoteAsset, event);

  token.isQuoteAsset = true;
  token.updatedAtBlock = event.block.number;
  token.save();

  factory.quoteAssetCount = factory.quoteAssetCount.plus(ONE_BI);
  factory.updatedAtBlock = event.block.number;
  factory.save();

  saveActivity(event, "QUOTE_ASSET_ADDED", null, event.params.quoteAsset);
}

export function handleQuoteAssetRemoved(event: QuoteAssetRemoved): void {
  const factory = getOrCreateFactory(event.address, event);
  const token = getOrCreateToken(event.params.quoteAsset, event);

  token.isQuoteAsset = false;
  token.updatedAtBlock = event.block.number;
  token.save();

  if (factory.quoteAssetCount.gt(ZERO_BI)) {
    factory.quoteAssetCount = factory.quoteAssetCount.minus(ONE_BI);
  }
  factory.updatedAtBlock = event.block.number;
  factory.save();

  saveActivity(event, "QUOTE_ASSET_REMOVED", null, event.params.quoteAsset);
}
