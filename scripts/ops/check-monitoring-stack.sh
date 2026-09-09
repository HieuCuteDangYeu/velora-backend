#!/usr/bin/env bash
set -euo pipefail

PROMETHEUS_URL="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
GRAFANA_URL="${GRAFANA_URL:-http://127.0.0.1:3001}"
TARGET_RETRY_ATTEMPTS="${TARGET_RETRY_ATTEMPTS:-9}"
TARGET_RETRY_DELAY_SECONDS="${TARGET_RETRY_DELAY_SECONDS:-5}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
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
  return 1
}

require_command curl
require_command jq

echo "[1/6] Checking Prometheus readiness..."
curl --fail --silent --show-error "${PROMETHEUS_URL}/-/ready" >/dev/null
echo "      Prometheus is ready"

echo "[2/6] Checking monitoring-service scrape target..."
wait_for_prometheus_target "monitoring-service" "monitoring-service"

echo "[3/6] Checking conversation-service scrape target..."
wait_for_prometheus_target "conversation-service" "conversation-service"

echo "[4/6] Checking call-service scrape target..."
wait_for_prometheus_target "call-service" "call-service"

echo "[5/6] Checking host node-exporter scrape target..."
wait_for_prometheus_target "node-exporter" "node-exporter"

echo "[6/6] Checking Grafana health..."
wait_for_grafana_health

echo
printf 'Monitoring smoke check passed.\nPrometheus:           %s\nMonitoring service:   UP\nConversation service: UP\nCall service:         UP\nNode exporter:        UP\nGrafana:              %s\n' \
  "$PROMETHEUS_URL" "$GRAFANA_URL"
