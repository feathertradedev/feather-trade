#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROBINHOOD_ENV="${ROBINHOOD_ENV:-testnet}"
DEFAULT_MANIFEST="$ROOT_DIR/deployments/robinhood/$ROBINHOOD_ENV/latest.json"
MANIFEST_PATH="${ROBINHOOD_MANIFEST_PATH:-${INDEXER_ROBINHOOD_MANIFEST:-$DEFAULT_MANIFEST}}"
OUT_DIR="$ROOT_DIR/.local"
META_OUT_FILE="$OUT_DIR/subgraph-smoke-robinhood-meta.json"
OUT_FILE="$OUT_DIR/subgraph-smoke-robinhood.json"
BINS_OUT_FILE="$OUT_DIR/subgraph-smoke-robinhood-bins.json"
ERROR_FILE="$OUT_DIR/subgraph-smoke-robinhood-error.log"
MAX_ATTEMPTS="${INDEXER_ROBINHOOD_SMOKE_ATTEMPTS:-120}"
SLEEP_SECONDS="${INDEXER_ROBINHOOD_SMOKE_SLEEP_SECONDS:-1}"
CURL_TIMEOUT_SECONDS="${INDEXER_ROBINHOOD_SMOKE_CURL_TIMEOUT_SECONDS:-15}"

mkdir -p "$OUT_DIR"

if [ ! -f "$MANIFEST_PATH" ]; then
  echo "Robinhood deployment manifest not found at $MANIFEST_PATH." >&2
  echo "Set ROBINHOOD_MANIFEST_PATH or INDEXER_ROBINHOOD_MANIFEST to a broadcast manifest." >&2
  exit 1
fi

ENDPOINT="${INDEXER_ROBINHOOD_ENDPOINT:-$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log((m.endpoints && m.endpoints.indexerUrl) || "")' "$MANIFEST_PATH")}"
RPC_URL="${INDEXER_ROBINHOOD_RPC_URL:-$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log((m.endpoints && m.endpoints.rpcUrl) || "")' "$MANIFEST_PATH")}"

if [ -z "$ENDPOINT" ] || [ "$ENDPOINT" = "null" ]; then
  echo "Set INDEXER_ROBINHOOD_ENDPOINT or endpoints.indexerUrl in $MANIFEST_PATH." >&2
  exit 1
fi

if [ -z "$RPC_URL" ] || [ "$RPC_URL" = "null" ]; then
  echo "Set INDEXER_ROBINHOOD_RPC_URL or endpoints.rpcUrl in $MANIFEST_PATH for RPC-backed data checks." >&2
  exit 1
fi

META_QUERY='query RobinhoodMeta { _meta { block { number hash } hasIndexingErrors } }'
META_BODY="$(node -e 'process.stdout.write(JSON.stringify({query: process.argv[1]}))' "$META_QUERY")"
SNAPSHOT_QUERY='query RobinhoodSnapshot($block: Int!) { factories(first: 25, block: { number: $block }) { id pairCount quoteAssetCount presetCount } pairs(first: 100, orderBy: updatedAtBlock, orderDirection: desc, block: { number: $block }) { id factory { id } tokenX { id } tokenY { id } binStep activeId reserveX reserveY totalVolumeX totalVolumeY swapCount depositCount withdrawCount transferCount } swaps(first: 100, orderBy: timestamp, orderDirection: desc, block: { number: $block }) { id pair { id } activeId amountsIn amountInX amountInY amountsOut amountOutX amountOutY transactionHash } liquidityEvents(first: 100, orderBy: timestamp, orderDirection: desc, block: { number: $block }) { id pair { id } type ids amounts amountX amountY transactionHash } positions(first: 100, where: { liquidity_gt: 0 }, block: { number: $block }) { id pair { id } owner liquidity bin { binId } } }'

for _ in $(seq 1 "$MAX_ATTEMPTS"); do
  if ! RPC_HEAD_BLOCK="$(ETH_RPC_URL="$RPC_URL" cast block-number 2>/dev/null)"; then
    printf '%s\n' "Configured RPC did not return a head block." >"$ERROR_FILE"
    sleep "$SLEEP_SECONDS"
    continue
  fi

  if ! curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" -H "Content-Type: application/json" --data "$META_BODY" "$ENDPOINT" >"$META_OUT_FILE"; then
    printf '%s\n' "Indexer metadata request failed." >"$ERROR_FILE"
    sleep "$SLEEP_SECONDS"
    continue
  fi

  if ! SNAPSHOT_BLOCK="$(node - "$META_OUT_FILE" 2>/dev/null <<'NODE'
