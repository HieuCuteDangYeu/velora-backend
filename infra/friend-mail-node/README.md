# friend-service, mail-service and media workers on velora-node-2

Since 2026-11-13 these two services run on `velora-node-2` (France, `144.91.101.1`,
tailnet `100.86.68.16`) instead of the homelab. Neither needs the lowest latency: both are
RabbitMQ RPC consumers (`friend_queue`, `mail_queue`) with no HTTP port, so moving them
only adds the homelab to node-2 round trip (about 220 ms) to each friend or mail request.

They are not in the homelab compose file and the homelab deploy script ignores this folder
(`infra/friend-mail-node/*`). The deploy script no longer checks `friend_queue` or
`mail_queue` consumers either, so a node-2 outage cannot fail or roll back a homelab release.

| Item | Value |
| --- | --- |
| Stack | `/opt/velora/friend-mail/`: `compose.yaml` (this folder), `.env`, `release.env`, `.deploy.lock` |
| Images | `<dockerhub user>/friend-service:<sha>-amd64` and `.../mail-service:<sha>-amd64`, built by the Homelab CD |
| Containers | `friend-service`, `mail-service` (names match the Compose service names Loki labels use) |
| Broker | homelab RabbitMQ, reached as `rabbitmq` through `extra_hosts` to `100.102.228.48` (tailnet) |
| Database | Aiven `friend-service` database; mail has none |
| Mail provider | Resend over HTTPS |

## Reel media workers (added 2026-11-15)

The same stack also runs two copies of `media-processing-service`, one per lane
(`media-processing-service` = `SHORT`, `media-processing-long-service` = `LONG`), built from
the same Dockerfile for `linux/amd64`. They consume `reel_media_short_jobs`, `processing_queue`
and `reel_media_long_jobs` on the homelab RabbitMQ as **competing consumers** next to the
homelab workers: RabbitMQ hands each job to whichever worker is free (prefetch 1), so no
queue, routing key or message format changes. A worker needs only RabbitMQ and Cloudflare R2;
it keeps its ffmpeg workspace in the container's `/tmp`.

- `media.env` (mode 640 `root:velora-deploy`, not in the repo) holds only `RABBITMQ_URL`,
  the `R2_*` keys, `FFMPEG_PATH` and the `MEDIA_*` HLS tuning keys, copied from the homelab
  `.env`. Keep the `MEDIA_*` values equal on both hosts or HLS output depends on which
  host took the job. friend and mail do not get the R2 keys.
- `TIKTOK_CDN_ENABLED=false` is set in the compose file. Jobs handled here upload to R2
  (the same fallback the homelab uses when the TikTok CDN upload fails); the TikTok session
  cookie stays tied to the homelab address.
- Each container is capped at 2 CPUs and 2 GB with a low CPU weight (`cpu_shares: 256`), so
  the Mongo and Postgres replicas and `call-media-2` on this host win when a transcode runs.
- A job that is running when a container is recreated is not acknowledged and RabbitMQ
  redelivers it, the same as on the homelab.
- The homelab no longer runs `media-processing-long-service` (removed from `docker-compose.yml`,
  listed in `REMOVED_COMPOSE_SERVICES`): **the LONG lane exists only here**, so long jobs wait in
  `reel_media_long_jobs` while this node is down. The homelab keeps `media-processing-service`
  (SHORT), so short jobs have two consumers. To bring the LONG lane back on the homelab,
  revert that compose removal.
- Monitoring needs nothing new: the `reel_media_*` queue alerts count consumers on the
  broker, so they cover both hosts.

## Release pipeline

`.github/workflows/cd.yml` (Homelab CD, after Homelab CI passes on `master`):

1. `build-and-push-node2-images` builds `friend-service`, `mail-service` and `media-processing-service` for
   `linux/amd64` (node-2 is x86_64, the homelab images are arm64) and pushes
   `<user>/<service>:<commit sha>-amd64` to Docker Hub.
2. `deploy-node2` connects as `velora-deploy@144.91.101.1` with a key that is only allowed
   to run `/usr/local/sbin/velora-friend-mail-deploy` (a copy of `deploy.sh`) and sends
   `deploy <sha>`.

`deploy.sh` then, for each image (the media image has two containers, which it treats as one unit): pulls the image, **skips it if the running container
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
- `release.env` holds `DOCKERHUB_USERNAME`, `FRIEND_SERVICE_TAG`, `MAIL_SERVICE_TAG` and `MEDIA_PROCESSING_SERVICE_TAG`.
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
FRIEND_DATABASE_URL=...     # friend-service
RESEND_API_KEY=...          # mail-service
RESEND_FROM_EMAIL=...       # mail-service
DEFAULT_ADMIN_ID=...        # friend-service: system user UUIDs required by libs/common
BOT_USER_ID=...             # seed constants (same values as the homelab; not secrets)
```

Nothing else from the homelab `.env` is needed (friend-service refuses to start without the
two UUIDs). Change a value here and on the homelab together.

## Operate

```sh
ssh root@144.91.101.1
cd /opt/velora/friend-mail
docker compose --env-file release.env ps
docker compose --env-file release.env logs --tail=100 friend-service mail-service media-processing-service media-processing-long-service
docker compose --env-file release.env stop      # consumers leave; requests wait in RabbitMQ
```

Roll back by hand: edit the tag in `release.env`, then
`docker compose --env-file release.env up -d`. While the stack is stopped, friend requests
from the gateway time out and queued mail waits in `mail_queue` until a consumer returns.
Logs reach the Velora Logs page through the node's Alloy shipper (`infra/vps-agent`).
