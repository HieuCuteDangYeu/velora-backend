# Independent local Qdrant verification

Date: 2026-10-27. Task: `task_a5bbc1ba7caa`; dispatch: `ctx_3e3eefac0617`.

**Single local readiness verdict: BLOCK.** The normal focused Jest invocation fails at suite construction when integration endpoints are absent. All configured local implementation checks passed, including the fresh 20-suite / 109-test run, but the default-run regression must be corrected before local PASS. No application fix was made.

Worktree: `/home/hieucutedangyeu/orca/workspaces/microservices-boilerplate/reel-qdrant-isolated`.
HEAD: `6e9ef1d9c6bc358661ab6666671b29441808a9e6`.
Source scope: 41 implementation/report files before this verification report (16 tracked modifications and 25 untracked files), all unstaged. This worker authored only this new report; no application/config/test edits, dependency install/relink, commit, push, PR, deployment, production migration, SSH, provider call or benchmark request.

The original specifications were read at:
- `/home/hieucutedangyeu/Documents/microservices-boilerplate/microservices-boilerplate/docs/reel-qdrant-migration-plan.md`
- `/home/hieucutedangyeu/Documents/microservices-boilerplate/microservices-boilerplate/docs/reel-qdrant-benchmark-impact.md`

## Blocking finding

**B1 — The opt-in integration suite breaks ordinary unit-test discovery.** At `apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts:22-25`, missing endpoints select `describe.skip`. Jest still executes the suite declaration callback, which allocates its fixture directory at line 28 and constructs `PrismaClient` at lines 44-46 with `datasources.db.url = undefined`. Prisma throws `PrismaClientConstructorValidationError: Invalid value undefined for datasource "db" provided to PrismaClient constructor` before any tests or cleanup hooks can run. The non-null assertion on the environment value does not create a runtime value.

Fresh reproduction, exit **1**:

```sh
pnpm exec jest --runInBand apps/reel-indexing-service/src apps/ai-service/src/application/clean-architecture.spec.ts apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts
```

Result: 19 suites / 96 tests passed; the integration suite failed to load. This is an implementation test-hygiene defect, distinct from the verifier-harness corrections below. A bounded fix must keep integration execution opt-in and avoid constructing resources for a skipped suite. It should then rerun this default invocation and the configured integration check. The coordinator explicitly confirmed this as LOCAL BLOCK; this verifier left the source frozen.

## Fresh results

| Check | Result | Evidence |
| --- | --- | --- |
| Focused unit/architecture suites with disposable endpoints | PASS | 20 suites, 109 tests, exit 0; includes all 13 real Qdrant/PostgreSQL scenarios |
| Ordinary focused invocation without integration endpoints | BLOCK | Exit 1, B1 above |
| Reel Indexing typecheck | PASS | `pnpm exec tsc --noEmit -p apps/reel-indexing-service/tsconfig.app.json`, exit 0 |
| Scoped lint without fixes | PASS | All 19 changed/new TypeScript files, exit 0, no lint output |
| Prisma validate | PASS | Schema valid using explicit disposable loopback URL, exit 0 |
| Prisma migration deploy | PASS | All 11 migrations applied to a fresh disposable PostgreSQL database, exit 0 |
| Additive preservation | PASS | Applied 10 baseline migrations to a second disposable database, seeded transcript/checkpoint/cache data, applied new SQL; dumps of all 13 original tables byte-identical |
| Deployment shell checks | PASS | All 10 `scripts/deploy/test-*.sh` scripts, each exit 0; includes Qdrant policy/launcher and existing infrastructure/approval guards |
| Shell syntax | PASS | Controller/core/launcher/policy, TLS check and Qdrant entrypoint/readiness scripts, exit 0 |
| Ops self-tests | PASS | 3 tests: authenticated encryption/tampering/wrong key, strict arguments/fingerprints, owned rotation/path rejection |
| TLS/auth/readiness/named-volume recreation | PASS | Pinned Qdrant v1.20.0; existing TLS test script exit 0 |
| Compose default and opt-in model assertions | PASS | Config only with non-secret temporary fixture; profile absent by default; secret ownership/private network/resources/default selectors asserted |
| Prometheus rule syntax | PASS | `promtool check rules`: 5 rules, exit 0 |
| Independent multi-Reel checks | PASS | 18 synthetic parity/filter/model/limit assertions plus actual stopped-Qdrant fallback and process restart; corrected inline check exit 0 |
| RPC and consumer contract files | PASS | Scoped `git diff --exit-code` exit 0; unchanged request/response types, controller, AI/public-search/recommendation mappings |
| Tracked whitespace | PASS | `git diff --check`, exit 0 |
| Dependency/build isolation | PASS | 45,439 regular files audited: 0 external symlinks, 0 multiply-linked files; own pnpm tools/client/build paths |
| Original benchmark isolation/provenance | PASS for checked artifacts | Both compiled fingerprints match specification and recorded state; original runner/worker hashes unchanged during this verification |
| Disposal | PASS | Label-checked removal of this worker's two containers and anonymous volumes; TLS script cleaned its own container/named volume |

The additive preservation dump SHA-256 before/after was identical: `fd75df93f05d2973a43ee407b38a385e6ca591b78754f040393e2714a247cbe5`. The only new tables were `VectorCollectionState`, `VectorProjection`, `VectorProjectionTask` and `VectorReelState`. This does not assert that historical pgvector/tsvector Prisma schema drift is clean; the existing schema/data were preserved.

## Behavior verified and limits

The configured integration suite exercised pre-migration enrollment while projection is disabled, readiness enforcement, idempotent all-four-kind projection, negative similarity mapping to distance 2, unchanged RRF60, authorized empty/excluded/tag scopes, full SQL fallback, Content rejection compensation, same-attempt replacement, expired leases/late upload, concurrent claims, partial multi-batch acknowledgement replay, durable publication continuation, restore epoch recertification, immutable export/resumable import/corruption rejection, encrypted snapshot restore with maintenance, wrong payload/scoped SQL mutation fallback, and deletion tombstones with import/delete race and late cleanup.

The extra inline check reused the existing test's candidate factory without editing it. It created three distinct Reels with non-tied cosine similarities 0.8, 0.2 and -0.6; compared IDs/RRF and distance tolerance `2e-5` across all four kinds; checked user, parent, source-length, empty and wrong-version scopes; checked invalid/default limits; excluded foreign embedding-model rows from all hybrid branches; proved lexical-only search did not call the vector branch; stopped the actual Qdrant container and obtained the complete authorized PostgreSQL result; restarted it, rediscovered its loopback port, and proved vector reads resumed against retained collection state. This is synthetic local parity, not a corpus benchmark, latency improvement claim, full-scan PostgreSQL reference proof or tie-boundary quality study.

Compose assertions proved Qdrant is absent without its profile and no base service receives its secrets. With the explicit overlay/profile, API-key owners are exactly Qdrant and both Indexing lanes, the private vector network is internal, no Qdrant port is published, and configured resources are 1 CPU / 768 MiB limit / 256 MiB reservation. Both lanes retain `postgres` with projection/publication/shadow false. The local integration explicitly opted into disposable HTTP and publication/projection only within test ConfigService values. Production effective configuration was neither read nor changed.

Initial verifier-only attempts are retained in the appendix: Compose rendering needed a temporary non-secret env-file fixture even with no env resolution, normalized Compose memory limits were strings and required numeric conversion, and Docker reassigned an ephemeral published port after restart. These were corrected only in inline verification commands; they do not represent application fixes or weaken assertions. The corrected checks passed. The default Jest defect B1 is independent and remains unresolved.

## NOT_PROVEN / held requirements

- Full service/process crash recovery under real RabbitMQ, simultaneous running normal/long Nest instances, query RPC availability throughout a real broker drain, and adversarial concurrent activation/rollback schedules were not established by this run. Tests prove narrower lease/continuation/compensation behaviors; a production smoke claim would overstate them.
- Native ARM64, homelab/VM free space and memory under overlapping TEI/indexing load, effective remote resource limits, authenticated deployed monitoring freshness, scheduled backup operation, genuine encrypted off-host storage/access/rotation, and a compatible full owner-PostgreSQL backup/restore remain NOT_PROVEN. The backup integration deliberately used a local off-host simulation and asserted `offhostVerified=false`.
- Live corpus enrollment/export/import/reconciliation/parity, full-scan PostgreSQL exact reference, boundary tie groups, held-out relevance/Recall/MRR/nDCG/citation quality, latency/p95/p99 and fallback denominators, new indexing/RAG/recommendation smoke checks, ordered cutover/rollback across every live writer/reader, and 14-/30-day observation/retention gates remain held or future work.
- No deployment, remote schema application, production backfill/reindex/read cutover, SQL vector removal or benchmark resumption is authorized by this report. The next separate independent source/semantic review remains required; test results are not that review.

## Original benchmark protection

Read-only recomputation found:
- Baseline: `e16f5cd87f670356d6c0e144087f62556a641fa500a094a6e801bf3cf66a8129`, recorded/specification match; 368 COMPLETED, 32 FAILED.
- Candidate: `f41f7524c198d18466f074468532fd5cbeb4935ad6fff900985ddfd9b7cfd75e`, recorded/specification match; 16 COMPLETED, 384 PENDING.
- Primary supervisor: `HALTED_PROVIDER_OR_EXECUTION`; post-primary: `PRIMARY_BLOCKED`.

The historical PIDs in the specification were absent; no liveness inference was substituted for these current status artifacts. An initial guessed flat `dist/apps/ai-service/main.js` path was absent; the subsequent exact `compiledBase` values from the recorded cohort states were used for successful fingerprint recomputation. Original `.env` and private overrides were not read, hashed, repaired or changed. Own dependency/build trees have no external links or shared writable hardlinks. No original dependencies were executed. No supervisor was signalled or restarted. The benchmark hold remains in force until the coordinator deliberately resolves and preserves that run.

## Exact command/result appendix

All commands below ran from the isolated worktree unless an inline fixture explicitly changed cwd. Credentials shown are disposable non-secret local fixtures, never production values. Commands returning sessions are followed by their recorded completion; polling rows identify the session. Expected error/warning logs from negative-path unit/shell fixtures are not provider calls. Auxiliary read-only discovery commands are summarized above; all material verification commands and failures are retained below.

### 1. Container images

Exit: 0.

```sh
docker --host unix:///var/run/docker.sock image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}'
```

