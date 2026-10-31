# Independent Qdrant source re-review

2026-10-28. Task `task_3192a0443c2b`, dispatch `ctx_9408c70f5fa5`; HEAD `6e9ef1d9c6bc358661ab6666671b29441808a9e6`. Local, unstaged implementation. Historical reports are preserved.

**Single verdict: LOCAL PASS.** The activation-recovery B1 in `source-review-report.md` is resolved in the current source. No additional concrete local-readiness blocker was established. This supersedes that source verdict for the reviewed implementation; it does not release the benchmark hold or authorize deployment, schema application, backfill, reindexing or read cutover.

What this change does: projects SQL-owned semantic vectors into Qdrant using durable generation-scoped work and publication recovery. PostgreSQL retains evidence, authorization, hybrid fusion and complete fallback; Qdrant remains an explicit opt-in.

## Source evidence for B1 closure

| Requirement / concrete schedule | Current source and assertions reviewed |
| --- | --- |
| A accepted; B activates; process loses activation return value before Content outcome | `prisma-semantic-candidate-lifecycle.ts:44-149` persists predecessor attempt/generation and ACTIVATED phase in the same per-Reel transaction as all four active-row changes. Re-entry at `:67-82` retains the predecessor. Migration adds journal fields without changing old tables. |
| Restart, current=false or true, Content rejects B | `commit-semantic-candidate.use-case.ts:53-77` compensates before discard. Lifecycle `:158-249` reads the durable predecessor, restores A transactionally and refuses to compensate a finalized generation or a different active winner. Integration `qdrant-reel-vector-store.integration.spec.ts:602-676` loses the activation result, expires the lease, uses fresh clients/workers, and asserts A alone active in all four tables, B removed and A points intact. |
| RPC error / lost acknowledgement; later idempotent acceptance | Commit `:84-120` retains recovery after compensation instead of entering generic discard/failure. Lifecycle `:334-367` protects unresolved continuation data; projection repository `:85-107` prevents replacement of active or recovery-dependent evidence. Integration `:678-767` asserts retained COMPENSATED continuation, restored A, eventual accepted B and FINALIZED cleanup. Actual Content `content.repository.ts:1099-1184` accepts repeated COMPLETED/DEGRADED completion, matching the test doubles. |
| Foreground/background overlap; expired owner returns late | Projection repository `:300-389,392-455,650-674` shares a durable per-Reel lease across foreground and background publication. Mutation ownership checks use generation/token and database-time expiry. Lifecycle checks ownership under its lock before activation/rollback/finalize/discard. Integration `:769-814` asserts no concurrent completion while owned and preserves the finalized winner after the former owner rejects late. |
| Newer attempt or same-attempt generation wins | Lifecycle `:47-82,168-187,379-415` and projection completion `:427-455` fence obsolete callbacks. Integration `:816-872` checks old activation/rollback/finalize/discard/completion paths cannot alter the newer accepted evidence. |
| SQL recovery while Qdrant processing is disabled | Worker `vector-projection-worker.service.ts:31-69` gates projection work but continues claiming publication recovery. Integration `:874-896` restores A then accepts B with both flags false and no store identity call. |

Paths above are relative to `apps/reel-indexing-service/src/infrastructure/repositories/` for repository classes, `src/application/use-cases/` for commit, `src/infrastructure/adapters/` for integration, and `apps/content-service/src/infrastructure/repositories/` for Content. Content RPCs remain outside SQL transactions. SQL activation remains provisional until Content responds, as in the approved guarded protocol; this is not atomic cross-service acceptance.

Finalization and continuation clearing remain separate recoverable steps: lifecycle `:252-331` marks FINALIZED under the lock; projection `:427-455` clears only an owned FINALIZED generation. Rejection clears only through fenced compensation/discard/revocation. A failure before either terminal step retains retryable work; release failure relies on persisted lease expiry.

## Preserved paths and plan coverage

