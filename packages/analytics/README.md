# Feather analytics core

`@robinhood-lb/analytics` is the deterministic aggregation and accounting core
behind the Wave 3 analytics API. It consumes canonical block envelopes rather
than reconstructing history in a browser.

The package provides:

- trusted, policy-gated USD price samples;
- exact 24-hour pool volume, total swap fee, protocol swap fee, LP-net swap fee,
  TVL, and LP-net fee/TVL metrics;
- 1m, 5m, 15m, 1h, 4h, 1d, and Monday-aligned 1w OHLC/volume/fee/TVL candles;
- bounded historical GraphQL pages plus resumable SSE candle replacements;
- grouped owner/pair/bin balances with cost basis and realized/unrealized P&L;
- parent-hash reorg rollback and deterministic replay;
- resumable, capped backfill helpers and cursor-limited query methods; and
- health state that reports partial valuation and missing price tokens.

All USD integers use 18-decimal fixed point. Query fields become `null` and the
row becomes `partial` when required pricing or history is unavailable; the
engine never silently substitutes zero, a pool spot price, or a stablecoin peg.

`SwapAnalyticsEvent.feeX/feeY` remain the legacy total trader-paid swap-fee
fields for checkpoint compatibility. New adapters also supply indexed
`protocolFeeX/protocolFeeY`; LP-net fees are exactly total minus protocol. If a
legacy checkpoint lacks either protocol field, total fees remain queryable but
protocol and LP-net values are `null`, `feeBreakdownComplete` is false, and the
row is partial. Composition fees and flash-loan fees are separate event classes
and are never included in these swap-fee metrics.

Run:

```sh
pnpm analytics:typecheck
pnpm analytics:test
pnpm analytics:load
```

The accepted boundaries, rollup DAG, mutable/finalized lifecycle, PostgreSQL
retention/partition plan, SSE resume/backpressure behavior, reorg recovery,
compatibility contract, and capacity targets are documented in
[`docs/wave-5/candle-architecture.md`](../../docs/wave-5/candle-architecture.md).

`AnalyticsApiService` implements `schema.graphql`, persists canonical blocks and
coverage state through atomic checkpoints, restores on restart, and exposes a
runnable HTTP server:

```sh
pnpm analytics:build

ANALYTICS_PRICE_POLICIES=/absolute/path/price-policies.json \
ANALYTICS_PRICE_VERIFIER_MODULE=/absolute/path/chainlink-verifier.mjs \
ANALYTICS_BLOCK_SOURCE_MODULE=/absolute/path/archive-block-source.mjs \
ANALYTICS_POSITION_SNAPSHOT_MODULE=/absolute/path/position-snapshot-provider.mjs \
ANALYTICS_CORS_ORIGINS=https://app.testnet.example.com \
ANALYTICS_STATE_PATH=.local/analytics/checkpoint.json \
ANALYTICS_INGEST_TOKEN='replace-with-a-secret' \
pnpm --filter @robinhood-lb/analytics start
```

The server binds to `127.0.0.1:8787` by default. `POST /graphql` serves bounded
queries. `POST /internal/blocks` accepts tagged-JSON `BlockSubmission` payloads
containing signed reports—not caller verification flags—only with the configured
bearer token; ingestion stays disabled if no token is configured. Use exported
`encodeTaggedJson` for bigint-safe payloads.

`ANALYTICS_CORS_ORIGINS` is a comma-separated exact-origin allowlist for the
browser-facing `/graphql` endpoint. Allowed origins receive bounded OPTIONS
preflight responses and CORS headers; wildcards are not supported and the
authenticated ingestion endpoint is never exposed through CORS. A same-origin
reverse proxy may leave the allowlist empty.

The CLI refuses to serve until `ANALYTICS_BLOCK_SOURCE_MODULE` completes a
canonical startup reconciliation. The module exports `createBlockSource()`,
returning `fetchPage(cursor)` and optionally `startupCursor(checkpoint)` and
`followLive(ingest, reconcileHead)`. Sources must explicitly attest a persisted
cursor through `startupCursor`; otherwise startup replays from the source's
beginning. The local adapter always returns `null` so its process-local pool
progression and canonical hash window are rebuilt deterministically from the
manifest `startBlock`. Backfill status/cursor/error and coverage bounds are
checkpointed, and partial/capped startup exits rather than serving incomplete
state as ready. A canonical block source and position snapshot module are
required at startup; authenticated `/internal/blocks` is only an additional
ingestion path.

`ANALYTICS_PRICE_VERIFIER_MODULE` exports `createPriceVerifier()`, returning a
`PriceSampleVerifier`. The verifier receives the signed Chainlink report and
must authenticate/decode it with the current Chainlink verifier/SDK; only the
trusted sample it returns reaches the engine. The service rejects missing,
forged, or mismatched reports and cannot be bypassed with a caller-provided
boolean. `fixed-test` pricing is disabled by default. Source/feed/freshness/
confidence checks are independently enforced inside the replay core.

`ANALYTICS_POSITION_SNAPSHOT_MODULE` exports
`createPositionSnapshotProvider()`. The provider performs a bounded owner query
at the requested canonical head and returns raw per-bin token claims. The
service attaches/reconciles those snapshots at that exact head before resolving
`walletPositions`; it never enumerates every holder on every block.
