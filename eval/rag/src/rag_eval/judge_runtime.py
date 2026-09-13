"""Shared, evaluation-only judge pacing, retry, and usage accounting."""

from __future__ import annotations

import asyncio
import email.utils
import json
import math
import os
import random
import re
import time
from collections import deque
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC
from typing import Any

_usage_key: ContextVar[str | None] = ContextVar("rag_eval_usage_key", default=None)
_metric_name: ContextVar[str | None] = ContextVar("rag_eval_metric_name", default=None)
_response_headers: ContextVar[dict[str, str] | None] = ContextVar(
    "rag_eval_response_headers", default=None
)

_RATE_LIMIT_HEADERS = {
    "retry-after",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
}
_RETRY_AFTER_BODY = re.compile(r"try again in\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m)?", re.I)


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _nonnegative_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value >= 0 else default


def _ratio(name: str, default: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        return default
    return min(0.95, max(0.0, value))


def _header_map(value: Any) -> dict[str, str]:
    headers = getattr(value, "headers", None)
    if headers is None:
        response = getattr(value, "response", None) or getattr(value, "_response", None)
        headers = getattr(response, "headers", None)
    if headers is None:
        return {}
    try:
        items = headers.items()
    except AttributeError:
        return {}
    return {
        str(key).lower(): str(raw_value)
        for key, raw_value in items
        if str(key).lower() in _RATE_LIMIT_HEADERS
    }


def _install_response_header_capture(client: Any) -> None:
    """Capture headers from OpenAI SDK responses that omit them from model objects."""

    try:
        http_client = client._client
        hooks = http_client.event_hooks.setdefault("response", [])
    except (AttributeError, TypeError):
        return

    async def capture(response: Any) -> None:
        headers = _header_map(response)
        if headers:
            _response_headers.set(headers)

    hooks.append(capture)


def _duration(value: str | None) -> float | None:
    if not value:
        return None
    text = value.strip()
    try:
        return max(0.0, float(text))
    except ValueError:
        pass
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h)?", text, re.I)
    if match:
        amount = float(match.group(1))
        multiplier = {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0}.get(
            (match.group(2) or "s").lower(), 1.0
        )
        return max(0.0, amount * multiplier)
    try:
        target = email.utils.parsedate_to_datetime(text)
        if target.tzinfo is None:
            target = target.replace(tzinfo=UTC)
        return max(0.0, target.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None


def retry_after_seconds(headers: dict[str, str], error_text: str = "") -> float | None:
    direct = _duration(headers.get("retry-after"))
    if direct is not None:
        return direct
    reset = _duration(headers.get("x-ratelimit-reset-tokens"))
    if reset is not None:
        return reset
    match = _RETRY_AFTER_BODY.search(error_text)
    if not match:
        return None
    amount = float(match.group(1))
    return amount / 1000 if (match.group(2) or "s").lower() == "ms" else amount * {
        "s": 1.0,
        "m": 60.0,
    }.get((match.group(2) or "s").lower(), 1.0)


def _provider_error(error: BaseException) -> dict[str, Any]:
    body = getattr(error, "body", {}) or {}
    if isinstance(body, dict):
        nested = body.get("error")
        if isinstance(nested, dict):
            return nested
        return body
    return {}


def _is_account_quota_error(
    status: int | None, message: str, provider: dict[str, Any]
) -> bool:
    if status != 429:
        return False
    try:
        details = json.dumps(provider, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        details = ""
    normalized = f"{message} {details}".lower()
    if any(
        marker in normalized
        for marker in (
            "tokens per day",
            "daily quota",
            "daily token limit",
            "quota exhausted",
            "quota exceeded",
        )
    ):
        return True
    return "quota" in normalized and any(
        marker in normalized for marker in ("exhausted", "exceeded", "reached")
    )


def classify_judge_error(
    status: int | None, error: BaseException | None = None
) -> tuple[str, bool, str | None]:
    message = str(error or "")
    provider = _provider_error(error) if error else {}
    code = provider.get("code")
    if _is_account_quota_error(status, message, provider):
        return "ACCOUNT_LIMITED", False, str(code) if code is not None else None
    if status == 429 or "rate_limit" in message.lower() or "rate limit" in message.lower():
        return "RATE_LIMITED", True, str(code) if code is not None else None
    if status in {408, 500, 502, 503, 504}:
        return "TRANSIENT_PROVIDER_ERROR", True, str(code) if code is not None else None
    error_name = type(error).__name__.lower() if error else ""
    if any(
        term in error_name or term in message.lower()
        for term in ("timeout", "connect", "network")
    ):
        return "TRANSIENT_NETWORK_ERROR", True, str(code) if code is not None else None
    return "NON_RETRYABLE_PROVIDER_ERROR", False, str(code) if code is not None else None


def estimate_input_tokens(messages: Any) -> int:
    """Conservative provider-neutral estimate when the exact GPT-OSS tokenizer is absent."""

    serialized = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    return max(1, math.ceil(len(serialized) / 3))


@dataclass
class _Reservation:
    tokens: int
    created_at: float
    wait_ms: float = 0.0
    released: bool = False


class JudgeRateLimiter:
    """Serialize and pace external judge calls against a rolling token budget."""

    window_seconds = 60.0

    def __init__(
        self,
        *,
        provider: str,
        concurrency: int,
        tpm_limit: int | None,
        tpm_target: int | None,
        headroom_ratio: float,
        safety_tokens: int,
        jitter_max_seconds: float,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        random_uniform: Callable[[float, float], float] = random.uniform,
    ):
        self.provider = provider
        self.concurrency = max(1, concurrency)
        self.tpm_limit = tpm_limit
        self.tpm_target = tpm_target
        self.headroom_ratio = headroom_ratio
        self.safety_tokens = max(0, safety_tokens)
        self.jitter_max_seconds = max(0.0, jitter_max_seconds)
        self._clock = clock
        self._sleep = sleep
        self._random_uniform = random_uniform
        self._semaphore = asyncio.Semaphore(self.concurrency)
        self._lock = asyncio.Lock()
        self._reservations: deque[_Reservation] = deque()
        self._provider_blocked_until = 0.0
        self._provider_reset_at = 0.0
        self._provider_remaining_tokens: int | None = None
        self._provider_limit_tokens: int | None = None
        self._last_headers: dict[str, str] = {}
        self.wait_count = 0
        self.total_wait_ms = 0.0
        self.max_observed_effective_tpm = 0.0
        self.header_observation_count = 0
        self.oversized_reservation_count = 0

    @classmethod
    def from_env(cls, provider: str) -> JudgeRateLimiter:
        provider_name = provider.strip().lower()
        limit = None
        target = None
        if provider_name == "groq":
            limit = _positive_int("RAGAS_GROQ_TPM_LIMIT", 8000)
            configured_target = _positive_int("RAGAS_GROQ_TPM_TARGET", 6000)
            target = min(
                configured_target,
                max(
                    1,
                    math.floor(
                        limit
                        * (1 - _ratio("RAGAS_RATE_LIMIT_HEADROOM_RATIO", 0.25))
                    ),
                ),
            )
        try:
            jitter = float(os.getenv("RAGAS_RATE_LIMIT_JITTER_MAX_SECONDS", "0.25"))
        except ValueError:
            jitter = 0.25
        return cls(
            provider=provider_name,
            concurrency=_positive_int("RAGAS_JUDGE_CONCURRENCY", 1),
            tpm_limit=limit,
            tpm_target=target,
            headroom_ratio=_ratio("RAGAS_RATE_LIMIT_HEADROOM_RATIO", 0.25),
            safety_tokens=_nonnegative_int("RAGAS_TOKEN_ESTIMATE_SAFETY_TOKENS", 256),
            jitter_max_seconds=max(0.0, jitter),
        )

    def _purge(self, now: float) -> None:
        while self._reservations and now - self._reservations[0].created_at >= self.window_seconds:
            self._reservations.popleft()

    def _reserved_tokens(self) -> int:
        return sum(item.tokens for item in self._reservations)

    async def acquire(self, tokens: int) -> _Reservation:
        reservation = _Reservation(max(1, tokens), self._clock())
        await self._semaphore.acquire()
        started = self._clock()
        try:
            while True:
                wait_seconds = 0.0
                async with self._lock:
                    now = self._clock()
                    self._purge(now)
                    if self._provider_reset_at <= now:
                        self._provider_remaining_tokens = None
                    if self._provider_blocked_until > now:
                        wait_seconds = self._provider_blocked_until - now
                    elif (
                        self._provider_remaining_tokens is not None
                        and self._provider_remaining_tokens < reservation.tokens
                        and self._provider_reset_at > now
                    ):
                        wait_seconds = self._provider_reset_at - now
                    elif self.tpm_target is None:
                        self._reservations.append(reservation)
                        break
                    else:
                        used = self._reserved_tokens()
                        if used == 0 and reservation.tokens > self.tpm_target:
                            self.oversized_reservation_count += 1
                            self._reservations.append(reservation)
                            break
                        if used + reservation.tokens <= self.tpm_target:
                            self._reservations.append(reservation)
                            break
                        if self._reservations:
                            wait_seconds = max(
                                wait_seconds,
                                self.window_seconds
                                - (now - self._reservations[0].created_at),
                            )
                wait_seconds += (
                    self._random_uniform(0, self.jitter_max_seconds)
                    if self.jitter_max_seconds
                    else 0.0
                )
                self.wait_count += 1
                await self._sleep(max(0.01, wait_seconds))
            reservation.wait_ms = (self._clock() - started) * 1000
            self.total_wait_ms += reservation.wait_ms
            return reservation
        except BaseException:
            self._semaphore.release()
            raise

    async def observe(
        self,
        headers: dict[str, str],
        *,
        status: int | None,
        actual_tokens: int | None,
        reservation: _Reservation | None = None,
        error_text: str = "",
        account_limited: bool = False,
    ) -> None:
        if os.getenv("RAGAS_RATE_LIMIT_HEADERS_ENABLED", "true").lower() != "false":
            self._last_headers = dict(headers)
            if headers:
                self.header_observation_count += 1
            try:
                if headers.get("x-ratelimit-limit-tokens") is not None:
                    self._provider_limit_tokens = int(
                        float(headers["x-ratelimit-limit-tokens"])
                    )
                if account_limited:
                    self._provider_remaining_tokens = None
                    self._provider_reset_at = 0.0
                elif headers.get("x-ratelimit-remaining-tokens") is not None:
                    self._provider_remaining_tokens = int(
                        float(headers["x-ratelimit-remaining-tokens"])
                    )
                if not account_limited:
                    reset = _duration(headers.get("x-ratelimit-reset-tokens"))
                    if reset is not None:
                        self._provider_reset_at = max(
                            self._provider_reset_at, self._clock() + reset
                        )
            except (TypeError, ValueError):
                pass
        retry_after = retry_after_seconds(headers, error_text)
        if (
            status == 429
            and retry_after is not None
            and not account_limited
            and not _is_account_quota_error(status, error_text, {})
        ):
            self._provider_blocked_until = max(
                self._provider_blocked_until,
                self._clock() + retry_after,
            )
        now = self._clock()
        self._purge(now)
        used = self._reserved_tokens()
        if actual_tokens is not None and reservation is not None:
            reservation.tokens = max(1, actual_tokens)
            used = self._reserved_tokens()
        self.max_observed_effective_tpm = max(
            self.max_observed_effective_tpm,
            used * 60.0 / self.window_seconds,
        )

    async def release(
        self, reservation: _Reservation, actual_tokens: int | None = None
    ) -> None:
        async with self._lock:
            if actual_tokens is not None:
                reservation.tokens = max(1, actual_tokens)
            # Keep completed calls in the rolling window; the semaphore controls
            # concurrency while the reservation queue controls TPM.
            if reservation.released:
                return
            reservation.released = True
        self._semaphore.release()

    async def retry_wait(self, headers: dict[str, str], error_text: str) -> float:
        delay = retry_after_seconds(headers, error_text)
        if delay is None:
            delay = 1.0
        delay += (
            self._random_uniform(0, self.jitter_max_seconds)
            if self.jitter_max_seconds
            else 0.0
        )
        await self._sleep(max(0.01, delay))
        return delay

    def stats(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "concurrency": self.concurrency,
            "tpmLimit": self.tpm_limit,
            "tpmTarget": self.tpm_target,
            "headroomRatio": self.headroom_ratio,
            "waitCount": self.wait_count,
            "totalWaitMs": self.total_wait_ms,
            "maxObservedEffectiveTpm": self.max_observed_effective_tpm,
            "headerObservationCount": self.header_observation_count,
            "lastRateLimitHeaders": self._last_headers,
            "providerLimitTokens": self._provider_limit_tokens,
            "providerRemainingTokens": self._provider_remaining_tokens,
            "providerResetAt": self._provider_reset_at,
            "oversizedReservationCount": self.oversized_reservation_count,
        }


class JudgeUsageTracker:
    """Wrap an OpenAI-compatible judge client with pacing and bounded retries."""

    def __init__(self, client: Any, *, provider: str = "cloudflare"):
        self._calls: dict[str, list[dict[str, Any]]] = {}
        self._limiter = JudgeRateLimiter.from_env(provider)
        try:
            self._max_retries = max(
                0, int(os.getenv("RAGAS_JUDGE_429_MAX_RETRIES", "2"))
            )
        except ValueError:
            self._max_retries = 2
        try:
            self._timeout_seconds = max(
                1.0, float(os.getenv("RAGAS_JUDGE_TIMEOUT_SECONDS", "120"))
            )
        except ValueError:
            self._timeout_seconds = 120.0
        original = client.chat.completions.create
        _install_response_header_capture(client)

        async def tracked_create(*args: Any, **kwargs: Any) -> Any:
            try:
                reserved_output = int(
                    kwargs.get("max_completion_tokens")
                    or kwargs.get("max_tokens")
                    or os.getenv("RAGAS_MAX_COMPLETION_TOKENS", "256")
                )
            except (TypeError, ValueError):
                reserved_output = 256
            estimated_input = estimate_input_tokens(kwargs.get("messages", []))
            reservation = await self._limiter.acquire(
                estimated_input + reserved_output + self._limiter.safety_tokens
            )
            released = False
            key = _usage_key.get()
            metric = _metric_name.get()
            try:
                for attempt in range(1, self._max_retries + 2):
                    started = time.monotonic()
                    try:
                        response = await asyncio.wait_for(
                            original(*args, **kwargs), timeout=self._timeout_seconds
                        )
                        headers = _header_map(response) or _response_headers.get({}) or {}
                        _response_headers.set({})
                        usage = getattr(response, "usage", None)
                        actual_tokens = None
                        if usage is not None:
                            input_tokens = getattr(usage, "prompt_tokens", None)
                            output_tokens = getattr(usage, "completion_tokens", None)
                            actual_tokens = (
                                getattr(usage, "total_tokens", None)
                                or (input_tokens or 0) + (output_tokens or 0)
                            )
                        await self._limiter.observe(
                            headers,
                            status=200,
                            actual_tokens=actual_tokens,
                            reservation=reservation,
                        )
                        self._record(
                            key,
                            {
                                "modelRole": "EVALUATION_JUDGE",
                                "metricName": metric,
                                "provider": self._limiter.provider,
                                "model": kwargs.get("model", "UNKNOWN"),
                                "attempt": attempt,
                                "configuredTimeoutMs": self._timeout_seconds * 1000,
                                "configuredMaxCompletionTokens": reserved_output,
                                "estimatedInputTokens": estimated_input,
                                "reservedOutputTokens": reserved_output,
                                "inputTokens": getattr(usage, "prompt_tokens", None),
                                "outputTokens": getattr(usage, "completion_tokens", None),
                                "totalTokens": getattr(usage, "total_tokens", None),
                                "usageSource": "PROVIDER" if usage else "UNAVAILABLE",
                                "latencyMs": (time.monotonic() - started) * 1000,
                                "providerStatus": 200,
                                "providerCategory": "SUCCESS",
                                "transient": False,
                                "scope": "EVALUATION_JUDGE",
                                "rateLimitHeaders": headers,
                                "rateLimitWaitMs": reservation.wait_ms,
                                "effectiveTpm": self._limiter.max_observed_effective_tpm,
                                "configuredTpmLimit": self._limiter.tpm_limit,
                                "configuredTpmTarget": self._limiter.tpm_target,
                                "configuredConcurrency": self._limiter.concurrency,
                            },
                        )
                        await self._limiter.release(reservation, actual_tokens)
                        released = True
                        return response
                    except Exception as error:
                        status = getattr(error, "status_code", None)
                        headers = _header_map(error) or _response_headers.get({}) or {}
                        _response_headers.set({})
                        category, transient, provider_code = classify_judge_error(status, error)
                        error_text = str(error)
                        delay = retry_after_seconds(headers, error_text)
                        await self._limiter.observe(
                            headers,
                            status=status,
                            actual_tokens=None,
                            reservation=reservation,
                            error_text=error_text,
                            account_limited=category == "ACCOUNT_LIMITED",
                        )
                        provider_status: Any = status
                        if status is None:
                            name = type(error).__name__.lower()
                            provider_status = "TIMEOUT" if "timeout" in name else "NETWORK_ERROR"
                        self._record(
                            key,
                            {
                                "modelRole": "EVALUATION_JUDGE",
                                "metricName": metric,
                                "provider": self._limiter.provider,
                                "model": kwargs.get("model", "UNKNOWN"),
                                "attempt": attempt,
                                "configuredTimeoutMs": self._timeout_seconds * 1000,
                                "configuredMaxCompletionTokens": reserved_output,
                                "estimatedInputTokens": estimated_input,
                                "reservedOutputTokens": reserved_output,
                                "inputTokens": None,
                                "outputTokens": None,
                                "totalTokens": None,
                                "usageSource": "UNAVAILABLE",
                                "latencyMs": (time.monotonic() - started) * 1000,
                                "providerStatus": provider_status,
                                "providerCategory": category,
                                "providerCode": provider_code,
                                "errorCode": provider_code,
                                "transient": transient,
                                "retryAfterMs": delay * 1000 if delay is not None else None,
                                "waitDurationMs": 0,
                                "scope": "EVALUATION_JUDGE",
                                "rateLimitHeaders": headers,
                                "rateLimitWaitMs": reservation.wait_ms,
                                "effectiveTpm": self._limiter.max_observed_effective_tpm,
                                "configuredTpmLimit": self._limiter.tpm_limit,
                                "configuredTpmTarget": self._limiter.tpm_target,
                                "configuredConcurrency": self._limiter.concurrency,
                            },
                        )
                        if not transient or attempt > self._max_retries:
                            await self._limiter.release(reservation)
                            released = True
                            raise
                        waited = await self._limiter.retry_wait(headers, error_text)
                        call = self._calls.get(key or "")
                        if call:
                            call[-1]["waitDurationMs"] = waited * 1000
                raise RuntimeError("judge retry loop exhausted")
            except BaseException:
                # The normal paths release the reservation; this protects cancellation.
                if not released:
                    await self._limiter.release(reservation)
                raise

        client.chat.completions.create = tracked_create

    def _record(self, key: str | None, call: dict[str, Any]) -> None:
        if key:
            self._calls.setdefault(key, []).append(call)

    def begin(self, key: str) -> None:
        _usage_key.set(key)
        self._calls[key] = []

    def set_metric(self, name: str) -> None:
        _metric_name.set(name)

    def take(self, key: str) -> list[dict[str, Any]]:
        _usage_key.set(None)
        _metric_name.set(None)
        return self._calls.pop(key, [])

    def calls_for(self, key: str, metric: str) -> list[dict[str, Any]]:
        return [
            dict(call)
            for call in self._calls.get(key, [])
            if call.get("metricName") == metric
        ]

    def limiter_stats(self) -> dict[str, Any]:
        return self._limiter.stats()
