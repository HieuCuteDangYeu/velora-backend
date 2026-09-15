"""Persistent, content-free Groq daily-token accounting."""

from __future__ import annotations

import hashlib
import json
import math
import os
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - the evaluator runs on Unix hosts
    fcntl = None


DEFAULT_LEDGER_PATH = Path(__file__).resolve().parents[2] / "results" / "groq-tpd-ledger.jsonl"
LEDGER_FIELDS = (
    "recordType",
    "schemaVersion",
    "requestId",
    "timestamp",
    "provider",
    "model",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "estimatedInputTokens",
    "reservedOutputTokens",
    "countedTokens",
    "countingMode",
    "runId",
    "caseId",
    "judgeOperation",
    "callIndex",
    "status",
    "providerStatus",
    "providerCategory",
    "attempt",
    "baselineId",
    "ledgerEpoch",
    "windowDateUtc",
    "baselineUsedTokens",
    "dailyLimitTokens",
    "organizationScope",
    "windowKey",
    "baselineFingerprint",
    "pricingVersion",
    "baselineRefreshOf",
)


class LedgerPersistenceError(RuntimeError):
    """The ledger could not safely record a provider request."""


def ledger_path_from_env() -> Path:
    return Path(os.getenv("RAGAS_GROQ_DAILY_LEDGER_PATH", str(DEFAULT_LEDGER_PATH)))


def utc_timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


