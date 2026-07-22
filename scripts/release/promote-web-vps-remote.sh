#!/bin/sh
set -eu

fail() {
  printf '%s\n' "VPS promotion failed: $1" >&2
  exit 1
}

validate_root() {
  case "$1" in
    /|""|*[!A-Za-z0-9_./-]*|*..*|*//*|*/)
      fail "release root is invalid"
      ;;
  esac
}

validate_environment() {
  case "$1" in
    testnet|mainnet) ;;
    *) fail "environment is invalid" ;;
  esac
}

validate_commit() {
  case "$1" in
    *[!0-9a-f]*) fail "commit is invalid" ;;
  esac
  [ "${#1}" -eq 40 ] || fail "commit is invalid"
}

validate_digest() {
  case "$1" in
    *[!0-9a-f]*) fail "SHA-256 digest is invalid" ;;
  esac
  [ "${#1}" -eq 64 ] || fail "SHA-256 digest is invalid"
}

validate_run_token() {
  case "$1" in
    ""|*[!A-Za-z0-9._-]*) fail "promotion run identity is invalid" ;;
  esac
  [ "${#1}" -le 128 ] || fail "promotion run identity is invalid"
}

validate_lease_seconds() {
  case "$1" in
    ""|*[!0-9]*) fail "activation lease is invalid" ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 900 ] || fail "activation lease is invalid"
}

validate_epoch() {
  case "$1" in
    ""|*[!0-9]*) fail "activation lease deadline is invalid" ;;
  esac
  [ "$1" -ge 1 ] || fail "activation lease deadline is invalid"
}

validate_link_identity() {
  case "$1" in
    ""|*[!0-9:]*) fail "activation link identity is invalid" ;;
  esac
  case "$1" in
    *:*) ;;
    *) fail "activation link identity is invalid" ;;
  esac
}

validate_archive_path() {
  root=$1
  archive=$2
  case "$archive" in
    "$root"/.incoming/*.tar.gz) ;;
    *) fail "transport archive path is invalid" ;;
  esac
  case "$archive" in
    *[!A-Za-z0-9_./-]*|*..*|*//*) fail "transport archive path is invalid" ;;
  esac
}

validate_helper_path() {
  root=$1
  helper=$2
  case "$helper" in
    "$root"/.incoming/*.helper.sh) ;;
    *) fail "watchdog helper path is invalid" ;;
  esac
  case "$helper" in
    *[!A-Za-z0-9_./-]*|*..*|*//*) fail "watchdog helper path is invalid" ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "no SHA-256 utility is installed"
  fi
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    fail "no SHA-256 utility is installed"
  fi
}

link_identity() {
  link_path=$1
  [ -L "$link_path" ] || fail "activation pointer identity is unavailable"
  if identity=$(stat -c '%d:%i' -- "$link_path" 2>/dev/null); then
    :
  elif identity=$(stat -f '%d:%i' "$link_path" 2>/dev/null); then
    :
  else
    fail "activation pointer identity cannot be inspected"
  fi
  validate_link_identity "$identity"
  printf '%s\n' "$identity"
}

payload_digest() {
  payload_root=$1
  find "$payload_root" -type f -print | LC_ALL=C sort | while IFS= read -r payload_file; do
    relative_path=${payload_file#"$payload_root"/}
    [ "$relative_path" != ".payload-sha256" ] || continue
    byte_count=$(wc -c < "$payload_file" | tr -d '[:space:]')
    file_digest=$(sha256_file "$payload_file")
    printf '%s\t%s\t%s\n' "$relative_path" "$byte_count" "$file_digest"
  done | sha256_stream
}

replace_link() {
  source_link=$1
  destination_link=$2
  if mv -Tf "$source_link" "$destination_link" 2>/dev/null; then
    return
  fi
  mv -fh "$source_link" "$destination_link"
}

validate_release_target() {
  target=$1
  case "$target" in
    releases/*/dist)
      validated_target_commit=${target#releases/}
      validated_target_commit=${validated_target_commit%/dist}
      validate_commit "$validated_target_commit"
      ;;
    *) fail "release pointer target is invalid" ;;
  esac
}

validate_release_directory() {
  release_path=$1
  expected_archive_digest=$2
  expected_commit=$3
  expected_environment=$4

  [ -d "$release_path" ] && [ ! -L "$release_path" ] || fail "rollback release path is not an immutable directory"
  [ -d "$release_path/dist" ] && [ ! -L "$release_path/dist" ] || fail "release is missing dist"
  [ -f "$release_path/dist/index.html" ] && [ ! -L "$release_path/dist/index.html" ] || fail "release is missing index.html"
  [ -f "$release_path/manifest.json" ] && [ ! -L "$release_path/manifest.json" ] || fail "release is missing manifest.json"
  [ -f "$release_path/custody.json" ] && [ ! -L "$release_path/custody.json" ] || fail "release is missing custody.json"
  [ -f "$release_path/.archive-sha256" ] && [ ! -L "$release_path/.archive-sha256" ] || fail "release is missing its archive digest marker"
  [ -f "$release_path/.payload-sha256" ] && [ ! -L "$release_path/.payload-sha256" ] || fail "release is missing its payload digest marker"
  [ -f "$release_path/.release-identity" ] && [ ! -L "$release_path/.release-identity" ] || fail "release is missing its identity marker"

  if find "$release_path" -type l -print -quit | grep -q .; then
    fail "release contains a symbolic link"
  fi
  if find "$release_path" ! -type d ! -type f -print -quit | grep -q .; then
    fail "release contains a special file"
  fi

  archive_digest=$(sed -n '1p' "$release_path/.archive-sha256")
  validate_digest "$archive_digest"
  if [ "$expected_archive_digest" != "-" ] && [ "$archive_digest" != "$expected_archive_digest" ]; then
    fail "existing immutable release has a different archive digest"
  fi

  release_identity=$(sed -n '1p' "$release_path/.release-identity")
  [ "$release_identity" = "$expected_environment $expected_commit" ] || fail "release identity does not match its environment and commit"

  expected_payload_digest=$(sed -n '1p' "$release_path/.payload-sha256")
  validate_digest "$expected_payload_digest"
  actual_payload_digest=$(payload_digest "$release_path")
  [ "$actual_payload_digest" = "$expected_payload_digest" ] || fail "release payload integrity check failed"
}

