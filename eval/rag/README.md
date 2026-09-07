# Ragas evaluation

This tooling-only package is the canonical evaluator for repository RAG experiments. It uses Ragas 0.4.3's current `Dataset` and `@experiment().arun(...)` APIs. Python is not imported by the AI service, indexing service, Docker production stack, or ordinary repository tests.

## Ownership boundary

Ragas owns versioned evaluation datasets, experiment results, semantic metrics, deterministic metrics, operational/cost aggregation, category slices, comparisons, and reports. The TypeScript runner remains responsible for production API execution, exactly one primary request per case, `benchmarkRunId` state, `IN_FLIGHT` protection, no-resend reconciliation, and RagTrace extraction. NestJS/LangGraph remains the application under test.

The runner and `normalize-existing-ami-rag-retest.cjs` emit `rag-eval-result-v1`; they do not determine correctness. The deprecated `summarize-existing-ami-rag-retest.cjs` is now only a compatibility alias for normalization.

## Environment

Install [uv](https://docs.astral.sh/uv/) and run `uv sync` in this directory. The lock pins Ragas 0.4.3. Generated experiments and reports, private live traces, virtual environments, and caches are ignored by Git.

No evaluation dependency is a production dependency. `pnpm eval:rag:test` and offline mode perform zero LLM calls, zero production requests, and zero database writes.

## Datasets

- `rag-frozen-ami-v1` and `rag-frozen-ami-v2`: immutable eight-case AMI datasets with the same questions, answers, reel scope, evidence modality, time intervals, and curated concepts; v2 records new production reel and index provenance.
- `rag-generalization-v1`: 65 router, 20 sufficiency, 15 verifier, and four generic retrieval/citation/access/provider rows. Tags are analysis metadata only.

The JSONL files under `datasets/` are the source of truth. Existing Jest control-plane tests read their fixture payloads from the same generic dataset. To add a case, add safe, non-production fixture data, increment the dataset version when semantics change, update the declared count, and add contract tests. Never place credentials, private production text, or benchmark answers in runtime code.

## Commands

```sh
pnpm eval:rag:offline --dataset rag-generalization-v1
pnpm eval:rag:live --dataset rag-frozen-ami-v1 --variant production \
  --definitions-report <safe-definitions.json> --confirm-live
pnpm eval:rag:report --run <run-id>
pnpm eval:rag:compare --baseline <run-a> --candidate <run-b>
pnpm eval:rag:persist --run <completed-run-id>
pnpm eval:rag:test
pnpm eval:rag:capacity-check --confirm-one-call
```

## Containerized evaluator

The evaluator has a separate `rag-eval` image and is available only through
the Compose `eval` profile. Normal `docker compose up -d` does not start it.
The image contains Node 20/pnpm, the compiled AI adapter and required Prisma
clients, Python 3.12, uv, and the locked Ragas environment; it is not part of
the `ai-service` image.

Build and run commands on the evaluation host use the repository tree and keep
state on the host:

```sh
docker compose --profile eval build rag-eval
docker compose --profile eval run --rm --no-deps rag-eval pnpm eval:rag:test
docker compose --profile eval run --rm --no-deps rag-eval \
  pnpm eval:rag:offline --dataset rag-generalization-v1
```

`eval/rag/results`, `eval/rag/experiments`, and
`test-data/reel-integration/ami/reports` are bind-mounted so Ragas reports and
the exactly-once AMI runner state survive container removal. Set
`RAG_EVAL_RESULTS_DIR`, `RAG_EVAL_EXPERIMENTS_DIR`, and
`RAG_EVAL_AMI_REPORT_DIR` only when the host uses different persistent paths.

The default `eval/rag/eval.env.example` contains no credentials. For live work,
set `RAG_EVAL_ENV_FILE` to a server-side evaluator env file for additional
evaluation-only values. Provider diagnostics still require the explicit
operator-observed `--runtime-config-snapshot`, a matching `--production-sha`,
and `CONFIG_MATCH=YES` before any provider call.

Offline mode uses explicit `FIXTURE` normalized results and never creates provider clients. Live mode is opt-in, invokes the existing TypeScript runner, refuses unsupported datasets, and evaluates only completed/reconciled rows. A failed or missing response remains in the denominator with a failure status; semantic metrics may be null.

Completed evaluation artifacts can be imported after a separately authorized
run with `pnpm eval:rag:persist --run <run-id>`. The importer reads only the
canonical `summary.json` and `cases.jsonl`, verifies the dataset bytes, stores
sanitized metrics/provenance, and never stores questions, answers, or retrieved
context. It requires `RAG_EVAL_PERSIST_CONFIRM=YES` and an explicit
`REEL_INDEXING_DATABASE_URL`; it does not fall back to another database
variable. Repeating an identical artifact is an idempotent no-op, while a
different artifact for an existing `benchmarkRunId` is rejected.

Capacity check makes exactly one cheap production-model request and never launches a benchmark. It requires explicit confirmation and Cloudflare credentials. Do not repeat it while an account-limit response is already known.

The capacity check uses `RAG_EVAL_CAPACITY_MODEL` (default `@cf/openai/gpt-oss-20b`) through a separate no-retry client. It does not construct the Ragas judge, invoke the judge model, or call embeddings. Run production-model deterministic gates and persist normalized frozen execution results before invoking semantic judge metrics.

## Metrics and hard gates

Current Ragas built-ins are wired for Faithfulness, Factual Correctness, Answer Relevancy (reported as response relevancy), Context Precision, and Context Recall. Tool Call Accuracy is order-insensitive, Tool Call F1 and Agent Goal Accuracy are supported when a structured trajectory exists. Native multimodal metrics are available only when original image inputs exist; textual visual evidence uses the deterministic modality metric and is never passed off as an image.

Exact IDs drive Recall@1/3/5/10, MRR, NDCG@5/10, evidence hit rate, citation precision/recall, wrong-reel/modality counts, router contract accuracy, modality accuracy, and access violations without an LLM. The curated frozen-answer rule remains a custom deterministic metric. Semantic scores supplement these rules and cannot override them. Any access-control violation fails the experiment hard gate.

Retrieval metrics measure whether relevant evidence was ranked and cited. Semantic metrics judge response grounding/correctness only when their required inputs are actually present. Null is retained when a metric is inapplicable or its judge is unavailable.

## Judge configuration

Judge models are evaluation roles, never production RAG roles:

```sh
RAG_EVAL_JUDGE_MODEL=@cf/...
RAG_EVAL_EMBEDDING_MODEL=@cf/...
RAG_EVAL_CLOUDFLARE_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1
```

The adapter uses Ragas' current factory with an OpenAI-compatible Cloudflare client. It never silently falls back to `AI_ANSWER_MODEL` or `AI_VERIFIER_MODEL`. Judge token usage and cost use `EVALUATION_JUDGE` scope and remain separate from `QUERY` and `INDEXING` costs.

## Pricing, reports, and comparisons

`config/cloudflare-pricing-v1.json` is a versioned snapshot of official Workers AI pricing. Update it only after checking the linked Cloudflare source, change the version and verification date, and add pricing tests. Unknown models or missing usage produce `costUsd=null` plus a warning, never a fabricated zero. Provider token counts remain labeled `PROVIDER`; explicit estimates are labeled `ESTIMATED`; absent usage is `UNAVAILABLE`.

Each run writes one schema family: `summary.json`, `cases.jsonl`, and `summary.md`. Query, indexing, and evaluation-judge costs stay separate. End-to-end latency uses actual wall time rather than summing potentially parallel node durations; role latency comes from individual model-call diagnostics. Reports include dataset/variant metadata and per-tag slices. `compare` calculates deltas without overwriting either run.

Live benchmark reconciliation remains TypeScript-owned. If a case is `IN_FLIGHT`, inspect/reconcile it through the runner; never resend it from Python. Once Workers capacity is restored, use the Ragas datasets and live command for model comparison, sufficiency/verifier gates, and a new frozen-eight run rather than returning to the legacy scorer.

# Live configuration provenance and router calibration

Control-plane runs require `--config` pointing to a versioned candidate JSON.
The candidate values override the selected credential env and inherited env
without mutating `process.env`. Runtime `AiApplicationConfigAdapter` resolves
the same values consumed by the actual use case and Cloudflare adapter. Missing
role timeout/model/budget is rejected before requests, not defaulted by Ragas.
Reports and atomic per-case `observations.json` retain the effective snapshot,
Git SHA, dataset/config hashes, candidate roles, execution overrides, and subset.
Existing run directories are never resent automatically after interruption.

The previous `router-gpt-oss-20b-20260826` and `router-glm-4-7-flash-20260826`
runs are `INVALID_CONFIG_TIMEOUT_8000`, not model-quality baselines. Their
credential env `.env.test.local` omitted router timeout; no inherited value was
present, so the runtime adapter supplied its 8000 ms default. `.env` (GLM, 8s,
no fallback) and `.env.example` (GPT20, GLM fallback, 45s/60s) were not loaded.
Model CLI overrides were the executed model; they did not select runtime roles.

Candidate `config/router-calibration-v1.json` explicitly records the tracked
45s/60s, GPT20/GLM candidate without editing runtime env or deployed roles. Each
comparison overrides only the executed model, disables fallback, and uses the
direct provider (gateway disabled) for exactly one request per case. These
transport/fallback overrides are visible and are not production-chain validation.

From the repository root, after offline checks and one successful capacity check:

```sh
pnpm eval:rag:control-plane --mode ROUTER --model @cf/openai/gpt-oss-20b --config eval/rag/config/router-calibration-v1.json --subset harness --run-id UNIQUE-ID
```

Repeat with GLM on the same six versioned generic cases. Only if all calls
complete structurally proceed to the separate ten-case `latency` subset for
each model. Its predeclared comfort bound is p95 and max < 36000 ms (80% of
45000 ms). These are harness/latency checks, not production timeout selection
from six cases, and their outputs are not reused in a full comparison. Omit
`--subset` for the 65-case comparison only after both calibration gates pass.
`--router-timeout-ms` is an explicit, recorded override for parity tests or an
authorized experiment. Do not increase timeout automatically after failure.

`eval:rag:live` uses public backend APIs, not the local structured-LLM runner.
Local env cannot configure a remote deployment. It therefore requires an
operator-supplied `--runtime-config-snapshot` whose `gitSha` matches explicit
`--production-sha`, whose `datasetVersion` matches the requested dataset, and
which includes the router snapshot fields and a `roles` map with each role's
model/timeoutMs/maxCompletionTokens. This is labeled operator attestation, not
claimed as remotely observed config. Deterministic outputs are saved before
any optional semantic judge, which is forbidden on a failed gate.
