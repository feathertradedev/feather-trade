import { Pool, type PoolClient } from "pg";

import type { AnalyticsCheckpoint, AnalyticsCheckpointMetadata } from "./engine.js";
import { decodeTaggedJson, encodeTaggedJson, type AnalyticsStateStore, type CandleStreamEvent } from "./service.js";
import type { Candle } from "./types.js";

const DEFAULT_REPLAY_SIZE = 2_048;

export interface PostgresAnalyticsStoreOptions {
  connectionString: string;
  schema?: string;
  replaySize?: number;
}

export class PostgresAnalyticsStore implements AnalyticsStateStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #replaySize: number;
  #initialization: Promise<void> | null = null;

  constructor(options: PostgresAnalyticsStoreOptions) {
    if (!options.connectionString.trim()) throw new Error("PostgreSQL connection string is required");
    this.#schema = options.schema ?? "feather_analytics";
    if (!/^[a-z_][a-z0-9_]*$/.test(this.#schema)) throw new Error("Analytics PostgreSQL schema name is invalid");
    this.#replaySize = options.replaySize ?? DEFAULT_REPLAY_SIZE;
    if (!Number.isSafeInteger(this.#replaySize) || this.#replaySize <= 0) throw new Error("Analytics replay size must be positive");
    this.#pool = new Pool({ connectionString: options.connectionString, max: 5 });
  }

  async load(): Promise<AnalyticsCheckpoint | null> {
    await this.#initialize();
    const [metadata, blocks] = await Promise.all([
      this.#pool.query<{ payload: unknown }>(`SELECT payload FROM ${this.#schema}.checkpoint WHERE singleton = TRUE`),
      this.#pool.query<{ payload: unknown }>(`SELECT payload FROM ${this.#schema}.canonical_blocks ORDER BY number ASC`)
    ]);
    if (metadata.rows[0] === undefined) return null;
    const checkpoint = decodePayload<AnalyticsCheckpoint>(metadata.rows[0].payload);
    checkpoint.blocks = blocks.rows.map((row) => decodePayload(row.payload));
    return checkpoint;
  }

  async save(checkpoint: AnalyticsCheckpoint, candles: readonly Candle[]): Promise<void> {
    await this.#initialize();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TEMP TABLE incoming_analytics_blocks (number NUMERIC(78, 0) PRIMARY KEY, hash TEXT, parent_hash TEXT, timestamp BIGINT, payload JSONB) ON COMMIT DROP`);
      await client.query(
        `INSERT INTO incoming_analytics_blocks
         SELECT number, hash, parent_hash, timestamp, payload
         FROM jsonb_to_recordset($1::jsonb) AS row(number NUMERIC(78, 0), hash TEXT, parent_hash TEXT, timestamp BIGINT, payload JSONB)`,
        [encodeRows(checkpoint.blocks.map((block) => ({ number: block.number.toString(), hash: block.hash, parent_hash: block.parentHash, timestamp: block.timestamp, payload: taggedValue(block) })))]
      );
      await client.query(
        `INSERT INTO ${this.#schema}.canonical_blocks (number, hash, parent_hash, timestamp, payload)
         SELECT number, hash, parent_hash, timestamp, payload FROM incoming_analytics_blocks
         ON CONFLICT (number) DO UPDATE SET hash = EXCLUDED.hash, parent_hash = EXCLUDED.parent_hash, timestamp = EXCLUDED.timestamp, payload = EXCLUDED.payload`
      );
      await client.query(`DELETE FROM ${this.#schema}.canonical_blocks stored WHERE NOT EXISTS (SELECT 1 FROM incoming_analytics_blocks incoming WHERE incoming.number = stored.number)`);
      const metadata = { ...checkpoint, blocks: [] };
      await client.query(
        `INSERT INTO ${this.#schema}.checkpoint (singleton, payload, updated_at) VALUES (TRUE, $1::jsonb, NOW())
         ON CONFLICT (singleton) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
        [encodeTaggedJson(metadata)]
      );
      await client.query(`CREATE TEMP TABLE incoming_analytics_candles (pair TEXT, interval TEXT, start_timestamp BIGINT, finalized BOOLEAN, revision INTEGER, payload JSONB, PRIMARY KEY (pair, interval, start_timestamp)) ON COMMIT DROP`);
      await client.query(
        `INSERT INTO incoming_analytics_candles
         SELECT pair, interval, start_timestamp, finalized, revision, payload
         FROM jsonb_to_recordset($1::jsonb) AS row(pair TEXT, interval TEXT, start_timestamp BIGINT, finalized BOOLEAN, revision INTEGER, payload JSONB)`,
        [encodeRows(candles.map((candle) => ({ pair: candle.pair, interval: candle.interval, start_timestamp: candle.startTimestamp, finalized: candle.finalized, revision: candle.revision, payload: taggedValue(candle) })))]
      );
      await client.query(
        `INSERT INTO ${this.#schema}.candles (pair, interval, start_timestamp, finalized, revision, payload)
         SELECT pair, interval, start_timestamp, finalized, revision, payload FROM incoming_analytics_candles
         ON CONFLICT (pair, interval, start_timestamp) DO UPDATE SET finalized = EXCLUDED.finalized, revision = EXCLUDED.revision, payload = EXCLUDED.payload`
      );
      await client.query(
        `DELETE FROM ${this.#schema}.candles stored
         WHERE NOT EXISTS (
           SELECT 1 FROM incoming_analytics_candles incoming
           WHERE incoming.pair = stored.pair AND incoming.interval = stored.interval AND incoming.start_timestamp = stored.start_timestamp
         )`
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendCanonicalState(
    metadata: AnalyticsCheckpointMetadata,
    block: AnalyticsCheckpoint["blocks"][number],
    candles: readonly Candle[]
  ): Promise<void> {
    await this.#initialize();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${this.#schema}.canonical_blocks (number, hash, parent_hash, timestamp, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (number) DO UPDATE SET
           hash = EXCLUDED.hash,
           parent_hash = EXCLUDED.parent_hash,
           timestamp = EXCLUDED.timestamp,
           payload = EXCLUDED.payload`,
        [block.number.toString(), block.hash, block.parentHash, block.timestamp, encodeTaggedJson(block)]
      );
      await client.query(
        `INSERT INTO ${this.#schema}.checkpoint (singleton, payload, updated_at) VALUES (TRUE, $1::jsonb, NOW())
         ON CONFLICT (singleton) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
        [encodeTaggedJson({ ...metadata, blocks: [] })]
      );
      if (candles.length > 0) {
        await client.query(`CREATE TEMP TABLE incoming_analytics_candle_changes (pair TEXT, interval TEXT, start_timestamp BIGINT, finalized BOOLEAN, revision INTEGER, payload JSONB, PRIMARY KEY (pair, interval, start_timestamp)) ON COMMIT DROP`);
        await client.query(
          `INSERT INTO incoming_analytics_candle_changes
           SELECT pair, interval, start_timestamp, finalized, revision, payload
           FROM jsonb_to_recordset($1::jsonb) AS row(pair TEXT, interval TEXT, start_timestamp BIGINT, finalized BOOLEAN, revision INTEGER, payload JSONB)`,
          [encodeRows(candles.map((candle) => ({ pair: candle.pair, interval: candle.interval, start_timestamp: candle.startTimestamp, finalized: candle.finalized, revision: candle.revision, payload: taggedValue(candle) })))]
        );
        await client.query(
          `INSERT INTO ${this.#schema}.candles (pair, interval, start_timestamp, finalized, revision, payload)
           SELECT pair, interval, start_timestamp, finalized, revision, payload FROM incoming_analytics_candle_changes
           ON CONFLICT (pair, interval, start_timestamp) DO UPDATE SET
             finalized = EXCLUDED.finalized,
             revision = EXCLUDED.revision,
             payload = EXCLUDED.payload`
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadCandleEvents(): Promise<CandleStreamEvent[]> {
    await this.#initialize();
    const result = await this.#pool.query<{ payload: unknown }>(
      `SELECT payload FROM ${this.#schema}.candle_stream_events ORDER BY cursor ASC`
    );
    return result.rows.map((row) => decodePayload<CandleStreamEvent>(row.payload));
  }

  async appendCandleEvents(events: readonly CandleStreamEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.#initialize();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        await client.query(
          `INSERT INTO ${this.#schema}.candle_stream_events (cursor, pair, interval, event_type, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (cursor) DO UPDATE SET pair = EXCLUDED.pair, interval = EXCLUDED.interval, event_type = EXCLUDED.event_type, payload = EXCLUDED.payload`,
          [event.cursor, event.pair, event.interval, event.type, encodeTaggedJson(event)]
        );
      }
      await client.query(
        `DELETE FROM ${this.#schema}.candle_stream_events
         WHERE cursor NOT IN (SELECT cursor FROM ${this.#schema}.candle_stream_events ORDER BY cursor DESC LIMIT $1)`,
        [this.#replaySize]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #initialize(): Promise<void> {
    this.#initialization ??= this.#createSchema();
    return this.#initialization;
  }

  async #createSchema(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.#schema}`);
      await createTables(client, this.#schema);
    } finally {
      client.release();
    }
  }
}

async function createTables(client: PoolClient, schema: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.checkpoint (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.canonical_blocks (
      number NUMERIC(78, 0) PRIMARY KEY,
      hash TEXT NOT NULL UNIQUE,
      parent_hash TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      payload JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${schema}.candles (
      pair TEXT NOT NULL,
      interval TEXT NOT NULL,
      start_timestamp BIGINT NOT NULL,
      finalized BOOLEAN NOT NULL,
      revision INTEGER NOT NULL,
      payload JSONB NOT NULL,
      PRIMARY KEY (pair, interval, start_timestamp)
    );
    CREATE INDEX IF NOT EXISTS candles_history_idx ON ${schema}.candles (pair, interval, start_timestamp DESC);
    CREATE TABLE IF NOT EXISTS ${schema}.candle_stream_events (
      cursor BIGINT PRIMARY KEY,
      pair TEXT,
      interval TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('candle', 'reset')),
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function decodePayload<T>(payload: unknown): T {
  return decodeTaggedJson(JSON.stringify(payload)) as T;
}

function taggedValue(value: unknown): unknown {
  return JSON.parse(encodeTaggedJson(value));
}

function encodeRows(rows: readonly unknown[]): string {
  return JSON.stringify(rows);
}
