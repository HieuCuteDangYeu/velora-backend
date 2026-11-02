# Indexing storage completion plan

Status: implementation in progress, 2026-11-03. The user authorized implementation and specified no orchestration. PostgreSQL relocation and Qdrant read cutover are complete; the new Qdrant-only candidate writer is deployed and a canary passed. The final SQL-vector removal remains pending below. This plan supersedes the permanent dual-vector-storage end state in the earlier migration runbook. Existing rollback instructions remain applicable only while SQL vectors are populated.

## Outcome

Run Reel Indexing's PostgreSQL database and Qdrant on the current remote server's private Docker networks. Qdrant is the only permanent store for embeddings and vector similarity search. PostgreSQL owns semantic content, lexical/tag retrieval, attempts, checkpoints, lifecycle and durable publication state. Preserve public RPCs, access restrictions, RRF60 and distance semantics. Preserve all existing source evidence and indexing identities.

Do not move unrelated Aiven databases, introduce a new orchestration system, add replicas, or rewrite lexical retrieval as part of this work. Continue directly in the current agent session as requested. Keep the HLS replacement/re-encoding session independent.

## Starting evidence and uncertainties

On 2026-11-03, Aiven was dumped (83 MiB) and the same-hash copy stored off-host. The complete dump restored to a new PostgreSQL 18.6 + pgvector 0.8.7 ARM64 container with a non-superuser app role. Four semantic tables matched by count, active count, null-vector count and per-row JSON hash. The PostgreSQL target is a separate private service on the homelab because the shared postgres:18.6 container lacks pgvector; unrelated databases were left on the shared container. A fresh post-canary target dump is also stored off-host with matching SHA-256 `0bc9c78473957f57939b35c2a067dd86bdf6e6e55115deba5030953178ad277e8`.

Both indexing lanes run `velora-reel-indexing-qdrant:c0965e02` against `reel-indexing-postgres` with Qdrant reads, projection and publication required. Existing SQL and Qdrant manifests reconcile with zero pending/unready active projections. The exact Qdrant count and sum of all ready generations are 3,986. Twelve scoped RPC queries had p50 96.7 ms and p95 137.8 ms; an earlier same-query sample was 177 ms after relocation versus 1,089 ms against Aiven. This is suggestive, not a statistically rigorous benchmark.

A new Reel reindex canary completed through Content and Indexing: its Reel document and two chunks have null SQL embeddings, a ready Qdrant generation, zero pending tasks, and its exact self-vector search returned rank 1 through the Qdrant RPC. Visual analysis was skipped under the existing Cloudflare quota, so this canary does not prove a newly created visual-scene point. The older two processing flags were reconciled with Content's completed/ready state; no attempts remain processing. All 4,350 legacy SQL embedding-cache vectors were moved to verified R2 batches, then those cache rows and objects were purged after the canary.

An encrypted Qdrant snapshot was uploaded to the private R2 backup prefix, read back and checksum-verified. Its isolated restore recreated 3,986 points, validated 16 sample vectors and removed the temporary collection. The Aiven database and both SQL dumps remain available for comparison/rollback. The old detailed per-point SQL import dry run is superseded by current source/target hashes, per-generation reconciliation, live point retrieval checks and this restore.

## Scope and source bindings

- Deployment: docker-compose.yml, docker-compose.qdrant.yml, .env.example and existing deployment policy/controller paths discovered before editing. Persist the reviewed image, private networks, secret mounts and flags so a normal restart cannot revert the rollout. Keep real credentials outside Git/shared output.
- SQL schema: apps/reel-indexing-service/prisma/schema.prisma and new forward migrations. Keep the four semantic tables, text fields, lexical tsvector indexes, identifiers and embedding provenance; remove only obsolete vector data and indexes in the final phase.
- Writer and recovery: PrismaSemanticIndexRepository, PrismaVectorProjectionRepository, PrismaSemanticCandidateLifecycle, PrismaIndexCheckpointRepository, persisted candidate validation, commit use case and Reel LangGraph workflow.
- Vector contracts: reel-vector-store interface, manifest/hash/ID helpers and Qdrant adapter. Reuse generation fencing, leases, tombstones and deterministic IDs.
- Operations: scripts/ops/reel-qdrant.cjs, qdrant-backup.cjs, metrics and rollout docs. Replace assumptions that reconciliation/export can read SQL embeddings.
- Direct writers: scripts/narto-scraper/sync.cjs (normal and --index-queued) and any repair/backfill tools found by a repository-wide writer search.
- Consumers: Content and AI remain on Indexing RPC. Update internal contracts only where required; no new cross-service SQL access.
- Tests: existing repository, lifecycle, projection, workflow, Qdrant integration, importer and architecture tests; add only missing regression/failure scenarios.

