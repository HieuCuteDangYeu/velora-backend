# mail-service on velora-node-2

Since 2026-11-13 `mail-service` runs on `velora-node-2` (France, `144.91.101.1`, tailnet
`100.86.68.16`) instead of the homelab. It does not need the lowest latency: it is a RabbitMQ RPC
consumer (`mail_queue`) with no HTTP port, so the move only adds the homelab to node-2 round trip
(about 220 ms) to each mail request.

**friend-service is back on the homelab (2026-11-17).** It answers the audience and access lookups
behind the reel feeds, tag pages and context windows. A probe over RabbitMQ with no database work
took 240-570 ms to reach it on node-2, and its database round trips were slower than the homelab's.
It is a normal Compose service again (`FRIEND_DATABASE_CONNECTION_LIMIT`, default 6) and the deploy
controller checks `friend_queue` again. The folder name stays for history.

`mail-service` is not in the homelab compose file and the homelab deploy script ignores this folder
(`infra/friend-mail-node/*`). The deploy script does not check `mail_queue` consumers either, so a
node-2 outage cannot fail or roll back a homelab release.

| Item | Value |
| --- | --- |
| Stack | `/opt/velora/friend-mail/`: `compose.yaml` (this folder), `.env`, `release.env`, `.deploy.lock` |
| Image | `<dockerhub user>/mail-service:<sha>-amd64`, built by the Homelab CD |
| Container | `mail-service` (the name matches the Compose service name Loki labels use) |
| Broker | homelab RabbitMQ, reached as `rabbitmq` through `extra_hosts` to `100.102.228.48` (tailnet) |
| Mail provider | Resend over HTTPS |

## Media workers do not run here (tried 2026-11-15, removed)

`media-processing-service` ran on this node for a day, first as an extra SHORT and LONG consumer,
then LONG only. It was removed again because the host is too slow for transcoding. Measured with
the production HLS command (360p/540p/720p, x264 `faster`, 4 s segments) on a 178 s 1080x1920
Narto Drama episode:

| Host | 1 job | 2 jobs in parallel |
| --- | --- | --- |
| Homelab (M1, 8 CPUs in the Docker VM) | 85 s (2.1x realtime) | 148 s each |
| Developer laptop (i7-12650H, 16 threads) | 85 s | 119 s each |
| This node, under a 2 CPU cap | 610 s (0.29x) | not run |

