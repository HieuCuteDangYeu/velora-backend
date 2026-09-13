"""Versioned official Groq pricing snapshot validation."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GROQ_PRICING = ROOT / "config/groq-pricing-v1.json"
DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
DECIMAL_PATTERN = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z")
SUPPORTED_UNCACHED_INPUT_PRICE = Decimal("0.15")


class GroqPricingError(ValueError):
    """The official pricing snapshot is missing, invalid, or stale."""


def parse_decimal(value: Any, *, field: str) -> Decimal:
    if not isinstance(value, str) or not DECIMAL_PATTERN.fullmatch(value):
        raise GroqPricingError(f"{field} must be a plain decimal string")
    try:
        parsed = Decimal(value)
    except InvalidOperation as error:
        raise GroqPricingError(f"{field} is not a valid decimal") from error
    if not parsed.is_finite() or parsed < 0:
        raise GroqPricingError(f"{field} must be a finite non-negative decimal")
    return parsed


def parse_verified_at(value: Any) -> datetime:
    if not isinstance(value, str):
        raise GroqPricingError("pricing verifiedAt is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise GroqPricingError("pricing verifiedAt is invalid") from error
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def load_groq_pricing(
    path: Path | str = DEFAULT_GROQ_PRICING,
    *,
    now: datetime | None = None,
    max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS,
) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise GroqPricingError("Groq pricing snapshot is unreadable") from error
    if not isinstance(payload, dict):
        raise GroqPricingError("Groq pricing snapshot is invalid")
    if payload.get("schemaVersion") != "groq-pricing-v1":
        raise GroqPricingError("Groq pricing snapshot schema is invalid")
    if payload.get("provider") != "groq" or payload.get("model") != "openai/gpt-oss-120b":
        raise GroqPricingError("Groq pricing snapshot model is invalid")
    if payload.get("currency") != "USD" or payload.get("unit") != "per 1M tokens":
        raise GroqPricingError("Groq pricing snapshot units are invalid")
    source = payload.get("officialSource")
    parsed_source = urlparse(source) if isinstance(source, str) else None
    if (
        parsed_source is None
        or parsed_source.scheme != "https"
        or parsed_source.hostname not in {"console.groq.com", "groq.com"}
    ):
        raise GroqPricingError("Groq pricing snapshot source is not official")
    verified_at = parse_verified_at(payload.get("verifiedAt"))
    current = now or datetime.now(UTC)
    age_seconds = (current - verified_at).total_seconds()
    if age_seconds < 0 or age_seconds > max_age_seconds:
        raise GroqPricingError("Groq pricing snapshot is stale or from the future")

    required = {
        "uncachedInputUsdPerMillion",
        "cachedInputUsdPerMillion",
        "outputUsdPerMillion",
        "rateLimitCountedTokenPriceFloorUsdPerMillion",
    }
    if required - payload.keys():
        raise GroqPricingError("Groq pricing snapshot is incomplete")
    prices = {key: parse_decimal(payload[key], field=key) for key in required}
    if prices["uncachedInputUsdPerMillion"] <= 0:
        raise GroqPricingError("uncached input pricing must be positive")
    if prices["uncachedInputUsdPerMillion"] != SUPPORTED_UNCACHED_INPUT_PRICE:
        raise GroqPricingError("uncached input pricing is not the supported official price")
    if prices["cachedInputUsdPerMillion"] >= prices["rateLimitCountedTokenPriceFloorUsdPerMillion"]:
        raise GroqPricingError("cached input pricing must remain below the counted-token floor")
    if prices["outputUsdPerMillion"] < prices["rateLimitCountedTokenPriceFloorUsdPerMillion"]:
        raise GroqPricingError("output pricing cannot be below the counted-token floor")
    if (
        prices["rateLimitCountedTokenPriceFloorUsdPerMillion"]
        != prices["uncachedInputUsdPerMillion"]
    ):
        raise GroqPricingError("counted-token floor must equal uncached input pricing")
    if prices["rateLimitCountedTokenPriceFloorUsdPerMillion"] != SUPPORTED_UNCACHED_INPUT_PRICE:
        raise GroqPricingError("counted-token floor is not the supported official price")
    if payload.get("cachedTokensCountTowardRateLimits") is not False:
        raise GroqPricingError("cached-token rate-limit semantics are missing")
    return payload