## Phase 1 — establish the baseline

1. Read applicable AGENTS and relevant semantic-index/service-boundary guidance. Inspect dirty state; preserve unrelated edits and the original checkout. Work from the integrated Qdrant worktree, with no workers unless requested.
2. Record exact live image digests, flags, collection/alias identity, SQL version/extensions/schema history, vector dimensions/model versions and complete database sizes. Inventory consumers of the existing PostgreSQL container before changing it.
3. Recover the old validator's outcome. If it failed or was abandoned, record the actual result and run bounded candidate-level verification with progress reporting, preserving generation and provenance checks. Do not launch another silent multi-hour per-point full-manifest scan.
4. Measure connection/transaction round trips separately from SQL execution and Qdrant work. Record fixed representative single-Reel and multi-Reel queries, SQL-only and hybrid modes, empty/access-denied scopes, chronological/adjacent evidence, warm/cold behavior, p50/p95 and fallback rates. Reuse existing vectors; do not call embedding or answer models for storage benchmarks.
5. Honor the user's development freeze: no uploads, scraper synchronization, reindex or deletion during capture/cutover. Check active processes, queues and transactions at the actual boundary. Classify the two stale attempts without blindly completing/deleting them. Refresh the freeze if new activity appears.

Exit: reproducible baseline, accounted writers/attempts and current parity record. The user's operational freeze is sufficient for this development migration; do not reintroduce an arbitrary credential-rotation approval gate. Permanent direct-writer bypasses must still be addressed before normal indexing resumes.

## Phase 2 — prepare same-server PostgreSQL and prove restoration

1. Prefer a separate indexing database and service login in the existing PostgreSQL instance, retaining service ownership boundaries. Use a distinct migration/owner role; runtime credentials must not administer unrelated databases. Cap aggregate application pool sizes against the existing 60-connection budget and other services. Measure before changing global memory settings.
2. Verify that the running PostgreSQL version can load a compatible pgvector extension for the temporary full-schema restore. Do not install extensions into unrelated databases or silently replace/restart their shared container.
3. If reuse requires a shared-container image change, rehearse that exact compatible image and volume layout against a disposable copy, verify existing database owners' health checks and preserve the old image/volume backup. If the change cannot be verified safely, use one dedicated indexing PostgreSQL container with compatible pgvector and a private persistent volume. Record this fallback and avoid adding another consolidation migration to this task.
4. Require sufficient host AND Docker-VM storage for live database, restore copy, WAL and backups, retaining at least the existing 20 GiB deployment gate and safety floor. Check CPU/RAM under overlapping embedding/reranking/encoding work. Use Docker service DNS and no public database port.
5. Create a fresh complete source dump and off-host copy. Restore into an isolated target with roles/ACLs explicitly mapped and \_prisma_migrations preserved. Handle Aiven-only extensions through a recorded TOC filter; do not claim provider-level parity from an application-data restore.
6. Verify all table counts, stable IDs, active attempts, textual content hashes, model provenance, constraints, indexes, schema history and vector parity. Test the exact rollback and restore commands. Back up and restore Qdrant separately into an isolated collection/store without replacing the live alias.

Exit: target database is schema- and data-proven; least-privilege connection and backups work; unrelated databases remain healthy. No live connection switch yet.

## Phase 3 — relocate the indexing database, retaining SQL vectors temporarily

