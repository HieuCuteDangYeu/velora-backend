# Reel Qdrant local implementation report

2026-10-27. Local implementation scope complete; independent verification/review and every production phase remain separate gates.

Worktree: `/home/hieucutedangyeu/orca/workspaces/microservices-boilerplate/reel-qdrant-isolated`
Branch: `HieuCuteDangYeu/reel-qdrant-isolated`
Base/HEAD: `6e9ef1d9c6bc358661ab6666671b29441808a9e6`
Delivery: all changes unstaged, no commit, push, PR, deployment or production migration.

## Implemented

- A Reel Indexing-owned vector port, built-in-fetch REST adapter and deterministic generation-specific point IDs; no added dependency. Requests/responses, batches, candidate size, timeouts and snapshot archives are bounded. Ordinary access uses verified TLS and a service-specific API-key file.
- Additive SQL projection/task/collection/Reel state with idempotent operation identities, durable leases and continuations, same-attempt generation replacement, certification fences, persistent deletion tombstones and obsolete-generation replay. Physical collection identity and restore epochs invalidate readiness. PostgreSQL vectors, caches, checkpoints, transcripts and canonical metadata remain retained.
- Existing current-attempt check, activation, Content completion, compensation and finalization, including pending-projection continuation outside generic failure/discard handling. Job-only RMQ drain keeps query/delete RPC and durable projection running.
- PostgreSQL remains the default. Projection processing, publication enforcement and shadow comparison default off. Both vector sources reuse the SQL fusion query, RRF60, lexical/tag ordering and existing limits. Qdrant similarity maps to distance as `1 - score`, including negative similarity. Chronological, neighbor and document reads remain SQL-owned; RPC and consumer contracts are unchanged.
- Qdrant reads require publication enforcement and verified scoped active manifests. Complete SQL scope/identity/hash checks, exact tuple/point filters, batched hydration and post-read scope revalidation precede mapping results. Incomplete coverage, concurrent changes and transport/provenance failures select the complete scoped PostgreSQL path. Lexical-only searches do not contact Qdrant. Shadow comparison serves PostgreSQL results and records unavailable/incomplete cases separately.
- Pinned Qdrant v1.20.0 Compose profile plus explicit Indexing-only overlay, private internal network, service-only secrets/CA, named storage/snapshot volumes, TLS, resource limits and readiness probe. Explicit deployment-policy handlers/tests cover service/network/volume/secret/config classification and preserve existing worker/database safeguards. The launcher loads controller/core/policy from the same approved SHA.
- Immutable consistent-snapshot export, resumable idempotent import with current-generation checks, enrollment, reconcile, maintenance/resume, metrics and bounded encrypted snapshot backup/restore tools. A completed export is required for import; a partial export cannot resume under a new SQL snapshot. Only the leased live projector certifies readiness. Backup captures aliases/configuration/SQL provenance and requires separate off-host verification; restore holds maintenance until explicit replay.

