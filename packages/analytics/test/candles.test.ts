import assert from "node:assert/strict";
import test from "node:test";

import {
  AnalyticsEngine,
  CANDLE_INTERVALS,
  USD_SCALE,
  candleBoundary,
  candleIntervalSeconds,
  type AnalyticsEvent,
  type BlockEnvelope,
  type Candle,
  type CandleInterval,
  type PricePolicy
} from "../src/index.js";

const PAIR = "0x00000000000000000000000000000000000000a1";
const FOREIGN_PAIR = "0x00000000000000000000000000000000000000a2";
const TOKEN_X = "0x00000000000000000000000000000000000000b1";
const TOKEN_Y = "0x00000000000000000000000000000000000000c1";
const UNIT = 10n ** 18n;
const MONDAY = 4 * 86_400;

const policies: PricePolicy[] = [
  { token: TOKEN_X, source: "chainlink-data-streams", feedId: "x-usd", maxAgeSeconds: 86_400, maxConfidenceBps: 100 },
  { token: TOKEN_Y, source: "chainlink-data-streams", feedId: "y-usd", maxAgeSeconds: 86_400, maxConfidenceBps: 100 }
];

test("aligns every interval to UTC and weeks to Monday 00:00 UTC", () => {
  const timestamp = MONDAY + 3 * 86_400 + 17 * 3_600 + 23 * 60 + 41;
  const expected: Record<CandleInterval, number> = {
    minute: timestamp - 41,
    "five-minutes": timestamp - 3 * 60 - 41,
    "fifteen-minutes": timestamp - 8 * 60 - 41,
    hour: timestamp - 23 * 60 - 41,
    "four-hours": MONDAY + 3 * 86_400 + 16 * 3_600,
    day: MONDAY + 3 * 86_400,
    week: MONDAY
  };
  for (const interval of CANDLE_INTERVALS) {
    assert.equal(candleBoundary(timestamp, interval), expected[interval], interval);
    assert.equal(candleBoundary(expected[interval], interval), expected[interval], `${interval} is idempotently aligned`);
  }
  assert.equal(candleBoundary(MONDAY - 1, "week"), MONDAY - 7 * 86_400);
  assert.equal(candleBoundary(MONDAY + 7 * 86_400, "week"), MONDAY + 7 * 86_400);
});

test("rollups deterministically match independent recomputation of canonical minute candles", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  const observations = [
    { timestamp: MONDAY + 10, price: 2n, amount: 2n },
    { timestamp: MONDAY + 50, price: 5n, amount: 3n },
    { timestamp: MONDAY + 5 * 60 + 2, price: 3n, amount: 7n },
    { timestamp: MONDAY + 60 * 60 + 4, price: 8n, amount: 11n },
    { timestamp: MONDAY + 24 * 60 * 60 + 8, price: 4n, amount: 13n }
  ];
  let parentHash = hash(0);
  observations.forEach((observation, index) => {
    const blockHash = hash(index + 1);
    engine.ingestBlock(canonicalBlock(BigInt(index + 1), blockHash, parentHash, observation));
    parentHash = blockHash;
  });

  const minutes = queryAll(engine, "minute", MONDAY, MONDAY + 2 * 86_400);
  assert.equal(minutes.length, 4);
  for (const interval of CANDLE_INTERVALS) {
    const actual = queryAll(
      engine,
      interval,
      candleBoundary(MONDAY, interval),
      candleBoundary(MONDAY + 2 * 86_400, interval)
    );
    const expected = recompute(minutes, interval);
    assert.deepEqual(actual.map(comparable), expected.map(comparable), interval);
  }
});

