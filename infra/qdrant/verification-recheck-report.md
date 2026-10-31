# Independent local Qdrant verification recheck

Dispatch: ctx_33e1a04dcf92; task: task_a5bbc1ba7caa.

Worktree: /home/hieucutedangyeu/orca/workspaces/microservices-boilerplate/reel-qdrant-isolated

HEAD: 6e9ef1d9c6bc358661ab6666671b29441808a9e6

Readiness verdict: PASS for local verification; production remains held. Historical verification-report.md preserved. Original specifications read only at their two original absolute paths. No application edits, original environment access, SSH, provider/benchmark requests, remote resources or deployment authorized.

**Single local readiness verdict: PASS for the requested independent test/verification gate. B1 is resolved.** The separate independent source review and every production deployment/data-migration gate remain pending.

This is the bounded retry authorized by coordinator message msg_71bde0e13931 and the reply to msg_a84a9456e532: task_ccfca1f8310d and B1 correction task_5c575730d2bc succeeded, both implementation workers settled, and source was frozen. The earlier BLOCK report is preserved as historical evidence; it is superseded only for B1 and the local test gate.

| Fresh check | Result |
| --- | --- |
| Ordinary focused Jest, all integration/target environment variables removed | Exit 0; 19 suites / 96 tests passed; 13 opt-in integration cases skipped |
| Configured real local Qdrant/PostgreSQL integration | Exit 0; 1 suite / all 13 cases passed; no skips |
| Configured full focused indexing/AI architecture/retrieval/consumer Jest | Exit 0; 20 suites / all 109 tests passed; no skips |
| No-resource lifecycle self-check | Exit 0; five scenarios, each registering all 13 cases; no clients/filesystem/network initialization for missing/partial endpoints or rejected remote endpoints |
| Changed integration spec ESLint, without fixes | Exit 0 |
| Reel Indexing service typecheck | Exit 0 |
| Disposable DB prerequisite | Exit 0; all 11 migrations applied to fresh local PostgreSQL |
| Prior proof continuity | Exit 0; 39/41 original files unchanged; only authorized integration spec and implementation report changed |
| Current-run integrity and cleanup | All 42 preexisting files unchanged; own two exact-ID/label-checked containers and PostgreSQL anonymous volume removed |

B1 setup now runs inside beforeAll after loopback validation; describe.skip registration only declares variables/helpers/hooks/cases. Teardown returns before touching resources when setup was rejected. Real configured execution retains the complete integration suite. Current integration-spec SHA256: da4912658a5d491076b030e31f2c7f9db7d768f07255fa21f5bdba1bd71c8831.

**Retained passing evidence, explicitly not rerun:** [verification-report.md](verification-report.md), dispatch ctx_3e3eefac0617, appendix checks 12–38, and its exact frozen 41-file manifest/checks 41–42. Those fresh prior checks cover 19-file lint, Prisma validation and preservation of all 13 old tables (identical dump SHA256 fd75df93f05d2973a43ee407b38a385e6ca591b78754f040393e2714a247cbe5), ten deployment shell suites, shell syntax, three ops tests, TLS/auth/readiness/named-volume recreation, five Prometheus rules, Compose opt-in/secrets/network/resources/default selectors, RPC/consumer source contracts, 18 multi-Reel parity/filter/model/limit checks, actual stopped-Qdrant full fallback and restart. Their application/migration/deployment/ops/TLS/monitoring/config source files remain byte-identical. Prior verification and original benchmark protection evidence were inspected directly; no claim is made that they were freshly rerun in this retry.

**Configuration/contracts:** retained Compose/source proof still establishes PostgreSQL default, projection/publication/shadow off, explicit Qdrant profile and Indexing-only overlay, API-key isolation, private internal networking/no published serving ports, and 1 CPU / 768 MiB limit / 256 MiB reservation. Fresh tests explicitly opt in only in their local fixture ConfigService. Existing RPC request/response/consumer mappings and RRF60/SQL evidence ownership remain unchanged. Fresh integration rechecks generations, readiness/compensation, late writes/leases, all four kinds, score/filter/fallback, import/delete races, restore epochs and encrypted local snapshot restore.

**NOT_PROVEN / remaining plan requirements:** independent source/semantic review; real RabbitMQ/process crash/drain and simultaneous lane deployment; native ARM64 and homelab disk/memory/overlap/OOM; effective deployed monitoring and scheduled backup; actual encrypted off-host destination/retention/restore and a compatible complete owner-PostgreSQL backup restore; production corpus parity/full-scan reference/ties/held-out quality/latency/fallback rate; all-writer ordered cutover/rollback and 14-/30-day observation/retention. The local integration backup deliberately simulates off-host storage and asserts offhostVerified=false. These are limits of local proof or held later phases, not passing production gates.

**Original benchmark isolation:** retained prior report appendix 39 proved both recorded/specification compiled fingerprints unchanged and original runner/worker hashes unchanged; coordinator confirms the hold remains with HALTED_PROVIDER_OR_EXECUTION (16 completed / 384 pending) and PRIMARY_BLOCKED. This retry read only the two original specification files; no original .env/private file reads or hashes, benchmark artifact/process changes, dependency/build execution, provider/benchmark calls, SSH, remote containers/DB, deployment, commits or pushes occurred. The original root .env change was external to this work; no repair or resumption attempted. Deployment/schema migration/backfill/read cutover remains held until the benchmark is deliberately resolved and preserved.

