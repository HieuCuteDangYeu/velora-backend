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

## Local checks

```sh
node --test scripts/ops/seed-chat-stress-users.test.cjs scripts/ops/prepare-chat-stress-rooms.test.cjs
```
