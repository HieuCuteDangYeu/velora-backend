#!/usr/bin/env bash
set -euo pipefail

PROMETHEUS_URL="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
LOKI_URL="${LOKI_URL:-http://127.0.0.1:3100}"
GRAFANA_URL="${GRAFANA_URL:-http://127.0.0.1:3001}"
TARGET_RETRY_ATTEMPTS="${TARGET_RETRY_ATTEMPTS:-9}"
TARGET_RETRY_DELAY_SECONDS="${TARGET_RETRY_DELAY_SECONDS:-5}"
CADVISOR_ENABLED="${CADVISOR_ENABLED:-true}"
CADVISOR_ENABLED="$(printf '%s' "$CADVISOR_ENABLED" | tr '[:upper:]' '[:lower:]')"
cadvisor_status="UP"
[ "$CADVISOR_ENABLED" = "false" ] && cadvisor_status="DISABLED"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

capture_grafana_diagnostics() {
  local container_id

  container_id="$(docker compose ps -aq grafana 2>/dev/null | head -n 1 || true)"
  if [ -z "$container_id" ]; then
    echo "      Grafana diagnostics: no Compose container found" >&2
    docker compose ps grafana >&2 2>/dev/null || true
    return 0
  fi

  echo "      ===== Grafana diagnostics before rollback =====" >&2
  echo "      Container: $container_id" >&2
  docker inspect --format \
    'State={{json .State}} Image={{.Image}} RestartCount={{.RestartCount}}' \
    "$container_id" >&2 2>/dev/null || true
  echo "      Mounts:" >&2
  docker inspect --format '{{json .Mounts}}' "$container_id" >&2 2>/dev/null || true
  echo "      Networks:" >&2
  docker inspect --format '{{json .NetworkSettings.Networks}}' "$container_id" >&2 2>/dev/null || true
  echo "      Stats:" >&2
  docker stats --no-stream "$container_id" >&2 2>/dev/null || true
  echo "      Last 300 Grafana log lines:" >&2
  docker logs --tail 300 "$container_id" >&2 2>/dev/null || true
  echo "      ===== End Grafana diagnostics =====" >&2
}

wait_for_prometheus_target() {
  local job="$1"
  local display_name="$2"
  local attempt response value

  for ((attempt = 1; attempt <= TARGET_RETRY_ATTEMPTS; attempt += 1)); do
    response="$(
      curl --fail --silent --show-error --get \
        --data-urlencode "query=up{job=\"${job}\"}" \
        "${PROMETHEUS_URL}/api/v1/query"
    )"

    value="$(jq -r '.data.result[0].value[1] // "missing"' <<<"$response")"
    if [ "$value" = "1" ]; then
      echo "      ${display_name} target is UP"
      return 0
    fi

    if (( attempt < TARGET_RETRY_ATTEMPTS )); then
      echo "      ${display_name} target is not UP yet (${value}); retrying in ${TARGET_RETRY_DELAY_SECONDS}s (${attempt}/${TARGET_RETRY_ATTEMPTS})..."
      sleep "$TARGET_RETRY_DELAY_SECONDS"
    fi
  done

  echo "      ${display_name} target is not UP after ${TARGET_RETRY_ATTEMPTS} attempts" >&2
  jq '.data.result' <<<"$response" >&2
  return 1
}

wait_for_container_metrics() {
  local attempt response value

  for ((attempt = 1; attempt <= TARGET_RETRY_ATTEMPTS; attempt += 1)); do
    response="$(
      curl --fail --silent --show-error --get \
        --data-urlencode 'query=count(container_memory_working_set_bytes{job="cadvisor",name!=""})' \
        "${PROMETHEUS_URL}/api/v1/query"
    )"

    value="$(jq -r '.data.result[0].value[1] // "0"' <<<"$response")"
    if [ "$value" != "0" ] && [ "$value" != "null" ]; then
      echo "      cAdvisor is reporting ${value} container(s)"
      return 0
    fi

    if (( attempt < TARGET_RETRY_ATTEMPTS )); then
      echo "      cAdvisor has not exposed container metrics yet; retrying in ${TARGET_RETRY_DELAY_SECONDS}s (${attempt}/${TARGET_RETRY_ATTEMPTS})..."
      sleep "$TARGET_RETRY_DELAY_SECONDS"
    fi
  done

  echo "      cAdvisor did not expose container metrics after ${TARGET_RETRY_ATTEMPTS} attempts" >&2
  jq '.data.result' <<<"$response" >&2
  return 1
}

