#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.local/full-stack"
COMPOSE_FILE="$ROOT_DIR/indexer/subgraph/docker-compose.yml"
COMPOSE_PROJECT_NAME="${FEATHER_STACK_COMPOSE_PROJECT:-feather-localstack}"
RPC_PORT="${FEATHER_STACK_RPC_PORT:-18545}"
GRAPHQL_PORT="${FEATHER_STACK_GRAPHQL_PORT:-18000}"
GRAPH_WS_PORT="${FEATHER_STACK_GRAPH_WS_PORT:-18001}"
GRAPH_ADMIN_PORT="${FEATHER_STACK_GRAPH_ADMIN_PORT:-18020}"
GRAPH_STATUS_PORT="${FEATHER_STACK_GRAPH_STATUS_PORT:-18030}"
GRAPH_METRICS_PORT="${FEATHER_STACK_GRAPH_METRICS_PORT:-18040}"
IPFS_PORT="${FEATHER_STACK_IPFS_PORT:-15001}"
POSTGRES_PORT="${FEATHER_STACK_POSTGRES_PORT:-15432}"
ANALYTICS_PORT="${FEATHER_STACK_ANALYTICS_PORT:-18787}"
WEB_PORT="${FEATHER_STACK_WEB_PORT:-15173}"
READY_ATTEMPTS="${FEATHER_STACK_READY_ATTEMPTS:-120}"

RPC_URL="http://127.0.0.1:$RPC_PORT"
INDEXER_URL="http://127.0.0.1:$GRAPHQL_PORT/subgraphs/name/robinhood-lb/localnet"
GRAPH_ADMIN_URL="http://127.0.0.1:$GRAPH_ADMIN_PORT/"
IPFS_URL="http://127.0.0.1:$IPFS_PORT"
ANALYTICS_URL="http://127.0.0.1:$ANALYTICS_PORT"
WEB_URL="http://127.0.0.1:$WEB_PORT"
MANIFEST_PATH="$ROOT_DIR/deployments/localnet/latest.json"
ANVIL_PID_FILE="$STATE_DIR/anvil.pid"
ANALYTICS_PID_FILE="$STATE_DIR/analytics.pid"
MARKET_ACTIVITY_PID_FILE="$STATE_DIR/market-activity.pid"
WEB_PID_FILE="$STATE_DIR/web.pid"
STACK_ENV_FILE="$STATE_DIR/stack.env"

PRICE_POLICIES="${ANALYTICS_PRICE_POLICIES:-$ROOT_DIR/scripts/localnet/analytics-price-policies.json}"
BLOCK_SOURCE_MODULE="${ANALYTICS_BLOCK_SOURCE_MODULE:-$ROOT_DIR/scripts/localnet/analytics-adapters.mjs}"
POSITION_SNAPSHOT_MODULE="${ANALYTICS_POSITION_SNAPSHOT_MODULE:-$ROOT_DIR/scripts/localnet/analytics-adapters.mjs}"

COMPOSE=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE")
START_FAILED=0
ACTION="${1:-help}"
FRESH=0
if [ "$#" -gt 0 ]; then shift; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --fresh) FRESH=1 ;;
    --json) ;;
    -h|--help) ACTION="help" ;;
    *) echo "Unknown local stack option: $1" >&2; exit 2 ;;
  esac
  shift
done

usage() {
  cat <<'EOF'
Usage: bash scripts/localnet/stack.sh <up|down|status> [--fresh] [--json]

  up --fresh  Replace only the owned Feather local stack, then start and health-gate every component.
  down        Stop owned web, analytics, Anvil, Graph Node, IPFS, and Postgres processes and volumes.
  status      Run the strict manifest/RPC/indexer/analytics/web health check.
EOF
}

require_tools() {
  local tool
  for tool in anvil cast curl docker node pnpm; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Missing required local stack tool: $tool" >&2; exit 1; }
  done
  docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required." >&2; exit 1; }
}

stop_pid() {
  local file="$1"
  if [ ! -f "$file" ]; then return; fi
  local pid
  pid="$(cat "$file")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then break; fi
      sleep 0.1
    done
    if kill -0 "$pid" >/dev/null 2>&1; then kill -KILL "$pid" >/dev/null 2>&1 || true; fi
  fi
  rm -f "$file"
}

