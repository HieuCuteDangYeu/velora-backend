import asyncio
import hashlib
import json
from argparse import Namespace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from rag_eval import cli
from rag_eval.checkpoint import JudgeCheckpointStore
from rag_eval.groq_tpd_usage import exact_usage_tpd_headroom
from rag_eval.judge_runtime import JudgeUsageTracker, estimate_input_tokens
from rag_eval.recovery import (
    AUTHORIZED_DATASET_SHA256,
    AUTHORIZED_DATASET_VERSION,
    AUTHORIZED_JUDGE_MODEL,
    AUTHORIZED_JUDGE_PROVIDER,
    AUTHORIZED_PRODUCTION_SHA,
    AUTHORIZED_SOURCE_RUN_ID,
    INSUFFICIENT_TPD_FOR_NEXT_OPERATION,
    MIDNIGHT_IN_FLIGHT_REQUESTS_PENDING,
    WAITING_FOR_NEXT_TPD_WINDOW,
    DailyRecoveryDeferred,
    MultiDayRecoveryStore,
    RecoveryOperation,
    RecoveryStateError,
    mandatory_metrics_complete,
    multiday_tpd_preflight,
    recovery_operations,
    schedule_safe_slice,
    source_provenance_fingerprint,
)
from rag_eval.tpd_ledger import GroqDailyTokenLedger

MODEL = AUTHORIZED_JUDGE_MODEL
TODAY = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
TOMORROW = TODAY + timedelta(days=1)
YESTERDAY = TODAY - timedelta(days=1)


def identity(**overrides):
    value = {
        "datasetVersion": AUTHORIZED_DATASET_VERSION,
        "datasetSha256": AUTHORIZED_DATASET_SHA256,
        "sourceRunId": AUTHORIZED_SOURCE_RUN_ID,
        "productionSha": AUTHORIZED_PRODUCTION_SHA,
        "judgeProvider": AUTHORIZED_JUDGE_PROVIDER,
        "judgeModel": AUTHORIZED_JUDGE_MODEL,
        "sourceProvenanceFingerprint": "a" * 64,
        "semanticContextBindingSha256": "b" * 64,
    }
    value.update(overrides)
    return value


def baseline(
    now: datetime,
    *,
    remaining: int = 200_000,
    method: str = "EXACT_TOKEN_USAGE_BASELINE",
    suffix: str = "base",
):
    date = now.astimezone(UTC).date().isoformat()
    fingerprint = hashlib.sha256(
        f"{date}:{remaining}:{method}:{suffix}".encode()
    ).hexdigest()
    return {
        "model": MODEL,
        "method": method,
        "dailyLimitTokens": 200_000,
        "baselineUsedTokens": 200_000 - remaining,
        "baselineId": f"epoch-{date}-{suffix}",
        "ledgerEpoch": f"epoch-{date}-{suffix}",
        "baselineFingerprint": fingerprint,
        "source": "groq-console-organization-usage-api",
        "observedAt": now.isoformat().replace("+00:00", "Z"),
        "windowDateUtc": date,
        "epochLedgerUsedTokens": 0,
        "epochMinimumProvenRemainingTokens": remaining,
        "minimumProvenRemainingTokens": remaining,
    }


def tpd(detail):
    return {"status": "YES", "reason": "test", "models": [detail]}


def make_store(tmp_path, *, now=TODAY, remaining=200_000, suffix="base"):
    store = MultiDayRecoveryStore(
        tmp_path / "recovery.json",
        identity(),
        checkpoint_id="checkpoint-1",
    )
    store.begin_epoch(baseline(now, remaining=remaining, suffix=suffix), now=now)
    return store


def dispatch(
    store,
    *,
    now=TODAY,
    case_id="case-1",
    metric="faithfulness",
    attempt=1,
    reservation=1_000,
    margin=10_000,
):
    request_id = store.ensure_capacity(
        case_id=case_id,
        metric=metric,
        attempt=attempt,
        reservation_tokens=reservation,
        safety_margin_tokens=margin,
        now=now,
    )
    store.mark_dispatched(
        request_id=request_id,
        case_id=case_id,
        metric=metric,
        attempt=attempt,
        reservation_tokens=reservation,
        now=now,
    )
    return request_id


