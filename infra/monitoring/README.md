# Velora monitoring stack

This directory contains the Prometheus, Loki, Alloy and Grafana configuration. Prometheus,
Loki, Alloy and `monitoring-service` are part of the default homelab Compose topology so the
existing CD service can reconcile them without a separate overlay command.

**Grafana no longer runs on the homelab.** Since 2026-11-13 it runs on velora-node-2 (France),
reading the homelab Prometheus and Loki over Tailscale, to free about 240 MiB of RAM. See
`../grafana-node/README.md`. The dashboards and provisioning in `grafana/` are still the
source: after editing them, copy them to `/opt/velora/grafana/` on the VPS by hand (the
homelab CD no longer touches them) and restart the container there.

## Start

The 8 GB self-host profile applies a conservative memory cap by default:

```text
Prometheus: 512 MiB
```

Override it only after measuring the host:

```bash
export PROMETHEUS_MEMORY_LIMIT=768m
```

The `GRAFANA_*` and `GF_*` variables in `.env` are no longer read by the homelab stack. They
are left in place on purpose: editing `.env` pauses automatic releases.

`monitoring-service` reads live container stats from the Docker Engine API over
the read-only `/var/run/docker.sock` mount. Set `DOCKER_ENGINE_GID` to the
socket's group id when the host does not use group `0`. CPU and memory values
are sampled on demand for the admin container snapshot; writable-layer size is
reported from the Docker container summary. Container rows are live snapshots;
Prometheus continues to retain host and service history, not per-container
time series.

Prometheus is defined directly in the root Compose file, so a normal deployment starts it
automatically. To start only the monitoring components manually:

```bash
docker compose up -d monitoring-service prometheus loki alloy
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
sum(rate(velora_monitoring_rpc_requests_total[1m]))
histogram_quantile(0.95, sum by (le) (rate(velora_monitoring_rpc_duration_seconds_bucket[1m])))
```

Grafana runs on velora-node-2 and listens on its Tailscale address only. From a machine that is
not on the tailnet, reach it through an SSH tunnel:

```bash
ssh -N -L 3001:100.86.68.16:3001 root@144.91.101.1
# then open http://localhost:3001
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
GET /api/monitoring/hosts
GET /api/monitoring/hosts/history?metric=host_cpu&from=&to=&stepSeconds=
GET /api/monitoring/containers?host=
GET /api/monitoring/timeseries?host=
GET /api/monitoring/alerts
GET /api/monitoring/logs?host=
```

`host` is optional everywhere; without it the endpoints describe the primary machine,
exactly as before.

The timeseries endpoint accepts only the server-side metric whitelist and a bounded
range; clients cannot submit arbitrary PromQL.

CPU values returned by the overview and timeseries endpoints are ratios of the
monitored host's total CPU capacity across all cores. This matches the CPU
percentage used by the Server view and its Docker container breakdown. The
underlying process counters remain available in Prometheus as cumulative
CPU-seconds, but the dashboard API normalizes them before returning them.

## Monitoring more than one VPS

The dashboard monitors every machine that has a node-exporter target in
`infra/monitoring/prometheus/prometheus.yml`. There is no separate host list: the
labels on the target are the registry.

| Label | Meaning |
| --- | --- |
| `host` | Required. Stable URL-safe id (letters, digits, `_`, `.`, `-`). Used in every query, in the dashboard URL and in alerts. |
| `host_name` | Display name. |
| `host_role` | `primary` for the machine that runs this Compose stack, `worker` for any other VPS. Exactly one `primary`. |
| `host_region`, `host_provider` | Optional, shown on the host card. |
| `docker_port` | Optional. Port of the read-only Docker socket proxy on that VPS; turns on its per-container CPU/RAM/disk breakdown. |
| `host_network` | Optional. `unavailable` when the exporter runs in a bridged container (as the Compose `node-exporter` does): its `node_network_*` then describes the container's own NIC, so the dashboard shows no network figures for that host. The agent in `infra/vps-agent/` uses host networking and needs no label. |

To add a VPS:

1. Start the agent stack from `infra/vps-agent/` on it (node-exporter, the Docker socket
   proxy and optionally the log shipper), all on its Tailscale address.
2. Add one `static_configs` block to the `node-exporter` job with the labels above.
3. Push. The deploy script recreates Prometheus; `monitoring-service` and the dashboard
   pick the host up within ten seconds, with no code change.

How the data flows:

```text
Dashboard -> /api/monitoring/hosts -> monitoring-service
  ├─ Prometheus: 12 queries grouped by host, whatever the number of VPSs
  └─ cached for one scrape interval and shared by every open dashboard
Dashboard -> /api/monitoring/containers?host=X -> monitoring-service
  ├─ primary host: the local Docker socket
  └─ worker host: its Docker socket proxy over Tailscale
```

Notes:

- Service CPU ratios (`conversation_cpu`, `call_cpu`, ...) are fractions of the **primary**
  machine's cores, because the services run there. Adding a worker does not change them as
  long as the worker carries `host_role: worker`.
- Host alerts (`VeloraHostDown`, `VeloraHostHighCpu`, `VeloraHostHighMemory`,
  `VeloraHostDiskAlmostFull`) are evaluated per host and carry the `host` label, which the
  Alerts page shows.
- A Prometheus config that has no `host` label yet keeps working: the series show up as one
  primary host named `local`. For five minutes after Prometheus restarts with new labels, the
  old unlabelled series are still visible; they are dropped when the same scrape address
  also has a labelled series, so no ghost host appears.
- Per-host history is queried straight from Prometheus (`host_cpu`, `host_memory`,
  `host_swap`, `host_disk`, `host_load1`, `host_network_receive`, `host_network_transmit`).
- Logs: the homelab Alloy tags its lines with `host="homelab"`; Alloy on a VPS tags its own.
  Lines without a `host` label count as the primary machine.

## Retention and scrape interval

The default uses a 5-second scrape and rule evaluation interval, a 3-second
scrape timeout, and three-day Prometheus retention. Live overview and timeseries
CPU, rate, error ratio, and histogram quantile queries use rolling one-minute
windows. Successful overviews are shared for up to five seconds per monitoring
instance, and concurrent callers share the same query batch; failed requests
are retried on the next call. The lightweight status endpoint queries only the
two exporter health signals and does not trigger an overview.

Timeseries defaults to 10-second points and accepts a 15-minute history; the
existing 24-hour range cap and 300-second maximum step remain. The CPU alert
fires when the one-minute mean is above 70 percent continuously for 60 seconds.
All other alert holds and their existing five/fifteen-minute event or pipeline
windows remain unchanged, including recent Reel failure counts.

Five-second scraping produces three times as many samples as the previous
15-second interval. Measure TSDB disk/RAM usage before increasing retention.

## Applying configuration changes

The deployment scripts select Prometheus for changes under
`infra/monitoring/prometheus/` and force-recreate it to refresh its read-only
configuration mounts. A Git push or file update alone does not reload a running
Prometheus process. For a deployment that bypasses these scripts, after updating
the checkout run from the deployment directory:

```bash
docker compose up -d --force-recreate --no-deps prometheus
```

Then verify `/api/v1/status/config` reports `scrape_interval: 5s`,
`scrape_timeout: 3s`, and `evaluation_interval: 5s`, and inspect the targets.
The Compose command does not enable the HTTP lifecycle reload endpoint.

## Security

The Docker socket proxy on a worker VPS cannot authenticate callers and
`GET /containers/<id>/json` includes a container's environment variables. Publish it on the
Tailscale address only (the agent compose file does) and restrict who may reach port 2375
with a Tailscale ACL.

Do not expose ports 9090, 3100 or 3001 directly to the public internet. The root
Compose file binds 9090 and 3100 to `127.0.0.1`; they are published on the tailnet only through
`tailscale serve` for Grafana on the VPS, and neither authenticates callers, so limit them with a
Tailscale ACL. Keep `GRAFANA_ADMIN_PASSWORD` set in `/opt/velora/grafana/.env` on the VPS. The Velora admin frontend should read selected metrics
through API Gateway -> monitoring-service instead of sending arbitrary PromQL to
Prometheus. Treat access to the Docker socket as privileged: keep it mounted
only in `monitoring-service` and do not expose the socket or container snapshot
endpoint publicly.

## Model server (laptop) health

The ai-service reaches its model through a reverse SSH tunnel to the developer laptop. `scripts/deploy/model-host-probe`
(LaunchAgent `com.velora.model-host-probe`, every 30 s) writes `velora-model-host.prom` into the node-exporter text-file
directory: `velora_model_host_up`, `velora_model_host_probe_duration_seconds`, `velora_model_host_model_resident` and
`velora_model_host_probe_timestamp_seconds`. The `velora-model-host` rule group alerts on an unreachable server (critical,
two minutes), a stopped probe, a model that is not loaded, and slow answers. See `docs/model-host.md`.