activation_record_paths() {
  record_root=$1
  record_environment=$2
  record_commit=$3
  record_run_token=$4
  activation_records="$record_root/.promotion-records"
  activation_record="$activation_records/$record_environment-$record_commit-$record_run_token.record"
  activation_anchor="$activation_records/$record_environment-$record_commit-$record_run_token.anchor"
  activation_confirmation="$activation_records/$record_environment-$record_commit-$record_run_token.confirmed"
  activation_watchdog_marker="$activation_records/$record_environment-$record_commit-$record_run_token.watchdog"
  activation_intent="$activation_records/$record_environment-$record_commit-$record_run_token.intent"
}

write_activation_intent() {
  intent_file=$1
  intent_environment=$2
  intent_commit=$3
  intent_run_token=$4
  intent_archive_digest=$5
  intent_created_epoch=$(date +%s)
  validate_epoch "$intent_created_epoch"
  intent_tmp="$intent_file.tmp.$$"
  {
    printf '%s\n' "schema=robinhood.web-promotion-intent.v1"
    printf '%s\n' "environment=$intent_environment"
    printf '%s\n' "commit=$intent_commit"
    printf '%s\n' "run_token=$intent_run_token"
    printf '%s\n' "archive_sha256=$intent_archive_digest"
    printf '%s\n' "created_epoch=$intent_created_epoch"
  } > "$intent_tmp"
  intent_checksum=$(sha256_file "$intent_tmp")
  printf '%s\n' "intent_sha256=$intent_checksum" >> "$intent_tmp"
  chmod 0400 "$intent_tmp"
  mv "$intent_tmp" "$intent_file"
}

