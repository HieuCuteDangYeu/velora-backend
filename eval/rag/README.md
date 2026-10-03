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
The flag records the exact bounded source blocks under existing RagTrace
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
