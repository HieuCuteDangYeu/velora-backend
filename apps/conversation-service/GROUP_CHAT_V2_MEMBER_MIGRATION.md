# Group Chat V2 — ConversationMember Migration and Cutover

## Goal

Introduce authoritative per-member group roles and membership without breaking direct chats, existing group history, realtime event names, or the legacy `Conversation` compatibility fields.

Group calls, invite-link/approval/ban flows, and Phase 2 discovery features are intentionally outside this migration.

## Compatibility model

The legacy `Conversation` fields remain a compatibility projection during the first V2 rollout window:

- `creatorId`
- `participantIds`
- `memberJoinedAt`

The new group membership source is `ConversationMember`:

- `conversationId`
- `userId`
- `role`: `OWNER | ADMIN | MEMBER`
- `status`: `ACTIVE | LEFT | REMOVED`
- `joinedAt`
- `invitedBy`
- `leftAt`
- `removedBy`

Direct conversations are not backfilled into `ConversationMember` and continue using their existing behavior.

## Stage 0 — Schema deploy

1. Generate the conversation Prisma client.
2. Validate the conversation schema.
3. Deploy the schema using the repository's normal MongoDB schema deployment process.
4. Confirm the `conversation_members` collection and indexes exist.
5. Confirm the deployment uses a MongoDB replica set because Stage 5/6B role and membership guards use interactive transactions.

Required commands:

```bash
pnpm prisma:generate:conversation
pnpm exec prisma validate --schema=apps/conversation-service/prisma/schema.prisma
```

## Stage 1 — Audit and backfill

Audit first:

```bash
pnpm audit:conversation-members-v2
```

Apply only after reviewing the audit:

```bash
pnpm backfill:conversation-members-v2:apply
```

Equivalent guarded command:

```bash
CONFIRM=BACKFILL_CONVERSATION_MEMBERS_V2 node scripts/backfill-conversation-members-v2.cjs
```

Run the audit again and require:

- `missingMembers = 0`
- `mismatchedMembers = 0`
- `orphanActiveMembers = 0`
- `invalidGroups = 0`

Backfill rules:

- legacy `creatorId` becomes `OWNER`;
- active existing `ADMIN` is preserved;
- other active participants become `MEMBER`;
- previously `LEFT`/`REMOVED` admins that reappear become `MEMBER` until the owner promotes them again;
- `joinedAt` uses `memberJoinedAt[userId]`, falling back to conversation creation time.

## Stage 2 — Compatibility dual write

Group create/add/remove/leave/ownership-transfer continue maintaining the legacy `Conversation` projection while synchronizing `ConversationMember`.

The compatibility path protects current clients while the V2 projection is verified. Projection drift can be repaired by the audit/backfill script.

## Stage 2.5 — Shadow consistency

Enable:

```bash
GROUP_V2_SHADOW_CONSISTENCY_ENABLED=true
```

This flag is default-OFF. The checker compares legacy membership against `ConversationMember` after group lifecycle mutations and reports drift when it detects:

- missing active members;
- unexpected active members;
- OWNER mismatch;
- `joinedAt` mismatch;
- projection/conversation read failure.

Drift log prefix:

```text
[GroupV2Shadow] membership projection drift
```

The check is telemetry only and never turns an otherwise successful compatibility mutation into a client failure.

## Stage 3 — V2 member read contract

Internal RMQ:

```text
get_group_member_projection
```

Gateway:

```text
GET /conversations/:id/members/v2
```

Response:

```ts
{
  userId: string
  user: {
    id: string
    email: string
    name?: string
    fullName?: string
    picture?: string
  }
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
  status: 'ACTIVE'
  joinedAt: string
  invitedBy?: string | null
}
```

The legacy `/members` endpoint remains available for compatibility.

## Stage 4 — Permission matrix

| Action                      | OWNER          | ADMIN | MEMBER |
| --------------------------- | -------------- | ----- | ------ |
| Rename/change group picture | Yes            | Yes   | No     |
| Add member                  | Yes            | Yes   | No     |
| Remove MEMBER               | Yes            | Yes   | No     |
| Remove ADMIN                | Yes            | No    | No     |
| Promote MEMBER → ADMIN      | Yes            | No    | No     |
| Demote ADMIN → MEMBER       | Yes            | No    | No     |
| Transfer ownership          | Yes            | No    | No     |
| Leave group                 | Transfer first | Yes   | Yes    |
| Disband group               | Not enabled    | No    | No     |

The pure policy is implemented in `group-permission.policy.ts`.

## Stage 5 — Role mutations

Enable:

```bash
GROUP_V2_ROLE_MUTATIONS_ENABLED=true
```

Gateway:

```text
PATCH /conversations/:id/members/:userId/role
```

Body:

```json
{ "role": "ADMIN" }
```

or:

```json
{ "role": "MEMBER" }
```

Only the current legacy owner can promote/demote during the transitional rollout. The write uses a MongoDB/Prisma transaction and guards ownership, active membership, and expected role against concurrent changes.

Idempotent role requests return success without creating another role write, activity entry, or duplicate `conversation_updated` event.

## Stage 6A — Canonical V2 reads

Enable:

```bash
GROUP_V2_CANONICAL_MEMBER_READS_ENABLED=true
```

The flag affects only `get_group_member_projection` / `/members/v2`.

When enabled:

- membership comes from ACTIVE `ConversationMember` rows;
- roles come from `ConversationMember`;
- `joinedAt` comes from `ConversationMember.joinedAt`;
- requester must be an ACTIVE projected member;
- projection failure is fail-closed, with no legacy fallback;
- active projected user ids must still exactly equal legacy `participantIds`;
- projected OWNER must still exactly equal legacy `creatorId`;
- every projected `joinedAt` must still equal legacy `memberJoinedAt[userId]`, falling back to `Conversation.createdAt`;
- any member-set, OWNER, or `joinedAt` drift returns conflict.

