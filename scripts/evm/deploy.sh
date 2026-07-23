#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REDACTOR="$ROOT_DIR/scripts/evm/redact-command-output.cjs"
VALIDATOR="$ROOT_DIR/scripts/evm/validate-manifest.cjs"
CACHE_CLEANER="$ROOT_DIR/scripts/evm/clear-sensitive-forge-cache.cjs"
ZERO_ADDRESS="0x0000000000000000000000000000000000000000"
ZERO_PRIVATE_KEY="0x0000000000000000000000000000000000000000000000000000000000000000"
PLACEHOLDER_PRIVATE_KEY="0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

# Forge can persist its RPC URL in a resumable script cache. Restrictive
# creation permissions protect transient files until the wrapper removes that
# script-specific cache on normal exit.
umask 077

load_dotenv() {
  local dotenv="$1/.env"
  local line key value

  [ -f "$dotenv" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    [ "${line:0:1}" = "#" ] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    if eval '[ "${'"$key"'+x}" = x ]'; then continue; fi
    if [[ "$value" == \"*\" && "$value" == *\" ]] || [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done <"$dotenv"
}

fail() {
  echo "$1" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required tool: $1"
}

require_value() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "Set $name before running the EVM deployer."
}

normalize_address() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

validate_address() {
  local name="$1"
  local value="${!name:-}"
  [[ "$value" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "$name must be a 20-byte 0x-prefixed EVM address."
  [ "$(normalize_address "$value")" != "$ZERO_ADDRESS" ] || fail "$name must not be the zero address."
}

validate_public_metadata_url() {
  local name="$1"
  local value="${!name:-}"
  [ -n "$value" ] || return 0
  if ! EVM_DEPLOY_METADATA_URL="$value" node -e '
    const value = process.env.EVM_DEPLOY_METADATA_URL;
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) process.exit(1);
      if (url.username || url.password || url.search || url.hash) process.exit(1);
    } catch (_) {
      process.exit(1);
    }
  '; then
    fail "$name must be an absolute public HTTP(S) URL without credentials, query parameters, or a fragment."
  fi
}

require_code() {
  local label="$1"
  local address="$2"
  local code
  if ! code="$(ETH_RPC_URL="$EVM_DEPLOY_RPC_URL" cast code "$address" 2>/dev/null)"; then
    fail "Could not read bytecode for $label from the configured RPC."
  fi
  [ -n "$code" ] && [ "$code" != "0x" ] && [ "$code" != "0x0" ] || fail "$label has no deployed bytecode on chain $EVM_DEPLOY_EXPECTED_CHAIN_ID."
}

load_dotenv "$ROOT_DIR"
cd "$ROOT_DIR"
for tool in cast forge git node tee; do require_tool "$tool"; done

EVM_DEPLOYER_PRIVATE_KEY="${EVM_DEPLOYER_PRIVATE_KEY:-${DEPLOYER_PRIVATE_KEY:-}}"
export EVM_DEPLOYER_PRIVATE_KEY

for name in EVM_DEPLOY_NETWORK EVM_DEPLOY_EXPECTED_CHAIN_ID EVM_DEPLOY_RPC_URL EVM_DEPLOY_WNATIVE_ADDRESS; do
  require_value "$name"
done

[[ "$EVM_DEPLOY_NETWORK" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail "EVM_DEPLOY_NETWORK must be a lowercase slug containing only letters, digits, and hyphens."
[[ "$EVM_DEPLOY_EXPECTED_CHAIN_ID" =~ ^[1-9][0-9]*$ ]] || fail "EVM_DEPLOY_EXPECTED_CHAIN_ID must be a positive decimal chain ID."
EVM_DEPLOY_CHAIN_ID_VALUE="$EVM_DEPLOY_EXPECTED_CHAIN_ID" node -e '
  const value = BigInt(process.env.EVM_DEPLOY_CHAIN_ID_VALUE);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) process.exit(1);
' || fail "EVM_DEPLOY_EXPECTED_CHAIN_ID must fit safely in the JSON deployment manifest."
[[ "$EVM_DEPLOYER_PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "EVM_DEPLOYER_PRIVATE_KEY must be a 32-byte 0x-prefixed private key."
[ "$(normalize_address "$EVM_DEPLOYER_PRIVATE_KEY")" != "$ZERO_PRIVATE_KEY" ] || fail "EVM_DEPLOYER_PRIVATE_KEY must not be zero."
[ "$(normalize_address "$EVM_DEPLOYER_PRIVATE_KEY")" != "$PLACEHOLDER_PRIVATE_KEY" ] || fail "EVM_DEPLOYER_PRIVATE_KEY must not use the placeholder key."
validate_address EVM_DEPLOY_WNATIVE_ADDRESS

actual_chain_id="$(ETH_RPC_URL="$EVM_DEPLOY_RPC_URL" cast chain-id 2>/dev/null)" || fail "Configured EVM deployment RPC did not return a chain ID."
[ "$actual_chain_id" = "$EVM_DEPLOY_EXPECTED_CHAIN_ID" ] || fail "RPC chain-id mismatch: expected $EVM_DEPLOY_EXPECTED_CHAIN_ID, got $actual_chain_id."
require_code EVM_DEPLOY_WNATIVE_ADDRESS "$EVM_DEPLOY_WNATIVE_ADDRESS"

seen_addresses="|$(normalize_address "$EVM_DEPLOY_WNATIVE_ADDRESS")|"
for index in 0 1 2 3; do
  name="EVM_DEPLOY_QUOTE_ASSET_$index"
  value="${!name:-}"
  [ -n "$value" ] || continue
  validate_address "$name"
  normalized="$(normalize_address "$value")"
  case "$seen_addresses" in
    *"|$normalized|"*) fail "$name duplicates wrapped native or another quote asset." ;;
  esac
  require_code "$name" "$value"
  seen_addresses="${seen_addresses}${normalized}|"
done

DRY_RUN="${DRY_RUN:-0}"
case "$DRY_RUN" in
  0|1) ;;
  *) fail "DRY_RUN must be 0 or 1." ;;
esac

if [ "$DRY_RUN" = "0" ]; then
  [ "${EVM_DEPLOY_CONFIRM_CHAIN_ID:-}" = "$EVM_DEPLOY_EXPECTED_CHAIN_ID" ] ||
    fail "Set EVM_DEPLOY_CONFIRM_CHAIN_ID=$EVM_DEPLOY_EXPECTED_CHAIN_ID to authorize this broadcast."
fi

export EVM_DEPLOY_CHAIN_NAME="${EVM_DEPLOY_CHAIN_NAME:-$EVM_DEPLOY_NETWORK}"
export EVM_DEPLOY_NATIVE_CURRENCY="${EVM_DEPLOY_NATIVE_CURRENCY:-ETH}"
export EVM_DEPLOY_RPC_ENV_VAR="${EVM_DEPLOY_RPC_ENV_VAR:-EVM_DEPLOY_RPC_URL}"
export EVM_DEPLOY_EXPLORER_URL="${EVM_DEPLOY_EXPLORER_URL:-}"
export EVM_DEPLOY_VERIFIER_URL="${EVM_DEPLOY_VERIFIER_URL:-}"
[[ "$EVM_DEPLOY_RPC_ENV_VAR" =~ ^[A-Za-z_][A-Za-z0-9_]{0,127}$ ]] ||
  fail "EVM_DEPLOY_RPC_ENV_VAR must be a valid environment variable name."
validate_public_metadata_url EVM_DEPLOY_EXPLORER_URL
validate_public_metadata_url EVM_DEPLOY_VERIFIER_URL
export EVM_DEPLOY_SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
if [ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]; then
  export EVM_DEPLOY_SOURCE_TREE_DIRTY=true
else
  export EVM_DEPLOY_SOURCE_TREE_DIRTY=false
fi

output_dir="${EVM_DEPLOY_OUTPUT_DIR:-$ROOT_DIR/deployments/evm/$EVM_DEPLOY_NETWORK}"
mkdir -p "$output_dir"
if [ "$DRY_RUN" = "1" ]; then
  final_manifest="${EVM_DEPLOY_MANIFEST_PATH:-$output_dir/dry-run.json}"
  mode="dry-run"
else
  final_manifest="${EVM_DEPLOY_MANIFEST_PATH:-$output_dir/latest.json}"
  mode="broadcast"
fi
mkdir -p "$(dirname "$final_manifest")"
pending_manifest="$(dirname "$final_manifest")/.pending-$(basename "$final_manifest").$$"
log_path="$output_dir/$mode.log"
rm -f "$pending_manifest"
clear_sensitive_forge_cache() {
  node "$CACHE_CLEANER" "$EVM_DEPLOY_EXPECTED_CHAIN_ID"
}
cleanup() {
  rm -f "$pending_manifest"
  clear_sensitive_forge_cache >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export EVM_DEPLOY_MANIFEST_PATH="$pending_manifest"

# Remove any cache left by an interrupted prior run before provider credentials
# are supplied to Forge again.
clear_sensitive_forge_cache

forge_args=(script contracts/joe-v2/script/deploy-evm.s.sol:GenericEvmDeployScript --slow)
if [ "$DRY_RUN" = "0" ]; then forge_args+=(--broadcast); fi

set +e
FOUNDRY_ETH_RPC_URL="$EVM_DEPLOY_RPC_URL" \
FOUNDRY_CACHE_PATH="$ROOT_DIR/cache" \
ETH_RPC_URL="$EVM_DEPLOY_RPC_URL" \
forge "${forge_args[@]}" 2>&1 |
  EVM_DEPLOY_REDACT_RPC_URL="$EVM_DEPLOY_RPC_URL" \
  EVM_DEPLOY_REDACT_PRIVATE_KEY="$EVM_DEPLOYER_PRIVATE_KEY" \
  node "$REDACTOR" |
  tee "$log_path"
pipeline_status=("${PIPESTATUS[@]}")
set -e

# Foundry writes the complete RPC URL to cache/deploy-evm.s.sol/<chain-id>.
# Receipts in broadcast/ remain intact; only the credential-bearing resume
# cache is removed.
clear_sensitive_forge_cache || fail "Failed to clear Forge's sensitive generic deployment cache."

[ "${pipeline_status[1]}" -eq 0 ] || fail "Failed to sanitize Forge output."
[ "${pipeline_status[2]}" -eq 0 ] || fail "Failed to write the sanitized deployment log."
if [ "${pipeline_status[0]}" -ne 0 ]; then
  exit "${pipeline_status[0]}"
fi

[ -f "$pending_manifest" ] || fail "Forge completed without writing the deployment manifest."
node "$VALIDATOR" "$pending_manifest" "$EVM_DEPLOY_NETWORK" "$EVM_DEPLOY_EXPECTED_CHAIN_ID"

if [ "$DRY_RUN" = "0" ]; then
  deployed_addresses="$(node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const address of Object.values(value.contracts || {})) console.log(address);
  ' "$pending_manifest")"
  while IFS= read -r address; do
    [ -n "$address" ] && require_code "deployed contract $address" "$address"
  done <<<"$deployed_addresses"
fi

mv -f "$pending_manifest" "$final_manifest"
trap - EXIT INT TERM

if [ "$DRY_RUN" = "1" ]; then
  forge_artifact="$ROOT_DIR/broadcast/deploy-evm.s.sol/$EVM_DEPLOY_EXPECTED_CHAIN_ID/dry-run/run-latest.json"
else
  forge_artifact="$ROOT_DIR/broadcast/deploy-evm.s.sol/$EVM_DEPLOY_EXPECTED_CHAIN_ID/run-latest.json"
fi

echo "EVM deployment $mode completed."
echo "Manifest: $final_manifest"
echo "Sanitized log: $log_path"
echo "Forge artifact: $forge_artifact"