The operator procedure, private-network/dependency setup, migration sequence and ordered rollback are in [README.md](README.md). The source API/configuration was checked against the [v1.20.0 OpenAPI](https://raw.githubusercontent.com/qdrant/qdrant/v1.20.0/docs/redoc/master/openapi.json), [pinned server configuration](https://github.com/qdrant/qdrant/blob/v1.20.0/config/config.yaml) and [official snapshot guidance](https://qdrant.tech/documentation/snapshots/).

## Verification evidence

The earlier implementation dispatch reached its usage limit before writing this report. Its retained logs below were inspected; the checks marked **fresh** were executed again during this handover. No broad suite was repeated merely to obtain a new timestamp.

| Check / command | Result and evidence |
| --- | --- |
| **Fresh:** `pnpm install --frozen-lockfile --ignore-scripts` | PASS; already up to date. Setup/postinstall hooks skipped. |
| **Fresh:** `pnpm exec prisma generate --schema=apps/reel-indexing-service/prisma/schema.prisma` | PASS; client v5.22.0 generated inside this worktree's own `node_modules`. |
| **Fresh:** recursive realpath/link-count audit of `node_modules` and `dist` | PASS; zero external symlinks and zero shared writable hardlinks. Internal pnpm links remain inside this worktree. |
| **Fresh:** `pnpm exec tsc --noEmit -p apps/reel-indexing-service/tsconfig.app.json` | PASS, exit 0. |
| **Fresh:** `pnpm exec prisma validate --schema=apps/reel-indexing-service/prisma/schema.prisma` | PASS using a dummy loopback URL; no database connection needed. |
| **Fresh:** `pnpm exec jest --runInBand --runTestsByPath apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts` | PASS, 1 suite / 13 tests, no skips; `/tmp/reel-qdrant-handover-integration.log`. |
| **Fresh:** `node --test scripts/ops/test-qdrant-ops.cjs` | PASS, 3 tests; encryption/tampering/wrong keys, strict arguments/fingerprints and owned-file rotation/path rejection. |
| **Fresh:** `pnpm exec eslint <all 19 changed or new TypeScript files> --format json` | PASS, 0 errors / 0 warnings; `/tmp/reel-qdrant-handover-eslint.json` contains the exact file list. No `--fix`. |
| **Fresh:** `bash scripts/deploy/test-qdrant-policy.sh` and `bash scripts/deploy/test-qdrant-launcher-bundle.sh` | PASS; bounded Compose policy and approved-SHA new/missing/legacy policy bundles. |
| **Fresh:** `bash -n scripts/deploy/velora-deploy scripts/deploy/velora-deploy-core scripts/deploy/velora-deploy-launcher scripts/deploy/velora-qdrant-policy scripts/ops/test-qdrant-local-tls.sh` | PASS. |
| **Fresh:** `git diff --check` | PASS; retained tracked diff has no whitespace errors. New-file whitespace checked separately during handover. |
| Recorded: focused Jest command below | PASS, 20 suites / **109 tests** according to the retained log, including real-Qdrant integration; `/tmp/reel-qdrant-final-jest-high.log`. The coordinator's earlier summary said 108; the actual log says 109. |
| Recorded: `pnpm exec prisma migrate deploy --schema=apps/reel-indexing-service/prisma/schema.prisma` | PASS, all 11 migrations applied to disposable local `qdrant_local_test` at `127.0.0.1:16473`; `/tmp/reel-qdrant-final-migration-high.log`. No production schema touched. |
| Recorded: baseline/current Prisma schema drift comparison | Existing drift is byte-identical: `cmp /tmp/reel-qdrant-baseline-drift.sql /tmp/reel-qdrant-current-drift.sql` freshly passed. Existing unsupported-vector/search defaults, indexes, legacy columns and index names were preserved; this is not a clean whole-schema diff claim. No new projection-table drift appears. |
| Recorded: every `scripts/deploy/test-*.sh` | PASS, including scoped env approval (73 checks), protected-stateful additions, infra scoping, image cleanup safety and RabbitMQ guardrails; `/tmp/reel-qdrant-final-deploy-high.log`. Fixture timeout/warning output is expected in negative-path tests. |
| Recorded: `bash scripts/ops/test-qdrant-local-tls.sh` | PASS; pinned v1.20.0 TLS/authentication/readiness, effective memory tier and named-volume persistence after recreation. Local x86_64 only. |

Recorded focused Jest command:

```sh
pnpm exec jest --runInBand \
  apps/reel-indexing-service/src \
  apps/ai-service/src/application/clean-architecture.spec.ts \
  apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts \
  apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts \
  apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts
```

Integration environment was supplied only from the two task-labelled disposable local containers, without dotenv, credential output or original-checkout access. The fresh command used `QDRANT_TEST_URL=http://127.0.0.1:16474` and `REEL_INDEXING_TEST_DATABASE_URL` at `127.0.0.1:16473/qdrant_local_test`, plus that disposable Qdrant key. The test requires loopback endpoints and creates random test identities/collections. Docker was explicitly addressed as `--host unix:///var/run/docker.sock`; observed daemon `msi-cua-tao`, Linux x86_64. Its Qdrant image digest matched the Compose pin `sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2`.

The real integration suite covers persisted legacy enrollment, readiness before activation, all four kinds, distance/RRF compatibility, scoped filtering/exclusion, lexical-only and full fallback, Content rejection compensation, same-attempt replacement, lease expiry and late upload, cross-instance serialization, acknowledgement loss/partial multi-batch replay, durable publication continuation, restore epoch invalidation, immutable export/import/checksums, encrypted snapshot restore, payload/concurrent SQL mutation fallback, and deletion/backfill/late-write tombstone cleanup. Backup destination tests use an explicit **local off-host simulation** (`offhostVerified=false`), not an actual remote backup.

### 2026-10-27 correction: optional integration startup

The independent verifier correctly found B1: `describe.skip` still registered the suite by constructing Prisma with an undefined datasource. Task `task_5c575730d2bc` moved temporary-directory/client/repository setup into `beforeAll`, after the unchanged loopback validation, and guarded teardown when validation rejects before initialization. All 13 cases and assertions remain; configured tests are still mandatory when both endpoints are supplied. The earlier failed [verification report](verification-report.md) is preserved unchanged as historical evidence; this correction resolves B1 only, without asserting the separate independent review gate passed.

Fresh commands/results (all exit 0 after two formatting corrections):

- The focused Jest command above, with `QDRANT_TEST_URL`, `QDRANT_TEST_KEY`, `REEL_INDEXING_TEST_DATABASE_URL`, `QDRANT_URL`, `QDRANT_API_KEY_FILE` and `REEL_INDEXING_DATABASE_URL` removed: **19 suites / 96 tests passed; 1 integration suite / 13 cases skipped** (`/tmp/reel-qdrant-fix-5c575730-default.log`).
- `pnpm exec jest --runInBand --runTestsByPath apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts`: **13 passed, no skips** (`/tmp/reel-qdrant-fix-5c575730-integration.log`); then the configured focused command above: **20 suites / 109 tests passed, no skips** (`/tmp/reel-qdrant-fix-5c575730-configured-focused.log`). Both used `QDRANT_TEST_URL=http://127.0.0.1:32777`, `QDRANT_TEST_KEY=local-disposable-test-key` and `REEL_INDEXING_TEST_DATABASE_URL=postgresql://qdrant_fix:disposable-fix-only@127.0.0.1:32776/qdrant_fix`.
- `pnpm exec eslint apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts` and `pnpm exec tsc --noEmit -p apps/reel-indexing-service/tsconfig.app.json`: **PASS**. Initial lint found only two formatting errors, corrected before the configured runs.
- `node /tmp/reel-qdrant-fix-5c575730-lifecycle-check.cjs`: **5 assertion checks passed** using stubbed resources: absent endpoints, either endpoint alone, and rejection of either non-loopback endpoint; all register 13 cases with zero resource initialization. Its initial verifier-harness attempt omitted the VM's standard `URL` global; supplying it corrected the harness without source changes.

Only `reel-qdrant-fix-5c575730-pg` and `reel-qdrant-fix-5c575730-qdrant` were created, using the existing local images and loopback-only published ports, with exact `velora.task=task_5c575730d2bc` and `velora.dispatch=ctx_134abd2cd850` labels. `REEL_INDEXING_DATABASE_URL` set to the disposable PostgreSQL URL plus `pnpm exec prisma migrate deploy --schema=apps/reel-indexing-service/prisma/schema.prisma` applied all 11 migrations solely to that fresh database. Both containers and PostgreSQL's anonymous volume were removed after ID/label/mount validation; no task-labelled container remains. No dependencies, build outputs, application/migration code, environment files, original checkout or benchmark artifacts/processes were changed; no SSH/provider/production/benchmark calls, staging, commits or pushes occurred. Unrelated passing checks were not repeated; production remains held for the unfinished benchmark.

## Runtime gates and limits

- **NOT_PROVEN:** native ARM64 homelab startup; host/VM backing-volume headroom; memory/OOM behavior under simultaneous indexing/TEI load; actual deployment, all-writer rollout and operational drain; production parity and rollback. Local adapter/recovery tests do not establish these.
- **NOT_PROVEN:** an independently restored full external indexing-database backup and true encrypted off-host access/retention/restore. The tool requires those operator proofs; no destination or schedule was provisioned.
- **NOT_PROVEN:** held-out quality, Recall@K, boundary tie behavior across a representative corpus, complete retrieval/end-to-end latency, resource targets or steady-state fallback rate. No benchmark/evaluator script, provider, judge or live RAG request ran. Exact vector ties may order differently; no performance or relevance improvement is claimed.
- The implementation deliberately falls back beyond its 20,000-point scoped/candidate bound or 4 MiB ordinary transport bound. Projection requests use batches of 128; snapshot and archive limits are 128 MiB and 180 MiB. The separate backup process buffers/encrypts archives and needs a measured memory allowance. Cleanup tasks retain generation history and tombstones; production retention sizing remains operational work.
- Independent verification and review are still pending with the coordinator. Publication must be enabled/verified everywhere before Qdrant reads; rollback switches/drains readers to PostgreSQL before disabling publication. SQL vectors remain populated throughout.
- Original specifications were read from the original absolute paths only. No source, environment, dependency, build, benchmark, artifact or process mutation was performed there. The updated benchmark-impact specification records `HALTED_PROVIDER_OR_EXECUTION` / `PRIMARY_BLOCKED` as of 13:08 UTC, with 16 completed / 384 pending; its live migration hold remains. This task did not repair, resume or restart it.

Task-owned cleanup is complete: after the fresh checks, only `velora-reel-qdrant-local-qdrant-high` and `velora-reel-qdrant-local-pg-851008` were removed, after rechecking their exact task labels and absence of mounts. No task-labelled containers remain. No volume/image pruning occurred. Subsequent independent integration checks must create their own disposable endpoints; worktree dependencies, generated client and verification logs remain available.

## Changed files

The complete unstaged file manifest follows; generated clients/build outputs and private credentials are excluded.

```text
.env.example
.gitignore
apps/reel-indexing-service/prisma/migrations/20261027100000_add_vector_projection/migration.sql
apps/reel-indexing-service/prisma/schema.prisma
apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.spec.ts
apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts
apps/reel-indexing-service/src/application/use-cases/process-reel-index-job.use-case.spec.ts
apps/reel-indexing-service/src/application/use-cases/process-reel-index-job.use-case.ts
apps/reel-indexing-service/src/domain/interfaces/reel-vector-store.interface.ts
apps/reel-indexing-service/src/domain/interfaces/semantic-candidate-lifecycle.interface.ts
apps/reel-indexing-service/src/domain/services/reel-vector-manifest.spec.ts
apps/reel-indexing-service/src/domain/services/reel-vector-manifest.ts
apps/reel-indexing-service/src/infrastructure/adapters/drainable-index-rmq.server.spec.ts
apps/reel-indexing-service/src/infrastructure/adapters/drainable-index-rmq.server.ts
apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter.spec.ts
apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter.ts
apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts
apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts
apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts
apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts
apps/reel-indexing-service/src/infrastructure/services/vector-projection-worker.service.ts
apps/reel-indexing-service/src/main.ts
apps/reel-indexing-service/src/reel-indexing-service.module.ts
docker-compose.qdrant.yml
docker-compose.yml
infra/monitoring/prometheus/rules/reel-vector.yml
infra/qdrant/README.md
infra/qdrant/config.yaml
infra/qdrant/entrypoint.sh
infra/qdrant/implementation-report.md
infra/qdrant/ready.sh
scripts/deploy/test-qdrant-launcher-bundle.sh
scripts/deploy/test-qdrant-policy.sh
scripts/deploy/velora-deploy
scripts/deploy/velora-deploy-core
scripts/deploy/velora-deploy-launcher
scripts/deploy/velora-qdrant-policy
scripts/ops/qdrant-backup.cjs
scripts/ops/reel-qdrant.cjs
scripts/ops/test-qdrant-local-tls.sh
scripts/ops/test-qdrant-ops.cjs
```
