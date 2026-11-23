# Sharded conversation database

`conversation_db` runs on a MongoDB sharded cluster:

| Part | Where | Address |
|---|---|---|
| Config server `cfg` (1 member) | homelab, `mongo-cfg` (this folder) | `mongo-cfg:27019`, tailnet via `tailscale serve --tcp 27019` |
| Router | homelab, `mongos` (this folder) | `mongos:27017` on the stack network |
| Shard 1 = `rs0` | homelab `mongo` (main compose, `--shardsvr`), secondary on velora-node-2 | `mongo:27017`, `100.86.68.16:27017` |
| Shard 2 = `rs1` (1 member) | Windows laptop, `infra/windows-node/mongo-shard2.compose.yaml` | `sh2.lab:27018` (= 100.104.227.44) |

conversation-service talks to the router when `CONVERSATION_MONGO_ROUTER=mongos:27017`
is set in `docker-compose.yml`; `apps/conversation-service/src/mongo-router-env.ts`
swaps the host of `CONVERSATION_DATABASE_URL` and drops `replicaSet`. Removing the
flag sends it straight to rs0 again (only safe while all chunks live on rs0).

## Shard keys

All three collections use ranged keys that put a conversation and its messages and
members on the same shard, so sending a message stays a single-shard transaction:

- `conversations`: `{ _id: 1 }`
- `conversation_members`: `{ conversationId: 1 }` (unique `conversationId, userId` is prefixed by it)
- `messages`: `{ conversationId: 1 }` (unique `conversationId, senderId, clientMessageId` is prefixed by it)

Zones keep the three aligned: zone `lab2` (shard rs1) owns `[MinKey, split)` and zone
`home` (shard rs0) owns `[split, MaxKey)` on every collection, with the same split
ObjectId. New conversations get larger ObjectIds, so they land on rs0 (the homelab,
on Ethernet). The balancer moves chunks to satisfy the zones.

## Users

Through mongos, users live on the config server, not on the shards. The cluster
has its own `root` (same name and password as `MONGO_INITDB_ROOT_*`) and
`velora_conversation` (same password as in `CONVERSATION_DATABASE_URL`). The old
users on rs0 still work for direct connections to shard 1 (backups, maintenance).

## Operating notes

- The laptop holds shard 2 alone: when it is off, conversations in zone `lab2`
  fail to load or send; everything on rs0 keeps working. Its state is in
  `infra/windows-node/check-after-reboot.sh`.
- A backup of `conversation_db` must go through mongos (or dump both shards);
  the node-2 backup worker dumps only rs0 from its secondary.
- Check the cluster: `docker exec mongos mongosh -u root -p ... --authenticationDatabase admin --eval 'sh.status()'`.
