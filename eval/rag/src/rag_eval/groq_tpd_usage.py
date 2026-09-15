"""Exact Groq Organization Usage API TPD baseline validation."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from typing import Any

from rag_eval.tpd_ledger import GroqDailyTokenLedger, LedgerPersistenceError, parse_timestamp

USAGE_BASELINE_SCHEMA = "groq-tpd-usage-baseline-v1"
DEFAULT_DAILY_LIMIT_TOKENS = 200_000
DEFAULT_PLANNED_FULL_RUN_TOKENS = 54_048
MIN_QUIET_PERIOD_SECONDS = 900
FORBIDDEN_IDENTIFIER_KEYS = {
    "organization_id",
    "organizationid",
    "project_id",
    "projectid",
    "api_key_id",
    "apikeyid",
    "api_key_redacted",
    "apikeyredacted",
}


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _integer(value: Any, *, minimum: int = 0) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= minimum else None


def _fresh_observation(
    payload: dict[str, Any], now: datetime, max_age_seconds: int
) -> datetime | None:
    observed_at = parse_timestamp(payload.get("observedAt"))
    if observed_at is None:
        return None
    age_seconds = (now - observed_at).total_seconds()
    return observed_at if 0 <= age_seconds <= max_age_seconds else None


def _contains_forbidden_identifier(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            str(key).lower() in FORBIDDEN_IDENTIFIER_KEYS or _contains_forbidden_identifier(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_forbidden_identifier(item) for item in value)
    return False


def _field(payload: dict[str, Any], normalized: str, raw: str) -> Any:
    normalized_value = payload.get(normalized)
    raw_value = payload.get(raw)
    if normalized_value is not None and raw_value is not None and normalized_value != raw_value:
        return None
    return normalized_value if normalized_value is not None else raw_value


def _limit_matches(
    payload: dict[str, Any], *, model: str, now: datetime, max_age_seconds: int
) -> bool:
    if (
        payload.get("schemaVersion") != "groq-tpd-limit-attestation-v1"
        or payload.get("provider") != "groq"
        or payload.get("scope") != "TPD_LIMIT"
        or _fresh_observation(payload, now, max_age_seconds) is None
    ):
        return False
    source = str(payload.get("source", "")).lower()
    if not source or "header" in source or "ratelimit" in source:
        return False
    values = payload.get("models")
    value = values.get(model) if isinstance(values, dict) else None
    return (
        isinstance(value, dict)
        and _integer(value.get("dailyLimitTokens")) == DEFAULT_DAILY_LIMIT_TOKENS
    )


def exact_usage_tpd_headroom(
    payload: dict[str, Any],
    models: tuple[str, ...],
    ledger: GroqDailyTokenLedger,
    *,
    limit_payload: dict[str, Any] | None = None,
    now: datetime | None = None,
    max_age_seconds: int = 3_600,
) -> dict[str, Any]:
    current = now or datetime.now(UTC)
    if (
        payload.get("schemaVersion") != USAGE_BASELINE_SCHEMA
        or payload.get("provider") != "groq"
        or payload.get("scope") != "TPD"
        or payload.get("source") != "groq-console-organization-usage-api"
        or payload.get("organizationScope") != "all-projects"
        or len(models) != 1
        or payload.get("model") != models[0]
        or _contains_forbidden_identifier(payload)
    ):
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_BASELINE_SCOPE_OR_MODEL_INVALID"}

    model = models[0]
    observed_at = _fresh_observation(payload, current, max_age_seconds)
    if observed_at is None:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_BASELINE_STALE_OR_INVALID"}
    if limit_payload is not None and not _limit_matches(
        limit_payload, model=model, now=current, max_age_seconds=max_age_seconds
    ):
        return {"status": "UNKNOWN", "reason": "TPD_LIMIT_ATTESTATION_INVALID_OR_STALE"}

    window_date = payload.get("windowDateUtc")
    expected_date = current.astimezone(UTC).date().isoformat()
    attested_bucket_timestamp = payload.get("usageBucketTimestamp")
    response_bucket_timestamp = payload.get("timestamp")
    if (
        attested_bucket_timestamp is not None
        and response_bucket_timestamp is not None
        and attested_bucket_timestamp != response_bucket_timestamp
    ):
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_BUCKET_INVALID"}
    bucket_timestamp = _integer(
        attested_bucket_timestamp
        if attested_bucket_timestamp is not None
        else response_bucket_timestamp,
        minimum=1,
    )
    if window_date != expected_date or bucket_timestamp is None:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_BUCKET_INVALID"}
    expected_bucket = int(datetime.fromisoformat(f"{expected_date}T00:00:00+00:00").timestamp())
    if bucket_timestamp != expected_bucket:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_BUCKET_STALE_OR_MISMATCHED"}
    bucket_at = datetime.fromtimestamp(bucket_timestamp, UTC)
    if bucket_at > current or observed_at < bucket_at:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_BUCKET_INVALID"}

    quiet_period = _integer(
        payload.get("verifiedQuietPeriodSeconds"), minimum=MIN_QUIET_PERIOD_SECONDS
    )
    console_delay = _integer(payload.get("consoleMaxReportingDelaySeconds"), minimum=0)
    if quiet_period is None:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_QUIET_PERIOD_PROOF_REQUIRED"}
    if console_delay is not None and quiet_period < console_delay:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_QUIET_PERIOD_TOO_SHORT"}

    context_tokens = _integer(_field(payload, "contextTokens", "n_context_tokens_total"))
    non_cached_tokens = _integer(
        _field(payload, "nonCachedInputTokens", "n_non_cached_context_tokens_total")
    )
    cached_normalized = payload.get("cachedInputTokens")
    cached_raw = payload.get("n_cached_context_tokens_total")
    if (
        cached_normalized is not None
        and cached_raw is not None
        and cached_normalized != cached_raw
    ):
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_CACHED_TOKEN_FIELDS_MISMATCH"}
    cached_value = cached_normalized if cached_normalized is not None else cached_raw
    cached_tokens = _integer(cached_value)
    cached_tokens_omitted = cached_value is None
    if cached_tokens_omitted:
        if (
            payload.get("cachedInputTokensOmitted") is not True
            or payload.get("cachedInputTokensOmissionReason")
            != "CONTEXT_EQUALS_NON_CACHED"
            or context_tokens is None
            or non_cached_tokens is None
            or context_tokens != non_cached_tokens
        ):
            return {"status": "UNKNOWN", "reason": "TPD_USAGE_CACHED_TOKEN_FIELDS_INCOMPLETE"}
        cached_tokens = 0
    elif payload.get("cachedInputTokensOmitted") is True:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_CACHED_TOKEN_OMISSION_INVALID"}
    generated_tokens = _integer(_field(payload, "generatedTokens", "n_generated_tokens_total"))
    counted_tokens = _integer(payload.get("rateLimitCountedUsedTokens"))
    if None in (context_tokens, non_cached_tokens, cached_tokens, generated_tokens, counted_tokens):
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_TOKEN_FIELDS_INCOMPLETE"}
    if context_tokens != non_cached_tokens + cached_tokens:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_CONTEXT_TOKEN_BREAKDOWN_MISMATCH"}
    if counted_tokens != non_cached_tokens + generated_tokens:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_COUNTED_TOKEN_FORMULA_MISMATCH"}

    request_count = _field(payload, "numRequests", "num_requests")
    if request_count is not None and _integer(request_count) is None:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_REQUEST_COUNT_INVALID"}
    daily_limit = _integer(payload.get("dailyLimitTokens"), minimum=1)
    planned = _integer(payload.get("plannedFullRunTokens"), minimum=1)
    configured_planned = _positive_int(
        "RAGAS_GROQ_TPD_PLANNED_FULL_RUN_TOKENS", DEFAULT_PLANNED_FULL_RUN_TOKENS
    )
    if daily_limit != DEFAULT_DAILY_LIMIT_TOKENS:
        return {"status": "UNKNOWN", "reason": "TPD_USAGE_LIMIT_INVALID"}
    if planned != configured_planned:
        return {"status": "UNKNOWN", "reason": "TPD_PLANNED_BUDGET_MISMATCH"}

    observed_at_text = observed_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
    window_key = f"{window_date}:{bucket_timestamp}"
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "bucketTimestamp": bucket_timestamp,
                "contextTokens": context_tokens,
                "nonCachedInputTokens": non_cached_tokens,
                "cachedInputTokens": cached_tokens,
                "cachedInputTokensOmitted": cached_tokens_omitted,
                "cachedInputTokensSource": (
                    "DERIVED_CONTEXT_MINUS_NON_CACHED"
                    if cached_tokens_omitted
                    else "PROVIDER"
                ),
                "generatedTokens": generated_tokens,
                "countedTokens": counted_tokens,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    try:
        previous_baseline = ledger.latest_baseline(
            provider="groq",
            model=model,
            organization_scope=payload["organizationScope"],
            window_key=window_key,
        )
        baseline_id = ledger.initialize_baseline(
            provider="groq",
            model=model,
            observed_at=observed_at_text,
            daily_limit_tokens=daily_limit,
            baseline_used_tokens=counted_tokens,
            organization_scope=payload["organizationScope"],
            window_key=window_key,
            baseline_fingerprint=fingerprint,
            pricing_version=USAGE_BASELINE_SCHEMA,
            allow_refresh=True,
        )
        day_start = datetime.fromisoformat(f"{window_date}T00:00:00+00:00")
        ledger_before_observation = ledger.usage_between(
            model, day_start, observed_at, include_start=True, include_end=False
        )
        ledger_after_observation = ledger.usage_between(
            model, observed_at, current, include_start=True, include_end=True
        )
    except LedgerPersistenceError:
        return {"status": "UNKNOWN", "reason": "TPD_LEDGER_BASELINE_UNAVAILABLE"}

    cost_only_remaining = max(0, daily_limit - counted_tokens)
    effective_used = max(counted_tokens, ledger_before_observation) + ledger_after_observation
    ledger_used = ledger_before_observation + ledger_after_observation
    proven_remaining = max(0, daily_limit - effective_used)
    unreconciled_ledger = (
        max(0, ledger_before_observation - counted_tokens) + ledger_after_observation
    )
    epoch_proven_remaining = proven_remaining
    epoch_ledger_used = effective_used
    epoch_ledger_epoch = (
        previous_baseline.get("ledgerEpoch")
        if previous_baseline is not None
        else baseline_id
    )
    baseline_refresh_of = (
        previous_baseline.get("baselineId")
        if previous_baseline is not None and previous_baseline.get("baselineId") != baseline_id
        else previous_baseline.get("baselineRefreshOf")
        if previous_baseline is not None
        else None
    )
    return {
        "status": "YES" if proven_remaining >= planned else "NO",
        "reason": "EXACT_TOKEN_TPD_BASELINE_EVALUATED",
        "models": [
            {
                "model": model,
                "method": "EXACT_TOKEN_USAGE_BASELINE",
                "dailyLimitTokens": daily_limit,
                "usageBucketTimestamp": bucket_timestamp,
                "windowDateUtc": window_date,
                "contextTokens": context_tokens,
                "nonCachedInputTokens": non_cached_tokens,
                "cachedInputTokens": cached_tokens,
                "cachedInputTokensOmitted": cached_tokens_omitted,
                "cachedInputTokensSource": (
                    "DERIVED_CONTEXT_MINUS_NON_CACHED"
                    if cached_tokens_omitted
                    else "PROVIDER"
                ),
                "generatedTokens": generated_tokens,
                "rateLimitCountedUsedTokens": counted_tokens,
                "baselineUsedTokens": counted_tokens,
                "ledgerUsedTokens": ledger_used,
                "ledgerBeforeObservationTokens": ledger_before_observation,
                "ledgerAfterObservationTokens": ledger_after_observation,
                "unreconciledLedgerTokens": unreconciled_ledger,
                "epochLedgerUsedTokens": epoch_ledger_used,
                "knownUsedTokens": effective_used,
                "calculatedMinimumRemainingTokens": cost_only_remaining,
                "conservativeUsedTokensUpperBound": effective_used,
                "minimumProvenRemainingTokens": proven_remaining,
                "epochMinimumProvenRemainingTokens": epoch_proven_remaining,
                "effectiveCurrentDayUsedTokens": effective_used,
                "freshObservedUsedTokens": counted_tokens,
                "plannedFullRunTokens": planned,
                "baselineId": baseline_id,
                "baselineFingerprint": fingerprint,
                "baselineRefreshOf": baseline_refresh_of,
                "ledgerEpoch": epoch_ledger_epoch,
                "observedAt": observed_at_text,
                "organizationScope": payload["organizationScope"],
                "source": payload["source"],
                "verifiedQuietPeriodSeconds": quiet_period,
                "headroom": proven_remaining >= planned,
            }
        ],
    }
