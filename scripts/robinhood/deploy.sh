#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=_network.sh
source "$ROOT_DIR/scripts/robinhood/_network.sh"

load_dotenv "$ROOT_DIR"
require_tool node
select_robinhood_network
require_tool cast
require_tool forge
require_deployer_private_key
assert_rpc_chain_id

DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" = "1" ]; then
  DEFAULT_MANIFEST_PATH="$ROOT_DIR/deployments/robinhood/$ROBINHOOD_ENV/dry-run.json"
  BROADCAST_ARGS=()
  echo "Dry-running Robinhood deployment on $RH_CHAIN_NAME ($RH_CHAIN_ID). No transactions will be broadcast."
else
  DEFAULT_MANIFEST_PATH="$ROOT_DIR/deployments/robinhood/$ROBINHOOD_ENV/latest.json"
  BROADCAST_ARGS=(--broadcast)
fi

if [ "$ROBINHOOD_ENV" = "mainnet" ] && [ "$DRY_RUN" != "1" ] && [ "${CONFIRM_MAINNET:-0}" != "1" ]; then
  echo "Set CONFIRM_MAINNET=1 to broadcast to Robinhood Chain mainnet." >&2
  exit 1
fi

if [ "$DRY_RUN" != "1" ]; then
  echo "Broadcasting Robinhood deployment on $RH_CHAIN_NAME ($RH_CHAIN_ID)."
fi

export ROBINHOOD_MANIFEST_PATH="${ROBINHOOD_MANIFEST_PATH:-$DEFAULT_MANIFEST_PATH}"
mkdir -p "$(dirname "$ROBINHOOD_MANIFEST_PATH")"

cd "$ROOT_DIR"
run_forge_with_redacted_output forge script contracts/joe-v2/script/deploy-robinhood.s.sol:RobinhoodDeployScript \
  "${BROADCAST_ARGS[@]}"