class GroqDailyTokenLedger:
    """Append-only ledger with request-ID idempotency across process restarts."""

    def __init__(self, path: Path | str):
        self.path = Path(path)

    @classmethod
    def from_env(cls) -> GroqDailyTokenLedger:
        return cls(ledger_path_from_env())

    @contextmanager
    def _locked(self, mode: str):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle = self.path.open(mode, encoding="utf-8")
        except OSError as error:
            raise LedgerPersistenceError(f"unable to open Groq TPD ledger: {error}") from error
        try:
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            yield handle
        finally:
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def _read_records(self, handle) -> list[dict[str, Any]]:
        handle.seek(0)
        records: list[dict[str, Any]] = []
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise LedgerPersistenceError(
                    f"invalid Groq TPD ledger JSON at line {line_number}"
                ) from error
            if (
                not isinstance(record, dict)
                or not isinstance(record.get("requestId"), str)
                or not record.get("requestId")
                or record.get("provider") != "groq"
                or not isinstance(record.get("model"), str)
                or not record.get("model")
                or not isinstance(record.get("timestamp"), str)
                or not isinstance(record.get("countedTokens"), int)
                or isinstance(record.get("countedTokens"), bool)
                or record.get("countedTokens") < 0
                or record.get("recordType", "REQUEST") not in {"REQUEST", "BASELINE"}
            ):
                raise LedgerPersistenceError(
                    f"invalid Groq TPD ledger record at line {line_number}"
                )
            records.append(record)
            if record.get("recordType", "REQUEST") == "BASELINE" and (
                not isinstance(record.get("baselineId"), str)
                or not record.get("baselineId")
                or not isinstance(record.get("ledgerEpoch"), str)
                or not record.get("ledgerEpoch")
                or (
                    record.get("baselineRefreshOf") is None
                    and record.get("ledgerEpoch") != record.get("baselineId")
                )
                or (
                    record.get("baselineRefreshOf") is not None
                    and (
                        not isinstance(record.get("baselineRefreshOf"), str)
                        or not record.get("baselineRefreshOf")
                    )
                )
                or not isinstance(record.get("baselineUsedTokens"), int)
                or isinstance(record.get("baselineUsedTokens"), bool)
                or record.get("baselineUsedTokens") < 0
                or not isinstance(record.get("dailyLimitTokens"), int)
                or isinstance(record.get("dailyLimitTokens"), bool)
                or record.get("dailyLimitTokens") <= 0
                or not isinstance(record.get("organizationScope"), str)
                or not record.get("organizationScope")
                or not isinstance(record.get("windowKey"), str)
                or not record.get("windowKey")
            ):
                raise LedgerPersistenceError(
                    f"invalid Groq TPD baseline record at line {line_number}"
                )
        return records

    def record(self, record: dict[str, Any]) -> str:
        """Persist one provider attempt; repeated request IDs are no-ops."""

        request_id = record.get("requestId")
        counted_tokens = record.get("countedTokens")
        if not isinstance(request_id, str) or not request_id:
            raise LedgerPersistenceError("Groq TPD ledger request ID is missing")
        if (
            not isinstance(counted_tokens, int)
            or isinstance(counted_tokens, bool)
            or counted_tokens < 0
        ):
            raise LedgerPersistenceError("Groq TPD ledger counted tokens are invalid")
        if (
            not isinstance(record.get("timestamp"), str)
            or parse_timestamp(record["timestamp"]) is None
            or not isinstance(record.get("model"), str)
            or not record["model"]
        ):
            raise LedgerPersistenceError("Groq TPD ledger request metadata is invalid")

        safe_record = {
            key: record[key]
            for key in LEDGER_FIELDS
            if key in record and isinstance(record[key], (str, int, float, type(None)))
        }
        safe_record.setdefault("schemaVersion", "groq-tpd-ledger-record-v1")
        safe_record["recordType"] = "REQUEST"
        safe_record["provider"] = "groq"
        safe_record["requestId"] = request_id
        safe_record["countedTokens"] = counted_tokens
        for key, value in safe_record.items():
            if isinstance(value, float) and not math.isfinite(value):
                raise LedgerPersistenceError(f"Groq TPD ledger field {key} is invalid")
        try:
            with self._locked("a+") as handle:
                records = self._read_records(handle)
                if any(item.get("requestId") == request_id for item in records):
                    return request_id
                handle.seek(0, 2)
                handle.write(json.dumps(safe_record, sort_keys=True) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except LedgerPersistenceError:
            raise
        except OSError as error:
            raise LedgerPersistenceError(f"unable to write Groq TPD ledger: {error}") from error
        return request_id

    def initialize_baseline(
        self,
        *,
        provider: str,
        model: str,
        observed_at: str,
        daily_limit_tokens: int,
        baseline_used_tokens: int,
        organization_scope: str,
        window_key: str,
        baseline_fingerprint: str,
        pricing_version: str,
        allow_refresh: bool = False,
    ) -> str:
        """Persist one immutable quota baseline without counting it as a request."""

        if provider != "groq" or not model or not organization_scope or not window_key:
            raise LedgerPersistenceError("Groq TPD baseline identity is invalid")
        observed = parse_timestamp(observed_at)
        if observed is None:
            raise LedgerPersistenceError("Groq TPD baseline timestamp is invalid")
        window_date_utc = observed.astimezone(UTC).date().isoformat()
        if (
            not isinstance(daily_limit_tokens, int)
            or isinstance(daily_limit_tokens, bool)
            or daily_limit_tokens <= 0
            or not isinstance(baseline_used_tokens, int)
            or isinstance(baseline_used_tokens, bool)
            or baseline_used_tokens < 0
        ):
            raise LedgerPersistenceError("Groq TPD baseline token values are invalid")
        if not isinstance(baseline_fingerprint, str) or not baseline_fingerprint:
            raise LedgerPersistenceError("Groq TPD baseline fingerprint is missing")
        if not isinstance(pricing_version, str) or not pricing_version:
            raise LedgerPersistenceError("Groq TPD baseline pricing version is missing")
        identity = "\x1f".join(
            (
                provider,
                model,
                observed_at,
                organization_scope,
                str(daily_limit_tokens),
                str(baseline_used_tokens),
                baseline_fingerprint,
                pricing_version,
                window_key,
            )
        )
        baseline_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        baseline = {
            "recordType": "BASELINE",
            "schemaVersion": "groq-tpd-ledger-baseline-v1",
            "requestId": baseline_id,
            "baselineId": baseline_id,
            "ledgerEpoch": baseline_id,
            "timestamp": observed_at,
            "provider": provider,
            "model": model,
            "countedTokens": 0,
            "windowDateUtc": window_date_utc,
            "baselineUsedTokens": baseline_used_tokens,
            "dailyLimitTokens": daily_limit_tokens,
            "organizationScope": organization_scope,
            "windowKey": window_key,
            "baselineFingerprint": baseline_fingerprint,
            "pricingVersion": pricing_version,
        }
        try:
            with self._locked("a+") as handle:
                records = self._read_records(handle)
                matching = []
                for item in records:
                    item_timestamp = parse_timestamp(item.get("timestamp"))
                    item_window_date = item.get("windowDateUtc")
                    if item_window_date is None and item_timestamp is not None:
                        item_window_date = item_timestamp.astimezone(UTC).date().isoformat()
                    if (
                        item.get("recordType", "REQUEST") == "BASELINE"
                        and item.get("provider") == provider
                        and item.get("model") == model
                        and item.get("organizationScope") == organization_scope
                        and item_window_date == window_date_utc
                    ):
                        matching.append(item)
                if matching:
                    same_baseline = next(
                        (item for item in matching if item.get("baselineId") == baseline_id),
                        None,
                    )
                    if same_baseline is not None and all(
                        same_baseline.get(key) == baseline[key]
                        for key in (
                            "timestamp",
                            "model",
                            "baselineUsedTokens",
                            "dailyLimitTokens",
                            "organizationScope",
                            "windowKey",
                            "baselineFingerprint",
                            "pricingVersion",
                        )
                    ):
                        return baseline_id
                    if not allow_refresh:
                        raise LedgerPersistenceError(
                            "conflicting Groq TPD baseline already exists for model/window"
                        )
                    baseline["baselineRefreshOf"] = matching[-1].get("baselineId")
                    baseline["ledgerEpoch"] = self._baseline_root_epoch(records, matching[-1])
                handle.seek(0, 2)
                handle.write(json.dumps(baseline, sort_keys=True) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except LedgerPersistenceError:
            raise
        except OSError as error:
            raise LedgerPersistenceError(f"unable to write Groq TPD baseline: {error}") from error
        return baseline_id

    @staticmethod
    def _baseline_root_epoch(
        records: list[dict[str, Any]], baseline: dict[str, Any]
    ) -> str:
        by_id = {
            record.get("baselineId"): record
            for record in records
            if record.get("recordType", "REQUEST") == "BASELINE"
        }
        current = baseline
        seen: set[str] = set()
        while (
            isinstance(current.get("baselineRefreshOf"), str)
            and current.get("baselineRefreshOf") not in seen
        ):
            seen.add(str(current["baselineId"]))
            parent = by_id.get(current["baselineRefreshOf"])
            if parent is None:
                break
            current = parent
        return str(current.get("ledgerEpoch") or current.get("baselineId"))

    def usage_since(
        self,
        model: str,
        window_started_at: datetime,
        *,
        now: datetime | None = None,
    ) -> int:
        """Return counted usage for one model in an attested window."""

        if not self.path.exists():
            return 0
        current = now or datetime.now(UTC)
        try:
            with self._locked("r") as handle:
                records = self._read_records(handle)
        except LedgerPersistenceError:
            raise
        except OSError as error:
            raise LedgerPersistenceError(f"unable to read Groq TPD ledger: {error}") from error

        seen: set[str] = set()
        total = 0
        for record in records:
            request_id = record.get("requestId")
            if request_id in seen:
                continue
            seen.add(request_id)
            if record.get("recordType", "REQUEST") != "REQUEST":
                continue
            if record.get("provider") != "groq" or record.get("model") != model:
                continue
            timestamp = parse_timestamp(record.get("timestamp"))
            if timestamp is None:
                raise LedgerPersistenceError("Groq TPD ledger contains an invalid timestamp")
            if timestamp < window_started_at:
                continue
            if timestamp > current:
                # Count future-dated records conservatively rather than resetting or ignoring them.
                total += int(record.get("countedTokens", 0))
                continue
            total += int(record.get("countedTokens", 0))
        return total


    def request(self, request_id: str) -> dict[str, Any] | None:
        """Return one persisted request record by ID without exposing content."""

        if not self.path.exists():
            return None
        with self._locked("r") as handle:
            for record in self._read_records(handle):
                if (
                    record.get("recordType", "REQUEST") == "REQUEST"
                    and record.get("requestId") == request_id
                ):
                    return dict(record)
        return None

    def latest_baseline(
        self,
        *,
        provider: str,
        model: str,
        organization_scope: str,
        window_key: str,
    ) -> dict[str, Any] | None:
        """Return the newest baseline observation for one daily query window."""

        if not self.path.exists():
            return None
        with self._locked("r") as handle:
            records = self._read_records(handle)
        matches = [
            record
            for record in records
            if (
                record.get("recordType", "REQUEST") == "BASELINE"
                and record.get("provider") == provider
                and record.get("model") == model
                and record.get("organizationScope") == organization_scope
                and record.get("windowKey") == window_key
            )
        ]
        if not matches:
            return None
        latest = dict(matches[-1])
        latest["ledgerEpoch"] = self._baseline_root_epoch(records, latest)
        return latest

    def usage_between(
        self,
        model: str,
        started_at: datetime,
        ended_at: datetime,
        *,
        include_start: bool = False,
        include_end: bool = True,
    ) -> int:
        """Count idempotent request usage in an explicit bounded interval."""

        if ended_at < started_at:
            raise LedgerPersistenceError("Groq TPD ledger interval is invalid")
        if not self.path.exists():
            return 0
        with self._locked("r") as handle:
            records = self._read_records(handle)
        seen: set[str] = set()
        total = 0
        for record in records:
            request_id = record.get("requestId")
            if request_id in seen:
                continue
            seen.add(request_id)
            if (
                record.get("recordType", "REQUEST") != "REQUEST"
                or record.get("provider") != "groq"
                or record.get("model") != model
            ):
                continue
            timestamp = parse_timestamp(record.get("timestamp"))
            if timestamp is None:
                raise LedgerPersistenceError("Groq TPD ledger contains an invalid timestamp")
            after_start = timestamp >= started_at if include_start else timestamp > started_at
            before_end = timestamp <= ended_at if include_end else timestamp < ended_at
            if after_start and before_end:
                total += int(record.get("countedTokens", 0))
        return total

    def usage_for_epoch(self, model: str, ledger_epoch: str) -> int:
        """Count only requests explicitly bound to one immutable quota epoch."""

        if not self.path.exists():
            return 0
        with self._locked("r") as handle:
            records = self._read_records(handle)
        seen: set[str] = set()
        total = 0
        for record in records:
            request_id = record.get("requestId")
            if request_id in seen:
                continue
            seen.add(request_id)
            if (
                record.get("recordType", "REQUEST") != "REQUEST"
                or record.get("provider") != "groq"
                or record.get("model") != model
                or record.get("ledgerEpoch") != ledger_epoch
            ):
                continue
            total += int(record.get("countedTokens", 0))
        return total

    def new_request_id(self) -> str:
        return str(uuid.uuid4())

    def deterministic_request_id(
        self,
        *,
        run_id: str | None,
        case_id: str | None,
        metric: str | None,
        model: str,
        attempt: int,
    ) -> str:
        """Return a stable fallback ID when the provider supplies no request ID."""

        material = "\x1f".join(
            (
                run_id or "",
                case_id or "",
                metric or "",
                model,
                str(attempt),
            )
        )
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"velora-groq-tpd:{material}"))
