"""Evaluation-only OpenAI-compatible Cloudflare adapter."""

import os
from typing import Any

from openai import AsyncOpenAI
from ragas.embeddings import embedding_factory
from ragas.llms import llm_factory

from rag_eval.judge_runtime import JudgeUsageTracker
from rag_eval.metrics.semantic import build_live_semantic_suite


def cloudflare_base_url() -> str:
    configured = os.getenv("RAG_EVAL_CLOUDFLARE_BASE_URL")
    if configured:
        return configured.rstrip("/")
    account_id = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    return f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1"


def build_live_judge() -> tuple[Any, Any, Any]:
    judge_model = os.environ["RAG_EVAL_JUDGE_MODEL"]
    embedding_model = os.environ["RAG_EVAL_EMBEDDING_MODEL"]
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    client = AsyncOpenAI(
        api_key=token,
        base_url=cloudflare_base_url(),
        max_retries=0,
    )
    usage_tracker = JudgeUsageTracker(client, provider="cloudflare")
    llm = llm_factory(model=judge_model, provider="openai", client=client)
    embeddings = embedding_factory(provider="openai", model=embedding_model, client=client)
    return (
        build_live_semantic_suite(llm, embeddings, usage_tracker),
        client,
        judge_model,
    )


def build_capacity_client() -> tuple[AsyncOpenAI, str]:
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    model = os.getenv("RAG_EVAL_CAPACITY_MODEL", "@cf/openai/gpt-oss-20b")
    return (
        AsyncOpenAI(
            api_key=token,
            base_url=cloudflare_base_url(),
            max_retries=0,
        ),
        model,
    )


def classify_capacity_error(status: int | None, code: int | None, message: str) -> str:
    normalized = message.lower()
    daily_allocation = (
        ("daily" in normalized or "per day" in normalized)
        and any(term in normalized for term in ("allocation", "quota", "limit"))
        and any(
            term in normalized
            for term in ("exhausted", "exceeded", "limited", "reached", "used up")
        )
    )
    if status == 429 and (code == 3036 or daily_allocation):
        return "ACCOUNT_LIMITED"
    if status == 429 and code == 3040:
        return "OUT_OF_CAPACITY"
    if status == 429 and ("rate limit" in normalized or "too many requests" in normalized):
        return "RATE_LIMITED"
    return "UNKNOWN_PROVIDER_FAILURE"


def capacity_message_class(message: str) -> str:
    normalized = message.lower()
    if classify_capacity_error(429, None, message) == "ACCOUNT_LIMITED":
        return "DAILY_ALLOCATION_ACCOUNT_LIMIT"
    if any(term in normalized for term in ("out of capacity", "temporary capacity")):
        return "TEMPORARY_CAPACITY"
    if "rate limit" in normalized or "too many requests" in normalized:
        return "RATE_LIMIT"
    return "NO_SAFE_PROVIDER_MESSAGE"
