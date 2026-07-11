import { ethereum } from "@graphprotocol/graph-ts";

export function eventId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

export function pairBinId(pair: string, binId: string): string {
  return pair + "-" + binId;
}

export function positionId(pair: string, owner: string, binId: string): string {
  return pair + "-" + owner + "-" + binId;
}
