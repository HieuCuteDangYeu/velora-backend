# Independent durable-publication recovery verification

2026-10-28. Task `task_7e9eeff4bf46`, dispatch `ctx_3d492ac43b8d`, HEAD `6e9ef1d9c6bc358661ab6666671b29441808a9e6`.

**LOCAL PASS** for the requested independent B1 recovery-verification gate. The source-review retry may proceed; source acceptance and production/cutover gates remain separate. Orca's requested and effective launch are both `gpt-6.1-sol` / `high`; prerequisite `task_ad570f6a94ce` succeeded in `ctx_3775f2fdd4b4` before this verification. Read `source-review-report.md` B1, `recovery-fix-report.md`, and the concise prior recheck/manifest; historical reports are preserved.

Only this repository report was created. All 1,786 frozen tracked/untracked source/report files remained byte-identical during verification. Temporary harnesses/logs are under `/tmp/recovery-verification-7e9eeff4/`. No app/test/config changes, child workers, staging, commits, pushes, SSH, production/remote/provider/judge/benchmark requests, deployment, reindex or original-root environment/dependency/build execution occurred. SQL migrations below ran only on disposable loopback PostgreSQL.

## Fresh crash schedules and persisted evidence

The real integration suite creates fresh Prisma clients, projection/lifecycle repositories, commit use cases and workers. It first accepts A, persists/projects B, defers B with the SQL publication lease, commits B activation, reads the persisted `previousIndexAttemptId=A`, `previousGeneration=A.generation`, `publicationPhase=ACTIVATED`, discards the activation return value and expires the lease in SQL. Content-port doubles reproduce the unchanged PROCESSING-only current guard and idempotent accepted COMPLETED/DEGRADED completion contract; no real broker/Content deployment was used.

| Schedule, after durable activation and before Content outcome | Fresh-worker evidence/result |
| --- | --- |
| Current=false, completion rejects | A alone active in all four SQL evidence tables; A's Qdrant points verify; scoped search returns one result; B removed; B journal COMPENSATED/revoked, continuation/token cleared only after compensation/discard. |
| Current=true, completion rejects | Same restoration and persisted cleanup as above; repeated activation retains durable predecessor. |
| Current=true, completion RPC throws | A alone active in all four tables and scoped search; B journal COMPENSATED, not revoked, retains predecessor/generation and non-null continuation, releases token. Generic discard and same-attempt persistence cannot erase recovery. A further fresh worker receives idempotent acceptance, restores B, FINALIZED and clears continuation. |
| B accepted, failure before finalization, restart | New worker sees current=false, rechecks idempotent completion, retains B alone active, FINALIZED and clears continuation; complete called twice. |
| Foreground paused in Content RPC; background and third instance race | Background worker makes no completion RPC; direct concurrent commit is pending; both concurrent continuation claims fail while the foreground SQL lease is valid. |
| Expired foreground lease; background accepts B; old callback rejects late | B remains sole active winner; former owner gets pending, cannot compensate or clear finalized generation. |
| Newer accepted attempt C, old B activation/rollback/finalize/discard/callback late | C remains sole active evidence; B commit is superseded. |
| Newer generation of same attempt accepted; stale generation/token returns | New generation stays FINALIZED, non-revoked, sole active; old complete is pending and lifecycle callbacks cannot change winner. |
| Qdrant processing/publication disabled during recovery | Fresh SQL worker restores A on error, then B on acceptance; store identity is not called. PostgreSQL fallback remains available. |

These schedules passed twice: the focused 32-test invocation and the full configured 122-test invocation. All 21 real integration cases remained enabled/configured and passed, including unrelated existing projection/read/filter/fallback/restore/import/delete cases. No terminal rejection/error schedule leaves an unaccepted B active; unresolved RPC continuations remain durable. Activation is necessarily provisional between SQL commit and Content response, as in the existing guarded protocol.

