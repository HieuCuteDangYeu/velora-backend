"""Evaluation-only Groq judge with local TEI embeddings."""

import os
from typing import Any

import instructor
from openai import AsyncOpenAI
from ragas.embeddings import embedding_factory
from ragas.llms.base import InstructorLLM, InstructorModelArgs

from rag_eval.judge_runtime import JudgeUsageTracker
from rag_eval.metrics.semantic import build_live_semantic_suite


def configured_max_completion_tokens() -> int:
    """Return the Groq structured-output budget, preserving an explicit override."""

    try:
        configured = int(os.getenv("RAGAS_MAX_COMPLETION_TOKENS", "512"))
    except ValueError:
        configured = 512
    return min(4096, max(64, configured))


def build_groq_structured_llm(
    client: AsyncOpenAI, model: str, max_completion_tokens: int
) -> InstructorLLM:
    """Use JSON text mode so Groq validates the result locally via Pydantic.

    Groq's native ``json_object`` path can reject otherwise valid Ragas
    schemas with ``json_validate_failed``. Markdown-JSON mode does not send a
    provider-side schema; Instructor still extracts and strictly validates the
    requested Pydantic response model.
    """

    patched_client = instructor.from_openai(client, mode=instructor.Mode.MD_JSON)
    return InstructorLLM(
        client=patched_client,
        model=model,
        provider="openai",
        model_args=InstructorModelArgs(),
        temperature=0.0,
        max_tokens=max_completion_tokens,
    )


def build_live_judge() -> tuple[Any, Any, str]:
    judge_model = os.environ["RAG_EVAL_JUDGE_MODEL"]
    token = os.environ["GROQ_API_KEY"]
    base_url = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip(
        "/"
    )
    embedding_model = os.getenv("RAG_EVAL_EMBEDDING_MODEL", "BAAI/bge-m3")
    embedding_base_url = os.environ["RAG_EVAL_TEI_EMBEDDING_BASE_URL"].rstrip("/")
    max_completion_tokens = configured_max_completion_tokens()

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
    usage_tracker = JudgeUsageTracker(judge_client, provider="groq")
    llm = build_groq_structured_llm(judge_client, judge_model, max_completion_tokens)
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
