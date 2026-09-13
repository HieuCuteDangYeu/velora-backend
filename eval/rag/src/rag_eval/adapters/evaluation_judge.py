"""Provider selection for evaluation-only semantic judging."""

import os

from rag_eval.adapters.cloudflare_judge import (
    build_live_judge as build_cloudflare_live_judge,
)
from rag_eval.adapters.groq_judge import build_live_judge as build_groq_live_judge


def build_live_judge():
    provider = os.getenv("RAG_EVAL_JUDGE_PROVIDER", "cloudflare").strip().lower()
    if provider == "cloudflare":
        return build_cloudflare_live_judge()
    if provider == "groq":
        return build_groq_live_judge()
    raise ValueError(
        "Unsupported RAG_EVAL_JUDGE_PROVIDER; expected cloudflare or groq"
    )
