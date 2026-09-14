"""Current Ragas semantic/agent metric wiring with injectable offline scorers."""

from __future__ import annotations

import math
import os
from typing import Any, Protocol

from ragas.metrics.collections import (
    AgentGoalAccuracy,
    AnswerRelevancy,
    ContextPrecision,
    ContextRecall,
    FactualCorrectness,
    Faithfulness,
    MultiModalFaithfulness,
    MultiModalRelevance,
    ToolCallAccuracy,
    ToolCallF1,
)

from rag_eval.checkpoint import JudgeCheckpointStore
from rag_eval.recovery import DailyRecoveryDeferred, MultiDayRecoveryStore


class Scorer(Protocol):
    def score(self, **kwargs: Any) -> Any: ...


SEMANTIC_NAMES = (
    "faithfulness",
    "factual_correctness",
    "response_relevancy",
    "context_precision",
    "context_recall",
)


def classify_metric_error(error: BaseException | None, calls: list[dict[str, Any]]) -> str:
    """Separate provider transport timeouts from metric/experiment failures."""

    if any(
        call.get("providerStatus") == "TIMEOUT"
        or call.get("providerCategory") == "PROVIDER_TIMEOUT"
        for call in calls
    ):
        return "PROVIDER_TIMEOUT"
    error_name = type(error).__name__.lower()
    if (
        isinstance(error, TimeoutError)
        or "timeout" in error_name
        or "timeout" in str(error).lower()
    ):
        return "METRIC_TIMEOUT"
    if "incompleteoutput" in error_name:
        return "METRIC_OUTPUT_INCOMPLETE"
    return "METRIC_ERROR"


def current_ragas_metric_types() -> dict[str, type]:
    return {
        "faithfulness": Faithfulness,
        "factual_correctness": FactualCorrectness,
        "response_relevancy": AnswerRelevancy,
        "context_precision": ContextPrecision,
        "context_recall": ContextRecall,
        "tool_call_accuracy": ToolCallAccuracy,
        "tool_call_f1": ToolCallF1,
        "agent_goal_accuracy": AgentGoalAccuracy,
        "multi_modal_faithfulness": MultiModalFaithfulness,
        "multi_modal_relevance": MultiModalRelevance,
    }


