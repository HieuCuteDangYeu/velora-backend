import json
from datetime import UTC, datetime, timedelta

import pytest

from rag_eval.cli import parser
from rag_eval.groq_tpd_metrics import (
    GroqMetricsBaselineError,
    normalize_groq_rolling_metrics_baseline,
)
from rag_eval.preflight import tpd_headroom
from rag_eval.recovery import RecoveryOperation, multiday_tpd_preflight
from rag_eval.tpd_ledger import GroqDailyTokenLedger

MODEL = "openai/gpt-oss-120b"
OBSERVED = datetime(2026, 9, 15, 12, 0, tzinfo=UTC)


def metric_row(
    timestamp: datetime,
    *,
    input_tokens: int = 100,
    cached_tokens: int = 25,
    uncached_tokens: int = 75,
    output_tokens: int = 10,
    requests: int = 1,
    model: str = MODEL,
    **extra,
):
    return {
        "timestamp": timestamp.isoformat().replace("+00:00", "Z"),
        "model": model,
        "total_input_tokens": input_tokens,
        "total_cached_input_tokens": cached_tokens,
        "total_uncached_input_tokens": uncached_tokens,
        "total_output_tokens": output_tokens,
        "total_requests": requests,
        **extra,
    }


def rolling_payload(*rows):
    return {"data": list(rows)}


