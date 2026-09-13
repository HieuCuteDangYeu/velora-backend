import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from rag_eval.groq_pricing import DEFAULT_GROQ_PRICING
from rag_eval.groq_tpd_cost import cost_tpd_headroom
from rag_eval.tpd_ledger import GroqDailyTokenLedger

MODEL = "openai/gpt-oss-120b"
NOW = datetime(2026, 9, 13, 12, 0, tzinfo=UTC)


def write_json(path: Path, payload: dict):
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def cost_payload(**overrides):
    payload = {
        "schemaVersion": "groq-tpd-cost-upper-bound-attestation-v1",
        "provider": "groq",
        "scope": "TPD",
        "source": "groq-console-organization-usage",
        "observedAt": NOW.isoformat(),
        "organizationScope": "all-projects",
        "model": MODEL,
        "dailyLimitTokens": 200_000,
        "observedOrganizationModelCostUsd": "0.0200000",
        "costValueSource": "groq-console-usage-raw",
        "costDecimalPlaces": 7,
        "rateLimitedTokenPriceFloorUsdPerMillion": "0.15",
        "consoleMaxReportingDelaySeconds": 900,
        "verifiedQuietPeriodSeconds": 900,
        "quietPeriodStatus": "operator-confirmed-no-known-groq-traffic",
        "plannedFullRunTokens": 54_048,
    }
    payload.update(overrides)
    return payload


def limit_payload(**overrides):
    payload = {
        "schemaVersion": "groq-tpd-limit-attestation-v1",
        "provider": "groq",
        "scope": "TPD_LIMIT",
        "source": "groq-console-organization-limits",
        "observedAt": NOW.isoformat(),
        "models": {MODEL: {"dailyLimitTokens": 200_000}},
    }
    payload.update(overrides)
    return payload


def evaluate(tmp_path, *, payload=None, limit=None, now=NOW, pricing_path=None):
    ledger = GroqDailyTokenLedger(tmp_path / "ledger.jsonl")
    return cost_tpd_headroom(
        payload or cost_payload(),
        (MODEL,),
        ledger,
        limit_payload=limit,
        pricing_path=str(pricing_path or DEFAULT_GROQ_PRICING),
        now=now,
        max_age_seconds=3_600,
        pricing_max_age_seconds=30 * 24 * 60 * 60,
    )


def test_exact_cost_below_safe_threshold_passes(tmp_path):
    result = evaluate(tmp_path, payload=cost_payload(observedOrganizationModelCostUsd="0.0218927"))

    assert result["status"] == "YES"
    assert result["models"][0]["maxRateLimitedTokensFromCost"] == 145_952
    assert result["models"][0]["minimumProvenRemainingTokens"] == 54_048


def test_base_cost_attestation_schema_is_supported(tmp_path):
    payload = cost_payload()
    for field in ("costValueSource", "costDecimalPlaces", "quietPeriodStatus"):
        del payload[field]

    result = evaluate(tmp_path, payload=payload)

    assert result["status"] == "YES"


def test_exact_cost_at_safe_threshold_passes_inclusively(tmp_path):
    result = evaluate(tmp_path, payload=cost_payload(observedOrganizationModelCostUsd="0.0218928"))

    assert result["status"] == "YES"
    assert result["models"][0]["maxRateLimitedTokensFromCost"] == 145_952
    assert result["models"][0]["calculatedMinimumRemainingTokens"] == 54_048


def test_exact_cost_above_safe_threshold_fails(tmp_path):
    result = evaluate(tmp_path, payload=cost_payload(observedOrganizationModelCostUsd="0.0218929"))

    assert result["status"] == "NO"
    assert result["models"][0]["maxRateLimitedTokensFromCost"] == 145_953
    assert result["models"][0]["minimumProvenRemainingTokens"] == 54_047