```text
qdrant/qdrant:v1.20.0 8a80c5500151
pgvector/pgvector:pg16 f1447071e6c8
hieucutedangyeu/jev-reranker:latest 1f3dfaa51f29
microservices-boilerplate-jev-reranker:latest 824e4dc1fe04
velora-rag-eval-ci:local-rag-ci-fix 793e755c72ce
nginx:alpine 55fcc661c2cd
grafana/loki:latest ceccdbc45e27
ghcr.io/huggingface/text-embeddings-inference:cpu-latest d40cd5ab72ad
grafana/grafana:latest 747aaf291145
velora-ai-memory-migration-ci:87f341b aeab3ed68bbb
velora/rag-eval:volume-fix 41b6833f41a1
velora/rag-eval:3fcf919 d4192d0f80d4
velora/rag-eval:local fb1f9adb9db7
local/rag-eval:latest fb1f9adb9db7
grafana/alloy:latest c740ac942015
prom/prometheus:latest 31c1e0aacb3a
postgres:16-alpine 75f5a96988cd
prom/node-exporter:latest 9bbbca8f5cb8
ghcr.io/github/github-mcp-server:latest 5b7da589d110
registry.heroku.com/hieu-user-service/worker:latest f7f632bcfa46
registry.heroku.com/hieu-media-service/worker:latest 03a4e5c4b556
registry.heroku.com/hieu-mail-service/worker:latest 8b70fa97de93
registry.heroku.com/hieu-auth-service/worker:latest a0840f815962
registry.heroku.com/hieu-payment-service/web:latest e19aba39ab92
registry.heroku.com/hieu-api-gateway/web:latest 5e73e05e227b
```

### 2. Isolation audit

Exit: 0.

```sh
python3 - <<'PY'
import os,pathlib,hashlib
root=pathlib.Path.cwd(); outside=[]; hard=[]; total=0
for folder in ['node_modules','dist']:
 for base,dirs,files in os.walk(root/folder,followlinks=False):
  for name in dirs+files:
   p=pathlib.Path(base)/name
   if p.is_symlink():
    if not p.resolve().is_relative_to(root):outside.append(str(p))
   elif p.is_file():
    total+=1
    if p.stat().st_nlink>1:hard.append(str(p))
print('regular_files',total,'external_symlinks',len(outside),'multiply_linked_files',len(hard))
print('external',outside[:5],'hardlinks',hard[:5])
assert not outside and not hard
original=pathlib.Path('/home/hieucutedangyeu/Documents/microservices-boilerplate/microservices-boilerplate')
for pid in [673970,734471,905604]:
 p=pathlib.Path('/proc')/str(pid)
 print('benchmark_pid',pid,'exists',p.exists(),'cwd',os.readlink(p/'cwd') if p.exists() else '<absent>')
for f in ['dist/apps/ai-service/main.js','scripts/ops/run-rag-coverage-evaluation.cjs','scripts/ops/rag-coverage-worker.cjs']:
 p=original/f
 print('original_sha256',f,hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else '<absent>')
PY
```

```text
regular_files 45439 external_symlinks 0 multiply_linked_files 0
external [] hardlinks []
benchmark_pid 673970 exists False cwd <absent>
benchmark_pid 734471 exists False cwd <absent>
benchmark_pid 905604 exists False cwd <absent>
original_sha256 dist/apps/ai-service/main.js <absent>
original_sha256 scripts/ops/run-rag-coverage-evaluation.cjs f6d218421efa8ee2ce72d6afef13a91fcde15714fb7fd2699308ba91bf8c32e2
original_sha256 scripts/ops/rag-coverage-worker.cjs b5b6958c6cf12637734199baf79b5d5827298ae58b6aacf8ff425784219d11c4
```

### 3. Focused unit and architecture suites

Exit: running session 97895.

```sh
pnpm exec jest --runInBand apps/reel-indexing-service/src apps/ai-service/src/application/clean-architecture.spec.ts apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts
```

### 4. Typecheck

Exit: running session 9917.

```sh
pnpm exec tsc --noEmit -p apps/reel-indexing-service/tsconfig.app.json
```

### 5. Ops self-tests

Exit: 0.

```sh
node --test scripts/ops/test-qdrant-ops.cjs
```

```text
TAP version 13
# Subtest: authenticated encrypted backup rejects tampering and wrong keys
ok 1 - authenticated encrypted backup rejects tampering and wrong keys
  ---
  duration_ms: 164.092755
  ...
# Subtest: strict arguments and target fingerprints never include credentials
ok 2 - strict arguments and target fingerprints never include credentials
  ---
  duration_ms: 0.525609
  ...
# Subtest: rotation touches only owned archives and traversal artifacts are rejected
ok 3 - rotation touches only owned archives and traversal artifacts are rejected
  ---
  duration_ms: 9.842435
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 744.95886
```

### 6. Pinned image and env-file absence

Exit: 0.

```sh
python3 - <<'PY'
from pathlib import Path
for p in [Path.cwd(),Path('apps/reel-indexing-service/prisma')]:
 print(str(p),'dotenv_filename_present',any(f.name=='.env' for f in p.iterdir()))
 assert not (p/'.env').exists()
PY
docker --host unix:///var/run/docker.sock image inspect qdrant/qdrant:v1.20.0 --format '{{json .RepoDigests}} {{.Architecture}}'
```

```text
/home/hieucutedangyeu/orca/workspaces/microservices-boilerplate/reel-qdrant-isolated dotenv_filename_present False
apps/reel-indexing-service/prisma dotenv_filename_present False
["qdrant/qdrant@sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2"] amd64
```

### 7. Disposable PostgreSQL startup

Exit: 0.

```sh
docker --host unix:///var/run/docker.sock run -d --name reel-qdrant-verify-a5bbc1-pg --label velora.task=task_a5bbc1ba7caa --cpus=1 --memory=512m -e POSTGRES_USER=qdrant_verify -e POSTGRES_PASSWORD=disposable-verify-only -e POSTGRES_DB=qdrant_verify -p 127.0.0.1::5432 pgvector/pgvector:pg16
```

```text
2bb229ccc0e1be638e8d8411e7a359d1b6949629cf7ecb3954b30bfcc9253a02
```

### 8. Disposable Qdrant startup

Exit: 0.

```sh
docker --host unix:///var/run/docker.sock run -d --name reel-qdrant-verify-a5bbc1-qdrant --label velora.task=task_a5bbc1ba7caa --cpus=1 --memory=768m -e QDRANT__SERVICE__API_KEY=local-disposable-test-key -p 127.0.0.1::6333 qdrant/qdrant:v1.20.0@sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2
```

```text
28e1a962f5366b6abbae273e28b7b1185ac7bccd7c85210f5e3120b2659ac0b5
```

### 9. Focused suites final output

Exit: 1.

```sh
poll session 97895
```

```text
19 suites / 96 tests passed; integration suite failed before skip: PrismaClientConstructorValidationError: Invalid value undefined for datasource db provided to PrismaClient constructor. qdrant integration spec constructs PrismaClient inside describe.skip.
```

### 10. Local endpoint ports and readiness

Exit: 0.

```sh
docker --host unix:///var/run/docker.sock port reel-qdrant-verify-a5bbc1-pg; docker --host unix:///var/run/docker.sock port reel-qdrant-verify-a5bbc1-qdrant; docker --host unix:///var/run/docker.sock exec reel-qdrant-verify-a5bbc1-pg pg_isready -U qdrant_verify -d qdrant_verify
```

```text
5432/tcp -> 127.0.0.1:32770
6333/tcp -> 127.0.0.1:32771
/var/run/postgresql:5432 - accepting connections
```

### 11. Typecheck completion

Exit: 0.

```sh
poll session 9917
```

### 12. Scoped lint

Exit: running session 83265.

```sh
python3 - <<'PY'
import subprocess
tracked=subprocess.check_output(['git','diff','--name-only'],text=True).splitlines()
new=subprocess.check_output(['git','ls-files','--others','--exclude-standard'],text=True).splitlines()
paths=sorted(set(p for p in tracked+new if p.endswith('.ts')))
print('TS_FILES',len(paths),flush=True)
print('\n'.join(paths),flush=True)
raise SystemExit(subprocess.run(['pnpm','exec','eslint',*paths]).returncode)
PY
```

```text
TS_FILES 19
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
```

### 13. Shell syntax

Exit: 0.

```sh
bash -n scripts/deploy/velora-deploy scripts/deploy/velora-deploy-core scripts/deploy/velora-deploy-launcher scripts/deploy/velora-qdrant-policy scripts/ops/test-qdrant-local-tls.sh infra/qdrant/entrypoint.sh infra/qdrant/ready.sh
```

### 14. Deployment-controller regression suites

Exit: running session 87944.

```sh
python3 - <<'PY'
import subprocess,pathlib
failed=[]
for p in sorted(pathlib.Path('scripts/deploy').glob('test-*.sh')):
 print('COMMAND: bash',p,flush=True)
 r=subprocess.run(['bash',str(p)])
 print('EXIT:',r.returncode,flush=True)
 if r.returncode:failed.append(str(p))
print('FAILED',failed,flush=True)
raise SystemExit(bool(failed))
PY
```

```text
COMMAND: bash scripts/deploy/test-deployment-metrics.sh
Waiting for RabbitMQ consumers: auth-service(auth_queue=0) payment-service(payment_queue=0) ai-service(ai_queue=0) mail-service(mail_queue=0) conversation-service(conversation_queue=0) call-service(call_queue=0) friend-service(friend_queue=0) monitoring-service(monitoring_queue=0) media-service(media_queue=0) content-service(content_queue=0) user-service(user_queue=0) (1/1)...
WARNING: RabbitMQ consumers did not become ready: auth-service(auth_queue=0) payment-service(payment_queue=0) ai-service(ai_queue=0) mail-service(mail_queue=0) conversation-service(conversation_queue=0) call-service(call_queue=0) friend-service(friend_queue=0) monitoring-service(monitoring_queue=0) media-service(media_queue=0) content-service(content_queue=0) user-service(user_queue=0)
Waiting for running services: reel-indexing-long-service(0/1) (1/1)...
==> Launcher fetching CI-approved Velora deployment controller...
deployment metrics: PASS
EXIT: 0
COMMAND: bash scripts/deploy/test-image-cleanup-container-safety.sh
==> Removing stale unused Velora application SHA tags...
==> Removing unused Velora rollback tags...
==> Pruning dangling Docker images...
==> Removing stale unused Velora application SHA tags...
==> Removing unused Velora rollback tags...
image cleanup container/recovery safety: PASS
EXIT: 0
COMMAND: bash scripts/deploy/test-infra-validation-scope.sh
==> Validating target Nginx configuration with nginx:alpine...
infra validation scoping: PASS
EXIT: 0
COMMAND: bash scripts/deploy/test-mongo-compose-addition.sh
```

### 15. Prisma validation

Exit: 0.

```sh
REEL_INDEXING_DATABASE_URL=postgresql://qdrant_verify:disposable-verify-only@127.0.0.1:32770/qdrant_verify pnpm exec prisma validate --schema=apps/reel-indexing-service/prisma/schema.prisma
```

```text
Prisma schema loaded from apps/reel-indexing-service/prisma/schema.prisma
The schema at apps/reel-indexing-service/prisma/schema.prisma is valid 🚀
```

### 16. Prisma full migration chain

Exit: running session 1555.

```sh
REEL_INDEXING_DATABASE_URL=postgresql://qdrant_verify:disposable-verify-only@127.0.0.1:32770/qdrant_verify pnpm exec prisma migrate deploy --schema=apps/reel-indexing-service/prisma/schema.prisma
```