def last_hour_payload(*rows, observed_at=OBSERVED):
    return {
        "request": {
            "start_time": (observed_at - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
            "end_time": observed_at.isoformat().replace("+00:00", "Z"),
        },
        "data": list(rows),
    }


def normalize(rolling, quiet=None, *, observed_at=OBSERVED):
    return normalize_groq_rolling_metrics_baseline(
        rolling,
        quiet if quiet is not None else last_hour_payload(observed_at=observed_at),
        observed_at=observed_at,
        all_projects=True,
    )


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def test_current_utc_date_filters_previous_date_and_aggregates_duplicate_timestamps():
    duplicate = OBSERVED.replace(hour=10)
    baseline = normalize(
        rolling_payload(
            metric_row(
                OBSERVED - timedelta(days=1),
                input_tokens=9_000,
                cached_tokens=0,
                uncached_tokens=9_000,
                output_tokens=1_000,
            ),
            metric_row(
                duplicate,
                input_tokens=100,
                cached_tokens=40,
                uncached_tokens=60,
                output_tokens=10,
                requests=2,
            ),
            metric_row(
                duplicate,
                input_tokens=50,
                cached_tokens=20,
                uncached_tokens=30,
                output_tokens=5,
                requests=3,
            ),
        )
    )

    assert baseline["windowDateUtc"] == "2026-09-15"
    assert baseline["contextTokens"] == 150
    assert baseline["cachedInputTokens"] == 60
    assert baseline["nonCachedInputTokens"] == 90
    assert baseline["generatedTokens"] == 15
    assert baseline["rateLimitCountedUsedTokens"] == 105
    assert baseline["numRequests"] == 5


def test_input_breakdown_must_match_before_aggregation():
    row = metric_row(OBSERVED.replace(hour=10))
    row["total_input_tokens"] = 101

    with pytest.raises(GroqMetricsBaselineError, match="METRICS_INPUT_TOKEN_BREAKDOWN_MISMATCH"):
        normalize(rolling_payload(row))


def test_future_target_bucket_fails_closed():
    with pytest.raises(GroqMetricsBaselineError, match="METRICS_BUCKET_TIMESTAMP_FUTURE"):
        normalize(rolling_payload(metric_row(OBSERVED + timedelta(seconds=1))))


def test_empty_last_hour_proves_full_hour_and_nonzero_usage_fails_closed():
    baseline = normalize(rolling_payload(metric_row(OBSERVED.replace(hour=10))))

    assert baseline["verifiedQuietPeriodSeconds"] == 3_600

    with pytest.raises(GroqMetricsBaselineError, match="LAST_HOUR_TARGET_MODEL_USAGE_NONZERO"):
        normalize(
            rolling_payload(metric_row(OBSERVED.replace(hour=10))),
            last_hour_payload(metric_row(OBSERVED - timedelta(minutes=30))),
        )


def test_last_hour_total_calls_field_prevents_false_quiet_proof():
    row = metric_row(
        OBSERVED - timedelta(minutes=30),
        input_tokens=0,
        cached_tokens=0,
        uncached_tokens=0,
        output_tokens=0,
        requests=0,
    )
    row.pop("total_requests")
    row["total_calls"] = 1

    with pytest.raises(GroqMetricsBaselineError, match="LAST_HOUR_TARGET_MODEL_USAGE_NONZERO"):
        normalize(
            rolling_payload(metric_row(OBSERVED.replace(hour=10))),
            last_hour_payload(row),
        )


def test_raw_empty_last_hour_response_uses_explicit_last_hour_input_contract():
    baseline = normalize(
        rolling_payload(metric_row(OBSERVED.replace(hour=10))),
        {"object": "list", "data": []},
    )

    assert baseline["verifiedQuietPeriodSeconds"] == 3_600


def test_last_hour_requires_request_window_to_end_at_observation():
    quiet = last_hour_payload()
    quiet["request"]["end_time"] = (OBSERVED - timedelta(seconds=1)).isoformat()

    with pytest.raises(GroqMetricsBaselineError, match="LAST_HOUR_WINDOW_INVALID"):
        normalize(rolling_payload(), quiet)


def test_raw_project_and_api_key_identifiers_are_not_emitted():
    baseline = normalize(
        rolling_payload(
            metric_row(
                OBSERVED.replace(hour=10),
                project_id="project-secret",
                api_key_id="key-secret",
            )
        )
    )
    serialized = json.dumps(baseline, sort_keys=True)

    assert "project_id" not in serialized
    assert "api_key_id" not in serialized
    assert "project-secret" not in serialized
    assert "key-secret" not in serialized
    assert baseline["organizationScope"] == "all-projects"


def test_saved_metrics_flow_reconciles_ledger_overlap_without_double_counting(tmp_path):
    rolling_path = write_json(
        tmp_path / "rolling.json",
        rolling_payload(
            metric_row(
                OBSERVED.replace(hour=10),
                input_tokens=900,
                cached_tokens=100,
                uncached_tokens=800,
                output_tokens=200,
            )
        ),
    )
    quiet_path = write_json(tmp_path / "quiet.json", last_hour_payload())
    ledger_path = tmp_path / "ledger.jsonl"
    ledger = GroqDailyTokenLedger(ledger_path)
    ledger.record(
        {
            "requestId": "before-observation",
            "timestamp": (OBSERVED - timedelta(hours=1, minutes=30)).isoformat(),
            "provider": "groq",
            "model": MODEL,
            "countedTokens": 700,
        }
    )
    ledger.record(
        {
            "requestId": "after-observation",
            "timestamp": (OBSERVED + timedelta(minutes=1)).isoformat(),
            "provider": "groq",
            "model": MODEL,
            "countedTokens": 300,
        }
    )

    result = tpd_headroom(
        None,
        (MODEL,),
        ledger_path=str(ledger_path),
        rolling_24h_metrics_path=str(rolling_path),
        last_hour_metrics_path=str(quiet_path),
        metrics_observed_at=OBSERVED.isoformat(),
        metrics_all_projects=True,
        now=OBSERVED + timedelta(minutes=2),
    )

    detail = result["models"][0]
    assert detail["baselineUsedTokens"] == 1_000
    assert detail["ledgerBeforeObservationTokens"] == 700
    assert detail["ledgerAfterObservationTokens"] == 300
    assert detail["effectiveCurrentDayUsedTokens"] == 1_300
    assert detail["unreconciledLedgerTokens"] == 300
    ledger_text = ledger_path.read_text(encoding="utf-8")
    assert "project_id" not in ledger_text
    assert "api_key_id" not in ledger_text


def test_metrics_refresh_preserves_same_day_epoch_and_utc_rollover_starts_new_epoch(tmp_path):
    ledger_path = tmp_path / "ledger.jsonl"

    def evaluate(observed_at, usage):
        rolling_path = write_json(
            tmp_path / "rolling.json",
            rolling_payload(
                metric_row(
                    observed_at.replace(hour=10, minute=0),
                    input_tokens=usage,
                    cached_tokens=0,
                    uncached_tokens=usage,
                    output_tokens=0,
                )
            ),
        )
        quiet_path = write_json(
            tmp_path / "quiet.json", last_hour_payload(observed_at=observed_at)
        )
        return tpd_headroom(
            None,
            (MODEL,),
            ledger_path=str(ledger_path),
            rolling_24h_metrics_path=str(rolling_path),
            last_hour_metrics_path=str(quiet_path),
            metrics_observed_at=observed_at.isoformat(),
            metrics_all_projects=True,
            now=observed_at + timedelta(minutes=1),
        )["models"][0]

    first = evaluate(OBSERVED, 1_000)
    refreshed = evaluate(OBSERVED + timedelta(minutes=30), 1_100)
    tomorrow = evaluate(OBSERVED + timedelta(days=1), 0)

    assert refreshed["baselineId"] != first["baselineId"]
    assert refreshed["ledgerEpoch"] == first["ledgerEpoch"]
    assert refreshed["baselineRefreshOf"] == first["baselineId"]
    assert tomorrow["ledgerEpoch"] != first["ledgerEpoch"]
    assert tomorrow["windowDateUtc"] == "2026-09-16"


def test_rolling_metrics_baseline_is_accepted_by_multiday_recovery_gate(tmp_path):
    rolling_path = write_json(
        tmp_path / "rolling.json",
        rolling_payload(metric_row(OBSERVED.replace(hour=10))),
    )
    quiet_path = write_json(tmp_path / "quiet.json", last_hour_payload())
    tpd = tpd_headroom(
        None,
        (MODEL,),
        ledger_path=str(tmp_path / "ledger.jsonl"),
        rolling_24h_metrics_path=str(rolling_path),
        last_hour_metrics_path=str(quiet_path),
        metrics_observed_at=OBSERVED.isoformat(),
        metrics_all_projects=True,
        now=OBSERVED,
    )

    result = multiday_tpd_preflight(
        tpd,
        [RecoveryOperation("case-1", "faithfulness", 8_000)],
        now=OBSERVED,
    )

    assert result["status"] == "YES"
    assert result["baseline"]["source"] == "groq-console-organization-rolling-metrics-api"


def test_cli_exposes_repeatable_saved_metrics_inputs():
    args = parser().parse_args(
        [
            "preflight",
            "--tpd-rolling-24h-metrics",
            "rolling.json",
            "--tpd-last-hour-metrics",
            "last-hour.json",
            "--tpd-metrics-observed-at",
            "2026-09-15T12:00:00Z",
            "--tpd-metrics-all-projects",
        ]
    )

    assert args.tpd_rolling_24h_metrics == "rolling.json"
    assert args.tpd_last_hour_metrics == "last-hour.json"
    assert args.tpd_metrics_observed_at == "2026-09-15T12:00:00Z"
    assert args.tpd_metrics_all_projects is True
