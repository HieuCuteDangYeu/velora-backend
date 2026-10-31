# Independent Qdrant source review

2026-10-27. Task `task_3192a0443c2b`, dispatch `ctx_d35c8e279eaf`.
HEAD `6e9ef1d9c6bc358661ab6666671b29441808a9e6`; unstaged implementation in the isolated worktree.

**Single verdict: LOCAL BLOCK.** Required activation/crash compensation is incomplete. Passing local verification does not resolve this source defect or authorize deployment, migration, benchmark resumption, or read cutover.

What this change does: adds a durable, generation-fenced Qdrant projection beside authoritative PostgreSQL semantic data. Reads retain SQL authorization, hybrid fusion and full PostgreSQL fallback, with explicit infrastructure and recovery tooling.

## Must fix

**B1 — Recover the previous accepted activation before clearing or replaying a continuation.**

Locations:

- `apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts:40-65,68-101`.
- `apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts:52-99,119-130,243-255`.
- `apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts:305-320,334-349,524-530`.

Concrete trigger: candidate A is accepted and active; candidate B is persisted, projected and durably deferred. B's SQL activation commits, deactivating A, then the process stops before Content completion. The continuation records job/completion/generation but no previous activation identity; `previousIndexAttemptId` exists only in the lost activation return value.

On restart there are two broken paths:

1. Content has superseded B. The resumed current-attempt check returns false; `isCandidateActive` returns true, but Content completion returns false. The stale branch invokes `discardCandidate`, which explicitly does nothing for an active candidate, then clears the continuation. B remains active indefinitely and A remains inactive, without Content accepting B.
2. B remains current at the initial check. Replay activates B again; the previous-active query excludes B and finds nothing because A is already inactive. If Content subsequently rejects completion or its RPC fails, rollback deactivates B and returns without restoring A. Both the SQL and Qdrant search paths then have no active candidate. Rejection can occur when Content changes attempts between the guard and completion; RPC failure alone also reproduces the loss.

The same repeated-activation window is reachable without a crash: `defer` publishes an immediately eligible continuation while the foreground commit still runs, and only the background claimant takes a continuation lease. The fix must account for foreground/background ownership as well as restart, while preserving the existing newer-winner generation/attempt fence.

Smallest required correction: persist the previous accepted candidate and activation phase atomically with SQL activation, then use that durable identity when recovering/rejecting an already-active generation. Do not clear its continuation until acceptance or fenced compensation has completed; prevent simultaneous publication owners from independently reactivating/compensating the same generation. No application fix was made by this reviewer.

Fresh local reproduction: `node -r ts-node/register/transpile-only -r tsconfig-paths/register` with a here-document importing the actual `PrismaSemanticCandidateLifecycle` and `CommitSemanticCandidateUseCase`. Only SQL transaction methods and Content/publication ports were in-memory doubles; no database, network, provider, dependency installation or application edit occurred. Each scenario activated B through the actual lifecycle, discarded the in-memory activation result to represent the crash, then replayed the actual commit use case. Assertions passed and printed:

```json
{"current":false,"completion":"reject","result":"STALE","active":["new"],"continuationCleared":true,"previousAccepted":"old"}
{"current":true,"completion":"reject","result":"STALE","active":[],"continuationCleared":false,"previousAccepted":"old"}
{"current":true,"completion":"error","result":"Content RPC unavailable","active":[],"continuationCleared":false,"previousAccepted":"old"}
```

Test gap: `commit-semantic-candidate.use-case.spec.ts:105-138` covers a crash **after Content accepts**, with a mocked lifecycle. The real integration case at `qdrant-reel-vector-store.integration.spec.ts:478-519` resumes a candidate before activation and completes successfully. The rejection case at `:328-362` does one uninterrupted activation. None tests crash/replay between activation and Content acceptance, or overlapping foreground/background commits. Add assertions that A remains active after rejection/error/staleness and that an accepted newer winner survives older compensation.

## Other reviewed paths and boundaries

