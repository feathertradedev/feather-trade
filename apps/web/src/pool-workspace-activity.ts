import type { Address } from "viem";

import type { CanonicalPoolActivityEvent } from "./analytics-data";
import type {
  ActivityRow,
  PortfolioPositionRow,
  PositionHistoryRow,
  PositionRow
} from "./data";

export function portfolioPositionRows(
  position: PortfolioPositionRow | null,
  walletAddress: string | null,
  poolAddress: string
): PositionRow[] {
  if (position === null || walletAddress === null) return [];
  const owner = walletAddress.toLowerCase();
  const pair = poolAddress.toLowerCase();
  if (position.owner.toLowerCase() !== owner || position.pair.toLowerCase() !== pair) {
    throw new Error("Analytics wallet position does not match the selected owner and pool");
  }
  return position.bins.flatMap((bin) => {
    let liquidity: bigint;
    try {
      liquidity = BigInt(bin.liquidity);
    } catch {
      throw new Error(`Analytics returned invalid position liquidity for bin ${bin.binId}`);
    }
    if (liquidity <= 0n) return [];
    return [{
      id: `${owner}:${pair}:${bin.binId}`,
      owner,
      pair,
      binId: bin.binId,
      liquidity: liquidity.toString(),
      updatedAtBlock: bin.asOfBlock ?? position.asOfBlock ?? "0"
    }];
  });
}

export function canonicalActivityRows(events: readonly CanonicalPoolActivityEvent[]): ActivityRow[] {
  return events.map((event) => ({
    id: event.id,
    type: event.kind,
    transactionHash: event.transactionHash ?? "",
    blockNumber: event.blockNumber,
    timestamp: event.timestamp.toString(),
    amountX: event.amountX,
    amountY: event.amountY,
    account: event.owner ?? event.from ?? event.to,
    pair: event.pair
  }));
}

export function canonicalPositionHistoryRows(
  events: readonly CanonicalPoolActivityEvent[],
  walletAddress: string | null
): PositionHistoryRow[] {
  const owner = walletAddress?.toLowerCase() ?? null;
  return events.flatMap((event) => {
    if (event.kind === "SWAP") return [];
    const type = event.kind === "POSITION_TRANSFER"
      ? owner !== null && event.from === owner && event.to !== owner
        ? "TRANSFER_OUT"
        : owner !== null && event.to === owner && event.from !== owner
          ? "TRANSFER_IN"
          : "TRANSFER"
      : event.kind;
    return [{
      id: event.id,
      type,
      transactionHash: event.transactionHash ?? "",
      blockNumber: event.blockNumber,
      timestamp: event.timestamp.toString(),
      amountX: event.amountX,
      amountY: event.amountY,
      binIds: event.binIds,
      sender: event.owner ?? event.from ?? "",
      to: event.to ?? event.owner ?? ""
    }];
  });
}

export function assertCanonicalActivityScope(
  event: CanonicalPoolActivityEvent,
  pair: Address,
  owner: Address | null
): void {
  if (event.pair !== pair.toLowerCase()) {
    throw new Error(`Canonical activity event belongs to another pool: ${event.pair}`);
  }
  const expectedOwner = owner?.toLowerCase() ?? null;
  if (
    expectedOwner !== null &&
    event.owner !== expectedOwner &&
    event.from !== expectedOwner &&
    event.to !== expectedOwner
  ) {
    throw new Error(`Canonical activity event is unrelated to owner ${expectedOwner}`);
  }
}
