#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID_FILE="${LOCALNET_PID_FILE:-$ROOT_DIR/.local/anvil.pid}"

if [ ! -f "$PID_FILE" ]; then
  echo "No local Anvil pid file found."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill "$PID" >/dev/null 2>&1; then
  echo "Stopped Anvil process $PID"
else
  echo "Anvil process $PID was not running."
fi

rm -f "$PID_FILE"
