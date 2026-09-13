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
from rag_eval.tpd_ledger import GroqDailyTokenLedger, LedgerPersistenceError, parse_timestamp

DEFAULT_PROBE_MODELS = ("openai/gpt-oss-120b",)
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


DEFAULT_TPD_PLANNED_TOKENS = 54_048
TPD_LIMIT_SCHEMA = "groq-tpd-limit-attestation-v1"
TPD_WINDOW_SCHEMA = "groq-tpd-window-attestation-v1"
TPD_WINDOW_SCOPES = {"TPD", "TPD_WINDOW"}


def _read_json(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _model_attestation(payload: dict[str, Any], model: str) -> dict[str, Any] | None:
    models = payload.get("models")
    if isinstance(models, dict):
        value = models.get(model)
        return value if isinstance(value, dict) else None
    if payload.get("model") == model:
        return payload
    return None


def _attestation_is_fresh(
    payload: dict[str, Any],
    *,
    expected_schema: str,
    expected_scopes: set[str],
    now: datetime,
    max_age_seconds: int,
) -> bool:
    if str(payload.get("provider", "")).lower() != "groq":
        return False
    if payload.get("schemaVersion") != expected_schema:
        return False
    if payload.get("scope") not in expected_scopes:
        return False
    source = str(payload.get("source", "")).lower()
    if not source or "header" in source or "ratelimit" in source:
        return False
    observed_at = parse_timestamp(payload.get("observedAt"))
    if observed_at is None:
        return False
    age_seconds = (now - observed_at).total_seconds()
    return 0 <= age_seconds <= max_age_seconds


def _integer(value: Any, *, minimum: int = 0) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    converted = int(value)
    return converted if converted >= minimum else None


def tpd_headroom(
    attestation_path: str | None,
    models: tuple[str, ...],
    *,
    ledger_path: str | None = None,
    limit_attestation_path: str | None = None,
    window_attestation_path: str | None = None,
    now: datetime | None = None,
    max_age_seconds: int | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(UTC)
    age_limit = (
        max_age_seconds
        if max_age_seconds is not None
        else _positive_int("RAGAS_GROQ_TPD_ATTESTATION_MAX_AGE_SECONDS", 3_600)
    )
    legacy = _read_json(attestation_path)
    limit_payload = _read_json(limit_attestation_path)
    window_payload = _read_json(window_attestation_path)
    if legacy is not None and (limit_payload is None or window_payload is None):
        scope = legacy.get("scope")
        if scope == "TPD_LIMIT" and limit_payload is None:
            limit_payload = legacy
        elif scope in TPD_WINDOW_SCOPES and window_payload is None:
            window_payload = legacy
        elif scope not in {"TPD_LIMIT", "TPD", "TPD_WINDOW"}:
            return {"status": "UNKNOWN", "reason": "TPD_ATTESTATION_SCOPE_INVALID"}

    if limit_payload is None or window_payload is None:
        return {"status": "UNKNOWN", "reason": "TPD_WINDOW_BASELINE_REQUIRED"}
    if not _attestation_is_fresh(
        limit_payload,
        expected_schema=TPD_LIMIT_SCHEMA,
        expected_scopes={"TPD_LIMIT"},
        now=current,
        max_age_seconds=age_limit,
    ):
        return {"status": "UNKNOWN", "reason": "TPD_LIMIT_ATTESTATION_INVALID_OR_STALE"}
    if not _attestation_is_fresh(
        window_payload,
        expected_schema=TPD_WINDOW_SCHEMA,
        expected_scopes=TPD_WINDOW_SCOPES,
        now=current,
        max_age_seconds=age_limit,
    ):
        return {"status": "UNKNOWN", "reason": "TPD_WINDOW_ATTESTATION_INVALID_OR_STALE"}

    ledger = GroqDailyTokenLedger(ledger_path) if ledger_path else GroqDailyTokenLedger.from_env()
    results = []
    if not models:
        return {"status": "UNKNOWN", "reason": "TPD_MODELS_MISSING"}
    for model in models:
        limit_value = _model_attestation(limit_payload, model)
        window_value = _model_attestation(window_payload, model)
        if limit_value is None or window_value is None:
            return {"status": "UNKNOWN", "reason": f"TPD_MODEL_ATTESTATION_MISSING:{model}"}
        daily_limit = _integer(limit_value.get("dailyLimitTokens"), minimum=1)
        window_limit = (
            _integer(window_value.get("dailyLimitTokens"), minimum=1)
            if "dailyLimitTokens" in window_value
            else daily_limit
        )
        baseline_usage = _integer(window_value.get("usageSinceWindowStartTokens"))
        observed_at = parse_timestamp(window_payload.get("observedAt"))
        window_started_at = parse_timestamp(
            window_payload.get("windowStartedAt") or window_value.get("windowStartedAt")
        )
        if (
            daily_limit is None
            or baseline_usage is None
            or window_limit is None
            or window_limit != daily_limit
            or observed_at is None
        ):
            return {"status": "UNKNOWN", "reason": f"TPD_MODEL_ATTESTATION_INCOMPLETE:{model}"}
        if window_started_at is None:
            if window_payload.get("source") == "operator-observed-fresh-window":
                window_started_at = observed_at
            else:
                return {"status": "UNKNOWN", "reason": "TPD_WINDOW_START_UNPROVEN"}
        if window_started_at > current:
            return {"status": "UNKNOWN", "reason": "TPD_WINDOW_START_IN_FUTURE"}
        if window_started_at > observed_at:
            return {"status": "UNKNOWN", "reason": "TPD_WINDOW_START_AFTER_OBSERVATION"}
        configured_required = _positive_int(
            "RAGAS_GROQ_TPD_PLANNED_FULL_RUN_TOKENS", DEFAULT_TPD_PLANNED_TOKENS
        )
        attested_required = window_value.get("plannedFullRunTokens")
        if (
            attested_required is not None
            and _integer(attested_required, minimum=1) != configured_required
        ):
            return {"status": "UNKNOWN", "reason": "TPD_PLANNED_BUDGET_MISMATCH"}
        required = _integer(
            window_payload.get("plannedFullRunTokens", configured_required),
            minimum=1,
        )
        if required != configured_required:
            return {"status": "UNKNOWN", "reason": "TPD_PLANNED_BUDGET_MISMATCH"}
        if required is None:
            return {"status": "UNKNOWN", "reason": "TPD_PLANNED_BUDGET_UNAVAILABLE"}
        try:
            ledger_usage = ledger.usage_since(model, window_started_at, now=current)
        except LedgerPersistenceError:
            return {"status": "UNKNOWN", "reason": "TPD_LEDGER_UNAVAILABLE"}
        known_used = baseline_usage + ledger_usage
        remaining = daily_limit - known_used
        results.append(
            {
                "model": model,
                "dailyLimitTokens": daily_limit,
                "baselineUsageTokens": baseline_usage,
                "ledgerUsedTokens": ledger_usage,
                "knownUsedTokens": known_used,
                "calculatedRemainingTokens": remaining,
                "plannedFullRunTokens": required,
                "observedAt": window_payload.get("observedAt"),
                "limitSource": limit_payload.get("source"),
                "limitObservedAt": limit_payload.get("observedAt"),
                "windowSource": window_payload.get("source"),
                "windowObservedAt": window_payload.get("observedAt"),
                "windowStartedAt": window_started_at.isoformat().replace("+00:00", "Z"),
                "source": window_payload.get("source"),
                "headroom": remaining >= required,
            }
        )
    return {
        "status": "YES" if all(item["headroom"] for item in results) else "NO",
        "reason": "MODEL_TPD_ATTESTATION_EVALUATED",
        "models": results,
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
        getattr(args, "tpd_attestation", None) or os.getenv("RAGAS_GROQ_TPD_ATTESTATION_PATH"),
        models,
        ledger_path=getattr(args, "ledger_path", None) or os.getenv("RAGAS_GROQ_DAILY_LEDGER_PATH"),
        limit_attestation_path=getattr(args, "tpd_limit_attestation", None)
        or os.getenv("RAGAS_GROQ_TPD_LIMIT_ATTESTATION_PATH"),
        window_attestation_path=getattr(args, "tpd_window_attestation", None)
        or os.getenv("RAGAS_GROQ_TPD_WINDOW_ATTESTATION_PATH"),
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
    details = tpd.get("models", [{}])
    first_tpd = details[0] if details and isinstance(details[0], dict) else {}
    print(f"TPD_ATTESTATION_SOURCE={first_tpd.get('limitSource', 'UNKNOWN')}")
    print(f"TPD_ATTESTATION_OBSERVED_AT={first_tpd.get('limitObservedAt', 'UNKNOWN')}")
    print(f"TPD_WINDOW_ATTESTATION_SOURCE={first_tpd.get('windowSource', 'UNKNOWN')}")
    print(f"TPD_WINDOW_ATTESTATION_OBSERVED_AT={first_tpd.get('windowObservedAt', 'UNKNOWN')}")
    print(
        "TPD_WINDOW_BASELINE_STATUS="
        + ("ATTESTED_AND_LEDGER_ACCOUNTED" if first_tpd else "UNKNOWN")
    )
    print(f"TPD_DAILY_LIMIT_TOKENS={first_tpd.get('dailyLimitTokens', 'UNKNOWN')}")
    print(f"TPD_LEDGER_USED_TOKENS={first_tpd.get('ledgerUsedTokens', 'UNKNOWN')}")
    print(
        f"TPD_CALCULATED_REMAINING_TOKENS={first_tpd.get('calculatedRemainingTokens', 'UNKNOWN')}"
    )
    print(
        "TPD_PLANNED_FULL_RUN_TOKENS="
        f"{first_tpd.get('plannedFullRunTokens', DEFAULT_TPD_PLANNED_TOKENS)}"
    )
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
