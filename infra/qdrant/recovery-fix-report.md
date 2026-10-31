# Qdrant B1 activation recovery fix

2026-10-28. Task `task_ad570f6a94ce`, finishing dispatch `ctx_3775f2fdd4b4`; Orca verified effective `gpt-6.1-sol` / `high`. HEAD remains `6e9ef1d9c6bc358661ab6666671b29441808a9e6`. Changes remain local and unstaged.

**Local implementation and required checks complete; independent verification and source re-review remain pending.** This report addresses the activation/ownership B1 in `source-review-report.md`, distinct from the historical optional-integration startup B1. The predecessor's recovery implementation/tests/runbook were preserved and completed; this dispatch corrected remaining lint findings and reran acceptance. All four previous implementation/verification/source-review reports remain byte-identical.

## Correction and files

- `prisma/schema.prisma` and the existing, undeployed `20261027100000_add_vector_projection/migration.sql`: add previous attempt/generation and STAGED/ACTIVATED/COMPENSATED/FINALIZED publication phase to the existing durable projection journal. Activation records its predecessor and phase in the same transaction as all four SQL active-row changes, under the existing per-Reel advisory lock. Re-entry retains the original predecessor; compensation restores it transactionally. No Content SQL or network RPC occurs inside these transactions.
- `prisma-semantic-candidate-lifecycle.ts`: journal-aware activation, rollback, finalization and discard, with generation and publication-token checks. Active/recovered rejected candidates are compensated before discard; generic failure cleanup cannot erase an unresolved continuation. Previous accepted evidence and projection points remain until acceptance/finalization. A later accepted generation survives stale activation, finalization, rollback and discard, including same-attempt generations.
- `prisma-vector-projection.repository.ts`, `reel-vector-store.interface.ts`, `semantic-candidate-lifecycle.interface.ts`, `commit-semantic-candidate.use-case.ts` and `vector-projection-worker.service.ts`: foreground and restarted/background publishers acquire the same durable, per-Reel SQL lease. Every publication mutation checks generation/token/expiry; no module-local lock substitutes for ownership. Rejected compensation/discard clears recovery transactionally; accepted continuation clears only after FINALIZED. RPC errors compensate while retaining recoverable SQL continuation. Workers recover SQL publication even with Qdrant processing disabled; the existing module's shared port bindings suffice.
- `prisma-semantic-index.repository.ts`: prevent same-attempt retries from replacing active accepted evidence or evidence needed by an unresolved publication. Existing vectors, metadata, transcripts, caches and checkpoints remain SQL-owned.
- `commit-semantic-candidate.use-case.spec.ts` and `qdrant-reel-vector-store.integration.spec.ts`: five additional unit assertions and eight real PostgreSQL/Qdrant cases, retaining all prior cases. Fresh Prisma/repository/worker instances inspect persisted rows in all four evidence tables. Cases cover post-activation crash with current=false/reject and current=true/reject, RPC failure/compensation with durable recovery, idempotent accepted-Content recovery, overlapping publishers and expired same-generation callbacks, a newer accepted attempt, same-attempt replacement fences, and disabled-Qdrant SQL recovery. Content doubles reproduce its actual existing contract: COMPLETED/DEGRADED completion is idempotently true while the current-attempt guard is PROCESSING-only. No Content contract change was needed.
- `infra/qdrant/README.md`: explicit all-writer inventory and enforced exclusion of both normal and `--index-queued` Narto scraper entry paths. Requires draining schedules/processes and excluding the SQL credential/network identity, with an explicit BLOCK for shared credentials until separation/rotation. No scraper refactor or production exclusion was performed; unmatched attempts retain complete authorized PostgreSQL fallback.

PostgreSQL remains the default. Qdrant projection/publication/shadow defaults, SQL fallback, public RPC/ranking/filter contracts, TLS/secrets/resources/deployment controls and all ten earlier migrations are unchanged. No dependencies were added.

## Fresh verification

All commands below exited 0 in this finishing dispatch after the noted harness/lint corrections. Local fixture endpoints were `127.0.0.1:32780` (PostgreSQL) and `http://127.0.0.1:32781` (Qdrant); only disposable credentials were supplied privately, without dotenv or original-root environment access. PostgreSQL fresh database: `recovery_sol_3775`. Exact image digest: `qdrant/qdrant@sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2`.