These equality checks are temporary cutover guards and deliberately remain during the first V2 test window.

## Stage 6B — ADMIN permissions and transactional membership mutations

Enable:

```bash
GROUP_V2_ADMIN_PERMISSIONS_ENABLED=true
```

This flag is default-OFF. With it disabled, the old owner-only V1 management path remains active.

With it enabled, rename/photo/add/remove/leave/transfer operations resolve the active V2 role and use `PrismaGroupManagementV2Repository` transactional guards.

Repository invariants include:

- actor must remain ACTIVE with the expected role;
- exact legacy `participantIds` are guarded for membership changes;
- ADMIN can remove only a `MEMBER`;
- current OWNER can never be removed at the repository boundary;
- target role must still match inside the transaction;
- ownership transfer requires the current OWNER and a different active target;
- two-member minimum is rechecked in the transaction path;
- legacy `participantIds`/`memberJoinedAt` and `ConversationMember` are committed together for V2 membership changes.

## Stage 6C — Structured group system activities

Enable:

```bash
GROUP_V2_SYSTEM_ACTIVITIES_ENABLED=true
```

Implemented activity types:

- `GROUP_CREATED`
- `MEMBER_ADDED`
- `MEMBER_LEFT`
- `MEMBER_REMOVED`
- `MEMBER_PROMOTED`
- `MEMBER_DEMOTED`
- `OWNERSHIP_TRANSFERRED`
- `GROUP_RENAMED`
- `GROUP_PICTURE_CHANGED`

Activities are stored as regular server-managed messages with structured `metadata.kind = group_system_activity`. The message content is encrypted at rest through the existing server-managed encryption path, while `Conversation.lastMessage` receives the readable activity preview.

Mobile renders these messages as centered, non-interactive timeline rows and preserves structured activity metadata through HTTP, Socket.IO, and the local WatermelonDB sync path.

Ordinary retries do not create duplicate activities because activities are only requested after a mutation reports a real state change. This is still a best-effort side effect rather than a transactional outbox: a process crash after the membership mutation but before asynchronous activity persistence can lose that activity entry. A strict outbox is a separate reliability migration.

## Group avatar

Backend group metadata supports picture set/removal. Mobile Group Info now supports:

1. choose JPEG/PNG/WebP;
2. existing media `upload-url` flow;
3. direct upload to the returned URL;
4. existing `finalize-upload` flow;
5. PATCH the finalized public URL into `conversation.picture`;
6. remove photo with `picture: null`.

No new media-service endpoint is required.

## One-pass staging flag set

For the requested single end-to-end V2 test, enable all five gates together **only after schema generation/validation and a clean backfill audit**:

```bash
GROUP_V2_SHADOW_CONSISTENCY_ENABLED=true
GROUP_V2_CANONICAL_MEMBER_READS_ENABLED=true
GROUP_V2_ROLE_MUTATIONS_ENABLED=true
GROUP_V2_ADMIN_PERMISSIONS_ENABLED=true
GROUP_V2_SYSTEM_ACTIVITIES_ENABLED=true
```

Do not enable only Stage 6B while canonical reads or projection consistency are known to be unhealthy; the management use case deliberately fails closed on membership/owner/`joinedAt` drift.

## Required automated validation before merge

Backend minimum:

```bash
pnpm prisma:generate:conversation
pnpm exec prisma validate --schema=apps/conversation-service/prisma/schema.prisma
pnpm test -- create-conversastion.use-case.spec.ts group-activity.service.spec.ts group-membership-consistency.service.spec.ts get-group-members.use-case.spec.ts manage-group-role.use-case.spec.ts group-permission.policy.spec.ts prisma-conversation-member.repository.spec.ts prisma-group-management-v2.repository.spec.ts prisma-conversation-chat.repository.spec.ts manage-group-conversation.use-case.spec.ts group-members.controller.spec.ts group-members-v2.controller.spec.ts chat.gateway.realtime.spec.ts chat.gateway.room-migration.spec.ts
pnpm build:conversation
pnpm build:gateway
```

Mobile minimum:

```bash
npm run type-check
npm test
npm run lint
```

These commands are requirements, not evidence that they have already passed in the current agent environment.

## Runtime validation before merge

1. Audit staging.
2. Apply backfill after review.
3. Audit again and require zero drift.
4. Enable the one-pass five-flag set above.
5. Execute `GROUP_CHAT_V2_FINAL_TEST_CHECKLIST.md` on staging.
6. Confirm no `[GroupV2Shadow]` warnings under valid traffic.
7. Confirm MongoDB transactions succeed on the actual replica-set deployment.
8. Validate Android and iOS physical devices.
9. Confirm direct chat send/reply/reaction/media/read-receipt/presence/call behavior remains unchanged.
10. Confirm group calls remain blocked until the separate Phase 4 implementation.

No merge should happen until runtime and physical-device validation is complete.

## Product policies intentionally unchanged

### Two-member groups

Two-member groups remain valid. Removing/leaving is blocked if it would reduce an existing group below two active legacy participants. Disband remains unresolved and disabled.

### New-member history

V2 continues the current FULL HISTORY behavior. Join-boundary history is a separate privacy migration because it must update pagination, anchored message navigation, search, reply targets, local bootstrap, and related data access together.

### Group calls

Group calls remain outside this migration and must stay blocked until the separate Mediasoup Phase 4 work is implemented and tested.
