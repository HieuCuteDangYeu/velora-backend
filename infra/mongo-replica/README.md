# MongoDB read replica on the second VPS

Set up on 2026-11-12. The homelab `mongo` container (replica set `rs0`) has one
non-voting secondary on a VPS. Nothing here is deployed by CI; the VPS is managed
by hand over SSH.

| Item | Value |
| --- | --- |
| VPS | `144.91.101.1` (Ubuntu 24.04, 6 vCPU, 11 GB RAM), tailnet name `velora-db-replica`, tailnet IP `100.86.68.16` |
| Homelab | tailnet name `quan`, tailnet IP `100.102.228.48` |
| Secondary | container `mongo-replica` from `compose.yaml`, files in `/opt/mongo-replica/` on the VPS |
| Member config | `{ host: '100.86.68.16:27017', priority: 0, votes: 0 }` |

## How it is wired

- The VPS container maps the name `mongo` to the homelab tailnet IP with
  `extra_hosts`, because the primary's member host in the `rs0` config is
  `mongo:27017`.
- The homelab exposes the primary to the tailnet with
  `sudo tailscale serve --bg --tcp 27017 tcp://localhost:27017` (persistent in
  `tailscaled`). The compose file of the main stack was not changed and the
  container was not recreated.
- The secondary publishes port 27017 only on the VPS tailnet IP, never on the
  public IP. Docker is ordered after `tailscaled` by
  `/etc/systemd/system/docker.service.d/10-after-tailscale.conf`.
- The keyfile is the homelab one (`mongo_config` volume), copied to
  `/opt/mongo-replica/keyfile` with owner 999 and mode 400. It is a secret and is
  not in this repo. If the homelab keyfile is ever regenerated, copy it again.

## Why the secondary has no vote

With two voting members the primary steps down whenever the VPS is unreachable.
With `votes: 0` the homelab alone is the majority, so a VPS outage or lag never
affects writes, including `w: majority`.

## Using it

The VPS is in France and the homelab in Vietnam, about 217 ms round trip over a
direct Tailscale path. A service next to the primary reads in under 1 ms, the same
service reading the replica takes about 226 ms (measured 2026-11-12 with
`message.findMany`, 20 rows), and a service on the VPS reads its local replica in
about 6 ms. So routing reads to this replica pays off for reads nobody is waiting
on, or for services that run on the VPS.

### Replica reads in conversation-service

`PrismaReadReplicaService` is a second Prisma client used only by reads that
tolerate a few seconds of lag. It is off by default. Today one read uses it:
`get_reaction_details` (who reacted to a message).

| Setting | Effect |
| --- | --- |
| `CONVERSATION_READ_REPLICA_PREFERENCE` unset, empty, or anything else | all reads stay on the primary, no second connection pool is created |
| `secondaryPreferred`, `secondary` or `nearest` | the read client uses the same `CONVERSATION_DATABASE_URL` with that `readPreference` |

Safety rules built into the service: a replica error is retried once on the
primary (`target="fallback"`), a replica miss (`null`) is confirmed on the primary
before answering 404 (`target="miss"`), and the membership check for the request
always runs on the primary. Do not route authorization checks, read-after-write
reads, or message history (recalled messages must not reappear) through it.

To turn it on, add `CONVERSATION_READ_REPLICA_PREFERENCE=secondaryPreferred` to
the homelab `.env` and recreate only `conversation-service`. This changes `.env`,
so `velora-deploy` will report env drift until the new hash is accepted.

### Showing the split

Prometheus metric `velora_conversation_routed_read_duration_seconds` (histogram,
labels `operation` and `target`). Reads per member and replica latency:

```promql
sum by (target) (rate(velora_conversation_routed_read_duration_seconds_count[5m]))
histogram_quantile(0.95, sum by (le, target) (rate(velora_conversation_routed_read_duration_seconds_bucket[5m])))
```

To see the replica serve queries independently of the app, compare
`db.serverStatus().opcounters.query` on the secondary before and after.

## Check health

On the homelab primary, `rs.status()` should show the secondary as `SECONDARY`
with `health: 1`, and the optime difference to the primary should be a few
seconds at most. If the secondary falls further behind than the oplog window, it
needs a fresh initial sync (remove the `mongo_replica_data` volume and restart).