def test_recovery_larger_than_daily_limit_is_accepted_as_multiday_slice():
    operations = [
        RecoveryOperation(f"case-{index}", "faithfulness", 8_000)
        for index in range(30)
    ]

    result = multiday_tpd_preflight(
        tpd(baseline(TODAY)), operations, now=TODAY, safety_margin_tokens=10_000
    )

    assert result["status"] == "YES"
    assert result["totalRecoveryEstimateTokens"] == 231_125
    assert result["scheduledReservationTokens"] <= 190_000
    assert result["deferredOperationKeys"]


def test_one_day_known_231125_lower_bound_still_fails_200000_tpd(tmp_path, monkeypatch):
    midnight = TODAY.replace(hour=0)
    monkeypatch.setenv("RAGAS_GROQ_TPD_PLANNED_FULL_RUN_TOKENS", "231125")
    payload = {
        "schemaVersion": "groq-tpd-usage-baseline-v1",
        "provider": "groq",
        "scope": "TPD",
        "source": "groq-console-organization-usage-api",
        "observedAt": TODAY.isoformat(),
        "windowDateUtc": TODAY.date().isoformat(),
        "usageBucketTimestamp": int(midnight.timestamp()),
        "organizationScope": "all-projects",
        "model": MODEL,
        "dailyLimitTokens": 200_000,
        "contextTokens": 0,
        "nonCachedInputTokens": 0,
        "cachedInputTokens": 0,
        "generatedTokens": 0,
        "rateLimitCountedUsedTokens": 0,
        "numRequests": 0,
        "plannedFullRunTokens": 231_125,
        "verifiedQuietPeriodSeconds": 900,
    }

    result = exact_usage_tpd_headroom(
        payload,
        (MODEL,),
        GroqDailyTokenLedger(tmp_path / "ledger.jsonl"),
        now=TODAY,
    )

    assert result["status"] == "NO"
    assert result["models"][0]["minimumProvenRemainingTokens"] == 200_000


def test_safe_slice_selection_is_a_conservative_prefix():
    operations = [
        RecoveryOperation("case-1", "faithfulness", 50_000),
        RecoveryOperation("case-2", "faithfulness", 50_000),
        RecoveryOperation("case-3", "faithfulness", 50_000),
    ]

    result = schedule_safe_slice(
        operations, remaining_tokens=120_000, safety_margin_tokens=10_000
    )

    assert [item.key for item in result["scheduled"]] == [
        "case-1::faithfulness",
        "case-2::faithfulness",
    ]
    assert [item.key for item in result["deferred"]] == ["case-3::faithfulness"]
    assert result["scheduledReservationTokens"] == 100_000


class FakeCompletions:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    async def create(self, **_kwargs):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class FakeClient:
    def __init__(self, outcomes):
        self.chat = SimpleNamespace(completions=FakeCompletions(outcomes))


class TransientRateLimitError(Exception):
    status_code = 429
    body = {"error": {"code": "rate_limit_exceeded", "message": "retry shortly"}}
    response = SimpleNamespace(headers={"retry-after": "0"})


def judge_response():
    return SimpleNamespace(
        id="judge-response",
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=4, total_tokens=14),
        headers={},
    )


def runtime_store(tmp_path, monkeypatch, *, remaining):
    now = datetime.now(UTC)
    monkeypatch.setenv("RAGAS_GROQ_DAILY_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    monkeypatch.setenv("RAGAS_TOKEN_ESTIMATE_SAFETY_TOKENS", "0")
    monkeypatch.setenv("RAGAS_MULTI_DAY_DAILY_SAFETY_MARGIN_TOKENS", "0")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_JITTER_MAX_SECONDS", "0")
    store = MultiDayRecoveryStore(
        tmp_path / "recovery.json", identity(), checkpoint_id="checkpoint-1"
    )
    store.begin_epoch(baseline(now, remaining=remaining), now=now)
    store.set_daily_plan(
        scheduled_operation_keys=["case-1::faithfulness"],
        deferred_operation_keys=[],
        scheduled_reservation_tokens=remaining,
    )
    return store


@pytest.mark.asyncio
async def test_over_headroom_operation_is_not_sent(tmp_path, monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "0")
    store = runtime_store(tmp_path, monkeypatch, remaining=50)
    client = FakeClient([judge_response()])
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.configure_multiday_recovery(store)
    tracker.begin("run:case-1")
    tracker.set_metric("faithfulness")

    with pytest.raises(DailyRecoveryDeferred, match=INSUFFICIENT_TPD_FOR_NEXT_OPERATION):
        await client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": "judge"}],
            max_tokens=100,
        )

    assert client.chat.completions.calls == 0


