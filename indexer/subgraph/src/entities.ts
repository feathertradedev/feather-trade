import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";

import { Activity, Bin, Factory, Pair, Position, Token } from "../generated/schema";
import { ZERO_BI } from "./constants";
import { pairBinId, positionId } from "./id";

export function getOrCreateFactory(address: Address, event: ethereum.Event): Factory {
  const id = address.toHexString();
  let factory = Factory.load(id);

  if (factory == null) {
    factory = new Factory(id);
    factory.address = address;
    factory.pairCount = ZERO_BI;
    factory.quoteAssetCount = ZERO_BI;
    factory.presetCount = ZERO_BI;
    factory.createdAtBlock = event.block.number;
  }

  factory.updatedAtBlock = event.block.number;
  factory.save();

  return factory;
}

export function getOrCreateToken(address: Address, event: ethereum.Event): Token {
  const id = address.toHexString();
  let token = Token.load(id);

  if (token == null) {
    token = new Token(id);
    token.address = address;
    token.pairCount = ZERO_BI;
    token.isQuoteAsset = false;
    token.createdAtBlock = event.block.number;
  }

  token.updatedAtBlock = event.block.number;
  token.save();

  return token;
}

export function getOrCreateBin(pair: Pair, id: BigInt, event: ethereum.Event): Bin {
  const entityId = pairBinId(pair.id, id.toString());
  let bin = Bin.load(entityId);

  if (bin == null) {
    bin = new Bin(entityId);
    bin.pair = pair.id;
    bin.binId = id;
    bin.totalSupply = ZERO_BI;
    bin.reserveX = ZERO_BI;
    bin.reserveY = ZERO_BI;
    bin.createdAtBlock = event.block.number;
  }

  bin.updatedAtBlock = event.block.number;
  bin.save();

  return bin;
}

export function getOrCreatePosition(pair: Pair, owner: Bytes, bin: Bin, event: ethereum.Event): Position {
  const id = positionId(pair.id, owner.toHexString(), bin.binId.toString());
  let position = Position.load(id);

  if (position == null) {
    position = new Position(id);
    position.pair = pair.id;
    position.owner = owner;
    position.bin = bin.id;
    position.liquidity = ZERO_BI;
  }

  position.updatedAtBlock = event.block.number;
  position.save();

  return position;
}

export function saveActivity(
  event: ethereum.Event,
  type: string,
  pair: Pair | null = null,
  account: Bytes | null = null
): void {
  const activity = new Activity(event.transaction.hash.toHexString() + "-" + event.logIndex.toString() + "-" + type);
  activity.type = type;
  activity.pair = pair == null ? null : pair.id;
  activity.account = account;
  activity.blockNumber = event.block.number;
  activity.timestamp = event.block.timestamp;
  activity.transactionHash = event.transaction.hash;
  activity.save();
}
