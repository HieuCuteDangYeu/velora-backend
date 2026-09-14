"""One authoritative per-case evaluation path."""

import math
import re
from typing import Any

from rag_eval.metrics.citation import (
    citation_evidence_hit_rate,
    citation_precision,
    citation_recall,
    wrong_modality_count,
    wrong_reel_count,
)
from rag_eval.metrics.cost import aggregate_costs
from rag_eval.metrics.retrieval import evidence_hit_rate, ndcg_at_k, recall_at_k, reciprocal_rank
from rag_eval.metrics.routing import exact_accuracy, modality_accuracy, set_accuracy
from rag_eval.metrics.safety import access_control_violations
from rag_eval.metrics.semantic import SemanticMetricSuite
from rag_eval.pricing import load_pricing
from rag_eval.schemas import EvaluationRow, NormalizedExecutionResult

STOPWORDS = {
    "they",
    "have",
    "that",
    "with",
    "under",
    "during",
    "about",
    "from",
    "into",
    "the",
    "and",
}


def semantic_payloads(
    row: EvaluationRow, execution: NormalizedExecutionResult
) -> dict[str, dict[str, Any]]:
    answer = execution.actual.get("answer")
    contexts = [
        item.get("text", "")
        for item in execution.actual.get("retrievedContexts", [])
        if item.get("text")
    ]
    payloads: dict[str, dict[str, Any]] = {}
    if answer and contexts:
        payloads["faithfulness"] = {
            "user_input": row.question,
            "response": answer,
            "retrieved_contexts": contexts,
        }
    if answer and row.referenceAnswer:
        payloads["factual_correctness"] = {
            "response": answer,
            "reference": row.referenceAnswer,
        }
    if answer:
        payloads["response_relevancy"] = {
            "user_input": row.question,
            "response": answer,
        }
    if row.referenceAnswer and contexts:
        context_payload = {
            "user_input": row.question,
            "reference": row.referenceAnswer,
            "retrieved_contexts": contexts,
        }
        payloads["context_precision"] = context_payload
        payloads["context_recall"] = context_payload
    return payloads


def frozen_answer_correct(answer: str | None, reference: str | None) -> float | None:
    if reference is None:
        return None
    words = [
        word
        for word in re.sub(r"[^a-z0-9]+", " ", reference.lower()).split()
        if len(word) > 2 and word not in STOPWORDS
    ]
    if not words:
        return float((answer or "").strip().lower() == reference.strip().lower())
    actual = re.sub(r"[^a-z0-9]+", " ", (answer or "").lower())
    return float(sum(word in actual for word in words) >= math.ceil(len(words) * 2 / 3))


def authorized_scope(
    row: EvaluationRow, execution: NormalizedExecutionResult
) -> tuple[list[str], list[str]]:
    configured_reels = row.accessScope.get("authorizedReelIds")
    configured_evidence = row.accessScope.get("authorizedEvidenceIds")
    diagnostics = execution.trace.get("diagnostics") or {}
    retrieval_execution = diagnostics.get("retrievalExecution") or {}
    observed_reels = retrieval_execution.get("accessibleReelIds")
    observed_reels_truncated = retrieval_execution.get("accessibleReelIdsTruncated") is True

    if isinstance(observed_reels, list) and observed_reels and not observed_reels_truncated:
        reels = [item for item in observed_reels if isinstance(item, str)]
        evidence = (
            [item for item in configured_evidence if isinstance(item, str)]
            if isinstance(configured_evidence, list)
            else []
        )
        return reels, evidence

    reels = (
        [item for item in configured_reels if isinstance(item, str)]
        if isinstance(configured_reels, list)
        else row.expectedReelIds
    )
    evidence = (
        [item for item in configured_evidence if isinstance(item, str)]
        if isinstance(configured_evidence, list)
        else row.relevantEvidenceIds
    )
    return reels, evidence


