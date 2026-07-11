#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIGURED_ROBINHOOD_ENV="${ROBINHOOD_ENV:-}"
DEFAULT_ROBINHOOD_ENV="${CONFIGURED_ROBINHOOD_ENV:-testnet}"
DEFAULT_MANIFEST="$ROOT_DIR/deployments/robinhood/$DEFAULT_ROBINHOOD_ENV/latest.json"
MANIFEST_PATH="${ROBINHOOD_MANIFEST_PATH:-${INDEXER_ROBINHOOD_MANIFEST:-$DEFAULT_MANIFEST}}"
VERSION_LABEL="${GOLDSKY_VERSION_LABEL:-v0.1.0}"
GOLDSKY_CLI_NPX_PACKAGE="${GOLDSKY_CLI_NPX_PACKAGE:-@goldskycom/cli@13.5.0}"

if [ ! -f "$MANIFEST_PATH" ]; then
  echo "Robinhood deployment manifest not found at $MANIFEST_PATH." >&2
  echo "Set ROBINHOOD_MANIFEST_PATH or INDEXER_ROBINHOOD_MANIFEST to a broadcast manifest." >&2
  exit 1
fi

node "$ROOT_DIR/scripts/manifests/validate-manifests.cjs" "$MANIFEST_PATH"
MANIFEST_ENV="$(node -e 'const fs=require("node:fs"); const manifest=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(manifest.environment);' "$MANIFEST_PATH")"

if [ -n "$CONFIGURED_ROBINHOOD_ENV" ] && [ "$CONFIGURED_ROBINHOOD_ENV" != "$MANIFEST_ENV" ]; then
  echo "ROBINHOOD_ENV=$CONFIGURED_ROBINHOOD_ENV does not match manifest environment $MANIFEST_ENV." >&2
  exit 1
fi

SUBGRAPH_NAME="${GOLDSKY_SUBGRAPH_NAME:-robinhood-lb-$MANIFEST_ENV}"

GOLDSKY_CLI=(goldsky)
if ! command -v goldsky >/dev/null 2>&1; then
  if command -v npx >/dev/null 2>&1; then
    GOLDSKY_CLI=(npx --yes "$GOLDSKY_CLI_NPX_PACKAGE")
  else
    echo "Goldsky CLI is not installed or not on PATH, and npx is unavailable." >&2
    echo "Install and authenticate the Goldsky CLI, or install Node.js/npm so npx can run $GOLDSKY_CLI_NPX_PACKAGE." >&2
    exit 1
  fi
fi

if [ -n "${GOLDSKY_TOKEN:-${GOLDSKY_API_KEY:-}}" ]; then
  echo "GOLDSKY_TOKEN/GOLDSKY_API_KEY is set, but this wrapper will not pass secrets through process arguments." >&2
  echo "Run 'goldsky login' or 'npx --yes $GOLDSKY_CLI_NPX_PACKAGE login' first." >&2
  exit 1
fi

echo "Rendering Robinhood subgraph from $MANIFEST_PATH"
ROBINHOOD_ENV="$MANIFEST_ENV" ROBINHOOD_MANIFEST_PATH="$MANIFEST_PATH" pnpm indexer:generate:robinhood
pnpm indexer:codegen:rendered
pnpm indexer:build:rendered

(
  cd "$ROOT_DIR/indexer/subgraph"
  "${GOLDSKY_CLI[@]}" subgraph deploy "$SUBGRAPH_NAME/$VERSION_LABEL" --path .
)

cat <<EOF

Goldsky deploy command finished for $SUBGRAPH_NAME/$VERSION_LABEL.

Record the returned GraphQL endpoint in the promoted deployment manifest:
  endpoints.indexerUrl

Then validate:
  pnpm manifests:validate <manifest>
  ROBINHOOD_MANIFEST_PATH=<manifest> INDEXER_ROBINHOOD_ENDPOINT=<endpoint> INDEXER_ROBINHOOD_RPC_URL=<archive-rpc> pnpm indexer:smoke:robinhood
EOF
