# VPS agent: what an additional VPS runs to be monitored

Every VPS that should appear in the Velora dashboard runs the stack in `compose.yaml`:

| Container | Port (Tailscale address only) | Purpose |
| --- | --- | --- |
| `node-exporter` | `9100` | Host CPU, memory, disk, load and network. Scraped by the homelab Prometheus. |
| `docker-proxy` | `2375` | Read-only Docker Engine API for the per-container breakdown. |
| `alloy` (profile `logs`) | none | Pushes the VPS's container logs to the homelab Loki. |

This folder is for hosts managed by hand over SSH. The homelab deploy script ignores it.
How the dashboard uses the data is described in `infra/monitoring/README.md`
("Monitoring more than one VPS").

## Set up a VPS

Example for `velora-node-2` (Tailscale `100.86.68.16`). Check that ports 9100 and 2375 are free
first (`ss -ltn`); `velora-node-2` already runs the Mongo and Postgres replicas and
`call-media-2` on other ports.

Copy the files:

```sh
ssh root@100.86.68.16 'mkdir -p /opt/velora/vps-agent'
scp infra/vps-agent/compose.yaml infra/vps-agent/alloy.config root@100.86.68.16:/opt/velora/vps-agent/
```

Create `/opt/velora/vps-agent/.env` on the VPS (mode 600) with:

```text
TAILNET_IP=100.86.68.16
HOST_ID=velora-node-2
LOKI_PUSH_URL=http://100.102.228.48:3100/loki/api/v1/push
```

`HOST_ID` and `LOKI_PUSH_URL` are only read by the optional log shipper. Then start it:

```sh
cd /opt/velora/vps-agent && docker compose up -d
```

Check from the homelab (or any tailnet device):

```sh
curl -s http://100.86.68.16:9100/metrics | head -3
curl -s http://100.86.68.16:2375/containers/json | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://100.86.68.16:2375/containers/create
```

The last command must print `403`: the proxy denies everything that is not a read.

### Optional: logs

Loki listens on `127.0.0.1:3100` on the homelab, so expose it to the tailnet once (needs sudo
there), then start the `logs` profile on the VPS:

```sh
sudo tailscale serve --bg --tcp 3100 tcp://localhost:3100
cd /opt/velora/vps-agent && docker compose --profile logs up -d
```

The first command runs on the homelab, the second on the VPS. Services that run on a VPS need
to be in the log service list of `monitoring-service` (`STANDARD_LOG_SERVICES` in
`system-logs.controller.ts`) before the Logs page offers them.

## Register it in Prometheus

Add (or uncomment) the target in `infra/monitoring/prometheus/prometheus.yml`, in the
`node-exporter` job:

```yaml
      - targets:
          - 100.86.68.16:9100
        labels:
          host: velora-node-2
          host_name: Velora node 2
          host_role: worker
          host_region: France
          host_provider: Contabo
          docker_port: '2375'
```

Push it. The deploy script recreates Prometheus. Then `GET /api/monitoring/hosts` lists the
host and the dashboard's Servers page shows it. Do this only after the agent is running,
otherwise `VeloraHostDown` fires for the missing exporter.

## Security

- Both ports are published on the Tailscale address, never on the public interface. Keep it
  that way: neither service authenticates callers.
- The Docker proxy allows `GET` on `/containers`, `/info` and `/system` only, but
  `GET /containers/<id>/json` returns a container's environment variables. Anyone who can
  reach port 2375 can read them, so limit the port with a Tailscale ACL to the homelab.
- `node-exporter` mounts `/` read-only to read filesystem usage.

## Remove a VPS

Delete its block from `prometheus.yml` and push. Its history stays in Prometheus until the
three-day retention expires; stop the stack with `docker compose down` on the VPS.
