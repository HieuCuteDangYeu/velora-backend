# Velora monitoring stack

This directory contains the local Prometheus + Grafana stack for `monitoring-service`.
It is intentionally an overlay for the repository root `docker-compose.yml` so the
existing application topology stays unchanged.

## Start

Set Grafana credentials in your shell or `.env`. The password is required so the
stack cannot silently start with `admin/admin`:

```bash
export GRAFANA_ADMIN_USER=admin
export GRAFANA_ADMIN_PASSWORD='change-me'
```

The 8 GB self-host profile also applies conservative memory caps by default:

```text
Prometheus: 512 MiB
Grafana:    256 MiB
```

Override them only after measuring the host:

```bash
export PROMETHEUS_MEMORY_LIMIT=768m
export GRAFANA_MEMORY_LIMIT=384m
```

Then start the existing stack together with the monitoring overlay:

```bash
docker compose \
  -f docker-compose.yml \
  -f infra/monitoring/docker-compose.monitoring.yml \
  up -d monitoring-service prometheus grafana
```

## Verify

Run the end-to-end smoke check from the repository root:

```bash
bash scripts/ops/check-monitoring-stack.sh
```

It verifies:

1. Prometheus readiness.
2. `up{job="monitoring-service"} == 1`.
3. Grafana database health.

For exporter-level inspection, the application endpoint remains internal to the
Docker network:

```bash
docker compose \
  -f docker-compose.yml \
  -f infra/monitoring/docker-compose.monitoring.yml \
  exec monitoring-service \
  node -e "require('http').get('http://127.0.0.1:3016/metrics',r=>{r.pipe(process.stdout);r.on('end',()=>process.exit(r.statusCode===200?0:1))}).on('error',()=>process.exit(1))"
```

Prometheus is bound to localhost only:

```text
http://127.0.0.1:9090
```

Open **Status -> Targets** and confirm `monitoring-service` is `UP`.
Useful first queries:

```promql
up{job="monitoring-service"}
velora_process_resident_memory_bytes{service="monitoring-service"}
sum(rate(velora_monitoring_rpc_requests_total[5m]))
histogram_quantile(0.95, sum by (le) (rate(velora_monitoring_rpc_duration_seconds_bucket[5m])))
```

Grafana is bound to localhost only:

```text
http://127.0.0.1:3001
```

The Prometheus datasource and the **Velora / Monitoring Service** dashboard are
provisioned automatically.

## Velora admin web

The browser does not talk to Prometheus directly. The data path is:

```text
Velora frontend -> /api/monitoring/* -> API Gateway -> monitoring-service -> Prometheus
```

The API Gateway requires an authenticated `ADMIN` user. The available endpoints are:

```text
GET /api/monitoring/overview
GET /api/monitoring/timeseries
```

The timeseries endpoint accepts only the server-side metric whitelist and a bounded
range; clients cannot submit arbitrary PromQL.

## Retention and scrape interval

The local profile uses a 15-second scrape interval and three-day Prometheus
retention. This keeps the footprint small for development and the thesis test
server. Increase retention only after measuring actual TSDB disk/RAM usage.

## Security

Do not expose ports 9090 or 3001 directly to the public internet. In production,
keep Prometheus internal and put Grafana behind authenticated ingress/VPN if remote
access is required. The Velora admin frontend should read selected metrics through
API Gateway -> monitoring-service instead of sending arbitrary PromQL to Prometheus.
