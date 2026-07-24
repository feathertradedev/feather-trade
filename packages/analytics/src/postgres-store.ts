import { createHash } from "node:crypto";

import { Pool, type PoolClient, type QueryConfig } from "pg";

import type { AnalyticsCheckpoint, AnalyticsCheckpointMetadata } from "./engine.js";
import {
  decodeTaggedJson,
  encodeTaggedJson,
  streamTopic,
  type AnalyticsStateStore,
  type CandleStreamEvent,
  type PoolStatePersistenceChange
} from "./service.js";
import type { Candle } from "./types.js";

const DEFAULT_REPLAY_SIZE = 2_048;
const DEFAULT_GLOBAL_REPLAY_SIZE = 8_192;
const WRITER_LEASE_NAMESPACE = "feather-analytics-writer:v1";

export class AnalyticsWriterLeaseUnavailableError extends Error {
  override readonly name = "AnalyticsWriterLeaseUnavailableError";
}

export interface PostgresAnalyticsStoreOptions {
  connectionString: string;
  schema?: string;
  applicationName?: string;
  replaySize?: number;
  globalReplaySize?: number;
  connectionTimeoutMs?: number;
  healthcheckTimeoutMs?: number;
  keepAliveInitialDelayMs?: number;
}

export class PostgresAnalyticsStore implements AnalyticsStateStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #replaySize: number;
  readonly #globalReplaySize: number;
  readonly #healthcheckTimeoutMs: number;
  #initialization: Promise<void> | null = null;
  #writerLeaseClient: PoolClient | null = null;
  #writerLeaseAcquisition: Promise<void> | null = null;
  #writerLeaseError: Error | null = null;
  readonly #writerLeaseFailure: Promise<Error>;
  readonly #resolveWriterLeaseFailure: (error: Error) => void;
  #closePromise: Promise<void> | null = null;
  #closing = false;

  constructor(options: PostgresAnalyticsStoreOptions) {
    if (!options.connectionString.trim()) throw new Error("PostgreSQL connection string is required");
    this.#schema = options.schema ?? "feather_analytics";
    if (!/^[a-z_][a-z0-9_]*$/.test(this.#schema)) throw new Error("Analytics PostgreSQL schema name is invalid");
    this.#replaySize = options.replaySize ?? DEFAULT_REPLAY_SIZE;
    if (!Number.isSafeInteger(this.#replaySize) || this.#replaySize <= 0) throw new Error("Analytics replay size must be positive");
    this.#globalReplaySize = options.globalReplaySize ?? DEFAULT_GLOBAL_REPLAY_SIZE;
    if (!Number.isSafeInteger(this.#globalReplaySize) || this.#globalReplaySize <= 0) {
      throw new Error("Analytics global replay size must be positive");
    }
    const connectionTimeoutMs = options.connectionTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(connectionTimeoutMs) || connectionTimeoutMs <= 0) {
      throw new Error("Analytics PostgreSQL connection timeout must be positive");
    }
    this.#healthcheckTimeoutMs = options.healthcheckTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.#healthcheckTimeoutMs) || this.#healthcheckTimeoutMs <= 0) {
      throw new Error("Analytics PostgreSQL healthcheck timeout must be positive");
    }
    const keepAliveInitialDelayMs = options.keepAliveInitialDelayMs ?? 10_000;
    if (!Number.isSafeInteger(keepAliveInitialDelayMs) || keepAliveInitialDelayMs <= 0) {
      throw new Error("Analytics PostgreSQL keepalive initial delay must be positive");
    }
    const applicationName = options.applicationName ?? "feather-analytics";
    if (!/^[A-Za-z0-9._:-]{1,63}$/.test(applicationName)) {
      throw new Error("Analytics PostgreSQL application name is invalid");
    }
    let resolveWriterLeaseFailure!: (error: Error) => void;
    this.#writerLeaseFailure = new Promise<Error>((resolve) => {
      resolveWriterLeaseFailure = resolve;
    });
    this.#resolveWriterLeaseFailure = resolveWriterLeaseFailure;
    this.#pool = new Pool({
      application_name: applicationName,
      connectionString: options.connectionString,
      connectionTimeoutMillis: connectionTimeoutMs,
      idle_in_transaction_session_timeout: 60_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: keepAliveInitialDelayMs,
      lock_timeout: 15_000,
      max: 1,
      query_timeout: 65_000,
      statement_timeout: 60_000
    });
  }

  async load(): Promise<AnalyticsCheckpoint | null> {
    const client = this.#requireWriterLease();
    await this.#initialize();
    const metadata = await client.query<{ payload: unknown }>(
      `SELECT payload FROM ${this.#schema}.checkpoint WHERE singleton = TRUE`
    );
    const blocks = await client.query<{ payload: unknown }>(
      `SELECT payload FROM ${this.#schema}.canonical_blocks ORDER BY number ASC`
    );
    if (metadata.rows[0] === undefined) return null;
    const checkpoint = decodePayload<AnalyticsCheckpoint>(metadata.rows[0].payload);
    checkpoint.blocks = blocks.rows.map((row) => decodePayload(row.payload));
    return checkpoint;
  }

  async save(
    checkpoint: AnalyticsCheckpoint,
    candles: readonly Candle[],
    poolStates?: readonly PoolStatePersistenceChange[]
  ): Promise<void> {
    await this.#saveCanonicalState(checkpoint, candles, null, poolStates ?? null);
  }

  async saveCanonicalStateAndCandleEvents(
    checkpoint: AnalyticsCheckpoint,
    candles: readonly Candle[],
    events: readonly CandleStreamEvent[],
    poolStates?: readonly PoolStatePersistenceChange[]
  ): Promise<void> {
    await this.#saveCanonicalState(checkpoint, candles, events, poolStates ?? null);
  }

  async #saveCanonicalState(
    checkpoint: AnalyticsCheckpoint,
    candles: readonly Candle[],
    events: readonly CandleStreamEvent[] | null,
    poolStates: readonly PoolStatePersistenceChange[] | null
  ): Promise<void> {
    const client = this.#requireWriterLease();
    await this.#initialize();
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
      if (poolStates !== null) await this.#replacePoolStates(client, poolStates);
      if (events !== null) await this.#writeStreamEvents(client, events);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  async appendCanonicalState(
    metadata: AnalyticsCheckpointMetadata,
    block: AnalyticsCheckpoint["blocks"][number],
    candles: readonly Candle[],
    poolStates?: readonly PoolStatePersistenceChange[]
  ): Promise<void> {
    await this.#appendCanonicalState(metadata, block, candles, null, poolStates ?? null);
  }

  async appendCanonicalStateAndCandleEvents(
    metadata: AnalyticsCheckpointMetadata,
    block: AnalyticsCheckpoint["blocks"][number],
    candles: readonly Candle[],
    events: readonly CandleStreamEvent[],
    poolStates?: readonly PoolStatePersistenceChange[]
  ): Promise<void> {
    await this.#appendCanonicalState(metadata, block, candles, events, poolStates ?? null);
  }

  async #appendCanonicalState(
    metadata: AnalyticsCheckpointMetadata,
    block: AnalyticsCheckpoint["blocks"][number],
    candles: readonly Candle[],
    events: readonly CandleStreamEvent[] | null,
    poolStates: readonly PoolStatePersistenceChange[] | null
  ): Promise<void> {
    const client = this.#requireWriterLease();
    await this.#initialize();
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
      if (poolStates !== null) await this.#upsertPoolStates(client, poolStates);
      if (events !== null) await this.#writeStreamEvents(client, events);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  async loadCandleEvents(): Promise<CandleStreamEvent[]> {
    const client = this.#requireWriterLease();
    await this.#initialize();
    const result = await client.query<{ payload: unknown }>(
      `SELECT payload FROM ${this.#schema}.stream_events ORDER BY cursor ASC`
    );
    return result.rows.map((row) => decodePayload<CandleStreamEvent>(row.payload));
  }

  async appendCandleEvents(events: readonly CandleStreamEvent[]): Promise<void> {
    if (events.length === 0) return;
    const client = this.#requireWriterLease();
    await this.#initialize();
    try {
      await client.query("BEGIN");
      await this.#writeStreamEvents(client, events);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  async healthcheck(): Promise<void> {
    this.#assertOpen();
    if (this.#writerLeaseAcquisition !== null) await this.#writerLeaseAcquisition;
    const query: QueryConfig & { query_timeout: number } = {
      text: "SELECT 1",
      query_timeout: this.#healthcheckTimeoutMs
    };
    await this.#requireWriterLease().query(query);
  }

  async acquireWriterLease(): Promise<void> {
    this.#assertOpen();
    this.#assertLeaseHasNotFailed();
    this.#writerLeaseAcquisition ??= this.#acquireWriterLease();
    return this.#writerLeaseAcquisition;
  }

  writerLeaseFailure(): Promise<Error> {
    return this.#writerLeaseFailure;
  }

  hasWriterLease(): boolean {
    return this.#writerLeaseClient !== null && this.#writerLeaseError === null && !this.#closing;
  }

  async releaseWriterLease(): Promise<void> {
    const acquisition = this.#writerLeaseAcquisition;
    if (acquisition !== null) await acquisition;
    await this.#releaseWriterLease();
    this.#writerLeaseAcquisition = null;
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #acquireWriterLease(): Promise<void> {
    const client = await this.#pool.connect();
    const [leaseKeyHigh, leaseKeyLow] = writerLeaseKey(this.#schema);
    try {
      // PostgreSQL advisory locks are session scoped. Deploy through a direct
      // database endpoint or PgBouncer session pooling; transaction pooling
      // cannot preserve this process-lifetime writer fence.
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
        [leaseKeyHigh, leaseKeyLow]
      );
      if (result.rows[0]?.acquired !== true) {
        throw new AnalyticsWriterLeaseUnavailableError(
          `Analytics writer lease is already held for PostgreSQL schema ${this.#schema}`
        );
      }
      client.on("error", this.#recordWriterLeaseError);
      client.on("end", this.#recordWriterLeaseEnd);
      this.#writerLeaseClient = client;
      this.#initialization ??= this.#createSchema(client);
      await this.#initialization;
    } catch (error) {
      if (this.#writerLeaseClient === client) {
        this.#writerLeaseClient = null;
        client.off("error", this.#recordWriterLeaseError);
        client.off("end", this.#recordWriterLeaseEnd);
      }
      client.release(true);
      throw error;
    }
  }

  async #releaseWriterLease(): Promise<void> {
    const client = this.#writerLeaseClient;
    if (client === null) return;
    this.#writerLeaseClient = null;
    client.off("error", this.#recordWriterLeaseError);
    client.off("end", this.#recordWriterLeaseEnd);
    const [leaseKeyHigh, leaseKeyLow] = writerLeaseKey(this.#schema);
    let destroy = this.#writerLeaseError !== null;
    try {
      if (!destroy) {
        const result = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock($1::integer, $2::integer) AS released",
          [leaseKeyHigh, leaseKeyLow]
        );
        if (result.rows[0]?.released !== true) {
          destroy = true;
          throw new Error(`Analytics writer lease was not held for PostgreSQL schema ${this.#schema}`);
        }
      }
    } catch (error) {
      destroy = true;
      throw error;
    } finally {
      client.release(destroy);
    }
  }

  async #close(): Promise<void> {
    this.#closing = true;
    try {
      if (this.#writerLeaseAcquisition !== null) {
        try {
          await this.#writerLeaseAcquisition;
        } catch {
          // Acquisition failures already release their dedicated client.
        }
      }
      await this.#releaseWriterLease();
    } finally {
      await this.#pool.end();
    }
  }

  readonly #recordWriterLeaseError = (error: Error): void => {
    this.#markWriterLeaseFailed(error);
  };

  readonly #recordWriterLeaseEnd = (): void => {
    this.#markWriterLeaseFailed(
      new Error("Analytics PostgreSQL writer lease connection ended unexpectedly")
    );
  };

  #markWriterLeaseFailed(error: Error): void {
    if (this.#writerLeaseError !== null || this.#closing) return;
    this.#writerLeaseError = error;
    this.#resolveWriterLeaseFailure(error);
  }

  #requireWriterLease(): PoolClient {
    if (this.#writerLeaseError !== null) {
      throw new Error("Analytics PostgreSQL writer lease connection failed", { cause: this.#writerLeaseError });
    }
    if (this.#writerLeaseClient === null) {
      throw new AnalyticsWriterLeaseUnavailableError("Analytics PostgreSQL writer lease has not been acquired");
    }
    return this.#writerLeaseClient;
  }

  #assertOpen(): void {
    if (this.#closing) throw new Error("Analytics PostgreSQL store is closed");
  }

  #assertLeaseHasNotFailed(): void {
    if (this.#writerLeaseError !== null) {
      throw new Error(
        "Analytics PostgreSQL writer lease failed permanently; restart the process before acquiring another lease",
        { cause: this.#writerLeaseError }
      );
    }
  }

  async #initialize(): Promise<void> {
    if (this.#initialization === null) {
      throw new AnalyticsWriterLeaseUnavailableError(
        "Analytics PostgreSQL schema cannot initialize before the writer lease is acquired"
      );
    }
    return this.#initialization;
  }

  async #createSchema(client: PoolClient): Promise<void> {
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.#schema}`);
      await createTables(client, this.#schema);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  async #writeStreamEvents(client: PoolClient, events: readonly CandleStreamEvent[]): Promise<void> {
    if (events.length === 0) return;
    for (const event of events) {
      const topic = streamTopic(event);
      const result = await client.query(
        `INSERT INTO ${this.#schema}.stream_events AS stored (cursor, topic, pair, interval, event_type, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (cursor) DO UPDATE SET cursor = stored.cursor
         WHERE stored.topic = EXCLUDED.topic
           AND stored.pair IS NOT DISTINCT FROM EXCLUDED.pair
           AND stored.interval IS NOT DISTINCT FROM EXCLUDED.interval
           AND stored.event_type = EXCLUDED.event_type
           AND stored.payload = EXCLUDED.payload
         RETURNING cursor`,
        [event.cursor, topic, event.pair, event.interval, event.type, encodeTaggedJson(event)]
      );
      if (result.rowCount !== 1) throw new Error(`Stream cursor ${event.cursor} conflicts with an immutable persisted event`);
    }
    await client.query(
      `DELETE FROM ${this.#schema}.stream_events stored
       USING (
         SELECT cursor, ROW_NUMBER() OVER (PARTITION BY topic ORDER BY cursor DESC) AS topic_rank
         FROM ${this.#schema}.stream_events
       ) ranked
       WHERE stored.cursor = ranked.cursor AND ranked.topic_rank > $1`,
      [this.#replaySize]
    );
    await client.query(
      `DELETE FROM ${this.#schema}.stream_events stored
       USING (
         SELECT cursor
         FROM ${this.#schema}.stream_events
         ORDER BY cursor DESC
         OFFSET $1
       ) stale
       WHERE stored.cursor = stale.cursor`,
      [this.#globalReplaySize]
    );
  }

  async #replacePoolStates(
    client: PoolClient,
    changes: readonly PoolStatePersistenceChange[]
  ): Promise<void> {
    await client.query(`TRUNCATE ${this.#schema}.pool_bins, ${this.#schema}.pool_states`);
    await this.#upsertPoolStates(client, changes);
  }

  async #upsertPoolStates(
    client: PoolClient,
    changes: readonly PoolStatePersistenceChange[]
  ): Promise<void> {
    for (const change of changes) {
      const state = change.state;
      await client.query(
        `INSERT INTO ${this.#schema}.pool_states
           (chain_id, pair, as_of_block, as_of_block_hash, revision, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (chain_id, pair) DO UPDATE SET
           as_of_block = EXCLUDED.as_of_block,
           as_of_block_hash = EXCLUDED.as_of_block_hash,
           revision = EXCLUDED.revision,
           payload = EXCLUDED.payload`,
        [
          state.chainId,
          state.pair,
          state.asOfBlock.toString(),
          state.asOfBlockHash,
          state.revision,
          encodeTaggedJson(state)
        ]
      );
      if (change.replaceBinWindow) {
        await client.query(
          `DELETE FROM ${this.#schema}.pool_bins WHERE chain_id = $1 AND pair = $2`,
          [state.chainId, state.pair]
        );
      }
      for (const bin of change.bins) {
        if (bin.chainId !== state.chainId || bin.pair.toLowerCase() !== state.pair.toLowerCase()) {
          throw new Error(`Pool bin ${bin.binId} does not belong to ${state.chainId}:${state.pair}`);
        }
        await client.query(
          `INSERT INTO ${this.#schema}.pool_bins
             (chain_id, pair, bin_id, updated_at_block, updated_at_block_hash, revision, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (chain_id, pair, bin_id) DO UPDATE SET
             updated_at_block = EXCLUDED.updated_at_block,
             updated_at_block_hash = EXCLUDED.updated_at_block_hash,
             revision = EXCLUDED.revision,
             payload = EXCLUDED.payload`,
          [
            bin.chainId,
            bin.pair,
            bin.binId,
            bin.updatedAtBlock.toString(),
            bin.updatedAtBlockHash,
            bin.revision,
            encodeTaggedJson(bin)
          ]
        );
      }
    }
  }
}

function writerLeaseKey(schema: string): [number, number] {
  const digest = createHash("sha256")
    .update(`${WRITER_LEASE_NAMESPACE}\0${schema}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
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
    CREATE TABLE IF NOT EXISTS ${schema}.pool_states (
      chain_id INTEGER NOT NULL,
      pair TEXT NOT NULL,
      as_of_block NUMERIC(78, 0) NOT NULL,
      as_of_block_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload JSONB NOT NULL,
      PRIMARY KEY (chain_id, pair)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.pool_bins (
      chain_id INTEGER NOT NULL,
      pair TEXT NOT NULL,
      bin_id NUMERIC(78, 0) NOT NULL,
      updated_at_block NUMERIC(78, 0) NOT NULL,
      updated_at_block_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload JSONB NOT NULL,
      PRIMARY KEY (chain_id, pair, bin_id),
      FOREIGN KEY (chain_id, pair) REFERENCES ${schema}.pool_states (chain_id, pair) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS pool_bins_window_idx ON ${schema}.pool_bins (chain_id, pair, bin_id);
    CREATE TABLE IF NOT EXISTS ${schema}.candle_stream_events (
      cursor BIGINT PRIMARY KEY,
      pair TEXT,
      interval TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('candle', 'reset')),
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.stream_events (
      cursor BIGINT PRIMARY KEY,
      topic TEXT NOT NULL,
      pair TEXT,
      interval TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('candle', 'pool-state', 'reset')),
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS stream_events_topic_cursor_idx ON ${schema}.stream_events (topic, cursor DESC);
    LOCK TABLE ${schema}.candle_stream_events IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE ${schema}.stream_events IN SHARE ROW EXCLUSIVE MODE;
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM ${schema}.candle_stream_events legacy
        JOIN ${schema}.stream_events current USING (cursor)
        WHERE current.topic IS DISTINCT FROM CASE
            WHEN legacy.event_type = 'reset' THEN 'reset'
            ELSE 'candle:' || LOWER(legacy.pair) || ':' || legacy.interval
          END
          OR current.pair IS DISTINCT FROM legacy.pair
          OR current.interval IS DISTINCT FROM legacy.interval
          OR current.event_type IS DISTINCT FROM legacy.event_type
          OR current.payload IS DISTINCT FROM legacy.payload
      ) THEN
        RAISE EXCEPTION 'Legacy candle stream cursor conflicts with an immutable stream event';
      END IF;
    END
    $migration$;
    INSERT INTO ${schema}.stream_events (cursor, topic, pair, interval, event_type, payload, created_at)
    SELECT
      cursor,
      CASE
        WHEN event_type = 'reset' THEN 'reset'
        ELSE 'candle:' || LOWER(pair) || ':' || interval
      END,
      pair,
      interval,
      event_type,
      payload,
      created_at
    FROM ${schema}.candle_stream_events
    ON CONFLICT (cursor) DO NOTHING;
    TRUNCATE ${schema}.candle_stream_events;
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
