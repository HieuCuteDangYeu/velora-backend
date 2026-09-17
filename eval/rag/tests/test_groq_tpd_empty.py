import hashlib
import json
from datetime import UTC, datetime, timedelta

from rag_eval.groq_tpd_empty import (
    MODEL,
    PREVIOUS_BUCKET,
    QUERY_SHAPE,
    empty_usage_tpd_headroom,
)
from rag_eval.preflight import tpd_headroom
from rag_eval.tpd_ledger import GroqDailyTokenLedger

NOW = datetime(2026, 9, 14, 5, 45, tzinfo=UTC)
BUCKET_TIMESTAMP = 1_789_344_000


def write_json(path, payload):
    path.write_text(json.dumps(payload), encoding="utf-8")


def query_fingerprint(*, date="2026-09-14"):
    return hashlib.sha256(
        json.dumps(
            {
                "queryShape": QUERY_SHAPE,
                "queryFromDateUtc": date,
                "queryToDateUtc": date,
                "organizationScope": "all-projects",
                "model": MODEL,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def positive_control(**overrides):
    control = {
        "queryShape": QUERY_SHAPE,
        "windowDateUtc": "2026-09-13",
        "bucketTimestamp": PREVIOUS_BUCKET["bucketTimestamp"],
        "organizationScope": "all-projects",
        "model": MODEL,
        "responseStatus": 200,
        "responseShape": "object-list",
        "queryFromDateUtc": "2026-09-13",
        "queryToDateUtc": "2026-09-13",
        "targetModelRecordCount": 1,
        "contextTokens": PREVIOUS_BUCKET["contextTokens"],
        "nonCachedInputTokens": PREVIOUS_BUCKET["nonCachedInputTokens"],
        "cachedInputTokens": PREVIOUS_BUCKET["cachedInputTokens"],
        "generatedTokens": PREVIOUS_BUCKET["generatedTokens"],
        "rateLimitCountedUsedTokens": PREVIOUS_BUCKET["rateLimitCountedUsedTokens"],
    }
    control.update(overrides)
    return control


def empty_payload(**overrides):
    payload = {
        "schemaVersion": "groq-tpd-empty-usage-baseline-v1",
        "provider": "groq",
        "scope": "TPD",
        "source": "groq-console-organization-usage-api",
        "observedAt": NOW.isoformat(),
        "windowDateUtc": "2026-09-14",
        "usageBucketTimestamp": BUCKET_TIMESTAMP,
        "queryShape": QUERY_SHAPE,
        "queryFromDateUtc": "2026-09-14",
        "queryToDateUtc": "2026-09-14",
        "organizationScope": "all-projects",
        "organizationLimitsVerified": True,
        "organizationLimitsSource": "groq-console-organization-limits",
        "model": MODEL,
        "dailyLimitTokens": 200_000,
        "usageResult": "EMPTY",
        "rateLimitCountedUsedTokens": 0,
        "responseStatus": 200,
        "responseShape": "object-list",
        "currentRecordCount": 0,
        "currentTargetModelRecordCount": 0,
        "currentUsageResult": "EMPTY",
        "authenticatedObservation": True,
        "uiState": "NO_USAGE_DATA_FOR_TODAY",
        "previousBucketPositiveControl": positive_control(),
        "usageQueryFingerprint": query_fingerprint(),
        "consoleMaxReportingDelaySeconds": 900,
        "verifiedQuietPeriodSeconds": 900,
        "verifiedNoGroqTrafficDuringQuietPeriod": True,
        "plannedFullRunTokens": 54_048,
    }
    payload.update(overrides)
    return payload


def evaluate(tmp_path, *, payload=None, now=NOW):
    return empty_usage_tpd_headroom(
        payload or empty_payload(),
        (MODEL,),
        GroqDailyTokenLedger(tmp_path / "ledger.jsonl"),
        now=now,
        max_age_seconds=3_600,
    )


def test_authenticated_empty_current_day_response_does_not_prove_effective_tpd_headroom(
    tmp_path,
):
    result = evaluate(tmp_path)

    assert result == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_EFFECTIVE_WINDOW_UNPROVEN",
    }
    assert not (tmp_path / "ledger.jsonl").exists()


def test_missing_target_row_in_nonempty_response_does_not_imply_zero(tmp_path):
    result = evaluate(tmp_path, payload=empty_payload(currentRecordCount=1))

    assert result == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_ENDPOINT_HEALTH_UNPROVEN",
    }


def test_http_failure_fails_closed(tmp_path):
    result = evaluate(tmp_path, payload=empty_payload(responseStatus=503))

    assert result["status"] == "UNKNOWN"


def test_malformed_empty_response_fails_closed(tmp_path):
    result = evaluate(tmp_path, payload=empty_payload(responseShape="not-a-list"))

    assert result["status"] == "UNKNOWN"


def test_wrong_utc_date_or_month_to_date_query_fails(tmp_path):
    wrong_date = evaluate(tmp_path, payload=empty_payload(windowDateUtc="2026-09-13"))
    month_to_date = evaluate(tmp_path, payload=empty_payload(queryFromDateUtc="2026-09-01"))

    assert wrong_date["status"] == "UNKNOWN"
    assert month_to_date == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_QUERY_WINDOW_INVALID",
    }


def test_non_organization_scope_fails_closed(tmp_path):
    result = evaluate(tmp_path, payload=empty_payload(organizationScope="project-only"))

    assert result["status"] == "UNKNOWN"


def test_insufficient_quiet_period_fails_closed(tmp_path):
    result = evaluate(tmp_path, payload=empty_payload(verifiedQuietPeriodSeconds=899))

    assert result == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_QUIET_PERIOD_UNPROVEN",
    }


