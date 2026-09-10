# Call runtime rollout

`call-service` currently owns Mediasoup rooms and Socket.IO call state in one
process. It must run as one instance until a future release adds both a
Socket.IO adapter and Mediasoup room affinity.

The service acquires a Redis lease before it starts listening. A second
instance fails startup; an instance that loses its lease closes itself. The
production compose definition also declares one replica.

## Required local configuration

Keep these values in the deployed service environment, not in remote config:

```sh
CALL_SINGLE_INSTANCE_GUARD=true
CALL_RUNTIME_LEASE_TTL_MS=15000
# Optional when the platform does not expose a unique hostname:
CALL_RUNTIME_INSTANCE_ID=call-service-primary
```

`CALL_SINGLE_INSTANCE_GUARD=false` is only for an isolated local developer
environment. It is not a safe production rollback because it reintroduces the
multi-node media-room risk.

## Deployment order and rollback

1. Back up the notification database, then apply the additive notification
   migrations from the checked-out backend source before replacing either
   runtime:

   ```sh
   pnpm exec prisma migrate deploy --schema=apps/notification-service/prisma/schema.prisma
   ```

   This release adds `notification_jobs.idempotency_key`; starting the new
   notification image before that migration is unsafe.
2. Deploy the new `notification-service` first. It consumes both the legacy
   `call_queue` and the new `notification_queue`, so old call-service images
   remain compatible during this window. Confirm it is healthy and can create
   a `CALL_STATE_UPDATE` notification job.
3. Deploy this `call-service` release as exactly one canary instance. It
   publishes lifecycle events to `notification_queue` and owns the Redis
   runtime lease.
4. Confirm the single runtime lease is held, no startup rejects occur, and
   both `join_call` / `answer_call` and `accept_incoming_call` complete a
   direct test call.
5. Monitor `accept_incoming_call` outcomes, `media_unavailable`,
   `answered_elsewhere`, and notification-job failures before rolling out the
   mobile prewarm release.
6. Release mobile with the baked atomic flag enabled. A rollback may set
   `EXPO_PUBLIC_CALL_ATOMIC_ACCEPT_ENABLED=false` in a newly built client;
   do not fetch this flag on the incoming-call cold path. Keep the new backend
   release running because the compatible legacy flow also uses its atomic
   lifecycle service.

If the call-service canary must be rolled back after notification-service is
already new, leave notification-service deployed: it intentionally supports
the old queue for the compatibility window. Do not roll back the notification
database migration; it is additive.

Do not use a remote-config fetch on the incoming-call cold path. Physical
iPhone/PushKit testing remains the release gate for killed or locked app
behavior; a debug simulator build cannot prove that path.

## Physical release-gate checklist

Run these checks on two physical iPhones using a Release/TestFlight build
after the backend canary is healthy. Record the native and server telemetry
timestamps for the first cold-start answer so regressions can be compared to
the PR0 baseline.

1. With the recipient app locked and then force-quit, place a voice call,
   answer it from CallKit, and confirm that the call reaches audible two-way
   audio without replaying the Answer action after the app opens.
2. Repeat while the caller cancels before the recipient app finishes opening.
   The recipient must never resurrect the call or show a stale call screen.
3. Sign the same recipient account into two devices and answer both incoming
   CallKit notifications at once. Exactly one device may join; the other must
   end as `answered_elsewhere`.
4. Tap End during the recipient's Connecting phase and then repeat after
   disabling the network immediately after Answer. Neither path may leave a
   persistent CallKit call or a server-side active call.
5. Switch account or log out while a native incoming action is pending. The
   action must not be processed with the former account's socket credentials.
6. Deny microphone permission and, for a video call, camera permission. The
   call must end with the matching terminal reason; video is intentionally
   rejected rather than silently downgraded to voice.
7. Verify the legacy `join_call` / `answer_call` client flow once during the
   compatibility window, then verify `accept_incoming_call`. Both must use the
   same first-winner server lifecycle.

Do not enable the mobile baked atomic flag for a broader release until every
check passes and the canary has no unexpected `media_unavailable`,
`answered_elsewhere`, call-state notification, or runtime-lease failures.