validate_activation_intent() {
  intent_root=$1
  intent_expected_environment=$2
  intent_expected_commit=$3
  intent_expected_archive_digest=$4
  intent_expected_run_token=$5
  activation_record_paths "$intent_root" "$intent_expected_environment" "$intent_expected_commit" "$intent_expected_run_token"
  [ -f "$activation_intent" ] && [ ! -L "$activation_intent" ] || fail "activation intent is unavailable"
  [ "$(wc -l < "$activation_intent" | tr -d '[:space:]')" = "7" ] || fail "activation intent shape is invalid"
  intent_line_1=$(sed -n '1p' "$activation_intent")
  intent_line_2=$(sed -n '2p' "$activation_intent")
  intent_line_3=$(sed -n '3p' "$activation_intent")
  intent_line_4=$(sed -n '4p' "$activation_intent")
  intent_line_5=$(sed -n '5p' "$activation_intent")
  intent_line_6=$(sed -n '6p' "$activation_intent")
  intent_line_7=$(sed -n '7p' "$activation_intent")
  [ "$intent_line_1" = "schema=robinhood.web-promotion-intent.v1" ] || fail "activation intent schema is invalid"
  [ "$intent_line_2" = "environment=$intent_expected_environment" ] || fail "activation intent environment is invalid"
  [ "$intent_line_3" = "commit=$intent_expected_commit" ] || fail "activation intent commit is invalid"
  [ "$intent_line_4" = "run_token=$intent_expected_run_token" ] || fail "activation intent run identity is invalid"
  [ "$intent_line_5" = "archive_sha256=$intent_expected_archive_digest" ] || fail "activation intent archive digest is invalid"
  intent_created_epoch=${intent_line_6#created_epoch=}
  [ "$intent_line_6" = "created_epoch=$intent_created_epoch" ] || fail "activation intent creation time is invalid"
  validate_epoch "$intent_created_epoch"
  intent_checksum=${intent_line_7#intent_sha256=}
  [ "$intent_line_7" = "intent_sha256=$intent_checksum" ] || fail "activation intent checksum is invalid"
  validate_digest "$intent_checksum"
  computed_intent_checksum=$(sed -n '1,6p' "$activation_intent" | sha256_stream)
  [ "$computed_intent_checksum" = "$intent_checksum" ] || fail "activation intent integrity check failed"
}

ensure_activation_records_directory() {
  record_root=$1
  activation_records="$record_root/.promotion-records"
  if [ -e "$activation_records" ] || [ -L "$activation_records" ]; then
    [ -d "$activation_records" ] && [ ! -L "$activation_records" ] || fail "activation record directory is invalid"
  else
    mkdir "$activation_records"
  fi
  chmod 0700 "$activation_records"
}

validate_activation_record() {
  ar_root=$1
  ar_expected_environment=$2
  ar_expected_commit=$3
  ar_expected_archive_digest=$4
  ar_expected_run_token=$5
  activation_record_paths "$ar_root" "$ar_expected_environment" "$ar_expected_commit" "$ar_expected_run_token"

  [ -f "$activation_record" ] && [ ! -L "$activation_record" ] || fail "activation record is unavailable"
  [ "$(wc -l < "$activation_record" | tr -d '[:space:]')" = "10" ] || fail "activation record shape is invalid"

  record_line_1=$(sed -n '1p' "$activation_record")
  record_line_2=$(sed -n '2p' "$activation_record")
  record_line_3=$(sed -n '3p' "$activation_record")
  record_line_4=$(sed -n '4p' "$activation_record")
  record_line_5=$(sed -n '5p' "$activation_record")
  record_line_6=$(sed -n '6p' "$activation_record")
  record_line_7=$(sed -n '7p' "$activation_record")
  record_line_8=$(sed -n '8p' "$activation_record")
  record_line_9=$(sed -n '9p' "$activation_record")
  record_line_10=$(sed -n '10p' "$activation_record")

  [ "$record_line_1" = "schema=robinhood.web-promotion-activation.v1" ] || fail "activation record schema is invalid"
  record_environment_value=${record_line_2#environment=}
  record_commit_value=${record_line_3#commit=}
  record_run_token_value=${record_line_4#run_token=}
  record_archive_digest=${record_line_5#archive_sha256=}
  record_release_target=${record_line_6#release_target=}
  record_rollback_target=${record_line_7#rollback_target=}
  record_lease_expires_epoch=${record_line_8#lease_expires_epoch=}
  record_link_identity=${record_line_9#current_link_identity=}
  record_checksum=${record_line_10#record_sha256=}

  [ "$record_line_2" = "environment=$record_environment_value" ] || fail "activation record environment is invalid"
  [ "$record_line_3" = "commit=$record_commit_value" ] || fail "activation record commit is invalid"
  [ "$record_line_4" = "run_token=$record_run_token_value" ] || fail "activation record run identity is invalid"
  [ "$record_line_5" = "archive_sha256=$record_archive_digest" ] || fail "activation record archive digest is invalid"
  [ "$record_line_6" = "release_target=$record_release_target" ] || fail "activation record release target is invalid"
  [ "$record_line_7" = "rollback_target=$record_rollback_target" ] || fail "activation record rollback target is invalid"
  [ "$record_line_8" = "lease_expires_epoch=$record_lease_expires_epoch" ] || fail "activation record lease deadline is invalid"
  [ "$record_line_9" = "current_link_identity=$record_link_identity" ] || fail "activation record link identity is invalid"
  [ "$record_line_10" = "record_sha256=$record_checksum" ] || fail "activation record checksum is invalid"

  validate_environment "$record_environment_value"
  validate_commit "$record_commit_value"
  validate_run_token "$record_run_token_value"
  validate_digest "$record_archive_digest"
  validate_release_target "$record_release_target"
  [ "$validated_target_commit" = "$record_commit_value" ] || fail "activation record release target does not match its commit"
  validate_link_identity "$record_link_identity"
  validate_epoch "$record_lease_expires_epoch"
  validate_digest "$record_checksum"

  [ "$record_environment_value" = "$ar_expected_environment" ] || fail "activation record environment does not match this request"
  [ "$record_commit_value" = "$ar_expected_commit" ] || fail "activation record commit does not match this request"
  [ "$record_run_token_value" = "$ar_expected_run_token" ] || fail "activation record run identity does not match this request"
  [ "$record_archive_digest" = "$ar_expected_archive_digest" ] || fail "activation record archive digest does not match this request"
  [ "$record_release_target" = "releases/$ar_expected_commit/dist" ] || fail "activation record release target does not match this request"

  if [ "$record_rollback_target" != "none" ]; then
    validate_release_target "$record_rollback_target"
    rollback_commit=$validated_target_commit
    validate_release_directory "$ar_root/releases/$rollback_commit" - "$rollback_commit" "$ar_expected_environment"
    [ "$record_rollback_target" != "$record_release_target" ] || fail "activation record cannot roll back to the promoted release"
  fi

  computed_record_checksum=$(sed -n '1,9p' "$activation_record" | sha256_stream)
  [ "$computed_record_checksum" = "$record_checksum" ] || fail "activation record integrity check failed"

  [ -L "$activation_anchor" ] || fail "activation record anchor is unavailable"
  [ "$(readlink "$activation_anchor")" = "$record_release_target" ] || fail "activation record anchor target is invalid"
  anchor_link_identity=$(link_identity "$activation_anchor")
  [ "$anchor_link_identity" = "$record_link_identity" ] || fail "activation record anchor identity does not match"

  validate_release_directory "$ar_root/releases/$ar_expected_commit" "$ar_expected_archive_digest" "$ar_expected_commit" "$ar_expected_environment"
}

write_activation_record() {
  record_file=$1
  record_environment_value=$2
  record_commit_value=$3
  record_run_token_value=$4
  record_archive_digest=$5
  record_release_target=$6
  record_rollback_target=$7
  record_lease_expires_epoch=$8
  record_link_identity=$9

  {
    printf '%s\n' "schema=robinhood.web-promotion-activation.v1"
    printf '%s\n' "environment=$record_environment_value"
    printf '%s\n' "commit=$record_commit_value"
    printf '%s\n' "run_token=$record_run_token_value"
    printf '%s\n' "archive_sha256=$record_archive_digest"
    printf '%s\n' "release_target=$record_release_target"
    printf '%s\n' "rollback_target=$record_rollback_target"
    printf '%s\n' "lease_expires_epoch=$record_lease_expires_epoch"
    printf '%s\n' "current_link_identity=$record_link_identity"
  } > "$record_file"
  record_checksum=$(sha256_file "$record_file")
  validate_digest "$record_checksum"
  printf '%s\n' "record_sha256=$record_checksum" >> "$record_file"
  chmod 0400 "$record_file"
}

validate_observed_current() {
  current_root=$1
  current_environment=$2
  current_pointer="$current_root/current"
  if [ -e "$current_pointer" ] && [ ! -L "$current_pointer" ]; then
    fail "current release pointer is not a symbolic link"
  fi
  if [ -L "$current_pointer" ]; then
    observed_target=$(readlink "$current_pointer")
    validate_release_target "$observed_target"
    observed_commit=$validated_target_commit
    validate_release_directory "$current_root/releases/$observed_commit" - "$observed_commit" "$current_environment"
  fi
}

activation_record_is_current() {
  record_root=$1
  current_pointer="$record_root/current"
  [ -L "$current_pointer" ] || return 1
  [ "$(readlink "$current_pointer")" = "$record_release_target" ] || return 1
  observed_link_identity=$(link_identity "$current_pointer")
  [ "$observed_link_identity" = "$record_link_identity" ]
}

print_active_status() {
  printf '%s\n' "PROMOTION_STATUS=active"
  printf '%s\n' "PROMOTION_PREVIOUS_TARGET=$record_rollback_target"
  printf '%s\n' "PROMOTION_ACTIVATION_ID=$record_link_identity"
}

write_watchdog_marker() {
  marker_file=$1
  marker_tmp="$marker_file.tmp.$$"
  {
    printf '%s\n' "schema=robinhood.web-promotion-watchdog.v1"
    printf '%s\n' "record_sha256=$record_checksum"
    printf '%s\n' "lease_expires_epoch=$record_lease_expires_epoch"
  } > "$marker_tmp"
  marker_checksum=$(sha256_file "$marker_tmp")
  printf '%s\n' "marker_sha256=$marker_checksum" >> "$marker_tmp"
  chmod 0400 "$marker_tmp"
  mv "$marker_tmp" "$marker_file"
}

validate_watchdog_marker() {
  marker_file=$1
  [ -f "$marker_file" ] && [ ! -L "$marker_file" ] || fail "activation watchdog marker is unavailable"
  [ "$(wc -l < "$marker_file" | tr -d '[:space:]')" = "4" ] || fail "activation watchdog marker shape is invalid"
  marker_line_1=$(sed -n '1p' "$marker_file")
  marker_line_2=$(sed -n '2p' "$marker_file")
  marker_line_3=$(sed -n '3p' "$marker_file")
  marker_line_4=$(sed -n '4p' "$marker_file")
  [ "$marker_line_1" = "schema=robinhood.web-promotion-watchdog.v1" ] || fail "activation watchdog marker schema is invalid"
  [ "$marker_line_2" = "record_sha256=$record_checksum" ] || fail "activation watchdog marker record identity is invalid"
  [ "$marker_line_3" = "lease_expires_epoch=$record_lease_expires_epoch" ] || fail "activation watchdog marker lease is invalid"
  marker_checksum=${marker_line_4#marker_sha256=}
  [ "$marker_line_4" = "marker_sha256=$marker_checksum" ] || fail "activation watchdog marker checksum is invalid"
  validate_digest "$marker_checksum"
  computed_marker_checksum=$(sed -n '1,3p' "$marker_file" | sha256_stream)
  [ "$computed_marker_checksum" = "$marker_checksum" ] || fail "activation watchdog marker integrity check failed"
}

write_confirmation() {
  confirmation_file=$1
  confirmation_tmp="$confirmation_file.tmp.$$"
  {
    printf '%s\n' "schema=robinhood.web-promotion-confirmation.v1"
    printf '%s\n' "record_sha256=$record_checksum"
    printf '%s\n' "current_link_identity=$record_link_identity"
  } > "$confirmation_tmp"
  confirmation_checksum=$(sha256_file "$confirmation_tmp")
  printf '%s\n' "confirmation_sha256=$confirmation_checksum" >> "$confirmation_tmp"
  chmod 0400 "$confirmation_tmp"
  mv "$confirmation_tmp" "$confirmation_file"
}

activation_is_confirmed() {
  if [ ! -e "$activation_confirmation" ] && [ ! -L "$activation_confirmation" ]; then
    return 1
  fi
  [ -f "$activation_confirmation" ] && [ ! -L "$activation_confirmation" ] || fail "activation confirmation is invalid"
  [ "$(wc -l < "$activation_confirmation" | tr -d '[:space:]')" = "4" ] || fail "activation confirmation shape is invalid"
  confirmation_line_1=$(sed -n '1p' "$activation_confirmation")
  confirmation_line_2=$(sed -n '2p' "$activation_confirmation")
  confirmation_line_3=$(sed -n '3p' "$activation_confirmation")
  confirmation_line_4=$(sed -n '4p' "$activation_confirmation")
  [ "$confirmation_line_1" = "schema=robinhood.web-promotion-confirmation.v1" ] || fail "activation confirmation schema is invalid"
  [ "$confirmation_line_2" = "record_sha256=$record_checksum" ] || fail "activation confirmation record identity is invalid"
  [ "$confirmation_line_3" = "current_link_identity=$record_link_identity" ] || fail "activation confirmation pointer identity is invalid"
  confirmation_checksum=${confirmation_line_4#confirmation_sha256=}
  [ "$confirmation_line_4" = "confirmation_sha256=$confirmation_checksum" ] || fail "activation confirmation checksum is invalid"
  validate_digest "$confirmation_checksum"
  computed_confirmation_checksum=$(sed -n '1,3p' "$activation_confirmation" | sha256_stream)
  [ "$computed_confirmation_checksum" = "$confirmation_checksum" ] || fail "activation confirmation integrity check failed"
  return 0
}

current_release_is_confirmed() {
  confirmed_root=$1
  confirmed_environment=$2
  confirmed_commit=$3
  confirmed_archive_digest=$4
  confirmed_current="$confirmed_root/current"
  [ -L "$confirmed_current" ] || return 1
  [ "$(readlink "$confirmed_current")" = "releases/$confirmed_commit/dist" ] || return 1
  confirmed_current_identity=$(link_identity "$confirmed_current")
  confirmed_prefix="$confirmed_environment-$confirmed_commit-"
  for confirmed_record in "$confirmed_root/.promotion-records/$confirmed_prefix"*.record; do
    [ -f "$confirmed_record" ] && [ ! -L "$confirmed_record" ] || continue
    confirmed_name=${confirmed_record##*/}
    confirmed_run_token=${confirmed_name#"$confirmed_prefix"}
    confirmed_run_token=${confirmed_run_token%.record}
    validate_run_token "$confirmed_run_token"
    validate_activation_record "$confirmed_root" "$confirmed_environment" "$confirmed_commit" "$confirmed_archive_digest" "$confirmed_run_token"
    [ "$record_link_identity" = "$confirmed_current_identity" ] || continue
    activation_record_is_current "$confirmed_root" || fail "current activation anchor does not match its record"
    activation_is_confirmed || fail "current release has an unconfirmed activation lease"
    return 0
  done
  return 1
}

acquire_activation_lock() {
  lock_root=$1
  lock_dir="$lock_root/.promotion.lock"
  lock_held=0
  lock_attempts=${WEB_PROMOTION_LOCK_ATTEMPTS:-120}
  case "$lock_attempts" in
    ""|*[!0-9]*) fail "activation lock attempts are invalid" ;;
  esac
  [ "$lock_attempts" -ge 1 ] && [ "$lock_attempts" -le 600 ] || fail "activation lock attempts are invalid"

  lock_count=1
  while ! mkdir "$lock_dir" 2>/dev/null; do
    [ "$lock_count" -lt "$lock_attempts" ] || fail "another release activation holds the VPS lock"
    lock_count=$((lock_count + 1))
    sleep 1
  done
  lock_held=1
}

release_activation_lock() {
  if [ "${lock_held:-0}" -eq 1 ]; then
    rmdir "$lock_dir" 2>/dev/null || true
    lock_held=0
  fi
}

prepare() {
  [ "$#" -eq 7 ] || fail "prepare arguments are invalid"
  root=$1
  environment=$2
  commit=$3
  archive=$4
  watchdog_helper=$5
  expected_digest=$6
  run_token=$7
  validate_root "$root"
  validate_environment "$environment"
  validate_commit "$commit"
  validate_archive_path "$root" "$archive"
  validate_helper_path "$root" "$watchdog_helper"
  validate_digest "$expected_digest"
  validate_run_token "$run_token"

  umask 077
  mkdir -p "$root/.incoming" "$root/releases"
  [ ! -d "$archive" ] || fail "transport archive path is a directory"
  [ ! -d "$watchdog_helper" ] || fail "watchdog helper path is a directory"
  rm -f "$archive" "$watchdog_helper"
  lock_held=0
  cleanup_prepare() {
    release_activation_lock
  }
  trap cleanup_prepare EXIT
  acquire_activation_lock "$root"
  ensure_activation_records_directory "$root"
  activation_record_paths "$root" "$environment" "$commit" "$run_token"
  if [ -e "$activation_intent" ] || [ -L "$activation_intent" ]; then
    validate_activation_intent "$root" "$environment" "$commit" "$expected_digest" "$run_token"
  else
    write_activation_intent "$activation_intent" "$environment" "$commit" "$run_token" "$expected_digest"
    validate_activation_intent "$root" "$environment" "$commit" "$expected_digest" "$run_token"
  fi
}

cleanup() {
  [ "$#" -eq 7 ] || fail "cleanup arguments are invalid"
  root=$1
  archive=$2
  watchdog_helper=$3
  environment=$4
  commit=$5
  expected_digest=$6
  run_token=$7
  validate_root "$root"
  validate_archive_path "$root" "$archive"
  validate_helper_path "$root" "$watchdog_helper"
  validate_environment "$environment"
  validate_commit "$commit"
  validate_digest "$expected_digest"
  validate_run_token "$run_token"
  rm -f "$archive" "$watchdog_helper"
  lock_held=0
  cleanup_cleanup() {
    release_activation_lock
  }
  trap cleanup_cleanup EXIT
  acquire_activation_lock "$root"
  ensure_activation_records_directory "$root"
  activation_record_paths "$root" "$environment" "$commit" "$run_token"
  if [ -e "$activation_intent" ] || [ -L "$activation_intent" ]; then
    validate_activation_intent "$root" "$environment" "$commit" "$expected_digest" "$run_token"
    if [ ! -e "$activation_record" ] && [ ! -L "$activation_record" ] && [ ! -e "$activation_anchor" ] && [ ! -L "$activation_anchor" ]; then
      rm -f "$activation_intent"
    fi
  fi
}

promote() {
  [ "$#" -eq 9 ] || fail "promote arguments are invalid"
  root=$1
  environment=$2
  commit=$3
  expected_digest=$4
  archive=$5
  run_token=$6
  watchdog_helper=$7
  expected_helper_digest=$8
  lease_seconds=$9
  validate_root "$root"
  validate_environment "$environment"
  validate_commit "$commit"
  validate_digest "$expected_digest"
  validate_archive_path "$root" "$archive"
  validate_run_token "$run_token"
  validate_helper_path "$root" "$watchdog_helper"
  validate_digest "$expected_helper_digest"
  validate_lease_seconds "$lease_seconds"
  [ -f "$archive" ] && [ ! -L "$archive" ] || fail "transport archive is unavailable"
  [ -f "$watchdog_helper" ] && [ ! -L "$watchdog_helper" ] || fail "watchdog helper is unavailable"

  actual_digest=$(sha256_file "$archive")
  [ "$actual_digest" = "$expected_digest" ] || fail "transport archive digest mismatch"
  actual_helper_digest=$(sha256_file "$watchdog_helper")
  [ "$actual_helper_digest" = "$expected_helper_digest" ] || fail "watchdog helper digest mismatch"
  chmod 0500 "$watchdog_helper"

  release_dir="$root/releases/$commit"
  release_target="releases/$commit/dist"
  stage="$root/releases/.${commit}.stage.$$"
  current="$root/current"
  previous="$root/previous"
  current_tmp="$root/.current.${commit}.$$"
  previous_tmp="$root/.previous.${commit}.$$"
  record_tmp=""
  anchor_tmp=""
  watchdog_started=0
  lock_held=0

  cleanup_paths() {
    rm -f "$archive" "$current_tmp" "$previous_tmp"
    [ -z "$record_tmp" ] || rm -f "$record_tmp"
    [ -z "$anchor_tmp" ] || rm -f "$anchor_tmp"
    if [ "$watchdog_started" -eq 0 ]; then
      rm -f "$watchdog_helper"
    fi
    rm -rf "$stage"
    release_activation_lock
  }
  trap cleanup_paths EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  rm -rf "$stage"
  mkdir "$stage"
  tar -xzf "$archive" -C "$stage" --no-same-owner --no-same-permissions
  [ -d "$stage/dist" ] && [ ! -L "$stage/dist" ] || fail "release archive is missing dist"
  [ -f "$stage/dist/index.html" ] && [ ! -L "$stage/dist/index.html" ] || fail "release archive is missing index.html"
  [ -f "$stage/manifest.json" ] && [ ! -L "$stage/manifest.json" ] || fail "release archive is missing manifest.json"
  [ -f "$stage/custody.json" ] && [ ! -L "$stage/custody.json" ] || fail "release archive is missing custody.json"
  if find "$stage" -type l -print -quit | grep -q .; then
    fail "release archive contains a symbolic link"
  fi
  if find "$stage" ! -type d ! -type f -print -quit | grep -q .; then
    fail "release archive contains a special file"
  fi
  printf '%s\n' "$expected_digest" > "$stage/.archive-sha256"
  printf '%s %s\n' "$environment" "$commit" > "$stage/.release-identity"
  stage_payload_digest=$(payload_digest "$stage")
  validate_digest "$stage_payload_digest"
  printf '%s\n' "$stage_payload_digest" > "$stage/.payload-sha256"
  validate_release_directory "$stage" "$expected_digest" "$commit" "$environment"

  acquire_activation_lock "$root"
  ensure_activation_records_directory "$root"
  activation_record_paths "$root" "$environment" "$commit" "$run_token"
  validate_activation_intent "$root" "$environment" "$commit" "$expected_digest" "$run_token"

  if [ -e "$release_dir" ] || [ -L "$release_dir" ]; then
    validate_release_directory "$release_dir" "$expected_digest" "$commit" "$environment"
    [ "$actual_payload_digest" = "$stage_payload_digest" ] || fail "existing release payload differs from the sealed archive"
  else
    mv "$stage" "$release_dir"
  fi
  find "$release_dir" -type d -exec chmod 0555 {} +
  find "$release_dir" -type f -exec chmod 0444 {} +

  if [ -e "$activation_record" ] || [ -L "$activation_record" ] || [ -e "$activation_anchor" ] || [ -L "$activation_anchor" ]; then
    validate_activation_record "$root" "$environment" "$commit" "$expected_digest" "$run_token"
    if activation_record_is_current "$root"; then
      print_active_status
      return
    fi
    fail "activation record already exists but is not current"
  fi

  if [ -L "$current" ] && [ "$(readlink "$current")" = "$release_target" ]; then
    requested_activation_intent=$activation_intent
    if current_release_is_confirmed "$root" "$environment" "$commit" "$expected_digest"; then
      rm -f "$requested_activation_intent"
      printf '%s\n' "PROMOTION_STATUS=already-confirmed"
      return
    fi
    fail "current release is not bound to a confirmed activation record"
  fi

  if [ -e "$current" ] && [ ! -L "$current" ]; then
    fail "current release pointer is not a symbolic link"
  fi

  rollback_target=none
  if [ -L "$current" ]; then
    current_target=$(readlink "$current")
    validate_release_target "$current_target"
    current_commit=$validated_target_commit
    validate_release_directory "$root/releases/$current_commit" - "$current_commit" "$environment"
    if [ "$current_target" != "$release_target" ]; then
      rollback_target=$current_target
      if [ -e "$previous" ] && [ ! -L "$previous" ]; then
        fail "previous release pointer is not a symbolic link"
      fi
      ln -s "$rollback_target" "$previous_tmp"
      replace_link "$previous_tmp" "$previous"
    elif [ -L "$previous" ]; then
      rollback_target=$(readlink "$previous")
      validate_release_target "$rollback_target"
      rollback_commit=$validated_target_commit
      validate_release_directory "$root/releases/$rollback_commit" - "$rollback_commit" "$environment"
    elif [ -e "$previous" ]; then
      fail "previous release pointer is not a symbolic link"
    fi
  elif [ -L "$previous" ]; then
    rollback_target=$(readlink "$previous")
    validate_release_target "$rollback_target"
    rollback_commit=$validated_target_commit
    validate_release_directory "$root/releases/$rollback_commit" - "$rollback_commit" "$environment"
  elif [ -e "$previous" ]; then
    fail "previous release pointer is not a symbolic link"
  fi

  ln -s "$release_target" "$current_tmp"
  current_link_identity=$(link_identity "$current_tmp")
  lease_started_epoch=$(date +%s)
  validate_epoch "$lease_started_epoch"
  lease_expires_epoch=$((lease_started_epoch + lease_seconds))
  validate_epoch "$lease_expires_epoch"
  record_tmp="$activation_record.tmp.$$"
  anchor_tmp="$activation_anchor.tmp.$$"
  ln -P "$current_tmp" "$anchor_tmp"
  [ "$(link_identity "$anchor_tmp")" = "$current_link_identity" ] || fail "activation anchor could not bind the pending pointer"
  write_activation_record "$record_tmp" "$environment" "$commit" "$run_token" "$expected_digest" "$release_target" "$rollback_target" "$lease_expires_epoch" "$current_link_identity"
  mv "$anchor_tmp" "$activation_anchor"
  anchor_tmp=""
  mv "$record_tmp" "$activation_record"
  record_tmp=""
  validate_activation_record "$root" "$environment" "$commit" "$expected_digest" "$run_token"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid sh "$watchdog_helper" lease-watch "$root" "$environment" "$commit" "$expected_digest" "$run_token" "$lease_expires_epoch" "$watchdog_helper" "$expected_helper_digest" </dev/null >/dev/null 2>&1 &
  else
    nohup sh "$watchdog_helper" lease-watch "$root" "$environment" "$commit" "$expected_digest" "$run_token" "$lease_expires_epoch" "$watchdog_helper" "$expected_helper_digest" </dev/null >/dev/null 2>&1 &
  fi
  watchdog_pid=$!
  watchdog_started=1
  watchdog_wait=0
  while [ ! -f "$activation_watchdog_marker" ]; do
    kill -0 "$watchdog_pid" 2>/dev/null || fail "activation watchdog failed to start"
    [ "$watchdog_wait" -lt 5 ] || fail "activation watchdog did not become ready"
    watchdog_wait=$((watchdog_wait + 1))
    sleep 1
  done
  validate_watchdog_marker "$activation_watchdog_marker"
  replace_link "$current_tmp" "$current"
  validate_activation_record "$root" "$environment" "$commit" "$expected_digest" "$run_token"
  activation_record_is_current "$root" || fail "activation pointer does not match its durable record"
  print_active_status
}

status() {
  [ "$#" -eq 5 ] || fail "status arguments are invalid"
  root=$1
  environment=$2
  commit=$3
  expected_digest=$4
  run_token=$5
  validate_root "$root"
  validate_environment "$environment"
  validate_commit "$commit"
  validate_digest "$expected_digest"
  validate_run_token "$run_token"
  lock_held=0

  cleanup_status() {
    release_activation_lock
  }
  trap cleanup_status EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  acquire_activation_lock "$root"
  ensure_activation_records_directory "$root"
  activation_record_paths "$root" "$environment" "$commit" "$run_token"
  if [ ! -e "$activation_record" ] && [ ! -L "$activation_record" ] && [ ! -e "$activation_anchor" ] && [ ! -L "$activation_anchor" ]; then
    validate_observed_current "$root" "$environment"
    if [ -e "$activation_intent" ] || [ -L "$activation_intent" ]; then
      validate_activation_intent "$root" "$environment" "$commit" "$expected_digest" "$run_token"
      printf '%s\n' "PROMOTION_STATUS=pending"
    elif current_release_is_confirmed "$root" "$environment" "$commit" "$expected_digest"; then
      printf '%s\n' "PROMOTION_STATUS=already-confirmed"
    else
      printf '%s\n' "PROMOTION_STATUS=absent"
    fi
    return
  fi
  validate_activation_record "$root" "$environment" "$commit" "$expected_digest" "$run_token"
  if activation_record_is_current "$root"; then
    print_active_status
    return
  fi
  validate_observed_current "$root" "$environment"
  printf '%s\n' "PROMOTION_STATUS=inactive"
}

confirm() {
  [ "$#" -eq 5 ] || fail "confirm arguments are invalid"
  root=$1
  environment=$2
  commit=$3
  expected_digest=$4
  run_token=$5
  validate_root "$root"
  validate_environment "$environment"
  validate_commit "$commit"
  validate_digest "$expected_digest"
  validate_run_token "$run_token"
  lock_held=0

  cleanup_confirmation() {
    release_activation_lock
  }
  trap cleanup_confirmation EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  acquire_activation_lock "$root"
  ensure_activation_records_directory "$root"
  validate_activation_intent "$root" "$environment" "$commit" "$expected_digest" "$run_token"
  validate_activation_record "$root" "$environment" "$commit" "$expected_digest" "$run_token"
  validate_watchdog_marker "$activation_watchdog_marker"
  activation_record_is_current "$root" || fail "activation changed before hosted smoke confirmation"
  confirmation_epoch=$(date +%s)
  validate_epoch "$confirmation_epoch"
  [ "$confirmation_epoch" -lt "$record_lease_expires_epoch" ] || fail "activation lease expired before hosted smoke confirmation"
  confirmed_watchdog_helper="$root/.incoming/$environment-$commit-$run_token.helper.sh"
  validate_helper_path "$root" "$confirmed_watchdog_helper"
  if activation_is_confirmed; then
    rm -f "$confirmed_watchdog_helper"
    rm -f "$activation_intent"
    printf '%s\n' "PROMOTION_CONFIRM=confirmed"
    return
  fi
  write_confirmation "$activation_confirmation"
  activation_is_confirmed || fail "activation confirmation could not be persisted"
  rm -f "$confirmed_watchdog_helper"
  rm -f "$activation_intent"
  printf '%s\n' "PROMOTION_CONFIRM=confirmed"
}

lease_watch() {
  [ "$#" -eq 8 ] || fail "lease-watch arguments are invalid"
  root=$1
  environment=$2
  commit=$3
  expected_digest=$4
  run_token=$5
  expected_expiry=$6
  watchdog_helper=$7
  expected_helper_digest=$8
  validate_root "$root"
  validate_environment "$environment"
  validate_commit "$commit"
  validate_digest "$expected_digest"
  validate_run_token "$run_token"
  validate_epoch "$expected_expiry"
  validate_helper_path "$root" "$watchdog_helper"
  validate_digest "$expected_helper_digest"
  [ -f "$watchdog_helper" ] && [ ! -L "$watchdog_helper" ] || fail "watchdog helper is unavailable"
  [ "$(sha256_file "$watchdog_helper")" = "$expected_helper_digest" ] || fail "watchdog helper digest mismatch"
  lock_held=0

  cleanup_lease_watch() {
    release_activation_lock
    rm -f "$watchdog_helper"
  }
  trap cleanup_lease_watch EXIT
  trap '' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  ensure_activation_records_directory "$root"
  validate_activation_record "$root" "$environment" "$commit" "$expected_digest" "$run_token"
  [ "$record_lease_expires_epoch" = "$expected_expiry" ] || fail "watchdog lease does not match the activation record"
  if [ -e "$activation_watchdog_marker" ] || [ -L "$activation_watchdog_marker" ]; then
    validate_watchdog_marker "$activation_watchdog_marker"
  else
    write_watchdog_marker "$activation_watchdog_marker"
    validate_watchdog_marker "$activation_watchdog_marker"
  fi

  while :; do
    lease_now=$(date +%s)
    validate_epoch "$lease_now"
    [ "$lease_now" -lt "$expected_expiry" ] || break
    lease_remaining=$((expected_expiry - lease_now))
    sleep "$lease_remaining"
  done

  acquire_activation_lock "$root"
  validate_activation_record "$root" "$environment" "$commit" "$expected_digest" "$run_token"
  if activation_is_confirmed; then
    rm -f "$activation_intent"
    return
  fi
  if activation_record_is_current "$root"; then
    current="$root/current"
    current_tmp="$root/.lease-rollback.${commit}.${run_token}.$$"
    if [ "$record_rollback_target" = "none" ]; then
      rm -f "$current"
    else
      ln -s "$record_rollback_target" "$current_tmp"
      replace_link "$current_tmp" "$current"
    fi
    rm -f "$activation_intent"
    return
  fi
  validate_observed_current "$root" "$environment"
  rm -f "$activation_intent"
}

recover_rollback() {
  [ "$#" -eq 5 ] || fail "recover-rollback arguments are invalid"
  root=$1
  environment=$2
  failed_commit=$3
  expected_digest=$4
  run_token=$5
  validate_root "$root"
  validate_environment "$environment"
  validate_commit "$failed_commit"
  validate_digest "$expected_digest"
  validate_run_token "$run_token"
  current="$root/current"
  current_tmp="$root/.rollback.${failed_commit}.${run_token}.$$"
  lock_held=0

  cleanup_recovery_rollback() {
    rm -f "$current_tmp"
    release_activation_lock
  }
  trap cleanup_recovery_rollback EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  acquire_activation_lock "$root"
  ensure_activation_records_directory "$root"
  validate_activation_record "$root" "$environment" "$failed_commit" "$expected_digest" "$run_token"
  if activation_is_confirmed; then
    rm -f "$activation_intent"
    printf '%s\n' "PROMOTION_ROLLBACK=confirmed"
    return
  fi
  if ! activation_record_is_current "$root"; then
    validate_observed_current "$root" "$environment"
    rm -f "$activation_intent"
    printf '%s\n' "PROMOTION_ROLLBACK=not-current"
    return
  fi

  if [ "$record_rollback_target" = "none" ]; then
    rm -f "$current"
  else
    ln -s "$record_rollback_target" "$current_tmp"
    replace_link "$current_tmp" "$current"
  fi
  rm -f "$activation_intent"
  printf '%s\n' "PROMOTION_ROLLBACK=restored"
}

action=${1:-}
[ "$#" -gt 0 ] || fail "action is required"
shift

case "$action" in
  prepare) prepare "$@" ;;
  cleanup) cleanup "$@" ;;
  promote) promote "$@" ;;
  status) status "$@" ;;
  confirm) confirm "$@" ;;
  lease-watch) lease_watch "$@" ;;
  recover-rollback) recover_rollback "$@" ;;
  *) fail "action is invalid" ;;
esac
