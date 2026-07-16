import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { buildSchema, graphql, isScalarType, type ExecutionResult, type GraphQLSchema } from "graphql";

import { runBackfill, type BackfillResult } from "./backfill.js";
import {
  AnalyticsEngine,
  CanonicalHeadChangedError,
  type AnalyticsCheckpoint,
  type AnalyticsCheckpointMetadata,
  type CanonicalHead
} from "./engine.js";
import type {
  AnalyticsHealth,
  BlockEnvelope,
  BlockSubmission,
  Candle,
  CandleInterval,
  PriceSample,
  PriceSubmission,
  PositionSnapshotEvent,
  WalletPairPosition,
  Connection
} from "./types.js";

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const STREAM_HEARTBEAT_MS = 15_000;
const MAX_STREAM_SUBSCRIBERS = 500;
const DEFAULT_STREAM_REPLAY_SIZE = 2_048;

type GraphqlCandleInterval =
  | "ONE_MINUTE"
  | "FIVE_MINUTES"
  | "FIFTEEN_MINUTES"
  | "HOUR"
  | "FOUR_HOURS"
  | "DAY"
  | "WEEK";

export interface CandleStreamEvent {
  cursor: string;
  type: "candle" | "reset";
  pair: string | null;
  interval: CandleInterval | null;
  candle: Candle | null;
  reason: string | null;
}

export type CandleStreamEventInput = Omit<CandleStreamEvent, "cursor">;

export class AnalyticsCheckpointStore {
  constructor(readonly path: string) {}