stop_stack() {
  mkdir -p "$STATE_DIR"
  stop_pid "$WEB_PID_FILE"
  stop_pid "$MARKET_ACTIVITY_PID_FILE"
  stop_pid "$ANALYTICS_PID_FILE"
  "${COMPOSE[@]}" down --volumes --remove-orphans >"$STATE_DIR/compose-down.log" 2>&1 || true
  stop_pid "$ANVIL_PID_FILE"
  rm -f "$STACK_ENV_FILE"
}

wait_http() {
  local name="$1"
  local url="$2"
  for _ in $(seq 1 "$READY_ATTEMPTS"); do
    if curl -sS --max-time 2 -o /dev/null "$url"; then return; fi
    sleep 1
  done
  echo "$name did not become ready at $url" >&2
  return 1
}

wait_analytics() {
  local body='{"query":"query StackStartup { analyticsHealth { status headBlock headHash } }"}'
  for _ in $(seq 1 "$READY_ATTEMPTS"); do
    if curl -fsS --max-time 2 -H 'content-type: application/json' --data "$body" "$ANALYTICS_URL/graphql" \
      | node -e 'let text=""; process.stdin.on("data", chunk => text += chunk); process.stdin.on("end", () => { const value=JSON.parse(text); if (!value.data?.analyticsHealth) process.exit(1); });' \
      >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo "Analytics did not become queryable at $ANALYTICS_URL/graphql" >&2
  return 1
}

wait_market_activity() {
  local pid
  pid="$(cat "$MARKET_ACTIVITY_PID_FILE")"
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "Continuous market activity exited during startup." >&2
      tail -20 "$STATE_DIR/market-activity.log" >&2 || true
      return 1
    fi
    if [ -s "$STATE_DIR/market-activity.log" ]; then return; fi
    sleep 0.25
  done
  echo "Continuous market activity did not report startup progress." >&2
  return 1
}

write_stack_env() {
  umask 077
  {
    printf 'LOCALNET_RPC_URL=%q\n' "$RPC_URL"
    printf 'LOCALNET_INDEXER_URL=%q\n' "$INDEXER_URL"
    printf 'LOCALNET_MANIFEST_PATH=%q\n' "$MANIFEST_PATH"
    printf 'INDEXER_LOCAL_ENDPOINT=%q\n' "$INDEXER_URL"
    printf 'ANALYTICS_LOCAL_ENDPOINT=%q\n' "$ANALYTICS_URL"
    printf 'MARKET_ACTIVITY_RPC_URL=%q\n' "$RPC_URL"
    printf 'MARKET_ACTIVITY_MANIFEST_PATH=%q\n' "$MANIFEST_PATH"
    printf 'FEATHER_WEB_URL=%q\n' "$WEB_URL"
    printf 'FEATHER_STACK_COMPOSE_PROJECT=%q\n' "$COMPOSE_PROJECT_NAME"
  } >"$STACK_ENV_FILE"
}

