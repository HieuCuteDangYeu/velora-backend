"""Normalize the TypeScript exactly-once runner's completed/reconciled rows."""

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

from rag_eval.schemas import EvaluationRow, NormalizedExecutionResult

SEMANTIC_CONTEXT_SCHEMA = "rag-eval-enriched-context-v1"

REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
RUNNER = REPOSITORY_ROOT / "scripts/ops/run-existing-ami-rag-retest.cjs"

_DATABASE_URL_RE = re.compile(
    r"\b(?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\/[^\s\"']+", re.IGNORECASE
)
_BEARER_RE = re.compile(r"\bBearer\s+[^\s,;]+", re.IGNORECASE)
_COOKIE_HEADER_RE = re.compile(
    r"(?im)(\b(?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]*?"
    r"(?=\s+[A-Za-z][A-Za-z_-]*\s*[:=]|\s*$)"
)
_SENSITIVE_VALUE_RE = re.compile(
    r"(?ix)("
    r"(?:\"|')?(?:authorization|proxy-authorization|password|secret|token|"
    r"access[_-]?token|refresh[_-]?token|api[_-]?key|database[_-]?url|"
    r"cloudflare[_-]?api[_-]?token|content[_-]?database[_-]?url|"
    r"reel[_-]?indexing[_-]?database[_-]?url)(?:\"|')?"
    r"\s*[:=]\s*"
    r"(?:\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)"
    r")"
)


def load_json(path: Path) -> Any:
    """Load one JSON document and preserve a useful parse location on failure."""

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(
            f"{path}: invalid JSON at line {error.lineno}, column {error.colno}: {error.msg}"
        ) from error


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    """Load one JSON object per non-empty line, including its source line on failure."""

    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(
                f"{path}: invalid JSONL at line {line_number}, column {error.colno}: {error.msg}"
            ) from error
        if not isinstance(value, dict):
            raise ValueError(
                f"{path}: invalid JSONL at line {line_number}: expected a JSON object"
            )
        rows.append(value)
    return rows


def load_json_or_jsonl(path: Path) -> list[dict[str, Any]]:
    """Accept the historical JSON-array trace file and the canonical JSONL form."""

    try:
        value = load_json(path)
    except ValueError:
        return load_jsonl(path)
    if isinstance(value, list):
        if not all(isinstance(item, dict) for item in value):
            raise ValueError(f"{path}: JSON trace array must contain only objects")
        return value
    if isinstance(value, dict):
        return [value]
    raise ValueError(f"{path}: expected a JSON object, array, or JSONL object rows")