**Harness corrections:** an initial command-wrapper string-substitution syntax error exited 1 before any check ran; an initial hash parser included the historical POST_EXISTING_SHA256 label and exited 1 on an expected-count assertion. Both were verifier-only harness mistakes, corrected without source changes; the corrected 41-file audit passed. Expected provider/error strings in unit output are fixture negative paths, not requests.


Initial implementation file fingerprints:

```json
{
  ".env.example": "399eeb43af7670c423f91387be077d9f569c79babf3ec9ab8db7e121345b102c",
  ".gitignore": "627ab3202b12ddb3f93e4afd4860c55dd0e1ee270bddcbcac4b8f79475de9a9f",
  "apps/reel-indexing-service/prisma/migrations/20261027100000_add_vector_projection/migration.sql": "12c149b3713091390a21ea271a4d11ff93a316be367fdc302fecd61d0acd97f1",
  "apps/reel-indexing-service/prisma/schema.prisma": "43ddd1a57b26ab2cb45afd4f8ea831d4bf16dbe03d20180f3eef1bd692d99a42",
  "apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.spec.ts": "3bb00288b3e24fc44d8bd1155658b3d54a13251c84a64e3ad0f9ee531f0c4f30",
  "apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts": "523e9d95ee7aecbd4d05e6d6978ae1d8f37eea0a0d3a637331a36cf406d19f56",
  "apps/reel-indexing-service/src/application/use-cases/process-reel-index-job.use-case.spec.ts": "da1263724b48136f8eb07a32bee3f608e5b9249336d0e73ab47d4abf5f3cdcc2",
  "apps/reel-indexing-service/src/application/use-cases/process-reel-index-job.use-case.ts": "a923b7530b5a991f0c5a6530bd7749f685f304f6eafaab83dc4c1faa02d99f2a",
  "apps/reel-indexing-service/src/domain/interfaces/reel-vector-store.interface.ts": "cf158eeaf6972bcfe78336d8ae8e5e9065878d9dd961e488ddb4a1e31b1df4ef",
  "apps/reel-indexing-service/src/domain/interfaces/semantic-candidate-lifecycle.interface.ts": "65c9d348feca35138f5c826c4dbf24abdd5457adaa8f0d2c595ab217c1b8b2f1",
  "apps/reel-indexing-service/src/domain/services/reel-vector-manifest.spec.ts": "c6598b8851fce7a6272ac45b4955f055adb6e9f46ae24039435bb8fceb007e53",
  "apps/reel-indexing-service/src/domain/services/reel-vector-manifest.ts": "688f68a8535d808feb82e08d94ee69d890de7ab160c6cba337db98ec706c8236",
  "apps/reel-indexing-service/src/infrastructure/adapters/drainable-index-rmq.server.spec.ts": "bc37173dea3eafafb3998d7f53f33daac1f7ddd61b49c194feca0aca9c38495a",
  "apps/reel-indexing-service/src/infrastructure/adapters/drainable-index-rmq.server.ts": "2f07896adf585c87c913400ec47e8ca6b93bcb52670bec25eec54334e0e49705",
  "apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter.spec.ts": "7446ffceea5c58644e7aedd5d19952224bab0fb4c394e0aaf036b17d3002f27b",
  "apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter.ts": "ef21531949dd0719739b212f742673014f7b0940cc5d9f457a52f6c44cf36a2f",
  "apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts": "da4912658a5d491076b030e31f2c7f9db7d768f07255fa21f5bdba1bd71c8831",
  "apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-candidate-lifecycle.ts": "3406904a0fc5b9cb4958c88531eba773ca0f99dac1d3acdb31643cf91581901e",
  "apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts": "894a47442da2fdb290d4d105786ff9645763aa803be7d23f31457e9059a5fa36",
  "apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository.ts": "5b13cf7dabd1f7e70579981b7e16e467a1d9e5a2b305dfa0079d68bc3a5fb157",
  "apps/reel-indexing-service/src/infrastructure/services/vector-projection-worker.service.ts": "9938312cf077d22708c0b757d0d18316856ae074d2f7c2fbb49ce1ce347bede7",
  "apps/reel-indexing-service/src/main.ts": "35dee913c585912a522e719523e9fea4b651bfbd600bea02d6ccc8e878b5f9d6",
  "apps/reel-indexing-service/src/reel-indexing-service.module.ts": "194ad862b3b26175f6ddf8f237861bee5417453fcc6c466d0d1ae94db468d6cd",
  "docker-compose.qdrant.yml": "38510dc3127580db9be3338fcba8ef354a37dfe2613a6f986fdfefb3d633f888",
  "docker-compose.yml": "d6ff47913ff81b130af238de0b5273f1bf54974afb8874466e263ee9f8787d5f",
  "infra/monitoring/prometheus/rules/reel-vector.yml": "d67b3baa1a700b4d26092c7ff56643394fd22bb46dd9ec457f70974097371e99",
  "infra/qdrant/README.md": "67273bed681a0287f26c2e92036a25d5a7af503013621fa253886c9b8edfbaf2",
  "infra/qdrant/config.yaml": "de46c27342b97700df8f12b9305b90e39bdb11b7bdc82a56b467069d58c48ba2",
  "infra/qdrant/entrypoint.sh": "e2fc752d4afd94276bd4bde07b6675d9ccd2702a45bf2958a7b0fee715d6875e",
  "infra/qdrant/implementation-report.md": "28c480f6facce93c9891bb03d1f65fd02396058a65a76b02e323df8b14d841e4",
  "infra/qdrant/ready.sh": "0fa7332c1e78fd08d3cf0cb1348a4cd366cfe51b8448d7e8086cc9f7844eba0f",
  "infra/qdrant/verification-report.md": "db6a43bffb9dc68cc74d8f01c976ab76ac235c05f53c135d334e2dc84ae8facd",
  "scripts/deploy/test-qdrant-launcher-bundle.sh": "ba0b4a093f774944f13a85c026f595f4e91a2c0b2f66f440649a7229b2a62069",
  "scripts/deploy/test-qdrant-policy.sh": "766a82811766936da0a1865d657c5f577d6a8efbf7ae35876b5b0a6a065bee4f",
  "scripts/deploy/velora-deploy": "2bed1211db0c7ae6593e1db172fc9548ce576f34763280d91f1dee0cb7ab3494",
  "scripts/deploy/velora-deploy-core": "2bb6b6e11280f9323404047b6b945cdaccb2f4ce907b1687228594624fe557b9",
  "scripts/deploy/velora-deploy-launcher": "48be277589f91324d82ad54e6234e321b84f6308cee31c656ed5e4ec0c6b26f8",
  "scripts/deploy/velora-qdrant-policy": "d784118c8f0eb06d4e994740ae4f7ec3a7c982a9da43424ca1fc6876d88c83b8",
  "scripts/ops/qdrant-backup.cjs": "1663937f5867f107cf20ed0239f08955c9baf779e67adb8dc21260c69fe3af6a",
  "scripts/ops/reel-qdrant.cjs": "3386ece8a1a1fb9f6749aba1489c2d7d531f75daf651ebe1d0530e0f66a5ddb8",
  "scripts/ops/test-qdrant-local-tls.sh": "a82c4ca1d0627392ea3603f1501173be00c2eb54626b420a8b6e5d33ce37ad19",
  "scripts/ops/test-qdrant-ops.cjs": "5e13039b01189f9c2fd7e608035890bc85da8365c05c7db2f49e27ce4541278c"
}
```

