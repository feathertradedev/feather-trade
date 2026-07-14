#!/usr/bin/env bash
set -euo pipefail

required=(
  TARGET_ENVIRONMENT
  WEB_PROMOTION_ARTIFACT
  WEB_PROMOTION_DEPLOYED_URL
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "::error::Cloudflare promotion requires $name"; exit 1; }
done

case "$TARGET_ENVIRONMENT" in
  testnet)
    project="feather-trade-testnet"
    expected_url="https://testnet.app.feather.markets"
    ;;
  mainnet)
    project="feather-trade-mainnet"
    expected_url="https://app.feather.markets"
    ;;
  *)
    echo "::error::Unsupported promotion environment: $TARGET_ENVIRONMENT"
    exit 1
    ;;
esac

[[ -d "$WEB_PROMOTION_ARTIFACT" ]] || {
  echo "::error::Sealed web artifact directory is missing"
  exit 1
}
[[ "$WEB_PROMOTION_DEPLOYED_URL" == "$expected_url" ]] || {
  echo "::error::$TARGET_ENVIRONMENT must deploy to $expected_url"
  exit 1
}

# Project, production branch, and destination are trusted constants. Candidate
# artifacts cannot select another Cloudflare project or preview branch.
pnpm exec wrangler pages deploy "$WEB_PROMOTION_ARTIFACT" \
  --project-name "$project" \
  --branch main \
  --commit-dirty=true
