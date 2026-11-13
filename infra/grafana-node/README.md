# Grafana on velora-node-2

Phase 1 of moving the monitoring stack off the homelab, which is short of RAM. Grafana only
serves people looking at dashboards, so a slower link does not hurt it, and it frees about
240 MiB on the homelab. Prometheus stays on the homelab: it scrapes the Compose-internal
service names (`conversation-service:3005` and so on), which are not reachable from the VPS.

| Item | Value |
| --- | --- |
| Where | `/opt/velora/grafana/` on velora-node-2 (France), managed by hand over SSH |
| Image | `grafana/grafana:13.2.2`, the version the homelab ran |
| Listens on | the Tailscale address only, port 3001 |
| Reads | homelab Prometheus `100.102.228.48:9090`, Loki on this VPS `100.86.68.16:3100` (since phase 2) |
| Dashboards | `infra/monitoring/grafana/dashboards`, copied at install time |

## Why this helps, and what it does not do

- The homelab gets about 240 MiB back (Grafana's usage was 238 MiB).
- Every panel now crosses a 217 ms link, so dashboards open more slowly than before.
- If the homelab goes down, Grafana stays up and still shows logs (Loki moved here in phase 2,
  see `../loki-node/README.md`) but has no metrics: Prometheus is still on the homelab.
- The dashboard's own Grafana-free pages (Servers, Calls, Logs) are not affected: the
  monitoring-service reads Prometheus and Loki directly.

## Install

1. On the **homelab**, publish Prometheus on the tailnet (Loki is no longer on the homelab) (needs `sudo`; the services
   still only listen on `127.0.0.1`, `tailscale serve` forwards the tailnet address to them):

   ```sh
   sudo tailscale serve --bg --tcp 9090 tcp://localhost:9090
   ```

   Prometheus does not authenticate callers. Limit the port to the VPS with a Tailscale ACL.

2. Copy the files to the VPS:

   ```sh
   ssh root@144.91.101.1 'mkdir -p /opt/velora/grafana/provisioning'
   scp infra/grafana-node/compose.yaml root@144.91.101.1:/opt/velora/grafana/
   scp -r infra/grafana-node/provisioning/datasources root@144.91.101.1:/opt/velora/grafana/provisioning/
   scp -r infra/monitoring/grafana/provisioning/dashboards root@144.91.101.1:/opt/velora/grafana/provisioning/
   scp -r infra/monitoring/grafana/dashboards root@144.91.101.1:/opt/velora/grafana/
   ```

3. On the VPS create `/opt/velora/grafana/.env` (mode 600) with `TAILNET_IP=100.86.68.16` and
   `GRAFANA_ADMIN_PASSWORD=<choose one>`, then `docker compose up -d`.

4. Open `http://100.86.68.16:3001` from a machine on the tailnet.

## Check

- Both datasources show green under Connections, and the Velora dashboard has data for both
  servers.
- The homelab Grafana can then be removed from `docker-compose.yml` (done in the same change
  that adds this folder once the VPS copy is confirmed).

## Roll back

Re-add the `grafana` service to the root `docker-compose.yml` (it is in git history) and
`docker compose down` here. Nothing else depends on Grafana.