```text
Prisma schema loaded from apps/reel-indexing-service/prisma/schema.prisma
Datasource "db": PostgreSQL database "qdrant_verify", schema "public" at "127.0.0.1:32770"

11 migrations found in prisma/migrations

Applying migration `20260722140000_init_reel_indexing`
Applying migration `20260722190000_add_embedding_cache`
Applying migration `20260722230000_add_semantic_index`
Applying migration `20260725090000_durable_evidence_index_workflow`
Applying migration `20260725103000_add_document_ordinals`
Applying migration `20260725110000_mark_legacy_semantic_imports`
Applying migration `20260811143000_add_visual_scene_index`
Applying migration `20260811150000_add_visual_artifact_provenance`
Applying migration `20260825090000_add_bge_m3_vector_version`
```

### 17. TLS authenticated readiness and persistence

Exit: running session 4443.

```sh
bash scripts/ops/test-qdrant-local-tls.sh
```

### 18. Prisma migration completion

Exit: 0.

```sh
poll 1555
```

```text
Applying migration `20260907170000_add_quality_evaluation_persistence`
Applying migration `20261027100000_add_vector_projection`

The following migration(s) have been applied:

migrations/
  └─ 20260722140000_init_reel_indexing/
    └─ migration.sql
  └─ 20260722190000_add_embedding_cache/
    └─ migration.sql
  └─ 20260722230000_add_semantic_index/
    └─ migration.sql
  └─ 20260725090000_durable_evidence_index_workflow/
    └─ migration.sql
  └─ 20260725103000_add_document_ordinals/
    └─ migration.sql
  └─ 20260725110000_mark_legacy_semantic_imports/
    └─ migration.sql
  └─ 20260811143000_add_visual_scene_index/
    └─ migration.sql
  └─ 20260811150000_add_visual_artifact_provenance/
    └─ migration.sql
  └─ 20260825090000_add_bge_m3_vector_version/
    └─ migration.sql
  └─ 20260907170000_add_quality_evaluation_persistence/
    └─ migration.sql
  └─ 20261027100000_add_vector_projection/
    └─ migration.sql

All migrations have been successfully applied.
```

### 19. Scoped lint completion

Exit: 0.

```sh
poll 83265
```

### 20. TLS test completion

Exit: 0.

```sh
poll 4443
```

```text
local pinned Qdrant TLS/auth/readiness/config/named-volume recreation: PASS
```

### 21. Deployment tests completion

Exit: 0.

```sh
poll 87944
```

```text
mongo compose addition: PASS
EXIT: 0
COMMAND: bash scripts/deploy/test-postgres-compose-addition.sh
postgres compose addition: PASS
EXIT: 0
COMMAND: bash scripts/deploy/test-qdrant-launcher-bundle.sh
qdrant launcher bundle (new, missing, legacy): PASS
EXIT: 0
COMMAND: bash scripts/deploy/test-qdrant-policy.sh
qdrant policy: PASS
EXIT: 0
COMMAND: bash scripts/deploy/test-rabbitmq-prometheus-migration.sh
==> Recreating RabbitMQ for the approved Prometheus exporter migration...
RabbitMQ Prometheus migration guard tests passed.
EXIT: 0
COMMAND: bash scripts/deploy/test-redis-compose-addition.sh
redis compose addition: PASS
EXIT: 0
COMMAND: bash scripts/deploy/test-turn-env-approval.sh
Approved TURN-only env drift for call-service; healthy env hash is unchanged until deployment succeeds.
Approved TURN-only env drift for call-service; healthy env hash is unchanged until deployment succeeds.
Approved TURN-only env drift for call-service; healthy env hash is unchanged until deployment succeeds.
Approved TURN-only env drift for call-service; healthy env hash is unchanged until deployment succeeds.
Approved TURN-only env drift for call-service; healthy env hash is unchanged until deployment succeeds.
Approved TURN-only env drift for call-service; healthy env hash is unchanged until deployment succeeds.
Approved TURN-only env drift for call-service; healthy env hash is unchanged until deployment succeeds.
Approved TURN-only env drift for call-service; healthy env hash is unchanged until deployment succeeds.
Approved LANGFUSE_SAMPLE_RATE-only env drift for ai-service; healthy env hash is unchanged until deployment succeeds.
Approved TURN-only env drift for call-service; healthy env hash is unchanged until deployment succeeds.
Scoped env approval: PASS (73 checks)
EXIT: 0
FAILED []
```

### 22. Configured focused suites including real Qdrant

Exit: running session 67471.

```sh
QDRANT_TEST_URL=http://127.0.0.1:32771 REEL_INDEXING_TEST_DATABASE_URL=postgresql://qdrant_verify:disposable-verify-only@127.0.0.1:32770/qdrant_verify pnpm exec jest --runInBand apps/reel-indexing-service/src apps/ai-service/src/application/clean-architecture.spec.ts apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts
```

### 23. Configured focused suites completion

Exit: 0.

```sh
poll session 67471
```

```text
[Nest] 1151735  - 10/27/2026, 8:18:04 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":8,"totalMs":98}
[Nest] 1151735  - 10/27/2026, 8:18:04 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":91,"sqlMs":7,"totalMs":98}
[Nest] 1151735  - 10/27/2026, 8:18:04 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":91,"sqlMs":7,"totalMs":98}
[Nest] 1151735  - 10/27/2026, 8:18:04 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":8,"totalMs":98}
[Nest] 1151735  - 10/27/2026, 8:18:04 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":8,"totalMs":97}
[Nest] 1151735  - 10/27/2026, 8:18:04 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":88,"sqlMs":7,"totalMs":95}
[Nest] 1151735  - 10/27/2026, 8:18:04 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":86,"sqlMs":8,"totalMs":94}
[Nest] 1151735  - 10/27/2026, 8:18:04 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"unavailable","qdrantMs":0,"sqlMs":3,"totalMs":3}
[Nest] 1151735  - 10/27/2026, 8:18:05 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":7,"totalMs":97}
[Nest] 1151735  - 10/27/2026, 8:18:05 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":7,"totalMs":97}
[Nest] 1151735  - 10/27/2026, 8:18:06 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"projection_incomplete","qdrantMs":43,"sqlMs":8,"totalMs":51}
[Nest] 1151735  - 10/27/2026, 8:18:07 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":6,"totalMs":96}
[Nest] 1151735  - 10/27/2026, 8:18:08 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"projection_incomplete","qdrantMs":42,"sqlMs":6,"totalMs":48}
[Nest] 1151735  - 10/27/2026, 8:18:08 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":88,"sqlMs":7,"totalMs":95}
[Nest] 1151735  - 10/27/2026, 8:18:08 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":7,"totalMs":97}
[Nest] 1151735  - 10/27/2026, 8:18:08 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"hit_mismatch","qdrantMs":46,"sqlMs":6,"totalMs":52}
[Nest] 1151735  - 10/27/2026, 8:18:08 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"scope_changed","qdrantMs":94,"sqlMs":9,"totalMs":103}
[Nest] 1151735  - 10/27/2026, 8:18:09 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":86,"sqlMs":6,"totalMs":92}
[Nest] 1151735  - 10/27/2026, 8:18:09 PM    WARN [SemanticRecommendationServiceAdapter] AI embedding response did not include model/version identity; semantic recommendation is falling back to keyword/tag hybrid retrieval.
[Nest] 1151735  - 10/27/2026, 8:18:09 PM     LOG [DeterministicRetrievalEngineAdapter] [HierarchicalRetrievalShadow] {"directMs":1,"hierarchicalMs":0,"direct":2,"hierarchical":1,"overlapAtK":0.5,"jaccard":0.5}
[Nest] 1151735  - 10/27/2026, 8:18:09 PM    WARN [DeterministicRetrievalEngineAdapter] [RetrievalEngine] semantic planner failed closed: provider failure
[Nest] 1151735  - 10/27/2026, 8:18:09 PM    WARN [DeterministicRetrievalEngineAdapter] [HierarchyRollout] production hierarchy serving was requested but promotion is not approved; serving direct retrieval and forcing hierarchy shadow instead
[Nest] 1151735  - 10/27/2026, 8:18:09 PM     LOG [DeterministicRetrievalEngineAdapter] [HierarchicalRetrievalShadow] {"directMs":0,"hierarchicalMs":0,"direct":1,"hierarchical":1,"overlapAtK":0,"jaccard":0}
[Nest] 1151735  - 10/27/2026, 8:18:10 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=false confidence=0.90 issues=MEDIUM:RETRIEVAL_QUALITY
[Nest] 1151735  - 10/27/2026, 8:18:10 PM    WARN [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] advisory rejection reelId=reel-1: Advisory issue.
[Nest] 1151735  - 10/27/2026, 8:18:10 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=true confidence=0.98 issues=none
[Nest] 1151735  - 10/27/2026, 8:18:10 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=false confidence=0.92 issues=HIGH:GROUNDING
[Nest] 1151735  - 10/27/2026, 8:18:10 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=false confidence=0.95 issues=HIGH:GROUNDING
[Nest] 1151735  - 10/27/2026, 8:18:10 PM    WARN [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] review unavailable; structural gate remains authoritative: agent unavailable
[Nest] 1151735  - 10/27/2026, 8:18:10 PM   ERROR [CommitSemanticCandidateUseCase] [SemanticCommit] post-commit cleanup failed for attempt-2: SQL unavailable
[Nest] 1151735  - 10/27/2026, 8:18:10 PM     LOG [AnalyzeVisualFrameManifestUseCase] [VisualIndex] reelId=reel-1 completed=1 failed=0 sampled=1
[Nest] 1151735  - 10/27/2026, 8:18:10 PM    WARN [AnalyzeVisualFrameManifestUseCase] [VisualIndex] frame analysis skipped reelId=reel-1 timestampMs=0: Cloudflare Workers AI vision request failed with status 429: daily free allocation exhausted
[Nest] 1151735  - 10/27/2026, 8:18:10 PM   ERROR [ProcessReelIndexJobUseCase] Index job job-1 failed: Visual provider rate limit or quota exhausted; retry this index attempt later: daily free allocation
[Nest] 1151735  - 10/27/2026, 8:18:10 PM   ERROR [ProcessReelIndexJobUseCase] Index job job-1 failed: temporary TEI timeout

Test Suites: 20 passed, 20 total
Tests:       109 passed, 109 total
Snapshots:   0 total
Time:        8.477 s
Ran all test suites matching apps/reel-indexing-service/src|apps/ai-service/src/application/clean-architecture.spec.ts|apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts|apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts|apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts.
```

### 24. Additive migration preservation with seeded baseline

Exit: running session 2370.