test("propagates missing valuation, latest TVL, canonical bounds, and mutable revisions", () => {
  const engine = new AnalyticsEngine([policies[1]!], { assumeCompleteHistory: true });
  engine.ingestBlock(canonicalBlock(1n, hash(1), hash(0), { timestamp: MONDAY + 10, price: 2n, amount: 2n }));
  engine.ingestBlock({
    ...canonicalBlock(2n, hash(2), hash(1), { timestamp: MONDAY + 70, price: 3n, amount: 4n }),
    prices: [price(TOKEN_Y, USD_SCALE, MONDAY + 70, 2n)],
    events: [swap(PAIR, 3n * USD_SCALE, 4n * UNIT, UNIT / 100n, 0n, 200n * UNIT)]
  });

  const minute = queryAll(engine, "minute", MONDAY + 60, MONDAY + 60)[0]!;
  assert.equal(minute.openUsdE18, 3n * USD_SCALE);
  assert.equal(minute.volumeUsdE18, null);
  assert.equal(minute.feesUsdE18, null);
  assert.equal(minute.tvlUsdE18, 200n * USD_SCALE);
  assert.equal(minute.status, "partial");
  assert.deepEqual(minute.missingPriceTokens, [TOKEN_X]);
  assert.equal(minute.firstBlock, 2n);
  assert.equal(minute.lastBlock, 2n);
  assert.equal(minute.firstBlockHash, hash(2));
  assert.equal(minute.lastBlockHash, hash(2));

  const hour = queryAll(engine, "hour", MONDAY, MONDAY)[0]!;
  assert.equal(hour.volumeUsdE18, null);
  assert.equal(hour.feesUsdE18, null);
  assert.equal(hour.tvlUsdE18, 200n * USD_SCALE);
  assert.deepEqual(hour.missingPriceTokens, [TOKEN_X]);
  assert.equal(hour.firstBlockHash, hash(1));
  assert.equal(hour.lastBlockHash, hash(2));
  assert.equal(hour.revision, queryAll(engine, "minute", MONDAY, MONDAY + 60).reduce((sum, row) => sum + row.revision, 0));
});

test("duplicate delivery is idempotent and reorg rebuilds every dependent interval", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  const first = canonicalBlock(1n, hash(1), hash(0), { timestamp: MONDAY + 10, price: 2n, amount: 2n });
  const orphan = canonicalBlock(2n, hash(2), hash(1), { timestamp: MONDAY + 86_400 + 10, price: 9n, amount: 9n });
  engine.ingestBlock(first);
  engine.ingestBlock(orphan);
  const beforeDuplicate = engine.listCandles();
  assert.equal(engine.ingestBlock(orphan), "duplicate");
  assert.deepEqual(engine.listCandles(), beforeDuplicate);

  const replacement = canonicalBlock(2n, hash(22), hash(1), { timestamp: MONDAY + 86_400 + 10, price: 4n, amount: 5n });
  assert.equal(engine.ingestBlock(replacement), "reorg");
  for (const interval of CANDLE_INTERVALS) {
    const rows = queryAll(
      engine,
      interval,
      candleBoundary(MONDAY, interval),
      candleBoundary(MONDAY + 2 * 86_400, interval)
    );
    assert(rows.length > 0, `${interval} remains queryable`);
    assert(rows.every((row) => row.highUsdE18 !== 9n * USD_SCALE), `${interval} discarded orphaned high`);
    assert(rows.every((row) => row.lastBlockHash !== hash(2)), `${interval} discarded orphaned block hash`);
    assert(rows.some((row) => row.lastBlockHash === hash(22)), `${interval} includes replacement block hash`);
  }
});

test("historical pages stay pair-scoped, aligned, stable, and bounded", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  let parentHash = hash(0);
  for (let index = 0; index < 120; index += 1) {
    const blockHash = hash(index + 1);
    const timestamp = MONDAY + index * 60;
    engine.ingestBlock({
      ...canonicalBlock(BigInt(index + 1), blockHash, parentHash, { timestamp, price: BigInt(2 + index % 3), amount: 1n }),
      events: [
        swap(PAIR, BigInt(2 + index % 3) * USD_SCALE, UNIT, 0n, 100n * UNIT, 200n * UNIT),
        swap(FOREIGN_PAIR, 7n * USD_SCALE, UNIT, 0n, 100n * UNIT, 200n * UNIT)
      ]
    });
    parentHash = blockHash;
  }

  const first = engine.queryCandles({ pair: PAIR, interval: "minute", fromTimestamp: MONDAY, toTimestamp: MONDAY + 119 * 60, first: 100 });
  assert.equal(first.nodes.length, 100);
  assert.equal(first.pageInfo.hasNextPage, true);
  assert(first.nodes.every((row) => row.pair === PAIR && row.startTimestamp % 60 === 0));
  const second = engine.queryCandles({ pair: PAIR, interval: "minute", fromTimestamp: MONDAY, toTimestamp: MONDAY + 119 * 60, first: 100, after: first.pageInfo.endCursor });
  assert.equal(second.nodes.length, 20);
  assert(second.nodes.every((row) => row.pair === PAIR));
  assert.throws(
    () => engine.queryCandles({ pair: PAIR, interval: "minute", fromTimestamp: MONDAY, toTimestamp: MONDAY + 500 * 60, first: 100 }),
    /cannot span more than 500/
  );
  assert.throws(
    () => engine.queryCandles({ pair: PAIR, interval: "minute", fromTimestamp: MONDAY, toTimestamp: MONDAY, first: 101 }),
    /between 1 and 100/
  );
});

