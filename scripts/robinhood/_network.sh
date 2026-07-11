#!/usr/bin/env bash

load_dotenv() {
  local root_dir="$1"
  local dotenv="$root_dir/.env"
  local line key value

  [ -f "$dotenv" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"

    if [ -z "$line" ] || [ "${line:0:1}" = "#" ]; then
      continue
    fi

    if [[ "$line" == export\ * ]]; then
      line="${line#export }"
    fi

    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      continue
    fi

    key="${line%%=*}"
    value="${line#*=}"

    if eval '[ "${'"$key"'+x}" = x ]'; then
      continue
    fi

    if [[ "$value" == \"*\" && "$value" == *\" ]] || [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done <"$dotenv"
}

select_robinhood_network() {
  ROBINHOOD_ENV="${ROBINHOOD_ENV:-testnet}"

  case "$ROBINHOOD_ENV" in
    mainnet)
      RH_CHAIN_NAME="Robinhood Chain"
      RH_CHAIN_ID="4663"
      RH_RPC_ENV_VAR="ROBINHOOD_RPC_URL"
      RH_RPC_URL="${ROBINHOOD_RPC_URL:-}"
      RH_PUBLIC_RPC_URL="https://rpc.mainnet.chain.robinhood.com"
      RH_EXPLORER_URL="https://robinhoodchain.blockscout.com"
      RH_VERIFIER_URL="https://robinhoodchain.blockscout.com/api/"
      ;;
    testnet)
      RH_CHAIN_NAME="Robinhood Chain Testnet"
      RH_CHAIN_ID="46630"
      RH_RPC_ENV_VAR="ROBINHOOD_TESTNET_RPC_URL"
      RH_RPC_URL="${ROBINHOOD_TESTNET_RPC_URL:-}"
      RH_PUBLIC_RPC_URL="https://rpc.testnet.chain.robinhood.com"
      RH_EXPLORER_URL="https://explorer.testnet.chain.robinhood.com"
      RH_VERIFIER_URL="https://explorer.testnet.chain.robinhood.com/api/"
      ;;
    *)
      echo "Unsupported ROBINHOOD_ENV=$ROBINHOOD_ENV. Use testnet or mainnet." >&2
      exit 1
      ;;
  esac

  if [ -z "$RH_RPC_URL" ]; then
    echo "Set $RH_RPC_ENV_VAR to an explicit provider RPC for $RH_CHAIN_NAME deploy/verify operations." >&2
    exit 1
  fi

  if ROBINHOOD_CANDIDATE_RPC_URL="$RH_RPC_URL" \
    ROBINHOOD_CANONICAL_PUBLIC_RPC_URL="$RH_PUBLIC_RPC_URL" \
    node -e '
      const candidate = new URL(process.env.ROBINHOOD_CANDIDATE_RPC_URL);
      const canonical = new URL(process.env.ROBINHOOD_CANONICAL_PUBLIC_RPC_URL);
      const normalizePath = (value) => value.pathname.replace(/\/+$/, "");
      const normalizeHost = (value) => value.hostname.toLowerCase().replace(/\.+$/, "");
      const sameEndpoint =
        candidate.protocol === canonical.protocol &&
        normalizeHost(candidate) === normalizeHost(canonical) &&
        candidate.port === canonical.port &&
        normalizePath(candidate) === normalizePath(canonical);
      process.exit(sameEndpoint ? 0 : 1);
    ' 2>/dev/null; then
    echo "$RH_RPC_ENV_VAR must be a provider RPC; the canonical public Robinhood RPC is prohibited for deploy/verify operations." >&2
    exit 1
  fi

  export ROBINHOOD_DEPLOYMENT_ENV="$ROBINHOOD_ENV"
  export ROBINHOOD_EXPECTED_CHAIN_ID="$RH_CHAIN_ID"
  export ROBINHOOD_CHAIN_NAME="$RH_CHAIN_NAME"
  export ROBINHOOD_EXPLORER_URL="$RH_EXPLORER_URL"
  export ROBINHOOD_VERIFIER_URL="$RH_VERIFIER_URL"
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 1
  fi
}

require_deployer_private_key() {
  RH_PRIVATE_KEY="${ROBINHOOD_DEPLOYER_PRIVATE_KEY:-${DEPLOYER_PRIVATE_KEY:-}}"
  local normalized="${RH_PRIVATE_KEY#0x}"

  if [ -z "$RH_PRIVATE_KEY" ] ||
    [ "$normalized" = "0000000000000000000000000000000000000000000000000000000000000000" ] ||
    [ "$normalized" = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" ]; then
    echo "Set ROBINHOOD_DEPLOYER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY to a real deployer key." >&2
    exit 1
  fi

  export ROBINHOOD_DEPLOYER_PRIVATE_KEY="$RH_PRIVATE_KEY"
}

assert_rpc_chain_id() {
  local actual_chain_id

  if ! actual_chain_id="$(ETH_RPC_URL="$RH_RPC_URL" cast chain-id 2>/dev/null)"; then
    echo "Configured provider RPC did not return a chain ID for $ROBINHOOD_ENV." >&2
    exit 1
  fi

  if [ "$actual_chain_id" != "$RH_CHAIN_ID" ]; then
    echo "RPC chain-id mismatch for $ROBINHOOD_ENV: expected $RH_CHAIN_ID, got $actual_chain_id." >&2
    exit 1
  fi
}

run_forge_with_redacted_output() {
  local redactor
  local -a pipeline_status
  redactor="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/redact-command-output.cjs"

  set +e
  ETH_RPC_URL="$RH_RPC_URL" "$@" 2>&1 |
    ROBINHOOD_REDACT_RPC_URL="$RH_RPC_URL" \
      ROBINHOOD_REDACT_PRIVATE_KEY="${ROBINHOOD_DEPLOYER_PRIVATE_KEY:-}" \
      node "$redactor"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e

  if [ "${pipeline_status[1]}" -ne 0 ]; then
    echo "Failed to sanitize Forge command output." >&2
    return 1
  fi

  return "${pipeline_status[0]}"
}