```sh
python3 - <<'PY'
import subprocess,pathlib,hashlib,re
prefix=['docker','--host','unix:///var/run/docker.sock','exec','-i','reel-qdrant-verify-a5bbc1-pg']
def sql(stmt,db='qdrant_additive'):
 r=subprocess.run(prefix+['psql','-X','-v','ON_ERROR_STOP=1','-U','qdrant_verify','-d',db,'-At'],input=stmt,text=True,capture_output=True)
 if r.returncode: print(r.stdout,r.stderr);raise SystemExit(r.returncode)
 return r.stdout
sql('CREATE DATABASE qdrant_additive;','qdrant_verify')
files=sorted(pathlib.Path('apps/reel-indexing-service/prisma/migrations').glob('*/migration.sql'))
for p in files[:-1]:
 sql(p.read_text()); print('BASE_MIGRATION',p.parent.name,'EXIT 0')
sql('''INSERT INTO "IndexingAttempt" ("indexAttemptId","jobId","reelId","mediaAttemptId","indexVersion","mergedTranscript","updatedAt") VALUES ('verification-attempt','verification-job','verification-reel','verification-media','reel-index-v2','preserved transcript',now());
INSERT INTO "EmbeddingCacheEntry" ("cacheKey","stableItemId","documentKind","embeddingInputHash","embeddingProvider","embeddingModel","embeddingDimensions","embeddingVersion","indexVersion","chunkingVersion","summaryVersion","embedding","updatedAt") VALUES ('verification-cache','verification-document','REEL','input','self-hosted-tei','BAAI/bge-m3',1024,'bge-m3-tei-v1','reel-index-v2','v1','v1','[1,0]',now());
INSERT INTO "LangGraphCheckpoint" ("threadId","checkpointNamespace","checkpointId","checkpointType","checkpoint","metadataType","metadata") VALUES ('verification-thread','','verification-checkpoint','json',decode('7b7d','hex'),'json',decode('7b7d','hex'));''')
tables=sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
def dump():
 cmd=prefix+['pg_dump','-U','qdrant_verify','-d','qdrant_additive','--no-owner','--no-privileges']
 for t in tables:cmd+=['-t','public."'+t+'"']
 r=subprocess.run(cmd,text=True,capture_output=True);assert r.returncode==0,r.stderr
 return '\n'.join(l for l in r.stdout.splitlines() if not l.startswith(('\\restrict','\\unrestrict','-- Dumped')))
before=dump();print('BASE_TABLES',len(tables),'SHA256',hashlib.sha256(before.encode()).hexdigest())
print('ADD_MIGRATION',files[-1],sql(files[-1].read_text()).strip())
after=dump();print('POST_EXISTING_SHA256',hashlib.sha256(after.encode()).hexdigest());assert before==after,'Existing schema or data changed'
new=set(sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines())-set(tables)
assert new=={'VectorReelState','VectorCollectionState','VectorProjection','VectorProjectionTask'},new
print('NEW_TABLES',sorted(new));print('PASS: 10 baseline migrations + seeded transcript/checkpoint/cache are byte-identical after additive migration')
PY
```

### 25. RPC and consumer source contracts unchanged

Exit: 0.

```sh
git diff --exit-code -- libs/common/src/processing/interfaces/semantic-index.interface.ts apps/reel-indexing-service/src/domain/interfaces/semantic-index.repository.interface.ts apps/reel-indexing-service/src/infrastructure/controllers/semantic-index.controller.ts apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.ts apps/content-service/src/infrastructure/adapters/semantic-reel-search.adapter.ts apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.ts
```

### 26. Tracked whitespace

Exit: 0.

```sh
git diff --check
```

### 27. Seeded additive migration completion

Exit: 0.

```sh
poll session 2370
```

```text
BASE_MIGRATION 20260722140000_init_reel_indexing EXIT 0
BASE_MIGRATION 20260722190000_add_embedding_cache EXIT 0
BASE_MIGRATION 20260722230000_add_semantic_index EXIT 0
BASE_MIGRATION 20260725090000_durable_evidence_index_workflow EXIT 0
BASE_MIGRATION 20260725103000_add_document_ordinals EXIT 0
BASE_MIGRATION 20260725110000_mark_legacy_semantic_imports EXIT 0
BASE_MIGRATION 20260811143000_add_visual_scene_index EXIT 0
BASE_MIGRATION 20260811150000_add_visual_artifact_provenance EXIT 0
BASE_MIGRATION 20260825090000_add_bge_m3_vector_version EXIT 0
BASE_MIGRATION 20260907170000_add_quality_evaluation_persistence EXIT 0
BASE_TABLES 13 SHA256 fd75df93f05d2973a43ee407b38a385e6ca591b78754f040393e2714a247cbe5
ADD_MIGRATION apps/reel-indexing-service/prisma/migrations/20261027100000_add_vector_projection/migration.sql CREATE TABLE
CREATE TABLE
CREATE TABLE
CREATE INDEX
CREATE TABLE
CREATE INDEX
CREATE INDEX
POST_EXISTING_SHA256 fd75df93f05d2973a43ee407b38a385e6ca591b78754f040393e2714a247cbe5
NEW_TABLES ['VectorCollectionState', 'VectorProjection', 'VectorProjectionTask', 'VectorReelState']
PASS: 10 baseline migrations + seeded transcript/checkpoint/cache are byte-identical after additive migration
```

### 28. Compose opt-in, secrets and resource assertions

Exit: 1.

```sh
python3 - <<'PY'
import subprocess,json,os,pathlib
env=dict(os.environ);env.update(DOCKERHUB_USERNAME='fixture',POSTGRES_PASSWORD='fixture',MONGO_INITDB_ROOT_PASSWORD='fixture',REDIS_PASSWORD='fixture',DOCKER_HOST='unix:///var/run/docker.sock')
for k in ['COMPOSE_FILE','COMPOSE_PROFILES','INDEX_VECTOR_SEARCH_BACKEND','INDEX_VECTOR_PROJECTION_ENABLED','INDEX_VECTOR_PUBLICATION_REQUIRED','INDEX_VECTOR_SHADOW_COMPARE']:env.pop(k,None)
base=['docker','compose','--env-file','/dev/null','-f',str(pathlib.Path('docker-compose.yml').resolve())]
def render(args):
 r=subprocess.run(args+['config','--no-env-resolution','--no-path-resolution','--format','json'],env=env,text=True,capture_output=True)
 assert r.returncode==0,r.stderr
 return json.loads(r.stdout)
m=render(base)
assert 'qdrant' not in m['services'],'Qdrant enabled without profile'
for n,s in m['services'].items():assert not any(x['source'].startswith('qdrant') for x in s.get('secrets',[])),n
print('BASE: qdrant absent; zero services receive Qdrant secrets')
m=render(base+['-f',str(pathlib.Path('docker-compose.qdrant.yml').resolve()),'--profile','qdrant'])
q=m['services']['qdrant'];assert q['cpus']==1.0 and q['mem_limit']==805306368 and q['mem_reservation']==268435456
assert not q.get('ports')
assert m['networks']['reel-vector-net']['internal'] is True
owners={n for n,s in m['services'].items() if any(x['source']=='qdrant_api_key' for x in s.get('secrets',[]))}
assert owners=={'qdrant','reel-indexing-service','reel-indexing-long-service'},owners
for n in ['reel-indexing-service','reel-indexing-long-service']:
 e=m['services'][n]['environment'];assert e['INDEX_VECTOR_SEARCH_BACKEND']=='postgres'
 for k in ['INDEX_VECTOR_PUBLICATION_REQUIRED','INDEX_VECTOR_PROJECTION_ENABLED','INDEX_VECTOR_SHADOW_COMPARE']:assert e[k]=='false',(n,k)
print('OPT-IN: API key owners',sorted(owners),'1 CPU / 768MiB limit / 256MiB reservation; private network; no ports')
print('Both lanes: postgres/default, projection=false, publication=false, shadow=false')
print('PASS: config-only rendering used /dev/null and --no-env-resolution; no service started')
PY
```

```text
Traceback (most recent call last):
  File "<stdin>", line 9, in <module>
  File "<stdin>", line 7, in render
AssertionError: env file .env not found: stat .env: no such file or directory
```

### 29. Prometheus rule syntax

Exit: 0.

```sh
docker --host unix:///var/run/docker.sock run --rm --network none --label velora.task=task_a5bbc1ba7caa --entrypoint /bin/promtool -v "$PWD/infra/monitoring/prometheus/rules/reel-vector.yml:/rules/reel-vector.yml:ro" prom/prometheus:latest check rules /rules/reel-vector.yml
```

```text
Checking /rules/reel-vector.yml
  SUCCESS: 5 rules found
```

### 30. Compose assertions with non-secret temporary fixture

Exit: 1.

```sh
python3 - <<'PY'
import subprocess,json,os,pathlib,tempfile
env=dict(os.environ);env.update(DOCKERHUB_USERNAME='fixture',POSTGRES_PASSWORD='fixture',MONGO_INITDB_ROOT_PASSWORD='fixture',REDIS_PASSWORD='fixture',DOCKER_HOST='unix:///var/run/docker.sock')
for k in ['COMPOSE_FILE','COMPOSE_PROFILES','INDEX_VECTOR_SEARCH_BACKEND','INDEX_VECTOR_PROJECTION_ENABLED','INDEX_VECTOR_PUBLICATION_REQUIRED','INDEX_VECTOR_SHADOW_COMPARE']:env.pop(k,None)
base=['docker','compose','--env-file','/dev/null','-f',str(pathlib.Path('docker-compose.yml').resolve())]
with tempfile.TemporaryDirectory(prefix='qdrant-compose-verify-') as fixture:
 pathlib.Path(fixture,'.env').write_text('NON_SECRET_COMPOSE_FIXTURE=true\n')
 def render(args):
  r=subprocess.run(args+['config','--no-env-resolution','--no-path-resolution','--format','json'],env=env,text=True,capture_output=True,cwd=fixture)
  assert r.returncode==0,r.stderr
  return json.loads(r.stdout)
 m=render(base)
 assert 'qdrant' not in m['services'],'Qdrant enabled without profile'
 for n,s in m['services'].items():assert not any(x['source'].startswith('qdrant') for x in s.get('secrets',[])),n
 print('BASE: qdrant absent; zero services receive Qdrant secrets')
 m=render(base+['-f',str(pathlib.Path('docker-compose.qdrant.yml').resolve()),'--profile','qdrant'])
 q=m['services']['qdrant'];assert float(q['cpus'])==1.0 and q['mem_limit']==805306368 and q['mem_reservation']==268435456
 assert not q.get('ports')
 assert m['networks']['reel-vector-net']['internal'] is True
 owners={n for n,s in m['services'].items() if any(x['source']=='qdrant_api_key' for x in s.get('secrets',[]))}
 assert owners=={'qdrant','reel-indexing-service','reel-indexing-long-service'},owners
 for n in ['reel-indexing-service','reel-indexing-long-service']:
  e=m['services'][n]['environment'];assert e['INDEX_VECTOR_SEARCH_BACKEND']=='postgres'
  for k in ['INDEX_VECTOR_PUBLICATION_REQUIRED','INDEX_VECTOR_PROJECTION_ENABLED','INDEX_VECTOR_SHADOW_COMPARE']:assert e[k]=='false',(n,k)
 print('OPT-IN: API key owners',sorted(owners),'1 CPU / 768MiB limit / 256MiB reservation; private network; no ports')
 print('Both lanes: postgres/default, projection=false, publication=false, shadow=false')
 print('PASS: config-only rendering used temporary non-secret fixture, /dev/null and --no-env-resolution; no service started')
PY
```

```text
BASE: qdrant absent; zero services receive Qdrant secrets
Traceback (most recent call last):
  File "<stdin>", line 16, in <module>
AssertionError
```