function canonicalBlock(
  number: bigint,
  blockHash: `0x${string}`,
  parentHash: `0x${string}`,
  observation: { timestamp: number; price: bigint; amount: bigint }
): BlockEnvelope {
  return {
    number,
    hash: blockHash,
    parentHash,
    timestamp: observation.timestamp,
    prices: [
      price(TOKEN_X, observation.price * USD_SCALE, observation.timestamp, number),
      price(TOKEN_Y, USD_SCALE, observation.timestamp, number)
    ],
    events: [swap(PAIR, observation.price * USD_SCALE, observation.amount * UNIT, observation.amount * UNIT / 100n, 100n * UNIT, 200n * UNIT)]
  };
}

function swap(
  pair: string,
  marketPriceQuoteE18: bigint,
  amountInX: bigint,
  feeX: bigint,
  reserveX: bigint,
  reserveY: bigint
): AnalyticsEvent {
  return {
    kind: "swap",
    pair,
    tokenX: TOKEN_X,
    tokenY: TOKEN_Y,
    decimalsX: 18,
    decimalsY: 18,
    marketPriceQuoteE18,
    activeId: 8_388_608,
    binStep: 10,
    amountInX,
    amountInY: 0n,
    feeX,
    feeY: 0n,
    protocolFeeX: 0n,
    protocolFeeY: 0n,
    reserveX,
    reserveY
  };
}

function price(token: string, priceUsdE18: bigint, observedAt: number, sequence: bigint) {
  return {
    token,
    source: "chainlink-data-streams" as const,
    feedId: token === TOKEN_X ? "x-usd" : "y-usd",
    priceUsdE18,
    confidenceUsdE18: priceUsdE18 / 10_000n,
    observedAt,
    sequence,
    verifiedBy: "deterministic-test"
  };
}

function queryAll(engine: AnalyticsEngine, interval: CandleInterval, fromTimestamp: number, toTimestamp: number): Candle[] {
  const bucketCount = Math.floor(toTimestamp / candleIntervalSeconds(interval)) - Math.floor(fromTimestamp / candleIntervalSeconds(interval)) + 1;
  if (bucketCount > 500) {
    return engine.listCandles().filter((candle) =>
      candle.pair === PAIR &&
      candle.interval === interval &&
      candle.startTimestamp >= fromTimestamp &&
      candle.startTimestamp <= toTimestamp
    );
  }
  const result: Candle[] = [];
  let after: string | null = null;
  do {
    const page = engine.queryCandles({ pair: PAIR, interval, fromTimestamp, toTimestamp, first: 100, after });
    result.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after !== null);
  return result;
}