  async load(): Promise<AnalyticsCheckpoint | null> {
    try {
      return decodeTaggedJson(await readFile(this.path, "utf8")) as AnalyticsCheckpoint;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(checkpoint: AnalyticsCheckpoint, _candles?: readonly Candle[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryPath, encodeTaggedJson(checkpoint), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}

export interface AnalyticsStateStore {
  load(): Promise<AnalyticsCheckpoint | null>;
  save(checkpoint: AnalyticsCheckpoint, candles: readonly Candle[]): Promise<void>;
  appendCanonicalState?(
    metadata: AnalyticsCheckpointMetadata,
    block: BlockEnvelope,
    candles: readonly Candle[]
  ): Promise<void>;
  appendCanonicalStateAndCandleEvents?(
    metadata: AnalyticsCheckpointMetadata,
    block: BlockEnvelope,
    candles: readonly Candle[],
    events: readonly CandleStreamEvent[]
  ): Promise<void>;
  saveCanonicalStateAndCandleEvents?(
    checkpoint: AnalyticsCheckpoint,
    candles: readonly Candle[],
    events: readonly CandleStreamEvent[]
  ): Promise<void>;
  loadCandleEvents?(): Promise<CandleStreamEvent[]>;
  appendCandleEvents?(events: readonly CandleStreamEvent[]): Promise<void>;
  close?(): Promise<void>;
}

interface PendingCanonicalCommit {
  block: BlockEnvelope;
  fullCandles: Candle[] | null;
  changedCandles: Candle[];
  canonicalPersisted: boolean;
  result: "appended" | "reorg";
}

export interface AnalyticsApiServiceOptions {
  engine: AnalyticsEngine;
  store?: AnalyticsStateStore | null;
  allowFixedTestPrices?: boolean;
  priceVerifier?: PriceSampleVerifier | null;
  positionSnapshotProvider?: PositionSnapshotProvider | null;
}

export interface PriceSampleVerifier {
  verify(
    submission: PriceSubmission,
    context: { blockNumber: bigint; blockHash: string; blockTimestamp: number }
  ): Promise<PriceSample>;
}

export interface BlockSubmissionPage {
  blocks: BlockSubmission[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AnalyticsBlockSource {
  fetchPage(cursor: string | null): Promise<BlockSubmissionPage>;
  followLive?(ingest: (block: BlockSubmission) => Promise<unknown>): Promise<void>;
}

export interface PositionSnapshotProvider {
  load(owner: string, head: CanonicalHead): Promise<PositionSnapshotEvent[]>;
}

export class CandleStreamHub {
  readonly #events: CandleStreamEvent[] = [];
  readonly #subscribers = new Set<(event: CandleStreamEvent) => void>();
  readonly #replaySize: number;
  #sequence = 0;

  constructor(replaySize = DEFAULT_STREAM_REPLAY_SIZE) {
    if (!Number.isSafeInteger(replaySize) || replaySize <= 0) throw new Error("Candle stream replay size must be positive");
    this.#replaySize = replaySize;
  }

  get cursor(): string {
    return String(this.#sequence);
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  restore(events: readonly CandleStreamEvent[]): void {
    if (this.#sequence !== 0 || this.#events.length !== 0) throw new Error("Candle stream can only be restored while empty");
    const retained = events.slice(-this.#replaySize);
    let previous = 0;
    for (const event of retained) {
      const cursor = Number(event.cursor);
      if (!Number.isSafeInteger(cursor) || cursor <= previous) throw new Error("Persisted candle stream cursor is invalid");
      previous = cursor;
      this.#events.push(structuredClone(event));
    }
    this.#sequence = previous;
  }

  publishCandle(candle: Candle): CandleStreamEvent {
    return this.#publish({
      type: "candle",
      pair: candle.pair,
      interval: candle.interval,
      candle,
      reason: null
    });
  }

  publishReset(reason: string): CandleStreamEvent {
    return this.#publish({ type: "reset", pair: null, interval: null, candle: null, reason });
  }

  async publishBatch(
    inputs: readonly CandleStreamEventInput[],
    persist: (events: readonly CandleStreamEvent[]) => Promise<void>
  ): Promise<CandleStreamEvent[]> {
    const events = inputs.map((input, index) => ({
      ...input,
      cursor: String(this.#sequence + index + 1)
    }));
    await persist(events);
    for (const event of events) this.#commit(event);
    return events;
  }

  replay(after: string, pair: string, interval: CandleInterval): CandleStreamEvent[] | null {
    if (!/^\d+$/.test(after)) return null;
    const cursor = Number(after);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.#sequence) return null;
    const oldest = this.#events[0] === undefined ? this.#sequence + 1 : Number(this.#events[0].cursor);
    if (cursor < oldest - 1) return null;
    return this.#events.filter((event) =>
      Number(event.cursor) > cursor &&
      (event.type === "reset" || event.pair === pair && event.interval === interval)
    );
  }

  subscribe(listener: (event: CandleStreamEvent) => void): () => void {
    if (this.#subscribers.size >= MAX_STREAM_SUBSCRIBERS) throw new Error("Candle stream subscriber limit reached");
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  #publish(input: Omit<CandleStreamEvent, "cursor">): CandleStreamEvent {
    const event = { ...input, cursor: String(this.#sequence + 1) };
    this.#commit(event);
    return event;
  }

  #commit(event: CandleStreamEvent): void {
    const cursor = Number(event.cursor);
    if (cursor !== this.#sequence + 1) throw new Error("Candle stream events must commit in cursor order");
    this.#sequence = cursor;
    this.#events.push(event);
    if (this.#events.length > this.#replaySize) this.#events.splice(0, this.#events.length - this.#replaySize);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch {
        this.#subscribers.delete(subscriber);
      }
    }
  }
}

export class AnalyticsApiService {
  readonly #engine: AnalyticsEngine;
  readonly #schema: GraphQLSchema;
  readonly #store: AnalyticsStateStore | null;
  readonly #allowFixedTestPrices: boolean;
  readonly #priceVerifier: PriceSampleVerifier | null;
  readonly #positionSnapshotProvider: PositionSnapshotProvider | null;
  readonly #stream = new CandleStreamHub();
  readonly #mutations = new AsyncMutex();
  #candleSnapshot = new Map<string, string>();
  #pendingCanonicalCommit: PendingCanonicalCommit | null = null;

  private constructor(options: AnalyticsApiServiceOptions, schema: GraphQLSchema) {
    this.#engine = options.engine;
    this.#schema = schema;
    this.#store = options.store ?? null;
    this.#allowFixedTestPrices = options.allowFixedTestPrices ?? false;
    this.#priceVerifier = options.priceVerifier ?? null;
    this.#positionSnapshotProvider = options.positionSnapshotProvider ?? null;
  }

  static async create(options: AnalyticsApiServiceOptions): Promise<AnalyticsApiService> {
    const schemaSource = await readFile(new URL("../../schema.graphql", import.meta.url), "utf8");
    const schema = buildSchema(schemaSource);
    configureBigIntScalar(schema);
    const service = new AnalyticsApiService(options, schema);
    const checkpoint = await service.#store?.load();
    if (checkpoint) service.#engine.restoreCheckpoint(checkpoint);
    const persistedEvents = await service.#store?.loadCandleEvents?.();
    if (persistedEvents && persistedEvents.length > 0) service.#stream.restore(persistedEvents);
    service.#replaceCandleSnapshot();
    return service;
  }

  get candleStream(): CandleStreamHub {
    return this.#stream;
  }

  async ingestBlock(submission: BlockSubmission): Promise<"appended" | "duplicate" | "reorg"> {
    const block = await this.#verifyBlock(submission);
    return this.#mutations.run(async () => {
      await this.#flushPendingCanonicalCommit();
      const result = this.#engine.ingestBlock(block);
      if (result !== "duplicate") {
        const changedCandles = result === "appended"
          ? this.#engine.listLastChangedCandles()
          : this.#engine.listCandles();
        const needsFullCandles = result === "reorg" ||
          (this.#store !== null && this.#store.appendCanonicalState === undefined);
        this.#pendingCanonicalCommit = {
          block,
          fullCandles: needsFullCandles ? this.#engine.listCandles() : null,
          changedCandles: this.#changedCandles(changedCandles),
          canonicalPersisted: false,
          result
        };
        await this.#flushPendingCanonicalCommit();
      }
      return result;
    });
  }

  async backfill(
    fetchPage: (cursor: string | null) => Promise<BlockSubmissionPage>,
    options: { startCursor?: string | null; maxPages?: number } = {}
  ): Promise<BackfillResult> {
    return this.#mutations.run(async () => {
      await this.#flushPendingCanonicalCommit();
      try {
        return await runBackfill({
          engine: this.#engine,
          startCursor: options.startCursor,
          maxPages: options.maxPages,
          fetchPage: async (cursor) => {
            const page = await fetchPage(cursor);
            return {
              ...page,
              blocks: await Promise.all(page.blocks.map((block) => this.#verifyBlock(block)))
            };
          }
        });
      } finally {
        await this.#persistFullStateAndPublish(false);
      }
    });
  }

  getHealth(nowTimestamp?: number): AnalyticsHealth {
    return this.#engine.getHealth(nowTimestamp);
  }

  async persist(): Promise<void> {
    await this.#mutations.run(async () => {
      await this.#flushPendingCanonicalCommit();
      await this.#persistUnlocked();
    });
  }

  async execute(source: string, variableValues?: Record<string, unknown>): Promise<ExecutionResult> {
    return graphql({
      schema: this.#schema,
      source,
      variableValues,
      rootValue: {
        poolMetrics: (args: { first: number; after?: string | null; asOfTimestamp?: number }) =>
          mapConnection(this.#engine.queryPoolMetrics(args), mapPoolMetrics),
        pairCandles: (args: {
          pair: string;
          interval: GraphqlCandleInterval;
          fromTimestamp: number;
          toTimestamp: number;
          first: number;
          after?: string | null;
        }) => ({
          ...mapConnection(
            this.#engine.queryCandles({
              ...args,
              interval: candleIntervalFromGraphql(args.interval)
            }),
            mapCandle
          ),
          streamCursor: this.#stream.cursor
        }),
        walletPositions: async (args: { owner: string; first: number; after?: string | null }) =>
          mapConnection(await this.queryWalletPositions(args), mapWalletPosition),
        analyticsHealth: () => mapHealth(this.#engine.getHealth())
      }
    });
  }

  async queryWalletPositions(args: {
    owner: string;
    first: number;
    after?: string | null;
  }): Promise<Connection<WalletPairPosition>> {
    if (this.#positionSnapshotProvider === null) {
      return this.#mutations.run(async () => this.#engine.queryWalletPositions(args));
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = this.#engine.getCanonicalHead();
      if (head === null) return this.#mutations.run(async () => this.#engine.queryWalletPositions(args));
      const snapshots = await this.#positionSnapshotProvider.load(args.owner.toLowerCase(), head);
      if (snapshots.some((snapshot) => snapshot.owner.toLowerCase() !== args.owner.toLowerCase())) {
        throw new Error("Position snapshot provider returned a different owner");
      }
      try {
        return await this.#mutations.run(async () => {
          await this.#flushPendingCanonicalCommit();
          this.#engine.augmentHeadPositionSnapshots(head, snapshots);
          await this.#persistHeadUnlocked();
          return this.#engine.queryWalletPositions(args);
        });
      } catch (error) {
        if (error instanceof CanonicalHeadChangedError) continue;
        throw error;
      }
    }
    throw new Error("Canonical head changed repeatedly while loading wallet positions");
  }

  async #persistUnlocked(): Promise<void> {
    await this.#store?.save(this.#engine.exportCheckpoint(), this.#engine.listCandles());
  }

  async #persistFullStateAndPublish(reorg: boolean): Promise<void> {
    const candles = this.#engine.listCandles();
    const inputs = this.#candleChangeInputs(reorg, candles);
    if (this.#store?.saveCanonicalStateAndCandleEvents !== undefined) {
      await this.#stream.publishBatch(inputs, (events) =>
        this.#store!.saveCanonicalStateAndCandleEvents!(
          this.#engine.exportCheckpoint(),
          candles,
          events
        )
      );
      this.#applyCandleSnapshot(reorg, candles);
      return;
    }
    await this.#persistUnlocked();
    await this.#publishCandleChanges(reorg, candles);
  }

