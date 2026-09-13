"""Persistent, content-free Groq daily-token accounting."""

from __future__ import annotations

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
    "status",
    "providerStatus",
    "providerCategory",
    "attempt",
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
            ):
                raise LedgerPersistenceError(
                    f"invalid Groq TPD ledger record at line {line_number}"
                )
            records.append(record)
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
