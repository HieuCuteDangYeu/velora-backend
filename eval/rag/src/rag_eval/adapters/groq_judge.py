"""Evaluation-only Groq judge with local TEI embeddings."""

import os
from typing import Any

from openai import AsyncOpenAI
from ragas.embeddings import embedding_factory
from ragas.llms import llm_factory

from rag_eval.adapters.cloudflare_judge import JudgeUsageTracker
from rag_eval.metrics.semantic import build_live_semantic_suite


def build_live_judge() -> tuple[Any, Any, str]:
    judge_model = os.environ["RAG_EVAL_JUDGE_MODEL"]
    token = os.environ["GROQ_API_KEY"]
    base_url = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip(
        "/"
    )
    embedding_model = os.getenv("RAG_EVAL_EMBEDDING_MODEL", "BAAI/bge-m3")
    embedding_base_url = os.environ["RAG_EVAL_TEI_EMBEDDING_BASE_URL"].rstrip("/")

    judge_client = AsyncOpenAI(
        api_key=token,
        base_url=base_url,
        max_retries=0,
    )
    embedding_client = AsyncOpenAI(
        api_key=os.getenv("RAG_EVAL_TEI_EMBEDDING_API_KEY", "local-tei"),
        base_url=embedding_base_url,
        max_retries=0,
    )
    usage_tracker = JudgeUsageTracker(judge_client)
    llm = llm_factory(
        model=judge_model,
        provider="openai",
        client=judge_client,
        temperature=0.0,
        max_tokens=2048,
    )
    embeddings = embedding_factory(
        provider="openai",
        model=embedding_model,
        client=embedding_client,
    )
    return (
        build_live_semantic_suite(llm, embeddings, usage_tracker),
        judge_client,
        judge_model,
    )