def test_daily_stop_persists_waiting_checkpoint(tmp_path):
    store = make_store(tmp_path)
    store.set_daily_plan(
        scheduled_operation_keys=["case-1::faithfulness"],
        deferred_operation_keys=["case-2::faithfulness"],
        scheduled_reservation_tokens=8_000,
    )

    with pytest.raises(DailyRecoveryDeferred, match=INSUFFICIENT_TPD_FOR_NEXT_OPERATION):
        store.ensure_capacity(
            case_id="case-2",
            metric="faithfulness",
            attempt=1,
            reservation_tokens=1_000,
            safety_margin_tokens=10_000,
            now=TODAY,
        )

    resumed = MultiDayRecoveryStore(
        tmp_path / "recovery.json", identity(), checkpoint_id="checkpoint-1"
    )
    snapshot = resumed.snapshot()
    assert snapshot["status"] == WAITING_FOR_NEXT_TPD_WINDOW
    assert snapshot["dailyRecoveryStopReason"] == INSUFFICIENT_TPD_FOR_NEXT_OPERATION
    assert snapshot["epochs"][0]["closedAt"] is not None


def test_daily_deferred_signal_bypasses_generic_provider_exception_handlers():
    assert not isinstance(DailyRecoveryDeferred(INSUFFICIENT_TPD_FOR_NEXT_OPERATION), Exception)


def test_daily_slice_membership_is_explicit(tmp_path):
    store = make_store(tmp_path)
    store.set_daily_plan(
        scheduled_operation_keys=["case-1::faithfulness"],
        deferred_operation_keys=["case-2::faithfulness"],
        scheduled_reservation_tokens=8_000,
    )

    assert store.operation_is_scheduled(case_id="case-1", metric="faithfulness")
    assert not store.operation_is_scheduled(case_id="case-2", metric="faithfulness")


def test_new_utc_epoch_after_closed_previous_day(tmp_path):
    store = make_store(tmp_path)
    assert store.close_current(INSUFFICIENT_TPD_FOR_NEXT_OPERATION, now=TODAY)

    store.begin_epoch(baseline(TOMORROW, suffix="day-2"), now=TOMORROW)

    epochs = store.epochs()
    assert [epoch["windowDateUtc"] for epoch in epochs] == [
        TODAY.date().isoformat(),
        TOMORROW.date().isoformat(),
    ]
    assert epochs[1]["baselineCountedUsedTokens"] == 0


def test_same_day_quota_slice_can_resume_with_newer_baseline(tmp_path):
    store = make_store(tmp_path)
    store.close_current(INSUFFICIENT_TPD_FOR_NEXT_OPERATION, now=TODAY)
    old_epoch = store.epochs()[0]
    refreshed_at = TODAY + timedelta(minutes=1)
    refreshed = baseline(refreshed_at, suffix="same-day-refresh")
    refreshed["ledgerEpoch"] = old_epoch["ledgerEpoch"]
    refreshed["effectiveCurrentDayUsedTokens"] = 1_000
    refreshed["epochMinimumProvenRemainingTokens"] = 199_000
    refreshed["minimumProvenRemainingTokens"] = 199_000

    store.begin_epoch(refreshed, now=TODAY + timedelta(minutes=2))

    epoch = store.epochs()[0]
    assert epoch["closedAt"] is None
    assert epoch["closeReason"] is None
    assert epoch["latestBaselineId"] == refreshed["baselineId"]
    assert epoch["calculatedRemainingTokens"] == 199_000
    assert len(epoch["sliceCloseHistory"]) == 1


def test_same_day_refresh_can_promote_previously_deferred_work(tmp_path):
    store = make_store(tmp_path)
    store.set_daily_plan(
        scheduled_operation_keys=["case-1::faithfulness"],
        deferred_operation_keys=["case-2::faithfulness"],
        scheduled_reservation_tokens=8_000,
    )
    store.close_current(INSUFFICIENT_TPD_FOR_NEXT_OPERATION, now=TODAY)
    old_epoch = store.epochs()[0]
    refreshed_at = TODAY + timedelta(minutes=1)
    refreshed = baseline(refreshed_at, suffix="same-day-refresh")
    refreshed["ledgerEpoch"] = old_epoch["ledgerEpoch"]

    store.begin_epoch(refreshed, now=TODAY + timedelta(minutes=2))
    store.set_daily_plan(
        scheduled_operation_keys=["case-2::faithfulness"],
        deferred_operation_keys=[],
        scheduled_reservation_tokens=8_000,
    )

    epoch = store.epochs()[0]
    assert epoch["scheduledOperationKeys"] == ["case-2::faithfulness"]
    assert epoch["deferredOperationKeys"] == []
    with pytest.raises(RecoveryStateError, match="cannot be replaced"):
        store.set_daily_plan(
            scheduled_operation_keys=["case-3::faithfulness"],
            deferred_operation_keys=[],
            scheduled_reservation_tokens=8_000,
        )


