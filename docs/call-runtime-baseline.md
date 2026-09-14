# Call runtime baseline and release gate

This document records the comparison point for the four call-runtime fixes. It
is intentionally explicit about measurements that were not captured; missing
device evidence must not be replaced with invented numbers.

## Comparison points

| Item | Baseline before this fix | Candidate after this fix |
| --- | --- | --- |
| Backend | `87688b2942c3383cffcc5929907b1a2e90210c81` | `d2eab4282bae4d7ed881071b0b4e6ed91106e70e` |
| Mobile | `0e7722076857e3e79625afc376dfd57b1a1b1207` | `2054abc9a55193646b484ad360d06016697c1c3a` |
| Captured at | 2026-09-14, Asia/Ho_Chi_Minh | 2026-09-14, Asia/Ho_Chi_Minh |

The baseline SHAs are immutable source references. The baseline runtime
measurements below were **not captured** during the source audit. The paired
physical iPhone is now available, but the manual matrix has not been executed;
an iOS simulator cannot prove CallKit/PushKit behavior. Do not mark the
real-device gate green until the matrix is rerun.

## Candidate build evidence

- The iPhone 17 simulator candidate built, installed and launched successfully
  with `npx expo run:ios --device "iPhone 17" --no-bundler`.
- The Debug `iphoneos` candidate built successfully with Xcode, and the same
  `com.quan.velora.dev` app installed and launched on the paired physical
  iPhone.
- These are compile/install checks only. No call, network-loss, camera-toggle
  or CallKit measurements are inferred from them; the physical matrix below
  remains pending.

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
| iPhone ↔ simulator video call | device/simulator build IDs, socket disconnects, ICE restarts, media rebuilds | not captured — manual physical-device matrix pending |
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
  apps/call-service/test/unit/infrastructure/call-service-runtime-lease.spec.ts \
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
