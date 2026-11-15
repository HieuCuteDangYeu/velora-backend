# Langfuse on velora-node-2

Since 2026-11-13 the self-hosted Langfuse (v4.75.0, events-only) that backs the RAG
observability and benchmark tooling runs on `velora-node-2` instead of a developer laptop.
Before, the homelab `ai-service` reached it through a reverse SSH tunnel from the laptop,
so tracing was silently dropped whenever the laptop was off.

| Item | Value |
| --- | --- |
| Stack | `/opt/velora/langfuse/`: the three compose files in this folder, plus `.env` (mode 600, not in the repo) |
| Compose project | `velora-langfuse` (the Logs page selectors in `monitoring-service` expect this name) |
| UI | `https://langfuse.velora-app.me` (Cloudflare tunnel from the homelab, behind a Cloudflare Access policy; sign-up is disabled) |
| API for services | `http://100.86.68.16:13000` (Tailscale address only; used by the homelab `ai-service`) |
| MinIO (media and exports) | `http://100.86.68.16:19090` (Tailscale address only) |
| Databases | ClickHouse, Postgres, Redis stay on the private Compose network, nothing published |
| Memory | about 1.3 GB in use; limits in `limits.yaml` add up to 6 GB at most |
| Homelab consumer | `ai-service`, `LANGFUSE_BASE_URL="http://100.86.68.16:13000"` in the homelab `.env` |

Files: `docker-compose.yml` is upstream Langfuse with the image tags pinned (its defaults are
upstream placeholders), `limits.yaml` sets memory/CPU limits and log rotation, `node2.yaml`
binds the published ports to the Tailscale address. The homelab deploy script ignores this folder.

`.env` is the previous local `langfuse.env` with `COMPOSE_PROJECT_NAME`,
`NEXTAUTH_URL` (the public address), `LANGFUSE_BASE_URL` and the two MinIO endpoints changed, plus
`TAILNET_IP` and `COMPOSE_FILE=docker-compose.yml:limits.yaml:node2.yaml`. `SALT`,
`ENCRYPTION_KEY` and `NEXTAUTH_SECRET` must stay the same as they were: changing them breaks
the existing API keys and stored credentials.

## Operate

```sh
ssh root@144.91.101.1
cd /opt/velora/langfuse
docker compose ps
docker compose logs --tail=100 langfuse-web langfuse-worker
docker compose pull && docker compose up -d     # after changing the image tags in docker-compose.yml
```

## Using it

- **Dashboard (UI):** open `https://langfuse.velora-app.me`. Cloudflare Access asks for your
  email first, then Langfuse has its own login. `NEXTAUTH_URL` is that address, so the UI does
  not work through the tailnet IP or a port forward (the sign-in form posts to the public URL).
  Users are added in Settings > Members; sign-up is disabled (`AUTH_DISABLE_SIGNUP` in `node2.yaml`).
- **Tunnel route:** the Cloudflare tunnel on the homelab publishes `langfuse.velora-app.me`
  to `http://100.86.68.16:13000`, so it depends on the homelab reaching node-2 over Tailscale.
- **Scripts and services:** use the API with the project keys on the tailnet address
  (`LANGFUSE_BASE_URL=http://100.86.68.16:13000`, as the homelab does). The public hostname is
  behind Access, so scripts would need a service token. From a laptop without Tailscale,
  `ssh -N -L 127.0.0.1:13000:100.86.68.16:13000 root@144.91.101.1` gives API access on
  `http://localhost:13000` (not the UI). Bulk ingestion (experiment replay with `flushAt: 200`)
  crosses the roughly 220 ms link to France, so it is slower than against a local container.
- MinIO (media uploads and batch exports) is only on the tailnet, so those two UI features do
  not work through the public hostname.

## Migration notes (2026-11-13)

The volumes (`postgres`, `redis`, `minio`, `clickhouse` data; not the ClickHouse logs) were
copied from the stopped laptop stack with `tar | gzip | ssh` in about 8 minutes. The laptop
volumes (`velora-rag-langfuse-local_langfuse_*`) were left in place as a rollback copy and
the containers set to `restart=no`; remove them once the node-2 data has been trusted.
To roll back, start them again and restore `LANGFUSE_BASE_URL=http://host.docker.internal:13000`
on the homelab (with the laptop's reverse tunnel running).

Not covered yet: nightly backups (`infra/backup-worker` does not include Langfuse).