const fs = require("node:fs");
const response = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const block = response && response.data && response.data._meta && response.data._meta.block;
if (!block || !Number.isInteger(Number(block.number)) || Number(block.number) < 0 || typeof block.hash !== "string") process.exit(1);
process.stdout.write(String(block.number));
NODE
  )"; then
    printf '%s\n' "Indexer metadata did not contain a valid block snapshot." >"$ERROR_FILE"
    sleep "$SLEEP_SECONDS"
    continue
  fi

  SNAPSHOT_BODY="$(node -e 'process.stdout.write(JSON.stringify({query: process.argv[1], variables: {block: Number(process.argv[2])}}))' "$SNAPSHOT_QUERY" "$SNAPSHOT_BLOCK")"
  if ! curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" -H "Content-Type: application/json" --data "$SNAPSHOT_BODY" "$ENDPOINT" >"$OUT_FILE"; then
    printf '%s\n' "Pinned indexer snapshot request failed." >"$ERROR_FILE"
    sleep "$SLEEP_SECONDS"
    continue
  fi

  if ! node - "$META_OUT_FILE" "$OUT_FILE" 2>/dev/null <<'NODE'
const fs = require("node:fs");
const metaPath = process.argv[2];
const responsePath = process.argv[3];
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
if (!response.data || typeof response.data !== "object") response.data = {};
response.data._meta = meta.data && meta.data._meta;
response.errors = [...(Array.isArray(meta.errors) ? meta.errors : []), ...(Array.isArray(response.errors) ? response.errors : [])];
if (response.errors.length === 0) delete response.errors;
fs.writeFileSync(responsePath, `${JSON.stringify(response, null, 2)}\n`);
NODE
  then
    printf '%s\n' "Pinned indexer snapshot response was malformed." >"$ERROR_FILE"
    : >"$OUT_FILE"
    sleep "$SLEEP_SECONDS"
    continue
  fi

  if ! BIN_BODY="$(
    node - "$OUT_FILE" "${INDEXER_ROBINHOOD_EXPECT_PAIRS:-}" "$SNAPSHOT_BLOCK" 2>/dev/null <<'NODE'
const fs = require("node:fs");
const response = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expectedPairs = new Set(String(process.argv[3] || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
const block = Number(process.argv[4]);
const pairs = Array.isArray(response.data && response.data.pairs) ? response.data.pairs : [];
const ids = pairs
  .filter((pair) => expectedPairs.size === 0 || expectedPairs.has(String(pair.id || "").toLowerCase()))
  .slice(0, 5)
  .filter((pair) => /^0x[0-9a-fA-F]{40}$/.test(String(pair.id || "")) && pair.activeId != null)
  .map((pair) => `${String(pair.id).toLowerCase()}-${String(pair.activeId)}`);
if (ids.length > 0) {
  process.stdout.write(JSON.stringify({
    query: "query RobinhoodActiveBins($ids: [ID!]!, $block: Int!) { bins(first: 500, where: { id_in: $ids }, block: { number: $block }) { id pair { id } binId totalSupply reserveX reserveY } }",
    variables: { ids, block }
  }));
}
NODE
  )"; then
    printf '%s\n' "Pinned indexer snapshot could not be prepared for active-bin validation." >"$ERROR_FILE"
    sleep "$SLEEP_SECONDS"
    continue
  fi

  if [ -n "$BIN_BODY" ]; then
    if ! curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" -H "Content-Type: application/json" --data "$BIN_BODY" "$ENDPOINT" >"$BINS_OUT_FILE"; then
      printf '%s\n' "Pinned active-bin request failed." >"$ERROR_FILE"
      sleep "$SLEEP_SECONDS"
      continue
    fi
    if ! node - "$OUT_FILE" "$BINS_OUT_FILE" 2>/dev/null <<'NODE'
const fs = require("node:fs");
const responsePath = process.argv[2];
const binsResponsePath = process.argv[3];
const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
const binsResponse = JSON.parse(fs.readFileSync(binsResponsePath, "utf8"));
if (Array.isArray(binsResponse.errors) && binsResponse.errors.length > 0) response.errors = [...(response.errors || []), ...binsResponse.errors];
response.data.bins = Array.isArray(binsResponse.data && binsResponse.data.bins) ? binsResponse.data.bins : [];
fs.writeFileSync(responsePath, `${JSON.stringify(response, null, 2)}\n`);
NODE
    then
      printf '%s\n' "Pinned active-bin response was malformed." >"$ERROR_FILE"
      : >"$BINS_OUT_FILE"
      sleep "$SLEEP_SECONDS"
      continue
    fi
  else
    if ! node - "$OUT_FILE" 2>/dev/null <<'NODE'
const fs = require("node:fs");
const responsePath = process.argv[2];
const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
response.data.bins = [];
fs.writeFileSync(responsePath, `${JSON.stringify(response, null, 2)}\n`);
NODE
    then
      printf '%s\n' "Pinned indexer snapshot could not record an empty active-bin result." >"$ERROR_FILE"
      sleep "$SLEEP_SECONDS"
      continue
    fi
  fi

  if ETH_RPC_URL="$RPC_URL" node "$ROOT_DIR/scripts/indexer/validate-smoke-robinhood.cjs" \
    "$OUT_FILE" \
    "$MANIFEST_PATH" \
    "${INDEXER_ROBINHOOD_EXPECT_PAIRS:-}" \
    "$RPC_HEAD_BLOCK" 2>"$ERROR_FILE"; then
    exit 0
  fi
  sleep "$SLEEP_SECONDS"
done

echo "Robinhood subgraph smoke did not pass in time." >&2
cat "$ERROR_FILE" >&2 || true
cat "$OUT_FILE" >&2 || true
exit 1
