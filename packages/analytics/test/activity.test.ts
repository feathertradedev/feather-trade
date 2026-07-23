import assert from "node:assert/strict";
import test from "node:test";

import {
  AnalyticsApiService,
  AnalyticsEngine,
  type AnalyticsEvent,
  type BlockEnvelope,
  type PairIdentity
} from "../src/index.js";

const PAIR = "0x00000000000000000000000000000000000000a1";
const OTHER_PAIR = "0x00000000000000000000000000000000000000a2";
const TOKEN_X = "0x00000000000000000000000000000000000000b1";
const TOKEN_Y = "0x00000000000000000000000000000000000000b2";
const OWNER = "0x00000000000000000000000000000000000000c1";
const RECIPIENT = "0x00000000000000000000000000000000000000c2";
const UNIT = 10n ** 18n;

test("serves canonical pool activity with bounded owner-scoped pagination", () => {
  const engine = populatedEngine();

  const first = engine.queryPoolActivity({ pair: PAIR.toUpperCase().replace("0X", "0x"), first: 2 });
  assert.deepEqual(first.nodes.map((event) => event.kind), ["withdraw", "position-transfer"]);
  assert.equal(first.pageInfo.hasNextPage, true);
  assert.equal(first.pageInfo.partial, false);
  assert.equal(first.asOfBlock, 3n);
  assert.equal(first.asOfBlockHash, hash("3"));
  assert.match(first.nodes[0]!.id, new RegExp(`^${hash("3")}:`));

  const second = engine.queryPoolActivity({
    pair: PAIR,
    first: 2,
    after: first.pageInfo.endCursor
  });
  assert.deepEqual(second.nodes.map((event) => event.kind), ["position-transfer", "deposit"]);
  assert.equal(second.pageInfo.hasNextPage, true);
  const third = engine.queryPoolActivity({
    pair: PAIR,
    first: 2,
    after: second.pageInfo.endCursor
  });
  assert.deepEqual(third.nodes.map((event) => event.kind), ["swap"]);
  assert.equal(third.pageInfo.hasNextPage, false);

  const owner = engine.queryPoolActivity({ pair: PAIR, owner: OWNER, first: 100 });
  assert.deepEqual(
    owner.nodes.map((event) => event.kind),
    ["withdraw", "position-transfer", "position-transfer", "deposit"]
  );
  assert(owner.nodes.every((event) =>
    event.owner === OWNER || event.from === OWNER || event.to === OWNER
  ));
  assert.equal(owner.nodes.find((event) => event.kind === "deposit")?.amountX, 10n * UNIT);
  assert.deepEqual(owner.nodes.find((event) => event.kind === "deposit")?.binIds, ["1"]);

  const recipient = engine.queryPoolActivity({ pair: PAIR, owner: RECIPIENT, first: 100 });
  assert.deepEqual(recipient.nodes.map((event) => event.kind), ["position-transfer", "position-transfer"]);
  assert.equal(engine.queryPoolActivity({ pair: OTHER_PAIR, first: 100 }).nodes.length, 0);
  assert.throws(
    () => engine.queryPoolActivity({ pair: "not-an-address", first: 1 }),
    /canonical EVM address/
  );
});

test("reorgs replace orphaned activity and expire pagination cursors", () => {
  const engine = populatedEngine();
  const before = engine.queryPoolActivity({ pair: PAIR, first: 1 });
  assert.equal(before.nodes[0]?.kind, "withdraw");
  const orphanId = before.nodes[0]!.id;

  assert.equal(engine.ingestBlock(block(
    3n,
    hash("4"),
    hash("2"),
    1_020,
    [swap("replacement-swap", "4", 2n * UNIT)]
  )), "reorg");
  const after = engine.queryPoolActivity({ pair: PAIR, first: 10 });
  assert.equal(after.nodes.some((event) => event.id === orphanId), false);
  assert.equal(after.nodes[0]?.kind, "swap");
  assert.equal(after.nodes[0]?.blockHash, hash("4"));
  assert.throws(
    () => engine.queryPoolActivity({ pair: PAIR, first: 1, after: before.pageInfo.endCursor }),
    /Cursor expired or invalid/
  );
});