  async #persistHeadUnlocked(): Promise<void> {
    if (this.#store === null) return;
    const head = this.#engine.getCanonicalHeadEnvelope();
    if (head !== null && this.#store.appendCanonicalState !== undefined) {
      await this.#store.appendCanonicalState(this.#engine.exportCheckpointMetadata(), head, []);
      return;
    }
    await this.#persistUnlocked();
  }

  #replaceCandleSnapshot(): void {
    this.#candleSnapshot = new Map(
      this.#engine.listCandles().map((candle) => [candleKey(candle), candleFingerprint(candle)])
    );
  }

  #changedCandles(candles: readonly Candle[]): Candle[] {
    return candles.filter((candle) => this.#candleSnapshot.get(candleKey(candle)) !== candleFingerprint(candle));
  }

  async #flushPendingCanonicalCommit(): Promise<void> {
    const pending = this.#pendingCanonicalCommit;
    if (pending === null) return;
    const candles = pending.result === "reorg"
      ? pending.fullCandles ?? this.#engine.listCandles()
      : pending.changedCandles;
    const inputs = this.#candleChangeInputs(pending.result === "reorg", candles);
    if (!pending.canonicalPersisted && pending.result === "appended" &&
      this.#store?.appendCanonicalStateAndCandleEvents !== undefined) {
      await this.#stream.publishBatch(inputs, (events) =>
        this.#store!.appendCanonicalStateAndCandleEvents!(
          this.#engine.exportCheckpointMetadata(),
          pending.block,
          pending.changedCandles,
          events
        )
      );
      this.#applyCandleSnapshot(false, pending.changedCandles);
      this.#pendingCanonicalCommit = null;
      return;
    }
    if (!pending.canonicalPersisted && pending.result === "reorg" &&
      this.#store?.saveCanonicalStateAndCandleEvents !== undefined) {
      await this.#stream.publishBatch(inputs, (events) =>
        this.#store!.saveCanonicalStateAndCandleEvents!(
          this.#engine.exportCheckpoint(),
          candles,
          events
        )
      );
      this.#applyCandleSnapshot(true, candles);
      this.#pendingCanonicalCommit = null;
      return;
    }
    if (!pending.canonicalPersisted) {
      if (pending.result === "appended" && this.#store?.appendCanonicalState !== undefined) {
        await this.#store.appendCanonicalState(
          this.#engine.exportCheckpointMetadata(),
          pending.block,
          pending.changedCandles
        );
      } else {
        await this.#store?.save(this.#engine.exportCheckpoint(), pending.fullCandles ?? this.#engine.listCandles());
      }
      pending.canonicalPersisted = true;
    }
    await this.#publishCandleChanges(pending.result === "reorg", candles);
    this.#pendingCanonicalCommit = null;
  }

  async #publishCandleChanges(reorg: boolean, candles = this.#engine.listCandles()): Promise<void> {
    const inputs = this.#candleChangeInputs(reorg, candles);
    if (inputs.length > 0) {
      await this.#stream.publishBatch(inputs, async (events) => {
        await this.#store?.appendCandleEvents?.(events);
      });
    }
    this.#applyCandleSnapshot(reorg, candles);
  }

  #candleChangeInputs(reorg: boolean, candles: readonly Candle[]): CandleStreamEventInput[] {
    const inputs: CandleStreamEventInput[] = reorg
      ? [{ type: "reset", pair: null, interval: null, candle: null, reason: "canonical-reorg" }]
      : [];
    for (const candle of candles) {
      const key = candleKey(candle);
      const fingerprint = candleFingerprint(candle);
      if (!reorg && this.#candleSnapshot.get(key) === fingerprint) continue;
      if (!reorg) inputs.push({ type: "candle", pair: candle.pair, interval: candle.interval, candle, reason: null });
    }
    return inputs;
  }

  #applyCandleSnapshot(reorg: boolean, candles: readonly Candle[]): void {
    if (reorg) {
      this.#candleSnapshot = new Map(candles.map((candle) => [candleKey(candle), candleFingerprint(candle)]));
    } else {
      for (const candle of candles) this.#candleSnapshot.set(candleKey(candle), candleFingerprint(candle));
    }
  }

  async #verifyBlock(submission: BlockSubmission): Promise<BlockEnvelope> {
    const prices: PriceSample[] = [];
    for (const price of submission.prices) {
      if (price.source === "fixed-test") {
        if (!this.#allowFixedTestPrices) throw new Error("fixed-test prices are disabled for this service");
        prices.push({ ...omitSignedReport(price), verifiedBy: "fixed-test" });
        continue;
      }
      if (price.signedReport === null || price.signedReport.trim() === "") {
        throw new Error(`Signed Chainlink report is required for ${price.token}`);
      }
      if (this.#priceVerifier === null) {
        throw new Error("Chainlink price verifier is not configured");
      }
      const verified = await this.#priceVerifier.verify(price, {
        blockNumber: submission.number,
        blockHash: submission.hash,
        blockTimestamp: submission.timestamp
      });
      assertVerifiedPriceMatches(price, verified);
      prices.push(verified);
    }
    return { ...submission, prices };
  }
}

