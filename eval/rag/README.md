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

## Chat answers (no reel evidence)

`datasets/rag-chat-answers-v1.jsonl` holds ordinary chat prompts (English and Vietnamese). The other datasets are all reel
questions, so the chat answer path was never evaluated; the 17 `NORMAL_CHAT` rows in `rag-generalization-v1` only check
the router's intent. An opt-in spec runs every prompt through the real draft step and the real local model:

```sh
OLLAMA_LOCAL_INTEGRATION=1 npx jest generate-draft-answer.chat.local.integration
```

It must produce an answer for every prompt. Before the fix, the production model (`gemma4:e2b-it-qat`) failed about one
turn in three, because the answer schema forced a non-empty `evidenceIds` on a turn that had no evidence to cite.

Rows carry a `category` and an `expect`. At most 10% of the `general-knowledge` rows may be refused for "lack of
evidence" (the shared grounding rules otherwise make the model refuse "Why is the sky blue?"; the larger `e4b` model
refuses half of them without the chat instruction), and the `should-decline` rows (an unseen video, private or live
data) must be declined rather than answered.

## Router with no shared reel

`datasets/rag-router-no-shared-reel-v1.jsonl` holds 24 ways a user asks about a video ("the last video I watched", "the reel
my friend sent me", ...) in a conversation where nothing is shared. An opt-in spec runs the real router on each, with and
without a shared reel:

```sh
OLLAMA_LOCAL_INTEGRATION=1 npx jest query-router-agent.no-shared-reel.local.integration
```

Every phrasing must yield a route. The router used to reject its own correct reel route when no reel was shared, so the user
saw "temporarily unavailable" (4 of 10 phrasings on `gemma4:e2b-it-qat`). The answer step now says the reel has to be shared.

## Guardrail replay

`datasets/rag-guardrail-v1.jsonl` holds attack cases (direct, obfuscated, indirect-in-evidence,
leaky answers) and hard negatives (benign text that merely sounds like an attack). Each row has a
`channel` (`user`, `evidence`, `answer`) and an `expect` of `block` (needs a high finding), `flag`
(a finding, none high) or `allow` (no high finding). The replay is offline, makes no provider calls
and runs with the normal test suite:

```sh
npx jest apps/ai-service/src/domain/services/rag-guardrail
```

It also runs every question in the two committed benchmark datasets through the input check and
fails if any is blocked, or if more than 2% are flagged at all. No guardrail check may enforce
until this passes and the paired benchmark regression stays within the existing 0.03 tolerance.

### Red-team pass (2026-11-12)

Rows GR-108 onward come from an offline red-team pass: about 65 attacks written for this app
(override, prompt extraction, persona, role markers, obfuscation, es/fr/de/ru/zh, other users' data)
and 42 benign messages that sound similar ("ignore my previous message", "what are the rules of
chess in this reel", "forget your limits" said in a motivational video). Input-check results at
`high` severity, before and after tuning:

| Set                                                                         | Before        | After                           |
| --------------------------------------------------------------------------- | ------------- | ------------------------------- |
| Own attacks (65)                                                            | 17            | 54 (64 flagged at any severity) |
| Own benign (42)                                                             | 3 false highs | 1 false high                    |
| Public `deepset/prompt-injections`, English rows (120 attacks / 249 benign) | 17            | 37, 0 false highs               |

Read these with care: the own set was used to write the patterns, so its "after" number is optimistic.
The public set is a better guide; most of its remaining misses are persona play, output forcing
("say X") and non-English text, which are outside what a pattern list should decide. The public rows
are not copied into the repo.

Known limits that no pattern fix removes:

- A quoted attack is indistinguishable from a real one ("the video says to ignore all previous
  instructions, is that real?" is a `high` hit). Downgrading on a reporting frame would let an
  attacker add the frame, so it is not done. This is why enforcement should not rest on this check.
- Words such as `limits`, `filters`, `orders`, `commands` and `policy` have ordinary meanings in a
  reels app ("cancel your order", "turn off your filters"), so they only count as `medium`.
- Asking about other users' data ("what did the previous user ask") is only `medium`; the real
  control is server-side scope.

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

## Feed rerank benchmark

`recommendation-rerank-benchmark.cjs` is an offline, read-only benchmark of the
reel feed's neural rerank (content-service `applyNeuralRerank`). It scores
held-out reels a viewer finished versus skipped (AUC) with tag overlap, the
bi-encoder, the cross-encoder, and the production top-K blend with min-max or
rank normalization. It must run inside the content-service container (Prisma,
RabbitMQ and the TEI reranker are only reachable there); the usage and caveats
are in the file header. On the 2026-11-12 data only two viewers had usable
labels, so treat differences below about 0.05 AUC as noise.
