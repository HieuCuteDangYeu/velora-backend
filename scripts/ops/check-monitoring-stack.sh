#!/usr/bin/env bash
set -euo pipefail

PROMETHEUS_URL="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
GRAFANA_URL="${GRAFANA_URL:-http://127.0.0.1:3001}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command curl
require_command jq

echo "[1/5] Checking Prometheus readiness..."
curl --fail --silent --show-error "${PROMETHEUS_URL}/-/ready" >/dev/null
echo "      Prometheus is ready"

echo "[2/5] Checking monitoring-service scrape target..."
target_response="$(
  curl --fail --silent --show-error --get \
    --data-urlencode 'query=up{job="monitoring-service"}' \
    "${PROMETHEUS_URL}/api/v1/query"
)"

target_value="$(jq -r '.data.result[0].value[1] // "0"' <<<"$target_response")"
if [ "$target_value" != "1" ]; then
  echo "      monitoring-service target is not UP" >&2
  jq '.data.result' <<<"$target_response" >&2
  exit 1
fi
echo "      monitoring-service target is UP"

echo "[3/5] Checking conversation-service scrape target..."
conversation_response="$(
  curl --fail --silent --show-error --get \
    --data-urlencode 'query=up{job="conversation-service"}' \
    "${PROMETHEUS_URL}/api/v1/query"
)"

conversation_value="$(jq -r '.data.result[0].value[1] // "0"' <<<"$conversation_response")"
if [ "$conversation_value" != "1" ]; then
  echo "      conversation-service target is not UP" >&2
  jq '.data.result' <<<"$conversation_response" >&2
  exit 1
fi
echo "      conversation-service target is UP"

echo "[4/5] Checking host node-exporter scrape target..."
node_response="$(
  curl --fail --silent --show-error --get \
    --data-urlencode 'query=up{job="node-exporter"}' \
    "${PROMETHEUS_URL}/api/v1/query"
)"

node_value="$(jq -r '.data.result[0].value[1] // "0"' <<<"$node_response")"
if [ "$node_value" != "1" ]; then
  echo "      node-exporter target is not UP" >&2
  jq '.data.result' <<<"$node_response" >&2
  exit 1
fi
echo "      node-exporter target is UP"

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
printf 'Monitoring smoke check passed.\nPrometheus:           %s\nConversation service: UP\nNode exporter:        UP\nGrafana:              %s\n' \
  "$PROMETHEUS_URL" "$GRAFANA_URL"
