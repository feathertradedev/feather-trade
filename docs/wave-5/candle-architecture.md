# Candle architecture decision

Status: accepted for Wave 5 / issue #66
Scope: analytics candles and chart delivery; this decision does not authorize contract or production transaction-builder changes.

## Decision summary

Feather materializes one canonical one-minute candle stream and derives every larger interval through one deterministic rollup DAG. Historical data is queried through bounded GraphQL connections. Live replacements are delivered with server-sent events (SSE) and a persisted monotonic cursor. PostgreSQL stores canonical envelopes, current candle rows, and the bounded replay log. The browser never reconstructs OHLC history from swaps.

Pool-derived chart prices and authoritative TVL pricing are separate concerns. A candle may use the active-bin token-Y-per-token-X quote multiplied by a trusted quote-token USD sample. This value is chart provenance (`active-bin-quote-usd`) only. It must not become a trusted token price or a TVL input; production TVL remains governed by issue #80.

## Resolution and UTC boundaries

All timestamps are Unix seconds. Intervals are half-open `[startTimestamp, endTimestamp)`. Non-week boundaries are integer multiples of their duration from the Unix epoch. Weeks begin Monday at 00:00:00 UTC, using the first Monday after the epoch (`1970-01-05T00:00:00Z`) as the offset.

| API value | Duration | Boundary | Default chart lookback | Max possible points |
| --- | ---: | --- | ---: | ---: |
| `ONE_MINUTE` | 60s | UTC minute | 6h | 361 |
| `FIVE_MINUTES` | 300s | UTC 5-minute multiple | 24h | 289 |
| `FIFTEEN_MINUTES` | 900s | UTC 15-minute multiple | 3d | 289 |
| `HOUR` | 3,600s | UTC hour | 14d | 337 |
| `FOUR_HOURS` | 14,400s | UTC 4-hour multiple | 60d | 361 |
| `DAY` | 86,400s | UTC day | 1y | 366 |
| `WEEK` | 604,800s | Monday 00:00 UTC | 3y | about 157 |

`candleBoundary` is the shared server rule; the web client implements the same rule only to form aligned query windows. Tests cover every boundary and the Monday transition.

## Canonical base and rollup DAG

```text
canonical blocks + swaps + active-bin observations + trusted quote USD
                              |
                              v
                             1m
                    +---------+---------+
                    v         v         v
                    5m       15m        1h
                                        |
                                  +-----+-----+
                                  v           v
                                  4h          1d
                                               |
                                               v
                                               1w
```

The append path applies each canonical block exactly once. Duplicate block hashes are no-ops. Rollups are disposable derived views: after a base-candle change, only its affected parent buckets are recomputed from canonical source rows, preventing an updated source revision from being added twice without scanning unrelated history. A reorg takes the conservative path of replaying retained canonical blocks and recreating the entire dependent DAG.

For each ordered source group:

- open: first non-null open;
- high / low: extrema of non-null values;
- close: last non-null close;
- volume, fees, and swap count: sums;
- TVL: last observation;
- missing volume or fees: propagated as null, never zero;
- missing-price tokens: sorted union;
- first/last block numbers and hashes: first and last canonical source bounds;
- price provenance: same source when uniform, otherwise `mixed`;
- revision: deterministic sum of source revisions.

Deterministic tests independently recompute this result from 1m rows and cover OHLCV, fees, TVL, counts, missing-price state, provenance, bounds, duplicates, and a replacement branch across all seven intervals.

## Mutable and finalized lifecycle

The candle containing the canonical head is mutable. Each canonical swap or pair observation updates the open 1m candle in place and increments its revision. Every affected parent candle receives a complete replacement with the same timestamp and a new deterministic revision.

When the canonical head timestamp reaches an interval's `endTimestamp`, that row becomes `finalized=true`; the first observation in the next boundary creates a new mutable row. Finalization is canonical-head based rather than wall-clock based, so an idle or lagging chain is not falsely marked complete. A later canonical reorg can still replace a finalized row inside the retained reorg window.

Consumers use `(pair, interval, startTimestamp)` as identity. A same-timestamp event replaces the row; a newer timestamp appends it. An older timestamp or a reset requires a history refetch.

## Persistence, partitioning, and retention