test("GraphQL activity rows preserve canonical identity and nullable log fields", async () => {
  const service = await AnalyticsApiService.create({ engine: populatedEngine() });
  const result = await service.execute(
    `query Activity($pair: ID!, $owner: ID!, $first: Int!) {
      poolActivity(pair: $pair, owner: $owner, first: $first) {
        nodes {
          id pair kind owner from to amountX amountY binIds blockNumber blockHash
          transactionHash logIndex sequence timestamp revision
        }
        pageInfo { endCursor hasNextPage partial }
        asOfBlock
        asOfBlockHash
      }
    }`,
    { pair: PAIR, owner: OWNER, first: 100 }
  );
  assert.equal(result.errors, undefined);
  const connection = (result.data as {
    poolActivity: {
      nodes: Array<Record<string, unknown>>;
      asOfBlock: string;
      asOfBlockHash: string;
      pageInfo: { partial: boolean };
    };
  }).poolActivity;
  assert.equal(connection.asOfBlock, "3");
  assert.equal(connection.asOfBlockHash, hash("3"));
  assert.equal(connection.pageInfo.partial, false);
  assert.deepEqual(
    connection.nodes.map((event) => event.kind),
    ["WITHDRAW", "POSITION_TRANSFER", "POSITION_TRANSFER", "DEPOSIT"]
  );
  assert.equal(connection.nodes[0]?.blockNumber, "3");
  assert.equal(connection.nodes[0]?.revision, 1);
  assert.equal(connection.nodes[0]?.transactionHash, txHash("6"));
});

test("incomplete retained history is exposed as partial instead of unavailable", () => {
  const engine = new AnalyticsEngine([]);
  engine.ingestBlock(block(1n, hash("a"), hash("0"), 1_000, [pairSnapshot()]));
  const page = engine.queryPoolActivity({ pair: PAIR, first: 10 });
  assert.equal(page.nodes.length, 0);
  assert.equal(page.pageInfo.partial, true);
});

function populatedEngine(): AnalyticsEngine {
  const engine = new AnalyticsEngine([], { assumeCompleteHistory: true });
  engine.ingestBlock(block(1n, hash("1"), hash("0"), 1_000, [pairSnapshot()]));
  engine.ingestBlock(block(2n, hash("2"), hash("1"), 1_010, [
    swap("swap-1", "1", 5n * UNIT),
    deposit("deposit-1", "2"),
    transfer("transfer-1", "3", OWNER, RECIPIENT),
    transfer("transfer-2", "4", RECIPIENT, OWNER)
  ]));
  engine.ingestBlock(block(3n, hash("3"), hash("2"), 1_020, [withdraw("withdraw-1", "6")]));
  return engine;
}

function identity(): PairIdentity {
  return { pair: PAIR, tokenX: TOKEN_X, tokenY: TOKEN_Y, decimalsX: 18, decimalsY: 18 };
}

function pairSnapshot(): AnalyticsEvent {
  return { ...identity(), kind: "pair-snapshot", reserveX: 100n * UNIT, reserveY: 100n * UNIT };
}

function swap(eventId: string, suffix: string, amountInX: bigint): AnalyticsEvent {
  return {
    ...identity(),
    kind: "swap",
    amountInX,
    amountInY: 0n,
    feeX: 0n,
    feeY: 0n,
    protocolFeeX: 0n,
    protocolFeeY: 0n,
    reserveX: 100n * UNIT,
    reserveY: 100n * UNIT,
    source: source(eventId, suffix)
  };
}

function deposit(eventId: string, suffix: string): AnalyticsEvent {
  return {
    ...identity(),
    kind: "deposit",
    owner: OWNER,
    bins: [{ binId: "1", liquidityDelta: 10n, amountX: 10n * UNIT, amountY: 5n * UNIT }],
    reserveX: 110n * UNIT,
    reserveY: 105n * UNIT,
    source: source(eventId, suffix)
  };
}

function withdraw(eventId: string, suffix: string): AnalyticsEvent {
  return {
    ...identity(),
    kind: "withdraw",
    owner: OWNER,
    bins: [{ binId: "1", liquidityDelta: -2n, amountX: UNIT, amountY: UNIT }],
    reserveX: 109n * UNIT,
    reserveY: 104n * UNIT,
    source: source(eventId, suffix)
  };
}

function transfer(eventId: string, suffix: string, from: string, to: string): AnalyticsEvent {
  return {
    ...identity(),
    kind: "position-transfer",
    from,
    to,
    bins: [{ binId: "1", liquidity: 2n }],
    source: source(eventId, suffix)
  };
}

function source(eventId: string, suffix: string) {
  const index = Number.parseInt(suffix, 16);
  return {
    eventId,
    transactionHash: txHash(suffix),
    logIndex: index,
    sequence: index,
    kind: "log" as const
  };
}

function block(
  number: bigint,
  blockHash: `0x${string}`,
  parentHash: `0x${string}`,
  timestamp: number,
  events: AnalyticsEvent[]
): BlockEnvelope {
  return {
    chainId: 11_155_111,
    number,
    hash: blockHash,
    parentHash,
    timestamp,
    prices: [],
    events
  };
}

function hash(character: string): `0x${string}` {
  return `0x${character.repeat(64)}`;
}

function txHash(character: string): `0x${string}` {
  return `0x${character.repeat(64)}`;
}
