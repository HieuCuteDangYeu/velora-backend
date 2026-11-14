# Isolated chat load fixtures

These operator scripts prepare synthetic USER identities and groups for the Node
runner in `Velora-dashboard/scripts/stress`. They do not change application pools,
authentication endpoints, encryption keys, or existing accounts.

## Private manifest

Keep the manifest outside Git, in a directory with mode `0700`, file mode `0600`.
It contains `baseUrl`, `fixtureNamespace`, `accounts`, `rooms`, and `stages`.
Accounts contain random UUID v4 IDs and independent random passwords. The
namespace is `mu-` followed by 12 random hexadecimal characters. Account suffixes
are `001`, `002`, and so on:

- Email: `<namespace>.<suffix>@velora-stress.invalid`
- Username: `vstress_<namespace without mu->_<suffix>`
- Full name: `Velora load <namespace> <suffix>`

Never publish passwords or tokens in task packets, logs, or reports. The `.invalid`
namespace is intentional: fixtures do not send registration email or register
native push tokens. They still log in through the normal mobile login API and
must pass actual authorization checks when joining or sending in a conversation.

## User and role preparation

Run `seed-chat-stress-users.cjs` in an operator environment with the generated
User/Auth Prisma clients and the corresponding database URL. Feed the manifest
through standard input. Run each phase first without `--apply` to inspect its
receipt, then with `--apply` to create only missing fixture rows.

```sh
node scripts/ops/seed-chat-stress-users.cjs --phase users < /private/manifest.json
node scripts/ops/seed-chat-stress-users.cjs --phase users --apply < /private/manifest.json
```

Store the successful User phase JSON receipt as `provisioning` in the private
manifest before running the `roles` phase. The latter requires the existing USER
policy and refuses any fixture with an elevated role. Execute phases sequentially;
each temporarily limits its Prisma PostgreSQL pool to one connection and always
disconnects. A mismatching existing identity fails closed; no password reset,
update, deletion, role escalation, or database reset is performed.

The receipt is an operator hand-off, not a signed authorization credential. Only
use a receipt from the actual successful User phase with the same private
manifest; never fabricate or copy its `verifiedUserIds` from another fixture.

## Twenty groups

For the initial 50-user scenario, prepare groups through normal authenticated APIs:

```sh
node scripts/ops/prepare-chat-stress-rooms.cjs --config /private/manifest.json
node scripts/ops/prepare-chat-stress-rooms.cjs --config /private/manifest.json --apply
```

The first command is a local plan only. The second creates ten groups of three
members and ten groups of two. Each account belongs to one group. Creation is
sequential and saves each result immediately. A retry discovers the stable group
name before creating anything and checks exact membership. An ambiguous POST is
never retried automatically. Setup sessions are logged out after use.

Run provisioning from one operator machine with one copy of the manifest. A
local exclusive lock prevents two processes using that manifest concurrently;
it does not lock another machine or a copied manifest. After an interrupted run,
confirm its process has exited before removing a stale `.prepare.lock` file.

This is a specific text-chat workload, not a measurement of mobile encryption,
native push, calls, all product traffic, or a guaranteed number of production
users. Only the live runner result establishes distinct authenticated users and
timely delivery; fixture row counts alone do not establish capacity.

## A crowd (scale profile)

The 50-user demo fixture has 20 rooms, so a stress run that holds thousands of
sockets spreads them over 50 accounts (80 sockets each) and one message is
written to about 200 sockets. A real message reaches a handful. For capacity
and scale-out work use a crowd instead: thousands of accounts in many small
rooms, one or two sockets per account.

```sh
# 1. A new isolated namespace; never touches the demo fixture. Multiple of 5, up to 5000.
node scripts/ops/generate-chat-stress-scale-fixtures.cjs --users 2000 \
  --base-url https://velora-app.me --out /private/scale-manifest.json

# 2. Users (User Service database) and USER roles (Auth Service database), exactly as above.
node scripts/ops/seed-chat-stress-users.cjs --phase users [--apply] < /private/scale-manifest.json
node scripts/ops/seed-chat-stress-users.cjs --phase roles [--apply] < /private/scale-manifest.json

# 3. Rooms through the normal API. On the server host use the local gateway; each user
#    presents its own benchmark address so the per-IP login limit does not apply.
node scripts/ops/prepare-chat-stress-rooms.cjs --config /private/scale-manifest.json \
  --base-url http://127.0.0.1 [--limit 25] [--apply]
```

The manifest carries `"fixtureProfile": "scale"`; without it the 200-account and
20-room limits of the demo apply. Rooms come in blocks of five accounts, one trio
and one pair per block (2.5 members on average, every account in exactly one
room). `--limit N` creates only the first N rooms, which is how to try the
procedure on a small batch before running it in full.

To make an existing crowd bigger, extend its manifest instead of creating a second
namespace. The accounts and rooms it already has are kept and new accounts are
appended, so steps 2 and 3 only create the new rows and the rooms of the new blocks:

```bash
node scripts/ops/generate-chat-stress-scale-fixtures.cjs --extend /private/scale-manifest.json \
  --users 5000 --out /private/scale-manifest-5000.json
```

The extended manifest has no user receipt, so run the users phase before the roles phase.

In `Velora-dashboard` the tools accept this manifest. The Mixed tool lets only a
bounded cohort send chat (`--chat-users`, default 200, on a block boundary,
which keeps whole rooms); the other accounts stay online through the connections
tool. There is no script that deletes a crowd: fixtures are isolated by
namespace and are never updated or removed by these tools.

## Removing what a stress run leaves behind

Messages and notification jobs pile up (millions after a day of stress runs) and slow
Mongo, Postgres, the nightly backups and the replication to the other servers.
`purge-chat-stress-data.cjs` removes them for one manifest and keeps the users and rooms:

```sh
# Inside the service containers (the Prisma clients and database URLs live there).
node purge-chat-stress-data.cjs --phase messages [--apply] < /private/manifest.json   # conversation-service
node purge-chat-stress-data.cjs --phase jobs     [--apply] < /private/manifest.json   # notification-service
```

It only counts unless `--apply` is given. Messages are deleted per batch of five fixture
rooms, jobs 20,000 at a time, with a pause (`--pause-ms`, default 250) so the oplog and WAL
replicated over Tailscale are not flooded. A room is only touched when it exists under the
exact name the manifest recorded; a mismatch aborts before any delete. Run the `jobs` phase
first if a backlog is still pending, and run each phase for every manifest you used
(the 50-user demo and any crowd).

## Local checks

```sh
node --test scripts/ops/seed-chat-stress-users.test.cjs scripts/ops/prepare-chat-stress-rooms.test.cjs
```