- Generation allocation, manifest capture and UPSERT task share semantic persistence's transaction/lock (`prisma-semantic-index.repository.ts:112-171`; projection repository `:110-140`). Lease checks and full projection verification precede readiness (`:479-623`). Same-attempt point IDs separate generations; cleanup uses exact obsolete tuples, with retained deletion state and repeated cleanup for late uploads (`:147-203,638-648`). Restore maintenance and epochs invalidate readiness before reuse (`:205-284`).
- Search `prisma-semantic-index.repository.ts:378-850` preserves empty-scope refusal, SQL filters, exact tuple/point constraints, batch SQL hydration, complete scoped SQL revalidation and full PostgreSQL fallback. SQL alone handles lexical-only, chronological, adjacent and document reads. Shared SQL fusion retains RRF60, branch identity predicates, limit fallback rules, absent-branch fields and lexical/tag/final tie ordering. Qdrant distance remains `1 - similarity`, including negative similarity. Representative vector boundary tie parity remains a later proof requirement.
- Adapter `qdrant-reel-vector-store.adapter.ts:113-273,286-365` checks physical identity, full certification point coverage/payloads/normalized vectors, response shape, deadlines and verified transport. Managed restores invalidate readiness before upload. Import rechecks live generations before/after upload and cannot certify readiness itself; export remains an immutable read-only repeatable-read snapshot.
- PostgreSQL/disabled-feature defaults, unchanged public RPC/consumer contracts, additive schema, pinned private TLS/secret/volume wiring, approved-SHA deployment tooling, backup encryption/retention and ordered operator cutover/rollback remain covered by the prior source review and unchanged verification evidence. Connected current code and original lifecycle/fusion analogs were read; no new blocker was established there.
- `infra/qdrant/README.md:47-65` now inventories all writers and requires enforced credential/network exclusion and drain of both Narto scraper entry paths. Shared credentials explicitly block cutover until separated or rotated. The scraper remains unchanged; its actual production exclusion is not proven by this runbook or by local source acceptance.

## Verification evidence and limits

Read-only specifications: original-root `docs/reel-qdrant-migration-plan.md` and `docs/reel-qdrant-benchmark-impact.md`. Coordinator message `msg_ebc7675fd8be` confirmed the later recovery-verification prerequisite passed and requested this bounded source retry.

Fresh checks in this review:

- Python SHA-256 continuity check: parsed the recheck JSON manifest, overlaid the recovery-verification file/report fingerprint tables and recomputed **45 files; zero mismatches**. This binds retained verification to current source.
- `git diff --check`: exit 0. Report whitespace and unchanged-file continuity were checked again before completion.
- Read-only source/caller/diff inspection, including original `HEAD` lifecycle behavior, current Content completion contract and integration assertions. No application test, migration, dependency install or build was rerun by this reviewer.

Retained independent evidence: `recovery-verification-report.md` records **32 focused tests**, **122 configured tests across 20 suites without skips**, **101 default tests with only 21 opt-in integration cases skipped**, service typecheck, scoped lint, Prisma validation, all 11 migrations on disposable PostgreSQL and preservation of all 13 original tables. Earlier unchanged deployment/TLS/ops/Compose/consumer proof remains retained evidence, not a fresh execution here. Tests use real local SQL/Qdrant state with controlled lease expiry and Content doubles; they do not prove real process kills, broker redelivery or deployed Content behavior.

Remaining runtime/deployment gates: real broker/process crash and job-only drain; simultaneous deployed lanes and all-writer exclusion; native ARM64, host/VM disk and overlapping-load memory/OOM; deployed monitoring/backup scheduling; compatible full owner-PostgreSQL restore and genuine encrypted off-host recovery; representative corpus parity against full-scan SQL including boundary ties, held-out quality, latency and backend/fallback denominators; ordered all-reader/all-writer cutover/rollback; 14-day observation and at least 30-day SQL-vector retention.

The benchmark-impact specification's latest checkpoint is 2026-10-28 04:50 UTC: 30 complete / 370 pending, waiting for 2026-10-29 00:01:30 UTC; post-primary WAITING_FOR_PRIMARY, live NOT_RUN. This review did not refresh benchmark state. Its hold remains in force until deliberately resolved and evidence preserved.

Only this report was created. No application/config/test/original-checkout changes, new workers, provider/benchmark/SSH/remote/production database calls, commits, pushes or merges occurred.

Not checked: deferred runtime/deployment/corpus gates; broad tests were retained with fingerprint continuity rather than repeated. Risk: LOCAL PASS establishes source readiness only; migration, benchmark completion and production acceptance remain held.