Isolation audit: local host msi-cua-tao, Linux x86_64, Docker explicitly unix:///var/run/docker.sock. node_modules: 56754 entries, zero external symlinks/shared writable hardlinks; dist: 3 entries, zero external links/shared hardlinks. .env absent at root, indexing service and Prisma directories (existence only checked). Existing local pgvector:pg16 and exact pinned Qdrant image available.

## Fresh command evidence

### Service typecheck

Command:

```sh
pnpm exec tsc --noEmit -p apps/reel-indexing-service/tsconfig.app.json
```

Explicit environment: {}

Exit: 0; seconds: 2.82.

```text

```

### Default focused discovery

Command:

```sh
pnpm exec jest --runInBand apps/reel-indexing-service/src apps/ai-service/src/application/clean-architecture.spec.ts apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts
```

Explicit environment: {}

Exit: 0; seconds: 4.57.

```text
[Nest] 1171305  - 10/27/2026, 8:36:59 PM    WARN [SemanticRecommendationServiceAdapter] AI embedding response did not include model/version identity; semantic recommendation is falling back to keyword/tag hybrid retrieval.
[Nest] 1171305  - 10/27/2026, 8:36:59 PM     LOG [DeterministicRetrievalEngineAdapter] [HierarchicalRetrievalShadow] {"directMs":0,"hierarchicalMs":1,"direct":2,"hierarchical":1,"overlapAtK":0.5,"jaccard":0.5}
[Nest] 1171305  - 10/27/2026, 8:36:59 PM    WARN [DeterministicRetrievalEngineAdapter] [RetrievalEngine] semantic planner failed closed: provider failure
[Nest] 1171305  - 10/27/2026, 8:36:59 PM    WARN [DeterministicRetrievalEngineAdapter] [HierarchyRollout] production hierarchy serving was requested but promotion is not approved; serving direct retrieval and forcing hierarchy shadow instead
[Nest] 1171305  - 10/27/2026, 8:36:59 PM     LOG [DeterministicRetrievalEngineAdapter] [HierarchicalRetrievalShadow] {"directMs":0,"hierarchicalMs":0,"direct":1,"hierarchical":1,"overlapAtK":0,"jaccard":0}
[Nest] 1171305  - 10/27/2026, 8:37:00 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=false confidence=0.90 issues=MEDIUM:RETRIEVAL_QUALITY
[Nest] 1171305  - 10/27/2026, 8:37:00 PM    WARN [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] advisory rejection reelId=reel-1: Advisory issue.
[Nest] 1171305  - 10/27/2026, 8:37:00 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=true confidence=0.98 issues=none
[Nest] 1171305  - 10/27/2026, 8:37:00 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=false confidence=0.92 issues=HIGH:GROUNDING
[Nest] 1171305  - 10/27/2026, 8:37:00 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=false confidence=0.95 issues=HIGH:GROUNDING
[Nest] 1171305  - 10/27/2026, 8:37:00 PM    WARN [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] review unavailable; structural gate remains authoritative: agent unavailable
[Nest] 1171305  - 10/27/2026, 8:37:00 PM   ERROR [ProcessReelIndexJobUseCase] Index job job-1 failed: Visual provider rate limit or quota exhausted; retry this index attempt later: daily free allocation
[Nest] 1171305  - 10/27/2026, 8:37:00 PM   ERROR [ProcessReelIndexJobUseCase] Index job job-1 failed: temporary TEI timeout
[Nest] 1171305  - 10/27/2026, 8:37:00 PM     LOG [AnalyzeVisualFrameManifestUseCase] [VisualIndex] reelId=reel-1 completed=1 failed=0 sampled=1
[Nest] 1171305  - 10/27/2026, 8:37:00 PM    WARN [AnalyzeVisualFrameManifestUseCase] [VisualIndex] frame analysis skipped reelId=reel-1 timestampMs=0: Cloudflare Workers AI vision request failed with status 429: daily free allocation exhausted
[Nest] 1171305  - 10/27/2026, 8:37:00 PM   ERROR [CommitSemanticCandidateUseCase] [SemanticCommit] post-commit cleanup failed for attempt-2: SQL unavailable

Test Suites: 1 skipped, 19 passed, 19 of 20 total
Tests:       13 skipped, 96 passed, 109 total
Snapshots:   0 total
Time:        3.231 s, estimated 9 s
Ran all test suites matching apps/reel-indexing-service/src|apps/ai-service/src/application/clean-architecture.spec.ts|apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts|apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts|apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts.

```

