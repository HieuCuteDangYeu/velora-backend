import asyncio
import json
import os
from types import SimpleNamespace

import pytest

from rag_eval.judge_runtime import (
    JudgeRateLimiter,
    JudgeUsageTracker,
    classify_judge_error,
    estimate_input_tokens,
    retry_after_seconds,
)


@pytest.fixture(autouse=True)
def isolated_groq_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv("RAGAS_GROQ_DAILY_LEDGER_PATH", str(tmp_path / "groq-ledger.jsonl"))


class FakeClock:
    def __init__(self):
        self.value = 0.0

    def now(self):
        return self.value

    async def sleep(self, seconds):
        self.value += seconds


def limiter(clock, *, target=100, concurrency=1):
    return JudgeRateLimiter(
        provider="groq",
        concurrency=concurrency,
        tpm_limit=8000,
        tpm_target=target,
        headroom_ratio=0.25,
        safety_tokens=0,
        jitter_max_seconds=0,
        clock=clock.now,
        sleep=clock.sleep,
        random_uniform=lambda _lower, _upper: 0,
    )


@pytest.mark.asyncio
async def test_concurrency_one_never_overlaps_calls():
    clock = FakeClock()
    rate_limiter = limiter(clock, target=None, concurrency=1)
    active = 0
    maximum = 0

    async def operation():
        nonlocal active, maximum
        lease = await rate_limiter.acquire(1)
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0)
        active -= 1
        await rate_limiter.release(lease, 1)

    await asyncio.gather(*(operation() for _ in range(8)))
    assert maximum == 1


@pytest.mark.asyncio
async def test_tpm_reservation_waits_for_rolling_window():
    clock = FakeClock()
    rate_limiter = limiter(clock, target=100)
    first = await rate_limiter.acquire(60)
    await rate_limiter.release(first, 60)
    second = await rate_limiter.acquire(50)
    await rate_limiter.release(second, 50)

    assert clock.value >= 60
    assert rate_limiter.wait_count == 1
    assert rate_limiter.total_wait_ms >= 60_000


def test_input_token_estimator_is_conservative_and_retry_headers_are_supported():
    assert estimate_input_tokens([{"role": "user", "content": "x" * 300}]) >= 100
    assert retry_after_seconds({"retry-after": "2.5"}) == 2.5
    assert retry_after_seconds({"x-ratelimit-reset-tokens": "3s"}) == 3
    assert retry_after_seconds({}, "try again in 4.14s") == 4.14


@pytest.mark.asyncio
async def test_tracker_reserves_input_output_and_records_rate_limit_state(monkeypatch):
    monkeypatch.setenv("RAGAS_TOKEN_ESTIMATE_SAFETY_TOKENS", "0")
    client = FakeClient([response()])
    tracker = JudgeUsageTracker(client, provider="groq")
    observed = []
    original_acquire = tracker._limiter.acquire

    async def capture(tokens):
        observed.append(tokens)
        return await original_acquire(tokens)

    tracker._limiter.acquire = capture
    messages = [{"role": "user", "content": "judge"}]
    tracker.begin("run:case")
    tracker.set_metric("context_recall")
    await client.chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=messages,
        max_tokens=32,
    )
    calls = tracker.take("run:case")

    assert observed == [estimate_input_tokens(messages) + 32]
    assert calls[0]["rateLimitHeaders"]["x-ratelimit-limit-tokens"] == "8000"
    assert tracker.limiter_stats()["headerObservationCount"] == 1
    assert tracker.limiter_stats()["providerRemainingTokens"] == 7986


def ledger_rows():
    path = os.environ["RAGAS_GROQ_DAILY_LEDGER_PATH"]
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


class FakeRateLimitError(Exception):
    status_code = 429
    body = {"error": {"code": "rate_limit_exceeded"}}
    response = SimpleNamespace(
        headers={
            "retry-after": "0",
            "x-ratelimit-limit-tokens": "8000",
            "x-ratelimit-remaining-tokens": "0",
            "x-ratelimit-reset-tokens": "0s",
        }
    )


class FakeConsumedRateLimitError(FakeRateLimitError):
    usage = SimpleNamespace(prompt_tokens=10, completion_tokens=2, total_tokens=12)


class FakeDailyQuotaError(Exception):
    status_code = 429
    body = {
        "error": {
            "code": "rate_limit_exceeded",
            "message": "tokens per day limit reached",
        }
    }
    response = SimpleNamespace(
        headers={
            "retry-after": "574",
            "x-ratelimit-limit-tokens": "8000",
            "x-ratelimit-remaining-tokens": "0",
            "x-ratelimit-reset-tokens": "17s",
        }
    )


class FakeGroqSchemaError(Exception):
    status_code = 400
    body = {
        "error": {
            "code": "json_validate_failed",
            "message": "Failed to validate JSON",
        }
    }


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


def response():
    return SimpleNamespace(
        id="response-1",
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=4, total_tokens=14),
        headers={
            "x-ratelimit-limit-tokens": "8000",
            "x-ratelimit-remaining-tokens": "7986",
            "x-ratelimit-reset-tokens": "59s",
        },
    )


