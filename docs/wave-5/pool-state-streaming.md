# Pool-state streaming architecture

Status: accepted for Wave 5 / issue #69
Scope: canonical pool state, bounded liquidity-bin replacements, and live delivery. This decision does not authorize contract or production transaction-builder changes.

## Decision summary

Pool-state updates use the same canonical block envelopes, reorg handling, PostgreSQL commit, and replayable delivery path as the candle implementation in issue #66. There is no second chain-ingestion pipeline. Each canonical block can produce at most one end-of-block `PoolStateObservation` per touched or newly discovered pair. It contains a complete scalar/fee snapshot and absolute replacements for only the relevant bins; it never contains arithmetic bin deltas.

The local adapter emits the manifest chain ID on every block. Every log-derived event retains the indexer's event ID, transaction hash, log index, and deterministic in-block sequence. Block snapshots use a deterministic identity derived from the canonical block hash and pair. These identities make an exact duplicate idempotent and make a conflicting duplicate fail closed.

## Canonical adapter contract

For each requested block, the local source verifies all three views before emitting anything:

1. the RPC block number, hash, parent hash, and timestamp;
2. the indexer `_meta` number and hash at that exact block;
3. every pool/token `eth_call` pinned to that same block number.

The source rejects a chain ID different from the localnet manifest, any indexer error, an RPC/indexer hash mismatch, a capped 1,000-row Graph response, malformed source identity, or malformed ABI output. Fixed local price samples remain test-only. Active-bin chart pricing remains separate from trusted TVL pricing as specified by issue #80.

The source keeps a bounded 256-block logical view of prior pair activity while it follows the local chain. Before each page it compares the last overlapping cached canonical hash to RPC and walks backward to the retained common ancestor when necessary. A same-height or retained deeper replacement is therefore re-emitted from the first changed block instead of being missed because the numeric cursor is already past the head. A pure head-height rollback emits an explicit rewind target even when no replacement child exists yet. Every completed page also attests the exact RPC/indexer canonical head; after ingesting the page, the service reconciles to that head. A reorg deeper than the retained canonical window fails closed.

On every startup, including when persisted coverage was previously complete, the service completes canonical reconciliation before opening its HTTP listener. A source must explicitly opt into a persisted startup cursor. The local adapter instead starts at the manifest `startBlock` on its first page because its prior-active-ID progression and bounded hash cache are process-local inputs to deterministic block envelopes. Replaying from deployment reconstructs those inputs byte-for-byte, exposes every replacement ancestor after an offline reorg—even when the new branch has already regrown beyond the saved cursor—and then resumes ordinary page cursors. The completed page exact-attests the RPC/indexer head. Restored state is therefore never externally queryable before ordinary downtime advances or an offline rollback/orphan suffix have passed through the canonical pipeline.

## Absolute bin observations

The visible market window is centered on the current active ID with radius 40. Initial pair discovery reads the complete bounded `activeId - 40 … activeId + 40` window, clamped to the `uint24` domain, and sets `replaceBinWindow=true`.

After discovery, one block's affected set is formed from:

- every bin crossed from the prior active ID through sequential swap active IDs;
- every bin ID named by a deposit or withdrawal;
- the final active bin;
- newly visible edge bins introduced when the active-centered window moves.

The adapter exact-reads each selected bin using:

- `getBin(uint24)` (`0x0abe9688`) for absolute `reserveX` and `reserveY`;
- `totalSupply(uint256)` (`0xbd85b039`) for absolute LP-token supply.

At most 81 sparse bins are read for an incremental update. If a large crossing or affected set would exceed that cap, the adapter does not truncate it. It emits a complete replacement of the new bounded active-centered window and sets `replaceBinWindow=true`. Full-state/backfill handoffs are independently filtered to the same active ID ±40 window before entering the replay log, even if PostgreSQL retains more previously observed bins. Consumers apply replacements and then prune their display cache to the same active-centered window.

Fee state is exact-read once for every emitted pool observation using:

- `getStaticFeeParameters()` (`0x7ca0de30`);
- `getVariableFeeParameters()` (`0x8d7024e5`).

The observation's `sourceEventIds` names the ordered canonical swap/liquidity events that caused it. Initial/full block snapshots also include their canonical snapshot identity. Mint/burn `TransferBatch` logs used to resolve a liquidity owner's identity are consumed once and are not emitted again as position transfers.

## Historical handoff and live replacements

The historical pool-state query returns a bounded snapshot plus a stream cursor captured with that snapshot. Query resolvers wait for any pending canonical state/outbox transaction, so a bootstrap can never expose engine state paired with an older durable cursor. The SSE endpoint accepts the pair and `after` cursor, while `Last-Event-ID` takes precedence on reconnect. The initial `after` handoff is not counted as an operational reconnect; only a transport-supplied `Last-Event-ID` is. Deployment uses one schema/service per chain, matching the candle partitioning decision. A pool update is a complete scalar state replacement plus absolute replacements for only its `binReplacements`.

Clients apply an update only when its chain and normalized pair match the selected market. Duplicate event IDs and lower/equal revisions are no-ops. `replaceBinWindow=true`, a reorg reset, an expired cursor, or a conflicting identity discards the live bin cache and refetches the canonical snapshot. Candle and pool updates share canonical block ingestion, persistence, and one monotonic replay cursor; endpoint filters keep each subscriber scoped to its requested data.

If the initial pool-state query is temporarily unavailable, the client retries at the bounded workspace refresh interval only until it obtains a snapshot and stream cursor. After that handoff succeeds, polling remains disabled so an older bootstrap can never overwrite newer sparse stream replacements.

Transaction construction continues to use head-pinned RPC/indexer safety reads. Live analytics state drives display and immediate query invalidation only; it is not substituted into production swap or liquidity transaction builders.

## Backpressure, recovery, and observability

Replay is bounded both per topic and globally: each candle/pool topic retains at most 2,048 events, while the process and PostgreSQL outbox retain at most 8,192 events across all topics. Global eviction advances a shared dropped-through floor, so a reconnect that could have missed any evicted event receives an explicit reset. Empty topic buffers are removed rather than accumulated. SSE writes honor the HTTP writable-buffer result; a slow subscriber is disconnected instead of receiving an unbounded per-client queue. Heartbeats and client stale detection follow the candle transport contract.

On a retained replacement or pure head rollback, the canonical engine removes the orphaned suffix, rebuilds pair/bin state from canonical observations, commits canonical state and replay events atomically, and then emits reset. Orphaned bin, fee, reserve, price, and active-ID state cannot survive the refetch. Canonical fee observations are range-checked against their packed contract lanes and protocol invariants before materialization.

The service exports the issue #69 operations metrics for:

- canonical ingest lag and pool-update delivery lag;
- current subscriber count;
- transport reconnects;
- slow-subscriber, invalid-cursor, subscriber-limit, listener, serialization, and transport drops by reason;
- reorg rebuild count and duration;

Pricing and backfill readiness remain available through the existing `analyticsHealth` contract; a persistence failure fails the atomic mutation and gates bootstrap reads rather than publishing an undurable metric snapshot.

Tests cover source/chain identity, exact block pinning, absolute bin and fee decoding, initial and incremental bounds, newly visible edge bins, over-cap replacement, exact duplicate suppression, conflicting duplicate rejection, same-height and pure-head reorg recovery, deterministic fresh-source replay after offline regrowth, replay/reset behavior, atomic outbox migration, and bounded slow subscribers.
