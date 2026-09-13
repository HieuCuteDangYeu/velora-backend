import json
from datetime import UTC, datetime, timedelta

import pytest

from rag_eval.tpd_ledger import GroqDailyTokenLedger, LedgerPersistenceError

NOW = datetime(2026, 9, 13, 12, 0, tzinfo=UTC)
MODEL = "openai/gpt-oss-120b"


def record(*, request_id="request-1", counted_tokens=1_000, timestamp=NOW):
    return {
        "schemaVersion": "groq-tpd-ledger-record-v1",
        "requestId": request_id,
        "timestamp": timestamp.isoformat(),
        "provider": "groq",
        "model": MODEL,
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


def test_process_restart_preserves_ledger_usage(tmp_path):
    path = tmp_path / "groq-ledger.jsonl"
    GroqDailyTokenLedger(path).record(record())

    restarted_ledger = GroqDailyTokenLedger(path)

    assert restarted_ledger.usage_since(MODEL, NOW - timedelta(seconds=1), now=NOW) == 1_000


def test_duplicate_request_accounting_is_idempotent(tmp_path):
    path = tmp_path / "groq-ledger.jsonl"
    ledger = GroqDailyTokenLedger(path)
    entry = record()

    ledger.record(entry)
    ledger.record(entry)

    assert ledger.usage_since(MODEL, NOW - timedelta(seconds=1), now=NOW) == 1_000
    assert len(path.read_text(encoding="utf-8").splitlines()) == 1


def test_ledger_drops_unapproved_content_fields(tmp_path):
    path = tmp_path / "groq-ledger.jsonl"
    ledger = GroqDailyTokenLedger(path)
    entry = record()
    entry["prompt"] = "private question"
    entry["answer"] = "private answer"
    entry["apiKey"] = "secret"

    ledger.record(entry)

    persisted = json.loads(path.read_text(encoding="utf-8"))
    assert "prompt" not in persisted
    assert "answer" not in persisted
    assert "apiKey" not in persisted


def test_malformed_existing_ledger_fails_closed(tmp_path):
    path = tmp_path / "groq-ledger.jsonl"
    path.write_text('{"requestId":"bad","countedTokens":"unknown"}\n', encoding="utf-8")

    with pytest.raises(LedgerPersistenceError):
        GroqDailyTokenLedger(path).usage_since(MODEL, NOW - timedelta(seconds=1), now=NOW)
