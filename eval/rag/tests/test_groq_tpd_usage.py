import json
from datetime import UTC, datetime, timedelta

from rag_eval.groq_tpd_usage import exact_usage_tpd_headroom
from rag_eval.tpd_ledger import GroqDailyTokenLedger

MODEL = "openai/gpt-oss-120b"
NOW = datetime(2026, 9, 14, 5, 45, tzinfo=UTC)
BUCKET_TIMESTAMP = 1_789_344_000


def usage_payload(**overrides):
    payload = {
        "schemaVersion": "groq-tpd-usage-baseline-v1",
        "provider": "groq",
        "scope": "TPD",
        "source": "groq-console-organization-usage-api",
        "observedAt": NOW.isoformat(),
        "windowDateUtc": "2026-09-14",
        "usageBucketTimestamp": BUCKET_TIMESTAMP,
        "organizationScope": "all-projects",
        "model": MODEL,
        "dailyLimitTokens": 200_000,
        "contextTokens": 102_000,
        "nonCachedInputTokens": 100_000,
        "cachedInputTokens": 2_000,
        "generatedTokens": 10_000,
        "rateLimitCountedUsedTokens": 110_000,
        "numRequests": 10,
        "plannedFullRunTokens": 54_048,
        "verifiedQuietPeriodSeconds": 900,
    }
    payload.update(overrides)
    return payload


def evaluate(tmp_path, *, payload=None, now=NOW, limit_payload=None):
    return exact_usage_tpd_headroom(
        payload or usage_payload(),
        (MODEL,),
        GroqDailyTokenLedger(tmp_path / "ledger.jsonl"),
        limit_payload=limit_payload,
        now=now,
        max_age_seconds=3_600,
    )


def test_exact_usage_baseline_passes_and_excludes_cached_tokens(tmp_path):
    result = evaluate(tmp_path)

    assert result["status"] == "YES"
    assert result["models"][0]["rateLimitCountedUsedTokens"] == 110_000
    assert result["models"][0]["calculatedMinimumRemainingTokens"] == 90_000
    assert result["models"][0]["cachedInputTokens"] == 2_000


def test_raw_usage_field_names_are_supported(tmp_path):
    payload = usage_payload(
        timestamp=BUCKET_TIMESTAMP,
        n_context_tokens_total=102_000,
        n_non_cached_context_tokens_total=100_000,
        n_cached_context_tokens_total=2_000,
        n_generated_tokens_total=10_000,
        num_requests=10,
    )
    for field in (
        "contextTokens",
        "usageBucketTimestamp",
        "nonCachedInputTokens",
        "cachedInputTokens",
        "generatedTokens",
        "numRequests",
    ):
        del payload[field]

    result = evaluate(tmp_path, payload=payload)

    assert result["status"] == "YES"
    assert result["models"][0]["usageBucketTimestamp"] == BUCKET_TIMESTAMP


def test_context_breakdown_must_match(tmp_path):
    result = evaluate(tmp_path, payload=usage_payload(contextTokens=103_000))

    assert result == {
        "status": "UNKNOWN",
        "reason": "TPD_USAGE_CONTEXT_TOKEN_BREAKDOWN_MISMATCH",
    }


def test_counted_usage_formula_must_match(tmp_path):
    result = evaluate(tmp_path, payload=usage_payload(rateLimitCountedUsedTokens=102_000))

    assert result == {
        "status": "UNKNOWN",
        "reason": "TPD_USAGE_COUNTED_TOKEN_FORMULA_MISMATCH",
    }


def test_current_bucket_timestamp_and_window_date_are_required(tmp_path):
    wrong_timestamp = evaluate(tmp_path, payload=usage_payload(usageBucketTimestamp=1_789_257_600))
    wrong_date = evaluate(tmp_path, payload=usage_payload(windowDateUtc="2026-09-13"))

    assert wrong_timestamp == {
        "status": "UNKNOWN",
        "reason": "TPD_USAGE_BUCKET_STALE_OR_MISMATCHED",
    }
    assert wrong_date == {"status": "UNKNOWN", "reason": "TPD_USAGE_BUCKET_INVALID"}


def test_stale_observation_fails_closed(tmp_path):
    result = evaluate(
        tmp_path,
        payload=usage_payload(observedAt=(NOW - timedelta(hours=2)).isoformat()),
    )

    assert result == {"status": "UNKNOWN", "reason": "TPD_USAGE_BASELINE_STALE_OR_INVALID"}