wait_for_grafana_health() {
  local attempt response database_status

  for ((attempt = 1; attempt <= TARGET_RETRY_ATTEMPTS; attempt += 1)); do
    response="$(
      curl --fail --silent --show-error \
        --connect-timeout 3 \
        --max-time 5 \
        "${GRAFANA_URL}/api/health" 2>/dev/null || true
    )"

    database_status="unknown"
    if [ -n "$response" ]; then
      database_status="$(jq -r '.database // "unknown"' <<<"$response" 2>/dev/null || printf 'unknown')"
    fi

    if [ "$database_status" = "ok" ]; then
      echo "      Grafana is healthy"
      return 0
    fi

    if (( attempt < TARGET_RETRY_ATTEMPTS )); then
      echo "      Grafana is not ready yet (${database_status}); retrying in ${TARGET_RETRY_DELAY_SECONDS}s (${attempt}/${TARGET_RETRY_ATTEMPTS})..."
      sleep "$TARGET_RETRY_DELAY_SECONDS"
    fi
  done

  echo "      Grafana did not become healthy after ${TARGET_RETRY_ATTEMPTS} attempts" >&2
  if [ -n "$response" ]; then
    jq . <<<"$response" >&2 2>/dev/null || printf '%s\n' "$response" >&2
  fi
  capture_grafana_diagnostics
  return 1
}

wait_for_loki_ready() {
  local attempt
  for ((attempt = 1; attempt <= TARGET_RETRY_ATTEMPTS; attempt += 1)); do
    if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 "${LOKI_URL}/ready" >/dev/null 2>&1; then
      echo "      Loki is ready"
      return 0
    fi
    if (( attempt < TARGET_RETRY_ATTEMPTS )); then
      echo "      Loki is not ready yet; retrying in ${TARGET_RETRY_DELAY_SECONDS}s (${attempt}/${TARGET_RETRY_ATTEMPTS})..."
      sleep "$TARGET_RETRY_DELAY_SECONDS"
    fi
  done

  echo "      Loki did not become ready after ${TARGET_RETRY_ATTEMPTS} attempts" >&2
  docker compose ps loki >&2 2>/dev/null || true
  docker compose logs --tail 200 loki >&2 2>/dev/null || true
  return 1
}

check_loki_from_monitoring_service() {
  if docker compose exec -T monitoring-service node <<'NODE'
const url = 'http://loki:3100/ready';
fetch(url, { signal: AbortSignal.timeout(5000) })
  .then(async (response) => {
    const body = await response.text();
    if (!response.ok || !body.toLowerCase().includes('ready')) {
      console.error(`Loki internal readiness failed: HTTP ${response.status}: ${body}`);
      process.exit(1);
    }
    console.log(`      monitoring-service -> Loki DNS/network is healthy (HTTP ${response.status})`);
  })
  .catch((error) => {
    console.error(error);
    if (error && error.cause) console.error('cause:', error.cause);
    process.exit(1);
  });
NODE
  then
    return 0
  fi

  echo "      monitoring-service cannot reach Loki through Docker DNS/network" >&2
  return 1
}

check_alloy_running() {
  local container_id
  container_id="$(docker compose ps --status running -q alloy 2>/dev/null | head -n 1 || true)"
  if [ -n "$container_id" ]; then
    echo "      Alloy is running"
    return 0
  fi

  echo "      Alloy is not running" >&2
  docker compose ps alloy >&2 2>/dev/null || true
  docker compose logs --tail 200 alloy >&2 2>/dev/null || true
  return 1
}

require_command curl
require_command jq
require_command docker

echo "[1/11] Checking Prometheus readiness..."
curl --fail --silent --show-error "${PROMETHEUS_URL}/-/ready" >/dev/null
echo "      Prometheus is ready"

echo "[2/11] Checking monitoring-service scrape target..."
wait_for_prometheus_target "monitoring-service" "monitoring-service"

echo "[3/11] Checking conversation-service scrape target..."
wait_for_prometheus_target "conversation-service" "conversation-service"

echo "[4/11] Checking call-service scrape target..."
wait_for_prometheus_target "call-service" "call-service"

echo "[5/11] Checking host node-exporter scrape target..."
wait_for_prometheus_target "node-exporter" "node-exporter"

if [ "$cadvisor_status" = "UP" ]; then
  echo "[6/11] Checking cAdvisor scrape target..."
  wait_for_prometheus_target "cadvisor" "cAdvisor"

  echo "[7/11] Checking cAdvisor container metrics..."
  wait_for_container_metrics
else
  echo "[6/11] Skipping cAdvisor scrape target (CADVISOR_ENABLED=false)"
  echo "[7/11] Skipping cAdvisor container metrics (CADVISOR_ENABLED=false)"
fi

echo "[8/11] Checking Loki readiness..."
wait_for_loki_ready

echo "[9/11] Checking monitoring-service to Loki Docker DNS/network..."
check_loki_from_monitoring_service

echo "[10/11] Checking Alloy log collector..."
check_alloy_running

echo "[11/11] Checking Grafana health..."
wait_for_grafana_health

echo
printf 'Monitoring smoke check passed.\nPrometheus:           %s\nMonitoring service:   UP\nConversation service: UP\nCall service:         UP\nNode exporter:        UP\ncAdvisor:             %s\nLoki:                 %s\nAlloy:                UP\nGrafana:              %s\n' \
  "$PROMETHEUS_URL" "$cadvisor_status" "$LOKI_URL" "$GRAFANA_URL"