### Changed integration spec lint

Command:

```sh
pnpm exec eslint apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts
```

Explicit environment: {}

Exit: 0; seconds: 6.63.

```text

```

### Independent no-resource lifecycle self-check

Command:

```sh
node -e 'const assert = require('"'"'node:assert/strict'"'"');
const fs = require('"'"'node:fs'"'"');
const vm = require('"'"'node:vm'"'"');
const ts = require("typescript");
const code = ts.transpileModule(fs.readFileSync("apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts", '"'"'utf8'"'"'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
(async () => {
  for (const [name, env, skipped] of [
    ['"'"'no endpoints'"'"', {}, true],
    ['"'"'only Qdrant'"'"', { QDRANT_TEST_URL: '"'"'http://127.0.0.1:6333'"'"' }, true],
    ['"'"'only PostgreSQL'"'"', { REEL_INDEXING_TEST_DATABASE_URL: '"'"'postgresql://u:p@127.0.0.1:5432/db'"'"' }, true],
    ['"'"'reject remote Qdrant'"'"', { QDRANT_TEST_URL: '"'"'http://example.invalid:6333'"'"', REEL_INDEXING_TEST_DATABASE_URL: '"'"'postgresql://u:p@127.0.0.1:5432/db'"'"' }, false],
    ['"'"'reject remote PostgreSQL'"'"', { QDRANT_TEST_URL: '"'"'http://127.0.0.1:6333'"'"', REEL_INDEXING_TEST_DATABASE_URL: '"'"'postgresql://u:p@example.invalid:5432/db'"'"' }, false],
  ]) {
    let cases = 0, attemptedResources = 0, selectedSkip;
    const before = [], after = [];
    const denied = () => { attemptedResources++; throw Error('"'"'Resource initialization during registration/validation'"'"'); };
    const constructor = class { constructor() { denied(); } };
    const describe = (_, callback) => { selectedSkip = false; callback(); };
    describe.skip = (_, callback) => { selectedSkip = true; callback(); };
    vm.runInNewContext(code, {
      exports: {}, process: { env }, describe, URL,
      beforeAll: callback => before.push(callback), afterAll: callback => after.push(callback),
      afterEach: () => {}, it: () => { cases++; },
      require: id => {
        if (id === '"'"'node:crypto'"'"') return require(id);
        if (id === '"'"'node:fs'"'"') return { ...fs, mkdtempSync: denied, writeFileSync: denied, rmSync: denied };
        if (id.startsWith('"'"'node:'"'"')) return require(id);
        return new Proxy({}, { get: () => constructor });
      },
      fetch: denied,
    }, { filename: "apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts" });
    assert.equal(selectedSkip, skipped);
    assert.equal(cases, 13);
    assert.equal(before.length, 1);
    assert.equal(after.length, 1);
    if (!skipped) {
      await assert.rejects(before[0](), /Integration requires loopback-only disposable targets/);
      await after[0]();
    }
    assert.equal(attemptedResources, 0);
    console.log('"'"'PASS:'"'"', name, '"'"'- 13 registered cases; zero client/filesystem/network initialization'"'"');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
'
```

Explicit environment: {}

Exit: 0; seconds: 0.32.

```text
PASS: no endpoints - 13 registered cases; zero client/filesystem/network initialization
PASS: only Qdrant - 13 registered cases; zero client/filesystem/network initialization
PASS: only PostgreSQL - 13 registered cases; zero client/filesystem/network initialization
PASS: reject remote Qdrant - 13 registered cases; zero client/filesystem/network initialization
PASS: reject remote PostgreSQL - 13 registered cases; zero client/filesystem/network initialization

```