def test_quiet_period_is_required_and_at_least_fifteen_minutes(tmp_path):
    missing = usage_payload()
    del missing["verifiedQuietPeriodSeconds"]
    short = usage_payload(verifiedQuietPeriodSeconds=899)

    assert evaluate(tmp_path, payload=missing)["status"] == "UNKNOWN"
    assert evaluate(tmp_path, payload=short) == {
        "status": "UNKNOWN",
        "reason": "TPD_USAGE_QUIET_PERIOD_PROOF_REQUIRED",
    }


def test_quiet_period_cannot_be_shorter_than_console_delay(tmp_path):
    result = evaluate(
        tmp_path,
        payload=usage_payload(
            consoleMaxReportingDelaySeconds=901,
            verifiedQuietPeriodSeconds=900,
        ),
    )

    assert result == {"status": "UNKNOWN", "reason": "TPD_USAGE_QUIET_PERIOD_TOO_SHORT"}


def test_wrong_scope_model_provider_or_limit_fails(tmp_path):
    wrong_scope = evaluate(tmp_path, payload=usage_payload(organizationScope="project-only"))
    wrong_model = evaluate(tmp_path, payload=usage_payload(model="openai/gpt-oss-20b"))
    wrong_provider = evaluate(tmp_path, payload=usage_payload(provider="openai"))
    wrong_limit = evaluate(tmp_path, payload=usage_payload(dailyLimitTokens=200_001))

    assert wrong_scope["status"] == "UNKNOWN"
    assert wrong_model["status"] == "UNKNOWN"
    assert wrong_provider["status"] == "UNKNOWN"
    assert wrong_limit == {"status": "UNKNOWN", "reason": "TPD_USAGE_LIMIT_INVALID"}


def test_optional_limit_attestation_is_cross_checked(tmp_path):
    limit = {
        "schemaVersion": "groq-tpd-limit-attestation-v1",
        "provider": "groq",
        "scope": "TPD_LIMIT",
        "source": "groq-console-organization-limits",
        "observedAt": NOW.isoformat(),
        "models": {MODEL: {"dailyLimitTokens": 199_999}},
    }

    result = evaluate(tmp_path, limit_payload=limit)

    assert result == {"status": "UNKNOWN", "reason": "TPD_LIMIT_ATTESTATION_INVALID_OR_STALE"}


def test_forbidden_identifiers_are_not_accepted(tmp_path):
    result = evaluate(tmp_path, payload=usage_payload(project_id="should-not-be-stored"))

    assert result == {"status": "UNKNOWN", "reason": "TPD_USAGE_BASELINE_SCOPE_OR_MODEL_INVALID"}


def test_exact_baseline_is_initialized_without_double_counting(tmp_path):
    result = evaluate(tmp_path)
    rows = [
        json.loads(line)
        for line in (tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()
    ]

    assert result["status"] == "YES"
    assert result["models"][0]["ledgerUsedTokens"] == 0
    assert rows[0]["recordType"] == "BASELINE"
    assert rows[0]["baselineUsedTokens"] == 110_000
    assert rows[0]["countedTokens"] == 0
    assert rows[0]["windowKey"] == "2026-09-14:1789344000"


def test_process_restart_and_later_ledger_usage_preserve_epoch(tmp_path):
    first = evaluate(tmp_path)
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

    assert resumed["status"] == "YES"
    assert resumed["models"][0]["baselineId"] == first["models"][0]["baselineId"]
    assert resumed["models"][0]["ledgerUsedTokens"] == 1_000
    assert resumed["models"][0]["minimumProvenRemainingTokens"] == 89_000
    assert resumed["models"][0]["epochLedgerUsedTokens"] == 1_000
    assert resumed["models"][0]["epochMinimumProvenRemainingTokens"] == 89_000


def test_new_observation_cannot_silently_rebase_existing_epoch(tmp_path):
    evaluate(tmp_path)
    new_observation = usage_payload(
        observedAt=(NOW + timedelta(minutes=1)).isoformat(),
        generatedTokens=10_001,
        rateLimitCountedUsedTokens=110_001,
    )

    result = evaluate(tmp_path, payload=new_observation, now=NOW + timedelta(minutes=2))

    assert result == {"status": "UNKNOWN", "reason": "TPD_LEDGER_BASELINE_UNAVAILABLE"}
