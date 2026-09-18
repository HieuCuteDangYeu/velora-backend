"""Normalize saved Groq rolling metrics into the exact TPD baseline contract."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from typing import Any

from rag_eval.groq_tpd_usage import (
    DEFAULT_DAILY_LIMIT_TOKENS,
    DEFAULT_PLANNED_FULL_RUN_TOKENS,
    USAGE_BASELINE_SCHEMA,
)
from rag_eval.tpd_ledger import parse_timestamp

TARGET_MODEL = "openai/gpt-oss-120b"
ROLLING_METRICS_SOURCE = "groq-console-organization-rolling-metrics-api"
FULL_QUIET_WINDOW_SECONDS = 3_600


class GroqMetricsBaselineError(ValueError):
    """Saved rolling metrics cannot safely establish a current-day baseline."""


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _nonnegative_integer(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    converted = int(value)
    return converted if converted >= 0 else None


def _timestamp(value: Any) -> datetime | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        raw = float(value)
        if raw > 10_000_000_000:
            raw /= 1_000
        try:
            return datetime.fromtimestamp(raw, UTC)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            return _timestamp(int(stripped))
        return parse_timestamp(stripped)
    return None


def _rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        raw_rows = payload
    elif isinstance(payload, dict):
        raw_rows = None
        containers = [payload]
        for key in ("response", "body"):
            candidate = payload.get(key)
            if isinstance(candidate, dict):
                containers.append(candidate)
        for container in containers:
            for key in ("data", "results", "metrics", "usage"):
                candidate = container.get(key)
                if isinstance(candidate, list):
                    raw_rows = candidate
                    break
            if raw_rows is not None:
                break
        if raw_rows is None:
            raise GroqMetricsBaselineError("METRICS_ROWS_MISSING")
    else:
        raise GroqMetricsBaselineError("METRICS_RESPONSE_INVALID")
    if not all(isinstance(row, dict) for row in raw_rows):
        raise GroqMetricsBaselineError("METRICS_ROW_INVALID")
    return list(raw_rows)


def _first(row: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in row:
            return row[key]
    return None


def _row_model(row: dict[str, Any]) -> str | None:
    value = _first(row, "model", "model_name", "modelName")
    return value if isinstance(value, str) else None


def _row_timestamp(row: dict[str, Any]) -> datetime | None:
    return _timestamp(
        _first(
            row,
            "timestamp",
            "bucket_timestamp",
            "bucketTimestamp",
            "start_time",
            "startTime",
            "bucket_start",
            "bucketStart",
        )
    )


def _row_usage(row: dict[str, Any]) -> dict[str, int]:
    values = {
        "input": _nonnegative_integer(
            _first(row, "total_input_tokens", "n_context_tokens_total", "context_tokens")
        ),
        "cached": _nonnegative_integer(
            _first(
                row,
                "total_cached_input_tokens",
                "n_cached_context_tokens_total",
                "cached_input_tokens",
            )
        ),
        "uncached": _nonnegative_integer(
            _first(
                row,
                "total_uncached_input_tokens",
                "n_non_cached_context_tokens_total",
                "non_cached_input_tokens",
            )
        ),
        "output": _nonnegative_integer(
            _first(
                row,
                "total_output_tokens",
                "total_completion_tokens",
                "total_generated_tokens",
                "n_generated_tokens_total",
                "generated_tokens",
            )
        ),
    }
    if any(value is None for value in values.values()):
        raise GroqMetricsBaselineError("METRICS_TOKEN_FIELDS_INCOMPLETE")
    usage = {key: int(value) for key, value in values.items()}
    if usage["input"] != usage["cached"] + usage["uncached"]:
        raise GroqMetricsBaselineError("METRICS_INPUT_TOKEN_BREAKDOWN_MISMATCH")
    requests = _first(row, "total_calls", "total_requests", "num_requests", "request_count")
    if requests is not None:
        parsed_requests = _nonnegative_integer(requests)
        if parsed_requests is None:
            raise GroqMetricsBaselineError("METRICS_REQUEST_COUNT_INVALID")
        usage["requests"] = parsed_requests
    else:
        usage["requests"] = 0
    return usage


def _metadata(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    output = [payload]
    for key in ("request", "request_metadata", "requestMetadata", "metadata", "meta", "query"):
        candidate = payload.get(key)
        if isinstance(candidate, dict):
            output.append(candidate)
    return output


def _metadata_value(payload: Any, *keys: str) -> Any:
    for container in _metadata(payload):
        value = _first(container, *keys)
        if value is not None:
            return value
    return None


def _last_hour_bounds(payload: Any, observed_at: datetime) -> tuple[datetime, datetime]:
    start = _timestamp(
        _metadata_value(
            payload,
            "start_time",
            "startTime",
            "window_start",
            "windowStart",
            "from",
        )
    )
    end = _timestamp(
        _metadata_value(
            payload,
            "end_time",
            "endTime",
            "window_end",
            "windowEnd",
            "to",
            "observed_at",
            "observedAt",
        )
    )
    if start is not None or end is not None:
        if start is None or end is None:
            raise GroqMetricsBaselineError("LAST_HOUR_WINDOW_INVALID")
        if end != observed_at or end - start < timedelta(seconds=FULL_QUIET_WINDOW_SECONDS):
            raise GroqMetricsBaselineError("LAST_HOUR_WINDOW_INVALID")
        return start, end

    duration = _nonnegative_integer(
        _metadata_value(
            payload,
            "window_seconds",
            "windowSeconds",
            "duration_seconds",
            "durationSeconds",
        )
    )
    window = _metadata_value(payload, "window", "period", "range")
    full_hour_label = isinstance(window, str) and window.strip().lower() in {
        "1h",
        "60m",
        "last-hour",
        "last_hour",
        "last hour",
    }
    if duration is not None or window is not None:
        if not (
            (duration is not None and duration >= FULL_QUIET_WINDOW_SECONDS) or full_hour_label
        ):
            raise GroqMetricsBaselineError("LAST_HOUR_WINDOW_INVALID")
        return observed_at - timedelta(seconds=FULL_QUIET_WINDOW_SECONDS), observed_at

    # Groq's rolling-metrics response does not currently echo the selected
    # dashboard time range. Supplying a payload through the dedicated
    # last-hour input is therefore the operator assertion that this saved
    # response came from the Last hour filter. The explicit observation time
    # anchors the one-hour proof window; any embedded metadata above is still
    # validated when present.
    if not isinstance(payload, (dict, list)):
        raise GroqMetricsBaselineError("LAST_HOUR_WINDOW_INVALID")
    return observed_at - timedelta(seconds=FULL_QUIET_WINDOW_SECONDS), observed_at


def normalize_groq_rolling_metrics_baseline(
    rolling_24h_payload: Any,
    last_hour_payload: Any,
    *,
    observed_at: str | datetime,
    all_projects: bool,
    model: str = TARGET_MODEL,
) -> dict[str, Any]:
    """Create one sanitized exact current-UTC-day baseline from saved metrics responses."""

    if all_projects is not True:
        raise GroqMetricsBaselineError("ALL_PROJECTS_SCOPE_REQUIRED")
    if model != TARGET_MODEL:
        raise GroqMetricsBaselineError("TARGET_MODEL_INVALID")
    observed = observed_at if isinstance(observed_at, datetime) else parse_timestamp(observed_at)
    if observed is None or observed.tzinfo is None:
        raise GroqMetricsBaselineError("OBSERVATION_TIMESTAMP_INVALID")
    observed = observed.astimezone(UTC)
    day_start = observed.replace(hour=0, minute=0, second=0, microsecond=0)

    totals = {"input": 0, "cached": 0, "uncached": 0, "output": 0, "requests": 0}
    for row in _rows(rolling_24h_payload):
        if _row_model(row) != model:
            continue
        bucket_at = _row_timestamp(row)
        if bucket_at is None:
            raise GroqMetricsBaselineError("METRICS_BUCKET_TIMESTAMP_INVALID")
        bucket_at = bucket_at.astimezone(UTC)
        if bucket_at > observed:
            raise GroqMetricsBaselineError("METRICS_BUCKET_TIMESTAMP_FUTURE")
        if bucket_at < day_start:
            continue
        usage = _row_usage(row)
        for key in totals:
            totals[key] += usage[key]

    quiet_start, quiet_end = _last_hour_bounds(last_hour_payload, observed)
    for row in _rows(last_hour_payload):
        if _row_model(row) != model:
            continue
        bucket_at = _row_timestamp(row)
        if bucket_at is None:
            raise GroqMetricsBaselineError("LAST_HOUR_BUCKET_TIMESTAMP_INVALID")
        bucket_at = bucket_at.astimezone(UTC)
        if bucket_at < quiet_start or bucket_at > quiet_end:
            raise GroqMetricsBaselineError("LAST_HOUR_BUCKET_TIMESTAMP_OUTSIDE_WINDOW")
        usage = _row_usage(row)
        if any(usage[key] > 0 for key in ("input", "cached", "uncached", "output", "requests")):
            raise GroqMetricsBaselineError("LAST_HOUR_TARGET_MODEL_USAGE_NONZERO")

    observed_text = observed.isoformat().replace("+00:00", "Z")
    return {
        "schemaVersion": USAGE_BASELINE_SCHEMA,
        "provider": "groq",
        "scope": "TPD",
        "source": ROLLING_METRICS_SOURCE,
        "observedAt": observed_text,
        "windowDateUtc": day_start.date().isoformat(),
        "usageBucketTimestamp": int(day_start.timestamp()),
        "organizationScope": "all-projects",
        "model": model,
        "dailyLimitTokens": DEFAULT_DAILY_LIMIT_TOKENS,
        "contextTokens": totals["input"],
        "nonCachedInputTokens": totals["uncached"],
        "cachedInputTokens": totals["cached"],
        "generatedTokens": totals["output"],
        "rateLimitCountedUsedTokens": totals["uncached"] + totals["output"],
        "numRequests": totals["requests"],
        "plannedFullRunTokens": _positive_int(
            "RAGAS_GROQ_TPD_PLANNED_FULL_RUN_TOKENS", DEFAULT_PLANNED_FULL_RUN_TOKENS
        ),
        "verifiedQuietPeriodSeconds": FULL_QUIET_WINDOW_SECONDS,
    }
