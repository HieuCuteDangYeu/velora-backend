import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from rag_eval.preflight import (
    first_request_tpm_headroom,
    run_preflight,
    scheduler_ready,
    scheduler_snapshot,
    tpd_headroom,
)
from rag_eval.tpd_ledger import GroqDailyTokenLedger

MODEL = "openai/gpt-oss-120b"
NOW = datetime(2026, 9, 13, 12, 0, tzinfo=UTC)


def probe(status=200, remaining="7925"):
    return {
        "model": MODEL,
        "status": status,
        "networkReachable": True,
        "headers": {
            "x-ratelimit-limit-tokens": "8000",
            "x-ratelimit-remaining-tokens": remaining,
            "x-ratelimit-reset-tokens": "562ms",
        },
        "dailyQuotaError": False,
    }


def write_json(path, payload):
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def limit_attestation(
    tmp_path, *, daily_limit=200_000, observed_at=NOW, model=MODEL, name="limit.json"
):
    return write_json(
        tmp_path / name,
        {
            "schemaVersion": "groq-tpd-limit-attestation-v1",
            "provider": "groq",
            "scope": "TPD_LIMIT",
            "source": "groq-console-organization-limits",
            "observedAt": observed_at.isoformat(),
            "models": {model: {"dailyLimitTokens": daily_limit}},
        },
    )


def window_attestation(
    tmp_path,
    *,
    usage=0,
    daily_limit=200_000,
    observed_at=NOW,
    window_started_at=None,
    source="operator-observed-fresh-window",
    planned=54_048,
    model=MODEL,
    name="window.json",
):
    model_value = {
        "dailyLimitTokens": daily_limit,
        "usageSinceWindowStartTokens": usage,
        "plannedFullRunTokens": planned,
    }
    payload = {
        "schemaVersion": "groq-tpd-window-attestation-v1",
        "provider": "groq",
        "scope": "TPD",
        "source": source,
        "observedAt": observed_at.isoformat(),
        "models": {model: model_value},
    }
    if window_started_at is not None:
        payload["windowStartedAt"] = window_started_at.isoformat()
    return write_json(tmp_path / name, payload)


def headroom(tmp_path, *, window=None, limit=None, ledger=None, now=NOW):
    return tpd_headroom(
        None,
        (MODEL,),
        limit_attestation_path=str(limit or limit_attestation(tmp_path)),
        window_attestation_path=str(window or window_attestation(tmp_path)),
        ledger_path=str(ledger or tmp_path / "ledger.jsonl"),
        now=now,
        max_age_seconds=3_600,
    )


def ledger_record(*, request_id="request-1", model=MODEL, counted_tokens=1_000):
    return {
        "schemaVersion": "groq-tpd-ledger-record-v1",
        "requestId": request_id,
        "timestamp": (NOW + timedelta(minutes=1)).isoformat(),
        "provider": "groq",
        "model": model,
        "inputTokens": counted_tokens - 100,
        "outputTokens": 100,
        "totalTokens": counted_tokens,
        "countedTokens": counted_tokens,
        "countingMode": "PROVIDER",
        "runId": "run-1",
        "caseId": "case-1",
        "judgeOperation": "faithfulness",
        "status": "SUCCESS",
        "providerStatus": 200,
        "providerCategory": "SUCCESS",
        "attempt": 1,
    }


def test_tpm_preflight_checks_only_the_next_operation():
    ok, remaining = first_request_tpm_headroom(probe(), 6_000)

    assert ok is True
    assert remaining == 7_925


def test_tpm_preflight_rejects_a_failed_first_operation():
    ok, remaining = first_request_tpm_headroom(probe(status=429), 6_000)

    assert ok is False
    assert remaining == 7_925


def test_scheduler_caps_target_at_six_thousand(monkeypatch):
    monkeypatch.setenv("RAGAS_GROQ_TPM_LIMIT", "8000")
    monkeypatch.setenv("RAGAS_GROQ_TPM_TARGET", "7000")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_HEADROOM_RATIO", "0.25")

    snapshot = scheduler_snapshot()

    assert snapshot["tpmTarget"] == 6_000
    assert scheduler_ready(snapshot) is True


def test_limit_only_attestation_does_not_establish_remaining_headroom(tmp_path):
    result = tpd_headroom(
        str(limit_attestation(tmp_path)),
        (MODEL,),
        ledger_path=str(tmp_path / "ledger.jsonl"),
        now=NOW,
        max_age_seconds=3_600,
    )

    assert result == {"status": "UNKNOWN", "reason": "TPD_WINDOW_BASELINE_REQUIRED"}


def test_fresh_window_and_empty_ledger_establishes_two_hundred_thousand_remaining(tmp_path):
    result = headroom(tmp_path)

    assert result["status"] == "YES"
    assert result["reason"] == "MODEL_TPD_ATTESTATION_EVALUATED"
    assert result["models"][0]["calculatedRemainingTokens"] == 200_000
    assert result["models"][0]["ledgerUsedTokens"] == 0
    assert result["models"][0]["plannedFullRunTokens"] == 54_048


def test_ledger_consumption_reduces_remaining_tpd(tmp_path):
    ledger_path = tmp_path / "ledger.jsonl"
    GroqDailyTokenLedger(ledger_path).record(ledger_record(counted_tokens=1_000))

    result = headroom(tmp_path, ledger=ledger_path, now=NOW + timedelta(minutes=2))

    assert result["status"] == "YES"
    assert result["models"][0]["ledgerUsedTokens"] == 1_000
    assert result["models"][0]["calculatedRemainingTokens"] == 199_000


def test_insufficient_remaining_budget_fails_preflight(tmp_path):
    result = headroom(
        tmp_path,
        window=window_attestation(tmp_path, usage=145_953),
    )

    assert result["status"] == "NO"
    assert result["models"][0]["calculatedRemainingTokens"] == 54_047


