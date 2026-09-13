"""Conservative decimal arithmetic for Groq organization cost attestations."""

from __future__ import annotations

import hashlib
import os
from datetime import UTC, datetime
from decimal import ROUND_CEILING, Decimal, localcontext
from typing import Any

from rag_eval.groq_pricing import (
    DEFAULT_GROQ_PRICING,
    GroqPricingError,
    load_groq_pricing,
    parse_decimal,
)
from rag_eval.tpd_ledger import (
    GroqDailyTokenLedger,
    LedgerPersistenceError,
    parse_timestamp,
)

COST_ATTESTATION_SCHEMA = "groq-tpd-cost-upper-bound-attestation-v1"
DEFAULT_DAILY_LIMIT_TOKENS = 200_000
DEFAULT_PLANNED_FULL_RUN_TOKENS = 54_048
DEFAULT_MAX_PRICING_AGE_SECONDS = 30 * 24 * 60 * 60
MIN_COST_DECIMAL_PLACES = 7
PRECISION_SOURCES = {
    "groq-console-usage-raw",
    "groq-console-usage-export",
    "groq-console-usage-network-response",
}


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _integer(value: Any, *, minimum: int = 0) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= minimum else None


def _fresh_observation(
    payload: dict[str, Any], now: datetime, max_age_seconds: int
) -> datetime | None:
    observed_at = parse_timestamp(payload.get("observedAt"))
    if observed_at is None:
        return None
    age_seconds = (now - observed_at).total_seconds()
    return observed_at if 0 <= age_seconds <= max_age_seconds else None


def _model_value(payload: dict[str, Any], model: str) -> dict[str, Any] | None:
    if payload.get("model") == model:
        return payload
    models = payload.get("models")
    value = models.get(model) if isinstance(models, dict) else None
    return value if isinstance(value, dict) else None


def _unknown(reason: str) -> dict[str, Any]:
    return {"status": "UNKNOWN", "reason": reason}


def _validate_limit_attestation(
    payload: dict[str, Any],
    *,
    model: str,
    daily_limit: int,
    now: datetime,
    max_age_seconds: int,
) -> bool:
    if (
        payload.get("schemaVersion") != "groq-tpd-limit-attestation-v1"
        or payload.get("provider") != "groq"
        or payload.get("scope") != "TPD_LIMIT"
    ):
        return False
    source = str(payload.get("source", "")).lower()
    if not source or "header" in source or "ratelimit" in source:
        return False
    if _fresh_observation(payload, now, max_age_seconds) is None:
        return False
    value = _model_value(payload, model)
    return value is not None and _integer(value.get("dailyLimitTokens")) == daily_limit


def _max_rate_limited_tokens(cost: Decimal, floor: Decimal) -> int:
    with localcontext() as context:
        context.prec = 60
        return int((cost / floor * Decimal(1_000_000)).to_integral_value(rounding=ROUND_CEILING))