Source checks corroborate the runtime evidence: predecessor/phase and all four active flags share the per-Reel advisory-lock transaction; publication ownership is a persisted token/generation/expiry checked with PostgreSQL time; foreground/background share that lease. The worker's `busy` flag only suppresses local redundant ticks. Content RPCs occur after repository transactions return, with no SQL transaction/advisory lock spanning RPC. Cleanup only completes FINALIZED owned generations; failed compensation cannot authorize continuation clearing. Newer accepted evidence and same-attempt retries are fenced. Public RPC/filter/ranking/consumer contracts, complete SQL fallback and PostgreSQL/disabled-feature defaults are unchanged.

## Commands and results

All commands executed from the isolated worktree with inherited target variables removed; configured tests used only disposable `127.0.0.1:32782/recovery_verify` and `http://127.0.0.1:32783`. No dotenv file existed in this worktree or was loaded.

```sh
pnpm exec prisma migrate deploy --schema=apps/reel-indexing-service/prisma/schema.prisma
```

```sh
pnpm exec jest --runInBand --runTestsByPath apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.spec.ts apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts --verbose
```

```sh
pnpm exec jest --runInBand apps/reel-indexing-service/src apps/ai-service/src/application/clean-architecture.spec.ts apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts
```

```sh
pnpm exec tsc --noEmit --incremental false -p apps/reel-indexing-service/tsconfig.app.json
```

```sh
pnpm exec eslint apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.spec.ts apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts apps/reel-indexing-service/src/domain/interfaces/reel-vector-store.interface.ts apps/reel-indexing-service/src/domain/interfaces/semantic-candidate-lifecycle.interface.ts apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts apps/reel-indexing-service/src/infrastructure/services/vector-projection-worker.service.ts
```

```sh
pnpm exec prisma validate --schema=apps/reel-indexing-service/prisma/schema.prisma
```

Results: migration exit 0, all 11 migrations applied fresh; recovery exit 0, 2 suites / 32 tests; configured exit 0, 20 suites / 122 tests without skips; typecheck/lint/Prisma validation exit 0, no lint errors/warnings. `default` repeated the identical configured Jest command with all DATABASE/QDRANT/INDEX_VECTOR variables removed: exit 0, 19 suites / 101 passed, only the opt-in 21 cases skipped. Negative-path RPC/provider/SQL log messages are test doubles, not external calls.

`python3 /tmp/recovery-verification-7e9eeff4/schema.py` exited 0: ten old migrations on a fresh additional database, seeded transcript/cache/checkpoint, then the additive draft. All 13 original table schema/data dumps are identical after removing only pg_dump's randomized restrict/unrestrict lines; canonical before/after SHA256 `ea86b721392cfdb3c97747c505d393b1576288021820c25e6ce580f403fcf0b2`. Journal/predecessor/lease fields, STAGED default and invalid-phase rejection passed. Ten old migration files remain identical to HEAD; sorted path/hash manifest SHA256 `b78870c33c0e0e814b6dc07fec346fce531479b80ec948b5c5b988bdfe9c12f2`.

An additional advisory `prisma migrate diff --from-url <disposable-db> --to-schema-datamodel <schema> --exit-code` returned 2 for preexisting old-table drift (legacy indexes/defaults/sourceVisualArtifactIds). `python3 /tmp/recovery-verification-7e9eeff4/baseline-drift.py` exited 0 and proved the entire diff byte-identical to a separate ten-migration database versus untouched HEAD schema. No new projection/journal drift; no unrelated repair. Exact argv are in the corresponding `.command.json` files. `git diff --check` and `git diff --exit-code` for Content, Narto scraper, shared RPC, semantic port/controller and consumer contracts passed.

## Retained proof and fingerprints

Recomputed the prior recheck's 42-file manifest: 30 unchanged; the only 12 changes are the expected recovery schema/lifecycle/ownership/tests and all-writer runbook below. Unaffected Compose/resource/secret/TLS/deployment/ops/backup/transport/fusion files match prior verified bytes, so prior verification proof is reused with this continuity boundary rather than broadly rerun. Changes to recovery behavior were freshly verified above. All four historical reports and the fix report retain their pre-verification hashes.

