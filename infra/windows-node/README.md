# Windows laptop in Vietnam as the third server

Set up on 2026-11-13. A Windows 11 Pro laptop (i5-8250U, 7.9 GB RAM, Wi-Fi, same LAN as the
homelab) runs Ubuntu 24.04 in WSL2 with Docker Engine, and hosts a non-voting MongoDB
secondary and a PostgreSQL hot standby of the homelab. Nothing here is deployed by CI; the
machine is managed by hand over SSH.

| Item | Value |
| --- | --- |
| Tailnet IP | `100.104.227.44` (LAN `192.168.1.10`, DHCP: reserve it in the router) |
| Windows account | `windows` (OpenSSH, key login, firewall rule allows 22 from `100.64.0.0/10` only) |
| Reach it from the Mac | `ssh -J ssh.velora-app.me windows@100.104.227.44` (the Mac is not on the tailnet; the homelab is the jump host) |
| WSL | `C:\Program Files\WSL\wsl.exe` by full path (the short `wsl` stub fails over ssh); distro `Ubuntu-24.04`, user `velora` (passwordless sudo), systemd on |
| Limits | `.wslconfig`: 5 GB RAM, 6 CPUs, mirrored networking (see `wslconfig.example`) |
| Stays up | scheduled task `VeloraWSLKeepAlive` (at logon of `windows`) runs `wsl -d Ubuntu-24.04 -u root -- sleep infinity` hidden. After a reboot WSL only starts once that user is logged in; enable auto-login if the laptop must recover alone |
| Stacks | `/opt/velora/mongo-replica`, `/opt/velora/postgres-replica` (compose files in this folder) |

## Mongo secondary

`mongo-replica.compose.yaml`: `mongo:8.0.34`, cache 1 GB, `network_mode: host`, listening on
loopback and the tailnet IP only. Host networking is required: a replica set member must reach
its own address to recognise itself, and behind a published port in WSL2 it cannot (it stays in
`STARTUP` with `isSelf ... HostUnreachable`). The keyfile is the homelab one
(`/data/configdb/keyfile` in the primary container), copied to
`/opt/velora/mongo-replica/keyfile`, owner 999, mode 400; not in this repo. Added with
`rs.add({ host: '100.104.227.44:27017', priority: 0, votes: 0 })`. Initial sync of
about 1.15 million messages took about 2 minutes. The homelab already exposes 27017 to the
tailnet (`tailscale serve`).

## Postgres standby

`postgres-replica.compose.yaml`: `postgres:18.6`, `shared_buffers=512MB`, port 5432 on the
tailnet IP. Role `replicator_win` (REPLICATION only; password in
`/opt/velora/postgres-replica/replicator.pw`, mode 600, not in this repo), a matching line in the
primary's `pg_hba.conf` (`host replication replicator_win 192.168.97.0/24 scram-sha-256`), and the
physical slot `win_standby` created by `pg_basebackup -C -S win_standby` (`basebackup.sh` in the
same folder on the machine). Verified 2026-11-13: `streaming`, async, lag 0, `notification_jobs`
row counts equal (1,707,272), writes refused on the standby. Failover is manual, as for node-2.

## Check health

- Primary: `select application_name, state, sync_state, replay_lag from pg_stat_replication`
  and `select slot_name, active, wal_status from pg_replication_slots` (`win_standby` active).
- Primary Mongo: `rs.status()` shows `100.104.227.44:27017` as `SECONDARY` with lag 0.
- Latency homelab to this machine: about 6 ms on the LAN, 14 to 18 ms over Tailscale, with
  peaks of 30 to 45 ms because both ends use Wi-Fi. Cable the laptop for steadier numbers.

## Not done yet

- A media node here (UDP 40001 must be forwarded to this machine; the image has to be built on
  this x86_64 machine, CI publishes arm64 only).
- Routing more reads to the replicas. Done: `get_reaction_details` and the presence audience read
  (`presence_audience`) use the Mongo secondary nearest to the homelab, which is this laptop.
  Postgres has no routed reads: the call history list is the only safe candidate and was left out.
- A Prometheus/host registry entry for this machine.