class SemanticMetricSuite:
    def __init__(
        self,
        scorers: dict[str, Scorer] | None = None,
        usage_tracker: Any | None = None,
    ):
        self.scorers = scorers or {}
        self.usage_tracker = usage_tracker
        self.checkpoint: JudgeCheckpointStore | None = None
        self.checkpoint_identity: dict[str, Any] = {}
        self._metric_diagnostics: dict[str, dict[str, dict[str, Any]]] = {}

    def configure_checkpoint(
        self, checkpoint: JudgeCheckpointStore, identity: dict[str, Any]
    ) -> None:
        self.checkpoint = checkpoint
        self.checkpoint_identity = dict(identity)

    def configure_multiday_recovery(self, store: MultiDayRecoveryStore) -> None:
        if not self.usage_tracker or not hasattr(self.usage_tracker, "configure_multiday_recovery"):
            raise ValueError("semantic suite has no recoverable judge usage tracker")
        self.usage_tracker.configure_multiday_recovery(store)

    def diagnostics_for(self, usage_key: str) -> dict[str, dict[str, Any]]:
        return {
            name: dict(value)
            for name, value in self._metric_diagnostics.get(usage_key, {}).items()
        }

    def score(self, payloads: dict[str, dict[str, Any]]) -> dict[str, float | None]:
        output: dict[str, float | None] = {}
        for name in SEMANTIC_NAMES:
            scorer = self.scorers.get(name)
            if scorer is None or name not in payloads:
                output[name] = None
                continue
            result = scorer.score(**payloads[name])
            output[name] = float(result.value)
        return output

    async def ascore(self, payloads: dict[str, dict[str, Any]]) -> dict[str, float | None]:
        output: dict[str, float | None] = {}
        for name in SEMANTIC_NAMES:
            scorer = self.scorers.get(name)
            if scorer is None or name not in payloads:
                output[name] = None
                continue
            try:
                if hasattr(scorer, "ascore"):
                    result = await scorer.ascore(**payloads[name])
                else:
                    result = scorer.score(**payloads[name])
                output[name] = float(result.value)
            except Exception:
                # Judge unavailability does not remove the production execution row.
                output[name] = None
        return output

    async def ascore_with_usage(
        self,
        payloads: dict[str, dict[str, Any]],
        usage_key: str,
        checkpoint_context: dict[str, Any] | None = None,
    ) -> tuple[dict[str, float | None], list[dict[str, Any]]]:
        if self.checkpoint and (
            not checkpoint_context
            or not checkpoint_context.get("sourceExecutionId")
            or not checkpoint_context.get("ragTraceId")
        ):
            raise ValueError("judge checkpoint source execution identity is incomplete")
        if self.usage_tracker:
            self.usage_tracker.begin(usage_key)
        case_id = usage_key.rsplit(":", 1)[-1]
        cached_calls: list[dict[str, Any]] = []
        metric_diagnostics: dict[str, dict[str, Any]] = {}
        context = checkpoint_context or {}
        try:
            metrics: dict[str, float | None] = {}
            for name in SEMANTIC_NAMES:
                scorer = self.scorers.get(name)
                if scorer is None or name not in payloads:
                    metrics[name] = None
                    metric_diagnostics[name] = {
                        "status": "NOT_EVALUATED",
                        "errorCategory": "NOT_ELIGIBLE",
                    }
                    continue

                cached = (
                    self.checkpoint.get(case_id, name)
                    if self.checkpoint
                    and os.getenv("RAGAS_RESUME_COMPLETED_JUDGE_RESULTS", "true").lower()
                    != "false"
                    else None
                )
                if cached and cached.get("status") == "COMPLETE":
                    metrics[name] = float(cached["value"])
                    cached_calls.extend(cached.get("calls") or [])
                    metric_diagnostics[name] = {
                        "status": "COMPLETE",
                        "source": "CHECKPOINT",
                    }
                    continue

                if self.usage_tracker:
                    self.usage_tracker.set_metric(name)
                caught_error: BaseException | None = None
                try:
                    if hasattr(scorer, "ascore"):
                        result = await scorer.ascore(**payloads[name])
                    else:
                        result = scorer.score(**payloads[name])
                    value = float(result.value)
                    if not math.isfinite(value):
                        raise ValueError("metric returned a non-finite value")
                    metrics[name] = value
                    status = "COMPLETE"
                    error_type = None
                except DailyRecoveryDeferred:
                    raise
                except Exception as error:
                    metrics[name] = None
                    value = None
                    status = "UNAVAILABLE"
                    error_type = type(error).__name__
                    caught_error = error

                calls = (
                    self.usage_tracker.calls_for(usage_key, name)
                    if self.usage_tracker
                    else []
                )
                error_category = (
                    None
                    if status == "COMPLETE"
                    else classify_metric_error(caught_error, calls)
                )
                metric_diagnostics[name] = {
                    "status": status,
                    "errorType": error_type,
                    "errorCategory": error_category,
                    "judgeCallCount": len(calls),
                }
                if self.checkpoint:
                    self.checkpoint.record(
                        {
                            **self.checkpoint_identity,
                            "sourceExecutionId": context.get("sourceExecutionId"),
                            "ragTraceId": context.get("ragTraceId"),
                            "caseId": case_id,
                            "metricName": name,
                            "status": status,
                            "value": value,
                            "errorType": error_type,
                            "errorCategory": error_category,
                            "calls": calls,
                        }
                    )
        finally:
            self._metric_diagnostics[usage_key] = metric_diagnostics
            calls = self.usage_tracker.take(usage_key) if self.usage_tracker else []
        return metrics, cached_calls + calls


def build_live_semantic_suite(
    llm: Any, embeddings: Any, usage_tracker: Any | None = None
) -> SemanticMetricSuite:
    return SemanticMetricSuite(
        {
            "faithfulness": Faithfulness(llm),
            "factual_correctness": FactualCorrectness(llm),
            "response_relevancy": AnswerRelevancy(llm, embeddings),
            "context_precision": ContextPrecision(llm),
            "context_recall": ContextRecall(llm),
        },
        usage_tracker,
    )


def tool_metrics_supported(trajectory: list[dict[str, Any]] | None) -> bool:
    return bool(trajectory)


def build_tool_metrics() -> dict[str, Any]:
    # Multiple authorized tool trajectories can be correct, so order is not a hard requirement.
    return {
        "tool_call_accuracy": ToolCallAccuracy(strict_order=False),
        "tool_call_f1": ToolCallF1(),
    }


def build_agent_goal_metric(llm: Any) -> Any:
    return AgentGoalAccuracy(llm)


def multimodal_support(has_original_images: bool) -> str:
    return "RAGAS_NATIVE" if has_original_images else "TEXT_GROUNDED_MODALITY_ONLY"