def test_same_day_resume_requires_a_newer_baseline(tmp_path):
    store = make_store(tmp_path)
    store.close_current(INSUFFICIENT_TPD_FOR_NEXT_OPERATION, now=TODAY)

    with pytest.raises(RecoveryStateError, match="newer TPD baseline"):
        store.begin_epoch(baseline(TODAY), now=TODAY + timedelta(minutes=1))


@pytest.mark.asyncio
async def test_multiple_structured_calls_share_metric_and_get_distinct_call_indexes(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "0")
    monkeypatch.setenv("RAGAS_TOKEN_ESTIMATE_SAFETY_TOKENS", "0")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_JITTER_MAX_SECONDS", "0")
    store = runtime_store(tmp_path, monkeypatch, remaining=50_000)
    client = FakeClient([judge_response(), judge_response()])
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.configure_multiday_recovery(store)
    tracker.begin("run:case-1")
    tracker.set_metric("faithfulness")
    messages = [{"role": "user", "content": "judge"}]

    await client.chat.completions.create(model=MODEL, messages=messages, max_tokens=32)
    await client.chat.completions.create(model=MODEL, messages=messages, max_tokens=32)
    calls = tracker.take("run:case-1")

    assert [call["callIndex"] for call in calls] == [1, 2]
    assert [call["attempt"] for call in calls] == [1, 1]
    assert [
        record["callIndex"]
        for record in (
            json.loads(line)
            for line in (tmp_path / "ledger.jsonl").read_text().splitlines()
        )
        if record.get("recordType") == "REQUEST"
    ] == [1, 2]
    assert len(store.snapshot()["requests"]) == 2


@pytest.mark.asyncio
async def test_resumed_metric_allocates_a_new_attempt_after_prior_accounting(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "0")
    monkeypatch.setenv("RAGAS_TOKEN_ESTIMATE_SAFETY_TOKENS", "0")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_JITTER_MAX_SECONDS", "0")
    store = runtime_store(tmp_path, monkeypatch, remaining=50_000)
    messages = [{"role": "user", "content": "judge"}]

    first_client = FakeClient([judge_response()])
    first = JudgeUsageTracker(first_client, provider="groq")
    first.configure_multiday_recovery(store)
    first.begin("run:case-1")
    first.set_metric("faithfulness")
    await first_client.chat.completions.create(model=MODEL, messages=messages, max_tokens=32)
    first.take("run:case-1")

    resumed_client = FakeClient([judge_response()])
    resumed = JudgeUsageTracker(resumed_client, provider="groq")
    resumed.configure_multiday_recovery(store)
    resumed.begin("run:case-1")
    resumed.set_metric("faithfulness")
    await resumed_client.chat.completions.create(model=MODEL, messages=messages, max_tokens=32)
    calls = resumed.take("run:case-1")

    assert calls[0]["callIndex"] == 1
    assert calls[0]["attempt"] == 2
    requests = store.snapshot()["requests"]
    assert sorted((item["callIndex"], item["attempt"]) for item in requests.values()) == [
        (1, 1),
        (1, 2),
    ]


@pytest.mark.asyncio
async def test_canceled_dispatched_request_is_conservatively_accounted(tmp_path, monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "0")
    monkeypatch.setenv("RAGAS_TOKEN_ESTIMATE_SAFETY_TOKENS", "0")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_JITTER_MAX_SECONDS", "0")
    store = runtime_store(tmp_path, monkeypatch, remaining=50_000)
    client = FakeClient([asyncio.CancelledError()])
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.configure_multiday_recovery(store)
    tracker.begin("run:case-1")
    tracker.set_metric("faithfulness")
    messages = [{"role": "user", "content": "judge"}]

    with pytest.raises(asyncio.CancelledError):
        await client.chat.completions.create(model=MODEL, messages=messages, max_tokens=32)

    request = next(iter(store.snapshot()["requests"].values()))
    assert request["status"] == "ACCOUNTED"
    assert request["outcomeStatus"] == "FAILURE"
    assert request["countedTokens"] == request["reservationTokens"]
    assert request["reservationTokens"] > 0
    assert request["callIndex"] == 1
    assert store.snapshot()["epochs"][0]["reservedPendingTokens"] == 0


