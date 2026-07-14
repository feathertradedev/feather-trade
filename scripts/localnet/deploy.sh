#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RPC_URL="${LOCALNET_RPC_URL:-http://127.0.0.1:8545}"
PRIVATE_KEY="${LOCALNET_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

if ! cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  echo "No local RPC responded at $RPC_URL. Run pnpm localnet:up first, or set LOCALNET_RPC_URL." >&2
  exit 1
fi

cd "$ROOT_DIR"
forge script contracts/joe-v2/script/deploy-local.s.sol:LocalnetDeployScript \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --private-key "$PRIVATE_KEY"

LOCALNET_RPC_URL="$RPC_URL" \
LOCALNET_MANIFEST_PATH="${LOCALNET_MANIFEST_PATH:-$ROOT_DIR/deployments/localnet/latest.json}" \
LOCALNET_PRIVATE_KEY="$PRIVATE_KEY" \
  bash "$ROOT_DIR/scripts/localnet/seed-liquidity.sh"
