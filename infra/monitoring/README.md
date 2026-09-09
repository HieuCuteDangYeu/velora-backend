# Velora monitoring stack

This directory contains the local Prometheus + Grafana + Loki stack for Velora observability.
It is intentionally an overlay for the repository root `docker-compose.yml` so the
existing application topology stays unchanged.

Prometheus stores metrics, evaluates active alert rules, and exposes their current
pending/firing state. Loki stores Docker service logs, Grafana can inspect both, and
Grafana Alloy discovers Compose containers and forwards their stdout/stderr to Loki.
Node Exporter supplies host CPU, memory, swap, filesystem, load, and uptime metrics.
Promtail is intentionally not used because it reached end of life in 2026.

## Start

Set Grafana credentials in your shell or `.env`. The password is required so the
stack cannot silently start with `admin/admin`:

```bash
export GRAFANA_ADMIN_USER=admin
export GRAFANA_ADMIN_PASSWORD='change-me'
```

The 8 GB self-host profile applies conservative memory caps by default:

```text
Prometheus:    512 MiB
Node Exporter:  64 MiB
Loki:          384 MiB
Alloy:         192 MiB
Grafana:       256 MiB
```

Override the monitoring components only after measuring the host:

```bash
export PROMETHEUS_MEMORY_LIMIT=768m
export LOKI_MEMORY_LIMIT=512m
export ALLOY_MEMORY_LIMIT=256m
export GRAFANA_MEMORY_LIMIT=384m
```

Start the application services together with the monitoring overlay. Conversation and
Call expose lightweight `/metrics` endpoints on their existing HTTP ports; no extra
metrics process is created inside either service.

```bash
docker compose \
  -f docker-compose.yml \
  -f infra/monitoring/docker-compose.monitoring.yml \
  up -d conversation-service call-service monitoring-service \
    node-exporter prometheus loki alloy grafana
```

Alloy reads Docker metadata and stdout/stderr through the Docker socket. Keep Alloy
internal to the host and do not expose its control plane publicly.

## Verify

Run the end-to-end smoke check from the repository root after the application services
are healthy:

```bash
bash scripts/ops/check-monitoring-stack.sh
```

It verifies:

1. Prometheus readiness.
2. Node Exporter, monitoring-service, conversation-service, and call-service scrape targets.
3. Loki readiness.
4. Grafana database health.

For exporter-level inspection, Prometheus scrapes:

```text
node-exporter:9100/metrics
monitoring-service:3016/metrics
conversation-service:3005/metrics
call-service:3007/metrics
```

Prometheus is bound to localhost only at `http://127.0.0.1:9090`.
Loki is bound to localhost only at `http://127.0.0.1:3100`.
Grafana is bound to localhost only at `http://127.0.0.1:3001`.

The Prometheus and Loki datasources and the **Velora / Monitoring Service** dashboard
are provisioned automatically in Grafana.

## Velora admin web

The browser talks only to API Gateway. It never receives direct Prometheus or Loki
access:

```text
Metrics: Velora frontend -> /api/monitoring/* -> API Gateway -> monitoring-service -> Prometheus
Alerts:  Velora frontend -> /api/monitoring/alerts -> API Gateway -> monitoring-service -> Prometheus
Logs:    Velora frontend -> /api/monitoring/logs -> API Gateway -> monitoring-service -> Loki
```

The API Gateway requires an authenticated `ADMIN` user. The available observability
endpoints are:

```text
GET /api/monitoring/overview
GET /api/monitoring/timeseries
GET /api/monitoring/alerts
GET /api/monitoring/logs?service=call-service&level=error&from=...&to=...&limit=200
```

Metric queries use a server-side whitelist and bounded time range; clients cannot
submit arbitrary PromQL. The alert endpoint exposes only Prometheus's currently active
pending/firing rule instances. Log queries are also bounded to known Velora Compose
services, a maximum 24-hour range, a maximum 500 returned lines, and an optional
200-character text search. Clients cannot submit arbitrary LogQL.

Host metrics come from Node Exporter. Monitoring, Conversation, and Call process
metrics are emitted directly by their existing Node.js processes using the Prometheus
text format, so the runtime overhead stays small. Conversation additionally records
message persistence rate, send attempt result, and send persistence latency at the
`SendMessageUseCase` boundary.

A rejected `send_message` can happen in the WebSocket gateway before that use case
(for example an invalid client message id or a membership rejection). That rejection
rate is deliberately returned as unavailable until the gateway itself is instrumented;
the monitoring API does not manufacture a zero value for a metric that is not measured.

## Alerts

Prometheus evaluates alert rules locally; there is no Alertmanager process in this
lightweight profile. The admin web can show active pending/firing alerts, but this stack
does not send email, Slack, or push notifications yet. Add Alertmanager later only if
external notification routing, silences, grouping, or inhibition become necessary.

Rules currently cover node-exporter availability, sustained host CPU/memory/disk
pressure, Conversation/Call scrape availability and event-loop delay, Conversation
message persistence error/latency, and monitoring-service availability/RPC health.

## Retention and resource scope

The local profile uses a 15-second Prometheus scrape interval, three-day Prometheus
retention, and three-day Loki retention. This keeps the footprint small for the 8 GB
self-hosted development/thesis server. Increase retention only after measuring actual
disk and RAM usage.

Loki stores the existing application stdout/stderr as-is. Many current Nest services
still emit plain text rather than structured JSON, so the admin API infers a simple
level (`error`, `warn`, `debug`, `info`) from Docker stream and log text. Service and
container identity are reliable Docker labels; richer request/call correlation should
be added later at the application logging layer instead of being invented in the UI.

## Security

Do not expose ports 9090, 3100, or 3001 directly to the public internet. In production,
keep Prometheus and Loki internal and put Grafana behind authenticated ingress/VPN if
remote access is required. The Velora admin frontend should read selected observability
data through API Gateway -> monitoring-service rather than sending arbitrary PromQL or
LogQL to the backing systems.