def test_ui_and_network_disagreement_fails_closed(tmp_path):
    result = evaluate(tmp_path, payload=empty_payload(uiState="USAGE_DATA_PRESENT"))

    assert result == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_SCOPE_OR_RESULT_INVALID",
    }


def test_stale_empty_baseline_fails_closed(tmp_path):
    result = evaluate(
        tmp_path,
        payload=empty_payload(observedAt=(NOW - timedelta(hours=2)).isoformat()),
    )

    assert result == {"status": "UNKNOWN", "reason": "TPD_EMPTY_BASELINE_STALE_OR_INVALID"}


def test_previous_bucket_positive_control_is_required_and_exact(tmp_path):
    missing = evaluate(tmp_path, payload=empty_payload(previousBucketPositiveControl=None))
    changed = evaluate(
        tmp_path,
        payload=empty_payload(
            previousBucketPositiveControl=positive_control(generatedTokens=13_845)
        ),
    )

    assert missing["status"] == "UNKNOWN"
    assert changed == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_ENDPOINT_HEALTH_UNPROVEN",
    }


def test_current_empty_with_failed_health_control_is_unknown(tmp_path):
    result = evaluate(
        tmp_path,
        payload=empty_payload(previousBucketPositiveControl=positive_control(responseStatus=500)),
    )

    assert result == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_ENDPOINT_HEALTH_UNPROVEN",
    }


def test_empty_baseline_never_initializes_a_zero_usage_ledger(tmp_path):
    first = evaluate(tmp_path)
    second = evaluate(tmp_path)

    assert first["status"] == "UNKNOWN"
    assert second == first
    assert not (tmp_path / "ledger.jsonl").exists()


def test_existing_ledger_usage_cannot_make_empty_baseline_authoritative(tmp_path):
    GroqDailyTokenLedger(tmp_path / "ledger.jsonl").record(
        {
            "requestId": "judge-1",
            "timestamp": (NOW + timedelta(minutes=1)).isoformat(),
            "provider": "groq",
            "model": MODEL,
            "countedTokens": 1_000,
        }
    )

    resumed = evaluate(tmp_path, now=NOW + timedelta(minutes=2))

    assert resumed == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_EFFECTIVE_WINDOW_UNPROVEN",
    }


def test_same_day_empty_refresh_remains_non_authoritative(tmp_path):
    ledger = GroqDailyTokenLedger(tmp_path / "ledger.jsonl")
    ledger.record(
        {
            "requestId": "timed-out-probe",
            "timestamp": (NOW + timedelta(minutes=1)).isoformat(),
            "provider": "groq",
            "model": MODEL,
            "countedTokens": 270,
        }
    )
    refreshed = evaluate(
        tmp_path,
        payload=empty_payload(observedAt=(NOW + timedelta(minutes=2)).isoformat()),
        now=NOW + timedelta(minutes=3),
    )

    assert refreshed == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_EFFECTIVE_WINDOW_UNPROVEN",
    }


def test_duplicate_ledger_accounting_is_idempotent(tmp_path):
    ledger = GroqDailyTokenLedger(tmp_path / "ledger.jsonl")
    request = {
        "requestId": "judge-1",
        "timestamp": NOW.isoformat(),
        "provider": "groq",
        "model": MODEL,
        "countedTokens": 1_000,
    }
    ledger.record(request)
    ledger.record(request)

    assert ledger.usage_since(MODEL, NOW - timedelta(seconds=1), now=NOW) == 1_000


def test_next_utc_date_invalidates_current_empty_baseline(tmp_path):
    next_day = NOW + timedelta(days=1)
    result = evaluate(
        tmp_path,
        payload=empty_payload(observedAt=next_day.isoformat()),
        now=next_day,
    )

    assert result == {"status": "UNKNOWN", "reason": "TPD_EMPTY_BASELINE_DATE_INVALID"}


def test_normal_zero_token_fields_are_not_accepted_for_empty_schema(tmp_path):
    result = evaluate(tmp_path, payload=empty_payload(contextTokens=0))

    assert result == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_SCOPE_OR_RESULT_INVALID",
    }


def test_tpm_and_rpd_headers_cannot_change_empty_tpd_baseline(tmp_path):
    result = evaluate(
        tmp_path,
        payload=empty_payload(
            x_ratelimit_remaining_tokens="0",
            x_ratelimit_limit_tokens="1",
            x_ratelimit_remaining_requests="0",
            x_ratelimit_limit_requests="1",
        ),
    )

    assert result == {
        "status": "UNKNOWN",
        "reason": "TPD_EMPTY_BASELINE_EFFECTIVE_WINDOW_UNPROVEN",
    }


def test_exact_usage_row_takes_precedence_over_empty_attestation(tmp_path):
    exact = empty_payload(
        schemaVersion="groq-tpd-usage-baseline-v1",
        source="groq-console-organization-usage-api",
        contextTokens=102_000,
        nonCachedInputTokens=100_000,
        cachedInputTokens=2_000,
        generatedTokens=10_000,
        rateLimitCountedUsedTokens=110_000,
    )
    exact_path = tmp_path / "exact.json"
    empty_path = tmp_path / "empty.json"
    write_json(exact_path, exact)
    write_json(empty_path, empty_payload())

    result = tpd_headroom(
        None,
        (MODEL,),
        usage_attestation_path=str(exact_path),
        empty_attestation_path=str(empty_path),
        ledger_path=str(tmp_path / "ledger.jsonl"),
        now=NOW,
        max_age_seconds=3_600,
    )

    assert result["reason"] == "EXACT_TOKEN_TPD_BASELINE_EVALUATED"
    assert result["models"][0]["rateLimitCountedUsedTokens"] == 110_000
