import pytest

from rag_eval.metrics.semantic import SemanticMetricSuite


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