start_stack() {
  require_tools
  if [ "$FRESH" != "1" ]; then
    echo "Refusing a non-fresh start. Use localstack:up or pass --fresh." >&2
    exit 1
  fi

  stop_stack
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR/analytics"
  if ! node "$ROOT_DIR/scripts/localnet/check-port-available.cjs" "$RPC_PORT"; then
    echo "Refusing to start: configured RPC port $RPC_PORT is occupied after owned-stack cleanup." >&2
    exit 1
  fi

  START_FAILED=1
  cleanup_failed_start() {
    local status=$?
    trap - EXIT INT TERM
    if [ "${START_FAILED:-1}" = "1" ]; then stop_stack; fi
    exit "$status"
  }
  trap cleanup_failed_start EXIT INT TERM

  export COMPOSE_PROJECT_NAME
  export GRAPH_NODE_GRAPHQL_PORT="$GRAPHQL_PORT"
  export GRAPH_NODE_WS_PORT="$GRAPH_WS_PORT"
  export GRAPH_NODE_ADMIN_PORT="$GRAPH_ADMIN_PORT"
  export GRAPH_NODE_STATUS_PORT="$GRAPH_STATUS_PORT"
  export GRAPH_NODE_METRICS_PORT="$GRAPH_METRICS_PORT"
  export GRAPH_NODE_IPFS_PORT="$IPFS_PORT"
  export GRAPH_NODE_POSTGRES_PORT="$POSTGRES_PORT"
  export GRAPH_NODE_RPC_PORT="$RPC_PORT"
  export GRAPH_NODE_ADMIN_URL="$GRAPH_ADMIN_URL"
  export GRAPH_NODE_IPFS_URL="$IPFS_URL"
  export INDEXER_LOCAL_ENDPOINT="$INDEXER_URL"
  export LOCALNET_RPC_URL="$RPC_URL"
  export LOCALNET_INDEXER_URL="$INDEXER_URL"
  export LOCALNET_MANIFEST_PATH="$MANIFEST_PATH"

  nohup anvil --silent --host 0.0.0.0 --port "$RPC_PORT" --chain-id 31337 --base-fee 0 --gas-limit 30000000 \
    >"$STATE_DIR/anvil.log" 2>&1 </dev/null &
  local anvil_pid="$!"
  echo "$anvil_pid" >"$ANVIL_PID_FILE"
  kill -0 "$anvil_pid" >/dev/null 2>&1 || { echo "Owned Anvil exited before RPC readiness polling." >&2; exit 1; }
  for _ in $(seq 1 80); do
    kill -0 "$anvil_pid" >/dev/null 2>&1 || { echo "Owned Anvil exited before RPC became ready." >&2; exit 1; }
    if cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  kill -0 "$anvil_pid" >/dev/null 2>&1 || { echo "Owned Anvil exited during RPC readiness." >&2; exit 1; }
  [ "$(cast chain-id --rpc-url "$RPC_URL")" = "31337" ] || { echo "Owned Anvil has the wrong chain ID." >&2; exit 1; }

  (cd "$ROOT_DIR" && pnpm localnet:deploy) >"$STATE_DIR/deploy.log" 2>&1
  local manifest_sha256
  manifest_sha256="$(node -e 'const crypto=require("node:crypto"); const fs=require("node:fs"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));' "$MANIFEST_PATH")"
  "${COMPOSE[@]}" up -d >"$STATE_DIR/compose-up.log" 2>&1
  wait_http "Graph Node admin" "$GRAPH_ADMIN_URL"
  (cd "$ROOT_DIR" && pnpm indexer:deploy:local) >"$STATE_DIR/indexer-deploy.log" 2>&1
  (cd "$ROOT_DIR" && pnpm sdk:build && pnpm market-activity:build) >"$STATE_DIR/market-activity-build.log" 2>&1

  [ -f "$PRICE_POLICIES" ] || { echo "Missing local analytics policies: $PRICE_POLICIES" >&2; exit 1; }
  [ -f "$BLOCK_SOURCE_MODULE" ] || { echo "Missing local analytics block-source adapter: $BLOCK_SOURCE_MODULE" >&2; exit 1; }
  [ -f "$POSITION_SNAPSHOT_MODULE" ] || { echo "Missing local analytics position adapter: $POSITION_SNAPSHOT_MODULE" >&2; exit 1; }
  (cd "$ROOT_DIR" && pnpm analytics:build) >"$STATE_DIR/analytics-build.log" 2>&1
  nohup env \
    ANALYTICS_HOST=127.0.0.1 \
    ANALYTICS_PORT="$ANALYTICS_PORT" \
    ANALYTICS_STATE_PATH="$STATE_DIR/analytics/checkpoint.json" \
    ANALYTICS_DATABASE_URL="postgres://graph-node:graph-node@127.0.0.1:$POSTGRES_PORT/graph-node" \
    ANALYTICS_PRICE_POLICIES="$PRICE_POLICIES" \
    ANALYTICS_BLOCK_SOURCE_MODULE="$BLOCK_SOURCE_MODULE" \
    ANALYTICS_POSITION_SNAPSHOT_MODULE="$POSITION_SNAPSHOT_MODULE" \
    ANALYTICS_ALLOW_FIXED_TEST_PRICES=1 \
    ANALYTICS_ENVIRONMENT=localnet \
    ANALYTICS_MAX_HEAD_LAG_SECONDS=86400 \
    ANALYTICS_CORS_ORIGINS="$WEB_URL,http://localhost:$WEB_PORT" \
    LOCALNET_RPC_URL="$RPC_URL" \
    LOCALNET_INDEXER_URL="$INDEXER_URL" \
    LOCALNET_MANIFEST_PATH="$MANIFEST_PATH" \
    INDEXER_LOCAL_ENDPOINT="$INDEXER_URL" \
    pnpm --dir "$ROOT_DIR" --filter @robinhood-lb/analytics start \
    >"$STATE_DIR/analytics.log" 2>&1 </dev/null &
  echo "$!" >"$ANALYTICS_PID_FILE"

  nohup env \
    VITE_LOCALNET_MANIFEST_PATH="$MANIFEST_PATH" \
    VITE_LOCALNET_MANIFEST_SHA256="$manifest_sha256" \
    VITE_LOCALNET_RPC_URL="$RPC_URL" \
    VITE_LOCALNET_INDEXER_URL="$INDEXER_URL" \
    VITE_ANALYTICS_LOCALNET_URL="$ANALYTICS_URL/graphql" \
    pnpm --dir "$ROOT_DIR/apps/web" exec vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort \
    >"$STATE_DIR/web.log" 2>&1 </dev/null &
  echo "$!" >"$WEB_PID_FILE"

  wait_analytics
  wait_http "Web" "$WEB_URL"
  write_stack_env

  # Fail startup unless the local WETH/USDC fixture can move the active bin in
  # both directions while the dev trader enforces its hard range.
  env \
    MARKET_ACTIVITY_RPC_URL="$RPC_URL" \
    MARKET_ACTIVITY_PRIVATE_KEY="${MARKET_ACTIVITY_PRIVATE_KEY:-${LOCALNET_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}}" \
    MARKET_ACTIVITY_MANIFEST_PATH="$MANIFEST_PATH" \
    MARKET_ACTIVITY_RANDOM_SEED="1723928558" \
    node "$ROOT_DIR/packages/dev-market-activity/dist/src/cli.js" verify \
    >"$STATE_DIR/market-activity-verification.log" 2>&1

  (cd "$ROOT_DIR" && node scripts/localnet/check-stack-health.cjs \
    --strict --json \
    --manifest "$MANIFEST_PATH" \
    --rpc-url "$RPC_URL" \
    --indexer-url "$INDEXER_URL" \
    --analytics-url "$ANALYTICS_URL" \
    --web-url "$WEB_URL") | tee "$STATE_DIR/health.json"

  # Establish one stable, fully validated analytics checkpoint before the
  # continuous trader begins advancing the local chain.
  nohup env \
    MARKET_ACTIVITY_RPC_URL="$RPC_URL" \
    MARKET_ACTIVITY_PRIVATE_KEY="${MARKET_ACTIVITY_PRIVATE_KEY:-${LOCALNET_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}}" \
    MARKET_ACTIVITY_MANIFEST_PATH="$MANIFEST_PATH" \
    node "$ROOT_DIR/packages/dev-market-activity/dist/src/cli.js" start \
    >"$STATE_DIR/market-activity.log" 2>&1 </dev/null &
  echo "$!" >"$MARKET_ACTIVITY_PID_FILE"
  wait_market_activity

  START_FAILED=0
  trap - EXIT INT TERM
}

case "$ACTION" in
  up) start_stack ;;
  down) require_tools; stop_stack; node -e 'console.log(JSON.stringify({ok:true,action:"down",owned:true}))' ;;
  status) node "$ROOT_DIR/scripts/localnet/check-stack-health.cjs" --strict --json --manifest "$MANIFEST_PATH" --rpc-url "$RPC_URL" --indexer-url "$INDEXER_URL" --analytics-url "$ANALYTICS_URL" --web-url "$WEB_URL" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
