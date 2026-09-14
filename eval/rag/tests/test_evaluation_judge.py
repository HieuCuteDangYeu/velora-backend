import instructor
import pytest
from openai import AsyncOpenAI

import rag_eval.adapters.evaluation_judge as evaluation_judge
import rag_eval.adapters.groq_judge as groq_judge
from rag_eval.adapters.groq_judge import configured_max_completion_tokens


def test_selects_groq_provider(monkeypatch):
    monkeypatch.setenv("RAG_EVAL_JUDGE_PROVIDER", "groq")
    monkeypatch.setattr(
        evaluation_judge,
        "build_groq_live_judge",
        lambda: ("suite", "client", "model"),
    )
    assert evaluation_judge.build_live_judge() == ("suite", "client", "model")


def test_selects_cloudflare_by_default(monkeypatch):
    monkeypatch.delenv("RAG_EVAL_JUDGE_PROVIDER", raising=False)
    monkeypatch.setattr(
        evaluation_judge,
        "build_cloudflare_live_judge",
        lambda: ("suite", "client", "model"),
    )
    assert evaluation_judge.build_live_judge() == ("suite", "client", "model")


def test_rejects_unknown_provider(monkeypatch):
    monkeypatch.setenv("RAG_EVAL_JUDGE_PROVIDER", "unknown")
    with pytest.raises(ValueError, match="expected cloudflare or groq"):
        evaluation_judge.build_live_judge()


def test_groq_structured_output_budget_defaults_to_evidence_backed_value(monkeypatch):
    monkeypatch.delenv("RAGAS_MAX_COMPLETION_TOKENS", raising=False)
    assert configured_max_completion_tokens() == 512


def test_groq_structured_output_budget_preserves_explicit_override(monkeypatch):
    monkeypatch.setenv("RAGAS_MAX_COMPLETION_TOKENS", "1024")
    assert configured_max_completion_tokens() == 1024


def test_groq_structured_llm_uses_local_markdown_json_validation(monkeypatch):
    client = AsyncOpenAI(api_key="test", base_url="http://127.0.0.1:9")
    observed = {}
    original = groq_judge.instructor.from_openai

    def capture(value, *, mode):
        observed["mode"] = mode
        return original(value, mode=mode)

    monkeypatch.setattr(groq_judge.instructor, "from_openai", capture)
    llm = groq_judge.build_groq_structured_llm(client, "openai/gpt-oss-120b", 512)

    assert observed["mode"] is instructor.Mode.MD_JSON
    assert llm.model_args["max_tokens"] == 512