export interface AnalyticsHttpServerOptions {
  service: AnalyticsApiService;
  ingestToken?: string | null;
  corsOrigins?: string[];
  host?: string;
  port?: number;
}

export async function startAnalyticsHttpServer(options: AnalyticsHttpServerOptions): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const corsOrigins = new Set((options.corsOrigins ?? []).map(normalizeCorsOrigin));
  const server = createServer(async (request, response) => {
    try {
      const origin = request.headers.origin;
      const pathname = new URL(request.url ?? "/", "http://analytics.local").pathname;
      const corsRoute = pathname === "/graphql" || pathname === "/events/candles";
      const corsAllowed = corsRoute && origin !== undefined && corsOrigins.has(origin);
      if (corsAllowed) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        if (!corsAllowed) {
          sendJson(response, 403, { error: "Origin is not allowed" });
          return;
        }
        response.writeHead(204, {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, last-event-id",
          "access-control-max-age": "600",
          "cache-control": "no-store"
        });
        response.end();
        return;
      }
      await routeRequest(request, response, options.service, options.ingestToken ?? null);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Analytics request failed" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function normalizeCorsOrigin(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`CORS origin must not include a path, query, or fragment: ${value}`);
  }
  return url.origin;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: AnalyticsApiService,
  ingestToken: string | null
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://analytics.local");
  if (request.method === "GET" && url.pathname === "/events/candles") {
    await openCandleStream(request, response, service.candleStream, url);
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "POST or candle-stream GET required" });
    return;
  }

  if (url.pathname === "/graphql") {
    const payload = JSON.parse(await readBody(request)) as { query?: unknown; variables?: unknown };
    if (typeof payload.query !== "string") {
      sendJson(response, 400, { error: "query must be a string" });
      return;
    }
    const result = await service.execute(
      payload.query,
      isRecord(payload.variables) ? payload.variables : undefined
    );
    sendJson(response, result.errors ? 400 : 200, result);
    return;
  }

  if (url.pathname === "/internal/blocks") {
    if (ingestToken === null) {
      sendJson(response, 503, { error: "Block ingestion is disabled until ANALYTICS_INGEST_TOKEN is configured" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${ingestToken}`) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    const block = decodeTaggedJson(await readBody(request)) as BlockSubmission;
    const result = await service.ingestBlock(block);
    sendJson(response, 202, { result });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function openCandleStream(
  request: IncomingMessage,
  response: ServerResponse,
  stream: CandleStreamHub,
  url: URL
): Promise<void> {
  const pair = url.searchParams.get("pair")?.toLowerCase() ?? "";
  const intervalValue = url.searchParams.get("interval") ?? "";
  if (!/^0x[0-9a-f]{40}$/.test(pair)) {
    sendJson(response, 400, { error: "pair must be a canonical EVM address" });
    return;
  }
  let interval: CandleInterval;
  try {
    interval = candleIntervalFromGraphql(intervalValue as GraphqlCandleInterval);
  } catch {
    sendJson(response, 400, { error: "interval is not supported" });
    return;
  }
  const after = headerValue(request.headers["last-event-id"]) ?? url.searchParams.get("after") ?? stream.cursor;
  const replay = stream.replay(after, pair, interval);

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.flushHeaders();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
    if (!response.writableEnded) response.end();
  };
  const write = (event: CandleStreamEvent) => {
    if (closed) return;
    if (event.type !== "reset" && (event.pair !== pair || event.interval !== interval)) return;
    const payload = event.type === "candle" && event.candle !== null
      ? { cursor: event.cursor, candle: mapCandle(event.candle) }
      : { cursor: event.cursor, reason: event.reason ?? "history-reset-required" };
    const writable = response.write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
    if (!writable) close();
  };
  let unsubscribe: (() => void) | undefined;
  const heartbeat = setInterval(() => {
    if (!closed && !response.write(`event: heartbeat\ndata: ${JSON.stringify({ cursor: stream.cursor, timestamp: Date.now() })}\n\n`)) close();
  }, STREAM_HEARTBEAT_MS);

  if (replay === null) {
    const cursor = stream.cursor;
    response.write(`id: ${cursor}\nevent: reset\ndata: ${JSON.stringify({ cursor, reason: "stream-cursor-expired" })}\n\n`);
  } else {
    for (const event of replay) write(event);
  }

  try {
    unsubscribe = stream.subscribe(write);
  } catch (error) {
    response.write(`event: reset\ndata: ${JSON.stringify({ cursor: stream.cursor, reason: error instanceof Error ? error.message : "subscriber-limit" })}\n\n`);
    close();
    return;
  }

  await new Promise<void>((resolve) => {
    request.once("close", resolve);
    response.once("close", resolve);
  });
  close();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Request body exceeds 5 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(encodeTaggedJson(value));
}

export function encodeTaggedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? { $featherBigInt: item.toString() } : item
  );
}

export function decodeTaggedJson(value: string): unknown {
  return JSON.parse(value, (_key, item: unknown) => {
    if (isRecord(item) && Object.keys(item).length === 1 && typeof item.$featherBigInt === "string") {
      return BigInt(item.$featherBigInt);
    }
    return item;
  });
}

function configureBigIntScalar(schema: GraphQLSchema): void {
  const scalar = schema.getType("BigInt");
  if (!isScalarType(scalar)) throw new Error("Analytics schema is missing BigInt scalar");
  scalar.serialize = (value: unknown) => {
    if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") return String(value);
    throw new Error("BigInt fields must be bigint, number, or decimal string");
  };
}

function mapConnection<T, U>(connection: { nodes: T[]; pageInfo: unknown }, map: (node: T) => U) {
  return { nodes: connection.nodes.map(map), pageInfo: connection.pageInfo };
}

function mapPoolMetrics<T extends { status: string }>(value: T) {
  return { ...value, status: value.status.toUpperCase() };
}

function mapCandle(value: Candle) {
  return {
    ...value,
    interval: candleIntervalToGraphql(value.interval),
    status: value.status.toUpperCase(),
    openUsdE18: nullableBigIntString(value.openUsdE18),
    highUsdE18: nullableBigIntString(value.highUsdE18),
    lowUsdE18: nullableBigIntString(value.lowUsdE18),
    closeUsdE18: nullableBigIntString(value.closeUsdE18),
    volumeUsdE18: nullableBigIntString(value.volumeUsdE18),
    feesUsdE18: nullableBigIntString(value.feesUsdE18),
    tvlUsdE18: nullableBigIntString(value.tvlUsdE18),
    firstBlock: value.firstBlock.toString(),
    lastBlock: value.lastBlock.toString()
  };
}

function mapWalletPosition<T extends { status: string; bins: Array<{ status: string }> }>(value: T) {
  return {
    ...value,
    status: value.status.toUpperCase(),
    bins: value.bins.map((bin) => ({ ...bin, status: bin.status.toUpperCase() }))
  };
}

function mapHealth<T extends { status: string }>(value: T) {
  return { ...value, status: value.status.toUpperCase() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function candleIntervalFromGraphql(interval: GraphqlCandleInterval): CandleInterval {
  switch (interval) {
    case "ONE_MINUTE": return "minute";
    case "FIVE_MINUTES": return "five-minutes";
    case "FIFTEEN_MINUTES": return "fifteen-minutes";
    case "HOUR": return "hour";
    case "FOUR_HOURS": return "four-hours";
    case "DAY": return "day";
    case "WEEK": return "week";
    default: throw new Error(`Unsupported candle interval ${String(interval)}`);
  }
}

function candleIntervalToGraphql(interval: CandleInterval): GraphqlCandleInterval {
  switch (interval) {
    case "minute": return "ONE_MINUTE";
    case "five-minutes": return "FIVE_MINUTES";
    case "fifteen-minutes": return "FIFTEEN_MINUTES";
    case "hour": return "HOUR";
    case "four-hours": return "FOUR_HOURS";
    case "day": return "DAY";
    case "week": return "WEEK";
  }
}

function candleKey(candle: Candle): string {
  return `${candle.pair}:${candle.interval}:${candle.startTimestamp}`;
}

function candleFingerprint(candle: Candle): string {
  return encodeTaggedJson(candle);
}

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.[0] ?? null;
}

function nullableBigIntString(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function omitSignedReport(submission: PriceSubmission): Omit<PriceSample, "verifiedBy"> {
  const { signedReport: _signedReport, ...sample } = submission;
  return sample;
}

function assertVerifiedPriceMatches(submission: PriceSubmission, verified: PriceSample): void {
  const expected = omitSignedReport(submission);
  const fields: Array<keyof typeof expected> = [
    "token",
    "source",
    "feedId",
    "priceUsdE18",
    "confidenceUsdE18",
    "observedAt",
    "sequence"
  ];
  for (const field of fields) {
    if (verified[field] !== expected[field]) throw new Error(`Verified Chainlink report does not match submitted ${field}`);
  }
  if (verified.verifiedBy.trim() === "") throw new Error("Price verifier returned an empty verification identity");
}

class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
