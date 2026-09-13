# Ragas evaluation

This tooling-only package is the canonical evaluator for repository RAG experiments. It uses Ragas 0.4.3's current `Dataset` and `@experiment().arun(...)` APIs. Python is not imported by the AI service, indexing service, Docker production stack, or ordinary repository tests.

## Ownership boundary

Ragas owns versioned evaluation datasets, experiment results, semantic metrics, deterministic metrics, operational/cost aggregation, category slices, comparisons, and reports. The TypeScript runner remains responsible for production API execution, exactly one primary request per case, `benchmarkRunId` state, `IN_FLIGHT` protection, no-resend reconciliation, and RagTrace extraction. NestJS/LangGraph remains the application under test.

The runner and `normalize-existing-ami-rag-retest.cjs` emit `rag-eval-result-v1`; they do not determine correctness. The deprecated `summarize-existing-ami-rag-retest.cjs` is now only a compatibility alias for normalization.

## Environment

Install [uv](https://docs.astral.sh/uv/) and run `uv sync` in this directory. The lock pins Ragas 0.4.3. Generated experiments and reports, private live traces, virtual environments, and caches are ignored by Git.

No evaluation dependency is a production dependency. `pnpm eval:rag:test` and offline mode perform zero LLM calls, zero production requests, and zero database writes.

## Datasets

- `rag-frozen-ami-v1`, `rag-frozen-ami-v2`, and `rag-frozen-ami-v3`: immutable eight-case AMI datasets with the same questions, answers, reel scope, evidence modality, time intervals, and curated concepts; v2 records the prior production reel/index provenance and v3 records the canonical self-hosted BGE-M3 production index provenance.
- `rag-generalization-v1`: 65 router, 20 sufficiency, 15 verifier, and four generic retrieval/citation/access/provider rows. Tags are analysis metadata only.

The JSONL files under `datasets/` are the source of truth. Existing contract tests read their fixture payloads from the same generic dataset. To add a case, add safe, non-production fixture data, increment the dataset version when semantics change, update the declared count, and add contract tests. Never place credentials, private production text, or benchmark answers in runtime code.

## Commands

```sh
pnpm eval:rag:offline --dataset rag-generalization-v1
pnpm eval:rag:live --dataset rag-frozen-ami-v1 --variant production \
  --definitions-report <safe-definitions.json> --confirm-live
pnpm eval:rag:report --run <run-id>
pnpm eval:rag:compare --baseline <run-a> --candidate <run-b>
pnpm eval:rag:persist --run <completed-run-id>
pnpm eval:rag:reranker
pnpm eval:rag:test
pnpm eval:rag:capacity-check --confirm-one-call
pnpm eval:rag:preflight --tpd-limit-attestation <limit-json> \
  --tpd-window-attestation <window-json> --ledger-path <ledger-jsonl>
pnpm eval:rag:preflight --tpd-cost-attestation <cost-json> \
  --pricing-path eval/rag/config/groq-pricing-v1.json --ledger-path <ledger-jsonl>
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
and `CONFIG_MATCH=YES` before any provider call. Live frozen runs automatically
export a sanitized, read-only RagTrace artifact and fail closed unless exactly
one trace exists for every completed case.

Offline mode uses explicit `FIXTURE` normalized results and never creates provider clients. Live mode is opt-in, invokes the existing TypeScript runner, refuses unsupported datasets, and evaluates only completed/reconciled rows. A failed or missing response remains in the denominator with a failure status; semantic metrics may be null.

Completed evaluation artifacts can be imported after a separately authorized
run with `pnpm eval:rag:persist --run <run-id>`. The importer reads only the
canonical `summary.json` and `cases.jsonl`, verifies the dataset bytes, stores
sanitized metrics/provenance, and never stores questions, answers, or retrieved
context. It requires `RAG_EVAL_PERSIST_CONFIRM=YES` and an explicit
`REEL_INDEXING_DATABASE_URL`; it does not fall back to another database
variable. Repeating an identical artifact is an idempotent no-op, while a
different artifact for an existing `benchmarkRunId` is rejected.

The provider-free reranker qualification uses the versioned safe fixture set
`rag-reranker-generalization-v1`. Run `pnpm eval:rag:reranker` only when the
profile-gated local TEI reranker is available; the harness disables the
reranker fallback so a passing result always represents the actual MiniLM
resource. Its two-case result is a small qualification gate, not a statistical
reliability claim.

Capacity check makes exactly one cheap production-model request and never launches a benchmark. It requires explicit confirmation and Cloudflare credentials. Do not repeat it while an account-limit response is already known.

The Groq preflight is separate from the Cloudflare capacity check. It makes only
small provider probes and never calls the production RAG endpoint. It treats
`x-ratelimit-*-tokens` as rolling TPM and checks only the next operation's
headroom, while `x-ratelimit-*-requests` is RPD rather than TPD. The existing
`JudgeUsageTracker` remains responsible for concurrency, the 6,000 TPM target,
reset waits, Retry-After, and bounded transient retries throughout a semantic
run. TPD is not inferred from provider headers.

Token-window preflight requires two fresh, operator-supplied artifacts for
every model being probed:

1. An independently observed organization TPD limit (`TPD_LIMIT`).
2. A current-window usage baseline (`TPD`) plus the persistent evaluator ledger.

The limit artifact may have this shape:

```json
{
  "schemaVersion": "groq-tpd-limit-attestation-v1",
  "provider": "groq",
  "scope": "TPD_LIMIT",
  "source": "groq-console-organization-limits",
  "observedAt": "2026-09-13T00:00:00Z",
  "models": {
    "openai/gpt-oss-120b": {
      "dailyLimitTokens": 200000
    }
  }
}
```

The current-window artifact may use an explicitly observed fresh window:

```json
{
  "schemaVersion": "groq-tpd-window-attestation-v1",
  "provider": "groq",
  "scope": "TPD",
  "source": "operator-observed-fresh-window",
  "observedAt": "2026-09-13T00:00:00Z",
  "models": {
    "openai/gpt-oss-120b": {
      "dailyLimitTokens": 200000,
      "usageSinceWindowStartTokens": 0,
      "plannedFullRunTokens": 54048
    }
  }
}
```

When the usage console exposes only precise organization-wide model cost, a
cost-derived upper-bound artifact can be used instead of a token-count window
baseline. It must carry the underlying decimal precision and an operator
confirmation that the reporting-delay quiet period was observed:

```json
{
  "schemaVersion": "groq-tpd-cost-upper-bound-attestation-v1",
  "provider": "groq",
  "scope": "TPD",
  "source": "groq-console-organization-usage",
  "observedAt": "2026-09-13T00:15:00Z",
  "organizationScope": "all-projects",
  "model": "openai/gpt-oss-120b",
  "dailyLimitTokens": 200000,
  "observedOrganizationModelCostUsd": "0.0200000",
  "costValueSource": "groq-console-usage-raw",
  "costDecimalPlaces": 7,
  "rateLimitedTokenPriceFloorUsdPerMillion": "0.15",
  "consoleMaxReportingDelaySeconds": 900,
  "verifiedQuietPeriodSeconds": 900,
  "quietPeriodStatus": "operator-confirmed-no-known-groq-traffic",
  "plannedFullRunTokens": 54048
}
```

The tracked `config/groq-pricing-v1.json` snapshot is validated for official
source, freshness, uncached input price ($0.15/M), cached input price
($0.075/M), output price ($0.60/M), and cached-token rate-limit semantics.
The default pricing snapshot freshness window is 30 days and is configurable
with `RAGAS_GROQ_PRICING_MAX_AGE_SECONDS`.
The evaluator uses decimal arithmetic only:
`ceil(cost / 0.15 * 1,000,000)` is the maximum possible rate-limited token
usage compatible with the observed cost. A visible rounded value such as
`"0.02"` is rejected because it cannot prove the required $0.0218928 boundary.
With the 200,000-token limit and 54,048-token planned run, the exact boundary
is `0.0218928`; the boundary itself passes and any greater precise value fails.
The optional `TPD_LIMIT` artifact is cross-checked when supplied, while the
cost artifact still must state the current 200,000-token limit.
The cost baseline is persisted in the TPD ledger as a non-counting epoch;
subsequent evaluator requests are counted after the observation timestamp.

For a non-fresh window, include an operator-proven `windowStartedAt` and the
known usage since that boundary. The evaluator then calculates
`dailyLimitTokens - usageSinceWindowStartTokens - ledgerUsage` and requires at
least `plannedFullRunTokens` (54,048 by default). It never automatically resets
the ledger because the provider's exact TPD reset boundary is not assumed.

The ledger records only safe request metadata and token counts, including
failed/retried requests. Provider usage is used when available; otherwise the
reserved input/output budget plus safety tokens is counted as a conservative
upper bound. Request IDs make repeated writes idempotent, and file locking keeps
concurrent evaluator processes from corrupting the ledger.

The attestation and ledger are intentionally not committed with credentials or
production data. A limit-only artifact, stale/incomplete evidence, a legacy
`dailyRemainingTokens` artifact, or header-derived TPD evidence produces an
unknown gate and prevents a frozen run from starting.

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

For an evaluation-only non-Cloudflare judge, the existing provider selector also
supports Groq with the local TEI embedding service:

```sh
RAG_EVAL_JUDGE_PROVIDER=groq
RAG_EVAL_JUDGE_MODEL=openai/gpt-oss-120b
RAG_EVAL_EMBEDDING_PROVIDER=tei
RAG_EVAL_EMBEDDING_MODEL=BAAI/bge-m3
RAG_EVAL_TEI_EMBEDDING_BASE_URL=http://127.0.0.1:<forwarded-port>/v1
RAGAS_JUDGE_CONCURRENCY=1
RAGAS_GROQ_TPM_LIMIT=8000
RAGAS_GROQ_TPM_TARGET=6000
RAGAS_JUDGE_TIMEOUT_SECONDS=120
RAGAS_MAX_COMPLETION_TOKENS=512
```

This path uses `GROQ_API_KEY`/`GROQ_BASE_URL` for the judge and an
OpenAI-compatible `/v1/embeddings` endpoint backed by the self-hosted TEI
service. Groq returned structured-output truncation at 256 tokens in the
accepted evaluation attempt, so this path defaults to 512 while preserving the
explicit `RAGAS_MAX_COMPLETION_TOKENS` override. It does not fall back to
Cloudflare or production RAG models.

Live semantic runs persist metric-level judge checkpoints at
`RAGAS_JUDGE_CHECKPOINT_PATH`, or beside the result root by default. A
checkpoint is bound to the source run, production SHA, provider, model, and
evaluator revision; only unavailable metrics are eligible for resume.
Each external judge request has a bounded timeout; timeout failures are recorded
and use the same bounded transient retry policy as network failures. Account-level
daily quota failures are recorded as permanent `ACCOUNT_LIMITED` errors and are
not retried.

When evaluating an already accepted production run, pass `--resume`,
`--source-summary`, and `--trace-file`. The evaluator loads the saved runner
report directly and does not contact the production RAG API.

## Pricing, reports, and comparisons

`config/cloudflare-pricing-v1.json` is a versioned snapshot of official Workers AI pricing. Update it only after checking the linked Cloudflare source, change the version and verification date, and add pricing tests. Unknown models or missing usage produce `costUsd=null` plus a warning, never a fabricated zero. Provider token counts remain labeled `PROVIDER`; explicit estimates are labeled `ESTIMATED`; absent usage is `UNAVAILABLE`.

Each run writes one schema family: `summary.json`, `cases.jsonl`, and `summary.md`. Query, indexing, and evaluation-judge costs stay separate. End-to-end latency uses actual wall time rather than summing potentially parallel node durations; role latency comes from individual model-call diagnostics. Reports include dataset/variant metadata and per-tag slices. `compare` calculates deltas without overwriting either run.

Live benchmark reconciliation remains TypeScript-owned. If a case is `IN_FLIGHT`, inspect/reconcile it through the runner; never resend it from Python. Once Workers capacity is restored, use the Ragas datasets and live command for model comparison, sufficiency/verifier gates, and a new frozen-eight run rather than returning to the legacy scorer.

# Live configuration provenance

Historical model-calibration artifacts remain versioned for provenance; they
are not part of the production evaluation path. Live evaluation requires an
operator-supplied runtime snapshot whose `gitSha` matches the explicit
`--production-sha`, whose dataset version matches the requested dataset, and
which records every role's model, timeout, and completion budget. This is an
attestation of the deployed configuration, not a claim that the local
evaluator can observe a remote process directly.

The TypeScript runner owns backend execution, exactly-once state, and
reconciliation. It records the effective snapshot, Git SHA, dataset/config
hashes, candidate roles, and execution overrides in the run artifacts. Existing
run directories are never resent automatically after interruption.

The evaluation judge remains isolated from production RAG. Its Cloudflare
adapter is used only when a separately authorized semantic evaluation is run;
it is not imported by the AI service. Deterministic results are persisted
before any optional judge metrics, and a failed deterministic hard gate forbids
judge execution.