def test_previous_epoch_is_immutable_after_rollover(tmp_path):
    store = make_store(tmp_path)
    store.close_current(INSUFFICIENT_TPD_FOR_NEXT_OPERATION, now=TODAY)
    previous = store.epochs()[0]

    store.begin_epoch(baseline(TOMORROW, suffix="day-2"), now=TOMORROW)

    assert store.epochs()[0] == previous


def checkpoint_identity(**overrides):
    value = {
        "sourceRunId": AUTHORIZED_SOURCE_RUN_ID,
        "productionSha": AUTHORIZED_PRODUCTION_SHA,
        "datasetVersion": AUTHORIZED_DATASET_VERSION,
        "judgeProvider": AUTHORIZED_JUDGE_PROVIDER,
        "judgeModel": AUTHORIZED_JUDGE_MODEL,
        "evaluatorSha": "c" * 40,
    }
    value.update(overrides)
    return value


def checkpoint_entry(**overrides):
    value = {
        **checkpoint_identity(),
        "sourceExecutionId": "execution-1",
        "ragTraceId": "trace-1",
        "caseId": "case-1",
        "metricName": "faithfulness",
        "status": "COMPLETE",
        "value": 0.9,
        "calls": [],
    }
    value.update(overrides)
    return value


def test_semantic_checkpoint_continues_across_daily_recovery(tmp_path):
    checkpoint_path = tmp_path / "checkpoint.json"
    checkpoint = JudgeCheckpointStore(checkpoint_path, checkpoint_identity())
    checkpoint.record(checkpoint_entry())
    checkpoint_id = checkpoint.checkpoint_id
    store = MultiDayRecoveryStore(
        tmp_path / "recovery.json", identity(), checkpoint_id=checkpoint_id
    )
    store.begin_epoch(baseline(TODAY), now=TODAY)
    store.close_current(INSUFFICIENT_TPD_FOR_NEXT_OPERATION, now=TODAY)

    resumed_checkpoint = JudgeCheckpointStore(
        checkpoint_path, checkpoint_identity(evaluatorSha="d" * 40)
    )
    resumed_store = MultiDayRecoveryStore(
        tmp_path / "recovery.json", identity(), checkpoint_id=resumed_checkpoint.checkpoint_id
    )
    resumed_store.begin_epoch(baseline(TOMORROW, suffix="day-2"), now=TOMORROW)

    assert resumed_checkpoint.checkpoint_id == checkpoint_id
    assert resumed_checkpoint.get("case-1", "faithfulness")["value"] == 0.9


def test_completed_metrics_are_never_rescheduled():
    operations = recovery_operations(
        ["case-1"],
        ["faithfulness", "context_recall"],
        [
            {"caseId": "case-1", "metricName": "faithfulness", "status": "COMPLETE"},
            {"caseId": "case-1", "metricName": "context_recall", "status": "UNAVAILABLE"},
        ],
        reservation_tokens=8_000,
    )

    assert [item.key for item in operations] == ["case-1::context_recall"]


def test_faithfulness_planning_reservation_covers_two_structured_calls(monkeypatch):
    monkeypatch.delenv("RAGAS_FAITHFULNESS_OPERATION_RESERVATION_TOKENS", raising=False)
    operations = recovery_operations(
        ["case-1"],
        ["faithfulness"],
        [{"caseId": "case-1", "metricName": "faithfulness", "status": "UNAVAILABLE"}],
        reservation_tokens=1_000,
    )

    assert operations[0].reservation_tokens == 12_000


def test_authorization_is_consumed_only_when_first_dispatch_occurs(tmp_path):
    store = make_store(tmp_path)
    assert store.authorization_status == "UNCONSUMED"
    store.ensure_capacity(
        case_id="case-1",
        metric="faithfulness",
        attempt=1,
        reservation_tokens=1_000,
        safety_margin_tokens=10_000,
        now=TODAY,
    )
    assert store.authorization_status == "UNCONSUMED"

    dispatch(store, now=TODAY)

    assert store.authorization_status == "CONSUMED"


