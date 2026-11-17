# Media workers on the developer laptop (LONG and SHORT lanes)

Since 2026-11-16 the developer laptop can run extra `media-processing-service` consumers for
`reel_media_long_jobs` (unit `velora-media-long-worker`) and `reel_media_short_jobs` (unit
`velora-media-short-worker`). It competes with the homelab worker on the same queue (RabbitMQ gives each
job to whichever consumer is free, prefetch 1), so no routing or code changes are involved, and
the homelab keeps its own LONG and SHORT workers. When the laptop sleeps or goes off, its
connection drops, RabbitMQ re-delivers any unacknowledged job and the homelab worker takes it,
exactly as when a worker restarts. Tested by stopping the services: consumers went 2 -> 1 -> 2.

Why the laptop and not node-2: the production HLS command on one 178 s 1080x1920 episode takes
85 s on the homelab M1, 85 s on this laptop (i7-12650H; 119 s each for two at once, M1: 148 s) and
610 s on node-2 under a 2 CPU cap, which fails the worker's 3x timeout on long videos
(see `infra/friend-mail-node/README.md`).

## How it connects

No Tailscale is needed. The worker only talks to RabbitMQ (through an SSH tunnel to the homelab,
`ssh velora-homelab` already goes through Cloudflare Access) and to Cloudflare R2 over HTTPS.

```text
laptop container (--network host) -> 127.0.0.1:25672 -> ssh -L -> homelab 127.0.0.1:5672 (RabbitMQ)
                                  -> https://<account>.r2.cloudflarestorage.com (R2)
```

## Files on the laptop (not in the repo)

`~/.config/velora-media-worker/media.env` (mode 600): `RABBITMQ_URL` (the homelab value with host
`127.0.0.1:25672`), `R2_*`, `FFMPEG_PATH` and the `MEDIA_*` HLS tuning keys, copied from the homelab
`.env`. Keep the `MEDIA_*` values equal to the homelab ones, or HLS output depends on which host took
the job. `~/.config/velora-media-worker/image.env`: `IMAGE=<user>/media-processing-service:<sha>-amd64`,
the amd64 image the Homelab CD builds next to the arm64 one.

## systemd user units

`~/.config/systemd/user/velora-rmq-tunnel.service`:

```ini
[Unit]
Description=SSH tunnel to the homelab RabbitMQ (127.0.0.1:25672)
After=network-online.target

[Service]
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -L 127.0.0.1:25672:127.0.0.1:5672 velora-homelab
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/velora-media-long-worker.service`:

```ini
[Unit]
Description=Velora media-processing worker (LONG lane) on this laptop
Requires=velora-rmq-tunnel.service
After=velora-rmq-tunnel.service

[Service]
EnvironmentFile=%h/.config/velora-media-worker/image.env
ExecStartPre=-/usr/bin/docker rm -f velora-media-long-worker
ExecStart=/usr/bin/docker run --rm --name velora-media-long-worker --network host --cpus 8 --cpu-shares 256 --memory 3g --env-file %h/.config/velora-media-worker/media.env -e MEDIA_WORKER_LANE=LONG -e MEDIA_WORKER_PREFETCH=1 -e TIKTOK_CDN_ENABLED=false -e RABBITMQ_HEARTBEAT_SECONDS=30 ${IMAGE}
ExecStop=/usr/bin/docker stop -t 20 velora-media-long-worker
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
```

It is capped at 8 CPUs, 3 GB and a low CPU weight so the laptop stays usable.
Since 2026-11-17 the units run with `TIKTOK_CDN_ENABLED=true` and `media.env` holds the four
`TIKTOK_CDN_*` values of the homelab `.env` (copied without their quotes, because `docker --env-file`
keeps quotes; the values contain `&`, so do not `source` the file in a shell). Jobs handled here then
stream their segments to the TikTok CDN like the homelab ones (the laptop's keep-alive ping answered
"Session active"). If uploads start failing with a permission error, go back to
`TIKTOK_CDN_ENABLED=false` (jobs then upload to R2): the same session cookie is shared with the
homelab, so a refresh must be copied to both places. Before that change this said: `TIKTOK_CDN_ENABLED=false`
kept the TikTok session tied to the homelab address, so jobs handled here uploaded to R2. The heartbeat is 30 s so a sleeping laptop is noticed within about a minute.

## Short-lane unit

`~/.config/systemd/user/velora-media-short-worker.service` is the long-worker unit with the name,
`ExecStartPre`/`ExecStop` container name and `-e MEDIA_WORKER_LANE=LONG` changed to
`velora-media-short-worker` and `-e MEDIA_WORKER_LANE=SHORT`; everything else (8 CPUs, 3 GB, low CPU
weight, `TIKTOK_CDN_ENABLED=false`, heartbeat 30 s) is identical. Both units share `media.env` and
`image.env`.

Which lane a job takes is decided by content-service from `clientObservedDurationMs` (up to
`MEDIA_SHORT_MAX_DURATION_SECONDS`, 180 s, is SHORT). A publish with no duration is queued as LONG,
so a test that must reach the short workers has to send the real duration.

Measured on 2026-11-16 (4 concurrent 106 s reels): 710-870 s with one short consumer, 429-510 s with
the laptop as a second consumer. Failover: a hard `docker kill` of the short worker 50 s into an
encode left the job unacknowledged, RabbitMQ redelivered it, the homelab worker took it with a new
attempt id and the reel completed about 3 minutes after the kill with nothing in the dead-letter
queue. The containers run with `--rm`, so their logs disappear when they are killed; copy them first
if you need them.

Remember that the encoder settings come from `media.env`: when the homelab `MEDIA_HLS_X264_PRESET`
changes, change it here in the same step.

## Operate

```sh
systemctl --user enable --now velora-rmq-tunnel velora-media-long-worker velora-media-short-worker
systemctl --user stop velora-media-long-worker velora-media-short-worker velora-rmq-tunnel   # leave the queues
docker logs -f velora-media-short-worker
```

Update: pull the new image, put its tag in `image.env`, then
`systemctl --user restart velora-media-long-worker velora-media-short-worker`. Keep it close to the homelab release, since the
job message format is shared. The user units start at login; run `loginctl enable-linger $USER` to
keep them running without a session.

Risks: the R2 write keys live on this machine; a job that is mid-transcode when the laptop sleeps
restarts from scratch on the homelab; the worker competes with your own CPU use.
