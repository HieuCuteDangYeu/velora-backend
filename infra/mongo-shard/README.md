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

All three collections use hashed keys on the same ObjectId, so a conversation,
its members and its messages hash to the same value and stay on one shard;
sending a message is a single-shard transaction:

- `conversations`: `{ _id: "hashed" }`
- `conversation_members`: `{ conversationId: "hashed" }`
- `messages`: `{ conversationId: "hashed" }`

The unique indexes `conversationId, userId` and `conversationId, senderId,
clientMessageId` still work: every document with the same conversationId has
the same hash, so uniqueness per shard is uniqueness overall (checked on
MongoDB 8.0.34 on 2026-11-23: duplicate inserts fail with 11000, upserts work).

Zones split the hashed space in two on every collection: `lab2` (shard rs1, the
laptop) owns `[MinKey, 0)` and `home` (shard rs0) owns `[0, MaxKey)`. New
conversations therefore land on either shard about half the time. The first
layout (2026-11-23 morning) used ranged keys split at one ObjectId, which sent
every new conversation to rs0; it was resharded to the hashed keys with
`reshardCollection` the same day.

## Users

Through mongos, users live on the config server, not on the shards. The cluster
has its own `root` (same name and password as `MONGO_INITDB_ROOT_*`) and
`velora_conversation` (same password as in `CONVERSATION_DATABASE_URL`). The old
users on rs0 exist for maintenance only: MongoDB 8.0 rejects direct reads and
writes on a shard unless the user has `directShardOperations` (nobody has it now;
both nightly backups dump through a mongos). Before adding a shard, move every
client to mongos first, or the shard starts refusing it the moment it joins.

## Operating notes

- The laptop holds shard 2 alone: when it is off, conversations in zone `lab2`
  fail to load or send; everything on rs0 keeps working. Its state is in
  `infra/windows-node/check-after-reboot.sh`.
- A backup of `conversation_db` must go through mongos (or dump both shards);
  the node-2 backup worker dumps only rs0 from its secondary.
- Check the cluster: `docker exec mongos mongosh -u root -p ... --authenticationDatabase admin --eval 'sh.status()'`.