1. During the development freeze, drain both job lanes and account for query/delete handlers, projection/continuation pollers and operator tools. Pause these writers for the final database snapshot/restore. Keep HLS preparation running; coordinate any brief Content/index handoff dependencies rather than restarting media services.
2. Restore the final consistent source snapshot to the verified target. Recheck every identity/count/checksum and pending continuation. Preserve Qdrant generation/manifest/collection identity; do not reuse old source-database fingerprints as proof of the new target. Reverify Qdrant readiness against the restored SQL state.
3. Update the service-specific SQL connection for BOTH lanes and designated operators. Update the durable deployment config so normal restart/redeploy uses the same target, image and Qdrant overlay. Prevent mixed-source readers/writers. Do not modify other services' Aiven URLs.
4. Restart in controlled order, verify target identity from inside each service, reconcile, test search/delete/context RPCs and an indexing canary, then resume permitted work. Confirm no indexing-service sessions connect to Aiven.
5. Rerun the fixed workload. Report actual latency/error/quality changes; do not promise a speedup based on topology alone.

Rollback before target writes: stop target writers and return all indexing instances/operators to unchanged Aiven. After target writes: keep the freeze, export/restore the target's accepted changes back before switching; never point at stale Aiven and lose writes. Reconcile paired Qdrant/SQL generation state after either recovery.

Exit: all indexing SQL traffic uses same-server PostgreSQL; repeatable retrieval and canary indexing pass; baseline comparison exists.

## Phase 4 — implement Qdrant-only permanent vector storage

Implement and test locally, then release with backward-compatible schema changes before destructive cleanup.

1. Retain PostgreSQL semantic text, hierarchy, lexical search and transactional lifecycle. Retain embedding model/version/dimension/input hashes and vector checksums as provenance, not vector arrays.
2. Use existing object storage for private immutable temporary publication bundles containing vectors, payload identity and checksums. SQL stores bundle identity/reference and durable generation/publication state. No new queue or storage engine. Persist the bundle before acknowledging durable publication; retries must recover it without regenerating embeddings. Record and clean orphan bundles safely.
3. Change the existing projector to read that bundle, upload bounded idempotent batches, verify Qdrant points, then complete the existing fenced activation/Content-completion protocol. Network calls stay outside SQL transactions. A lost acknowledgement, stale attempt or expired lease must not activate the wrong generation or remove the previous playable/active result.
4. Keep an accepted candidate immutable. Reindex publishes a new generation and retains the previous generation until the existing activation/compensation path permits cleanup. Tombstones reject delayed uploads; deletion removes live and staged vectors and temporary artifacts. Retain minimal deletion fences through their replay horizon.
5. Remove permanent SQL embedding-cache writes. Reuse compatible existing Qdrant points by input hash/model identity where already supported; recover in-progress work from the staged bundle. Do not introduce a new general cache. Audit drafts, LangGraph state and logs so no permanent SQL vector copies remain. Keep only bounded vector staging with explicit ownership/retention; do not purge artifacts required by unresolved work.
6. Rewrite candidate validation, manifests, export/import, reconciliation and recovery to use SQL identity/checksum records plus Qdrant/staged data. Reconciliation must distinguish missing content from superseded/deleted generations and rebuild from retained evidence only through an explicit reindex path when no recoverable bundle exists.
7. Preserve Qdrant vector candidate lookup, SQL lexical/tag candidates and RRF60. Keep Content-resolved Reel scoping and final active-generation validation. Reduce redundant SQL round trips only when correctness tests prove unchanged access and replacement/delete behavior. ANN tuning is a separate measured choice; do not silently change exact search or relevance here.
8. Remove the live PostgreSQL vector-similarity fallback. On Qdrant unavailability, preserve existing response contracts: return a typed retriable retrieval failure unless the caller already supports an explicit lexical-only degraded mode; never label lexical-only output as equivalent semantic retrieval. Index publication stays retryable and does not falsely complete.
9. Route importer/backfill/direct writers through the reviewed indexing handoff, retaining importer media behavior. If a path cannot be converted in scope, make its unsupported SQL-vector mode fail clearly with the supported replacement command; do not leave a silent bypass.