Real SHORT jobs took 246 s here against 137 s on the homelab. A vCPU here is about a third of an
M1 core and the 2 CPU cap throttled the six x264 threads; the neighbours are not the cause
(Langfuse's ClickHouse is already capped at 1.5 CPUs and used 76% of one core). The worker kills
a transcode after 3x the video length plus 5 minutes and RabbitMQ stops waiting for an
acknowledgement after 30 minutes, so at 0.29x anything over about 10 minutes of video fails.
A synthetic single-process ffmpeg run had looked comparable (9.6 s vs 8 s); do not size this
host from that. The amd64 image is still built by the CD (it is what a laptop worker runs).

## Release pipeline

`.github/workflows/cd.yml` (Homelab CD, after Homelab CI passes on `master`):

1. `build-and-push-node2-images` builds `mail-service` and (for other amd64 hosts, not this node) `media-processing-service` for
   `linux/amd64` (node-2 is x86_64, the homelab images are arm64) and pushes
   `<user>/<service>:<commit sha>-amd64` to Docker Hub.
2. `deploy-node2` connects as `velora-deploy@144.91.101.1` with a key that is only allowed
   to run `/usr/local/sbin/velora-friend-mail-deploy` (a copy of `deploy.sh`) and sends
   `deploy <sha>`.

`deploy.sh` then, for each image (the node runs mail only): pulls the image, **skips it if the running container
already has the same image id**, otherwise records the new tag in `release.env`, recreates
only that container, and waits until it is running, has not restarted and logged
`Nest microservice successfully started`. If that does not happen within 90 s it puts the
previous tag back, recreates the container again, and exits non-zero (the `deploy-node2`
job goes red; the homelab release is unaffected). Images other than the new and the
previous tag are removed afterwards. Runs are serialised with `flock`.

The two jobs are independent of `promote-homelab`: neither can hold back the other.

### One-time setup (done 2026-11-13)

- User `velora-deploy` (system user, member of `docker`), with
  `restrict,command="/usr/local/sbin/velora-friend-mail-deploy"` in front of its key in
  `~/.ssh/authorized_keys`. The forced command accepts only `deploy <40 hex>` and `status`;
  it never reads an image name, path or shell command from the caller.
- GitHub secrets `NODE2_DEPLOY_SSH_KEY` (private key) and `NODE2_KNOWN_HOSTS` (the node's
  ed25519 host key, read from the node itself). Rotate by generating a new key, replacing
  the `authorized_keys` line and the secret.
- `/opt/velora/friend-mail` is group-writable by `velora-deploy`; `.env` is `640 root:velora-deploy`.
- `release.env` holds `DOCKERHUB_USERNAME` and `MAIL_SERVICE_TAG`.
  The first containers ran a locally built image that was tagged `boot`.

### Changing the script or the compose file

Neither is shipped by the pipeline on purpose: the CD key can only choose an image tag of
this repository's own images, nothing else. Copy them by hand with root when they change:

```sh
scp infra/friend-mail-node/compose.yaml root@144.91.101.1:/opt/velora/friend-mail/compose.yaml
scp infra/friend-mail-node/deploy.sh root@144.91.101.1:/tmp/deploy.sh
ssh root@144.91.101.1 'install -m 755 /tmp/deploy.sh /usr/local/sbin/velora-friend-mail-deploy && rm /tmp/deploy.sh'
```

`scripts/deploy/test-friend-mail-node-deploy.sh` tests the script against a fake `docker`
(input validation, changed image, unchanged image, rollback).

## `.env` (mode 640 root:velora-deploy, not in the repo)

```text
RABBITMQ_URL=...            # same value the homelab uses (host name rabbitmq)
RESEND_API_KEY=...          # mail-service
RESEND_FROM_EMAIL=...       # mail-service
```

Nothing else from the homelab `.env` is needed. Change a value here and on the homelab together.

## Operate

```sh
ssh root@144.91.101.1
cd /opt/velora/friend-mail
docker compose --env-file release.env ps
docker compose --env-file release.env logs --tail=100 mail-service
docker compose --env-file release.env stop      # consumers leave; requests wait in RabbitMQ
```

Roll back by hand: edit the tag in `release.env`, then
`docker compose --env-file release.env up -d`. While the stack is stopped, queued mail waits in
`mail_queue` until a consumer returns.
Logs reach the Velora Logs page through the node's Alloy shipper (`infra/vps-agent`).

## Moving friend-service back to the homelab (2026-11-17), one-time steps on this node

The node still ran the old friend container, a competing consumer on `friend_queue`, until
this was done by hand as root (the CD key cannot do it):

```sh
cd /opt/velora/friend-mail
docker compose --env-file release.env stop friend-service      # the homelab one now serves it
scp infra/friend-mail-node/compose.yaml root@144.91.101.1:/opt/velora/friend-mail/compose.yaml   # from the repo
scp infra/friend-mail-node/deploy.sh root@144.91.101.1:/tmp/deploy.sh
ssh root@144.91.101.1 'install -m 755 /tmp/deploy.sh /usr/local/sbin/velora-friend-mail-deploy && rm /tmp/deploy.sh'
docker compose --env-file release.env up -d --remove-orphans   # removes the stopped friend container
```

The friend lines in `.env` and `release.env` are unused afterwards and can stay or go.
Rollback: `docker compose` a friend service back into this folder's compose file and restore the
homelab one's removal (git history: ea7a43d3 moved it here).
