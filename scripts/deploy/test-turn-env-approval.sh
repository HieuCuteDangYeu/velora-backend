#!/usr/bin/env bash
set -Eeuo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  for candidate in /opt/homebrew/bin/bash /usr/local/bin/bash; do
    [[ -x "$candidate" ]] && exec "$candidate" "$0" "$@"
  done
  printf 'Bash 4+ is required.\n' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
export VELORA_APP_DIR="$tmp_dir/app" VELORA_STATE_DIR="$tmp_dir/state"
source "$repo_root/scripts/deploy/velora-deploy"
trap 'rm -rf -- "$tmp_dir"' EXIT
trap - ERR
mkdir -p "$APP_DIR" "$STATE_DIR"
baseline="$tmp_dir/before.env"
calls="$tmp_dir/calls"
checks=0

# All production operations are stubbed; file/hash validation is real.
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
publish_deployment_metrics() { printf 'metrics:%s\n' "$1" >>"$calls"; }
reset_fixture() {
  printf 'DATABASE_URL=unchanged-test-value\n# preserved comment\n' >"$baseline"
  cp "$baseline" "$APP_DIR/.env"
  printf 'TURN_URLS=turn:relay.example:443\nTURN_USERNAME=test-user\nTURN_CREDENTIAL=test-password\n' >>"$APP_DIR/.env"
  STORED_ENV_HASH="$(sha256sum "$baseline" | awk '{print $1}')"
  CURRENT_ENV_HASH="$(env_hash)"
  printf '%s\n' "$STORED_ENV_HASH" >"$ENV_HASH_FILE"
  TURN_ENV_BASELINE="$baseline"
  TURN_ENV_APPROVED=false
  FORCE=false
  DRY_RUN=false
  RETRY_FAILED=false
  MODE=deploy
  DB_RISK=false
  PULL_SERVICES=()
  RECONCILE_SERVICES=()
  INFRA_RECONCILE_SERVICES=()
  CHANGED_FILES='apps/call-service/src/infrastructure/engines/turn-configuration.ts'
  TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  LAST_DEPLOYED_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  printf '%s\n' "$LAST_DEPLOYED_SHA" >"$STATE_FILE"
  : >"$calls"
}
pass() { checks=$((checks + 1)); }
reject() {
  local recorded_hash
  recorded_hash="$(cat "$ENV_HASH_FILE")"
  if ( "$@" ) >"$tmp_dir/rejected.log" 2>&1; then
    printf 'Expected rejection: %s\n' "$*" >&2
    exit 1
  fi
  ! grep -Fq 'test-password' "$tmp_dir/rejected.log"
  [[ "$(cat "$ENV_HASH_FILE")" == "$recorded_hash" ]]
  pass
}

reset_fixture
plan_from_changed_files
approve_turn_env
[[ "$TURN_ENV_APPROVED" == true && "$FORCE" == false ]]
[[ "${PULL_SERVICES[*]}" == call-service && "${RECONCILE_SERVICES[*]}" == call-service ]]
[[ "$(cat "$ENV_HASH_FILE")" == "$STORED_ENV_HASH" ]]
pass

reset_fixture
CURRENT_ENV_HASH="$(env_hash)"
STORED_ENV_HASH="$CURRENT_ENV_HASH"
reject approve_turn_env
reset_fixture
STORED_ENV_HASH=""
reject approve_turn_env
reset_fixture
printf 'UNRELATED=value\n' >>"$baseline"
reject approve_turn_env
reset_fixture
TURN_ENV_BASELINE="$tmp_dir/missing.env"
reject approve_turn_env

for addition in 'DATABASE_URL=changed' '# changed comment' 'TURN_CREDENTIAL=duplicate' 'export TURN_USERNAME=alternate' ' TURN_USERNAME=alternate'; do
  reset_fixture
  printf '%s\n' "$addition" >>"$APP_DIR/.env"
  CURRENT_ENV_HASH="$(env_hash)"
  reject approve_turn_env
done
for value in '"unclosed' '${DATABASE_URL}' "a'b" '`unclosed'; do
  reset_fixture
  cp "$baseline" "$APP_DIR/.env"
  printf 'TURN_URLS=turn:relay.example:443\nTURN_USERNAME=test-user\nTURN_CREDENTIAL=%s\n' "$value" >>"$APP_DIR/.env"
  CURRENT_ENV_HASH="$(env_hash)"
  reject approve_turn_env
