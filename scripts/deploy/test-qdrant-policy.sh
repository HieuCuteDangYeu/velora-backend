#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root/scripts/deploy/velora-deploy"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
printf 'DOCKERHUB_USERNAME=fixture\nPOSTGRES_PASSWORD=fixture\nMONGO_INITDB_ROOT_PASSWORD=fixture\nREDIS_PASSWORD=fixture\n' >"$tmp/.env"
(
  cd "$tmp"
  docker compose --env-file "$tmp/.env" -f "$root/docker-compose.yml" -f "$root/docker-compose.qdrant.yml" --profile qdrant config --no-path-resolution --format json
) >"$tmp/target.json"
jq 'del(.services.qdrant,.networks["reel-vector-net"],.volumes.qdrant_storage,.volumes.qdrant_snapshots,.secrets)
  | .services |= with_entries(if (.key | startswith("reel-indexing")) then .value |= (del(.secrets,.networks["reel-vector-net"]) | .environment |= del(.QDRANT_URL,.QDRANT_API_KEY_FILE,.NODE_EXTRA_CA_CERTS,.INDEX_VECTOR_SEARCH_BACKEND,.INDEX_VECTOR_PROJECTION_ENABLED,.INDEX_VECTOR_PUBLICATION_REQUIRED,.INDEX_VECTOR_SHADOW_COMPARE)) else . end)' "$tmp/target.json" >"$tmp/base.json"
compare() {
  (
    LAST_DEPLOYED_SHA=0000000000000000000000000000000000000001
    BASELINE_DIR="$tmp"; STAGING_DIR="$tmp"; BASE_COMPOSE_JSON="$tmp/base.json"; TARGET_COMPOSE_JSON="$1"
    INFRA_RECONCILE_SERVICES=(); RECONCILE_SERVICES=(); PULL_SERVICES=()
    compare_compose_models
    printf 'INFRA=%s\n' "${INFRA_RECONCILE_SERVICES[*]:-}"
  )
}
output="$(compare "$tmp/target.json")"
grep -qx 'INFRA=qdrant' <<<"$output"
for mutation in '.services.qdrant.ports=[{target:6333,published:"6333"}]' '.networks["reel-vector-net"].internal=false' '.services["ai-service"].secrets=[{source:"qdrant_api_key"}]' '.services["reel-indexing-service"].environment.INDEX_VECTOR_SEARCH_BACKEND="qdrant"' '.services["reel-indexing-service"].environment.INDEX_WORKER_LANE="LONG"' '.volumes.surprise={}' '.services.qdrant.volumes += [{type:"bind",source:"/",target:"/host"}]'; do
  jq "$mutation" "$tmp/target.json" >"$tmp/bad.json"
  if compare "$tmp/bad.json" >/dev/null 2>&1; then printf 'Unsafe Qdrant model accepted: %s\n' "$mutation" >&2; exit 1; fi
done
(
  CHANGED_FILES=infra/qdrant/config.yaml; INFRA_RECONCILE_SERVICES=(); RECONCILE_SERVICES=(); FORCE=false
  plan_from_changed_files
  [[ "${INFRA_RECONCILE_SERVICES[*]}" == qdrant && ${#RECONCILE_SERVICES[@]} == 0 ]]
)
# The handler preserves named volumes and never force-recreates Qdrant.
(
  docker() { printf '%s\n' "$*" >>"$tmp/calls"; }
  qdrant_deploy_preflight() { :; }
  TARGET_SHA=fixture
  reconcile_qdrant
)
grep -qx 'compose --profile qdrant up -d --no-deps qdrant' "$tmp/calls"
! grep -q 'force-recreate\|down\|volume rm' "$tmp/calls"
printf 'qdrant policy: PASS\n'
# A baseline release without the new overlay must still render during comparison/rollback.
(
  mkdir -p "$tmp/legacy"
  docker() { printf '%s\n' "${COMPOSE_FILE:-}"; }
  COMPOSE_FILE=docker-compose.yml:docker-compose.qdrant.yml
  [[ "$(render_compose_json "$tmp/legacy" fixture)" == docker-compose.yml ]]
)

# An already reviewed serving configuration remains deployable when it is unchanged.
(
  jq '.services["reel-indexing-service"].environment.INDEX_VECTOR_SEARCH_BACKEND="qdrant" | .services["reel-indexing-long-service"].environment.INDEX_VECTOR_SEARCH_BACKEND="qdrant"' "$tmp/target.json" > "$tmp/serving.json"
  cp "$tmp/serving.json" "$tmp/base.json"
  compare "$tmp/serving.json" | grep -qx 'INFRA='
)