### Prior independent proof hash continuity

Command:

```sh
python3 -c 'import re,pathlib,hashlib
root=pathlib.Path.cwd();report=(root/'"'"'infra/qdrant/verification-report.md'"'"').read_text()
old=dict(re.findall(r'"'"'^([^\s]+) ([0-9a-f]{64})$'"'"',report,re.M))
assert len(old)==41,len(old)
changed=[]
for p,h in old.items():
 actual=hashlib.sha256((root/p).read_bytes()).hexdigest()
 if actual!=h:changed.append(p);print('"'"'CHANGED_SINCE_INITIAL'"'"',p,'"'"'old'"'"',h,'"'"'current'"'"',actual)
assert sorted(changed)==sorted(['"'"'infra/qdrant/implementation-report.md'"'"','"'"'apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts'"'"']),changed
print('"'"'PASS: 39 of 41 initial frozen files unchanged; only B1 integration spec and implementation report differ'"'"')
'
```

Explicit environment: {}

Exit: 1; seconds: 0.09.

```text
Traceback (most recent call last):
  File "<string>", line 4, in <module>
AssertionError: 42

```

### PostgreSQL disposable start

Command:

```sh
docker --host unix:///var/run/docker.sock run --pull=never -d --name reel-qdrant-recheck-33e1-pg --label velora.task=task_a5bbc1ba7caa --label velora.dispatch=ctx_33e1a04dcf92 -e POSTGRES_USER=recheck -e POSTGRES_PASSWORD=local-recheck-only -e POSTGRES_DB=recheck -p 127.0.0.1::5432 pgvector/pgvector:pg16
```

Explicit environment: {}

Exit: 0; seconds: 0.12.

```text
b486e5c3ed90824811b93faf998cb6b068b74d8c898aef2ed2e6b2bcfb904552

```

### Qdrant disposable start

Command:

```sh
docker --host unix:///var/run/docker.sock run --pull=never -d --name reel-qdrant-recheck-33e1-qdrant --label velora.task=task_a5bbc1ba7caa --label velora.dispatch=ctx_33e1a04dcf92 --cpus=1 --memory=768m -e QDRANT__SERVICE__API_KEY=local-disposable-test-key -p 127.0.0.1::6333 qdrant/qdrant:v1.20.0@sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2
```

Explicit environment: {}

Exit: 0; seconds: 0.16.

```text
089bfb9aa804f001a1bf1ce11a778203a254ba5c8472183d17afe09da20d3189

```

### Corrected prior proof hash continuity

Command:

```sh
python3 -c 'import re,pathlib,hashlib
root=pathlib.Path.cwd();report=(root/'"'"'infra/qdrant/verification-report.md'"'"').read_text()
old={p:h for p,h in re.findall(r'"'"'^([^\s]+) ([0-9a-f]{64})$'"'"',report,re.M) if (root/p).is_file()}
assert len(old)==41,len(old)
changed=[]
for p,h in old.items():
 actual=hashlib.sha256((root/p).read_bytes()).hexdigest()
 if actual!=h:changed.append(p);print('"'"'CHANGED_SINCE_INITIAL'"'"',p,'"'"'old'"'"',h,'"'"'current'"'"',actual)
assert sorted(changed)==sorted(['"'"'infra/qdrant/implementation-report.md'"'"','"'"'apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts'"'"']),changed
print('"'"'PASS: 39 of 41 initial frozen files unchanged; only B1 integration spec and implementation report differ'"'"')
'
```

Explicit environment: {}

Exit: 0; seconds: 0.02.

```text
CHANGED_SINCE_INITIAL apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts old 25f5e6334b3e97af652143137962d2e02ba8363db4fde4bcc9d08d3e8e9de80b current da4912658a5d491076b030e31f2c7f9db7d768f07255fa21f5bdba1bd71c8831
CHANGED_SINCE_INITIAL infra/qdrant/implementation-report.md old 08d3861a7237e4f9a1d640257af4915e8020891faffb46e5a7ea4510f06c0ba2 current 28c480f6facce93c9891bb03d1f65fd02396058a65a76b02e323df8b14d841e4
PASS: 39 of 41 initial frozen files unchanged; only B1 integration spec and implementation report differ

```

### Local container identity and readiness

Command:

```sh
python3 -c 'import subprocess,json,time,urllib.request
base=['"'"'docker'"'"','"'"'--host'"'"','"'"'unix:///var/run/docker.sock'"'"']
ports={}
for name,target in [('"'"'pg'"'"','"'"'5432/tcp'"'"'),('"'"'qdrant'"'"','"'"'6333/tcp'"'"')]:
 info=json.loads(subprocess.check_output(base+['"'"'inspect'"'"','"'"'reel-qdrant-recheck-33e1-'"'"'+name],text=True))[0]
 assert info['"'"'Config'"'"']['"'"'Labels'"'"']['"'"'velora.dispatch'"'"']=='"'"'ctx_33e1a04dcf92'"'"'
 assert info['"'"'Config'"'"']['"'"'Labels'"'"']['"'"'velora.task'"'"']=='"'"'task_a5bbc1ba7caa'"'"'
 bindings=info['"'"'NetworkSettings'"'"']['"'"'Ports'"'"'][target];assert len(bindings)==1 and bindings[0]['"'"'HostIp'"'"']=='"'"'127.0.0.1'"'"'
 ports[name]=bindings[0]['"'"'HostPort'"'"']
 print(name,'"'"'127.0.0.1:'"'"'+ports[name],info['"'"'Id'"'"'])
for i in range(40):
 p=subprocess.run(base+['"'"'exec'"'"','"'"'reel-qdrant-recheck-33e1-pg'"'"','"'"'pg_isready'"'"','"'"'-U'"'"','"'"'recheck'"'"'],capture_output=True)
 try:q=urllib.request.urlopen('"'"'http://127.0.0.1:'"'"'+ports['"'"'qdrant'"'"']+'"'"'/readyz'"'"',timeout=1).status==200
 except Exception:q=False
 if p.returncode==0 and q:break
 time.sleep(.2)
else:raise RuntimeError('"'"'disposable endpoints not ready'"'"')
print('"'"'READY'"'"',json.dumps(ports))
'
```

Explicit environment: {}

Exit: 0; seconds: 0.17.

```text
pg 127.0.0.1:32778 b486e5c3ed90824811b93faf998cb6b068b74d8c898aef2ed2e6b2bcfb904552
qdrant 127.0.0.1:32779 089bfb9aa804f001a1bf1ce11a778203a254ba5c8472183d17afe09da20d3189
READY {"pg": "32778", "qdrant": "32779"}

```

### Fresh disposable database migration prerequisite

Command:

```sh
pnpm exec prisma migrate deploy --schema=apps/reel-indexing-service/prisma/schema.prisma
```

Explicit environment: {'REEL_INDEXING_DATABASE_URL': 'postgresql://recheck:local-recheck-only@127.0.0.1:32778/recheck'}

Exit: 0; seconds: 1.17.

```text
Prisma schema loaded from apps/reel-indexing-service/prisma/schema.prisma
Datasource "db": PostgreSQL database "recheck", schema "public" at "127.0.0.1:32778"

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

### Configured real local Qdrant/PostgreSQL integration

Command:

```sh
pnpm exec jest --runInBand --runTestsByPath apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts
```

Explicit environment: {'QDRANT_TEST_URL': 'http://127.0.0.1:32779', 'QDRANT_TEST_KEY': 'local-disposable-test-key', 'REEL_INDEXING_TEST_DATABASE_URL': 'postgresql://recheck:local-recheck-only@127.0.0.1:32778/recheck'}

Exit: 0; seconds: 7.38.

```text
[Nest] 1173415  - 10/27/2026, 8:38:30 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":10,"totalMs":100}
[Nest] 1173415  - 10/27/2026, 8:38:30 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":88,"sqlMs":9,"totalMs":97}
[Nest] 1173415  - 10/27/2026, 8:38:30 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":91,"sqlMs":8,"totalMs":99}
[Nest] 1173415  - 10/27/2026, 8:38:30 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":91,"sqlMs":8,"totalMs":99}
[Nest] 1173415  - 10/27/2026, 8:38:30 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":6,"totalMs":96}
[Nest] 1173415  - 10/27/2026, 8:38:30 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":87,"sqlMs":8,"totalMs":95}
[Nest] 1173415  - 10/27/2026, 8:38:30 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":87,"sqlMs":9,"totalMs":96}
[Nest] 1173415  - 10/27/2026, 8:38:30 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"unavailable","qdrantMs":0,"sqlMs":5,"totalMs":5}
[Nest] 1173415  - 10/27/2026, 8:38:31 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":88,"sqlMs":8,"totalMs":96}
[Nest] 1173415  - 10/27/2026, 8:38:31 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":6,"totalMs":96}
[Nest] 1173415  - 10/27/2026, 8:38:32 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"projection_incomplete","qdrantMs":43,"sqlMs":8,"totalMs":51}
[Nest] 1173415  - 10/27/2026, 8:38:33 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":8,"totalMs":97}
[Nest] 1173415  - 10/27/2026, 8:38:34 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"projection_incomplete","qdrantMs":43,"sqlMs":6,"totalMs":50}
[Nest] 1173415  - 10/27/2026, 8:38:34 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":7,"totalMs":97}
[Nest] 1173415  - 10/27/2026, 8:38:34 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":7,"totalMs":97}
[Nest] 1173415  - 10/27/2026, 8:38:34 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"hit_mismatch","qdrantMs":46,"sqlMs":7,"totalMs":53}
[Nest] 1173415  - 10/27/2026, 8:38:34 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"scope_changed","qdrantMs":95,"sqlMs":10,"totalMs":105}
[Nest] 1173415  - 10/27/2026, 8:38:35 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":85,"sqlMs":7,"totalMs":92}
Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total
Snapshots:   0 total
Time:        6.333 s, estimated 7 s
Ran all test suites within paths "apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.integration.spec.ts".

