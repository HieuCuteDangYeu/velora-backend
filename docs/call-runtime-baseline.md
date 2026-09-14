# Call runtime baseline and release gate

This document records the comparison point for the four call-runtime fixes. It
is intentionally explicit about measurements that were not captured; missing
device evidence must not be replaced with invented numbers.

## Comparison points

| Item | Baseline before this fix | Candidate after this fix |
| --- | --- | --- |
| Backend | `87688b2942c3383cffcc5929907b1a2e90210c81` | `6b3353d064bb92322988dc8b0e02df000e7701fc` |
| Mobile | `0e7722076857e3e79625afc376dfd57b1a1b1207` | `c4a5b6a0cf4f9fe9fe329c2e8e823dd7a099efea` |
| Captured at | 2026-09-14, Asia/Ho_Chi_Minh | 2026-09-14, Asia/Ho_Chi_Minh |

The baseline SHAs are immutable source references. The baseline runtime
measurements below are **not captured** because the paired physical iPhone was
offline during this audit and an iOS simulator cannot prove CallKit/PushKit
behavior. Do not mark the real-device gate green until the matrix is rerun.

## Safe diagnostic contract

Development diagnostics and release telemetry may contain only:

- `socketGeneration` and call/setup generation;
- shortened call, transport and producer identifiers;
- shortened media `requestId`/`actionId`;
- camera `revision`, command status and bounded retry attempt;
- a stable `errorCode` and `recoveryReason`.

They must never contain access tokens, real user identifiers, SDP, RTP
parameters, native SDK error messages or audio/video content. The candidate
implementation uses bounded error categories and shortened IDs at call/media
diagnostic sites.

## Baseline scenarios to capture on the same build pair

| Scenario | Required evidence | Baseline status |
| --- | --- | --- |
| iPhone ↔ simulator video call | device/simulator build IDs, socket disconnects, ICE restarts, media rebuilds | not captured — physical iPhone unavailable |
| 20 camera toggles | command/revision sequence and peer convergence | not captured |
| inactive → active | producer/consumer count and camera revision | not captured |
| 3–5 second network loss | control-plane recovery without CoreAudio/media teardown | not captured |

Record only aggregate counters and the safe fields above. A simulator-only run
is useful for JavaScript behavior but cannot satisfy the CallKit row.

## Candidate gates

The source gates are reproducible from the repositories:

```sh
# backend
pnpm exec jest --runInBand \
  apps/call-service/test/e2e/call-flow.e2e.spec.ts \
  apps/call-service/test/unit/infrastructure/call.gateway.spec.ts \
  apps/call-service/test/unit/infrastructure/mediasoup-call.engine.spec.ts \
  apps/call-service/test/unit/infrastructure/call-ws-exception.filter.spec.ts \
  apps/call-service/test/unit/infrastructure/call-socket-config.spec.ts \
  apps/call-service/test/unit/application/video-call.use-case.spec.ts
pnpm run build:call

# mobile
pnpm test
pnpm run type-check
pnpm run lint
```

The Definition of Done remains blocked until the real-device matrix is
recorded: 30 toggles, 10 foreground/background transitions, lock/unlock,
network loss at 3/10/>20 seconds, toggle during reconnect, end during
recovery, voice regression and CallKit accept/end on a physical iPhone.
