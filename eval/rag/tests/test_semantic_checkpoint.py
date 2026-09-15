import pytest
from instructor.v2.core.errors import IncompleteOutputException

from rag_eval.metrics.semantic import SemanticMetricSuite, classify_metric_error


class Result:
    def __init__(self, value):
        self.value = value


class Scorer:
    def __init__(self, value, fail=False):
        self.value = value
        self.fail = fail
        self.calls = 0

    async def ascore(self, **_payload):
        self.calls += 1
        if self.fail:
            raise RuntimeError("temporary judge failure")
        return Result(self.value)


class TimeoutScorer:
    async def ascore(self, **_payload):
        raise TimeoutError("embedding timed out")


class ScheduledTracker:
    def __init__(self, scheduled):
        self.scheduled = set(scheduled)

    def begin(self, _key):
        return None

    def set_metric(self, _name):
        return None

    def operation_is_scheduled(self, case_id, metric):
        return f"{case_id}::{metric}" in self.scheduled

    def calls_for(self, _key, _metric):
        return []

    def take(self, _key):
        return []


@pytest.mark.asyncio
async def test_completed_metric_checkpoint_is_not_rejudged(tmp_path):
    from rag_eval.checkpoint import JudgeCheckpointStore

    identity = {
        "sourceRunId": "run",
        "productionSha": "a" * 40,
        "datasetVersion": "rag-frozen-ami-v3",
        "judgeProvider": "groq",
        "judgeModel": "openai/gpt-oss-120b",
        "evaluatorSha": "b" * 40,
    }
    checkpoint = JudgeCheckpointStore(tmp_path / "checkpoint.json", identity)
    first = {name: Scorer(0.8) for name in ("faithfulness", "factual_correctness")}
    first["response_relevancy"] = Scorer(0.0, fail=True)
    suite = SemanticMetricSuite(first)
    suite.configure_checkpoint(checkpoint, identity)
    payloads = {
        "faithfulness": {"value": 1},
        "factual_correctness": {"value": 1},
        "response_relevancy": {"value": 1},
    }
    context = {"sourceExecutionId": "assistant", "ragTraceId": "trace"}

    result, _ = await suite.ascore_with_usage(payloads, "run:IN1001-1", context)
    assert result == {
        "faithfulness": 0.8,
        "factual_correctness": 0.8,
        "response_relevancy": None,
        "context_precision": None,
        "context_recall": None,
    }

    second = {name: Scorer(0.9) for name in first}
    resumed = SemanticMetricSuite(second)
    resumed.configure_checkpoint(checkpoint, identity)
    result, _ = await resumed.ascore_with_usage(payloads, "run:IN1001-1", context)

    assert result["faithfulness"] == 0.8
    assert result["factual_correctness"] == 0.8
    assert result["response_relevancy"] == 0.9
    assert second["faithfulness"].calls == 0
    assert second["factual_correctness"].calls == 0
    assert second["response_relevancy"].calls == 1


@pytest.mark.asyncio
async def test_metric_timeout_is_distinguished_from_provider_timeout():
    suite = SemanticMetricSuite({"response_relevancy": TimeoutScorer()})

    result, _ = await suite.ascore_with_usage(
        {"response_relevancy": {"value": 1}}, "run:IN1001-1"
    )

    assert result["response_relevancy"] is None
    assert (
        suite.diagnostics_for("run:IN1001-1")["response_relevancy"]["errorCategory"]
        == "METRIC_TIMEOUT"
    )
    assert (
        classify_metric_error(
            TimeoutError("provider"), [{"providerStatus": "TIMEOUT"}]
        )
        == "PROVIDER_TIMEOUT"
    )


def test_incomplete_output_is_classified_as_truncation():
    assert classify_metric_error(IncompleteOutputException(), []) == "OUTPUT_TRUNCATED"


@pytest.mark.asyncio
async def test_deferred_daily_operation_is_not_recorded_as_metric_failure(tmp_path):
    from rag_eval.checkpoint import JudgeCheckpointStore

    identity = {
        "sourceRunId": "run",
        "productionSha": "a" * 40,
        "datasetVersion": "rag-frozen-ami-v3",
        "judgeProvider": "groq",
        "judgeModel": "openai/gpt-oss-120b",
        "evaluatorSha": "b" * 40,
    }
    checkpoint = JudgeCheckpointStore(tmp_path / "checkpoint.json", identity)
    scorer = Scorer(0.8)
    suite = SemanticMetricSuite({"faithfulness": scorer}, ScheduledTracker(set()))
    suite.configure_checkpoint(checkpoint, identity)

    result, _ = await suite.ascore_with_usage(
        {"faithfulness": {"value": 1}},
        "run:case-1",
        {"sourceExecutionId": "assistant", "ragTraceId": "trace"},
    )

    assert result["faithfulness"] is None
    assert scorer.calls == 0
    assert checkpoint.entries() == []
    assert suite.diagnostics_for("run:case-1")["faithfulness"] == {
        "status": "NOT_EVALUATED",
        "errorCategory": "DAILY_RECOVERY_DEFERRED",
        "source": "DAILY_TPD_SLICE",
    }
