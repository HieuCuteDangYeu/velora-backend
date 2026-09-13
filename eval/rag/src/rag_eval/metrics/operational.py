"""Latency and provider reliability aggregation from actual trace fields."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any


def percentile(values: list[float], percent: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def latency_summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    end_to_end = [float(row["latencyMs"]) for row in results if row.get("latencyMs") is not None]
    by_role: dict[str, list[float]] = defaultdict(list)
    for row in results:
        for call in row.get("modelCalls", []):
            if call.get("latencyMs") is not None:
                by_role[call["modelRole"]].append(float(call["latencyMs"]))

    def summarize(values: list[float]) -> dict[str, float | None]:
        return {
            "p50": percentile(values, 0.50),
            "p90": percentile(values, 0.90),
            "p95": percentile(values, 0.95),
            "max": max(values) if values else None,
        }

    return {
        "endToEnd": summarize(end_to_end),
        "byRole": {k: summarize(v) for k, v in by_role.items()},
    }


def reliability_metrics(results: list[dict[str, Any]]) -> dict[str, Any]:
    calls = [
        call
        for row in results
        for call in row.get("modelCalls", [])
        if call.get("scope", "QUERY") != "EVALUATION_JUDGE"
    ]
    traces = [row.get("trace", {}) for row in results]

    def count_category(category: str) -> int:
        return sum(call.get("providerCategory") == category for call in calls)

    denominator = len(results)

    def rate(count: int) -> float | None:
        return count / denominator if denominator else None

    return {
        "providerRequests": len(calls),
        "providerRetries": sum(max(0, int(call.get("attempt", 1)) - 1) for call in calls),
        "http429Count": sum(call.get("providerStatus") == 429 for call in calls),
        "accountLimitedCount": count_category("ACCOUNT_LIMITED"),
        "outOfCapacityCount": count_category("OUT_OF_CAPACITY"),
        "timeoutCount": count_category("TRANSIENT_PROVIDER_FAILURE"),
        "truncationCount": sum(bool(trace.get("truncated")) for trace in traces),
        "invalidJsonCount": sum(int(trace.get("invalidJsonCount", 0)) for trace in traces),
        "schemaFailureCount": sum(int(trace.get("schemaFailureCount", 0)) for trace in traces),
        "routerFallbackRate": rate(sum(bool(trace.get("routerFallback")) for trace in traces)),
        "verifierEscalationRate": rate(
            sum(bool(trace.get("verifierEscalated")) for trace in traces)
        ),
        "answerRevisionRate": rate(sum(int(trace.get("revisionDepth", 0)) > 0 for trace in traces)),
        "retrievalRetryRate": rate(sum(int(trace.get("retryCount", 0)) > 0 for trace in traces)),
    }


def judge_metrics(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate judge requests separately from production provider calls."""

    calls = [
        call
        for row in results
        for call in row.get("modelCalls", [])
        if call.get("scope") == "EVALUATION_JUDGE"
    ]
    failures = [call for call in calls if call.get("providerStatus") != 200]
    retries = [call for call in calls if int(call.get("attempt", 1)) > 1]
    waits = [
        call
        for call in calls
        if float(call.get("rateLimitWaitMs") or 0) > 0
        or float(call.get("waitDurationMs") or 0) > 0
    ]
    return {
        "provider": next((call.get("provider") for call in calls if call.get("provider")), None),
        "model": next((call.get("model") for call in calls if call.get("model")), None),
        "callCount": len(calls),
        "successCount": sum(call.get("providerStatus") == 200 for call in calls),
        "failureCount": len(failures),
        "retryCount": len(retries),
        "rateLimitErrorCount": sum(call.get("providerStatus") == 429 for call in failures),
        "accountLimitedCount": sum(
            call.get("providerCategory") == "ACCOUNT_LIMITED" for call in failures
        ),
        "timeoutCount": sum(call.get("providerStatus") == "TIMEOUT" for call in failures),
        "networkErrorCount": sum(
            call.get("providerStatus") == "NETWORK_ERROR" for call in failures
        ),
        "waitCount": len(waits),
        "totalWaitMs": sum(
            float(call.get("rateLimitWaitMs") or 0)
            + float(call.get("waitDurationMs") or 0)
            for call in calls
        ),
        "maxObservedEffectiveTpm": max(
            (float(call.get("effectiveTpm") or 0) for call in calls),
            default=0.0,
        ),
        "configuredTpmLimit": next(
            (
                call.get("configuredTpmLimit")
                for call in calls
                if call.get("configuredTpmLimit") is not None
            ),
            None,
        ),
        "configuredTpmTarget": next(
            (
                call.get("configuredTpmTarget")
                for call in calls
                if call.get("configuredTpmTarget") is not None
            ),
            None,
        ),
        "inputTokens": sum(call.get("inputTokens") or 0 for call in calls),
        "outputTokens": sum(call.get("outputTokens") or 0 for call in calls),
        "totalTokens": sum(call.get("totalTokens") or 0 for call in calls),
        "latencyMs": sum(float(call.get("latencyMs") or 0) for call in calls),
        "failureCategories": sorted(
            {call.get("providerCategory") for call in failures if call.get("providerCategory")}
        ),
    }