### 31. Inspect normalized Compose resource types

Exit: 0.

```sh
python3 - <<'PY'
import subprocess,tempfile,pathlib,os,json
root=pathlib.Path.cwd();env=dict(os.environ);env.update(DOCKERHUB_USERNAME='fixture',POSTGRES_PASSWORD='fixture',MONGO_INITDB_ROOT_PASSWORD='fixture',REDIS_PASSWORD='fixture')
with tempfile.TemporaryDirectory(prefix='qdrant-compose-verify-') as d:
 pathlib.Path(d,'.env').write_text('NON_SECRET_FIXTURE=true\n')
 r=subprocess.run(['docker','compose','--env-file','/dev/null','-f',str(root/'docker-compose.yml'),'-f',str(root/'docker-compose.qdrant.yml'),'--profile','qdrant','config','--no-env-resolution','--no-path-resolution','--format','json'],cwd=d,env=env,capture_output=True,text=True)
 assert not r.returncode,r.stderr
 m=json.loads(r.stdout);q=m['services']['qdrant'];print(json.dumps({k:q.get(k) for k in ['cpus','mem_limit','mem_reservation','ports','profiles','networks']}));print('network',m['networks'].get('reel-vector-net'))
PY
```

```text
{"cpus": 1, "mem_limit": "805306368", "mem_reservation": "268435456", "ports": null, "profiles": ["qdrant"], "networks": {"reel-vector-net": null}}
network {'name': 'reel-qdrant-isolated_reel-vector-net', 'ipam': {}, 'internal': True}
```

### 32. Compose final opt-in assertions

Exit: 0.

```sh
python3 - <<'PY'
import subprocess,json,os,pathlib,tempfile
env=dict(os.environ);env.update(DOCKERHUB_USERNAME='fixture',POSTGRES_PASSWORD='fixture',MONGO_INITDB_ROOT_PASSWORD='fixture',REDIS_PASSWORD='fixture',DOCKER_HOST='unix:///var/run/docker.sock')
for k in ['COMPOSE_FILE','COMPOSE_PROFILES','INDEX_VECTOR_SEARCH_BACKEND','INDEX_VECTOR_PROJECTION_ENABLED','INDEX_VECTOR_PUBLICATION_REQUIRED','INDEX_VECTOR_SHADOW_COMPARE']:env.pop(k,None)
base=['docker','compose','--env-file','/dev/null','-f',str(pathlib.Path('docker-compose.yml').resolve())]
with tempfile.TemporaryDirectory(prefix='qdrant-compose-verify-') as fixture:
 pathlib.Path(fixture,'.env').write_text('NON_SECRET_COMPOSE_FIXTURE=true\n')
 def render(args):
  r=subprocess.run(args+['config','--no-env-resolution','--no-path-resolution','--format','json'],env=env,text=True,capture_output=True,cwd=fixture)
  assert r.returncode==0,r.stderr
  return json.loads(r.stdout)
 m=render(base)
 assert 'qdrant' not in m['services'],'Qdrant enabled without profile'
 for n,s in m['services'].items():assert not any(x['source'].startswith('qdrant') for x in s.get('secrets',[])),n
 print('BASE: qdrant absent; zero services receive Qdrant secrets')
 m=render(base+['-f',str(pathlib.Path('docker-compose.qdrant.yml').resolve()),'--profile','qdrant'])
 q=m['services']['qdrant'];assert float(q['cpus'])==1.0 and int(q['mem_limit'])==805306368 and int(q['mem_reservation'])==268435456
 assert not q.get('ports')
 assert m['networks']['reel-vector-net']['internal'] is True
 owners={n for n,s in m['services'].items() if any(x['source']=='qdrant_api_key' for x in s.get('secrets',[]))}
 assert owners=={'qdrant','reel-indexing-service','reel-indexing-long-service'},owners
 for n in ['reel-indexing-service','reel-indexing-long-service']:
  e=m['services'][n]['environment'];assert e['INDEX_VECTOR_SEARCH_BACKEND']=='postgres'
  for k in ['INDEX_VECTOR_PUBLICATION_REQUIRED','INDEX_VECTOR_PROJECTION_ENABLED','INDEX_VECTOR_SHADOW_COMPARE']:assert e[k]=='false',(n,k)
 print('OPT-IN: API key owners',sorted(owners),'1 CPU / 768MiB limit / 256MiB reservation; private network; no ports')
 print('Both lanes: postgres/default, projection=false, publication=false, shadow=false')
 print('PASS: config-only rendering used temporary non-secret fixture, /dev/null and --no-env-resolution; no service started')
PY
```

```text
BASE: qdrant absent; zero services receive Qdrant secrets
OPT-IN: API key owners ['qdrant', 'reel-indexing-long-service', 'reel-indexing-service'] 1 CPU / 768MiB limit / 256MiB reservation; private network; no ports
Both lanes: postgres/default, projection=false, publication=false, shadow=false
PASS: config-only rendering used temporary non-secret fixture, /dev/null and --no-env-resolution; no service started
```

### 33. Independent multi-Reel score/filter/model/limit/real-outage/restart checks

Exit: running session 8460.

```sh
node <<'JS'
const assert=require('node:assert/strict');
require('ts-node/register/transpile-only');require('tsconfig-paths/register');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript');
const {randomUUID}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {ConfigService}=require('@nestjs/config');
const {PrismaClient}=require('@prisma/reel-indexing-client');
const {PrismaSemanticIndexRepository}=require('./apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository');
const {PrismaVectorProjectionRepository}=require('./apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository');
const {PrismaSemanticCandidateLifecycle}=require('./apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle');
const {QdrantReelVectorStoreAdapter}=require('./apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter');
const source=fs.readFileSync('apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts','utf8');
const begin=source.indexOf('    function candidate('),end=source.indexOf('    async function persist(',begin);
assert(begin>0&&end>begin);
const fixture=ts.transpile(source.slice(begin,end),{target:ts.ScriptTarget.ES2022});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qdrant-independent-'));
fs.writeFileSync(path.join(dir,'key'),'local-disposable-test-key',{mode:0o600});
const config=new ConfigService({QDRANT_URL:'http://127.0.0.1:32771',QDRANT_COLLECTION:'independent_verify_a5bbc1',QDRANT_ALLOW_LOCAL_HTTP:'true',QDRANT_API_KEY_FILE:path.join(dir,'key'),INDEX_VECTOR_PROJECTION_ENABLED:'true',INDEX_VECTOR_PUBLICATION_REQUIRED:'true',INDEX_VECTOR_SEARCH_BACKEND:'qdrant',INDEX_EMBEDDING_PROVIDER:'self-hosted-tei',AI_EMBEDDING_MODEL:'BAAI/bge-m3',AI_EMBEDDING_DIMENSIONS:'1024',AI_EMBEDDING_VERSION:'bge-m3-tei-v1'});
const prisma=new PrismaClient({datasources:{db:{url:'postgresql://qdrant_verify:disposable-verify-only@127.0.0.1:32770/qdrant_verify'}}});
const store=new QdrantReelVectorStoreAdapter(config),projection=new PrismaVectorProjectionRepository(prisma,config,store),repo=new PrismaSemanticIndexRepository(prisma,config,projection,store),lifecycle=new PrismaSemanticCandidateLifecycle(prisma,projection);
const vectors=s=>[s,Math.sqrt(1-s*s),...Array(1022).fill(0)];
const reels=[randomUUID(),randomUUID(),randomUUID()];let checks=0,searchCalls=0,stopped=false;
const realSearch=store.search.bind(store);store.search=async q=>{searchCalls++;return realSearch(q)};
async function drain(){for(let i=0;i<100;i++){const task=await projection.claim();if(task){await projection.apply(task);continue;}if(!await prisma.vectorProjectionTask.count({where:{completedAt:null}}))return;await new Promise(r=>setTimeout(r,10));}throw Error('queue did not drain')}
const make=(reel,score)=>new Function('reelId','randomUUID','vector',fixture+';return candidate;')(reel,randomUUID,()=>vectors(score))();
const query={queryEmbedding:[1,...Array(1023).fill(0)],queryEmbeddingModel:'BAAI/bge-m3',queryEmbeddingVersion:'bge-m3-tei-v1',queryText:'science',queryTags:['science'],filters:{reelIds:reels},requiredIndexVersion:'reel-index-v2',limit:10};
async function parity(q,method='searchReels'){
 config.set('INDEX_VECTOR_SEARCH_BACKEND','postgres');const pg=await repo[method](q);
 config.set('INDEX_VECTOR_SEARCH_BACKEND','qdrant');const qd=await repo[method](q);
 assert.deepEqual(qd.map(x=>x.id),pg.map(x=>x.id));
 for(let i=0;i<pg.length;i++){assert.equal(qd[i].rrfScore,pg[i].rrfScore);if(pg[i].vectorDistance!==undefined)assert(Math.abs(qd[i].vectorDistance-pg[i].vectorDistance)<2e-5);}
 checks++;return qd;
}
(async()=>{try{
 await store.initialize();
 for(let i=0;i<3;i++){
  const c=make(reels[i],[.8,.2,-.6][i]);c.job.userId=i===2?'foreign-owner':'authorized-owner';c.job.sourceLengthClass=i===1?'LONG':'SHORT';
  await prisma.indexingAttempt.create({data:{indexAttemptId:c.job.indexAttemptId,reelId:reels[i],jobId:c.job.jobId,mediaAttemptId:'media',indexVersion:'reel-index-v2'}});
  await repo.persistCandidate(c);
  await drain();await lifecycle.activateCandidate({reelId:reels[i],indexAttemptId:c.job.indexAttemptId});
 }
 for(const method of ['searchReels','searchSections','searchChunks','searchVisualScenes'])assert.equal((await parity(query,method)).length,3);
 assert(searchCalls>=4,'Qdrant vector branch was bypassed');
 assert.equal((await parity({...query,filters:{reelIds:reels,userIds:['authorized-owner']}})).length,2);
 assert.equal((await parity({...query,filters:{reelIds:reels,sourceLengthClasses:['LONG']}})).length,1);
 assert.equal((await parity({...query,filters:{reelIds:reels,parentIds:['REEL:'+reels[1]]}},'searchChunks')).length,1);
 assert.equal((await parity({...query,filters:{reelIds:[]}})).length,0);
 assert.equal((await parity({...query,requiredIndexVersion:'foreign-version'})).length,0);
 for(const limit of [undefined,0,-1,101,1.5,NaN,1,2]){
  await parity({...query,limit,candidateLimit:0});
 }
 const normalized=repo.normalizeSearch({...query,limit:0,candidateLimit:0});assert.equal(normalized.limit,20);assert.equal(normalized.candidateLimit,100);
 for(const table of ['ReelDocument','ReelSection','ReelChunk','ReelVisualScene'])await prisma.$executeRawUnsafe('UPDATE "'+table+'" SET "embeddingModel" = $1 WHERE "reelId" = $2','foreign-model',reels[2]);
 const calls=searchCalls;assert.equal((await parity(query)).length,2);assert(searchCalls>calls);
 const lexical={queryText:'science',filters:{reelIds:reels}};const beforeLexical=searchCalls;assert.equal((await repo.searchReels(lexical)).length,3);assert.equal(searchCalls,beforeLexical);
 console.log('PASS: multi-Reel exact cosine/RRF parity across 4 kinds, owner/parent/length/version/empty scopes, invalid limit fallback, model exclusion on every hybrid branch, lexical-only no vector call; checks='+checks);
 config.set('INDEX_VECTOR_SEARCH_BACKEND','postgres');const expected=await repo.searchReels(query);config.set('INDEX_VECTOR_SEARCH_BACKEND','qdrant');
 execFileSync('docker',['--host','unix:///var/run/docker.sock','stop','reel-qdrant-verify-a5bbc1-qdrant']);stopped=true;
 assert.deepEqual(await repo.searchReels(query),expected);
 assert.equal((await repo.searchReels(lexical)).length,3);
 console.log('PASS: actual stopped Qdrant socket uses full authorized PostgreSQL fallback, including lexical-only query');
 execFileSync('docker',['--host','unix:///var/run/docker.sock','start','reel-qdrant-verify-a5bbc1-qdrant']);stopped=false;
 for(let i=0;i<50;i++){try{await store.identity();break}catch(e){if(i===49)throw e;await new Promise(r=>setTimeout(r,100))}}
 assert.equal((await parity(query)).length,2);
 console.log('PASS: real Qdrant process restart retains collection and resumes scoped vector search');
}finally{
 if(stopped)execFileSync('docker',['--host','unix:///var/run/docker.sock','start','reel-qdrant-verify-a5bbc1-qdrant']);
 for(const reel of reels)await repo.deleteReel(reel);await drain();
 await store.request('/collections/'+store.collection,'DELETE');await prisma.$disconnect();fs.rmSync(dir,{recursive:true,force:true});
}})().catch(e=>{console.error(e);process.exitCode=1});
JS
```