def evaluate_case(
    row: EvaluationRow,
    execution: NormalizedExecutionResult,
    semantic_suite: SemanticMetricSuite | None = None,
    catalog: dict[str, Any] | None = None,
) -> dict[str, Any]:
    actual = execution.actual
    route = actual.get("route") or {}
    retrieved = actual.get("retrievedContexts") or []
    reranked = actual.get("rerankedContexts") or retrieved
    citations = actual.get("citations") or []
    retrieved_ids = [item.get("evidenceId") for item in reranked if item.get("evidenceId")]
    types = [item.get("evidenceType") for item in retrieved if item.get("evidenceType")]
    authorized_reels, authorized_evidence = authorized_scope(row, execution)
    answer_correct = frozen_answer_correct(actual.get("answer"), row.referenceAnswer)
    access_violations = access_control_violations(
        retrieved, citations, authorized_reels, authorized_evidence
    )
    deterministic = {
        **{
            f"recallAt{k}": recall_at_k(retrieved_ids, row.relevantEvidenceIds, k)
            for k in (1, 3, 5, 10)
        },
        "mrr": reciprocal_rank(retrieved_ids, row.relevantEvidenceIds),
        "ndcgAt5": ndcg_at_k(retrieved_ids, row.relevantEvidenceIds, 5),
        "ndcgAt10": ndcg_at_k(retrieved_ids, row.relevantEvidenceIds, 10),
        "evidenceHitRate": evidence_hit_rate(retrieved_ids, row.relevantEvidenceIds),
        "citationPrecision": citation_precision(citations, row.relevantEvidenceIds),
        "citationRecall": citation_recall(citations, row.relevantEvidenceIds),
        "citationEvidenceHitRate": citation_evidence_hit_rate(citations, row.relevantEvidenceIds),
        "wrongReelCitationCount": wrong_reel_count(citations, row.expectedReelIds),
        "wrongModalityCitationCount": wrong_modality_count(citations, row.expectedEvidenceTypes),
        "routerIntentAccuracy": exact_accuracy(route.get("intent"), row.expectedIntent),
        "referenceTargetAccuracy": exact_accuracy(
            route.get("referenceTarget"), row.expectedReferenceTarget
        ),
        "requiredEvidenceAccuracy": set_accuracy(
            route.get("requiredEvidence", []), row.expectedEvidenceTypes
        ),
        "modalityAccuracy": modality_accuracy(types, row.expectedEvidenceTypes),
        "accessControlViolations": access_violations,
        "answerCorrect": 0.0
        if execution.executionStatus not in {"COMPLETED", "FIXTURE"}
        else answer_correct,
    }
    grounded = bool(deterministic["citationEvidenceHitRate"] == 1 and access_violations == 0)
    deterministic["grounded"] = float(grounded)
    deterministic["correctAndGrounded"] = float(answer_correct == 1 and grounded)
    semantic = (semantic_suite or SemanticMetricSuite()).score(semantic_payloads(row, execution))
    completed = execution.executionStatus in {"COMPLETED", "FIXTURE"}
    frozen_gate = row.fixtureGroup != "frozen-ami" or deterministic["correctAndGrounded"] == 1
    return {
        "caseId": row.id,
        "datasetVersion": row.datasetVersion,
        "tags": row.tags,
        "category": row.category,
        "execution": execution.model_dump(mode="json"),
        "semantic": semantic,
        "deterministic": deterministic,
        "cost": aggregate_costs(
            [call.model_dump() for call in execution.modelCalls], catalog or load_pricing()
        ),
        "hardGatePassed": completed and access_violations == 0 and frozen_gate,
    }


async def evaluate_case_async(
    row: EvaluationRow,
    execution: NormalizedExecutionResult,
    semantic_suite: SemanticMetricSuite | None = None,
    catalog: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = evaluate_case(row, execution, None, catalog)
    if semantic_suite:
        metrics, judge_calls = await semantic_suite.ascore_with_usage(
            semantic_payloads(row, execution),
            f"{execution.runId}:{row.id}",
            {
                "sourceExecutionId": execution.trace.get("productionExecutionId"),
                "ragTraceId": execution.trace.get("ragTraceId"),
            },
        )
        result["semantic"] = metrics
        result["semanticDiagnostics"] = semantic_suite.diagnostics_for(
            f"{execution.runId}:{row.id}"
        )
        result["execution"]["modelCalls"].extend(judge_calls)
        result["cost"] = aggregate_costs(
            result["execution"]["modelCalls"], catalog or load_pricing()
        )
    return result