done
reset_fixture
printf 'TURN_URLS="turn:relay.example:443"\nTURN_USERNAME=\x27test-user\x27\nTURN_CREDENTIAL="test-password"\n' >"$tmp_dir/quoted.env"
cp "$baseline" "$APP_DIR/.env"
while IFS= read -r line; do printf '%s\n' "$line" >>"$APP_DIR/.env"; done <"$tmp_dir/quoted.env"
CURRENT_ENV_HASH="$(env_hash)"
approve_turn_env
pass
reset_fixture
printf 'MULTILINE="\nTURN_USERNAME=old-user\n"\n' >>"$baseline"
printf 'MULTILINE="\nTURN_USERNAME=old-user\n"\n' >>"$APP_DIR/.env"
STORED_ENV_HASH="$(sha256sum "$baseline" | awk '{print $1}')"
CURRENT_ENV_HASH="$(env_hash)"
reject approve_turn_env
reset_fixture
printf 'OTHER=${TURN_USERNAME}\n' >>"$baseline"
printf 'OTHER=${TURN_USERNAME}\n' >>"$APP_DIR/.env"
STORED_ENV_HASH="$(sha256sum "$baseline" | awk '{print $1}')"
CURRENT_ENV_HASH="$(env_hash)"
reject approve_turn_env
reset_fixture
printf 'DATABASE_URL=changed-test-value\n# preserved comment\nTURN_URLS=turn:relay.example:443\nTURN_USERNAME=test-user\nTURN_CREDENTIAL=test-password\n' >"$APP_DIR/.env"
CURRENT_ENV_HASH="$(env_hash)"
reject approve_turn_env
reset_fixture
printf '# preserved comment\nTURN_URLS=turn:relay.example:443\nTURN_USERNAME=test-user\nTURN_CREDENTIAL=test-password\n' >"$APP_DIR/.env"
CURRENT_ENV_HASH="$(env_hash)"
reject approve_turn_env
reset_fixture
cp "$baseline" "$APP_DIR/.env"
printf 'TURN_URLS=turn:relay.example:443\nTURN_USERNAME=test-user\n' >>"$APP_DIR/.env"
CURRENT_ENV_HASH="$(env_hash)"
reject approve_turn_env
reset_fixture
cp "$baseline" "$APP_DIR/.env"
printf 'TURN_URLS=turn:relay.example:443\nTURN_USERNAME=\nTURN_CREDENTIAL=\n' >>"$APP_DIR/.env"
CURRENT_ENV_HASH="$(env_hash)"
reject approve_turn_env
reset_fixture
printf '\n' >>"$APP_DIR/.env"
reject approve_turn_env  # File changed since load_state, even before planning.

reset_fixture
CHANGED_FILES='apps/user-service/src/main.ts'
plan_from_changed_files
reject approve_turn_env
reset_fixture
PULL_SERVICES=(user-service)
reject approve_turn_env
reset_fixture
INFRA_RECONCILE_SERVICES=(nginx)
reject approve_turn_env
reset_fixture
DB_RISK=true
reject approve_turn_env

reset_fixture
TURN_ENV_BASELINE=""
parse_args --approve-turn-env "$baseline" --dry-run
[[ "$TURN_ENV_BASELINE" == "$baseline" && "$DRY_RUN" == true ]]
pass
reset_fixture
TURN_ENV_BASELINE=""
reject parse_args --approve-turn-env
reject parse_args --approve-turn-env --dry-run
reject parse_args --approve-turn-env relative.env
reject parse_args --approve-turn-env "$baseline" --force
reject parse_args --force --approve-turn-env "$baseline"
reject parse_args --approve-turn-env "$baseline" --rollback
reject parse_args --rollback --approve-turn-env "$baseline"
reject parse_args --approve-turn-env "$baseline" --approve-db-change "$TARGET_SHA"

# Support both credential rotation and turning TURN off.
for settings in rotation clear remove; do
  reset_fixture
  printf 'TURN_URLS=turn:old.example:80\nTURN_USERNAME=old-user\nTURN_CREDENTIAL=old-password\n' >>"$baseline"
  STORED_ENV_HASH="$(sha256sum "$baseline" | awk '{print $1}')"
  printf '%s\n' "$STORED_ENV_HASH" >"$ENV_HASH_FILE"
  if [[ "$settings" != rotation ]]; then
    printf 'DATABASE_URL=unchanged-test-value\n# preserved comment\n' >"$APP_DIR/.env"
    if [[ "$settings" == clear ]]; then
      printf 'TURN_URLS=\nTURN_USERNAME=\nTURN_CREDENTIAL=\n' >>"$APP_DIR/.env"
    fi
  fi
  CURRENT_ENV_HASH="$(env_hash)"
  approve_turn_env
  [[ "${RECONCILE_SERVICES[*]}" == call-service ]]
  pass
done

reset_fixture
approve_turn_env
restore_turn_env_for_rollback
cmp -s "$baseline" "$APP_DIR/.env"
[[ "$(cat "$ENV_HASH_FILE")" == "$STORED_ENV_HASH" ]]
if [[ "$(uname -s)" == Darwin ]]; then
  [[ "$(stat -f '%Lp' "$APP_DIR/.env")" == 600 ]]
else
  [[ "$(stat -c '%a' "$APP_DIR/.env")" == 600 ]]
