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
  type CanonicalHead
} from "./engine.js";
import type {
  AnalyticsHealth,
  BlockEnvelope,
  BlockSubmission,
  CandleInterval,
  PriceSample,
  PriceSubmission,
  PositionSnapshotEvent,
  WalletPairPosition,
  Connection
} from "./types.js";

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

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

  async save(checkpoint: AnalyticsCheckpoint): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryPath, encodeTaggedJson(checkpoint), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}

export interface AnalyticsApiServiceOptions {
  engine: AnalyticsEngine;
  store?: AnalyticsCheckpointStore | null;
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

export class AnalyticsApiService {
  readonly #engine: AnalyticsEngine;
  readonly #schema: GraphQLSchema;
  readonly #store: AnalyticsCheckpointStore | null;
  readonly #allowFixedTestPrices: boolean;
  readonly #priceVerifier: PriceSampleVerifier | null;
  readonly #positionSnapshotProvider: PositionSnapshotProvider | null;
  readonly #mutations = new AsyncMutex();

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
    return service;
  }

  async ingestBlock(submission: BlockSubmission): Promise<"appended" | "duplicate" | "reorg"> {
    const block = await this.#verifyBlock(submission);
    return this.#mutations.run(async () => {
      const result = this.#engine.ingestBlock(block);
      if (result !== "duplicate") await this.#persistUnlocked();
      return result;
    });
  }

  async backfill(
    fetchPage: (cursor: string | null) => Promise<BlockSubmissionPage>,
    options: { startCursor?: string | null; maxPages?: number } = {}
  ): Promise<BackfillResult> {
    return this.#mutations.run(async () => {
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
        await this.#persistUnlocked();
      }
    });
  }

  getHealth(nowTimestamp?: number): AnalyticsHealth {
    return this.#engine.getHealth(nowTimestamp);
  }

  async persist(): Promise<void> {
    await this.#mutations.run(() => this.#persistUnlocked());
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
          interval: "HOUR" | "DAY";
          fromTimestamp: number;
          toTimestamp: number;
          first: number;
          after?: string | null;
        }) =>
          mapConnection(
            this.#engine.queryCandles({
              ...args,
              interval: args.interval.toLowerCase() as CandleInterval
            }),
            mapCandle
          ),
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
          this.#engine.augmentHeadPositionSnapshots(head, snapshots);
          await this.#persistUnlocked();
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
    await this.#store?.save(this.#engine.exportCheckpoint());
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
      const graphqlCorsAllowed = request.url === "/graphql" && origin !== undefined && corsOrigins.has(origin);
      if (graphqlCorsAllowed) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        if (!graphqlCorsAllowed) {
          sendJson(response, 403, { error: "Origin is not allowed" });
          return;
        }
        response.writeHead(204, {
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
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
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "POST required" });
    return;
  }

  if (request.url === "/graphql") {
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

  if (request.url === "/internal/blocks") {
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

function mapCandle<T extends { status: string; interval: string }>(value: T) {
  return { ...value, status: value.status.toUpperCase(), interval: value.interval.toUpperCase() };
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