```

### Configured complete focused unit/architecture/integration run

Command:

```sh
pnpm exec jest --runInBand apps/reel-indexing-service/src apps/ai-service/src/application/clean-architecture.spec.ts apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts
```

Explicit environment: {'QDRANT_TEST_URL': 'http://127.0.0.1:32779', 'QDRANT_TEST_KEY': 'local-disposable-test-key', 'REEL_INDEXING_TEST_DATABASE_URL': 'postgresql://recheck:local-recheck-only@127.0.0.1:32778/recheck'}

Exit: 0; seconds: 9.29.

```text
[Nest] 1173692  - 10/27/2026, 8:38:50 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":93,"sqlMs":9,"totalMs":102}
[Nest] 1173692  - 10/27/2026, 8:38:50 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":8,"totalMs":97}
[Nest] 1173692  - 10/27/2026, 8:38:50 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":8,"totalMs":98}
[Nest] 1173692  - 10/27/2026, 8:38:50 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":9,"totalMs":99}
[Nest] 1173692  - 10/27/2026, 8:38:50 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":91,"sqlMs":8,"totalMs":99}
[Nest] 1173692  - 10/27/2026, 8:38:51 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":88,"sqlMs":7,"totalMs":95}
[Nest] 1173692  - 10/27/2026, 8:38:51 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":87,"sqlMs":8,"totalMs":96}
[Nest] 1173692  - 10/27/2026, 8:38:51 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"unavailable","qdrantMs":0,"sqlMs":4,"totalMs":4}
[Nest] 1173692  - 10/27/2026, 8:38:51 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":9,"totalMs":98}
[Nest] 1173692  - 10/27/2026, 8:38:51 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":7,"totalMs":96}
[Nest] 1173692  - 10/27/2026, 8:38:53 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"projection_incomplete","qdrantMs":44,"sqlMs":8,"totalMs":52}
[Nest] 1173692  - 10/27/2026, 8:38:53 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":86,"sqlMs":6,"totalMs":93}
[Nest] 1173692  - 10/27/2026, 8:38:54 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"projection_incomplete","qdrantMs":44,"sqlMs":6,"totalMs":50}
[Nest] 1173692  - 10/27/2026, 8:38:55 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":89,"sqlMs":6,"totalMs":95}
[Nest] 1173692  - 10/27/2026, 8:38:55 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":90,"sqlMs":6,"totalMs":96}
[Nest] 1173692  - 10/27/2026, 8:38:55 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"hit_mismatch","qdrantMs":48,"sqlMs":5,"totalMs":53}
[Nest] 1173692  - 10/27/2026, 8:38:55 PM     LOG [SemanticVectorSearch] {"backend":"postgres","fallback":"scope_changed","qdrantMs":93,"sqlMs":8,"totalMs":101}
[Nest] 1173692  - 10/27/2026, 8:38:55 PM     LOG [SemanticVectorSearch] {"backend":"qdrant","qdrantMs":88,"sqlMs":4,"totalMs":92}
[Nest] 1173692  - 10/27/2026, 8:38:55 PM    WARN [SemanticRecommendationServiceAdapter] AI embedding response did not include model/version identity; semantic recommendation is falling back to keyword/tag hybrid retrieval.
[Nest] 1173692  - 10/27/2026, 8:38:55 PM     LOG [DeterministicRetrievalEngineAdapter] [HierarchicalRetrievalShadow] {"directMs":0,"hierarchicalMs":0,"direct":2,"hierarchical":1,"overlapAtK":0.5,"jaccard":0.5}
[Nest] 1173692  - 10/27/2026, 8:38:55 PM    WARN [DeterministicRetrievalEngineAdapter] [RetrievalEngine] semantic planner failed closed: provider failure
[Nest] 1173692  - 10/27/2026, 8:38:55 PM    WARN [DeterministicRetrievalEngineAdapter] [HierarchyRollout] production hierarchy serving was requested but promotion is not approved; serving direct retrieval and forcing hierarchy shadow instead
[Nest] 1173692  - 10/27/2026, 8:38:56 PM     LOG [DeterministicRetrievalEngineAdapter] [HierarchicalRetrievalShadow] {"directMs":0,"hierarchicalMs":1,"direct":1,"hierarchical":1,"overlapAtK":0,"jaccard":0}
[Nest] 1173692  - 10/27/2026, 8:38:56 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=false confidence=0.90 issues=MEDIUM:RETRIEVAL_QUALITY
[Nest] 1173692  - 10/27/2026, 8:38:56 PM    WARN [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] advisory rejection reelId=reel-1: Advisory issue.
[Nest] 1173692  - 10/27/2026, 8:38:56 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=true confidence=0.98 issues=none
[Nest] 1173692  - 10/27/2026, 8:38:56 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=false confidence=0.92 issues=HIGH:GROUNDING
[Nest] 1173692  - 10/27/2026, 8:38:56 PM     LOG [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] reelId=reel-1 acceptable=false confidence=0.95 issues=HIGH:GROUNDING
[Nest] 1173692  - 10/27/2026, 8:38:56 PM    WARN [ValidatePersistedSemanticCandidateUseCase] [IndexQualityAgent] review unavailable; structural gate remains authoritative: agent unavailable
[Nest] 1173692  - 10/27/2026, 8:38:56 PM   ERROR [ProcessReelIndexJobUseCase] Index job job-1 failed: Visual provider rate limit or quota exhausted; retry this index attempt later: daily free allocation
[Nest] 1173692  - 10/27/2026, 8:38:56 PM   ERROR [ProcessReelIndexJobUseCase] Index job job-1 failed: temporary TEI timeout
[Nest] 1173692  - 10/27/2026, 8:38:57 PM   ERROR [CommitSemanticCandidateUseCase] [SemanticCommit] post-commit cleanup failed for attempt-2: SQL unavailable
[Nest] 1173692  - 10/27/2026, 8:38:57 PM     LOG [AnalyzeVisualFrameManifestUseCase] [VisualIndex] reelId=reel-1 completed=1 failed=0 sampled=1
[Nest] 1173692  - 10/27/2026, 8:38:57 PM    WARN [AnalyzeVisualFrameManifestUseCase] [VisualIndex] frame analysis skipped reelId=reel-1 timestampMs=0: Cloudflare Workers AI vision request failed with status 429: daily free allocation exhausted

