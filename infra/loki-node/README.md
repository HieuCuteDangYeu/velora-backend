# Loki on velora-node-2

Phase 2 of moving the monitoring stack off the homelab (phase 1 moved Grafana, see
`../grafana-node/README.md`). Loki stores the container logs of both servers for 72 hours.
Alloy on each server pushes into it; the Velora dashboard's Logs page and Grafana read from it.

| Item | Value |
| --- | --- |
| Where | `/opt/velora/loki/` on velora-node-2 (France), managed by hand over SSH |
| Image | `grafana/loki:3.7.8`, the version the homelab ran |
| Listens on | the Tailscale address only, `100.86.68.16:3100`, no authentication |
| Config | `loki-config.yml` here (moved from `infra/monitoring/loki/`), 72 h retention |
| Pushed by | Alloy on the homelab (`infra/monitoring/alloy/config.alloy`) and Alloy on this VPS (`infra/vps-agent`, profile `logs`) |
| Read by | `monitoring-service` (`LOKI_URL` in `docker-compose.yml`) and Grafana (`../grafana-node`) |

## Why this helps, and what it costs

- The homelab gets about 150 MiB of RAM back (Loki's usage was 153 MiB).
- If the homelab goes down, the logs it pushed up to that moment are still here.
- Logs from the homelab now cross a 217 ms link. If the link is down, Alloy retries for a while
  and then drops the lines, so a long outage leaves a gap in the logs.
- The Logs page queries over the link, so it is slower than before.
- Metrics stay on the homelab Prometheus; an outage still loses metrics.

## Install

```sh
ssh root@144.91.101.1 'mkdir -p /opt/velora/loki'
scp infra/loki-node/compose.yaml infra/loki-node/loki-config.yml root@144.91.101.1:/opt/velora/loki/
ssh root@144.91.101.1 'cd /opt/velora/loki && echo TAILNET_IP=100.86.68.16 > .env && docker compose up -d'
```

Check it from the homelab: `curl http://100.86.68.16:3100/ready` must answer `ready`.

Limit port 3100 to the homelab and this VPS with a Tailscale ACL: Loki does not authenticate callers.

Start this VPS's own Alloy so its logs land here too:

```sh
cd /opt/velora/vps-agent
# .env: LOKI_PUSH_URL=http://100.86.68.16:3100/loki/api/v1/push
docker compose --profile logs up -d
```

## History is not moved

The 72-hour history on the homelab is not copied. After the switch, older lines are only on the
homelab volume until that container is removed.

## Roll back

Re-add the `loki` service and `loki_data` volume to the root `docker-compose.yml` (in git
history), point Alloy and `monitoring-service` back at `http://loki:3100`, and
`docker compose down` here.