| Recovery file (relative to repository) | Current SHA256 |
| --- | --- |
| `apps/reel-indexing-service/prisma/migrations/20261027100000_add_vector_projection/migration.sql` | `fb389c24cf1051b24d0143095c4365eaf3a30f85c34afe6f90d1d63f49525a24` |
| `apps/reel-indexing-service/prisma/schema.prisma` | `cf089e5a2794015bfecd8ab6e578abf90697dd954f6cf588d2a8d5f0e4f74111` |
| `apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.spec.ts` | `75e93cab010559b495167efa8afe016a2e7d0e2d7fe23259e46d85a0034f3117` |
| `apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts` | `39b2a0584e8f8e71f37cd72a26379d61e4e9e00eac5252e9918817c1bc4bbe2e` |
| `apps/reel-indexing-service/src/domain/interfaces/reel-vector-store.interface.ts` | `3235796dd70587a477ae9e3e94ad21f87fff44c9465de279e8c09c264e2a2c82` |
| `apps/reel-indexing-service/src/domain/interfaces/semantic-candidate-lifecycle.interface.ts` | `e3ec583d982470cc193f6100fd0dc855b7493a54b0e39ecf3623bffbba7f28a0` |
| `apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts` | `7333bc197b10dacb9ff57a2109a1d406fa6810a61c18f0d61d44670a4125dfae` |
| `apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts` | `ace223b0ad4454421f25e8328f1d88c81fbb6b3102f19d3381f9d8acb13a9b25` |
| `apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts` | `64302956392ec12081d7aa7499abe3ca86242d06ffe6e89058bede00cb311cf9` |
| `apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts` | `2ce16bc96c22fd430e90ff7cded48ca1d693e0d6573ba24084600905a96a80d7` |
| `apps/reel-indexing-service/src/infrastructure/services/vector-projection-worker.service.ts` | `cb4417f46c364d7a4cc99d640ccd4c18d7469474aa4a47026944730461e31ee0` |
| `infra/qdrant/README.md` | `a6e6ef05f3965fc9aefc57125f9c7d09e0f4329fcc84cd4700031d33bcdd2c89` |

| Preserved report | SHA256 |
| --- | --- |
| `implementation-report.md` | `28c480f6facce93c9891bb03d1f65fd02396058a65a76b02e323df8b14d841e4` |
| `recovery-fix-report.md` | `86ab2e1e1813582b957b4d9419e9df9518be6f017460686e64afe5cc4861e4ae` |
| `source-review-report.md` | `a543f05b12b8b3331b442369ebdc266a084c63bcef3810610a99a3660c7390c1` |
| `verification-recheck-report.md` | `ebddcb45a700b24542abdec7002873bc0488db1403b9f04894077ef872de9798` |
| `verification-report.md` | `db6a43bffb9dc68cc74d8f01c976ab76ac235c05f53c135d334e2dc84ae8facd` |

| Local evidence | SHA256 |
| --- | --- |
| `/tmp/recovery-verification-7e9eeff4/recovery.log` | `fa174e58231f7c7e2c0a40cabd521676b3d8016ed52a5f8f64d63cef7e41ee81` |
| `/tmp/recovery-verification-7e9eeff4/configured.log` | `887097d689d6b57c0905b0300a2ba9d1bccff8f8dbacd29783d8cbf6602656db` |
| `/tmp/recovery-verification-7e9eeff4/default.log` | `900cab7da7b60745b835cd2e5cac861beae50792cc8a3c31d7a83475918e9da6` |
| `/tmp/recovery-verification-7e9eeff4/typecheck.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `/tmp/recovery-verification-7e9eeff4/lint.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `/tmp/recovery-verification-7e9eeff4/migration.log` | `de767f2e7980646c5534a34e8b47c639f663fe48b313a979937632ca495bba58` |
| `/tmp/recovery-verification-7e9eeff4/schema.log` | `3cf4fda2e700d2774d81bb369289941d5bdcb20e6820513c090d2ea293c6d509` |
| `/tmp/recovery-verification-7e9eeff4/schema-validate.log` | `07879fe9d2c6ec4df3eab9d83ecc30d72c2b523e33bf618f75575a1264e2eb15` |
| `/tmp/recovery-verification-7e9eeff4/schema-diff.log` | `111cb1d8e97eeeec88e28f6c9ec8b1be78c3d36e14ec899417fc1d01f77e4921` |
| `/tmp/recovery-verification-7e9eeff4/baseline-drift.log` | `111cb1d8e97eeeec88e28f6c9ec8b1be78c3d36e14ec899417fc1d01f77e4921` |
| `/tmp/recovery-verification-7e9eeff4/baseline-drift-result.log` | `bf8abd90413ad277dc152b13f322e2be95730830f7c74167e9308984037f0e8a` |
| `/tmp/recovery-verification-7e9eeff4/cleanup.log` | `dc8359dc2c0039a80b2079892cf495b0fe8f9e690a11ef04aec33d0835892fce` |
| `/tmp/recovery-verification-7e9eeff4/before.json` | `86abd0eb0a1e62249953994049b424d8e2945d42eb8a70db876f3bffcca2cef3` |
| `/tmp/recovery-verification-7e9eeff4/continuity.json` | `1e69065c9f6fe025bed839ad31c1e5669bf71fa342c872effd40b0b0182b7a94` |
| `/tmp/recovery-verification-7e9eeff4/model-proof.json` | `2ed3566fbb8f21c6cb7967ae6200db8d3edf8905ddf9fea688c6947252bbb86d` |