| Command/check | Result |
| --- | --- |
| `pnpm exec prisma migrate deploy --schema=apps/reel-indexing-service/prisma/schema.prisma` | All 11 migrations applied to a fresh disposable DB; `/tmp/reel-qdrant-recovery-sol-migrate.log`. |
| `pnpm exec jest --runInBand --runTestsByPath apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.spec.ts` | 11/11 passed; predecessor's mock-related failure no longer reproduces. |
| `pnpm exec jest --runInBand --runTestsByPath apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.spec.ts apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts` | 2 suites / 32 tests passed, no skips; `/tmp/reel-qdrant-recovery-sol-recovery.log`. |
| Configured full scoped command below | 20 suites / 122 tests passed, no skips; original 109 plus 13 new tests; `/tmp/reel-qdrant-recovery-sol-configured.log`. |
| Same scoped command with `QDRANT_TEST_URL`, `QDRANT_TEST_KEY`, `REEL_INDEXING_TEST_DATABASE_URL`, `QDRANT_URL`, `QDRANT_API_KEY_FILE`, `REEL_INDEXING_DATABASE_URL` removed | 19 suites / 101 tests passed; only the opt-in suite's 21 cases skipped; `/tmp/reel-qdrant-recovery-sol-default.log`. |
| `pnpm exec tsc --noEmit -p apps/reel-indexing-service/tsconfig.app.json` | PASS; `/tmp/reel-qdrant-recovery-sol-typecheck.log`. |
| `pnpm exec prisma validate --schema=apps/reel-indexing-service/prisma/schema.prisma` | PASS; `/tmp/reel-qdrant-recovery-sol-validate.log`. |
| Scoped ESLint command below, without fixes | PASS, zero errors/warnings. Initial five lint findings were corrected before acceptance. |
| `python3 /tmp/reel-qdrant-recovery-sol-schema.py` | Fresh baseline-ten plus draft-additive migration proof; all 13 original table schema/data dumps identical after removing only randomized pg_dump restrict/unrestrict nonce lines. Seeded transcript, embedding cache and LangGraph checkpoint retained; journal/lease fields, STAGED default and invalid-phase constraint verified. Canonical dump SHA256 `9c4a493bf37dd929ee2f147e1904ad4a456af49d571681f617bc10ed977a7ecb`; `/tmp/reel-qdrant-recovery-sol-schema.log`. |
| `git diff --check`; `git diff --exit-code -- apps/content-service/src scripts/narto-scraper/sync.cjs libs/common/src/processing/interfaces/semantic-index.interface.ts`; hash comparisons | PASS; unchanged Content/scraper/RPC files, ten prior migrations and four prior reports. |

```sh
pnpm exec jest --runInBand \
  apps/reel-indexing-service/src \
  apps/ai-service/src/application/clean-architecture.spec.ts \
  apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts \
  apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts \
  apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts

pnpm exec eslint \
  apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts \
  apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.spec.ts \
  apps/reel-indexing-service/src/domain/interfaces/reel-vector-store.interface.ts \
  apps/reel-indexing-service/src/domain/interfaces/semantic-candidate-lifecycle.interface.ts \
  apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts \
  apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts \
  apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts \
  apps/reel-indexing-service/src/infrastructure/services/vector-projection-worker.service.ts \
  apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts
```

Verification harness corrections: `python` was unavailable, so scripts ran using `python3`; the first original-table dump comparison rejected pg_dump's randomized restrict nonce, then the corrected fresh-database proof excluded only those two nonce lines and passed. These were local harness issues, not application-test failures. Expected RPC/SQL/provider-error strings in passing unit output are negative-path doubles, not provider calls. The earlier predecessor log's 31/32 result is historical; the fresh 32/32 and 122/122 results above supersede it.

## Isolation and remaining gates

The two original absolute planning/benchmark-impact documents were read as specifications. No original environment, dependencies, generated clients, dist, benchmark artifacts or processes were changed; no SSH, provider/judge/RAG/benchmark requests, production SQL/container/deployment/backfill/reindex, staging, commit or push occurred. No new workers were launched. Existing local dependency-root isolation was retained; no install or build ran here.

Tests adopted only predecessor task-owned containers `reel-qdrant-recovery-bfa-pg` (`b2af7e99c9b3`) and `reel-qdrant-recovery-bfa-qdrant` (`b2e93c20e9e7`), after exact IDs, task/dispatch labels, loopback ports and local `unix:///var/run/docker.sock` checks on Linux x86_64 host `msi-cua-tao`. Both were removed by verified exact ID after testing; their anonymous volume was removed, no task-labelled containers remain, and the private temporary environment was deleted. No unrelated container/volume was modified.

The benchmark hold remains. The coordinator supplied a newer 2026-10-28 04:50 UTC checkpoint: WAITING_FOR_UTC_RESET, 30 completed / 370 pending / zero in flight, next 2026-10-29 00:01:30 UTC; post-primary WAITING_FOR_PRIMARY, live NOT_RUN. This supersedes the older HALTED/16 checkpoint in the read-only specification; this dispatch did not refresh, resume or repair the benchmark.

Not checked: independent verification/source acceptance, real RabbitMQ/process-kill delivery/drain, production all-writer exclusion/cutover, native ARM64 and disk/overlap/OOM, deployed monitoring/backup scheduling, full owner-SQL restore and genuine encrypted off-host recovery, corpus tie/parity/quality/performance/fallback gates and 14-/30-day observation/retention. Earlier successful TLS/deployment/ops/consumer checks are retained evidence, not broadly repeated here; local crash schedules use real persisted SQL/Qdrant state with controlled lease expiry and Content-port responses, not a real broker or Content deployment.
