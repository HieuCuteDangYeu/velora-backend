"""Fail-closed validation for an authenticated empty Groq TPD response."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from typing import Any

from rag_eval.tpd_ledger import GroqDailyTokenLedger, LedgerPersistenceError, parse_timestamp

EMPTY_BASELINE_SCHEMA = "groq-tpd-empty-usage-baseline-v1"
MODEL = "openai/gpt-oss-120b"
DAILY_LIMIT_TOKENS = 200_000
PLANNED_FULL_RUN_TOKENS = 54_048
MIN_QUIET_PERIOD_SECONDS = 900
QUERY_SHAPE = "groq-organization-activity-v1"
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
PREVIOUS_BUCKET = {
    "windowDateUtc": "2026-09-13",
    "bucketTimestamp": 1_789_257_600,
    "organizationScope": "all-projects",
    "model": MODEL,
    "responseStatus": 200,
    "responseShape": "object-list",
    "queryFromDateUtc": "2026-09-13",
    "queryToDateUtc": "2026-09-13",
    "targetModelRecordCount": 1,
    "contextTokens": 115_027,
    "nonCachedInputTokens": 102_739,
    "cachedInputTokens": 12_288,
    "generatedTokens": 13_844,
    "rateLimitCountedUsedTokens": 116_583,
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


def _field(payload: dict[str, Any], normalized: str, raw: str) -> Any:
    normalized_value = payload.get(normalized)
    raw_value = payload.get(raw)
    if normalized_value is not None and raw_value is not None and normalized_value != raw_value:
        return None
    return normalized_value if normalized_value is not None else raw_value


def _contains_forbidden_identifier(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            str(key).lower() in FORBIDDEN_IDENTIFIER_KEYS or _contains_forbidden_identifier(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_forbidden_identifier(item) for item in value)
    return False


def _has_normal_token_fields(payload: dict[str, Any]) -> bool:
    return any(
        field in payload
        for field in (
            "contextTokens",
            "nonCachedInputTokens",
            "cachedInputTokens",
            "generatedTokens",
            "n_context_tokens_total",
            "n_non_cached_context_tokens_total",
            "n_cached_context_tokens_total",
            "n_generated_tokens_total",
        )
    )


def _control_value(control: dict[str, Any], normalized: str, raw: str) -> Any:
    return _field(control, normalized, raw)


def _positive_control_is_valid(control: Any) -> bool:
    if not isinstance(control, dict):
        return False
    if (
        control.get("queryShape") != QUERY_SHAPE
        or control.get("windowDateUtc") != PREVIOUS_BUCKET["windowDateUtc"]
        or _integer(control.get("bucketTimestamp"), minimum=1) != PREVIOUS_BUCKET["bucketTimestamp"]
        or control.get("organizationScope") != PREVIOUS_BUCKET["organizationScope"]
        or control.get("model") != PREVIOUS_BUCKET["model"]
        or control.get("responseStatus") != PREVIOUS_BUCKET["responseStatus"]
        or control.get("responseShape") != PREVIOUS_BUCKET["responseShape"]
        or control.get("queryFromDateUtc") != PREVIOUS_BUCKET["queryFromDateUtc"]
        or control.get("queryToDateUtc") != PREVIOUS_BUCKET["queryToDateUtc"]
        or _integer(control.get("targetModelRecordCount"), minimum=1)
        != PREVIOUS_BUCKET["targetModelRecordCount"]
    ):
        return False
    for normalized, raw in (
        ("contextTokens", "n_context_tokens_total"),
        ("nonCachedInputTokens", "n_non_cached_context_tokens_total"),
        ("cachedInputTokens", "n_cached_context_tokens_total"),
        ("generatedTokens", "n_generated_tokens_total"),
    ):
        if _integer(_control_value(control, normalized, raw)) != PREVIOUS_BUCKET[normalized]:
            return False
    return (
        _integer(control.get("rateLimitCountedUsedTokens"))
        == PREVIOUS_BUCKET["rateLimitCountedUsedTokens"]
        and PREVIOUS_BUCKET["contextTokens"]
        == PREVIOUS_BUCKET["nonCachedInputTokens"] + PREVIOUS_BUCKET["cachedInputTokens"]
        and PREVIOUS_BUCKET["rateLimitCountedUsedTokens"]
        == PREVIOUS_BUCKET["nonCachedInputTokens"] + PREVIOUS_BUCKET["generatedTokens"]
    )


def _unknown(reason: str) -> dict[str, Any]:
    return {"status": "UNKNOWN", "reason": reason}


def empty_usage_tpd_headroom(
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
        payload.get("schemaVersion") != EMPTY_BASELINE_SCHEMA
        or payload.get("provider") != "groq"
        or payload.get("scope") != "TPD"
        or payload.get("source") != "groq-console-organization-usage-api"
        or payload.get("organizationScope") != "all-projects"
        or payload.get("model") != MODEL
        or models != (MODEL,)
        or payload.get("usageResult") != "EMPTY"
        or payload.get("authenticatedObservation") is not True
        or payload.get("uiState") != "NO_USAGE_DATA_FOR_TODAY"
        or _contains_forbidden_identifier(payload)
        or _has_normal_token_fields(payload)
    ):
        return _unknown("TPD_EMPTY_BASELINE_SCOPE_OR_RESULT_INVALID")
    if _fresh_observation(payload, current, max_age_seconds) is None:
        return _unknown("TPD_EMPTY_BASELINE_STALE_OR_INVALID")
    if limit_payload is not None:
        if (
            limit_payload.get("schemaVersion") != "groq-tpd-limit-attestation-v1"
            or limit_payload.get("provider") != "groq"
            or limit_payload.get("scope") != "TPD_LIMIT"
            or _fresh_observation(limit_payload, current, max_age_seconds) is None
        ):
            return _unknown("TPD_LIMIT_ATTESTATION_INVALID_OR_STALE")
        limit_source = str(limit_payload.get("source", "")).lower()
        limit_values = limit_payload.get("models")
        limit_value = limit_values.get(MODEL) if isinstance(limit_values, dict) else None
        if (
            not limit_source
            or "header" in limit_source
            or "ratelimit" in limit_source
            or not isinstance(limit_value, dict)
            or _integer(limit_value.get("dailyLimitTokens")) != DAILY_LIMIT_TOKENS
        ):
            return _unknown("TPD_LIMIT_ATTESTATION_INVALID_OR_STALE")
    if (
        payload.get("organizationLimitsVerified") is not True
        or payload.get("organizationLimitsSource") != "groq-console-organization-limits"
    ):
        return _unknown("TPD_EMPTY_BASELINE_LIMIT_PROVENANCE_UNPROVEN")

    current_date = current.astimezone(UTC).date().isoformat()
    if payload.get("windowDateUtc") != current_date:
        return _unknown("TPD_EMPTY_BASELINE_DATE_INVALID")
    if (
        payload.get("queryShape") != QUERY_SHAPE
        or payload.get("queryFromDateUtc") != current_date
        or payload.get("queryToDateUtc") != current_date
    ):
        return _unknown("TPD_EMPTY_BASELINE_QUERY_WINDOW_INVALID")
    bucket_timestamp = _integer(payload.get("usageBucketTimestamp"), minimum=1)
    expected_bucket = int(datetime.fromisoformat(f"{current_date}T00:00:00+00:00").timestamp())
    if bucket_timestamp != expected_bucket:
        return _unknown("TPD_EMPTY_BASELINE_BUCKET_INVALID")

    if (
        payload.get("responseStatus") != 200
        or payload.get("responseShape") != "object-list"
        or _integer(payload.get("currentRecordCount")) != 0
        or _integer(payload.get("currentTargetModelRecordCount")) != 0
        or payload.get("currentUsageResult") != "EMPTY"
        or not _positive_control_is_valid(payload.get("previousBucketPositiveControl"))
    ):
        return _unknown("TPD_EMPTY_BASELINE_ENDPOINT_HEALTH_UNPROVEN")
    quiet_period = _integer(
        payload.get("verifiedQuietPeriodSeconds"), minimum=MIN_QUIET_PERIOD_SECONDS
    )
    console_delay = _integer(payload.get("consoleMaxReportingDelaySeconds"), minimum=0)
    if quiet_period is None:
        return _unknown("TPD_EMPTY_BASELINE_QUIET_PERIOD_UNPROVEN")
    if console_delay is not None and quiet_period < console_delay:
        return _unknown("TPD_EMPTY_BASELINE_QUIET_PERIOD_TOO_SHORT")
    if payload.get("verifiedNoGroqTrafficDuringQuietPeriod") is not True:
        return _unknown("TPD_EMPTY_BASELINE_QUIET_PERIOD_TRAFFIC_UNPROVEN")

    query_fingerprint = payload.get("usageQueryFingerprint")
    expected_query_fingerprint = hashlib.sha256(
        json.dumps(
            {
                "queryShape": QUERY_SHAPE,
                "queryFromDateUtc": current_date,
                "queryToDateUtc": current_date,
                "organizationScope": "all-projects",
                "model": MODEL,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    if (
        not isinstance(query_fingerprint, str)
        or len(query_fingerprint) != 64
        or any(character not in "0123456789abcdef" for character in query_fingerprint.lower())
        or query_fingerprint.lower() != expected_query_fingerprint
    ):
        return _unknown("TPD_EMPTY_BASELINE_QUERY_FINGERPRINT_INVALID")
    daily_limit = _integer(payload.get("dailyLimitTokens"), minimum=1)
    planned = _integer(payload.get("plannedFullRunTokens"), minimum=1)
    configured_planned = _positive_int(
        "RAGAS_GROQ_TPD_PLANNED_FULL_RUN_TOKENS", PLANNED_FULL_RUN_TOKENS
    )
    if daily_limit != DAILY_LIMIT_TOKENS:
        return _unknown("TPD_EMPTY_BASELINE_LIMIT_INVALID")
    if planned != configured_planned:
        return _unknown("TPD_PLANNED_BUDGET_MISMATCH")
    if _integer(payload.get("rateLimitCountedUsedTokens")) != 0:
        return _unknown("TPD_EMPTY_BASELINE_COUNT_INVALID")

    observed_at = _fresh_observation(payload, current, max_age_seconds)
    assert observed_at is not None
    observed_at_text = observed_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
    window_key = f"{current_date}:{bucket_timestamp}"
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "queryShape": payload["queryShape"],
                "queryFromDateUtc": payload["queryFromDateUtc"],
                "queryToDateUtc": payload["queryToDateUtc"],
                "usageQueryFingerprint": query_fingerprint,
                "bucketTimestamp": bucket_timestamp,
                "uiState": payload["uiState"],
                "previousBucketPositiveControl": payload["previousBucketPositiveControl"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    try:
        previous_baseline = ledger.latest_baseline(
            provider="groq",
            model=MODEL,
            organization_scope="all-projects",
            window_key=window_key,
        )
        baseline_id = ledger.initialize_baseline(
            provider="groq",
            model=MODEL,
            observed_at=observed_at_text,
            daily_limit_tokens=daily_limit,
            baseline_used_tokens=0,
            organization_scope="all-projects",
            window_key=window_key,
            baseline_fingerprint=fingerprint,
            pricing_version=EMPTY_BASELINE_SCHEMA,
            allow_refresh=True,
        )
        day_start = datetime.fromisoformat(f"{current_date}T00:00:00+00:00")
        ledger_before_observation = ledger.usage_between(
            MODEL, day_start, observed_at, include_start=True, include_end=False
        )
        ledger_after_observation = ledger.usage_between(
            MODEL, observed_at, current, include_start=True, include_end=True
        )
    except LedgerPersistenceError:
        return _unknown("TPD_EMPTY_BASELINE_LEDGER_UNAVAILABLE")
    effective_used = ledger_before_observation + ledger_after_observation
    ledger_used = effective_used
    proven_remaining = max(0, daily_limit - effective_used)
    unreconciled_ledger = ledger_before_observation + ledger_after_observation
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
        "reason": "EMPTY_CURRENT_WINDOW_TPD_BASELINE_EVALUATED",
        "models": [
            {
                "model": MODEL,
                "method": "EMPTY_CURRENT_WINDOW_VERIFIED",
                "dailyLimitTokens": daily_limit,
                "usageBucketTimestamp": bucket_timestamp,
                "windowDateUtc": current_date,
                "rateLimitCountedUsedTokens": 0,
                "baselineUsedTokens": 0,
                "ledgerUsedTokens": ledger_used,
                "ledgerBeforeObservationTokens": ledger_before_observation,
                "ledgerAfterObservationTokens": ledger_after_observation,
                "unreconciledLedgerTokens": unreconciled_ledger,
                "epochLedgerUsedTokens": epoch_ledger_used,
                "knownUsedTokens": ledger_used,
                "calculatedMinimumRemainingTokens": daily_limit,
                "conservativeUsedTokensUpperBound": ledger_used,
                "minimumProvenRemainingTokens": proven_remaining,
                "epochMinimumProvenRemainingTokens": epoch_proven_remaining,
                "effectiveCurrentDayUsedTokens": effective_used,
                "freshObservedUsedTokens": 0,
                "plannedFullRunTokens": planned,
                "baselineId": baseline_id,
                "baselineFingerprint": fingerprint,
                "baselineRefreshOf": baseline_refresh_of,
                "ledgerEpoch": epoch_ledger_epoch,
                "observedAt": observed_at_text,
                "organizationScope": "all-projects",
                "source": payload["source"],
                "verifiedQuietPeriodSeconds": quiet_period,
                "responseStatus": 200,
                "currentRecordCount": 0,
                "currentTargetModelRecordCount": 0,
                "previousBucketPositiveControl": True,
                "usageQueryFingerprint": query_fingerprint,
                "headroom": proven_remaining >= planned,
            }
        ],
    }
