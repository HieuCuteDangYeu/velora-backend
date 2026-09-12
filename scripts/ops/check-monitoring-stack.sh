#!/usr/bin/env bash
set -euo pipefail

PROMETHEUS_URL="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
LOKI_URL="${LOKI_URL:-http://127.0.0.1:3100}"
GRAFANA_URL="${GRAFANA_URL:-http://127.0.0.1:3001}"
TARGET_RETRY_ATTEMPTS="${TARGET_RETRY_ATTEMPTS:-9}"
TARGET_RETRY_DELAY_SECONDS="${TARGET_RETRY_DELAY_SECONDS:-5}"

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

check_docker_engine_access() {
  local attempt

  for ((attempt = 1; attempt <= TARGET_RETRY_ATTEMPTS; attempt += 1)); do
    if docker compose exec -T monitoring-service node <<'NODE'
const http = require('node:http');

const requestJson = (path) => new Promise((resolve, reject) => {
  const request = http.request({
    socketPath: process.env.DOCKER_ENGINE_SOCKET || '/var/run/docker.sock',
    path,
    headers: { Accept: 'application/json' },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (response.statusCode !== 200) {
        reject(new Error(`Docker Engine returned HTTP ${response.statusCode}`));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Docker Engine returned invalid JSON'));
      }
    });
  });
  request.setTimeout(5000, () => request.destroy(new Error('Docker Engine request timed out')));
  request.on('error', reject);
  request.end();
});

(async () => {
  const containers = await requestJson('/containers/json?all=false');
  if (!Array.isArray(containers)) throw new Error('Docker Engine returned an invalid container list');
  const first = containers[0];
  if (first?.Id) await requestJson(`/containers/${first.Id}/stats?stream=false`);
  console.log(`      Docker Engine API is reachable (${containers.length} running containers)`);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE
    then
      return 0
    fi

    if (( attempt < TARGET_RETRY_ATTEMPTS )); then
      echo "      Docker Engine API is not ready yet; retrying in ${TARGET_RETRY_DELAY_SECONDS}s (${attempt}/${TARGET_RETRY_ATTEMPTS})..."
      sleep "$TARGET_RETRY_DELAY_SECONDS"
    fi
  done

  echo "      monitoring-service cannot reach the Docker Engine socket after ${TARGET_RETRY_ATTEMPTS} attempts" >&2
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

echo "[1/10] Checking Prometheus readiness..."
curl --fail --silent --show-error "${PROMETHEUS_URL}/-/ready" >/dev/null
echo "      Prometheus is ready"

echo "[2/10] Checking monitoring-service scrape target..."
wait_for_prometheus_target "monitoring-service" "monitoring-service"

echo "[3/10] Checking conversation-service scrape target..."
wait_for_prometheus_target "conversation-service" "conversation-service"

echo "[4/10] Checking call-service scrape target..."
wait_for_prometheus_target "call-service" "call-service"

echo "[5/10] Checking host node-exporter scrape target..."
wait_for_prometheus_target "node-exporter" "node-exporter"

echo "[6/10] Checking Docker Engine API access..."
check_docker_engine_access

echo "[7/10] Checking Loki readiness..."
wait_for_loki_ready

echo "[8/10] Checking monitoring-service to Loki Docker DNS/network..."
check_loki_from_monitoring_service

echo "[9/10] Checking Alloy log collector..."
check_alloy_running

echo "[10/10] Checking Grafana health..."
wait_for_grafana_health

echo
printf 'Monitoring smoke check passed.\nPrometheus:           %s\nMonitoring service:   UP\nConversation service: UP\nCall service:         UP\nNode exporter:        UP\nDocker Engine:        UP\nLoki:                 %s\nAlloy:                UP\nGrafana:              %s\n' \
  "$PROMETHEUS_URL" "$LOKI_URL" "$GRAFANA_URL"