fi
pass
reset_fixture
approve_turn_env
printf 'OPERATOR_EDIT=preserve-me\n' >>"$APP_DIR/.env"
reject restore_turn_env_for_rollback
grep -Fq 'OPERATOR_EDIT=preserve-me' "$APP_DIR/.env"
reset_fixture
approve_turn_env
printf 'OPERATOR_EDIT=preserve-me\n' >>"$baseline"
reject restore_turn_env_for_rollback

# Exercise the real orchestration path, including same-SHA credential changes.
for stub in preflight_resources validate_rabbitmq_static_config validate_rabbitmq_live validate_target_files prepare_baseline_compose compute_changed_files classify_db_impact compare_compose_models ensure_manual_db_approval check_blocked_release validate_target_infrastructure public_smoke_warning_only send_deployment_receipt post_success_cleanup remove_removed_compose_services; do
  eval "$stub() { :; }"
done
prepull_target_images() { printf 'pull\n' >>"$calls"; }
prepull_managed_infra() { :; }
snapshot_current_release() { TEMP_SNAPSHOT="$tmp_dir/snapshot.json"; printf '{}\n' >"$TEMP_SNAPSHOT"; }
checkout_release() { printf 'checkout\n' >>"$calls"; }
docker() { printf 'docker:%s\n' "$*" >>"$calls"; }
verify_deployment_health() {
  [[ "$(cat "$ENV_HASH_FILE")" == "$STORED_ENV_HASH" ]] || return 1
  printf 'health\n' >>"$calls"
  return "${TEST_HEALTH_EXIT:-0}"
}
save_local_deployment_receipt() { printf 'receipt:%s\n' "$1" >>"$calls"; }
promote_snapshot_to_previous_release() { :; }
already_deployed_path() { fail 'Unexpected same-SHA shortcut'; }
remove_removed_compose_services() { printf 'remove-deprecated\n' >>"$calls"; }
block_release() { printf 'blocked\n' >>"$calls"; }
remove_snapshot_tags() { :; }
reclaim_unused_docker_images() { :; }

reset_fixture
DRY_RUN=true
( perform_deployment ) >"$tmp_dir/dry-run.log"
! grep -Eq '^(pull|checkout|docker:)' "$calls"
[[ "$(cat "$ENV_HASH_FILE")" == "$STORED_ENV_HASH" ]]
pass
reset_fixture
LAST_DEPLOYED_SHA="$TARGET_SHA"
( perform_deployment ) >"$tmp_dir/success.log"
grep -Fxq 'docker:compose up -d --no-deps call-service' "$calls"
! grep -Fxq 'remove-deprecated' "$calls"
[[ "$(cat "$ENV_HASH_FILE")" == "$CURRENT_ENV_HASH" ]]
[[ "$(cat "$STATE_FILE")" == "$TARGET_SHA" ]]
pass

reset_fixture
TURN_ENV_BASELINE=""
reject perform_deployment
grep -Fxq 'metrics:config-drift' "$calls"
! grep -Eq '^(pull|checkout|docker:)' "$calls"

reset_fixture
TURN_ENV_BASELINE=""
STORED_ENV_HASH="$CURRENT_ENV_HASH"
printf '%s\n' "$STORED_ENV_HASH" >"$ENV_HASH_FILE"
( perform_deployment ) >"$tmp_dir/normal-success.log"
grep -Fxq 'docker:compose up -d --no-deps call-service' "$calls"
grep -Fxq 'remove-deprecated' "$calls"
pass

for guard in ensure_manual_db_approval check_blocked_release; do
  reset_fixture
  original_guard="$(declare -f "$guard")"
  eval "$guard() { fail 'Existing deployment gate remains enforced'; }"
  reject perform_deployment
  ! grep -Eq '^(pull|checkout|docker:)' "$calls"
  eval "$original_guard"
done

reset_fixture
approve_turn_env
printf 'OPERATOR_EDIT=preserve-me\n' >>"$APP_DIR/.env"
reject persist_success_state
[[ "$(cat "$STATE_FILE")" == "$LAST_DEPLOYED_SHA" ]]

reset_fixture
original_prepull="$(declare -f prepull_target_images)"
prepull_target_images() { printf 'OPERATOR_EDIT=preserve-me\n' >>"$APP_DIR/.env"; }
reject perform_deployment
! grep -Eq '^(checkout|docker:)' "$calls"
eval "$original_prepull"

reset_fixture
TEST_HEALTH_EXIT=1
DEPLOYMENT_FAILURE_DETAIL='test health failure'
DEPLOYMENT_FAILURE_ACTION='inspect test'
rollback_from_snapshot() {
  cmp -s "$baseline" "$APP_DIR/.env" || return 1
  printf 'rollback-with-old-env\n' >>"$calls"
}
reject perform_deployment
grep -Fxq 'rollback-with-old-env' "$calls"
cmp -s "$baseline" "$APP_DIR/.env"

printf 'TURN env approval: PASS (%s checks)\n' "$checks"