- Candidate persistence captures generation/manifest/task atomically under the per-Reel lock; same-attempt replacement advances generation. Leased writes certify current SQL manifests only after full payload/vector verification. Generation-specific IDs and exact-tuple deletion keep late obsolete uploads from overwriting or deleting current points; retained tombstones and periodic cleanup handle unreachable orphans.
- Qdrant reads preserve authorized SQL filters, exact tuple/point scope, all-branch model/version/dimension predicates, complete SQL scope revalidation, batched SQL evidence hydration and whole-request SQL fallback. Lexical-only and chronological/neighbor/document reads remain SQL-owned. Shared SQL fusion preserves RRF60, branch limits, tag/keyword ranking and absent-branch fields; distance is `1 - similarity`, including negative similarity. Vector boundary ties remain explicitly unproven against a representative exact SQL reference.
- Maintenance, collection identity and SQL restore epochs invalidate certificates; managed restore leaves maintenance held until explicit resume/reconciliation. Immutable export uses one read-only repeatable-read snapshot; imports check artifacts and current generations and cannot certify readiness themselves. Backup encryption, bounded archives, separate destination/readback and owned rotation are implemented; a complete owner-PostgreSQL restore and genuine off-host destination remain separate proof requirements.
- PostgreSQL and disabled projection/publication/shadow defaults remain; Compose profile/overlay, Indexing-only secret injection, private network, pinned image, resource policy, approved-SHA controller bundle and deployment gates were traced. Controlled cutover/rollback is manual and ordered. Job drain has a local unit check, not real RabbitMQ/process proof. No additional concrete blocker was established in these paths.

**All-writer rollout caveat:** the unchanged `scripts/narto-scraper/sync.cjs:76-81,365-500` is an actual direct SQL writer, invoked by normal ingestion at `:782` and `--index-queued` at `:840`. It directly deletes/inserts active Reel/Chunk rows without projection capture or the per-Reel lock and marks Content completed at `:503-520`. A new/unmatched attempt fails the readiness join and takes complete PostgreSQL fallback; this is not evidence of an ACL leak. Before phase 4 or publication cutover, explicitly include this writer in capture or enforce its exclusion/drain for the migration window. The two service lanes alone do not establish all-writer coverage; no scraper was run or changed.

## Evidence and remaining proof

- Read-only specifications: original-root `docs/reel-qdrant-migration-plan.md` and `docs/reel-qdrant-benchmark-impact.md`. Reviewed changed execution paths, current callers, original lifecycle/fusion analogs, implementation report, and both independent verification reports. The recheck supersedes historical B1 default-suite failure only.
- Fresh integrity command: parsed the first JSON manifest in `infra/qdrant/verification-recheck-report.md`, recomputed every SHA-256 and asserted no mismatch: **42 files checked, zero changed since verification**.
- Retained verification evidence: recheck reports **20 suites / 109 tests**, including 13 real local integration cases, and default invocation **19 suites / 96 tests**, with only the opt-in 13 cases skipped. Prior lint/typecheck/migration/preservation/Compose/TLS/deployment/ops checks are retained evidence, not reruns by this reviewer. No broad tests were repeated because they do not exercise B1's missing schedule.
- Still required after B1: focused recovery/concurrency tests and independent re-review; real broker/process crash/drain and simultaneous-lane behavior; native ARM64, disk and overlapping-load memory; deployed monitoring/backup scheduling, full SQL restore and true encrypted off-host recovery; corpus parity with full-scan SQL reference and boundary ties; held-out quality/latency/fallback denominators; all-writer ordered cutover/rollback and 14-/30-day observation/retention.
- The original benchmark hold remains in force. Its latest specification checkpoint says `HALTED_PROVIDER_OR_EXECUTION` / `PRIMARY_BLOCKED`, 16 completed and 384 pending. This review did not independently refresh benchmark state and made no provider, benchmark, SSH, remote or production-DB calls.

Only this report was created. Application/config/tests, original checkout, dependencies, builds and runtime resources were not changed; no commit, push or merge occurred.

Not checked: production runtime/deployment/corpus performance; existing verification was retained rather than broadly repeated. Risk: B1 can leave an unaccepted candidate active or remove all active evidence after recovery.