## Isolation, cleanup and remaining gates

Docker context and explicit `--host unix:///var/run/docker.sock` verified local daemon `msi-cua-tao`, Linux x86_64. Containers created with unique task/dispatch labels and dynamic loopback ports, without image pulls:

- PostgreSQL ID `ee365c88bdf2ffbd89dc72ba74bf873327abf2713bf5aa8c47f36bb6db7da129`, port 32782; `pgvector/pgvector@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a`.
- Qdrant ID `c8e64e09aafd1b26d8d9fef9ab95f6085db70a4f8723f2b753f8fe5bc0f8c595`, port 32783; `qdrant/qdrant@sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2`, 1 CPU / 768 MiB.

Exact creation argv are `create-pg.command.json` / `create-qdrant.command.json`; both specify `velora.task=task_7e9eeff4bf46` and `velora.dispatch=ctx_3d492ac43b8d`. `python3 /tmp/recovery-verification-7e9eeff4/cleanup.py` revalidated IDs/labels/loopback bindings, removed only these exact IDs with `docker --host unix:///var/run/docker.sock rm -f -v`, verified their anonymous volume absent and zero task-labelled containers, and deleted the private temporary environment. No unrelated resource cleanup.

`infra/qdrant/README.md:47-65` now inventories all writers and explicitly excludes both normal and `--index-queued` Narto modes throughout capture/export/publication/Qdrant reads. It requires scheduler/process/connection drain plus enforced SQL credential/network exclusion, with shared credentials explicitly BLOCKED until separation/rotation. This is a sufficient explicit rollout gate for the unchanged direct writer; actual deployed exclusion remains NOT_PROVEN, and no scraper rewrite was demanded or performed.

The benchmark/cutover/live hold was not released, repaired or restarted. The task's historical `HALTED_PROVIDER_OR_EXECUTION` / 16 complete / 384 pending / post `PRIMARY_BLOCKED` checkpoint remains preserved in historical reports. Coordinator message `msg_b532d6d6244b` supplies a newer unverified-by-this-worker 2026-10-28 04:50 UTC checkpoint: 30 complete / 370 pending / zero in flight, waiting for 2026-10-29 00:01:30 UTC, post WAITING_FOR_PRIMARY, live NOT_RUN. Neither snapshot is a fresh benchmark observation by this verifier.

Not checked: independent source-review acceptance; real broker/process-kill/drain delivery; native ARM64, disk/overlap/OOM/resource behavior; deployed monitoring/backup schedules, full SQL restore and genuine encrypted off-host recovery; all-writer deployed enforcement and ordered cutover; representative corpus/full-scan tie parity, quality/performance/fallback gates; benchmark completion and 14-/30-day observation/retention. Those remain unproven and held; local lease-expiry/Content-double schedules do not establish production or benchmark readiness.
