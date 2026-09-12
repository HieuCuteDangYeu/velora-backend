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
```

Override them only after measuring the host:

```bash
export PROMETHEUS_MEMORY_LIMIT=768m
export GRAFANA_MEMORY_LIMIT=384m
```

`monitoring-service` reads live container stats from the Docker Engine API over
the read-only `/var/run/docker.sock` mount. Set `DOCKER_ENGINE_GID` to the
socket's group id when the host does not use group `0`. CPU and memory values
are sampled on demand for the admin container snapshot; writable-layer size is
reported from the Docker container summary. Container rows are live snapshots;
Prometheus continues to retain host and service history, not per-container
time series.

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
3. Docker Engine API access from `monitoring-service` and a live container
   stats response when a container is running.
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

Open **Status -> Targets** and confirm `monitoring-service` is `UP`. Container
resources are read through the Docker Engine API by the protected admin
endpoint; Prometheus remains the source for host and service history.
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
Velora frontend -> /api/monitoring/* -> API Gateway -> monitoring-service
  ├─ Prometheus (host/service history)
  └─ Docker Engine API (live container snapshot)
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
Prometheus. Treat access to the Docker socket as privileged: keep it mounted
only in `monitoring-service` and do not expose the socket or container snapshot
endpoint publicly.