Test Suites: 20 passed, 20 total
Tests:       109 passed, 109 total
Snapshots:   0 total
Time:        8.274 s, estimated 9 s
Ran all test suites matching apps/reel-indexing-service/src|apps/ai-service/src/application/clean-architecture.spec.ts|apps/ai-service/src/application/use-cases/evaluate-retrieval-benchmark.use-case.spec.ts|apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts|apps/content-service/src/infrastructure/adapters/semantic-recommendation-service.adapter.spec.ts.

```

### Owned disposable resources cleanup

Command:

```sh
python3 -c 'import subprocess,json
base=['"'"'docker'"'"','"'"'--host'"'"','"'"'unix:///var/run/docker.sock'"'"']
expected={'"'"'reel-qdrant-recheck-33e1-pg'"'"':'"'"'b486e5c3ed90824811b93faf998cb6b068b74d8c898aef2ed2e6b2bcfb904552'"'"','"'"'reel-qdrant-recheck-33e1-qdrant'"'"':'"'"'089bfb9aa804f001a1bf1ce11a778203a254ba5c8472183d17afe09da20d3189'"'"'}
for name,cid in expected.items():
 info=json.loads(subprocess.check_output(base+['"'"'inspect'"'"',name],text=True))[0]
 assert info['"'"'Id'"'"']==cid
 assert info['"'"'Config'"'"']['"'"'Labels'"'"']['"'"'velora.task'"'"']=='"'"'task_a5bbc1ba7caa'"'"'
 assert info['"'"'Config'"'"']['"'"'Labels'"'"']['"'"'velora.dispatch'"'"']=='"'"'ctx_33e1a04dcf92'"'"'
 assert all(m['"'"'Type'"'"']=='"'"'volume'"'"' and m['"'"'Destination'"'"']=='"'"'/var/lib/postgresql/data'"'"' for m in info['"'"'Mounts'"'"']),info['"'"'Mounts'"'"']
 subprocess.run(base+['"'"'rm'"'"','"'"'-fv'"'"',cid],check=True)
remaining=subprocess.check_output(base+['"'"'ps'"'"','"'"'-a'"'"','"'"'--filter'"'"','"'"'label=velora.dispatch=ctx_33e1a04dcf92'"'"','"'"'--format'"'"','"'"'{{.Names}}'"'"'],text=True)
assert not remaining.strip(),remaining
print('"'"'PASS: exact-ID/label/mount-checked owned container and anonymous-volume cleanup; no dispatch containers remain'"'"')
'
```

Explicit environment: {}

Exit: 0; seconds: 0.38.

```text
b486e5c3ed90824811b93faf998cb6b068b74d8c898aef2ed2e6b2bcfb904552
089bfb9aa804f001a1bf1ce11a778203a254ba5c8472183d17afe09da20d3189
PASS: exact-ID/label/mount-checked owned container and anonymous-volume cleanup; no dispatch containers remain

```

Final scope: 16 tracked modifications + 27 untracked files; 43 total. All 42 preexisting files unchanged during this retry. Only verifier-authored file: infra/qdrant/verification-recheck-report.md.

### Final integrity and report checks

Command:

```sh
python3 -c 'import pathlib,json,hashlib,subprocess
p=pathlib.Path('"'"'infra/qdrant/verification-recheck-report.md'"'"')
text=p.read_text();manifest=json.loads(text.split('"'"'\x60\x60\x60json\n'"'"',1)[1].split('"'"'\n\x60\x60\x60'"'"',1)[0])
for f,h in manifest.items():assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h,f
assert all(line==line.rstrip() for line in text.splitlines())
r=subprocess.run(['"'"'git'"'"','"'"'diff'"'"','"'"'--check'"'"'],text=True,capture_output=True);assert r.returncode==0,(r.returncode,r.stdout,r.stderr)
r2=subprocess.run(['"'"'git'"'"','"'"'diff'"'"','"'"'--no-index'"'"','"'"'--check'"'"','"'"'--'"'"','"'"'/dev/null'"'"',str(p)],text=True,capture_output=True)
assert r2.returncode==1 and not r2.stdout and not r2.stderr,(r2.returncode,r2.stdout,r2.stderr)
print('"'"'PASS: 42-file SHA continuity, report whitespace, git diff --check exit 0; report-only no-index --check exit 1 with zero diagnostics (new-file difference)'"'"')
'
```

Explicit environment: {}

Exit: 0; seconds: 0.04.

```text
PASS: 42-file SHA continuity, report whitespace, git diff --check exit 0; report-only no-index --check exit 1 with zero diagnostics (new-file difference)

```