def _load_semantic_context_rows(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Load enriched rows and an optional artifact-level metadata envelope."""

    try:
        value = load_json(path)
    except ValueError:
        return load_jsonl(path), {}
    if isinstance(value, dict) and isinstance(value.get("rows"), list):
        rows = value["rows"]
        if not all(isinstance(item, dict) for item in rows):
            raise ValueError(f"{path}: enriched context rows must be objects")
        return rows, value
    if isinstance(value, dict):
        return [value], {}
    if isinstance(value, list) and all(isinstance(item, dict) for item in value):
        return value, {}
    raise ValueError(f"{path}: enriched context artifact must contain object rows")


def _required_string_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE={field.upper()}_INVALID")
    return value


def _context_ids(value: Any, field: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE={field.upper()}_MISSING")
    ids: list[str] = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("evidenceId"), str):
            raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE={field.upper()}_INVALID")
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE={field.upper()}_TEXT_MISSING")
        ids.append(item["evidenceId"])
    return ids


def _safe_contexts(value: Any, field: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE={field.upper()}_MISSING")
    output: list[dict[str, Any]] = []
    for rank, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE={field.upper()}_INVALID")
        evidence_id = item.get("evidenceId")
        text = item.get("text")
        if not isinstance(evidence_id, str) or not isinstance(text, str) or not text.strip():
            raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE={field.upper()}_TEXT_MISSING")
        output.append(
            {
                "evidenceId": evidence_id,
                "reelId": item.get("reelId"),
                "evidenceType": item.get("evidenceType"),
                "text": text,
                "rank": item.get("rank", rank),
            }
        )
    return output


def validate_semantic_context_artifact(
    artifact_path: Path,
    report_path: Path,
    source_trace_path: Path,
    source_summary_path: Path,
    rows: dict[str, EvaluationRow],
    *,
    source_run_id: str,
    production_sha: str,
    dataset_version: str,
    dataset_sha256: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Bind saved context text to one immutable production execution set."""

    summary = load_json(source_summary_path)
    if (
        summary.get("runId") != source_run_id
        or summary.get("dataset") != dataset_version
        or summary.get("caseCount") != len(rows)
        or summary.get("correctAndGrounded") != len(rows)
        or summary.get("hardGatePassed") is not True
        or summary.get("variant", {}).get("productionSha") != production_sha
    ):
        raise ValueError("SEMANTIC_CONTEXT_PROVENANCE=SOURCE_SUMMARY_MISMATCH")

    report = load_json(report_path)
    source_cases = report.get("cases")
    if not isinstance(source_cases, list):
        raise ValueError("SEMANTIC_CONTEXT_PROVENANCE=SOURCE_REPORT_INVALID")
    source_case_ids = [item.get("caseId") for item in source_cases]
    if len(source_case_ids) != len(set(source_case_ids)) or set(source_case_ids) != set(rows):
        raise ValueError("SEMANTIC_CONTEXT_PROVENANCE=SOURCE_CASES_MISMATCH")
    source_by_case = {item["caseId"]: item for item in source_cases}

    trace_rows = load_json_or_jsonl(source_trace_path)
    trace_ids = [item.get("caseId") for item in trace_rows]
    if len(trace_ids) != len(set(trace_ids)) or set(trace_ids) != set(rows):
        raise ValueError("SEMANTIC_CONTEXT_PROVENANCE=SOURCE_TRACES_MISMATCH")
    trace_by_case = {item["caseId"]: item for item in trace_rows}

    enriched_rows, envelope = _load_semantic_context_rows(artifact_path)
    enriched_ids = [item.get("caseId") for item in enriched_rows]
    if len(enriched_ids) != len(set(enriched_ids)) or set(enriched_ids) != set(rows):
        raise ValueError("SEMANTIC_CONTEXT_PROVENANCE=ENRICHED_CASES_MISMATCH")
    enriched_by_case = {item["caseId"]: item for item in enriched_rows}

    expected_envelope = {
        "sourceRunId": source_run_id,
        "productionSha": production_sha,
        "datasetVersion": dataset_version,
        "datasetSha256": dataset_sha256,
    }
    for key, expected in expected_envelope.items():
        if key in envelope and envelope[key] != expected:
            label = re.sub(r"(?<!^)(?=[A-Z])", "_", key).upper()
            raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE=ENVELOPE_{label}_MISMATCH")

    artifact_sha256 = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    bound: dict[str, dict[str, Any]] = {}
    binding_cases: list[dict[str, Any]] = []
    explicit_metadata = True
    for case_id in sorted(rows):
        source_case = source_by_case[case_id]
        if (
            source_case.get("status") != "EVALUATED"
            or not isinstance(source_case.get("assistantMessageId"), str)
            or not source_case.get("assistantMessageId")
        ):
            raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE=SOURCE_EXECUTION_INVALID:{case_id}")
        source_execution_id = source_case["assistantMessageId"]
        source_trace = trace_by_case[case_id]
        source_trace_id = source_trace.get("traceId") or source_trace.get("ragTraceId")
        if not isinstance(source_trace_id, str) or not source_trace_id:
            raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE=SOURCE_TRACE_ID_MISSING:{case_id}")
        enriched = enriched_by_case[case_id]

        for key, expected in {
            "sourceRunId": source_run_id,
            "productionSha": production_sha,
            "datasetVersion": dataset_version,
            "datasetSha256": dataset_sha256,
            "sourceExecutionId": source_execution_id,
        }.items():
            if key not in enriched:
                explicit_metadata = False
            elif enriched[key] != expected:
                label = re.sub(r"(?<!^)(?=[A-Z])", "_", key).upper()
                raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE={label}_MISMATCH:{case_id}")

        enriched_trace_id = enriched.get("ragTraceId") or enriched.get("traceId")
        if enriched_trace_id != source_trace_id:
            raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE=RAG_TRACE_ID_MISMATCH:{case_id}")
        source_retrieved = _required_string_list(
            source_trace.get("retrievedChunkIds"), "source_retrieved_chunks"
        )
        source_reranked = _required_string_list(
            source_trace.get("rerankedChunkIds"), "source_reranked_chunks"
        )
        enriched_retrieved = _required_string_list(
            enriched.get("retrievedChunkIds"), "enriched_retrieved_chunks"
        )
        enriched_reranked = _required_string_list(
            enriched.get("rerankedChunkIds"), "enriched_reranked_chunks"
        )
        if enriched_retrieved != source_retrieved:
            raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE=RETRIEVED_CHUNKS_MISMATCH:{case_id}")
        if enriched_reranked != source_reranked:
            raise ValueError(f"SEMANTIC_CONTEXT_PROVENANCE=RERANKED_CHUNKS_MISMATCH:{case_id}")

        retrieved_contexts = _safe_contexts(enriched.get("retrievedContexts"), "retrieved_contexts")
        reranked_contexts = _safe_contexts(
            enriched.get("rerankedContexts"), "reranked_contexts"
        )
        if _context_ids(retrieved_contexts, "retrieved_contexts") != source_retrieved:
            raise ValueError(
                "SEMANTIC_CONTEXT_PROVENANCE=RETRIEVED_CONTEXT_IDS_MISMATCH:"
                f"{case_id}"
            )
        if _context_ids(reranked_contexts, "reranked_contexts") != source_reranked:
            raise ValueError(
                "SEMANTIC_CONTEXT_PROVENANCE=RERANKED_CONTEXT_IDS_MISMATCH:"
                f"{case_id}"
            )
        bound[case_id] = {
            "retrievedContexts": retrieved_contexts,
            "rerankedContexts": reranked_contexts,
        }
        binding_cases.append(
            {
                "caseId": case_id,
                "sourceExecutionId": source_execution_id,
                "ragTraceId": source_trace_id,
                "retrievedChunkIds": source_retrieved,
                "rerankedChunkIds": source_reranked,
            }
        )

    fingerprint_payload = {
        "schemaVersion": SEMANTIC_CONTEXT_SCHEMA,
        **expected_envelope,
        "artifactSha256": artifact_sha256,
        "cases": binding_cases,
    }
    binding_sha256 = hashlib.sha256(
        json.dumps(fingerprint_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return bound, {
        "schemaVersion": SEMANTIC_CONTEXT_SCHEMA,
        "artifactSha256": artifact_sha256,
        "bindingSha256": binding_sha256,
        "sourceRunId": source_run_id,
        "productionSha": production_sha,
        "datasetVersion": dataset_version,
        "datasetSha256": dataset_sha256,
        "provenanceMode": "EXPLICIT" if explicit_metadata else "SOURCE_BOUND_LEGACY_ROWS",
        "caseCount": len(binding_cases),
    }


def _object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _collect_model_calls(
    value: Any,
    output: list[dict[str, Any]] | None = None,
    seen: set[tuple[Any, ...]] | None = None,
) -> list[dict[str, Any]]:
    calls = output if output is not None else []
    identities = seen if seen is not None else set()
    if not isinstance(value, (dict, list)):
        return calls
    if isinstance(value, dict):
        model = value.get("model")
        role = value.get("modelRole") or value.get("role")
        usage = value.get("usage") if isinstance(value.get("usage"), dict) else {}
        provider_status = value.get("providerStatus")
        call_shaped_status = isinstance(provider_status, int) or provider_status in {
            "NETWORK_ERROR",
            "TIMEOUT",
        }
        if isinstance(model, str) and role and (
            call_shaped_status
            or usage
            or "configuredTimeoutMs" in value
            or "finishReason" in value
            or "attempt" in value
        ):
            normalized = {
                "modelRole": role,
                "model": model,
                "attempt": value.get("attempt", 1),
                "configuredTimeoutMs": value.get("configuredTimeoutMs"),
                "configuredMaxCompletionTokens": value.get(
                    "configuredMaxCompletionTokens"
                ),
                "latencyMs": value.get("latencyMs"),
                "providerStatus": provider_status,
                "providerCode": value.get("providerCode"),
                "providerCategory": value.get("providerCategory"),
                "errorCode": value.get("errorCode"),
                "transient": value.get("transient"),
                "retryAfterMs": value.get("retryAfterMs"),
                "networkErrorName": value.get("networkErrorName"),
                "networkErrorCode": value.get("networkErrorCode"),
                "networkErrorSyscall": value.get("networkErrorSyscall"),
                "finishReason": value.get("finishReason"),
                "endpointContract": value.get("endpointContract"),
                "responseContentType": value.get("responseContentType"),
                "contentPresent": value.get("contentPresent"),
                "toolCallsPresent": value.get("toolCallsPresent"),
                "schemaPath": value.get("schemaPath"),
                "schemaConstraint": value.get("schemaConstraint"),
                "schemaVersion": value.get("schemaVersion"),
                "expectedType": value.get("expectedType"),
                "actualJsonType": value.get("actualJsonType"),
                "inputTokens": value.get("inputTokens", usage.get("inputTokens")),
                "outputTokens": value.get("outputTokens", usage.get("outputTokens")),
                "totalTokens": value.get("totalTokens", usage.get("totalTokens")),
                "reasoningTokens": value.get(
                    "reasoningTokens", usage.get("reasoningTokens")
                ),
                "usageSource": value.get(
                    "usageSource", "PROVIDER" if usage else "UNAVAILABLE"
                ),
                "scope": value.get("scope", "QUERY"),
            }
            identity = tuple(
                normalized.get(key)
                for key in (
                    "modelRole",
                    "attempt",
                    "model",
                    "configuredTimeoutMs",
                    "latencyMs",
                    "errorCode",
                    "providerStatus",
                    "providerCode",
                    "providerCategory",
                )
            )
            if identity not in identities:
                identities.add(identity)
                calls.append(normalized)
            return calls
        children = value.values()
    else:
        children = value
    for child in children:
        _collect_model_calls(child, calls, identities)
    return calls


def _normalize_context(item: Any, rank: int) -> dict[str, Any]:
    if isinstance(item, str):
        parts = item.split(":")
        return {
            "evidenceId": item,
            "reelId": parts[1] if parts[0] == "reel" and len(parts) > 1 else parts[0],
            "evidenceType": "UNKNOWN",
            "rank": rank,
        }
    return item if isinstance(item, dict) else {"evidenceId": item, "rank": rank}


def _route_from_trace(trace: dict[str, Any]) -> dict[str, Any]:
    metrics = _object(trace.get("workflowMetrics"))
    diagnostics = _object(metrics.get("diagnostics"))
    persisted = (
        _object(trace.get("routeDecision"))
        or _object(metrics.get("routeDecision"))
        or _object(diagnostics.get("routeDecision"))
    )
    legacy = _object(trace.get("route"))
    if not any(
        key in legacy
        for key in (
            "intent",
            "referenceTarget",
            "reelQuestionType",
            "requiredEvidence",
            "needsRetrieval",
            "needsVerification",
            "recommendationActionType",
        )
    ):
        legacy = {
            key: trace[key]
            for key in (
                "intent",
                "referenceTarget",
                "reelQuestionType",
                "requiredEvidence",
                "needsRetrieval",
                "needsVerification",
                "recommendationActionType",
            )
            if key in trace
        }
    route = persisted or legacy

    actual = {
        "intent": route.get("intent", trace.get("intent")),
        "referenceTarget": route.get("referenceTarget"),
        "reelQuestionType": route.get("reelQuestionType"),
        "requiredEvidence": route.get("requiredEvidence", []),
        "needsRetrieval": route.get("needsRetrieval", trace.get("needsRetrieval")),
        "needsVerification": route.get("needsVerification"),
        "recommendationActionType": route.get("recommendationActionType"),
    }
    if not isinstance(actual["requiredEvidence"], list):
        actual["requiredEvidence"] = []
    return actual


def _citation_provenance(trace: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]]]:
    metrics = _object(trace.get("workflowMetrics"))
    diagnostics = _object(metrics.get("diagnostics"))
    mappings = metrics.get("citationEvidenceMappings")
    if not isinstance(mappings, list):
        mappings = diagnostics.get("citationEvidenceMappings")
    if not isinstance(mappings, list):
        mappings = []
    evidence_ids = metrics.get("citationEvidenceIds")
    if not isinstance(evidence_ids, list):
        evidence_ids = diagnostics.get("citationEvidenceIds")
    if not isinstance(evidence_ids, list):
        evidence_ids = []
    return (
        [item for item in evidence_ids if isinstance(item, str)],
        [item for item in mappings if isinstance(item, dict)],
    )


def _evaluation_citations(
    citations: list[dict[str, Any]], trace: dict[str, Any], reranked: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if not citations:
        return []
    context_by_id = {
        item.get("evidenceId"): item
        for item in reranked
        if item.get("evidenceId")
    }
    evidence_ids, mappings = _citation_provenance(trace)
    by_index: dict[int, str] = {}
    for mapping in mappings:
        index = mapping.get("citationIndex")
        evidence_id = mapping.get("evidenceId")
        if (
            isinstance(index, int)
            and index >= 0
            and isinstance(evidence_id, str)
            and index not in by_index
            and evidence_id in context_by_id
        ):
            by_index[index] = evidence_id
    if len(by_index) < len(citations) and len(evidence_ids) == len(citations):
        for index, evidence_id in enumerate(evidence_ids):
            if evidence_id in context_by_id:
                by_index.setdefault(index, evidence_id)

    output: list[dict[str, Any]] = []
    for index, citation in enumerate(citations):
        evidence_id = by_index.get(index)
        context = context_by_id.get(evidence_id) if evidence_id else None
        if context and citation.get("reelId") not in {None, context.get("reelId")}:
            evidence_id = None
        if evidence_id:
            output.append({**citation, "evidenceId": evidence_id})
        else:
            output.append(dict(citation))
    return output


def sanitize_runner_diagnostic(
    stdout: str | bytes | None = None,
    stderr: str | bytes | None = None,
    limit: int = 4000,
) -> str:
    """Return bounded child output with credentials and session material removed."""

    parts: list[str] = []
    for label, value in (("stdout", stdout), ("stderr", stderr)):
        if value is None:
            continue
        text = value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)
        if not text:
            continue
        text = _DATABASE_URL_RE.sub("<redacted-db-url>", text)
        text = _BEARER_RE.sub("Bearer <redacted>", text)
        text = _COOKIE_HEADER_RE.sub(r"\1<redacted>", text)
        text = _SENSITIVE_VALUE_RE.sub(
            lambda match: f"{match.group(0).split(':', 1)[0].split('=', 1)[0]}=<redacted>",
            text,
        )
        parts.append(f"{label}: {' '.join(text.split())}")
    diagnostic = " | ".join(parts) or "<no child output>"
    return diagnostic[:limit]


def normalize_runner_case(
    row: EvaluationRow, case: dict[str, Any], trace: dict[str, Any] | None = None
) -> NormalizedExecutionResult:
    trace = trace or case.get("trace") or {}
    retrieved = trace.get("retrievedContexts") or trace.get("retrievedChunkIds") or []
    reranked = trace.get("rerankedContexts") or trace.get("rerankedChunkIds") or retrieved
    retrieved_contexts = [
        _normalize_context(item, index + 1) for index, item in enumerate(retrieved)
    ]
    reranked_contexts = [
        _normalize_context(item, index + 1) for index, item in enumerate(reranked)
    ]
    citations = case.get("citations") or trace.get("citations") or []
    citations = _evaluation_citations(citations, trace, reranked_contexts)
    return NormalizedExecutionResult(
        runId=case.get("runId", "typescript-runner"),
        caseId=row.id,
        executionStatus="COMPLETED" if case.get("status") == "EVALUATED" else "RECONCILED_FAILURE",
        input={"question": row.question},
        reference={
            "answer": row.referenceAnswer,
            "relevantEvidenceIds": row.relevantEvidenceIds,
            "expectedReelIds": row.expectedReelIds,
            "expectedIntent": row.expectedIntent,
            "expectedEvidenceTypes": row.expectedEvidenceTypes,
        },
        actual={
            "answer": case.get("finalAnswer"),
            "route": _route_from_trace(trace),
            "retrievedContexts": retrieved_contexts,
            "rerankedContexts": reranked_contexts,
            "citations": citations,
        },
        trace={
            **(_object(trace.get("workflowMetrics")) or trace),
            **({"ragTraceId": trace["traceId"]} if trace.get("traceId") else {}),
            "productionExecutionId": case.get("assistantMessageId")
            or case.get("userMessageId"),
        },
        modelCalls=trace.get("modelCalls") or _collect_model_calls(trace),
        latencyMs=case.get("latencyMs", trace.get("latencyMs")),
    )


def load_runner_report(
    report_path: Path,
    rows: dict[str, EvaluationRow],
    traces_path: Path | None = None,
    *,
    require_trace: bool = False,
    semantic_context_rows: dict[str, dict[str, Any]] | None = None,
) -> dict[str, NormalizedExecutionResult]:
    report = load_json(report_path)
    if not isinstance(report, dict):
        raise ValueError(f"{report_path}: runner report must be a JSON object")
    traces = {}
    if traces_path:
        trace_rows = load_json_or_jsonl(traces_path)
        trace_keys = [item.get("caseId") for item in trace_rows]
        if require_trace:
            expected = set(rows)
            if any(not isinstance(key, str) for key in trace_keys):
                raise ValueError(
                    "TRACE_PROVENANCE=INCOMPLETE: every trace row needs caseId"
                )
            if len(trace_keys) != len(set(trace_keys)):
                raise ValueError("TRACE_PROVENANCE=AMBIGUOUS: duplicate trace caseId")
            actual = set(trace_keys)
            if actual != expected:
                raise ValueError(
                    "TRACE_PROVENANCE=INCOMPLETE: "
                    f"missing={sorted(expected - actual)} extra={sorted(actual - expected)}"
                )
        traces = {item.get("caseId", item.get("message")): item for item in trace_rows}
    elif require_trace:
        raise ValueError("TRACE_PROVENANCE=MISSING: trace file is required")
    output = {}
    for case in report.get("cases", []):
        case_id = case.get("caseId")
        if case_id in rows:
            case["runId"] = report.get("runId")
            trace = traces.get(case_id)
            if semantic_context_rows is not None:
                semantic_context = semantic_context_rows.get(case_id)
                if semantic_context is None:
                    raise ValueError(
                        f"SEMANTIC_CONTEXT_PROVENANCE=MISSING case={case_id}"
                    )
                trace = {
                    **(trace or {}),
                    "retrievedContexts": semantic_context["retrievedContexts"],
                    "rerankedContexts": semantic_context["rerankedContexts"],
                }
            output[case_id] = normalize_runner_case(rows[case_id], case, trace)
    return output


def validate_trace_provenance(traces_path: Path, case_ids: set[str]) -> str:
    """Validate the one-trace-per-completed-case contract."""

    trace_rows = load_json_or_jsonl(traces_path)
    trace_ids = [item.get("caseId") for item in trace_rows]
    if any(not isinstance(value, str) for value in trace_ids):
        raise ValueError("TRACE_PROVENANCE=INCOMPLETE: every trace row needs caseId")
    if len(trace_ids) != len(set(trace_ids)):
        raise ValueError("TRACE_PROVENANCE=AMBIGUOUS: duplicate trace caseId")
    if set(trace_ids) != case_ids:
        raise ValueError(
            "TRACE_PROVENANCE=INCOMPLETE: trace case IDs do not match cases"
        )
    return "COMPLETE"


def invoke_typescript_runner(arguments: list[str]) -> Path:
    try:
        completed = subprocess.run(
            ["node", str(RUNNER), *arguments],
            cwd=REPOSITORY_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as error:
        diagnostic = sanitize_runner_diagnostic(error.stdout, error.stderr)
        raise RuntimeError(
            f"TypeScript runner failed with exit code {error.returncode}: {diagnostic}"
        ) from error
    except OSError as error:
        diagnostic = sanitize_runner_diagnostic(stderr=str(error))
        raise RuntimeError(f"TypeScript runner could not start: {diagnostic}") from error
    for line in reversed(completed.stdout.splitlines()):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and payload.get("reportPath"):
            return Path(payload["reportPath"])
    raise RuntimeError("TypeScript runner completed without a reportPath")


def fixture_execution(
    row: EvaluationRow, run_id: str, variant: dict[str, Any]
) -> NormalizedExecutionResult:
    evidence_id = row.relevantEvidenceIds[0] if row.relevantEvidenceIds else None
    reel_id = row.expectedReelIds[0] if row.expectedReelIds else None
    evidence_type = next((item for item in row.expectedEvidenceTypes if item != "NONE"), None)
    contexts = (
        [
            {
                "evidenceId": evidence_id,
                "reelId": reel_id,
                "evidenceType": evidence_type or "TRANSCRIPT",
                "text": row.referenceAnswer or "fixture evidence",
                "rank": 1,
            }
        ]
        if evidence_id
        else []
    )
    citations = (
        [{"evidenceId": evidence_id, "reelId": reel_id, "evidenceType": evidence_type}]
        if evidence_id
        else []
    )
    return NormalizedExecutionResult(
        runId=run_id,
        caseId=row.id,
        executionStatus="FIXTURE",
        input={"question": row.question},
        reference={
            "answer": row.referenceAnswer,
            "relevantEvidenceIds": row.relevantEvidenceIds,
            "expectedReelIds": row.expectedReelIds,
            "expectedIntent": row.expectedIntent,
            "expectedEvidenceTypes": row.expectedEvidenceTypes,
        },
        actual={
            "answer": row.referenceAnswer,
            "route": {
                "intent": row.expectedIntent,
                "referenceTarget": row.expectedReferenceTarget,
                "reelQuestionType": row.expectedReelQuestionType,
                "requiredEvidence": row.expectedEvidenceTypes,
            },
            "retrievedContexts": contexts,
            "rerankedContexts": contexts,
            "citations": citations,
        },
        trace={"retryCount": 0, "citationRetryCount": 0, "revisionDepth": 0},
        modelCalls=[],
        latencyMs=1.0,
        variant=variant,
    )
