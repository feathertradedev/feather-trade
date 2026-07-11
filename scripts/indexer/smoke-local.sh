#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENDPOINT="${INDEXER_LOCAL_ENDPOINT:-http://localhost:8000/subgraphs/name/robinhood-lb/localnet}"
RPC_URL="${LOCALNET_RPC_URL:-http://127.0.0.1:8545}"
MANIFEST_PATH="${LOCALNET_MANIFEST_PATH:-${INDEXER_LOCAL_MANIFEST:-$ROOT_DIR/deployments/localnet/latest.json}}"
OUT_DIR="$ROOT_DIR/.local"
OUT_FILE="$OUT_DIR/subgraph-smoke.json"
ERROR_FILE="$OUT_DIR/subgraph-smoke-error.log"

mkdir -p "$OUT_DIR"

if [ ! -f "$MANIFEST_PATH" ]; then
  echo "Local deployment manifest not found at $MANIFEST_PATH. Run pnpm localnet:up first." >&2
  exit 1
fi

CURRENT_BLOCK_HASH="$(cast block latest --rpc-url "$RPC_URL" --json | jq -r '.hash')"

QUERY='{ _meta { block { number hash } hasIndexingErrors } factories(first: 25) { id pairCount quoteAssetCount presetCount } pairs(first: 100) { id factory { id } binStep reserveX reserveY totalVolumeX totalVolumeY swapCount depositCount withdrawCount transferCount tokenX { id } tokenY { id } } swaps(first: 100) { id pair { id } activeId amountsIn amountInX amountInY amountsOut amountOutX amountOutY } liquidityEvents(first: 100, where: { type: "DEPOSIT" }) { id pair { id } type ids amounts amountX amountY } positions(first: 100, where: { liquidity_gt: 0 }) { id pair { id } owner liquidity bin { binId } } }'
BODY="$(node -e 'console.log(JSON.stringify({ query: process.argv[1] }))' "$QUERY")"

for _ in $(seq 1 120); do
  if curl -fsS -H "Content-Type: application/json" --data "$BODY" "$ENDPOINT" >"$OUT_FILE"; then
    if node "$ROOT_DIR/scripts/indexer/validate-smoke-local.cjs" "$OUT_FILE" "$MANIFEST_PATH" "$CURRENT_BLOCK_HASH" 2>"$ERROR_FILE"; then
      exit 0
    fi
  fi
  sleep 1
done

echo "Subgraph did not return the current manifest factory, seeded pair(s), swap, liquidity event, and LP position in time." >&2
cat "$ERROR_FILE" >&2 || true
cat "$OUT_FILE" >&2 || true
exit 1