def test_unknown_reset_window_provenance_fails_closed(tmp_path):
    window = window_attestation(
        tmp_path,
        source="operator-observed-known-usage",
    )

    result = headroom(tmp_path, window=window)

    assert result == {"status": "UNKNOWN", "reason": "TPD_WINDOW_START_UNPROVEN"}


def test_tpm_headers_can_never_alter_tpd_accounting(tmp_path):
    limit = limit_attestation(tmp_path)
    window = window_attestation(tmp_path)
    for path in (limit, window):
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["x-ratelimit-remaining-tokens"] = "0"
        payload["x-ratelimit-limit-tokens"] = "1"
        path.write_text(json.dumps(payload), encoding="utf-8")

    result = headroom(tmp_path, limit=limit, window=window)

    assert result["models"][0]["calculatedRemainingTokens"] == 200_000


def test_unrelated_model_ledger_entries_are_not_attributed(tmp_path):
    ledger_path = tmp_path / "ledger.jsonl"
    GroqDailyTokenLedger(ledger_path).record(
        ledger_record(model="openai/gpt-oss-20b", counted_tokens=150_000)
    )

    result = headroom(tmp_path, ledger=ledger_path, now=NOW + timedelta(minutes=2))

    assert result["status"] == "YES"
    assert result["models"][0]["ledgerUsedTokens"] == 0


def test_stale_window_attestation_fails_closed(tmp_path):
    window = window_attestation(tmp_path, observed_at=NOW - timedelta(hours=2))

    result = headroom(tmp_path, window=window)

    assert result == {
        "status": "UNKNOWN",
        "reason": "TPD_WINDOW_ATTESTATION_INVALID_OR_STALE",
    }


def test_legacy_remaining_tpd_attestation_is_not_accepted(tmp_path):
    path = write_json(
        tmp_path / "legacy.json",
        {
            "schemaVersion": "groq-tpd-attestation-v1",
            "provider": "groq",
            "scope": "TPD",
            "source": "groq-console-organization-limits",
            "observedAt": NOW.isoformat(),
            "models": {MODEL: {"dailyRemainingTokens": 200_000, "plannedFullRunTokens": 54_048}},
        },
    )

    result = tpd_headroom(
        str(path),
        (MODEL,),
        ledger_path=str(tmp_path / "ledger.jsonl"),
        now=NOW,
        max_age_seconds=3_600,
    )

    assert result["status"] == "UNKNOWN"


@pytest.mark.asyncio
async def test_run_preflight_does_not_pass_without_tpd_baseline(monkeypatch, capsys, tmp_path):
    async def fake_probe(models, _base_url, _api_key, _timeout):
        return [probe() | {"model": model} for model in models]

    monkeypatch.setenv("GROQ_API_KEY", "present-but-not-read")
    monkeypatch.setenv("RAGAS_GROQ_TPM_LIMIT", "8000")
    monkeypatch.setenv("RAGAS_GROQ_TPM_TARGET", "6000")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_HEADROOM_RATIO", "0.25")
    monkeypatch.setattr("rag_eval.preflight.probe_groq", fake_probe)
    args = SimpleNamespace(
        models=MODEL,
        first_model=MODEL,
        first_operation_tokens=6_000,
        tpd_attestation=None,
        tpd_limit_attestation=None,
        tpd_window_attestation=None,
        ledger_path=str(tmp_path / "ledger.jsonl"),
        timeout=1.0,
    )

    result = await run_preflight(args)

    assert result == 1
    output = capsys.readouterr().out
    assert "PROVIDER_REACHABLE=YES" in output
    assert "TPM_SCHEDULER_READY=YES" in output
    assert "FIRST_REQUEST_TPM_HEADROOM=YES" in output
    assert "TPD_WINDOW_BASELINE_STATUS=UNKNOWN" in output
    assert "TPD_HEADROOM_FOR_FULL_RUN=UNKNOWN" in output
    assert "PREFLIGHT_PASS=NO" in output
    assert "FROZEN_V3_RUN_STARTED=NO" in output


@pytest.mark.asyncio
async def test_run_preflight_passes_with_limit_and_window_attestations(
    monkeypatch, capsys, tmp_path
):
    async def fake_probe(models, _base_url, _api_key, _timeout):
        return [probe() | {"model": model} for model in models]

    monkeypatch.setenv("GROQ_API_KEY", "present-but-not-read")
    monkeypatch.setenv("RAGAS_GROQ_TPM_LIMIT", "8000")
    monkeypatch.setenv("RAGAS_GROQ_TPM_TARGET", "6000")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_HEADROOM_RATIO", "0.25")
    monkeypatch.setattr("rag_eval.preflight.probe_groq", fake_probe)
    observed_at = datetime.now(UTC)
    args = SimpleNamespace(
        models=MODEL,
        first_model=MODEL,
        first_operation_tokens=6_000,
        tpd_attestation=None,
        tpd_limit_attestation=str(limit_attestation(tmp_path, observed_at=observed_at)),
        tpd_window_attestation=str(window_attestation(tmp_path, observed_at=observed_at)),
        ledger_path=str(tmp_path / "ledger.jsonl"),
        timeout=1.0,
    )

    result = await run_preflight(args)

    assert result == 0
    output = capsys.readouterr().out
    assert "TPD_HEADROOM_FOR_FULL_RUN=YES" in output
    assert "TPD_HEADROOM_REASON=MODEL_TPD_ATTESTATION_EVALUATED" in output
    assert "TPD_CALCULATED_REMAINING_TOKENS=200000" in output
    assert "PREFLIGHT_PASS=YES" in output
    assert "FROZEN_V3_RUN_STARTED" not in output
