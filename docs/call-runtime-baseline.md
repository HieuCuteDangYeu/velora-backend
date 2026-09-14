# Call runtime baseline and release gate

This document records the comparison point for the four call-runtime fixes. It
is intentionally explicit about measurements that were not captured; missing
device evidence must not be replaced with invented numbers.

## Comparison points

| Item | Baseline before this fix | Candidate after this fix |
| --- | --- | --- |
| Backend | `87688b2942c3383cffcc5929907b1a2e90210c81` | `11bd4341b61e0412b12c83507374792c0d97c122` |
| Mobile | `0e7722076857e3e79625afc376dfd57b1a1b1207` | `f6b0b1fa2f6409cca4c821e69071ff6169ef574d` |
| Captured at | 2026-09-14, Asia/Ho_Chi_Minh | 2026-09-14, Asia/Ho_Chi_Minh |

The baseline SHAs are immutable source references. The baseline runtime
measurements below were **not captured** during the source audit. The manual
matrix has not been executed; an iOS simulator cannot prove CallKit/PushKit
behavior. The final source tips above are the merged release candidates, not
the earlier pre-merge test SHAs. Do not mark the real-device gate green until
the matrix is rerun.

## Candidate build evidence

- The final merged iPhone 17 simulator candidate built, installed and launched
  successfully with `npx expo run:ios --device "iPhone 17" --no-bundler`.
- The final merged Debug `iphoneos` candidate built successfully with Xcode and
  was installed on the connected iPhone 12
  (`DA46320E-FC2F-5BF4-B97E-D2E485B6DDC3`). Launch was deferred because the
  device was locked; no call result is inferred from the install alone.
- These are compile/install checks only. No call, network-loss, camera-toggle
  or CallKit measurements are inferred from them; the physical matrix below
  remains pending.

## Deployment evidence

- The functional backend candidate is
  `11bd4341b61e0412b12c83507374792c0d97c122`. `homelab-deploy` is now the
  docs-only descendant `b5fa5821b67e1f5b7515a33a625b119427496d60`; its
  call-service image remains the functional candidate. `master` currently has
  the unrelated follow-up `dd9034538313842390c3652b87e9f02647a15e50` on top.
- Homelab CI run `34819110593` and CD run `34819572841` passed, including the
  ARM64 `call-service` image build and promotion step.
- The homelab deployment receipt
  `20260914T075755Z-11bd4341b61e-success.json` reports a successful transition
  from `46f70ea1d1c45e39c5d936fd267dadba4b595ba6` to the candidate in 72
  seconds. `deployed-sha` and the running call-service image now report the
  candidate; post-deploy root-disk headroom was 33 GB.
- Public Socket.IO handshake is healthy (`HTTP 200`, `pingInterval=25000`,
  `pingTimeout=20000`). The call-service `/metrics` endpoint exposes
  `velora_call_socket_disconnects_total`, `velora_call_socket_reconnects_total`
  and `velora_call_socket_reconnect_duration_seconds_{sum,count,max}`.

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
pnpm exec jest --runInBand apps/call-service/test
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
