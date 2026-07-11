#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/indexer/subgraph/docker-compose.yml"
ARTIFACT_DIR="$ROOT_DIR/.local/graph-node-e2e"
READY_ATTEMPTS="${GRAPH_NODE_E2E_READY_ATTEMPTS:-120}"
COMPOSE_PROJECT_NAME="${GRAPH_NODE_E2E_COMPOSE_PROJECT:-robinhood-lb-graph-e2e}"
GRAPH_NODE_GRAPHQL_PORT="${GRAPH_NODE_E2E_GRAPHQL_PORT:-18000}"
GRAPH_NODE_WS_PORT="${GRAPH_NODE_E2E_WS_PORT:-18001}"
GRAPH_NODE_ADMIN_PORT="${GRAPH_NODE_E2E_ADMIN_PORT:-18020}"
GRAPH_NODE_STATUS_PORT="${GRAPH_NODE_E2E_STATUS_PORT:-18030}"
GRAPH_NODE_METRICS_PORT="${GRAPH_NODE_E2E_METRICS_PORT:-18040}"
GRAPH_NODE_IPFS_PORT="${GRAPH_NODE_E2E_IPFS_PORT:-15001}"
GRAPH_NODE_POSTGRES_PORT="${GRAPH_NODE_E2E_POSTGRES_PORT:-15432}"
GRAPH_NODE_RPC_PORT="${GRAPH_NODE_E2E_RPC_PORT:-18545}"
LOCALNET_RPC_URL="${LOCALNET_RPC_URL:-http://127.0.0.1:${GRAPH_NODE_RPC_PORT}}"
LOCALNET_PID_FILE="$ARTIFACT_DIR/anvil.pid"
LOCALNET_LOG_FILE="$ARTIFACT_DIR/anvil.log"
GRAPH_NODE_ADMIN_URL="http://127.0.0.1:${GRAPH_NODE_ADMIN_PORT}/"
GRAPH_NODE_IPFS_URL="http://127.0.0.1:${GRAPH_NODE_IPFS_PORT}"
INDEXER_LOCAL_ENDPOINT="http://127.0.0.1:${GRAPH_NODE_GRAPHQL_PORT}/subgraphs/name/robinhood-lb/localnet"
STARTED_ANVIL=0
STARTED_GRAPH=0

export COMPOSE_PROJECT_NAME GRAPH_NODE_GRAPHQL_PORT GRAPH_NODE_WS_PORT
export GRAPH_NODE_ADMIN_PORT GRAPH_NODE_STATUS_PORT GRAPH_NODE_METRICS_PORT
export GRAPH_NODE_IPFS_PORT GRAPH_NODE_POSTGRES_PORT GRAPH_NODE_RPC_PORT
export GRAPH_NODE_ADMIN_URL GRAPH_NODE_IPFS_URL INDEXER_LOCAL_ENDPOINT
export LOCALNET_RPC_URL LOCALNET_PID_FILE LOCALNET_LOG_FILE

COMPOSE=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE")

mkdir -p "$ARTIFACT_DIR"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$STARTED_GRAPH" = "1" ]; then
    "${COMPOSE[@]}" logs --no-color >"$ARTIFACT_DIR/compose.log" 2>&1 || true
    "${COMPOSE[@]}" down --volumes --remove-orphans >>"$ARTIFACT_DIR/cleanup.log" 2>&1 || true
  fi
  if [ "$STARTED_ANVIL" = "1" ]; then
    bash "$ROOT_DIR/scripts/localnet/down.sh" >>"$ARTIFACT_DIR/cleanup.log" 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

for tool in anvil cast curl docker node pnpm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required Graph Node E2E tool: $tool" >&2; exit 1; }
done

rpc_probe=""
if rpc_probe="$(curl -sS --max-time 2 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$LOCALNET_RPC_URL" 2>/dev/null)" &&
  node -e 'const value=JSON.parse(process.argv[1]); if (typeof value.result !== "string") process.exit(1);' "$rpc_probe" >/dev/null 2>&1; then
  echo "Refusing to reuse an existing RPC at $LOCALNET_RPC_URL; Graph Node E2E requires an isolated chain." >&2
  exit 1
fi
if [ -n "$("${COMPOSE[@]}" ps -q 2>/dev/null)" ]; then
  echo "Refusing to reuse existing Graph Node E2E project $COMPOSE_PROJECT_NAME; stop that isolated project before retrying." >&2
  exit 1
fi

cd "$ROOT_DIR"
STARTED_ANVIL=1
LOCALNET_ANVIL_HOST="${LOCALNET_ANVIL_HOST:-0.0.0.0}" \
  LOCALNET_ANVIL_PORT="$GRAPH_NODE_RPC_PORT" \
  LOCALNET_START_ANVIL=1 \
  pnpm localnet:up

STARTED_GRAPH=1
"${COMPOSE[@]}" up -d

ready=0
for _ in $(seq 1 "$READY_ATTEMPTS"); do
  if curl -sS --max-time 2 -o /dev/null "$GRAPH_NODE_ADMIN_URL"; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "Graph Node admin endpoint did not become ready." >&2
  exit 1
fi

pnpm indexer:deploy:local
pnpm sdk:example:localnet:liquidity 2>&1 | tee "$ARTIFACT_DIR/liquidity.log"
pnpm sdk:example:localnet:swap 2>&1 | tee "$ARTIFACT_DIR/swap.log"
pnpm indexer:smoke:local
node scripts/indexer/assert-graph-node-mappings.cjs | tee "$ARTIFACT_DIR/assertions.json"