function recompute(minutes: readonly Candle[], interval: CandleInterval): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const minute of minutes) {
    const boundary = candleBoundary(minute.startTimestamp, interval);
    const group = groups.get(boundary) ?? [];
    group.push(minute);
    groups.set(boundary, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right).map(([startTimestamp, group]) => {
    const ordered = [...group].sort((left, right) => left.startTimestamp - right.startTimestamp);
    const first = ordered[0]!;
    const last = ordered.at(-1)!;
    const highs = ordered.flatMap((row) => row.highUsdE18 === null ? [] : [row.highUsdE18]);
    const lows = ordered.flatMap((row) => row.lowUsdE18 === null ? [] : [row.lowUsdE18]);
    const sources = new Set(ordered.map((row) => row.priceSource));
    return {
      ...first,
      interval,
      startTimestamp,
      endTimestamp: startTimestamp + candleIntervalSeconds(interval),
      openUsdE18: ordered.find((row) => row.openUsdE18 !== null)?.openUsdE18 ?? null,
      highUsdE18: highs.length === 0 ? null : highs.reduce((highest, value) => value > highest ? value : highest),
      lowUsdE18: lows.length === 0 ? null : lows.reduce((lowest, value) => value < lowest ? value : lowest),
      closeUsdE18: [...ordered].reverse().find((row) => row.closeUsdE18 !== null)?.closeUsdE18 ?? null,
      volumeUsdE18: ordered.some((row) => row.volumeUsdE18 === null) ? null : ordered.reduce((sum, row) => sum + row.volumeUsdE18!, 0n),
      feesUsdE18: ordered.some((row) => row.feesUsdE18 === null) ? null : ordered.reduce((sum, row) => sum + row.feesUsdE18!, 0n),
      totalSwapFeesUsdE18: ordered.some((row) => row.totalSwapFeesUsdE18 === null) ? null : ordered.reduce((sum, row) => sum + row.totalSwapFeesUsdE18!, 0n),
      protocolSwapFeesUsdE18: ordered.some((row) => row.protocolSwapFeesUsdE18 === null) ? null : ordered.reduce((sum, row) => sum + row.protocolSwapFeesUsdE18!, 0n),
      lpNetSwapFeesUsdE18: ordered.some((row) => row.lpNetSwapFeesUsdE18 === null) ? null : ordered.reduce((sum, row) => sum + row.lpNetSwapFeesUsdE18!, 0n),
      feeBreakdownComplete: ordered.every((row) => row.feeBreakdownComplete),
      tvlUsdE18: last.tvlUsdE18,
      swapCount: ordered.reduce((sum, row) => sum + row.swapCount, 0),
      status: ordered.some((row) => row.status === "partial") ? "partial" : "ready",
      missingPriceTokens: [...new Set(ordered.flatMap((row) => row.missingPriceTokens))].sort(),
      firstBlock: first.firstBlock,
      lastBlock: last.lastBlock,
      firstBlockHash: first.firstBlockHash,
      lastBlockHash: last.lastBlockHash,
      finalized: last.finalized && last.endTimestamp >= startTimestamp + candleIntervalSeconds(interval),
      revision: ordered.reduce((sum, row) => sum + row.revision, 0),
      priceSource: sources.size === 1 ? first.priceSource : "mixed",
      quoteToken: last.quoteToken
    };
  });
}

function comparable(candle: Candle) {
  return {
    interval: candle.interval,
    startTimestamp: candle.startTimestamp,
    endTimestamp: candle.endTimestamp,
    openUsdE18: candle.openUsdE18,
    highUsdE18: candle.highUsdE18,
    lowUsdE18: candle.lowUsdE18,
    closeUsdE18: candle.closeUsdE18,
    volumeUsdE18: candle.volumeUsdE18,
    feesUsdE18: candle.feesUsdE18,
    totalSwapFeesUsdE18: candle.totalSwapFeesUsdE18,
    protocolSwapFeesUsdE18: candle.protocolSwapFeesUsdE18,
    lpNetSwapFeesUsdE18: candle.lpNetSwapFeesUsdE18,
    feeBreakdownComplete: candle.feeBreakdownComplete,
    tvlUsdE18: candle.tvlUsdE18,
    swapCount: candle.swapCount,
    status: candle.status,
    missingPriceTokens: candle.missingPriceTokens,
    firstBlock: candle.firstBlock,
    lastBlock: candle.lastBlock,
    firstBlockHash: candle.firstBlockHash,
    lastBlockHash: candle.lastBlockHash,
    revision: candle.revision,
    priceSource: candle.priceSource,
    quoteToken: candle.quoteToken
  };
}

function hash(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