### 34. Independent multi-Reel check completion

Exit: 1.

```sh
poll session 8460
```

```text
[Nest] 1155923  - 10/27/2026, 8:21:39 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":131,"sqlMs":10,"totalMs":142}
[Nest] 1155923  - 10/27/2026, 8:21:39 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":130,"sqlMs":10,"totalMs":141}
[Nest] 1155923  - 10/27/2026, 8:21:39 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":133,"sqlMs":8,"totalMs":142}
[Nest] 1155923  - 10/27/2026, 8:21:39 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":131,"sqlMs":8,"totalMs":139}
[Nest] 1155923  - 10/27/2026, 8:21:39 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":132,"sqlMs":8,"totalMs":140}
[Nest] 1155923  - 10/27/2026, 8:21:39 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":8,"totalMs":98}
[Nest] 1155923  - 10/27/2026, 8:21:40 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":9,"totalMs":98}
[Nest] 1155923  - 10/27/2026, 8:21:40 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":87,"sqlMs":6,"totalMs":93}
[Nest] 1155923  - 10/27/2026, 8:21:40 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":129,"sqlMs":8,"totalMs":137}
[Nest] 1155923  - 10/27/2026, 8:21:40 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":130,"sqlMs":6,"totalMs":136}
[Nest] 1155923  - 10/27/2026, 8:21:40 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":130,"sqlMs":7,"totalMs":137}
[Nest] 1155923  - 10/27/2026, 8:21:40 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":131,"sqlMs":6,"totalMs":137}
[Nest] 1155923  - 10/27/2026, 8:21:40 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":128,"sqlMs":6,"totalMs":134}
[Nest] 1155923  - 10/27/2026, 8:21:40 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":131,"sqlMs":7,"totalMs":138}
[Nest] 1155923  - 10/27/2026, 8:21:41 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":131,"sqlMs":7,"totalMs":138}
[Nest] 1155923  - 10/27/2026, 8:21:41 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":130,"sqlMs":6,"totalMs":137}
[Nest] 1155923  - 10/27/2026, 8:21:41 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":129,"sqlMs":6,"totalMs":135}
PASS: multi-Reel exact cosine/RRF parity across 4 kinds, owner/parent/length/version/empty scopes, invalid limit fallback, model exclusion on every hybrid branch, lexical-only no vector call; checks=18
[Nest] 1155923  - 10/27/2026, 8:21:41 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"unavailable","qdrantMs":2,"sqlMs":3,"totalMs":5}
PASS: actual stopped Qdrant socket uses full authorized PostgreSQL fallback, including lexical-only query
TypeError: fetch failed
    at node:internal/deps/undici/undici:13510:13
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async QdrantReelVectorStoreAdapter.request (/home/hieucutedangyeu/orca/workspaces/microservices-boilerplate/reel-qdrant-isolated/apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter.ts:325:22)
    at async QdrantReelVectorStoreAdapter.remove (/home/hieucutedangyeu/orca/workspaces/microservices-boilerplate/reel-qdrant-isolated/apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter.ts:224:20)
    at async PrismaVectorProjectionRepository.apply (/home/hieucutedangyeu/orca/workspaces/microservices-boilerplate/reel-qdrant-isolated/apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts:396:7)
    at async drain ([stdin]:23:92)
    at async [stdin]:67:54 {
  [cause]: Error: connect ECONNREFUSED 127.0.0.1:32771
      at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16) {
    errno: -111,
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: '127.0.0.1',
    port: 32771
  }
}
```

### 35. Restart endpoint diagnosis

Exit: 0.

```sh
docker --host unix:///var/run/docker.sock port reel-qdrant-verify-a5bbc1-qdrant; docker --host unix:///var/run/docker.sock inspect reel-qdrant-verify-a5bbc1-qdrant --format '{{.State.Status}} {{.RestartCount}} {{json .HostConfig.PortBindings}}'
```

```text
6333/tcp -> 127.0.0.1:32774
running 0 {"6333/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]}
```

### 36. Isolated restart-check cleanup and schema clone

Exit: 0.

```sh
python3 - <<'PY'
import subprocess,urllib.request
req=urllib.request.Request('http://127.0.0.1:32774/collections/independent_verify_a5bbc1',method='DELETE',headers={'api-key':'local-disposable-test-key'})
with urllib.request.urlopen(req) as r:assert r.status==200
r=subprocess.run(['docker','--host','unix:///var/run/docker.sock','exec','reel-qdrant-verify-a5bbc1-pg','psql','-X','-v','ON_ERROR_STOP=1','-U','qdrant_verify','-d','qdrant_verify','-c','CREATE DATABASE qdrant_independent TEMPLATE qdrant_verify;'],capture_output=True,text=True);print(r.stdout,r.stderr);assert not r.returncode
r=subprocess.run(['docker','--host','unix:///var/run/docker.sock','exec','reel-qdrant-verify-a5bbc1-pg','psql','-X','-v','ON_ERROR_STOP=1','-U','qdrant_verify','-d','qdrant_independent','-c','TRUNCATE "VectorProjectionTask", "VectorProjection", "VectorReelState", "VectorCollectionState";'],capture_output=True,text=True);print(r.stdout,r.stderr);assert not r.returncode
PY
```

```text
CREATE DATABASE

TRUNCATE TABLE
```

### 37. Corrected independent multi-Reel and outage/restart verification

Exit: running session 45302.