def test_rounded_cost_without_precise_source_is_rejected(tmp_path):
    rounded_label = evaluate(
        tmp_path,
        payload=cost_payload(
            observedOrganizationModelCostUsd="$0.02",
            costDecimalPlaces=2,
        ),
    )
    rounded_decimal = evaluate(
        tmp_path,
        payload=cost_payload(
            observedOrganizationModelCostUsd="0.02",
            costDecimalPlaces=2,
        ),
    )

    assert rounded_label["status"] == "UNKNOWN"
    assert rounded_decimal["status"] == "UNKNOWN"


def test_missing_or_short_quiet_period_proof_fails(tmp_path):
    missing = cost_payload()
    del missing["verifiedQuietPeriodSeconds"]
    short = cost_payload(verifiedQuietPeriodSeconds=899)

    assert evaluate(tmp_path, payload=missing)["status"] == "UNKNOWN"
    assert evaluate(tmp_path, payload=short)["status"] == "UNKNOWN"


def test_unverified_quiet_period_fails(tmp_path):
    result = evaluate(
        tmp_path,
        payload=cost_payload(quietPeriodStatus="operator-confirmed-traffic-quiet"),
    )

    assert result == {"status": "UNKNOWN", "reason": "TPD_COST_QUIET_PERIOD_PROOF_REQUIRED"}


def test_wrong_scope_model_or_limit_fails(tmp_path):
    wrong_scope = evaluate(tmp_path, payload=cost_payload(organizationScope="project-only"))
    wrong_model = evaluate(tmp_path, payload=cost_payload(model="openai/gpt-oss-20b"))
    wrong_limit = evaluate(tmp_path, payload=cost_payload(dailyLimitTokens=200_001))
    mismatched_limit_attestation = evaluate(
        tmp_path,
        payload=cost_payload(),
        limit=limit_payload(models={MODEL: {"dailyLimitTokens": 199_999}}),
    )

    assert wrong_scope["status"] == "UNKNOWN"
    assert wrong_model["status"] == "UNKNOWN"
    assert wrong_limit["status"] == "UNKNOWN"
    assert mismatched_limit_attestation["status"] == "UNKNOWN"


def test_stale_cost_observation_fails(tmp_path):
    result = evaluate(
        tmp_path,
        payload=cost_payload(observedAt=(NOW - timedelta(hours=2)).isoformat()),
    )

    assert result == {"status": "UNKNOWN", "reason": "TPD_COST_ATTESTATION_STALE_OR_INVALID"}


def test_price_floor_must_match_supported_uncached_input_floor(tmp_path):
    pricing = json.loads(DEFAULT_GROQ_PRICING.read_text(encoding="utf-8"))
    pricing["rateLimitCountedTokenPriceFloorUsdPerMillion"] = "0.075"
    path = write_json(tmp_path / "pricing.json", pricing)

    result = evaluate(tmp_path, pricing_path=path)

    assert result["status"] == "UNKNOWN"
    assert result["reason"] == "GROQ_PRICING_SNAPSHOT_INVALID_OR_STALE"


def test_output_price_cannot_make_bound_less_conservative(tmp_path):
    pricing = json.loads(DEFAULT_GROQ_PRICING.read_text(encoding="utf-8"))
    pricing["outputUsdPerMillion"] = "60.00"
    path = write_json(tmp_path / "pricing.json", pricing)

    result = evaluate(tmp_path, pricing_path=path)

    assert result["status"] == "YES"
    assert result["models"][0]["maxRateLimitedTokensFromCost"] == 133_334


def test_output_price_below_counted_floor_is_rejected(tmp_path):
    pricing = json.loads(DEFAULT_GROQ_PRICING.read_text(encoding="utf-8"))
    pricing["outputUsdPerMillion"] = "0.14"
    path = write_json(tmp_path / "pricing.json", pricing)

    result = evaluate(tmp_path, pricing_path=path)

    assert result["status"] == "UNKNOWN"
    assert result["reason"] == "GROQ_PRICING_SNAPSHOT_INVALID_OR_STALE"


