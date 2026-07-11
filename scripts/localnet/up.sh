#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEFAULT_RPC_URL="http://127.0.0.1:8545"
RPC_URL="${LOCALNET_RPC_URL:-$DEFAULT_RPC_URL}"
CHAIN_ID="${LOCALNET_CHAIN_ID:-31337}"
ANVIL_HOST="${LOCALNET_ANVIL_HOST:-127.0.0.1}"
ANVIL_PORT="${LOCALNET_ANVIL_PORT:-8545}"
START_CUSTOM_ANVIL="${LOCALNET_START_ANVIL:-0}"
LOCAL_DIR="$ROOT_DIR/.local"
PID_FILE="${LOCALNET_PID_FILE:-$LOCAL_DIR/anvil.pid}"
LOG_FILE="${LOCALNET_LOG_FILE:-$LOCAL_DIR/anvil.log}"

mkdir -p "$LOCAL_DIR" "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

if cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  echo "Using existing local RPC at $RPC_URL"
else
  if [ "$RPC_URL" != "$DEFAULT_RPC_URL" ] && [ "$START_CUSTOM_ANVIL" != "1" ]; then
    echo "No RPC responded at $RPC_URL. Start that custom RPC first, or set LOCALNET_START_ANVIL=1 with LOCALNET_ANVIL_PORT." >&2
    exit 1
  fi

  echo "Starting Anvil on $RPC_URL with host binding $ANVIL_HOST"
  nohup anvil --host "$ANVIL_HOST" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --base-fee 0 --gas-limit 30000000 \
    >"$LOG_FILE" 2>&1 </dev/null &
  ANVIL_PID="$!"
  echo "$ANVIL_PID" >"$PID_FILE"
  disown "$ANVIL_PID" 2>/dev/null || true

  for _ in $(seq 1 40); do
    if cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done

  if ! cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
    echo "Anvil did not become ready. See $LOG_FILE" >&2
    exit 1
  fi
fi

bash "$ROOT_DIR/scripts/localnet/deploy.sh"