```sh
node <<'JS'
const assert=require('node:assert/strict');
require('ts-node/register/transpile-only');require('tsconfig-paths/register');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript');
const {randomUUID}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {ConfigService}=require('@nestjs/config');
const {PrismaClient}=require('@prisma/reel-indexing-client');
const {PrismaSemanticIndexRepository}=require('./apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository');
const {PrismaVectorProjectionRepository}=require('./apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository');
const {PrismaSemanticCandidateLifecycle}=require('./apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle');
const {QdrantReelVectorStoreAdapter}=require('./apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter');
const source=fs.readFileSync('apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts','utf8');
const begin=source.indexOf('    function candidate('),end=source.indexOf('    async function persist(',begin);
assert(begin>0&&end>begin);
const fixture=ts.transpile(source.slice(begin,end),{target:ts.ScriptTarget.ES2022});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qdrant-independent-'));
fs.writeFileSync(path.join(dir,'key'),'local-disposable-test-key',{mode:0o600});
const config=new ConfigService({QDRANT_URL:'http://127.0.0.1:32774',QDRANT_COLLECTION:'independent_verify_second_a5bbc1',QDRANT_ALLOW_LOCAL_HTTP:'true',QDRANT_API_KEY_FILE:path.join(dir,'key'),INDEX_VECTOR_PROJECTION_ENABLED:'true',INDEX_VECTOR_PUBLICATION_REQUIRED:'true',INDEX_VECTOR_SEARCH_BACKEND:'qdrant',INDEX_EMBEDDING_PROVIDER:'self-hosted-tei',AI_EMBEDDING_MODEL:'BAAI/bge-m3',AI_EMBEDDING_DIMENSIONS:'1024',AI_EMBEDDING_VERSION:'bge-m3-tei-v1'});
const prisma=new PrismaClient({datasources:{db:{url:'postgresql://qdrant_verify:disposable-verify-only@127.0.0.1:32770/qdrant_independent'}}});
const store=new QdrantReelVectorStoreAdapter(config),projection=new PrismaVectorProjectionRepository(prisma,config,store),repo=new PrismaSemanticIndexRepository(prisma,config,projection,store),lifecycle=new PrismaSemanticCandidateLifecycle(prisma,projection);
const vectors=s=>[s,Math.sqrt(1-s*s),...Array(1022).fill(0)];
const reels=[randomUUID(),randomUUID(),randomUUID()];let checks=0,searchCalls=0,stopped=false;
const realSearch=store.search.bind(store);store.search=async q=>{searchCalls++;return realSearch(q)};
async function drain(){for(let i=0;i<100;i++){const task=await projection.claim();if(task){await projection.apply(task);continue;}if(!await prisma.vectorProjectionTask.count({where:{completedAt:null}}))return;await new Promise(r=>setTimeout(r,10));}throw Error('queue did not drain')}
const make=(reel,score)=>new Function('reelId','randomUUID','vector',fixture+';return candidate;')(reel,randomUUID,()=>vectors(score))();
const query={queryEmbedding:[1,...Array(1023).fill(0)],queryEmbeddingModel:'BAAI/bge-m3',queryEmbeddingVersion:'bge-m3-tei-v1',queryText:'science',queryTags:['science'],filters:{reelIds:reels},requiredIndexVersion:'reel-index-v2',limit:10};
async function parity(q,method='searchReels'){
 config.set('INDEX_VECTOR_SEARCH_BACKEND','postgres');const pg=await repo[method](q);
 config.set('INDEX_VECTOR_SEARCH_BACKEND','qdrant');const qd=await repo[method](q);
 assert.deepEqual(qd.map(x=>x.id),pg.map(x=>x.id));
 for(let i=0;i<pg.length;i++){assert.equal(qd[i].rrfScore,pg[i].rrfScore);if(pg[i].vectorDistance!==undefined)assert(Math.abs(qd[i].vectorDistance-pg[i].vectorDistance)<2e-5);}
 checks++;return qd;
}
(async()=>{try{
 await store.initialize();
 for(let i=0;i<3;i++){
  const c=make(reels[i],[.8,.2,-.6][i]);c.job.userId=i===2?'foreign-owner':'authorized-owner';c.job.sourceLengthClass=i===1?'LONG':'SHORT';
  await prisma.indexingAttempt.create({data:{indexAttemptId:c.job.indexAttemptId,reelId:reels[i],jobId:c.job.jobId,mediaAttemptId:'media',indexVersion:'reel-index-v2'}});
  await repo.persistCandidate(c);
  await drain();await lifecycle.activateCandidate({reelId:reels[i],indexAttemptId:c.job.indexAttemptId});
 }
 for(const method of ['searchReels','searchSections','searchChunks','searchVisualScenes'])assert.equal((await parity(query,method)).length,3);
 assert(searchCalls>=4,'Qdrant vector branch was bypassed');
 assert.equal((await parity({...query,filters:{reelIds:reels,userIds:['authorized-owner']}})).length,2);
 assert.equal((await parity({...query,filters:{reelIds:reels,sourceLengthClasses:['LONG']}})).length,1);
 assert.equal((await parity({...query,filters:{reelIds:reels,parentIds:['REEL:'+reels[1]]}},'searchChunks')).length,1);
 assert.equal((await parity({...query,filters:{reelIds:[]}})).length,0);
 assert.equal((await parity({...query,requiredIndexVersion:'foreign-version'})).length,0);
 for(const limit of [undefined,0,-1,101,1.5,NaN,1,2]){
  await parity({...query,limit,candidateLimit:0});
 }
 const normalized=repo.normalizeSearch({...query,limit:0,candidateLimit:0});assert.equal(normalized.limit,20);assert.equal(normalized.candidateLimit,100);
 for(const table of ['ReelDocument','ReelSection','ReelChunk','ReelVisualScene'])await prisma.$executeRawUnsafe('UPDATE "'+table+'" SET "embeddingModel" = $1 WHERE "reelId" = $2','foreign-model',reels[2]);
 const calls=searchCalls;assert.equal((await parity(query)).length,2);assert(searchCalls>calls);
 const lexical={queryText:'science',filters:{reelIds:reels}};const beforeLexical=searchCalls;assert.equal((await repo.searchReels(lexical)).length,3);assert.equal(searchCalls,beforeLexical);
 console.log('PASS: multi-Reel exact cosine/RRF parity across 4 kinds, owner/parent/length/version/empty scopes, invalid limit fallback, model exclusion on every hybrid branch, lexical-only no vector call; checks='+checks);
 config.set('INDEX_VECTOR_SEARCH_BACKEND','postgres');const expected=await repo.searchReels(query);config.set('INDEX_VECTOR_SEARCH_BACKEND','qdrant');
 execFileSync('docker',['--host','unix:///var/run/docker.sock','stop','reel-qdrant-verify-a5bbc1-qdrant']);stopped=true;
 assert.deepEqual(await repo.searchReels(query),expected);
 assert.equal((await repo.searchReels(lexical)).length,3);
 console.log('PASS: actual stopped Qdrant socket uses full authorized PostgreSQL fallback, including lexical-only query');
 execFileSync('docker',['--host','unix:///var/run/docker.sock','start','reel-qdrant-verify-a5bbc1-qdrant']);stopped=false;
 const endpoint=execFileSync('docker',['--host','unix:///var/run/docker.sock','port','reel-qdrant-verify-a5bbc1-qdrant','6333/tcp'],{encoding:'utf8'}).trim();
 assert(endpoint.startsWith('127.0.0.1:'));config.set('QDRANT_URL','http://'+endpoint);console.log('Rediscovered local restart endpoint',endpoint);
 for(let i=0;i<50;i++){try{await store.identity();break}catch(e){if(i===49)throw e;await new Promise(r=>setTimeout(r,100))}}
 assert.equal((await parity(query)).length,2);
 console.log('PASS: real Qdrant process restart retains collection and resumes scoped vector search');
}finally{
 if(stopped)execFileSync('docker',['--host','unix:///var/run/docker.sock','start','reel-qdrant-verify-a5bbc1-qdrant']);
 for(const reel of reels)await repo.deleteReel(reel);await drain();
 await store.request('/collections/'+store.collection,'DELETE');await prisma.$disconnect();fs.rmSync(dir,{recursive:true,force:true});
}})().catch(e=>{console.error(e);process.exitCode=1});
JS
```

### 38. Corrected independent verification completion

Exit: 0.

```sh
poll session 45302
```

```text
[Nest] 1157202  - 10/27/2026, 8:22:52 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":129,"sqlMs":9,"totalMs":140}
[Nest] 1157202  - 10/27/2026, 8:22:53 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":129,"sqlMs":8,"totalMs":138}
[Nest] 1157202  - 10/27/2026, 8:22:53 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":129,"sqlMs":7,"totalMs":137}
[Nest] 1157202  - 10/27/2026, 8:22:53 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":130,"sqlMs":9,"totalMs":140}
[Nest] 1157202  - 10/27/2026, 8:22:53 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":131,"sqlMs":10,"totalMs":141}
[Nest] 1157202  - 10/27/2026, 8:22:53 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":88,"sqlMs":9,"totalMs":97}
[Nest] 1157202  - 10/27/2026, 8:22:53 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":88,"sqlMs":9,"totalMs":97}
[Nest] 1157202  - 10/27/2026, 8:22:53 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":86,"sqlMs":6,"totalMs":92}
[Nest] 1157202  - 10/27/2026, 8:22:53 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":130,"sqlMs":5,"totalMs":135}
[Nest] 1157202  - 10/27/2026, 8:22:54 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":129,"sqlMs":7,"totalMs":136}
[Nest] 1157202  - 10/27/2026, 8:22:54 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":131,"sqlMs":8,"totalMs":139}
[Nest] 1157202  - 10/27/2026, 8:22:54 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":132,"sqlMs":7,"totalMs":139}
[Nest] 1157202  - 10/27/2026, 8:22:54 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":130,"sqlMs":7,"totalMs":138}
[Nest] 1157202  - 10/27/2026, 8:22:54 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":132,"sqlMs":7,"totalMs":139}
[Nest] 1157202  - 10/27/2026, 8:22:54 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":130,"sqlMs":7,"totalMs":137}
[Nest] 1157202  - 10/27/2026, 8:22:54 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":130,"sqlMs":6,"totalMs":136}
[Nest] 1157202  - 10/27/2026, 8:22:55 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":131,"sqlMs":6,"totalMs":137}
PASS: multi-Reel exact cosine/RRF parity across 4 kinds, owner/parent/length/version/empty scopes, invalid limit fallback, model exclusion on every hybrid branch, lexical-only no vector call; checks=18
[Nest] 1157202  - 10/27/2026, 8:22:55 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"unavailable","qdrantMs":3,"sqlMs":2,"totalMs":5}
PASS: actual stopped Qdrant socket uses full authorized PostgreSQL fallback, including lexical-only query
Rediscovered local restart endpoint 127.0.0.1:32775
[Nest] 1157202  - 10/27/2026, 8:22:55 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":129,"sqlMs":8,"totalMs":138}
PASS: real Qdrant process restart retains collection and resumes scoped vector search
```

### 39. Original frozen benchmark fingerprints read-only

Exit: 0.

```sh
node <<'JS'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root='/home/hieucutedangyeu/Documents/microservices-boilerplate/microservices-boilerplate';
const dir=path.join(root,'.benchmarks/rag-remediation-v8-20261027-01/evaluation-5e78a743-primary-20261027-01');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const fingerprint=v=>crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const runner=fs.readFileSync(path.join(root,'scripts/ops/run-rag-coverage-evaluation.cjs'),'utf8');
const begin=runner.indexOf('function compiledRuntimeFiles('),end=runner.indexOf('function parseGroqQuotaGroups(',begin);assert(begin>=0&&end>begin);
const buildFingerprint=new Function('fs','path','fingerprint',runner.slice(begin,end)+';return buildFingerprint;')(fs,path,fingerprint);
for(const [cohort,expected] of [['baseline','e16f5cd87f670356d6c0e144087f62556a641fa500a094a6e801bf3cf66a8129'],['candidate','f41f7524c198d18466f074468532fd5cbeb4935ad6fff900985ddfd9b7cfd75e']]){
 const state=JSON.parse(fs.readFileSync(path.join(dir,'cohort-v8-'+cohort,'state.json'),'utf8'));
 assert(path.resolve(state.compiledBase).startsWith(root+'/'));
 const actual=buildFingerprint(state.compiledBase);assert.equal(actual,state.buildFingerprint);assert.equal(actual,expected);
 const counts={};for(const c of Object.values(state.cases||{}))counts[c.status]=(counts[c.status]||0)+1;
 console.log(cohort,JSON.stringify({compiledBase:state.compiledBase,fingerprint:actual,recordedMatch:true,specificationMatch:true,counts}));
}
for(const file of ['supervisor-status.json','post-primary-supervisor-status.json']){
 const s=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));console.log(file,JSON.stringify({status:s.status,state:s.state,phase:s.phase,completed:s.completed,pending:s.pending,inFlight:s.inFlight}));
}
for(const [file,expected] of [['scripts/ops/run-rag-coverage-evaluation.cjs','f6d218421efa8ee2ce72d6afef13a91fcde15714fb7fd2699308ba91bf8c32e2'],['scripts/ops/rag-coverage-worker.cjs','b5b6958c6cf12637734199baf79b5d5827298ae58b6aacf8ff425784219d11c4']]){
 const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');assert.equal(hash,expected);console.log('UNCHANGED',file,hash);
}
console.log('PASS: no original node_modules executed; no dotenv/private files read; no request, signal, resume or original write');
JS
```

```text
baseline {"compiledBase":"/home/hieucutedangyeu/Documents/microservices-boilerplate/microservices-boilerplate/.benchmarks/rag-remediation-v2-20261010-01/build/ai/apps/ai-service/src","fingerprint":"e16f5cd87f670356d6c0e144087f62556a641fa500a094a6e801bf3cf66a8129","recordedMatch":true,"specificationMatch":true,"counts":{"COMPLETED":368,"FAILED":32}}
candidate {"compiledBase":"/home/hieucutedangyeu/Documents/microservices-boilerplate/microservices-boilerplate/dist/apps/ai-service/apps/ai-service/src","fingerprint":"f41f7524c198d18466f074468532fd5cbeb4935ad6fff900985ddfd9b7cfd75e","recordedMatch":true,"specificationMatch":true,"counts":{"COMPLETED":16,"PENDING":384}}
supervisor-status.json {"status":"HALTED_PROVIDER_OR_EXECUTION"}
post-primary-supervisor-status.json {"status":"PRIMARY_BLOCKED"}
UNCHANGED scripts/ops/run-rag-coverage-evaluation.cjs f6d218421efa8ee2ce72d6afef13a91fcde15714fb7fd2699308ba91bf8c32e2
UNCHANGED scripts/ops/rag-coverage-worker.cjs b5b6958c6cf12637734199baf79b5d5827298ae58b6aacf8ff425784219d11c4
PASS: no original node_modules executed; no dotenv/private files read; no request, signal, resume or original write
```

