from types import SimpleNamespace

from ragas.embeddings.base import embedding_factory
from ragas.llms.base import InstructorLLM

from rag_eval.metrics.semantic import (
    SEMANTIC_NAMES,
    SemanticMetricSuite,
    build_live_semantic_suite,
    build_tool_metrics,
    current_ragas_metric_types,
    multimodal_support,
)


class FakeScorer:
    def __init__(self, value):
        self.value = value
        self.calls = []

    def score(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(value=self.value)


def test_fake_judge_wires_all_semantic_metrics_without_network():
    scorers = {name: FakeScorer(index / 10) for index, name in enumerate(SEMANTIC_NAMES, 1)}
    payloads = {name: {"safe": "fixture"} for name in SEMANTIC_NAMES}
    values = SemanticMetricSuite(scorers).score(payloads)
    assert values == {
        "faithfulness": 0.1,
        "factual_correctness": 0.2,
        "response_relevancy": 0.3,
        "context_precision": 0.4,
        "context_recall": 0.5,
    }
    assert all(len(scorer.calls) == 1 for scorer in scorers.values())


async def test_fake_judge_async_wiring_without_network():
    scorers = {name: FakeScorer(0.75) for name in SEMANTIC_NAMES}
    payloads = {name: {"safe": "fixture"} for name in SEMANTIC_NAMES}
    values = await SemanticMetricSuite(scorers).ascore(payloads)
    assert set(values.values()) == {0.75}


def test_current_ragas_builtin_agent_and_multimodal_types_are_wired():
    types = current_ragas_metric_types()
    assert set(SEMANTIC_NAMES) <= set(types)
    assert {"tool_call_accuracy", "tool_call_f1", "agent_goal_accuracy"} <= set(types)
    assert {"multi_modal_faithfulness", "multi_modal_relevance"} <= set(types)
    assert build_tool_metrics()["tool_call_accuracy"].strict_order is False
    assert multimodal_support(False) == "TEXT_GROUNDED_MODALITY_ONLY"


def test_faithfulness_accepts_a_metric_specific_llm():
    standard_llm = InstructorLLM(client=object(), model="test", provider="openai")
    faithfulness_llm = InstructorLLM(client=object(), model="test", provider="openai")
    embeddings = embedding_factory(provider="openai", model="test", client=object())
    suite = build_live_semantic_suite(
        standard_llm, embeddings, faithfulness_llm=faithfulness_llm
    )

    assert suite.scorers["faithfulness"].llm is faithfulness_llm
    assert suite.scorers["factual_correctness"].llm is standard_llm
