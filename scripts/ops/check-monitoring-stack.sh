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

require_command curl
require_command jq

echo "[1/5] Checking Prometheus readiness..."
curl --fail --silent --show-error "${PROMETHEUS_URL}/-/ready" >/dev/null
echo "      Prometheus is ready"

echo "[2/5] Checking monitoring-service scrape target..."
wait_for_prometheus_target "monitoring-service" "monitoring-service"

echo "[3/5] Checking conversation-service scrape target..."
wait_for_prometheus_target "conversation-service" "conversation-service"

echo "[4/5] Checking host node-exporter scrape target..."
wait_for_prometheus_target "node-exporter" "node-exporter"

echo "[5/5] Checking Grafana health..."
grafana_response="$(curl --fail --silent --show-error "${GRAFANA_URL}/api/health")"
database_status="$(jq -r '.database // "unknown"' <<<"$grafana_response")"
if [ "$database_status" != "ok" ]; then
  echo "      Grafana database health is ${database_status}" >&2
  jq . <<<"$grafana_response" >&2
  exit 1
fi
echo "      Grafana is healthy"

echo
printf 'Monitoring smoke check passed.\nPrometheus:           %s\nMonitoring service:   UP\nConversation service: UP\nNode exporter:        UP\nGrafana:              %s\n' \
  "$PROMETHEUS_URL" "$GRAFANA_URL"
