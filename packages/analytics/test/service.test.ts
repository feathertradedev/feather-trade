import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  AnalyticsApiService,
  AnalyticsEngine,
  CandleStreamHub,
  USD_SCALE,
  startAnalyticsHttpServer,
  type AnalyticsStateStore,
  type BlockSubmission,
  type PoolStateUpdate,
  type PricePolicy
} from "../src/index.js";

const PAIR = "0x00000000000000000000000000000000000000a1";
const TOKEN_X = "0x00000000000000000000000000000000000000b1";
const TOKEN_Y = "0x00000000000000000000000000000000000000c1";
const ACTIVE_ID = 8_388_608;
const policies: PricePolicy[] = [
  { token: TOKEN_X, source: "fixed-test", feedId: "x-usd", maxAgeSeconds: 300, maxConfidenceBps: 100 },
  { token: TOKEN_Y, source: "fixed-test", feedId: "y-usd", maxAgeSeconds: 300, maxConfidenceBps: 100 }
];

test("requires independent verification for on-chain Data Feeds without pretending they are signed reports", async () => {
  const token = "0x00000000000000000000000000000000000000d1";
  const feedId = "0x00000000000000000000000000000000000000e1";
  const dataFeedPolicies: PricePolicy[] = [{
    token,
    source: "chainlink-data-feeds",
    feedId,
    maxAgeSeconds: 300,
    maxConfidenceBps: 0,
    feedDecimals: 8,
    feedDescription: "TEST / USD"
  }];
  const submission: BlockSubmission = {
    chainId: 11_155_111,
    number: 1n,
    hash: hash(1),
    parentHash: hash(0),
    timestamp: 100,
    events: [],
    prices: [{
      token,
      source: "chainlink-data-feeds",
      feedId,
      priceUsdE18: 2n * USD_SCALE,
      confidenceUsdE18: 0n,
      observedAt: 100,
      sequence: 7n,
      signedReport: null
    }]
  };
  const verifier = {
    verify: async (price: BlockSubmission["prices"][number]) => {
      const { signedReport: _signedReport, ...sample } = price;
      return { ...sample, verifiedBy: "canonical-chainlink-data-feed-test" };
    }
  };
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(dataFeedPolicies),
    priceVerifier: verifier
  });
  await service.ingestBlock(submission);
  assert.deepEqual(service.getHealth(100).prices, [{
    token: token.toLowerCase(),
    source: "chainlink-data-feeds",
    feedId: feedId.toLowerCase(),
    status: "available",
    observedAt: 100,
    ageSeconds: 0
  }]);

  const missingVerifier = await AnalyticsApiService.create({ engine: new AnalyticsEngine(dataFeedPolicies) });
  await assert.rejects(() => missingVerifier.ingestBlock(submission), /price verifier is not configured/);

  const streamsPolicy: PricePolicy[] = [{
    token,
    source: "chainlink-data-streams",
    feedId: "stream-id",
    maxAgeSeconds: 300,
    maxConfidenceBps: 100
  }];
  const streamsService = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(streamsPolicy),
    priceVerifier: verifier
  });
  await assert.rejects(
    () => streamsService.ingestBlock({
      ...submission,
      prices: [{ ...submission.prices[0]!, source: "chainlink-data-streams", feedId: "stream-id" }]
    }),
    /Signed Chainlink report is required/
  );
});

test("rejects reused fragment DAGs within a deterministic traversal budget", async () => {
  const service = await AnalyticsApiService.create({ engine: new AnalyticsEngine(policies) });
  const fragments = ["fragment Chain0 on Query { analyticsHealth { status } }"];
  for (let index = 1; index <= 40; index += 1) {
    fragments.push(`fragment Chain${index} on Query { ...Chain${index - 1} }`);
  }
  fragments.push("fragment Dag0 on Query { ...Chain40 }");
  for (let index = 1; index <= 16; index += 1) {
    fragments.push(`fragment Dag${index} on Query { ...Dag${index - 1} ...Dag${index - 1} }`);
  }
  const source = `query { ...Dag16 }\n${fragments.join("\n")}`;

  const started = performance.now();
  const rejected = await service.execute(source);
  const elapsedMs = performance.now() - started;
  assert.match(rejected.errors?.[0]?.message ?? "", /GraphQL traversal limit is 256/);
  assert(elapsedMs < 500, `fragment DAG rejection took ${elapsedMs.toFixed(1)}ms`);

  const health = await service.execute("{ analyticsHealth { status } }");
  assert.equal(health.errors, undefined);
});