def cost_tpd_headroom(
    payload: dict[str, Any],
    models: tuple[str, ...],
    ledger: GroqDailyTokenLedger,
    *,
    limit_payload: dict[str, Any] | None = None,
    pricing_path: str | None = None,
    now: datetime | None = None,
    max_age_seconds: int = 3_600,
    pricing_max_age_seconds: int | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(UTC)
    if (
        payload.get("schemaVersion") != COST_ATTESTATION_SCHEMA
        or payload.get("provider") != "groq"
        or payload.get("scope") != "TPD"
        or payload.get("source") != "groq-console-organization-usage"
        or payload.get("organizationScope") != "all-projects"
        or len(models) != 1
        or payload.get("model") != models[0]
    ):
        return _unknown("TPD_COST_ATTESTATION_SCOPE_OR_MODEL_INVALID")

    model = models[0]
    observed_at = _fresh_observation(payload, current, max_age_seconds)
    if observed_at is None:
        return _unknown("TPD_COST_ATTESTATION_STALE_OR_INVALID")
    daily_limit = _integer(payload.get("dailyLimitTokens"), minimum=1)
    if daily_limit != DEFAULT_DAILY_LIMIT_TOKENS:
        return _unknown("TPD_COST_ATTESTATION_LIMIT_INVALID")
    if limit_payload is not None and not _validate_limit_attestation(
        limit_payload,
        model=model,
        daily_limit=daily_limit,
        now=current,
        max_age_seconds=max_age_seconds,
    ):
        return _unknown("TPD_LIMIT_ATTESTATION_INVALID_OR_STALE")

    console_delay = _integer(payload.get("consoleMaxReportingDelaySeconds"), minimum=0)
    quiet_period = _integer(payload.get("verifiedQuietPeriodSeconds"), minimum=0)
    if console_delay is None or quiet_period is None:
        return _unknown("TPD_COST_QUIET_PERIOD_PROOF_REQUIRED")
    if quiet_period < console_delay:
        return _unknown("TPD_COST_QUIET_PERIOD_TOO_SHORT")
    quiet_status = payload.get("quietPeriodStatus")
    if quiet_status is not None and quiet_status != "operator-confirmed-no-known-groq-traffic":
        return _unknown("TPD_COST_QUIET_PERIOD_PROOF_REQUIRED")

    cost_text = payload.get("observedOrganizationModelCostUsd")
    try:
        cost = parse_decimal(cost_text, field="observedOrganizationModelCostUsd")
    except GroqPricingError:
        return _unknown("TPD_COST_PRECISION_INVALID")
    fraction = cost_text.partition(".")[2]
    decimal_places = _integer(
        payload.get("costDecimalPlaces", len(fraction)), minimum=MIN_COST_DECIMAL_PLACES
    )
    cost_value_source = payload.get("costValueSource")
    if (
        decimal_places is None
        or len(fraction) < MIN_COST_DECIMAL_PLACES
        or len(fraction) != decimal_places
        or (cost_value_source is not None and cost_value_source not in PRECISION_SOURCES)
    ):
        return _unknown("TPD_COST_PRECISION_PROVENANCE_REQUIRED")

    try:
        pricing = load_groq_pricing(
            pricing_path or DEFAULT_GROQ_PRICING,
            now=current,
            max_age_seconds=pricing_max_age_seconds
            if pricing_max_age_seconds is not None
            else _positive_int(
                "RAGAS_GROQ_PRICING_MAX_AGE_SECONDS", DEFAULT_MAX_PRICING_AGE_SECONDS
            ),
        )
    except (GroqPricingError, TypeError):
        return _unknown("GROQ_PRICING_SNAPSHOT_INVALID_OR_STALE")
    try:
        floor = parse_decimal(
            pricing["rateLimitCountedTokenPriceFloorUsdPerMillion"],
            field="rateLimitCountedTokenPriceFloorUsdPerMillion",
        )
        attested_floor = parse_decimal(
            payload.get("rateLimitedTokenPriceFloorUsdPerMillion"),
            field="rateLimitedTokenPriceFloorUsdPerMillion",
        )
    except GroqPricingError:
        return _unknown("TPD_COST_PRICE_FLOOR_INVALID")
    if attested_floor != floor:
        return _unknown("TPD_COST_PRICE_FLOOR_MISMATCH")

    planned = _integer(payload.get("plannedFullRunTokens"), minimum=1)
    configured_planned = _positive_int(
        "RAGAS_GROQ_TPD_PLANNED_FULL_RUN_TOKENS", DEFAULT_PLANNED_FULL_RUN_TOKENS
    )
    if planned != configured_planned:
        return _unknown("TPD_PLANNED_BUDGET_MISMATCH")

    baseline_used = _max_rate_limited_tokens(cost, floor)
    cost_only_remaining = max(0, daily_limit - baseline_used)
    observed_at_text = observed_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
    fingerprint = hashlib.sha256(cost_text.encode("utf-8")).hexdigest()
    pricing_version = f"{pricing['schemaVersion']}@{pricing['verifiedAt']}"
    try:
        baseline_id = ledger.initialize_baseline(
            provider="groq",
            model=model,
            observed_at=observed_at_text,
            daily_limit_tokens=daily_limit,
            baseline_used_tokens=baseline_used,
            organization_scope=payload["organizationScope"],
            baseline_fingerprint=fingerprint,
            pricing_version=pricing_version,
        )
        ledger_used = ledger.usage_since(model, observed_at, now=current)
    except LedgerPersistenceError:
        return _unknown("TPD_LEDGER_BASELINE_UNAVAILABLE")
    proven_remaining = max(0, cost_only_remaining - ledger_used)
    return {
        "status": "YES" if proven_remaining >= planned else "NO",
        "reason": "COST_DERIVED_TPD_ATTESTATION_EVALUATED",
        "models": [
            {
                "model": model,
                "method": "COST_DERIVED_CONSERVATIVE_UPPER_BOUND",
                "dailyLimitTokens": daily_limit,
                "observedOrganizationModelCostUsd": cost_text,
                "rateLimitedTokenPriceFloorUsdPerMillion": str(floor),
                "maxRateLimitedTokensFromCost": baseline_used,
                "calculatedMinimumRemainingTokens": cost_only_remaining,
                "baselineUsedTokens": baseline_used,
                "ledgerUsedTokens": ledger_used,
                "conservativeUsedTokensUpperBound": baseline_used + ledger_used,
                "minimumProvenRemainingTokens": proven_remaining,
                "plannedFullRunTokens": planned,
                "baselineId": baseline_id,
                "observedAt": observed_at_text,
                "organizationScope": payload["organizationScope"],
                "source": payload["source"],
                "pricingVersion": pricing_version,
                "pricingSource": pricing["officialSource"],
                "consoleMaxReportingDelaySeconds": console_delay,
                "verifiedQuietPeriodSeconds": quiet_period,
                "headroom": proven_remaining >= planned,
            }
        ],
    }