`PostgresAnalyticsStore` commits checkpoint metadata, the new canonical block, only changed candle buckets, and the corresponding bounded replay events in one append transaction. It never rewrites historical rows on the ordinary live path. Retained reorgs and backfill finalization use an atomic full-state-and-outbox transaction that replaces the canonical branch and candle set, deleting rows absent from the recovered checkpoint. The service advances and publishes its in-memory cursor only after that transaction commits. If an outbox insert fails, PostgreSQL rolls back the canonical head and candle rows with it; a restart therefore restores either the complete old state or the complete new state and replay log, never a new candle behind an old valid cursor. A failed write remains pending and must be repaired before any later backfill, checkpoint, or head-snapshot write can proceed; an unrecoverable live-source failure closes the server. CI executes these paths against PostgreSQL and injects an outbox failure before recreating the store/service to prove atomic rollback, replay after successful restart, delta appends, orphan deletion, mutable row replacement, replay trimming, and restoration.

Production deployment uses one PostgreSQL schema per chain, which is the chain partition and prevents cross-chain keys. Within it:

- `canonical_blocks`: primary key by block number, unique hash, ordered time index in the production migration;
- `candles`: primary key `(pair, interval, start_timestamp)` and history index `(pair, interval, start_timestamp DESC)`;
- `candle_stream_events`: monotonic cursor with pair/interval columns for bounded replay.

At scale, `candles` is list-partitioned by interval, then monthly range-partitioned by `start_timestamp`; high-volume 1m partitions are hash-subpartitioned by pair. Canonical envelopes are monthly range partitions. The current store's keys and access patterns are migration-compatible, so no GraphQL or client contract changes are required.

Retention tiers:

| Data | Hot PostgreSQL | Cold/rebuild source |
| --- | --- | --- |
| canonical envelopes and swaps | 35 days | encrypted object archive for 3 years, or canonical archive-RPC replay |
| 1m | 30 days | rebuild while source coverage exists |
| 5m | 90 days | rebuild from retained 1m/source |
| 15m | 180 days | rebuild from retained 1m/source |
| 1h | 400 days | rebuild from source/1m |
| 4h | 3 years | rebuild from 1h |
| 1d / 1w | indefinite | rebuild from 1h/1d while retained |
| SSE replay | latest 2,048 events | no archive; clients reset/refetch |

Compaction never claims deleted periods are complete. Every backfill records `coverageStartTimestamp`, `coverageThroughTimestamp`, status, cursor, and error. A partial/capped backfill stays partial. The API's `pageInfo.partial` tells the chart that requested coverage is incomplete. Old history is restored from canonical source before it is advertised; fabricated candle rows are forbidden.

## Historical query contract

`pairCandles` requires a pair, interval, time range, `first`, and optional cursor. Server guarantees:

- exact normalized pair filtering before pagination;
- rows aligned to the requested interval;
- `first` from 1 through 100;
- no query window over 500 interval buckets;
- snapshot-bound pagination cursors that expire when the canonical head changes;
- canonical first/last block hashes, status, missing-price tokens, provenance, finalized state, and revision on every row;
- a `streamCursor` captured with the historical response.

Immutable finalized ranges may be cached by the API/reverse proxy. The mutable tail must use `no-store` or a short revalidation path and must never be cached as immutable.

## SSE transport, resume, and backpressure

SSE is selected because the first version is strictly server-to-client and browser `EventSource` supplies automatic reconnect plus `Last-Event-ID`. WebSockets add operational state without a client-message requirement. The endpoint is:

```text
GET /events/candles?pair=<address>&interval=<enum>&after=<streamCursor>
```

The history response cursor closes the history-to-live race. The server replays retained events after either `Last-Event-ID` (preferred) or `after`. Events are complete replacements and IDs are monotonic. A batch is persisted before the in-memory cursor advances or subscribers can observe it, so a failed replay write cannot create an unrepairable cursor gap. Duplicate delivery is harmless because clients reject lower revisions for the same timestamp. A canonical reorg emits `reset`; an invalid, future, or expired cursor emits `reset` with `stream-cursor-expired`. The client then closes the source and refetches history.

