#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::VPS web promotion failed: $1" >&2
  exit 1
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "protected environment value $name is required"
}

for name in \
  WEB_PROMOTION_ENVIRONMENT \
  WEB_PROMOTION_COMMIT \
  WEB_PROMOTION_ARTIFACT \
  WEB_PROMOTION_MANIFEST \
  WEB_PROMOTION_ARCHIVE \
  WEB_PROMOTION_CUSTODY \
  WEB_PROMOTION_DEPLOYED_URL \
  WEB_VPS_DEPLOYED_ORIGIN \
  WEB_VPS_DOCS_ORIGIN \
  WEB_VPS_SSH_HOST \
  WEB_VPS_SSH_USER \
  WEB_VPS_SSH_PORT \
  WEB_VPS_RELEASE_ROOT \
  WEB_VPS_SSH_PRIVATE_KEY \
  WEB_VPS_SSH_KNOWN_HOSTS
do
  require_env "$name"
done

[[ "$WEB_PROMOTION_ENVIRONMENT" == "sepolia" || "$WEB_PROMOTION_ENVIRONMENT" == "testnet" || "$WEB_PROMOTION_ENVIRONMENT" == "mainnet" ]] || fail "environment is invalid"
[[ "$WEB_PROMOTION_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "immutable commit is invalid"
[[ -d "$WEB_PROMOTION_ARTIFACT" ]] || fail "verified artifact directory is unavailable"
[[ -f "$WEB_PROMOTION_ARTIFACT/index.html" ]] || fail "verified artifact is missing index.html"
[[ -f "$WEB_PROMOTION_MANIFEST" ]] || fail "verified manifest is unavailable"
[[ -f "$WEB_PROMOTION_ARCHIVE" ]] || fail "sealed promotion archive is unavailable"
[[ -f "$WEB_PROMOTION_CUSTODY" ]] || fail "custody envelope is unavailable"
[[ "$WEB_VPS_SSH_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "SSH user is invalid"
[[ "$WEB_VPS_SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || fail "SSH host is invalid"
[[ "$WEB_VPS_SSH_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || fail "SSH port is invalid"
(( WEB_VPS_SSH_PORT >= 1 && WEB_VPS_SSH_PORT <= 65535 )) || fail "SSH port is invalid"
[[ "$WEB_VPS_RELEASE_ROOT" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail "release root is invalid"
[[ "$WEB_VPS_RELEASE_ROOT" != "/" && "$WEB_VPS_RELEASE_ROOT" != */ && "$WEB_VPS_RELEASE_ROOT" != *..* && "$WEB_VPS_RELEASE_ROOT" != *//* ]] || fail "release root is invalid"
[[ "$WEB_VPS_SSH_PRIVATE_KEY" == *"PRIVATE KEY"* ]] || fail "SSH private key is invalid"
[[ -n "${WEB_VPS_SSH_KNOWN_HOSTS//$'\n'/}" ]] || fail "SSH known-hosts data is invalid"

if ! docs_origin="$(node - "$WEB_PROMOTION_DEPLOYED_URL" "$WEB_VPS_DEPLOYED_ORIGIN" "$WEB_VPS_DOCS_ORIGIN" <<'NODE'
const [actualValue, expectedValue, docsValue] = process.argv.slice(2);
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) process.exit(1);
  return url.origin;
}
const actualOrigin = origin(actualValue);
const expectedOrigin = origin(expectedValue);
const docsOrigin = origin(docsValue);
if (actualOrigin !== expectedOrigin || docsOrigin === expectedOrigin) process.exit(1);
process.stdout.write(docsOrigin);
NODE
)"
then
  fail "deployed app or docs URL does not match the protected VPS origins"
fi

if ! archive_digest="$(node - "$WEB_PROMOTION_CUSTODY" "$WEB_PROMOTION_ARCHIVE" "$WEB_PROMOTION_ENVIRONMENT" "$WEB_PROMOTION_COMMIT" 2>/dev/null <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const [custodyPath, archivePath, environment, commit] = process.argv.slice(2);
const custody = JSON.parse(fs.readFileSync(custodyPath, "utf8"));
if (custody.schemaVersion !== "robinhood.web-promotion-custody.v1") throw new Error("unsupported custody envelope");
if (custody.environment !== environment || custody.repositoryCommit !== commit) throw new Error("custody identity mismatch");
if (!/^[0-9a-f]{64}$/.test(custody.archiveSha256 ?? "")) throw new Error("custody digest is invalid");
const archive = fs.readFileSync(archivePath);
if (archive.byteLength !== custody.archiveBytes) throw new Error("archive byte count mismatch");
const actual = crypto.createHash("sha256").update(archive).digest("hex");
if (actual !== custody.archiveSha256) throw new Error("archive digest mismatch");
process.stdout.write(actual);
NODE
)"
then
  fail "sealed promotion archive failed custody verification"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
remote_helper="$script_dir/promote-web-vps-remote.sh"
smoke_checker="$script_dir/../web/check-hosted-release.cjs"
analytics_smoke_checker="$script_dir/../web/check-hosted-analytics.cjs"
[[ -f "$remote_helper" ]] || fail "remote promotion helper is unavailable"
[[ -f "$smoke_checker" ]] || fail "hosted release smoke checker is unavailable"
[[ -f "$analytics_smoke_checker" ]] || fail "hosted analytics smoke checker is unavailable"

ssh_bin="${WEB_PROMOTION_SSH_BIN:-ssh}"
scp_bin="${WEB_PROMOTION_SCP_BIN:-scp}"
smoke_bin="${WEB_PROMOTION_SMOKE_BIN:-}"
analytics_smoke_bin="${WEB_PROMOTION_ANALYTICS_SMOKE_BIN:-}"
lease_seconds="${WEB_PROMOTION_LEASE_SECONDS:-300}"
if [[ -n "${WEB_PROMOTION_SSH_BIN:-}${WEB_PROMOTION_SCP_BIN:-}${WEB_PROMOTION_SMOKE_BIN:-}${WEB_PROMOTION_ANALYTICS_SMOKE_BIN:-}${WEB_PROMOTION_LEASE_SECONDS:-}" && "${WEB_PROMOTION_TEST_MODE:-0}" != "1" ]]; then
  fail "transport and smoke binary overrides require WEB_PROMOTION_TEST_MODE=1"
fi
[[ "$lease_seconds" =~ ^[0-9]+$ ]] && (( lease_seconds >= 1 && lease_seconds <= 900 )) || fail "activation lease is invalid"
if [[ "${WEB_PROMOTION_TEST_MODE:-0}" != "1" ]] && (( lease_seconds < 30 )); then
  fail "production activation lease must be at least 30 seconds"
fi
smoke_command=(node "$smoke_checker")
[[ -z "$smoke_bin" ]] || smoke_command=("$smoke_bin")
analytics_smoke_command=(node "$analytics_smoke_checker")
[[ -z "$analytics_smoke_bin" ]] || analytics_smoke_command=("$analytics_smoke_bin")

work_dir="$(mktemp -d)"
chmod 700 "$work_dir"
key_file="$work_dir/id"
known_hosts_file="$work_dir/known_hosts"
umask 077
printf '%s\n' "$WEB_VPS_SSH_PRIVATE_KEY" > "$key_file"
printf '%s\n' "$WEB_VPS_SSH_KNOWN_HOSTS" > "$known_hosts_file"

ssh_options=(
  -F /dev/null
  -i "$key_file"
  -p "$WEB_VPS_SSH_PORT"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$known_hosts_file"
  -o GlobalKnownHostsFile=/dev/null
  -o PasswordAuthentication=no
  -o KbdInteractiveAuthentication=no
  -o ClearAllForwardings=yes
  -o ConnectTimeout=15
  -o LogLevel=ERROR
  -o RequestTTY=no
)
scp_options=(
  -F /dev/null
  -i "$key_file"
  -P "$WEB_VPS_SSH_PORT"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$known_hosts_file"
  -o GlobalKnownHostsFile=/dev/null
  -o PasswordAuthentication=no
  -o KbdInteractiveAuthentication=no
  -o ClearAllForwardings=yes
  -o ConnectTimeout=15
  -o LogLevel=ERROR
)

target="$WEB_VPS_SSH_USER@$WEB_VPS_SSH_HOST"
run_token="${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-0}"
[[ "$run_token" =~ ^[A-Za-z0-9._-]+$ ]] || fail "promotion run identity is invalid"
remote_archive="$WEB_VPS_RELEASE_ROOT/.incoming/$WEB_PROMOTION_ENVIRONMENT-$WEB_PROMOTION_COMMIT-$run_token.tar.gz"
remote_watchdog_helper="$WEB_VPS_RELEASE_ROOT/.incoming/$WEB_PROMOTION_ENVIRONMENT-$WEB_PROMOTION_COMMIT-$run_token.helper.sh"
watchdog_helper_digest="$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$remote_helper")"
[[ "$watchdog_helper_digest" =~ ^[0-9a-f]{64}$ ]] || fail "watchdog helper digest is invalid"
remote_prepared=0
activation_attempted=0
activated=0
smoke_succeeded=0
rollback_target=""
activation_id=""
activation_mode=""

parse_activation_status() {
  local output="$1"
  local active_pattern=$'^PROMOTION_STATUS=active\nPROMOTION_PREVIOUS_TARGET=(none|releases/[0-9a-f]{40}/dist)\nPROMOTION_ACTIVATION_ID=([0-9]+:[0-9]+)$'
  if [[ "$output" =~ $active_pattern ]]; then
    rollback_target="${BASH_REMATCH[1]}"
    activation_id="${BASH_REMATCH[2]}"
    activation_mode="pending"
    return 0
  fi
  if [[ "$output" == "PROMOTION_STATUS=already-confirmed" ]]; then
    activation_mode="already-confirmed"
    return 0
  fi
  if [[ "$output" == "PROMOTION_STATUS=absent" || "$output" == "PROMOTION_STATUS=inactive" ]]; then
    return 2
  fi
  if [[ "$output" == "PROMOTION_STATUS=pending" ]]; then
    return 3
  fi
  return 1
}

query_activation_status() {
  local output
  if ! output="$("$ssh_bin" "${ssh_options[@]}" "$target" sh -s -- status \
    "$WEB_VPS_RELEASE_ROOT" "$WEB_PROMOTION_ENVIRONMENT" "$WEB_PROMOTION_COMMIT" "$archive_digest" "$run_token" < "$remote_helper")"
  then
    return 1
  fi
  parse_activation_status "$output"
}

guarded_record_rollback() {
  local output
  if ! output="$("$ssh_bin" "${ssh_options[@]}" "$target" sh -s -- recover-rollback \
    "$WEB_VPS_RELEASE_ROOT" "$WEB_PROMOTION_ENVIRONMENT" "$WEB_PROMOTION_COMMIT" "$archive_digest" "$run_token" < "$remote_helper")"
  then
    return 1
  fi
  if [[ "$output" == "PROMOTION_ROLLBACK=restored" ]]; then
    rollback_outcome="restored"
    return 0
  fi
  if [[ "$output" == "PROMOTION_ROLLBACK=not-current" ]]; then
    rollback_outcome="not-current"
    return 0
  fi
  if [[ "$output" == "PROMOTION_ROLLBACK=confirmed" ]]; then
    rollback_outcome="confirmed"
    return 0
  fi
  return 1
}

attempt_guarded_rollback() {
  local attempt status
  rollback_outcome=""
  [[ "$activation_attempted" == "1" ]] || return 0
  for attempt in 1 2 3; do
    if guarded_record_rollback; then
      return 0
    fi
    if query_activation_status; then
      continue
    else
      status=$?
      if [[ "$status" == "2" ]]; then
        rollback_outcome="not-current"
        return 0
      fi
    fi
  done
  return 1
}

confirm_activation() {
  local attempt output
  for attempt in 1 2 3; do
    if output="$("$ssh_bin" "${ssh_options[@]}" "$target" sh -s -- confirm \
      "$WEB_VPS_RELEASE_ROOT" "$WEB_PROMOTION_ENVIRONMENT" "$WEB_PROMOTION_COMMIT" "$archive_digest" "$run_token" < "$remote_helper")"
    then
      [[ "$output" == "PROMOTION_CONFIRM=confirmed" ]] && return 0
    fi
  done
  return 1
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if (( activation_attempted == 1 && smoke_succeeded == 0 )); then
    attempt_guarded_rollback >/dev/null 2>&1 || true
  fi
  if (( remote_prepared == 1 )); then
    "$ssh_bin" "${ssh_options[@]}" "$target" sh -s -- cleanup "$WEB_VPS_RELEASE_ROOT" "$remote_archive" "$remote_watchdog_helper" \
      "$WEB_PROMOTION_ENVIRONMENT" "$WEB_PROMOTION_COMMIT" "$archive_digest" "$run_token" < "$remote_helper" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! "$ssh_bin" "${ssh_options[@]}" "$target" sh -s -- prepare \
  "$WEB_VPS_RELEASE_ROOT" "$WEB_PROMOTION_ENVIRONMENT" "$WEB_PROMOTION_COMMIT" "$remote_archive" "$remote_watchdog_helper" "$archive_digest" "$run_token" < "$remote_helper"
then
  fail "remote release staging failed"
fi
remote_prepared=1

if ! "$scp_bin" "${scp_options[@]}" -- "$WEB_PROMOTION_ARCHIVE" "$target:$remote_archive"
then
  fail "sealed archive transport failed"
fi
if ! "$scp_bin" "${scp_options[@]}" -- "$remote_helper" "$target:$remote_watchdog_helper"
then
  fail "watchdog helper transport failed"
fi

activation_attempted=1
activation_transport_ok=0
if activation_output="$("$ssh_bin" "${ssh_options[@]}" "$target" sh -s -- promote \
  "$WEB_VPS_RELEASE_ROOT" "$WEB_PROMOTION_ENVIRONMENT" "$WEB_PROMOTION_COMMIT" "$archive_digest" "$remote_archive" "$run_token" "$remote_watchdog_helper" "$watchdog_helper_digest" "$lease_seconds" < "$remote_helper")"
then
  activation_transport_ok=1
fi

activation_status=1
if (( activation_transport_ok == 1 )); then
  if parse_activation_status "$activation_output"; then
    activation_status=0
  else
    activation_status=$?
  fi
fi

if (( activation_status != 0 )); then
  if query_activation_status; then
    activation_status=0
  else
    activation_status=$?
  fi
fi

if (( activation_status == 0 )); then
  remote_prepared=0
  if [[ "$activation_mode" == "pending" ]]; then
    activated=1
  else
    activation_attempted=0
  fi
elif (( activation_status == 2 )); then
  activation_attempted=0
  fail "remote release activation did not become current"
else
  if attempt_guarded_rollback; then
    activation_attempted=0
    fail "remote release activation result was ambiguous; any matching unsmoked activation was guardedly rolled back"
  fi
  fail "remote release activation result was ambiguous and could not be reconciled or guardedly rolled back"
fi

smoke_args=(
  --url "$WEB_PROMOTION_DEPLOYED_URL"
  --dist "$WEB_PROMOTION_ARTIFACT"
  --manifest "$WEB_PROMOTION_MANIFEST"
  --docs-url "$docs_origin/docs"
)
if ! "${smoke_command[@]}" "${smoke_args[@]}"; then
  if [[ "$activation_mode" == "already-confirmed" ]]; then
    fail "hosted app/docs smoke failed; the previously confirmed current release was left unchanged"
  fi
  if attempt_guarded_rollback; then
    activated=0
    activation_attempted=0
    if [[ "$rollback_outcome" == "restored" ]]; then
      fail "hosted app/docs smoke failed; the prior verified release was restored"
    fi
    fail "hosted app/docs smoke failed; guarded rollback could not restore because this activation was no longer current"
  fi
  fail "hosted app/docs smoke failed and guarded rollback could not restore the prior release"
fi

analytics_smoke_args=(
  --origin "$WEB_PROMOTION_DEPLOYED_URL"
  --manifest "$WEB_PROMOTION_MANIFEST"
)
if ! "${analytics_smoke_command[@]}" "${analytics_smoke_args[@]}"; then
  if [[ "$activation_mode" == "already-confirmed" ]]; then
    fail "hosted analytics smoke failed; the previously confirmed current release was left unchanged"
  fi
  if attempt_guarded_rollback; then
    activated=0
    activation_attempted=0
    if [[ "$rollback_outcome" == "restored" ]]; then
      fail "hosted analytics smoke failed; the prior verified release was restored"
    fi
    fail "hosted analytics smoke failed; guarded rollback could not restore because this activation was no longer current"
  fi
  fail "hosted analytics smoke failed and guarded rollback could not restore the prior release"
fi

if [[ "$activation_mode" == "already-confirmed" ]]; then
  smoke_succeeded=1
  echo "VPS web promotion completed for immutable commit $WEB_PROMOTION_COMMIT."
  exit 0
fi

if ! confirm_activation; then
  if attempt_guarded_rollback; then
    activation_attempted=0
    if [[ "$rollback_outcome" == "confirmed" ]]; then
      smoke_succeeded=1
      activated=0
      echo "VPS web promotion completed for immutable commit $WEB_PROMOTION_COMMIT."
      exit 0
    fi
    fail "hosted app/docs smoke passed but confirmation failed; the pending activation was guardedly rolled back"
  fi
  fail "hosted app/docs smoke passed but confirmation was unavailable; the on-host activation lease will roll it back automatically"
fi

smoke_succeeded=1
activation_attempted=0
activated=0
echo "VPS web promotion completed for immutable commit $WEB_PROMOTION_COMMIT."
