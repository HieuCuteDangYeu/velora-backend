# Call runtime baseline and release gate

This document records the comparison point for the four call-runtime fixes. It
is intentionally explicit about measurements that were not captured; missing
device evidence must not be replaced with invented numbers.

## Comparison points

| Item | Baseline before this fix | Candidate after this fix |
| --- | --- | --- |
| Backend | `87688b2942c3383cffcc5929907b1a2e90210c81` | `3cb70df6e9bd3b20bb7ad4f74c3de8902086f012` |
| Mobile | `0e7722076857e3e79625afc376dfd57b1a1b1207` | `b20d769a4ff25cf2105721c9bff80566dea1c95c` |
| Captured at | 2026-09-14, Asia/Ho_Chi_Minh | 2026-09-14, Asia/Ho_Chi_Minh |

The baseline SHAs are immutable source references. The baseline runtime
measurements below were **not captured** during the source audit. The paired
physical iPhone was available earlier, but the manual matrix has not been
executed; an iOS simulator cannot prove CallKit/PushKit behavior. The final
source tips above are the merged release candidates, not the earlier pre-merge
test SHAs. Do not mark the real-device gate green until the matrix is rerun.

## Candidate build evidence

- The final merged iPhone 17 simulator candidate built, installed and launched
  successfully with `npx expo run:ios --device "iPhone 17" --no-bundler`.
- The final merged Debug `iphoneos` candidate built successfully with Xcode.
  A final reinstall was not completed because CoreDevice reported the paired
  iPhone as unavailable; the earlier pre-merge install is not counted as final
  evidence.
- These are compile/install checks only. No call, network-loss, camera-toggle
  or CallKit measurements are inferred from them; the physical matrix below
  remains pending.

## Deployment evidence

- The functional backend candidate is `3cb70df6e9bd3b20bb7ad4f74c3de8902086f012`;
  `master` and `homelab-deploy` both point to that source candidate.
- Homelab CI run `34814915926` and CD run `34815304302` passed, including the
  ARM64 `call-service` image build and promotion step.
- The server daemon fetched the candidate but did not restart containers:
  `deployed-sha` remains `b570a36abf62739c165ef32139006e39777a59f2` because the
  disk guard reports 14–15 GB free while requiring at least 20 GB.
- No production runtime result is attributed to the candidate until the disk
  guard is cleared and the call-service container reports the candidate SHA.

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
