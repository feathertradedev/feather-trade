import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { afterEach, assert, clearStore, createMockedFunction, describe, newTypedMockEvent, test } from "matchstick-as/assembly/index";

import { CompositionFees, Swap as SwapEvent } from "../generated/templates/LBPair/LBPair";
import { Pair } from "../generated/schema";
import { handleCompositionFees, handleSwap } from "../src/pair";

const PAIR_ADDRESS = Address.fromString("0x1111111111111111111111111111111111111111");
const FACTORY_ADDRESS = Address.fromString("0x2222222222222222222222222222222222222222");
const TOKEN_X = Address.fromString("0x3333333333333333333333333333333333333333");
const TOKEN_Y = Address.fromString("0x4444444444444444444444444444444444444444");
const SENDER = Address.fromString("0x5555555555555555555555555555555555555555");
const TRANSACTION_FROM = Address.fromString("0x6666666666666666666666666666666666666666");
const TRANSACTION_HASH = Bytes.fromHexString(
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
);
const ZERO_PACKED = Bytes.fromHexString(
  "0x0000000000000000000000000000000000000000000000000000000000000000"
);
const X_SEVEN = Bytes.fromHexString(
  "0x0000000000000000000000000000000000000000000000000000000000000007"
);
const Y_NINE = Bytes.fromHexString(
  "0x0000000000000000000000000000000900000000000000000000000000000000"
);
const X_SEVEN_Y_NINE = Bytes.fromHexString(
  "0x0000000000000000000000000000000900000000000000000000000000000007"
);
const X_TWO_Y_THREE = Bytes.fromHexString(
  "0x0000000000000000000000000000000300000000000000000000000000000002"
);

describe("handleCompositionFees", () => {
  afterEach(() => {
    clearStore();
  });

  test("executes X-only composition fee aggregation exactly once", () => {
    executeCase(X_SEVEN, ZERO_PACKED, "18", "13", "2", "3", "7", "0", "0", "0");
  });

  test("executes Y-only composition fee aggregation exactly once", () => {
    executeCase(Y_NINE, ZERO_PACKED, "11", "22", "2", "3", "0", "9", "0", "0");
  });

  test("executes both-token composition fee aggregation exactly once", () => {
    executeCase(X_SEVEN_Y_NINE, ZERO_PACKED, "18", "22", "2", "3", "7", "9", "0", "0");
  });

  test("executes nonzero protocol-share aggregation exactly once", () => {
    executeCase(X_SEVEN_Y_NINE, X_TWO_Y_THREE, "18", "22", "4", "6", "7", "9", "2", "3");
  });
});

describe("handleSwap", () => {
  afterEach(() => {
    clearStore();
  });

  test("persists the canonical transaction origin independently of the router sender", () => {
    seedPair();
    mockPairReserves();
    const event = createSwapEvent();

    handleSwap(event);

    const swapId = TRANSACTION_HASH.toHexString() + "-0";
    assert.entityCount("Swap", 1);
    assert.fieldEquals("Swap", swapId, "transactionFrom", TRANSACTION_FROM.toHexString());
    assert.fieldEquals("Swap", swapId, "sender", SENDER.toHexString());
  });
});

function executeCase(
  totalFees: Bytes,
  protocolFees: Bytes,
  expectedPairTotalX: string,
  expectedPairTotalY: string,
  expectedPairProtocolX: string,
  expectedPairProtocolY: string,
  expectedEventTotalX: string,
  expectedEventTotalY: string,
  expectedEventProtocolX: string,
  expectedEventProtocolY: string
): void {
  seedPair();
  const event = createCompositionFeesEvent(totalFees, protocolFees);
  handleCompositionFees(event);

  const pairId = PAIR_ADDRESS.toHexString();
  assert.fieldEquals("Pair", pairId, "totalFeesX", expectedPairTotalX);
  assert.fieldEquals("Pair", pairId, "totalFeesY", expectedPairTotalY);
  assert.fieldEquals("Pair", pairId, "protocolFeesX", expectedPairProtocolX);
  assert.fieldEquals("Pair", pairId, "protocolFeesY", expectedPairProtocolY);
  assert.fieldEquals("Pair", pairId, "updatedAtBlock", "123");
  assert.fieldEquals("Pair", pairId, "totalVolumeX", "101");
  assert.fieldEquals("Pair", pairId, "totalVolumeY", "202");
  assert.fieldEquals("Pair", pairId, "swapCount", "3");

  const feeId = TRANSACTION_HASH.toHexString() + "-0";
  assert.entityCount("FeeEvent", 1);
  assert.fieldEquals("FeeEvent", feeId, "type", "COMPOSITION");
  assert.fieldEquals("FeeEvent", feeId, "totalFeeX", expectedEventTotalX);
  assert.fieldEquals("FeeEvent", feeId, "totalFeeY", expectedEventTotalY);
  assert.fieldEquals("FeeEvent", feeId, "protocolFeeX", expectedEventProtocolX);
  assert.fieldEquals("FeeEvent", feeId, "protocolFeeY", expectedEventProtocolY);
  assert.entityCount("Activity", 1);
}