test("shares one cursor while bounding candle and pool replay independently", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(verifiedBlock(1, hash(1), hash(0), 60));
  const candle = engine.listCandles().find((row) => row.interval === "minute")!;
  const update = engine.listLastChangedPoolUpdates()[0]!;
  const stream = new CandleStreamHub(2);

  const candleEvent = stream.publishCandle(candle);
  for (let revision = 1; revision <= 10; revision += 1) {
    stream.publishPoolState(withRevision(update, revision));
  }

  assert.deepEqual(
    stream.replay("0", PAIR, "minute")?.map((event) => event.cursor),
    [candleEvent.cursor],
    "pool traffic must not evict the candle topic"
  );
  assert.equal(stream.replayPool("0", PAIR), null, "the independently bounded pool topic expires old cursors");
  assert.deepEqual(stream.replayPool("9", PAIR)?.map((event) => event.cursor), ["10", "11"]);
});

test("bounds replay globally across independently fair topics", () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  engine.ingestBlock(verifiedBlock(1, hash(1), hash(0), 60));
  const candle = engine.listCandles().find((row) => row.interval === "minute")!;
  const stream = new CandleStreamHub(4, 5);
  const pairs = Array.from({ length: 7 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`);
  const published = pairs.map((pair) => stream.publishCandle({ ...candle, pair }));

  assert.equal(stream.retainedEventCount, 5);
  assert.equal(stream.retainedTopicCount, 5);
  assert.equal(stream.replay("0", pairs.at(-1)!, "minute"), null, "an evicted global cursor must reset every topic safely");
  assert.deepEqual(stream.replay("2", pairs.at(-1)!, "minute")?.map((event) => event.cursor), ["7"]);

  const restored = new CandleStreamHub(4, 5);
  restored.restore(published.slice(-5));
  assert.equal(restored.cursor, "7");
  assert.equal(restored.retainedEventCount, 5);
  assert.equal(restored.replay("0", pairs.at(-1)!, "minute"), null, "restart must preserve the global reset floor");

  const overfullRestore = new CandleStreamHub(10, 5);
  overfullRestore.restore(published.map((event) => ({
    ...event,
    cursor: String(Number(event.cursor) + 2)
  })));
  assert.equal(overfullRestore.retainedEventCount, 5);
  assert.equal(
    overfullRestore.replay("3", `0x${"f".repeat(40)}`, "minute"),
    null,
    "restoring more than the global bound must not lower the eviction floor"
  );
});

test("serves pool bootstrap and replay, closes bad cursors, and exposes stream metrics", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  const first = submission(1, hash(1), hash(0), 60);
  assert.equal(await service.ingestBlock(first), "appended");
  const cursor = service.candleStream.cursor;
  assert.notEqual(cursor, "0");
  assert.equal(await service.ingestBlock(first), "duplicate");
  assert.equal(service.candleStream.cursor, cursor, "duplicate delivery cannot allocate another cursor");

  const query = await service.execute(`query($pair: ID!) {
    poolState(pair: $pair, radius: 1) {
      streamCursor
      state { chainId pair activeId reserveX asOfBlock revision feeState { static { baseFactor } } }
      bins { binId reserveX reserveY revision }
    }
  }`, { pair: PAIR });
  assert.equal(query.errors, undefined);
  const bootstrap = query.data?.poolState as {
    streamCursor: string;
    state: { chainId: number; pair: string; activeId: number; reserveX: string; asOfBlock: string; revision: number };
    bins: Array<{ binId: string; reserveX: string; reserveY: string; revision: number }>;
  };
  assert.equal(bootstrap.streamCursor, cursor);
  assert.equal(bootstrap.state.chainId, 31_337);
  assert.equal(bootstrap.state.pair, PAIR);
  assert.equal(bootstrap.state.activeId, ACTIVE_ID);
  assert.deepEqual(bootstrap.bins.map((bin) => bin.binId), [String(ACTIVE_ID - 1), String(ACTIVE_ID), String(ACTIVE_ID + 1)]);

  const server = await startAnalyticsHttpServer({ service, host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const replay = await firstSseEvent(`${base}/events/pools?pair=${PAIR}&after=0`, "pool-state");
    assert.equal(replay.event, "pool-state");
    assert.equal((replay.data.update as { state: { pair: string } }).state.pair, PAIR);

    const invalid = await fetch(`${base}/events/pools?pair=${PAIR}`, {
      headers: { "last-event-id": String(Number(cursor) + 10) }
    });
    assert.equal(invalid.status, 200);
    const invalidBody = await invalid.text();
    assert.equal((invalidBody.match(/event: reset/g) ?? []).length, 1);
    assert.match(invalidBody, /stream-cursor-expired/);
    assert.equal(service.candleStream.subscriberCount, 0, "invalid cursors never remain subscribed");

    const slowResponse = await fetch(`${base}/events/pools?pair=${PAIR}&after=${service.candleStream.cursor}`);
    assert.equal(slowResponse.status, 200);
    await waitFor(() => service.candleStream.subscriberCount === 1);
    const baseUpdate = service.candleStream.replayPool("0", PAIR)
      ?.find((event) => event.type === "pool-state")?.update;
    assert(baseUpdate);
    for (let revision = 10; revision < 2_010; revision += 1) {
      service.candleStream.publishPoolState(withRevision(baseUpdate, revision));
    }
    await waitFor(() => service.candleStream.subscriberCount === 0);
    await slowResponse.body?.cancel();

    const metrics = await (await fetch(`${base}/metrics`)).text();
    assert.match(metrics, /feather_analytics_ingest_lag_seconds/);
    assert.match(metrics, /feather_analytics_delivery_lag_seconds/);
    assert.match(metrics, /feather_analytics_stream_reconnects_total 1/);
    assert.match(metrics, /feather_analytics_stream_drops_total\{reason="cursor-invalid-or-expired"\} 1/);
    assert.match(metrics, /feather_analytics_stream_drops_total\{reason="backpressure"\} 1/);
    assert.match(metrics, /feather_analytics_stream_subscribers 0/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("caps SSE by socket IP and trusts forwarded clients only when explicitly enabled", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  await service.ingestBlock(submission(1, hash(1), hash(0), 60));
  const direct = await startAnalyticsHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    maxStreamsPerIp: 1
  });
  const directBase = `http://127.0.0.1:${(direct.address() as AddressInfo).port}`;
  try {
    const first = await fetch(`${directBase}/events/pools?pair=${PAIR}&after=${service.candleStream.cursor}`, {
      headers: { "x-forwarded-for": "198.51.100.10" }
    });
    assert.equal(first.status, 200);
    await waitFor(() => service.candleStream.subscriberCount === 1);
    const spoofed = await fetch(`${directBase}/events/pools?pair=${PAIR}&after=${service.candleStream.cursor}`, {
      headers: { "x-forwarded-for": "198.51.100.11" }
    });
    assert.equal(spoofed.status, 429, "direct clients cannot evade quotas with X-Forwarded-For");
    await first.body?.cancel();
    await waitFor(() => service.candleStream.subscriberCount === 0);
  } finally {
    await new Promise<void>((resolve, reject) => direct.close((error) => error ? reject(error) : resolve()));
  }

  const proxied = await startAnalyticsHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    maxStreamsPerIp: 1,
    trustProxy: true
  });
  const proxiedBase = `http://127.0.0.1:${(proxied.address() as AddressInfo).port}`;
  try {
    const first = await fetch(`${proxiedBase}/events/pools?pair=${PAIR}&after=${service.candleStream.cursor}`, {
      headers: { "x-forwarded-for": "198.51.100.10" }
    });
    const second = await fetch(`${proxiedBase}/events/pools?pair=${PAIR}&after=${service.candleStream.cursor}`, {
      headers: { "x-forwarded-for": "198.51.100.11" }
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    await waitFor(() => service.candleStream.subscriberCount === 2);
    await Promise.all([first.body?.cancel(), second.body?.cancel()]);
    await waitFor(() => service.candleStream.subscriberCount === 0);
  } finally {
    await new Promise<void>((resolve, reject) => proxied.close((error) => error ? reject(error) : resolve()));
  }
});

test("normalizes IPv6 /64 and mapped IPv4 identities for GraphQL rate buckets", async () => {
  const service = await AnalyticsApiService.create({ engine: new AnalyticsEngine(policies) });
  const server = await startAnalyticsHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    trustProxy: true,
    graphqlRequestsPerMinute: 1,
    graphqlRateLimitClients: 10
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const query = (client: string) => fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": client },
      body: JSON.stringify({ query: "{ analyticsHealth { status } }" })
    });
    assert.equal((await query("2001:db8:10:20::1")).status, 200);
    assert.equal((await query("2001:db8:10:20:ffff::2")).status, 429, "one routed /64 shares a bucket");
    assert.equal((await query("2001:db8:10:21::1")).status, 200, "a distinct /64 keeps an independent bucket");
    assert.equal((await query("203.0.113.9")).status, 200);
    assert.equal((await query("::ffff:203.0.113.9")).status, 429, "mapped IPv4 must match its IPv4 identity");
    assert.equal((await query("0:0:0:0:0:ffff:cb00:7109")).status, 429, "expanded mapped IPv4 must also match");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("shares concurrent SSE quota within an IPv6 /64 but not across /64s", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  await service.ingestBlock(submission(1, hash(1), hash(0), 60));
  const server = await startAnalyticsHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    trustProxy: true,
    maxStreamsPerIp: 1
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = `${base}/events/pools?pair=${PAIR}&after=${service.candleStream.cursor}`;
    const first = await fetch(url, { headers: { "x-forwarded-for": "2001:db8:20:30::1" } });
    assert.equal(first.status, 200);
    await waitFor(() => service.candleStream.subscriberCount === 1);
    const samePrefix = await fetch(url, { headers: { "x-forwarded-for": "2001:db8:20:30:abcd::2" } });
    assert.equal(samePrefix.status, 429);
    const otherPrefix = await fetch(url, { headers: { "x-forwarded-for": "2001:db8:20:31::1" } });
    assert.equal(otherPrefix.status, 200);
    await waitFor(() => service.candleStream.subscriberCount === 2);
    await Promise.all([first.body?.cancel(), otherPrefix.body?.cancel()]);
    await waitFor(() => service.candleStream.subscriberCount === 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("resets oversized SSE replay and rate-limits repeated reconnect serialization", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  await service.ingestBlock(submission(1, hash(1), hash(0), 60));
  const after = service.candleStream.cursor;
  const update = service.candleStream.replayPool("0", PAIR)
    ?.find((event) => event.type === "pool-state")?.update;
  assert(update);
  for (let revision = 1; revision <= 300; revision += 1) {
    service.candleStream.publishPoolState(withRevision(update, revision));
  }
  const server = await startAnalyticsHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    trustProxy: true
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = `${base}/events/pools?pair=${PAIR}&after=${after}`;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(url, {
        headers: { "x-forwarded-for": `2001:db8:30:40::${attempt + 1}` }
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /event: reset/);
      assert.match(body, /stream-replay-limit/);
      assert.doesNotMatch(body, /event: pool-state/);
    }
    const limited = await fetch(url, { headers: { "x-forwarded-for": "2001:db8:30:40::ffff" } });
    assert.equal(limited.status, 429);
    assert.match(await limited.text(), /connection rate limit exceeded/i);

    const independent = await fetch(url, { headers: { "x-forwarded-for": "2001:db8:30:41::1" } });
    assert.equal(independent.status, 200);
    assert.match(await independent.text(), /stream-replay-limit/);
    assert.equal(service.candleStream.subscriberCount, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("publishes a reset instead of orphaned pool replacements after a reorg", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  await service.ingestBlock(submission(1, hash(1), hash(0), 60));
  const before = service.candleStream.cursor;
  await service.ingestBlock(submission(2, hash(2), hash(1), 120));
  const orphanCursor = service.candleStream.cursor;
  assert.equal(await service.ingestBlock(submission(2, hash(3), hash(1), 121)), "reorg");

  const events = service.candleStream.replayPool(orphanCursor, PAIR);
  assert.deepEqual(events?.map((event) => event.type), ["reset"]);
  assert.equal(events?.[0]?.reason, "canonical-reorg");
  assert(Number(service.candleStream.cursor) > Number(before));
  assert.match(service.renderMetrics(121), /feather_analytics_rebuilds_total 1/);
});

test("rewinds a pure head rollback durably and publishes one reset", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  await service.ingestBlock(submission(1, hash(1), hash(0), 60));
  await service.ingestBlock(submission(2, hash(2), hash(1), 120));
  await service.ingestBlock(submission(3, hash(3), hash(2), 180));
  const orphanCursor = service.candleStream.cursor;

  assert.equal(await service.reconcileCanonicalHead({ number: 2n, hash: hash(2), timestamp: 120 }), "reorg");
  assert.deepEqual(
    service.candleStream.replayPool(orphanCursor, PAIR)?.map((event) => [event.type, event.reason]),
    [["reset", "canonical-reorg"]]
  );
  const result = await service.execute(`query($pair: ID!) {
    poolState(pair: $pair, radius: 2) { streamCursor state { activeId asOfBlock asOfBlockHash } }
  }`, { pair: PAIR });
  assert.equal(result.errors, undefined);
  const snapshot = result.data?.poolState as {
    streamCursor: string;
    state: { activeId: number; asOfBlock: string; asOfBlockHash: string };
  };
  assert.equal(snapshot.streamCursor, service.candleStream.cursor);
  assert.equal(snapshot.state.activeId, ACTIVE_ID + 1);
  assert.equal(snapshot.state.asOfBlock, "2");
  assert.equal(snapshot.state.asOfBlockHash, hash(2));
  assert.match(service.renderMetrics(120), /feather_analytics_rebuilds_total 1/);
});

test("completed source head attestation trims a persisted orphan suffix after restart", async () => {
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true
  });
  await service.ingestBlock(submission(1, hash(1), hash(0), 60));
  await service.ingestBlock(submission(2, hash(2), hash(1), 120));
  await service.ingestBlock(submission(3, hash(3), hash(2), 180));
  const orphanCursor = service.candleStream.cursor;

  await service.backfill(async () => ({
    blocks: [submission(1, hash(1), hash(0), 60), submission(2, hash(2), hash(1), 120)],
    canonicalHead: { number: 2n, hash: hash(2), timestamp: 120 },
    nextCursor: "3",
    hasMore: false
  }));
  assert.equal(service.getHealth(120).headBlock, 2n);
  assert.deepEqual(service.candleStream.replayPool(orphanCursor, PAIR)?.map((event) => event.type), ["reset"]);
});

test("pool bootstrap waits for its canonical state and cursor to commit", async () => {
  let entered!: () => void;
  let release!: () => void;
  const persistenceEntered = new Promise<void>((resolve) => { entered = resolve; });
  const persistenceReleased = new Promise<void>((resolve) => { release = resolve; });
  const store: AnalyticsStateStore = {
    load: async () => null,
    save: async () => undefined,
    loadCandleEvents: async () => [],
    appendCanonicalStateAndCandleEvents: async () => {
      entered();
      await persistenceReleased;
    }
  };
  const service = await AnalyticsApiService.create({
    engine: new AnalyticsEngine(policies, { assumeCompleteHistory: true }),
    allowFixedTestPrices: true,
    store
  });
  const ingest = service.ingestBlock(submission(1, hash(1), hash(0), 60));
  await persistenceEntered;

  let querySettled = false;
  const query = service.execute(`query($pair: ID!) {
    poolState(pair: $pair, radius: 1) { streamCursor state { asOfBlock } }
  }`, { pair: PAIR }).finally(() => { querySettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(querySettled, false, "bootstrap cannot observe the engine while persistence is pending");

  release();
  await ingest;
  const result = await query;
  assert.equal(result.errors, undefined);
  const snapshot = result.data?.poolState as { streamCursor: string; state: { asOfBlock: string } };
  assert.equal(snapshot.state.asOfBlock, "1");
  assert.equal(snapshot.streamCursor, service.candleStream.cursor);
  assert.notEqual(snapshot.streamCursor, "0");
});

test("bounds full backfill pool replacements to the active display window", async () => {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  const service = await AnalyticsApiService.create({ engine, allowFixedTestPrices: true });
  const blocks = Array.from({ length: 120 }, (_, index) => {
    const number = index + 1;
    return submission(number, hash(number), hash(number - 1), number * 60);
  });
  await service.backfill(async () => ({ blocks, nextCursor: "121", hasMore: false }));
  assert((engine.listPoolStates()[0]?.bins.length ?? 0) > 81, "canonical persistence retains the observed bin history");

  const update = service.candleStream.replayPool("0", PAIR)
    ?.find((event) => event.type === "pool-state")?.update;
  assert(update);
  assert.equal(update.replaceBinWindow, true);
  assert(update.binReplacements.length <= 81);
  const minimum = BigInt(update.state.activeId - 40);
  const maximum = BigInt(update.state.activeId + 40);
  assert(update.binReplacements.every((bin) => BigInt(bin.binId) >= minimum && BigInt(bin.binId) <= maximum));
});

function submission(
  number: number,
  blockHash: `0x${string}`,
  parentHash: `0x${string}`,
  timestamp: number
): BlockSubmission {
  const block = verifiedBlock(number, blockHash, parentHash, timestamp);
  return {
    ...block,
    prices: block.prices.map(({ verifiedBy: _verifiedBy, ...price }) => ({
      ...price,
      source: "fixed-test" as const,
      signedReport: null
    }))
  };
}

function verifiedBlock(
  number: number,
  blockHash: `0x${string}`,
  parentHash: `0x${string}`,
  timestamp: number
) {
  const activeId = ACTIVE_ID + number - 1;
  return {
    chainId: 31_337,
    number: BigInt(number),
    hash: blockHash,
    parentHash,
    timestamp,
    prices: [
      fixedPrice(TOKEN_X, "x-usd", 2_000n * USD_SCALE, timestamp, BigInt(number)),
      fixedPrice(TOKEN_Y, "y-usd", USD_SCALE, timestamp, BigInt(number))
    ],
    events: [{
      kind: "pair-snapshot" as const,
      pair: PAIR,
      tokenX: TOKEN_X,
      tokenY: TOKEN_Y,
      decimalsX: 18,
      decimalsY: 6,
      reserveX: 100n * 10n ** 18n,
      reserveY: 200_000n * 10n ** 6n,
      activeId,
      binStep: 10,
      marketPriceQuoteE18: 2_000n * USD_SCALE,
      source: {
        eventId: `snapshot:${number}`,
        transactionHash: null,
        logIndex: null,
        sequence: 0,
        kind: "block-snapshot" as const
      },
      poolState: {
        feeState: {
          static: {
            baseFactor: 25n,
            filterPeriod: 30n,
            decayPeriod: 120n,
            reductionFactor: 5_000n,
            variableFeeControl: 40_000n,
            protocolShare: 1_000n,
            maxVolatilityAccumulator: 350_000n
          },
          variable: {
            volatilityAccumulator: BigInt(number),
            volatilityReference: 0n,
            idReference: BigInt(activeId),
            timeOfLastUpdate: BigInt(timestamp)
          }
        },
        binUpdates: [-1, 0, 1].map((offset) => ({
          binId: String(activeId + offset),
          reserveX: BigInt(10 + offset + number),
          reserveY: BigInt(20 - offset + number),
          totalSupply: 100n
        })),
        sourceEventIds: [`snapshot:${number}`],
        replaceBinWindow: number === 1
      }
    }]
  };
}

function fixedPrice(token: string, feedId: string, priceUsdE18: bigint, observedAt: number, sequence: bigint) {
  return {
    token,
    source: "fixed-test" as const,
    feedId,
    priceUsdE18,
    confidenceUsdE18: 0n,
    observedAt,
    sequence,
    verifiedBy: "service-test"
  };
}

function withRevision(update: PoolStateUpdate, revision: number): PoolStateUpdate {
  return {
    ...structuredClone(update),
    eventId: `${update.eventId}:${revision}`,
    state: { ...structuredClone(update.state), revision }
  };
}

async function firstSseEvent(url: string, eventName: string): Promise<{ event: string; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`SSE stream ended before ${eventName}`);
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (event === eventName && data !== undefined) return { event, data: JSON.parse(data) };
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    controller.abort();
  }
}

function hash(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for service test condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
