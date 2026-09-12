import pytest

import rag_eval.adapters.evaluation_judge as evaluation_judge


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