@pytest.mark.asyncio
async def test_429_is_bounded_retried_and_headers_are_recorded(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "1")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_JITTER_MAX_SECONDS", "0")
    client = FakeClient([FakeRateLimitError(), response()])
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.begin("run:case")
    tracker.set_metric("faithfulness")

    result = await client.chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=[{"role": "user", "content": "judge"}],
        max_tokens=32,
    )
    calls = tracker.take("run:case")

    assert result.usage.total_tokens == 14
    assert client.chat.completions.calls == 2
    assert [call["attempt"] for call in calls] == [1, 2]
    assert calls[0]["providerStatus"] == 429
    assert calls[1]["providerStatus"] == 200
    assert calls[0]["rateLimitHeaders"]["retry-after"] == "0"
    assert calls[0]["waitDurationMs"] >= 0


@pytest.mark.asyncio
async def test_failed_provider_request_with_known_usage_is_counted(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "0")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_JITTER_MAX_SECONDS", "0")
    client = FakeClient([FakeConsumedRateLimitError()])
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.begin("run:case")
    tracker.set_metric("faithfulness")

    with pytest.raises(FakeConsumedRateLimitError):
        await client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": "judge"}],
            max_tokens=32,
        )

    rows = ledger_rows()
    assert len(rows) == 1
    assert rows[0]["status"] == "FAILURE"
    assert rows[0]["inputTokens"] == 10
    assert rows[0]["outputTokens"] == 2
    assert rows[0]["totalTokens"] == 12
    assert rows[0]["countedTokens"] == 12
    assert rows[0]["countingMode"] == "PROVIDER"


@pytest.mark.asyncio
async def test_unavailable_usage_receives_conservative_accounting(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "0")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_JITTER_MAX_SECONDS", "0")
    monkeypatch.setenv("RAGAS_TOKEN_ESTIMATE_SAFETY_TOKENS", "0")
    messages = [{"role": "user", "content": "judge"}]
    client = FakeClient([FakeRateLimitError()])
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.begin("run:case")
    tracker.set_metric("faithfulness")

    with pytest.raises(FakeRateLimitError):
        await client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=messages,
            max_tokens=32,
        )

    rows = ledger_rows()
    assert len(rows) == 1
    assert rows[0]["countingMode"] == "CONSERVATIVE_UPPER_BOUND"
    assert rows[0]["countedTokens"] == estimate_input_tokens(messages) + 32


@pytest.mark.asyncio
async def test_maximum_retries_stops_without_unbounded_calls(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "1")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_JITTER_MAX_SECONDS", "0")
    client = FakeClient([FakeRateLimitError(), FakeRateLimitError(), response()])
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.begin("run:case")
    tracker.set_metric("context_recall")

    with pytest.raises(FakeRateLimitError):
        await client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": "judge"}],
            max_tokens=32,
        )

    calls = tracker.take("run:case")
    assert client.chat.completions.calls == 2
    assert all(call["providerStatus"] == 429 for call in calls)


def test_daily_quota_429_is_permanent_and_not_transient():
    category, transient, code = classify_judge_error(429, FakeDailyQuotaError())
    assert category == "ACCOUNT_LIMITED"
    assert transient is False
    assert code == "rate_limit_exceeded"


def test_groq_json_schema_failure_is_permanent_and_not_retried():
    category, transient, code = classify_judge_error(400, FakeGroqSchemaError())

    assert category == "NON_RETRYABLE_PROVIDER_ERROR"
    assert transient is False
    assert code == "json_validate_failed"


@pytest.mark.asyncio
async def test_daily_quota_429_is_not_retried(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "2")
    monkeypatch.setenv("RAGAS_RATE_LIMIT_JITTER_MAX_SECONDS", "0")
    client = FakeClient([FakeDailyQuotaError()])
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.begin("run:case")
    tracker.set_metric("faithfulness")

    with pytest.raises(FakeDailyQuotaError):
        await client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": "judge"}],
            max_tokens=32,
        )

    calls = tracker.take("run:case")
    assert client.chat.completions.calls == 1
    assert calls[0]["providerCategory"] == "ACCOUNT_LIMITED"
    assert tracker.limiter_stats()["providerRemainingTokens"] is None


class SlowCompletions:
    async def create(self, **_kwargs):
        await asyncio.sleep(2)


@pytest.mark.asyncio
async def test_timeout_is_bounded_and_recorded(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_TIMEOUT_SECONDS", "1")
    monkeypatch.setenv("RAGAS_JUDGE_429_MAX_RETRIES", "0")
    client = SimpleNamespace(chat=SimpleNamespace(completions=SlowCompletions()))
    tracker = JudgeUsageTracker(client, provider="groq")
    tracker.begin("run:case")
    tracker.set_metric("faithfulness")

    with pytest.raises(asyncio.TimeoutError):
        await client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": "judge"}],
            max_tokens=32,
        )

    calls = tracker.take("run:case")
    assert len(calls) == 1
    assert calls[0]["providerStatus"] == "TIMEOUT"
    assert calls[0]["providerCategory"] == "PROVIDER_TIMEOUT"
    assert calls[0]["configuredTimeoutMs"] == 1000.0
