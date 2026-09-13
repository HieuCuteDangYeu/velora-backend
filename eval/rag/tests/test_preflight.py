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


def probe(status=200, remaining="7925"):
    return {
        "model": "openai/gpt-oss-120b",
        "status": status,
        "networkReachable": True,
        "headers": {
            "x-ratelimit-limit-tokens": "8000",
            "x-ratelimit-remaining-tokens": remaining,
            "x-ratelimit-reset-tokens": "562ms",
        },
        "dailyQuotaError": False,
    }


def attestation(tmp_path, *, remaining=100_000, required=50_000, source="groq-console-limits"):
    path = tmp_path / "groq-tpd.json"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": "groq-tpd-attestation-v1",
                "provider": "groq",
                "scope": "TPD",
                "source": source,
                "observedAt": datetime.now(UTC).isoformat(),
                "models": {
                    "openai/gpt-oss-120b": {
                        "dailyRemainingTokens": remaining,
                        "plannedFullRunTokens": required,
                    }
                },
            }
        )
    )
    return path


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


def test_tpd_is_independent_from_tpm_headers(tmp_path):
    result = tpd_headroom(
        str(attestation(tmp_path, remaining=100_000, required=50_000)),
        ("openai/gpt-oss-120b",),
    )

    assert result == {
        "status": "YES",
        "reason": "MODEL_TPD_ATTESTATION_EVALUATED",
    }


def test_tpd_rejects_insufficient_daily_budget(tmp_path):
    result = tpd_headroom(
        str(attestation(tmp_path, remaining=49_999, required=50_000)),
        ("openai/gpt-oss-120b",),
    )

    assert result["status"] == "NO"


def test_tpd_requires_independent_attestation(tmp_path):
    assert tpd_headroom(None, ("openai/gpt-oss-120b",))["status"] == "UNKNOWN"
    assert (
        tpd_headroom(
            str(attestation(tmp_path, source="x-ratelimit-remaining-tokens")),
            ("openai/gpt-oss-120b",),
        )["status"]
        == "UNKNOWN"
    )


def test_tpd_rejects_stale_attestation(tmp_path):
    path = attestation(tmp_path)
    payload = json.loads(path.read_text())
    payload["observedAt"] = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    path.write_text(json.dumps(payload))

    result = tpd_headroom(
        str(path),
        ("openai/gpt-oss-120b",),
        now=datetime.now(UTC),
        max_age_seconds=3_600,
    )

    assert result == {"status": "UNKNOWN", "reason": "TPD_ATTESTATION_STALE"}


@pytest.mark.asyncio
async def test_run_preflight_does_not_pass_without_tpd_attestation(monkeypatch, capsys):
    async def fake_probe(models, _base_url, _api_key, _timeout):
        return [probe() | {"model": model} for model in models]

    monkeypatch.setenv("GROQ_API_KEY", "present-but-not-read")
    monkeypatch.setattr("rag_eval.preflight.probe_groq", fake_probe)
    args = SimpleNamespace(
        models="openai/gpt-oss-120b",
        first_model=None,
        first_operation_tokens=6_000,
        tpd_attestation=None,
        timeout=1.0,
    )

    result = await run_preflight(args)

    assert result == 1
    output = capsys.readouterr().out
    assert "PROVIDER_REACHABLE=YES" in output
    assert "TPM_SCHEDULER_READY=YES" in output
    assert "FIRST_REQUEST_TPM_HEADROOM=YES" in output
    assert "TPD_HEADROOM_FOR_FULL_RUN=UNKNOWN" in output
    assert "PREFLIGHT_PASS=NO" in output
    assert "FROZEN_V3_RUN_STARTED=NO" in output


@pytest.mark.asyncio
async def test_run_preflight_passes_with_independent_tpd_attestation(monkeypatch, capsys, tmp_path):
    async def fake_probe(models, _base_url, _api_key, _timeout):
        return [probe() | {"model": model} for model in models]

    monkeypatch.setenv("GROQ_API_KEY", "present-but-not-read")
    monkeypatch.setattr("rag_eval.preflight.probe_groq", fake_probe)
    path = attestation(tmp_path, remaining=100_000, required=50_000)
    args = SimpleNamespace(
        models="openai/gpt-oss-120b",
        first_model=None,
        first_operation_tokens=6_000,
        tpd_attestation=str(path),
        timeout=1.0,
    )

    result = await run_preflight(args)

    assert result == 0
    output = capsys.readouterr().out
    assert "TPD_HEADROOM_FOR_FULL_RUN=YES" in output
    assert "PREFLIGHT_PASS=YES" in output
    assert "FROZEN_V3_RUN_STARTED" not in output