def test_day_two_resume_does_not_consume_second_authorization(tmp_path):
    store = make_store(tmp_path)
    request_id = dispatch(store, now=TODAY)
    consumed_at = store.snapshot()["authorization"]["consumedAt"]
    store.mark_accounted(request_id, 500, now=TODAY)
    store.close_current(INSUFFICIENT_TPD_FOR_NEXT_OPERATION, now=TODAY)
    store.begin_epoch(baseline(TOMORROW, suffix="day-2"), now=TOMORROW)

    request_id = dispatch(store, now=TOMORROW, case_id="case-2")

    assert store.authorization_status == "CONSUMED"
    assert store.snapshot()["authorization"]["consumedAt"] == consumed_at
    assert request_id


def test_each_new_utc_day_requires_fresh_baseline(tmp_path):
    store = make_store(tmp_path)
    store.close_current(INSUFFICIENT_TPD_FOR_NEXT_OPERATION, now=TODAY)

    with pytest.raises(RecoveryStateError, match="fresh current-day exact TPD baseline"):
        store.begin_epoch(baseline(TODAY), now=TOMORROW)


def test_stale_prior_day_attestation_is_rejected_by_multiday_preflight():
    result = multiday_tpd_preflight(
        tpd(baseline(YESTERDAY)),
        [RecoveryOperation("case-1", "faithfulness", 8_000)],
        now=TODAY,
    )

    assert result == {"status": "UNKNOWN", "reason": "MULTI_DAY_TPD_BASELINE_DATE_INVALID"}


def test_exact_current_day_baseline_is_accepted():
    result = multiday_tpd_preflight(
        tpd(baseline(TODAY)),
        [RecoveryOperation("case-1", "faithfulness", 8_000)],
        now=TODAY,
    )

    assert result["status"] == "YES"


def test_verified_empty_current_day_baseline_is_accepted():
    result = multiday_tpd_preflight(
        tpd(baseline(TODAY, method="EMPTY_CURRENT_WINDOW_VERIFIED")),
        [RecoveryOperation("case-1", "faithfulness", 8_000)],
        now=TODAY,
    )

    assert result["status"] == "YES"


def test_same_day_baseline_refresh_keeps_one_recovery_epoch(tmp_path):
    store = make_store(tmp_path)
    old_epoch = store.active_epoch()
    refreshed = baseline(TODAY, suffix="refresh")
    refreshed["ledgerEpoch"] = old_epoch["ledgerEpoch"]
    refreshed["effectiveCurrentDayUsedTokens"] = 270
    refreshed["epochMinimumProvenRemainingTokens"] = 199_730
    refreshed["minimumProvenRemainingTokens"] = 199_730
    refreshed["baselineUsedTokens"] = 0

    store.begin_epoch(refreshed, now=TODAY)

    epochs = store.epochs()
    assert len(epochs) == 1
    assert epochs[0]["ledgerEpoch"] == old_epoch["ledgerEpoch"]
    assert epochs[0]["latestBaselineId"] == refreshed["baselineId"]
    assert epochs[0]["calculatedRemainingTokens"] == 199_730
    assert len(epochs[0]["baselineRefreshes"]) == 1


@pytest.mark.asyncio
async def test_transient_retry_rechecks_and_obeys_daily_tpd(tmp_path, monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "1")
    messages = [{"role": "user", "content": "judge"}]
    request_reservation = estimate_input_tokens(messages) + 32
    store = runtime_store(tmp_path, monkeypatch, remaining=request_reservation * 3)
    client = FakeClient([TransientRateLimitError(), judge_response()])
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.configure_multiday_recovery(store)
    tracker.begin("run:case-1")
    tracker.set_metric("faithfulness")

    await client.chat.completions.create(model=MODEL, messages=messages, max_tokens=32)

    snapshot = store.snapshot()
    assert client.chat.completions.calls == 2
    assert len(snapshot["requests"]) == 2
    assert all(item["status"] == "ACCOUNTED" for item in snapshot["requests"].values())


@pytest.mark.asyncio
async def test_insufficient_retry_budget_defers_without_second_provider_call(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "1")
    messages = [{"role": "user", "content": "judge"}]
    request_reservation = estimate_input_tokens(messages) + 32
    store = runtime_store(tmp_path, monkeypatch, remaining=request_reservation * 2 - 1)
    client = FakeClient([TransientRateLimitError(), judge_response()])
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.configure_multiday_recovery(store)
    tracker.begin("run:case-1")
    tracker.set_metric("faithfulness")

    with pytest.raises(DailyRecoveryDeferred, match=INSUFFICIENT_TPD_FOR_NEXT_OPERATION):
        await client.chat.completions.create(model=MODEL, messages=messages, max_tokens=32)

    assert client.chat.completions.calls == 1
    assert store.snapshot()["dailyRecoveryStopReason"] == INSUFFICIENT_TPD_FOR_NEXT_OPERATION