def test_cached_price_does_not_increase_rate_limited_bound(tmp_path):
    pricing = json.loads(DEFAULT_GROQ_PRICING.read_text(encoding="utf-8"))
    pricing["cachedInputUsdPerMillion"] = "0.001"
    path = write_json(tmp_path / "pricing.json", pricing)

    result = evaluate(tmp_path, pricing_path=path)

    assert result["status"] == "YES"
    assert result["models"][0]["rateLimitedTokenPriceFloorUsdPerMillion"] == "0.15"
    assert result["models"][0]["maxRateLimitedTokensFromCost"] == 133_334


def test_stale_pricing_snapshot_fails_closed(tmp_path):
    pricing = json.loads(DEFAULT_GROQ_PRICING.read_text(encoding="utf-8"))
    pricing["verifiedAt"] = (NOW - timedelta(days=31)).isoformat()
    path = write_json(tmp_path / "pricing.json", pricing)

    result = evaluate(tmp_path, pricing_path=path)

    assert result == {"status": "UNKNOWN", "reason": "GROQ_PRICING_SNAPSHOT_INVALID_OR_STALE"}


def test_cost_baseline_initializes_ledger_conservatively(tmp_path):
    result = evaluate(
        tmp_path,
        payload=cost_payload(observedOrganizationModelCostUsd="0.0218928"),
    )
    rows = [
        json.loads(line)
        for line in (tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()
    ]

    assert result["status"] == "YES"
    assert len(rows) == 1
    assert rows[0]["recordType"] == "BASELINE"
    assert rows[0]["baselineUsedTokens"] == 145_952
    assert rows[0]["countedTokens"] == 0
    assert rows[0]["ledgerEpoch"] == rows[0]["baselineId"]


def test_subsequent_ledger_usage_reduces_proven_remaining(tmp_path):
    result = evaluate(tmp_path, payload=cost_payload(observedOrganizationModelCostUsd="0.0218928"))
    ledger = GroqDailyTokenLedger(tmp_path / "ledger.jsonl")
    ledger.record(
        {
            "requestId": "judge-1",
            "timestamp": (NOW + timedelta(minutes=1)).isoformat(),
            "provider": "groq",
            "model": MODEL,
            "countedTokens": 1_000,
        }
    )
    resumed = evaluate(
        tmp_path,
        payload=cost_payload(observedOrganizationModelCostUsd="0.0218928"),
        now=NOW + timedelta(minutes=2),
    )

    assert result["status"] == "YES"
    assert resumed["models"][0]["baselineId"] == result["models"][0]["baselineId"]
    assert resumed["status"] == "NO"
    assert resumed["models"][0]["ledgerUsedTokens"] == 1_000
    assert resumed["models"][0]["minimumProvenRemainingTokens"] == 53_048


def test_new_cost_observation_cannot_silently_rebase_existing_ledger(tmp_path):
    evaluate(tmp_path, payload=cost_payload(observedOrganizationModelCostUsd="0.0218928"))
    later = cost_payload(
        observedAt=(NOW + timedelta(minutes=1)).isoformat(),
        observedOrganizationModelCostUsd="0.0218929",
    )

    result = evaluate(tmp_path, payload=later, now=NOW + timedelta(minutes=2))

    assert result == {"status": "UNKNOWN", "reason": "TPD_LEDGER_BASELINE_UNAVAILABLE"}


def test_tpm_and_rpd_headers_are_not_tpd_evidence(tmp_path):
    result = evaluate(
        tmp_path,
        payload=cost_payload(
            **{
                "x-ratelimit-remaining-tokens": "0",
                "x-ratelimit-limit-tokens": "1",
                "x-ratelimit-remaining-requests": "0",
                "x-ratelimit-limit-requests": "1",
            }
        ),
    )

    assert result["status"] == "YES"