function seedPair(): void {
  const pair = new Pair(PAIR_ADDRESS.toHexString());
  pair.address = PAIR_ADDRESS;
  pair.factory = FACTORY_ADDRESS.toHexString();
  pair.tokenX = TOKEN_X.toHexString();
  pair.tokenY = TOKEN_Y.toHexString();
  pair.binStep = BigInt.fromI32(10);
  pair.pid = BigInt.fromI32(0);
  pair.reserveX = BigInt.fromI32(1000);
  pair.reserveY = BigInt.fromI32(2000);
  pair.totalVolumeX = BigInt.fromI32(101);
  pair.totalVolumeY = BigInt.fromI32(202);
  pair.totalFeesX = BigInt.fromI32(11);
  pair.totalFeesY = BigInt.fromI32(13);
  pair.protocolFeesX = BigInt.fromI32(2);
  pair.protocolFeesY = BigInt.fromI32(3);
  pair.ignoredForRouting = false;
  pair.swapCount = BigInt.fromI32(3);
  pair.depositCount = BigInt.fromI32(4);
  pair.withdrawCount = BigInt.fromI32(5);
  pair.transferCount = BigInt.fromI32(6);
  pair.createdAtBlock = BigInt.fromI32(1);
  pair.createdAtTimestamp = BigInt.fromI32(1);
  pair.updatedAtBlock = BigInt.fromI32(1);
  pair.save();
}

function createCompositionFeesEvent(totalFees: Bytes, protocolFees: Bytes): CompositionFees {
  const event = newTypedMockEvent<CompositionFees>();
  event.address = PAIR_ADDRESS;
  event.block.number = BigInt.fromI32(123);
  event.block.timestamp = BigInt.fromI32(456);
  event.transaction.hash = TRANSACTION_HASH;
  event.logIndex = BigInt.fromI32(0);
  event.parameters = [
    new ethereum.EventParam("sender", ethereum.Value.fromAddress(SENDER)),
    new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(8388608))),
    new ethereum.EventParam("totalFees", ethereum.Value.fromFixedBytes(totalFees)),
    new ethereum.EventParam("protocolFees", ethereum.Value.fromFixedBytes(protocolFees))
  ];
  return event;
}

function createSwapEvent(): SwapEvent {
  const event = newTypedMockEvent<SwapEvent>();
  event.address = PAIR_ADDRESS;
  event.block.number = BigInt.fromI32(123);
  event.block.timestamp = BigInt.fromI32(456);
  event.transaction.hash = TRANSACTION_HASH;
  event.transaction.from = TRANSACTION_FROM;
  event.logIndex = BigInt.fromI32(0);
  event.parameters = [
    new ethereum.EventParam("sender", ethereum.Value.fromAddress(SENDER)),
    new ethereum.EventParam("to", ethereum.Value.fromAddress(TRANSACTION_FROM)),
    new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(8388608))),
    new ethereum.EventParam("amountsIn", ethereum.Value.fromFixedBytes(X_SEVEN)),
    new ethereum.EventParam("amountsOut", ethereum.Value.fromFixedBytes(Y_NINE)),
    new ethereum.EventParam("volatilityAccumulator", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1))),
    new ethereum.EventParam("totalFees", ethereum.Value.fromFixedBytes(ZERO_PACKED)),
    new ethereum.EventParam("protocolFees", ethereum.Value.fromFixedBytes(ZERO_PACKED))
  ];
  return event;
}

function mockPairReserves(): void {
  createMockedFunction(PAIR_ADDRESS, "getReserves", "getReserves():(uint128,uint128)")
    .withArgs([])
    .returns([
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1000)),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2000))
    ]);
  createMockedFunction(PAIR_ADDRESS, "getBin", "getBin(uint24):(uint128,uint128)")
    .withArgs([ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(8388608))])
    .returns([
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(100)),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(200))
    ]);
}