Exit: new and retried jobs persist vectors only to Qdrant plus temporary recoverable staging, and all readers/recovery tools operate without SQL embeddings. PostgreSQL vector columns can remain temporarily but new writes do not populate them; use nullable/backward-compatible transitional migrations as necessary.

## Phase 5 — end-to-end acceptance and vector removal

Required acceptance:

- New Reel completes transcript/visual indexing and retrieves authorized Reel/section/chunk/scene evidence using Qdrant telemetry. HLS playback remains valid.
- Reindex changes generation; stale/redelivered jobs and concurrent deletes cannot reactivate old vectors. Wrong-user/Reel scopes and deleted content produce no leakage.
- Interrupt before/after bundle persistence, Qdrant upload, verification, activation and Content completion. Recovery preserves accepted state and idempotency across new worker processes.
- Qdrant outage during indexing retains recoverable work; after restart it settles. Retrieval outage behavior is explicit and recovers without manual SQL vector repair.
- Local PostgreSQL outage/restart, Docker restart and ordinary deployment preserve database target, image/flags, secrets and collection identity.
- Fresh paired PostgreSQL/Qdrant off-host backups restore in isolation with generation/epoch validation, plus a missing-Qdrant-data recovery exercise. Encryption keys remain outside backup destinations. Restore does not trust stale readiness certificates.
- Counts, complete point/payload/vector checksums, hierarchy/chronology, lexical/tag ranking, RRF scores and access results match the fixed baseline except documented equivalent-score ties. A newly changed embedding model uses its own identity baseline.
- Repeat the same retrieval workload before/after: record p50/p95, SQL and Qdrant time, errors, fallback/degraded rate and resource peaks. Require no correctness regression and demonstrate a measured latency benefit before declaring performance requirements met. Record exact numerical targets before the run; if none are supplied, report relative p50/p95 improvement and flag lack of a product SLO.

After these pass, take a verified fresh backup, then apply a reviewed forward migration dropping only the obsolete embedding columns/vector indexes and SQL vector arrays. Find dependencies first; do not use CASCADE. Keep semantic tables and lexical indexes. The extension package may remain installed in the isolated Indexing database; the runtime no longer requires it.

Remove vector-containing historical cache/checkpoint values with bounded cleanup only after active recovery dependencies have been migrated or resolved. Verify no persistent SQL embeddings remain, including JSON/binary checkpoints. Keep the offline comparison dump/export privately; it is historical evidence, not a synchronized live vector database.

Rollback after vector deletion is a restore/reindex operation, not toggling the old PostgreSQL vector-search flag. Document this boundary before cleanup. Retire the Aiven indexing database only after target-write recovery, accepted comparison evidence and backups are complete; do not delete it or its backups just because the connection switched. Any final provider deletion is an explicitly identified destructive execution step, distinct from this plan.

## Completion report and delivery

Record exact changed files/commits, deployed image digests, effective flags, destination database identity (no credentials), migrations, validator outcomes, point counts, queue/continuation state, backup/restore results, canary results and latency comparison. Distinguish implemented, locally tested, deployed and live-proven. Update the runbook and current rollout report; historical status records must be labeled as such.

Commit only scoped implementation and operational documentation when executing the authorized work; no push or merge without the user's request. Do not store private dumps, payload bundles, certificates or credentials in Git. Keep unrelated dirty work untouched.

Done means all acceptance items passed, every new writer uses the supported path, no permanent SQL vectors remain, ordinary restart preserves the deployment, and the user can resume indexing/testing without manual repair. A running container, matching count or single smoke test alone is not completion.

## References

- apps/reel-indexing-service/prisma/schema.prisma
- apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts
- apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts
- apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts
- apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts
- scripts/ops/reel-qdrant.cjs and scripts/ops/qdrant-backup.cjs
- PostgreSQL backup/restore: https://www.postgresql.org/docs/18/backup.html
- Qdrant operation guarantees: https://qdrant.tech/documentation/scaling/horizontal-scaling/
