# Second mediasoup media node on velora-node-2

Tested 2026-11-12. `call-media-2` is a copy of the homelab `call-media-1` that runs on
`velora-node-2` (France, static public IPv4 `144.91.101.1`). It removes the limit
described in `docs/call-runtime-rollout.md`: the home router forwards only UDP 40000, so
the homelab can host one media node, while node-2 has its own public IP and free ports.
It is **not** part of the homelab compose stack and the deploy script does not manage it.
It is stopped by default (start with the command below).

| Item | Value |
| --- | --- |
| Stack | `/opt/velora/call-media/` on node-2: `compose.yaml` (this folder), `.env`, `src/` |
| Image | `call-service-node2:<sha>`, built on node-2 (see below) |
| Public media port | UDP 40000 on `144.91.101.1`, announced with `MEDIASOUP_ANNOUNCED_IP_MODE=static` |
| RPC and metrics | `100.86.68.16:4100` and `:3019`, tailnet address only (the RPC has no authentication) |
| Registry and queue | the homelab Redis and RabbitMQ, reached as `redis` and `rabbitmq` through `extra_hosts` to `100.102.228.48` |

## Why the image is built on node-2

CI publishes `linux/arm64` only (the homelab is Apple Silicon); node-2 is `x86_64`. The
image is built there from a `git archive` of the commit with the repo Dockerfile,
`--target production`, without touching CI:

```sh
git archive --format=tar HEAD | ssh root@144.91.101.1 'rm -rf /opt/velora/call-media/src && mkdir -p /opt/velora/call-media/src && tar -x -C /opt/velora/call-media/src'
ssh root@144.91.101.1 'cd /opt/velora/call-media/src && docker build -f apps/call-service/Dockerfile --target production -t call-service-node2:<sha> .'
```

It takes about 15 minutes (it compiles the mediasoup worker). Rebuild whenever the media
node contract changes, and keep the image tag in `compose.yaml` in step with it.

## What the node needs

- `.env` next to the compose file with only `REDIS_PASSWORD` and `RABBITMQ_URL` (mode 600,
  copied from the homelab media node; not in the repo). Nothing else from the homelab `.env`.
- On the homelab, `sudo tailscale serve --bg --tcp 6379 tcp://localhost:6379` and the same
  for `5672`. Both services keep their passwords.
- `CALL_MEDIA_RPC_HOST` set to the node-2 tailnet IP, because the node publishes that host
  in its heartbeat and the signaling replicas dial it.
- A scrape target in `infra/monitoring/prometheus/prometheus.yml` (job `call-media`,
  address `100.86.68.16:3019`, relabelled to `instance="call-media-2:3019"`). Without it
  `VeloraCallMediaNodeDown` cannot fire for this node. The target is reachable from the
  Prometheus container over Tailscale; it takes effect when Prometheus reloads the file.

Start and stop:

```sh
cd /opt/velora/call-media && docker compose up -d     # registers in call:media-nodes
cd /opt/velora/call-media && docker compose stop      # its Redis record expires within seconds
```

## Placement warning

New calls go to the live node with the fewest rooms, with a random choice among equals
(`chooseNode` in `remote-call-media.engine.ts`). There is no weight, drain flag or latency
awareness, so while node-2 is registered about half of the new calls are placed in France.
The homelab to node-2 round trip is about 217 ms, and every media RPC from signaling and
every Redis command from the node crosses it. Run it only for demos and tests, or add
region-aware placement first.

## Test result, 2026-11-12

Three group voice calls started from the iPhone simulator in a two-member stress fixture
group, with only test traffic and no other calls running:

| Call | Placed on | Placement key after tap | Room visible in heartbeat |
| --- | --- | --- | --- |
| 1 | call-media-1 | 2 s | 8 s |
| 2 | call-media-1 | 1 s | 7 s |
| 3 | call-media-2 | 3 s | 6 s |

The third call showed "Waiting for others to join, 1 person in call" with no media error.
`tcpdump` on node-2 showed UDP in both directions between `144.91.101.1:40000` and the
public IP of the test Mac while the call was up, so the direct UDP path to the node works.
The rooms returned to zero and `call:media-nodes` returned to a single entry after each
call. Three samples with one participant do not measure call quality or setup time; a
two-device call and several repetitions are needed for that.