### 40. Exact integration setup lines

Exit: 0.

```sh
nl -ba apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts | sed -n '20,66p'
```

```text
    20	import { VectorProjectionWorker } from '../services/vector-projection-worker.service';
    21
    22	const enabled =
    23	  !!process.env.QDRANT_TEST_URL &&
    24	  !!process.env.REEL_INDEXING_TEST_DATABASE_URL;
    25	(enabled ? describe : describe.skip)(
    26	  'real Qdrant v1.20 and PostgreSQL projection',
    27	  () => {
    28	    const directory = mkdtempSync(join(tmpdir(), 'reel-qdrant-test-'));
    29	    const collection = `test_${randomUUID().replaceAll('-', '')}`;
    30	    const values = {
    31	      QDRANT_URL: process.env.QDRANT_TEST_URL!,
    32	      QDRANT_COLLECTION: collection,
    33	      QDRANT_ALLOW_LOCAL_HTTP: 'true',
    34	      QDRANT_API_KEY_FILE: join(directory, 'key'),
    35	      INDEX_VECTOR_PROJECTION_ENABLED: 'true',
    36	      INDEX_VECTOR_PUBLICATION_REQUIRED: 'true',
    37	      INDEX_VECTOR_SEARCH_BACKEND: 'qdrant',
    38	      INDEX_EMBEDDING_PROVIDER: 'self-hosted-tei',
    39	      AI_EMBEDDING_MODEL: 'BAAI/bge-m3',
    40	      AI_EMBEDDING_DIMENSIONS: '1024',
    41	      AI_EMBEDDING_VERSION: 'bge-m3-tei-v1',
    42	    };
    43	    const config = new ConfigService(values);
    44	    const prisma = new PrismaClient({
    45	      datasources: { db: { url: process.env.REEL_INDEXING_TEST_DATABASE_URL } },
    46	    });
    47	    const store = new QdrantReelVectorStoreAdapter(config);
    48	    const projection = new PrismaVectorProjectionRepository(
    49	      prisma as never,
    50	      config,
    51	      store,
    52	    );
    53	    const repository = new PrismaSemanticIndexRepository(
    54	      prisma as never,
    55	      config,
    56	      projection,
    57	      store,
    58	    );
    59	    const lifecycle = new PrismaSemanticCandidateLifecycle(
    60	      prisma as never,
    61	      projection,
    62	    );
    63	    const reelId = randomUUID();
    64	    const vector = (sign = 1) => [sign, ...Array<number>(1023).fill(0)];
    65	    function candidate(
    66	      attempt = randomUUID(),
```

### 41. Diff file manifest

Exit: 0.

```sh
python3 - <<'PY'
import subprocess,pathlib,hashlib,json
tracked=subprocess.check_output(['git','diff','--name-only'],text=True).splitlines();new=subprocess.check_output(['git','ls-files','--others','--exclude-standard'],text=True).splitlines()
paths=sorted(set(tracked+new))
print('tracked_changed',len(tracked),'untracked_files',len(new),'total',len(paths))
for p in paths:print(p,hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest())
PY
```

```text
tracked_changed 16 untracked_files 25 total 41
.env.example 399eeb43af7670c423f91387be077d9f569c79babf3ec9ab8db7e121345b102c
.gitignore 627ab3202b12ddb3f93e4afd4860c55dd0e1ee270bddcbcac4b8f79475de9a9f
apps/reel-indexing-service/prisma/migrations/20261027100000_add_vector_projection/migration.sql 12c149b3713091390a21ea271a4d11ff93a316be367fdc302fecd61d0acd97f1
apps/reel-indexing-service/prisma/schema.prisma 43ddd1a57b26ab2cb45afd4f8ea831d4bf16dbe03d20180f3eef1bd692d99a42
apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.spec.ts 3bb00288b3e24fc44d8bd1155658b3d54a13251c84a64e3ad0f9ee531f0c4f30
apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts 523e9d95ee7aecbd4d05e6d6978ae1d8f37eea0a0d3a637331a36cf406d19f56
apps/reel-indexing-service/src/application/use-cases/process-reel-index-job.use-case.spec.ts da1263724b48136f8eb07a32bee3f608e5b9249336d0e73ab47d4abf5f3cdcc2
apps/reel-indexing-service/src/application/use-cases/process-reel-index-job.use-case.ts a923b7530b5a991f0c5a6530bd7749f685f304f6eafaab83dc4c1faa02d99f2a
apps/reel-indexing-service/src/domain/interfaces/reel-vector-store.interface.ts cf158eeaf6972bcfe78336d8ae8e5e9065878d9dd961e488ddb4a1e31b1df4ef
apps/reel-indexing-service/src/domain/interfaces/semantic-candidate-lifecycle.interface.ts 65c9d348feca35138f5c826c4dbf24abdd5457adaa8f0d2c595ab217c1b8b2f1
apps/reel-indexing-service/src/domain/services/reel-vector-manifest.spec.ts c6598b8851fce7a6272ac45b4955f055adb6e9f46ae24039435bb8fceb007e53
apps/reel-indexing-service/src/domain/services/reel-vector-manifest.ts 688f68a8535d808feb82e08d94ee69d890de7ab160c6cba337db98ec706c8236
apps/reel-indexing-service/src/infrastructure/adapters/drainable-index-rmq.server.spec.ts bc37173dea3eafafb3998d7f53f33daac1f7ddd61b49c194feca0aca9c38495a
apps/reel-indexing-service/src/infrastructure/adapters/drainable-index-rmq.server.ts 2f07896adf585c87c913400ec47e8ca6b93bcb52670bec25eec54334e0e49705
apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter.spec.ts 7446ffceea5c58644e7aedd5d19952224bab0fb4c394e0aaf036b17d3002f27b
apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter.ts ef21531949dd0719739b212f742673014f7b0940cc5d9f457a52f6c44cf36a2f
apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts 25f5e6334b3e97af652143137962d2e02ba8363db4fde4bcc9d08d3e8e9de80b
apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts 3406904a0fc5b9cb4958c88531eba773ca0f99dac1d3acdb31643cf91581901e
apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts 894a47442da2fdb290d4d105786ff9645763aa803be7d23f31457e9059a5fa36
apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts 5b13cf7dabd1f7e70579981b7e16e467a1d9e5a2b305dfa0079d68bc3a5fb157
apps/reel-indexing-service/src/infrastructure/services/vector-projection-worker.service.ts 9938312cf077d22708c0b757d0d18316856ae074d2f7c2fbb49ce1ce347bede7
apps/reel-indexing-service/src/main.ts 35dee913c585912a522e719523e9fea4b651bfbd600bea02d6ccc8e878b5f9d6
apps/reel-indexing-service/src/reel-indexing-service.module.ts 194ad862b3b26175f6ddf8f237861bee5417453fcc6c466d0d1ae94db468d6cd
docker-compose.qdrant.yml 38510dc3127580db9be3338fcba8ef354a37dfe2613a6f986fdfefb3d633f888
docker-compose.yml d6ff47913ff81b130af238de0b5273f1bf54974afb8874466e263ee9f8787d5f
infra/monitoring/prometheus/rules/reel-vector.yml d67b3baa1a700b4d26092c7ff56643394fd22bb46dd9ec457f70974097371e99
infra/qdrant/README.md 67273bed681a0287f26c2e92036a25d5a7af503013621fa253886c9b8edfbaf2
infra/qdrant/config.yaml de46c27342b97700df8f12b9305b90e39bdb11b7bdc82a56b467069d58c48ba2
infra/qdrant/entrypoint.sh e2fc752d4afd94276bd4bde07b6675d9ccd2702a45bf2958a7b0fee715d6875e
infra/qdrant/implementation-report.md 08d3861a7237e4f9a1d640257af4915e8020891faffb46e5a7ea4510f06c0ba2
infra/qdrant/ready.sh 0fa7332c1e78fd08d3cf0cb1348a4cd366cfe51b8448d7e8086cc9f7844eba0f
scripts/deploy/test-qdrant-launcher-bundle.sh ba0b4a093f774944f13a85c026f595f4e91a2c0b2f66f440649a7229b2a62069
scripts/deploy/test-qdrant-policy.sh 766a82811766936da0a1865d657c5f577d6a8efbf7ae35876b5b0a6a065bee4f
scripts/deploy/velora-deploy 2bed1211db0c7ae6593e1db172fc9548ce576f34763280d91f1dee0cb7ab3494
scripts/deploy/velora-deploy-core 2bb6b6e11280f9323404047b6b945cdaccb2f4ce907b1687228594624fe557b9
scripts/deploy/velora-deploy-launcher 48be277589f91324d82ad54e6234e321b84f6308cee31c656ed5e4ec0c6b26f8
scripts/deploy/velora-qdrant-policy d784118c8f0eb06d4e994740ae4f7ec3a7c982a9da43424ca1fc6876d88c83b8
scripts/ops/qdrant-backup.cjs 1663937f5867f107cf20ed0239f08955c9baf779e67adb8dc21260c69fe3af6a
scripts/ops/reel-qdrant.cjs 3386ece8a1a1fb9f6749aba1489c2d7d531f75daf651ebe1d0530e0f66a5ddb8
scripts/ops/test-qdrant-local-tls.sh a82c4ca1d0627392ea3603f1501173be00c2eb54626b420a8b6e5d33ce37ad19
scripts/ops/test-qdrant-ops.cjs 5e13039b01189f9c2fd7e608035890bc85da8365c05c7db2f49e27ce4541278c
```

### 42. Owned resource cleanup

Exit: 0.

```sh
python3 - <<'PY'
import subprocess,json
base=['docker','--host','unix:///var/run/docker.sock']
for n in ['reel-qdrant-verify-a5bbc1-pg','reel-qdrant-verify-a5bbc1-qdrant']:
 info=json.loads(subprocess.check_output(base+['inspect',n],text=True))[0]
 assert info['Config']['Labels']['velora.task']=='task_a5bbc1ba7caa'
 r=subprocess.run(base+['rm','-fv',n],text=True,capture_output=True);print('REMOVE',n,'EXIT',r.returncode);assert r.returncode==0
r=subprocess.run(base+['ps','-a','--filter','label=velora.task=task_a5bbc1ba7caa','--format','{{.Names}}'],capture_output=True,text=True)
assert not r.stdout.strip(),r.stdout
print('PASS: no task-owned containers remain; TLS test removed its own named volume')
PY
```

```text
REMOVE reel-qdrant-verify-a5bbc1-pg EXIT 0
REMOVE reel-qdrant-verify-a5bbc1-qdrant EXIT 0
PASS: no task-owned containers remain; TLS test removed its own named volume
```


Final audit: exit 0; SHA-256 of all 41 preexisting implementation/report files remained unchanged; final scope is 16 tracked modifications plus 26 untracked files (only this report added by verifier). An initial report audit rejected whitespace-only blank lines in captured console output; those report-only lines were normalized before this successful audit.
