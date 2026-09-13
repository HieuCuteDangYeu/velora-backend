"""Provider-only quota preflight for live frozen evaluations."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from rag_eval.judge_runtime import JudgeRateLimiter

DEFAULT_PROBE_MODELS = (
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
)
RATE_LIMIT_HEADERS = (
    "retry-after",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
)


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _nonnegative_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value >= 0 else default


def _header_map(headers: Any) -> dict[str, str]:
    return {
        str(key).lower(): str(value)
        for key, value in headers.items()
        if str(key).lower() in RATE_LIMIT_HEADERS
    }


def _response_headers(headers: Any) -> dict[str, str]:
    return {key: value for key, value in _header_map(headers).items()}


def _probe_sync(model: str, base_url: str, api_key: str, timeout: float) -> dict[str, Any]:
    request = Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(
            {
                "model": model,
                "messages": [{"role": "user", "content": "Reply OK."}],
                "max_tokens": 1,
                "temperature": 0,
            }
        ).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "velora-rag-eval-preflight/1",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            response.read(512)
            return {
                "model": model,
                "status": response.status,
                "networkReachable": True,
                "headers": _response_headers(response.headers),
                "dailyQuotaError": False,
            }
    except HTTPError as error:
        body = error.read(4096).decode("utf-8", "replace").lower()
        return {
            "model": model,
            "status": error.code,
            "networkReachable": True,
            "headers": _response_headers(error.headers),
            "dailyQuotaError": any(
                marker in body
                for marker in (
                    "tokens per day",
                    "daily quota",
                    "daily token limit",
                    "quota exhausted",
                    "quota exceeded",
                )
            ),
        }
    except (OSError, TimeoutError, URLError):
        return {
            "model": model,
            "status": None,
            "networkReachable": False,
            "headers": {},
            "dailyQuotaError": False,
        }


async def probe_groq(
    models: tuple[str, ...], base_url: str, api_key: str, timeout: float
) -> list[dict[str, Any]]:
    results = []
    for model in models:
        results.append(await asyncio.to_thread(_probe_sync, model, base_url, api_key, timeout))
    return results


def scheduler_snapshot(provider: str = "groq") -> dict[str, Any]:
    limiter = JudgeRateLimiter.from_env(provider)
    stats = limiter.stats()
    return {
        "provider": stats["provider"],
        "concurrency": stats["concurrency"],
        "tpmLimit": stats["tpmLimit"],
        "tpmTarget": stats["tpmTarget"],
        "headersEnabled": os.getenv("RAGAS_RATE_LIMIT_HEADERS_ENABLED", "true").lower() != "false",
        "maxRetries": _nonnegative_int("RAGAS_JUDGE_429_MAX_RETRIES", 2),
    }


def scheduler_ready(snapshot: dict[str, Any]) -> bool:
    target = snapshot.get("tpmTarget")
    limit = snapshot.get("tpmLimit")
    return bool(
        snapshot.get("provider") == "groq"
        and isinstance(limit, int)
        and limit > 0
        and isinstance(target, int)
        and 0 < target <= 6_000
        and target <= limit
        and snapshot.get("concurrency", 0) >= 1
        and snapshot.get("headersEnabled") is True
        and snapshot.get("maxRetries", -1) >= 0
    )


def first_request_tpm_headroom(
    probe: dict[str, Any], required_tokens: int
) -> tuple[bool, int | None]:
    value = probe.get("headers", {}).get("x-ratelimit-remaining-tokens")
    try:
        remaining = int(float(value))
    except (TypeError, ValueError):
        return False, None
    return (
        probe.get("status", 0) in range(200, 300)
        and required_tokens > 0
        and remaining >= required_tokens,
        remaining,
    )


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _remaining_tokens(value: dict[str, Any]) -> int | None:
    direct = value.get("dailyRemainingTokens")
    if isinstance(direct, (int, float)):
        return int(direct)
    limit = value.get("dailyLimitTokens")
    used = value.get("dailyUsedTokens")
    if isinstance(limit, (int, float)) and isinstance(used, (int, float)):
        return int(limit - used)
    return None


def _required_tokens(value: dict[str, Any]) -> int | None:
    for key in ("requiredTokens", "plannedFullRunTokens"):
        candidate = value.get(key)
        if isinstance(candidate, (int, float)) and candidate > 0:
            return int(candidate)
    return None


def tpd_headroom(
    attestation_path: str | None,
    models: tuple[str, ...],
    *,
    now: datetime | None = None,
    max_age_seconds: int | None = None,
) -> dict[str, Any]:
    if not attestation_path:
        return {"status": "UNKNOWN", "reason": "INDEPENDENT_TPD_ATTESTATION_REQUIRED"}

    try:
        payload = json.loads(Path(attestation_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"status": "UNKNOWN", "reason": "TPD_ATTESTATION_UNREADABLE"}
    if not isinstance(payload, dict):
        return {"status": "UNKNOWN", "reason": "TPD_ATTESTATION_INVALID"}
    if str(payload.get("provider", "")).lower() != "groq" or payload.get("scope") != "TPD":
        return {"status": "UNKNOWN", "reason": "TPD_ATTESTATION_SCOPE_INVALID"}
    source = str(payload.get("source", "")).lower()
    if not source or "header" in source or "ratelimit" in source:
        return {"status": "UNKNOWN", "reason": "TPD_ATTESTATION_NOT_INDEPENDENT"}
    observed_at = _parse_timestamp(payload.get("observedAt"))
    if observed_at is None:
        return {"status": "UNKNOWN", "reason": "TPD_ATTESTATION_TIMESTAMP_INVALID"}
    current = now or datetime.now(UTC)
    age_limit = max_age_seconds or _positive_int(
        "RAGAS_GROQ_TPD_ATTESTATION_MAX_AGE_SECONDS", 3_600
    )
    if (current - observed_at).total_seconds() > age_limit:
        return {"status": "UNKNOWN", "reason": "TPD_ATTESTATION_STALE"}

    model_values = payload.get("models")
    if isinstance(model_values, dict):
        checks = []
        for model in models:
            value = model_values.get(model)
            if not isinstance(value, dict):
                return {"status": "UNKNOWN", "reason": f"TPD_MODEL_ATTESTATION_MISSING:{model}"}
            remaining = _remaining_tokens(value)
            required = _required_tokens(value)
            if remaining is None or required is None:
                return {"status": "UNKNOWN", "reason": f"TPD_MODEL_ATTESTATION_INCOMPLETE:{model}"}
            checks.append(remaining >= required)
        return {
            "status": "YES" if all(checks) else "NO",
            "reason": "MODEL_TPD_ATTESTATION_EVALUATED",
        }

    remaining = _remaining_tokens(payload)
    required = _required_tokens(payload)
    if remaining is None or required is None:
        return {"status": "UNKNOWN", "reason": "TPD_ATTESTATION_INCOMPLETE"}
    return {
        "status": "YES" if remaining >= required else "NO",
        "reason": "ACCOUNT_TPD_ATTESTATION_EVALUATED",
    }


def _models(value: str | None) -> tuple[str, ...]:
    raw = value or os.getenv("RAGAS_PREFLIGHT_MODELS")
    values = raw.split(",") if raw else list(DEFAULT_PROBE_MODELS)
    models = tuple(item.strip() for item in values if item.strip())
    return models or DEFAULT_PROBE_MODELS


async def run_preflight(args: argparse.Namespace) -> int:
    provider = "groq"
    snapshot = scheduler_snapshot(provider)
    models = _models(args.models)
    requested_first_model = args.first_model or os.getenv("RAGAS_PREFLIGHT_FIRST_MODEL", models[0])
    first_model = requested_first_model if requested_first_model in models else models[0]
    first_tokens = args.first_operation_tokens or _positive_int(
        "RAGAS_PREFLIGHT_FIRST_OPERATION_TOKENS", snapshot["tpmTarget"] or 1
    )
    api_key = os.getenv("GROQ_API_KEY")
    base_url = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
    probes = (
        await probe_groq(models, base_url, api_key, args.timeout)
        if api_key
        else [
            {
                "model": model,
                "status": None,
                "networkReachable": False,
                "headers": {},
                "dailyQuotaError": False,
            }
            for model in models
        ]
    )
    first_probe = next((probe for probe in probes if probe["model"] == first_model), probes[0])
    first_headroom, remaining = first_request_tpm_headroom(first_probe, first_tokens)
    tpd = tpd_headroom(
        args.tpd_attestation or os.getenv("RAGAS_GROQ_TPD_ATTESTATION_PATH"),
        models,
    )
    provider_reachable = all(probe["networkReachable"] for probe in probes)
    daily_quota_error = any(probe["dailyQuotaError"] for probe in probes)
    if daily_quota_error:
        tpd = {"status": "NO", "reason": "PROVIDER_DAILY_QUOTA_ERROR"}
    ready = scheduler_ready(snapshot)
    all_gates_pass = provider_reachable and ready and first_headroom and tpd["status"] == "YES"

    print(f"PROVIDER_REACHABLE={'YES' if provider_reachable else 'NO'}")
    print(f"TPM_SCHEDULER_READY={'YES' if ready else 'NO'}")
    print(f"TPM_LIMIT_TOKENS={first_probe['headers'].get('x-ratelimit-limit-tokens', 'UNKNOWN')}")
    print(f"TPM_REMAINING_TOKENS={remaining if remaining is not None else 'UNKNOWN'}")
    print(f"TPM_RESET_TOKENS={first_probe['headers'].get('x-ratelimit-reset-tokens', 'UNKNOWN')}")
    print(f"TPM_TARGET_TOKENS={snapshot.get('tpmTarget', 'UNKNOWN')}")
    print(f"FIRST_REQUEST_MODEL={first_model}")
    print(f"FIRST_REQUEST_TPM_REQUIRED_TOKENS={first_tokens}")
    print(f"FIRST_REQUEST_TPM_HEADROOM={'YES' if first_headroom else 'NO'}")
    print(f"TPD_HEADROOM_FOR_FULL_RUN={tpd['status']}")
    print(f"TPD_HEADROOM_REASON={tpd['reason']}")
    print(f"PREFLIGHT_PASS={'YES' if all_gates_pass else 'NO'}")
    if not all_gates_pass:
        print("FROZEN_V3_RUN_STARTED=NO")
        blocker = (
            "GROQ_TPD_HEADROOM_UNAVAILABLE"
            if tpd["status"] != "YES"
            else "GROQ_TPM_PREFLIGHT_FAILED"
        )
        print(f"BLOCKER={blocker}")
    return 0 if all_gates_pass else 1