def test_crash_restart_reconciles_ledger_without_resending(tmp_path):
    store = make_store(tmp_path)
    request_id = dispatch(store, now=TODAY)
    epoch = store.request_epoch(request_id)
    ledger = GroqDailyTokenLedger(tmp_path / "ledger.jsonl")
    ledger.record(
        {
            "requestId": request_id,
            "timestamp": TODAY.isoformat(),
            "provider": "groq",
            "model": MODEL,
            "countedTokens": 700,
            **epoch,
        }
    )

    resumed = MultiDayRecoveryStore(
        tmp_path / "recovery.json", identity(), checkpoint_id="checkpoint-1"
    )
    assert resumed.reconcile_ledger(ledger) == 1
    request = next(iter(resumed.snapshot()["requests"].values()))

    assert request["status"] == "ACCOUNTED"
    assert request["countedTokens"] == 700
    assert ledger.usage_for_epoch(MODEL, epoch["ledgerEpoch"]) == 700


def test_midnight_in_flight_request_blocks_new_epoch_conservatively(tmp_path):
    store = make_store(tmp_path, now=TODAY.replace(hour=23, minute=59))
    dispatch(store, now=TODAY.replace(hour=23, minute=59))

    with pytest.raises(DailyRecoveryDeferred, match=WAITING_FOR_NEXT_TPD_WINDOW):
        store.begin_epoch(baseline(TOMORROW, suffix="day-2"), now=TOMORROW)

    snapshot = store.snapshot()
    assert len(snapshot["epochs"]) == 1
    assert snapshot["epochs"][0]["closedAt"] is None
    assert snapshot["dailyRecoveryStopReason"] == MIDNIGHT_IN_FLIGHT_REQUESTS_PENDING


@pytest.mark.asyncio
async def test_multiday_mode_cannot_start_a_new_production_rag_run(monkeypatch):
    calls = 0

    def forbidden_runner(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise AssertionError("production RAG runner must not execute")

    monkeypatch.setattr(cli, "invoke_typescript_runner", forbidden_runner)
    args = Namespace(
        confirm_live=True,
        dataset=AUTHORIZED_DATASET_VERSION,
        definitions_report="unused.json",
        resume=None,
        trace_file="saved-traces.jsonl",
        semantic_context_file="saved-context.json",
        multi_day_recovery=True,
        live_judge=True,
    )

    with pytest.raises(SystemExit, match="saved --resume"):
        await cli.run_live(args)

    assert calls == 0


def test_source_and_enriched_context_fingerprints_are_stable_and_bound():
    executions_a = {
        "case-2": SimpleNamespace(
            trace={"productionExecutionId": "exec-2", "ragTraceId": "trace-2"}
        ),
        "case-1": SimpleNamespace(
            trace={"productionExecutionId": "exec-1", "ragTraceId": "trace-1"}
        ),
    }
    executions_b = dict(reversed(list(executions_a.items())))

    first = source_provenance_fingerprint(executions_a)
    second = source_provenance_fingerprint(executions_b)
    changed = source_provenance_fingerprint(
        {
            **executions_a,
            "case-1": SimpleNamespace(
                trace={"productionExecutionId": "exec-1", "ragTraceId": "trace-changed"}
            ),
        }
    )

    assert first == second
    assert first != changed
    assert identity()["semanticContextBindingSha256"] == "b" * 64


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("datasetVersion", "rag-frozen-ami-v2"),
        ("datasetSha256", "0" * 64),
        ("sourceRunId", "other-run"),
        ("productionSha", "0" * 40),
        ("judgeProvider", "cloudflare"),
        ("judgeModel", "other-model"),
        ("sourceProvenanceFingerprint", "0" * 64),
        ("semanticContextBindingSha256", "0" * 64),
    ],
)
def test_lineage_mismatch_fails_closed(tmp_path, field, value):
    path = tmp_path / "recovery.json"
    MultiDayRecoveryStore(path, identity(), checkpoint_id="checkpoint-1")

    with pytest.raises(RecoveryStateError):
        MultiDayRecoveryStore(
            path,
            identity(**{field: value}),
            checkpoint_id="checkpoint-1",
        )


