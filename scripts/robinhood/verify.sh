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
require_tool jq
assert_rpc_chain_id

MANIFEST_PATH="${ROBINHOOD_MANIFEST_PATH:-$ROOT_DIR/deployments/robinhood/$ROBINHOOD_ENV/latest.json}"
if [ ! -f "$MANIFEST_PATH" ]; then
  echo "No manifest found at $MANIFEST_PATH" >&2
  exit 1
fi

manifest_chain_id="$(jq -r '.chainId' "$MANIFEST_PATH")"
if [ "$manifest_chain_id" != "$RH_CHAIN_ID" ]; then
  echo "Manifest chain-id mismatch: expected $RH_CHAIN_ID for $ROBINHOOD_ENV, got $manifest_chain_id in $MANIFEST_PATH" >&2
  exit 1
fi

manifest_verifier_url="$(jq -r '.chain.verifierUrl // empty' "$MANIFEST_PATH")"
VERIFIER_URL="${manifest_verifier_url:-$RH_VERIFIER_URL}"

VERIFY_WATCH="${VERIFY_WATCH:-1}"
if [ "$VERIFY_WATCH" != "1" ]; then
  echo "VERIFY_WATCH must be 1; verification success must prove terminal Blockscout confirmation." >&2
  exit 1
fi
WATCH_ARGS=(--watch)

verify_contract() {
  local address="$1"
  local contract_id="$2"
  local constructor_args="${3:-}"

  local args=(
    verify-contract "$address" "$contract_id"
    --chain-id "$RH_CHAIN_ID"
    --verifier blockscout
    --verifier-url "$VERIFIER_URL"
  )

  if [ -n "$constructor_args" ]; then
    args+=(--constructor-args "$constructor_args")
  fi

  run_forge_with_redacted_output forge "${args[@]}" "${WATCH_ARGS[@]}"
}

factory="$(jq -r '.contracts.lbFactory' "$MANIFEST_PATH")"
pair_implementation="$(jq -r '.contracts.lbPairImplementation' "$MANIFEST_PATH")"
router="$(jq -r '.contracts.lbRouter' "$MANIFEST_PATH")"
quoter="$(jq -r '.contracts.lbQuoter' "$MANIFEST_PATH")"

fee_recipient="$(jq -r '.constructorArgs.feeRecipient' "$MANIFEST_PATH")"
initial_owner="$(jq -r '.constructorArgs.initialOwner' "$MANIFEST_PATH")"
flash_loan_fee="$(jq -r '.constructorArgs.flashLoanFee' "$MANIFEST_PATH")"
router_factory_v1="$(jq -r '.constructorArgs.routerFactoryV1' "$MANIFEST_PATH")"
router_legacy_factory_v2="$(jq -r '.constructorArgs.routerLegacyFactoryV2' "$MANIFEST_PATH")"
router_legacy_router_v2="$(jq -r '.constructorArgs.routerLegacyRouterV2' "$MANIFEST_PATH")"
router_factory_v2_1="$(jq -r '.constructorArgs.routerFactoryV2_1' "$MANIFEST_PATH")"
router_wnative="$(jq -r '.constructorArgs.routerWNative' "$MANIFEST_PATH")"
quoter_factory_v1="$(jq -r '.constructorArgs.quoterFactoryV1' "$MANIFEST_PATH")"
quoter_legacy_factory_v2="$(jq -r '.constructorArgs.quoterLegacyFactoryV2' "$MANIFEST_PATH")"
quoter_factory_v2_1="$(jq -r '.constructorArgs.quoterFactoryV2_1' "$MANIFEST_PATH")"
quoter_factory_v2_2="$(jq -r '.constructorArgs.quoterFactoryV2_2' "$MANIFEST_PATH")"
quoter_legacy_router_v2="$(jq -r '.constructorArgs.quoterLegacyRouterV2' "$MANIFEST_PATH")"
quoter_router_v2_1="$(jq -r '.constructorArgs.quoterRouterV2_1' "$MANIFEST_PATH")"
quoter_router_v2_2="$(jq -r '.constructorArgs.quoterRouterV2_2' "$MANIFEST_PATH")"

factory_args="$(cast abi-encode 'constructor(address,address,uint256)' "$fee_recipient" "$initial_owner" "$flash_loan_fee")"
pair_args="$(cast abi-encode 'constructor(address)' "$factory")"
router_args="$(
  cast abi-encode 'constructor(address,address,address,address,address,address)' \
    "$factory" \
    "$router_factory_v1" \
    "$router_legacy_factory_v2" \
    "$router_legacy_router_v2" \
    "$router_factory_v2_1" \
    "$router_wnative"
)"
quoter_args="$(
  cast abi-encode 'constructor(address,address,address,address,address,address,address)' \
    "$quoter_factory_v1" \
    "$quoter_legacy_factory_v2" \
    "$quoter_factory_v2_1" \
    "$quoter_factory_v2_2" \
    "$quoter_legacy_router_v2" \
    "$quoter_router_v2_1" \
    "$quoter_router_v2_2"
)"

verify_contract "$factory" contracts/joe-v2/src/LBFactory.sol:LBFactory "$factory_args"
verify_contract "$pair_implementation" contracts/joe-v2/src/LBPair.sol:LBPair "$pair_args"
verify_contract "$router" contracts/joe-v2/src/LBRouter.sol:LBRouter "$router_args"
verify_contract "$quoter" contracts/joe-v2/src/LBQuoter.sol:LBQuoter "$quoter_args"