The service permits at most 500 concurrent candle subscribers per process and retains 2,048 replay events. Heartbeats are emitted every 15 seconds. The client reports stale after 45 seconds without an open, candle, or heartbeat event. When the HTTP writable buffer fills, the server closes that slow subscriber instead of retaining an unbounded per-client queue; reconnect/replay recovers it, or resets it if it fell beyond retention. Subscriber-limit rejection also sends reset and closes.

## Reorg recovery

Every block envelope includes number, hash, and parent hash. A new canonical block either appends to the head, is a duplicate, or replaces the suffix after a retained parent. A parent outside retained history fails closed and requires an operator backfill/reset.

On a retained reorg:

1. remove the orphaned canonical suffix;
2. append the replacement block;
3. replay price policies, pair state, 1m candles, flows, and positions from retained canonical envelopes;
4. rebuild 5m/15m/1h, then 4h/1d, then 1w;
5. transactionally replace persisted canonical/candle rows;
6. emit `reset`, forcing clients to refetch the canonical snapshot.

Tests prove orphaned price highs, volume, block hashes, and dependent interval rows disappear. PostgreSQL coverage proves the orphan hash is deleted on save.

## Capacity targets and observability

The executable `pnpm analytics:load` release floor uses 600 canonical blocks, 500 subscribers, and 50 fan-out events. It fails below:

- 50 canonical blocks/second in the deterministic engine;
- 10,000 subscriber deliveries/second;
- 25ms p95 in-process publish time;
- 50ms p95 bounded historical query time;
- 2KiB average serialized candle replacement.

Those are regression floors, not production SLOs. Initial production targets per process are:

- steady ingest: 100 canonical blocks/second, burst 500/second for 60 seconds;
- live update enqueue-to-SSE-write p95 under 250ms, p99 under 1 second;
- finalized-candle availability p95 under 2 seconds after canonical boundary observation;
- bounded historical query p95 under 300ms and p99 under 1 second;
- 500 live subscribers per process, horizontally scaled before 70% saturation;
- zero silent event drops; reconnects are replayed or explicitly reset.

Required metrics: canonical ingest lag, processing rate, current/finalization lag, historical latency and row counts, replay depth, resets by reason, slow-subscriber disconnects, subscribers, reorg/rebuild count and duration, backfill coverage, partial pricing, and PostgreSQL write/partition size. Alert on head lag, p99 finalization over 10 seconds, replay utilization over 80%, subscriber utilization over 80%, or any sustained persistence failure.

## Local price-movement fixture

The local deployment funds WETH/USDC with correctly single-sided liquidity on both sides of the active bin: token Y at and below, token X at and above. The secondary local curve extends to ±15 bins; the trader's startup policy remains the stricter anchor ±8 hard range and ±6 turnaround range. Local fixture depth is intentionally sized so several bounded trades consume the active bin instead of producing an indefinitely flat chart.

`pnpm market-activity:verify` is a finite Anvil-only gate. It validates manifest/pool identity, bounded allowances and balances, deliberately traverses down and back up, and fails unless both active-ID directions are observed inside the hard range. The normal `start` mode retains a trade direction while the active ID is unchanged, visibly chewing through current-bin reserves; after movement it returns to the seeded organic mean-reverting walk. `localstack:up` runs the finite gate before strict health and before starting the continuous trader. The localnet CI transaction job runs the same proof. Mainnet remains rejected without an override.

## Frontend behavior and compatibility

The chart exposes 1m, 5m, 15m, 1h, 4h, 1d, and 1w, defaulting to 1h. React Query keeps the previous successful page while a new interval loads. Lightweight Charts receives `series.update()` for append/replacement updates; a reset or non-monotonic history change uses `setData()` after refetch. The UI distinguishes loading, no activity, partial history, stale stream, and unavailable analytics. Browser tests cover all intervals, history-to-live replacement, canonical reset/refetch, 45-second stale state, and a 390px mobile viewport.

Existing hourly and daily GraphQL enum values remain `HOUR` and `DAY`; their field shapes and pagination behavior are unchanged. Existing consumers can continue using them. New consumers should handle `finalized`, `revision`, provenance, canonical hashes, and `streamCursor`; all were additive fields. Clients that cannot consume SSE may continue historical polling, but must not label the mutable tail live.