def test_checkpoint_replacement_cannot_be_used_for_score_shopping(tmp_path):
    path = tmp_path / "recovery.json"
    MultiDayRecoveryStore(path, identity(), checkpoint_id="checkpoint-1")

    with pytest.raises(RecoveryStateError, match="lineage mismatch"):
        MultiDayRecoveryStore(path, identity(), checkpoint_id="checkpoint-replacement")


def test_final_aggregates_require_every_mandatory_metric_complete():
    partial = [
        {"status": "COMPLETE"},
        {"status": "COMPLETE"},
        {"status": "UNAVAILABLE"},
    ]
    complete = [{"status": "COMPLETE"} for _ in range(3)]

    assert not mandatory_metrics_complete(partial, 3)
    assert not mandatory_metrics_complete(complete[:2], 3)
    assert mandatory_metrics_complete(complete, 3)


def test_partial_progress_reports_completed_failed_pending_and_deferred(tmp_path):
    store = make_store(tmp_path, remaining=150_000)
    request_id = dispatch(store, now=TODAY, case_id="case-pending")
    assert request_id
    progress = store.progress(
        [
            {"status": "COMPLETE"},
            {"status": "COMPLETE"},
            {"status": "UNAVAILABLE"},
        ],
        total_operations=5,
        deferred_operations=1,
    )

    assert progress["completedCalls"] == 2
    assert progress["failedCalls"] == 1
    assert progress["pendingCalls"] == 1
    assert progress["deferredCalls"] == 1
    assert progress["dailyLimitTokens"] == 200_000
    assert progress["calculatedRemainingTokens"] == 150_000
    assert progress["callsCompletedToday"] == 0
    assert progress["callsFailedToday"] == 0
    assert progress["callsPendingToday"] == 1


def test_yesterday_epoch_usage_never_reduces_todays_epoch_budget(tmp_path):
    ledger = GroqDailyTokenLedger(tmp_path / "ledger.jsonl")
    day1 = ledger.initialize_baseline(
        provider="groq",
        model=MODEL,
        observed_at=TODAY.isoformat(),
        daily_limit_tokens=200_000,
        baseline_used_tokens=0,
        organization_scope="all-projects",
        window_key=f"{TODAY.date().isoformat()}:day",
        baseline_fingerprint="1" * 64,
        pricing_version="test",
    )
    day2 = ledger.initialize_baseline(
        provider="groq",
        model=MODEL,
        observed_at=TOMORROW.isoformat(),
        daily_limit_tokens=200_000,
        baseline_used_tokens=0,
        organization_scope="all-projects",
        window_key=f"{TOMORROW.date().isoformat()}:day",
        baseline_fingerprint="2" * 64,
        pricing_version="test",
    )
    ledger.record(
        {
            "requestId": "day-1-request",
            "timestamp": TODAY.isoformat(),
            "provider": "groq",
            "model": MODEL,
            "countedTokens": 50_000,
            "ledgerEpoch": day1,
            "windowDateUtc": TODAY.date().isoformat(),
        }
    )
    ledger.record(
        {
            "requestId": "day-2-request",
            "timestamp": TOMORROW.isoformat(),
            "provider": "groq",
            "model": MODEL,
            "countedTokens": 2_000,
            "ledgerEpoch": day2,
            "windowDateUtc": TOMORROW.date().isoformat(),
        }
    )

    assert ledger.usage_for_epoch(MODEL, day1) == 50_000
    assert ledger.usage_for_epoch(MODEL, day2) == 2_000


def test_only_unavailable_or_not_evaluated_work_can_enter_recovery():
    operations = recovery_operations(
        ["case-1", "case-2"],
        ["faithfulness"],
        [{"caseId": "case-1", "metricName": "faithfulness", "status": "UNAVAILABLE"}],
        reservation_tokens=8_000,
    )

    assert [(item.key, item.status) for item in operations] == [
        ("case-1::faithfulness", "UNAVAILABLE"),
        ("case-2::faithfulness", "NOT_EVALUATED"),
    ]
    with pytest.raises(RecoveryStateError, match="unsupported checkpoint status"):
        recovery_operations(
            ["case-1"],
            ["faithfulness"],
            [{"caseId": "case-1", "metricName": "faithfulness", "status": "FAILED"}],
            reservation_tokens=8_000,
        )
