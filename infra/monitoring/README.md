# Velora monitoring stack

This directory contains the Prometheus and Grafana configuration used by the
repository root `docker-compose.yml`. Prometheus, Grafana, and
`monitoring-service` are part of the default homelab Compose topology so the
existing CD service can reconcile them without a separate overlay command.

## Start

Set Grafana credentials in your shell or `.env` before starting the stack:

```bash
export GRAFANA_ADMIN_USER=admin
export GRAFANA_ADMIN_PASSWORD='change-me'
```

The 8 GB self-host profile applies conservative memory caps by default:

```text
Prometheus: 512 MiB
Grafana:    256 MiB
cAdvisor:   256 MiB
```

Override them only after measuring the host:

```bash
export PROMETHEUS_MEMORY_LIMIT=768m
export GRAFANA_MEMORY_LIMIT=384m
export CADVISOR_MEMORY_LIMIT=256m
```

Prometheus and Grafana are now defined directly in the root Compose file, so a
normal deployment starts them automatically. To start only the monitoring
components manually:

```bash
docker compose up -d monitoring-service prometheus grafana
```

## Verify

Run the end-to-end smoke check from the repository root:

```bash
bash scripts/ops/check-monitoring-stack.sh
```

It verifies:

1. Prometheus readiness.
2. `up{job="monitoring-service"} == 1`.
3. `up{job="cadvisor"} == 1` and labeled container samples.
4. Grafana database health.

For exporter-level inspection, the application endpoint remains internal to the
Docker network:

```bash
docker compose exec monitoring-service \
  node -e "require('http').get('http://127.0.0.1:3016/metrics',r=>{r.pipe(process.stdout);r.on('end',()=>process.exit(r.statusCode===200?0:1))}).on('error',()=>process.exit(1))"
```

Prometheus is bound to localhost only:

```text
http://127.0.0.1:9090
```

Open **Status -> Targets** and confirm `monitoring-service` and `cadvisor` are
`UP`. cAdvisor is available only inside the Docker network at
`http://cadvisor:8080/metrics`.
Useful first queries:

```promql
up{job="monitoring-service"}
velora_process_resident_memory_bytes{service="monitoring-service"}
sum(rate(velora_monitoring_rpc_requests_total[5m]))
histogram_quantile(0.95, sum by (le) (rate(velora_monitoring_rpc_duration_seconds_bucket[5m])))
sum by (service, container) (rate(container_cpu_usage_seconds_total{job="cadvisor",service!="",container!=""}[5m]))
sum by (service, container) (container_memory_working_set_bytes{job="cadvisor",service!="",container!=""})
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
GET /api/monitoring/status
GET /api/monitoring/containers
GET /api/monitoring/timeseries
```

The timeseries endpoint accepts only the server-side metric whitelist and a bounded
range; clients cannot submit arbitrary PromQL.

## Retention and scrape interval

The local profile uses a 15-second scrape interval and three-day Prometheus
retention. This keeps the footprint small for development and the thesis test
server. Increase retention only after measuring actual TSDB disk/RAM usage.

## Security

Do not expose ports 9090 or 3001 directly to the public internet. The root
Compose file binds both ports to `127.0.0.1`. Keep `GRAFANA_ADMIN_PASSWORD` set
in the server `.env`; the CI workflow supplies only a non-secret placeholder for
configuration validation. The Velora admin frontend should read selected metrics
through API Gateway -> monitoring-service instead of sending arbitrary PromQL to
Prometheus.
