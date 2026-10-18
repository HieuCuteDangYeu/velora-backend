# RAG fixtures

The JSONL files under `datasets/` are provider-free fixtures used by focused
AI and reranker contract tests. Production tracing and evaluation are owned by
self-hosted Langfuse; there is no Python evaluator runtime here.

Import the provisional scraped candidate set with:

```sh
pnpm ops:langfuse:dataset:import --input eval/rag/datasets/rag-scraped-v1-provisional.jsonl --dry-run
```

The importer requires exactly 220 `GENERATED_CANDIDATE` rows and preserves Reel
IDs, evidence IDs, modality, and provenance hashes without making production
RAG requests.

## Evaluation v2

New runs store a frozen input/reference snapshot and an evaluator version. The
legacy same-Reel evidence score is named `reel_evidence_proxy_recall`; it is
separate from source-ID retrieval recall, MRR, NDCG, generation-evidence coverage
and citation modality precision. Missing trace/context data is unavailable,
never scored as a retrieval failure or reconstructed from the current index.

Replay saved answers offline into **new** files:

```sh
pnpm ops:rag:audit \
  --state .benchmarks/langfuse-live-220-20261002-14.state.json \
  --dataset eval/rag/datasets/rag-scraped-v1-provisional.jsonl \
  --output .benchmarks/new-evaluation-v2.json \
  --review .benchmarks/new-human-review.json \
  --enriched-state .benchmarks/new-frozen-state-v2.json
```

The review file contains `PENDING` candidates, not accepted human labels. A
reviewer must verify original source evidence and resolve ambiguous questions
before creating a reviewed dataset. Keep all questions from one Reel/Series in
one development or holdout split. The live runner accepts `--dataset <name>`
with an explicit `--expected-cases <count>` for a reviewed dataset; it sends only
the question to the application, never the expected answer or source IDs.

For a future authorized experiment, enable `AI_RAG_CAPTURE_EVALUATION_CONTEXT`
only in its isolated evaluation environment. Default tracing remains redacted.
The flag records the exact bounded source blocks under the Langfuse workflow root
diagnostics, with original IDs, timestamps and index versions. It does not add
private context or chunk IDs to public chat responses. Content still resolves
Reel access and index RPCs remain constrained to that access.

Export matching traces with `scripts/ops/export-rag-traces.cjs`, passing the
state as `--runner-report` and explicitly selecting
`--include-evaluation-context`. Give that export to the offline audit with
`--traces <export.jsonl>` and a new `--enriched-state` path. Trace identity and
dataset fingerprints must match. Content exports are restricted local
artifacts; do not commit them.

`pnpm ops:rag:judge --state <enriched-state.json>` uses frozen references and
captured generation evidence. Its default output is `*.semantic-v2.json` and
its quota ledger has a separate v2 namespace. It runs **four independent judge
calls per eligible case**: relevance sees no reference, faithfulness sees no
reference, and context completeness sees no generated answer. The default
judge is pinned to Groq; changing provider is an explicit controller option.
Invalid or absent dimensions become unavailable. Case scores attach to their
trace, rather than attributing every case to the experiment aggregate. Human
judge calibration remains required before these scores become a release gate.

To diagnose retrieval versus answering, compare the normal context with
reviewed original evidence in an isolated answer experiment. Oracle evidence
belongs only in that experiment; never use gold references as production
memory or runtime retrieval hints. Do not reindex, change embeddings, enable
production hierarchy, or add graph/memory engines without measured residual
failures. Memory recall now honors the router's decision for Reel questions.

## Broader coverage candidate dataset

`scripts/ops/build-rag-coverage-dataset.cjs` builds 400 main cases (240 development,
160 held out) and 40 isolated operational cases from an owner-service snapshot.
The snapshots, source text, fixture definitions and generated rows stay in a
restricted `.benchmarks/` directory rather than Git. All labels remain
`GENERATED_CANDIDATE`; approving the dataset design does not certify answer labels.

```sh
node scripts/ops/build-rag-coverage-dataset.cjs <source-snapshot.json> <new-output-dir>
node --test scripts/ops/rag-coverage-dataset.test.cjs
```

`publish-rag-coverage-dataset.cjs` publishes separate immutable candidate datasets
using the Langfuse CLI, verifies every input/reference/metadata hash by readback,
and refuses conflicting or ambiguous upserts. It requires an explicitly supplied
private credential file and installed CLI entry point. The old 50-case regression
set remains a separate development asset; it is not promoted to held out.

`rag-coverage-worker.cjs` runs the compiled real AI workflow in an isolated Nest
process with frozen Content/Index/memory ports. It permits model providers but
disables owner-service RPCs, persistence and publication. Only question, identity
and actual fixture memory enter runtime input; reference answers remain evaluator
data. Fixture search uses lexical ranking, so replay retrieval scores do not
measure live vector retrieval or production authorization enforcement. Use live
owner-service integration checks separately for those properties.

Before a release benchmark, review image-backed labels and judge calibration,
report unavailable/degraded denominators, and keep held-out cases out of tuning.
This English candidate set has no verified production-traffic examples. Source
families are separated from the latest 50-case tuning set, but some sources were
seen in the historical 220-case run. It is not a historically pristine holdout.

## Monitoring store

New RAG monitoring traces live only in Langfuse. Each `rag.workflow` root
contains a versioned `ragTrace` diagnostic snapshot in its output, with stage
observations and per-call model/token usage beneath it. Prompts, answers,
queries, drafts, and evidence text remain redacted by default. Monitoring failures
must not fail the chat request. Aggregate monitoring events remain available.

Before deploying the migration, configure the AI service with
`LANGFUSE_ENABLED=true`, project keys, and `LANGFUSE_BASE_URL`.
`LANGFUSE_SAMPLE_RATE=1` is the default and is required for complete evaluation
exports. An existing explicit `0.1` setting still samples 10%; change it to `1`
when full coverage is required. Disabled tracing or lost/unsampled traces have no
PostgreSQL fallback and cause missing provenance, rather than fabricated metrics.
Allow SDK ingestion to settle before exporting; never replay requests to obtain
missing traces. Readiness checks now use Langfuse workflow observations, so use a
release boundary after this migration. Readers use cursor pagination through the
Langfuse v2 observations API (Langfuse server v4 required).

Migration `20261003130000_drop_retired_rag_monitoring_tables` removes the PostgreSQL
`RagTrace` and `RagHierarchyShadowObservation` tables, including their historical
rows and indexes. Applied migration files remain unchanged. New exports use Langfuse only; the PostgreSQL export option is retired.
If historical traces need to be retained, archive them before applying this migration.
Deploy the Langfuse-only writer and readers with this migration; an older AI service
still attempts to write the removed tables. Existing user/conversation memory
tables remain intact. Hierarchy comparison diagnostics now live in
`rag.hierarchy-shadow` Langfuse observations, including the original source IDs,
latencies, overlap and Jaccard metrics. Query text is excluded by default.
Hierarchy label-template export requires `LANGFUSE_CAPTURE_CONTENT=true` when
capturing an isolated evaluation, and fails explicitly for redacted queries. Apply the migration
only after the existing benchmark finishes and its results are retained.
