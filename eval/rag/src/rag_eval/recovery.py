"""Evaluator-only multi-day semantic recovery state and daily TPD planning."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from rag_eval.tpd_ledger import GroqDailyTokenLedger, parse_timestamp

RECOVERY_SCHEMA = "ragas-multiday-recovery-v1"
WAITING_FOR_NEXT_TPD_WINDOW = "WAITING_FOR_NEXT_TPD_WINDOW"
INSUFFICIENT_TPD_FOR_NEXT_OPERATION = "INSUFFICIENT_TPD_FOR_NEXT_OPERATION"
MIDNIGHT_IN_FLIGHT_REQUESTS_PENDING = "MIDNIGHT_IN_FLIGHT_REQUESTS_PENDING"
DEFAULT_DAILY_SAFETY_MARGIN_TOKENS = 10_000
DEFAULT_OPERATION_RESERVATION_TOKENS = 8_000
DEFAULT_TOTAL_RECOVERY_ESTIMATE_TOKENS = 231_125
DEFAULT_TPD_BASELINE_MAX_AGE_SECONDS = 3_600
ACCEPTED_BASELINE_METHODS = {
    "EXACT_TOKEN_USAGE_BASELINE",
    "EMPTY_CURRENT_WINDOW_VERIFIED",
}

AUTHORIZED_DATASET_VERSION = "rag-frozen-ami-v3"
AUTHORIZED_DATASET_SHA256 = "856e34483522da55e8d09cf0ab542b29add224f49572ae98f363a9db2520d391"
AUTHORIZED_SOURCE_RUN_ID = "production-rag-frozen-ami-v3-a27fb356-20260912-02"
AUTHORIZED_PRODUCTION_SHA = "a27fb35680d685321d2d408e17fc96d8bbe2b6b6"
AUTHORIZED_JUDGE_PROVIDER = "groq"
AUTHORIZED_JUDGE_MODEL = "openai/gpt-oss-120b"


class DailyRecoveryDeferred(RuntimeError):
    """The active UTC epoch cannot safely dispatch another judge request."""


class RecoveryStateError(RuntimeError):
    """Persisted recovery state does not match the authorized semantic lineage."""


@dataclass(frozen=True)
class RecoveryOperation:
    case_id: str
    metric_name: str
    reservation_tokens: int
    status: str = "UNAVAILABLE"

    def __post_init__(self) -> None:
        if (
            not isinstance(self.case_id, str)
            or not self.case_id
            or not isinstance(self.metric_name, str)
            or not self.metric_name
            or isinstance(self.reservation_tokens, bool)
            or not isinstance(self.reservation_tokens, int)
            or self.reservation_tokens <= 0
            or self.status not in {"COMPLETE", "UNAVAILABLE", "NOT_EVALUATED"}
        ):
            raise RecoveryStateError("multi-day recovery operation is invalid")

    @property
    def key(self) -> str:
        return f"{self.case_id}::{self.metric_name}"


def _env_nonnegative_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(0, value)


def daily_safety_margin_tokens() -> int:
    return _env_nonnegative_int(
        "RAGAS_MULTI_DAY_DAILY_SAFETY_MARGIN_TOKENS",
        DEFAULT_DAILY_SAFETY_MARGIN_TOKENS,
    )


def tpd_baseline_max_age_seconds() -> int:
    return _env_nonnegative_int(
        "RAGAS_GROQ_TPD_ATTESTATION_MAX_AGE_SECONDS",
        DEFAULT_TPD_BASELINE_MAX_AGE_SECONDS,
    )


def planned_operation_reservation_tokens() -> int:
    """Return the planning fallback; actual requests are re-estimated before dispatch."""

    configured = _env_nonnegative_int(
        "RAGAS_MULTI_DAY_OPERATION_RESERVATION_TOKENS",
        _env_nonnegative_int("RAGAS_GROQ_TPM_LIMIT", DEFAULT_OPERATION_RESERVATION_TOKENS),
    )
    return max(1, configured)


def _utc_date(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).astimezone(UTC).date().isoformat()


def _utc_timestamp(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).astimezone(UTC).isoformat().replace("+00:00", "Z")


def _canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def validate_authorized_recovery_identity(identity: dict[str, Any]) -> None:
    expected = {
        "datasetVersion": AUTHORIZED_DATASET_VERSION,
        "datasetSha256": AUTHORIZED_DATASET_SHA256,
        "sourceRunId": AUTHORIZED_SOURCE_RUN_ID,
        "productionSha": AUTHORIZED_PRODUCTION_SHA,
        "judgeProvider": AUTHORIZED_JUDGE_PROVIDER,
        "judgeModel": AUTHORIZED_JUDGE_MODEL,
    }
    mismatched = [key for key, value in expected.items() if identity.get(key) != value]
    if mismatched:
        raise RecoveryStateError(
            "multi-day recovery authorization identity mismatch: " + ",".join(sorted(mismatched))
        )
    for key in ("sourceProvenanceFingerprint", "semanticContextBindingSha256"):
        value = identity.get(key)
        if not isinstance(value, str) or len(value) != 64:
            raise RecoveryStateError(f"multi-day recovery {key} is missing")


def source_provenance_fingerprint(executions: dict[str, Any]) -> str:
    """Bind one recovery lineage to exact source execution and RagTrace IDs."""

    rows = []
    for case_id in sorted(executions):
        trace = executions[case_id].trace
        execution_id = trace.get("productionExecutionId")
        trace_id = trace.get("ragTraceId")
        if not execution_id or not trace_id:
            raise RecoveryStateError("semantic recovery source provenance is incomplete")
        rows.append(
            {
                "caseId": case_id,
                "sourceExecutionId": execution_id,
                "ragTraceId": trace_id,
            }
        )
    return _canonical_hash(rows)


def _historical_reservation(entry: dict[str, Any] | None, fallback: int) -> int:
    if not entry:
        return fallback
    observed: list[int] = []
    for call in entry.get("calls") or []:
        if not isinstance(call, dict):
            continue
        direct = call.get("reservationTokens")
        if isinstance(direct, int) and direct > 0:
            observed.append(direct)
            continue
        estimated = call.get("estimatedInputTokens")
        output = call.get("reservedOutputTokens")
        if (
            isinstance(estimated, int)
            and estimated >= 0
            and isinstance(output, int)
            and output >= 0
        ):
            safety = _env_nonnegative_int("RAGAS_TOKEN_ESTIMATE_SAFETY_TOKENS", 256)
            observed.append(estimated + output + safety)
    return max(observed, default=fallback)


def recovery_operations(
    case_ids: Iterable[str],
    metric_names: Iterable[str],
    checkpoint_entries: Iterable[dict[str, Any]],
    *,
    reservation_tokens: int | None = None,
) -> list[RecoveryOperation]:
    """Return deterministic unresolved case/metric operations only."""

    fallback = reservation_tokens or planned_operation_reservation_tokens()
    by_key = {
        f"{entry.get('caseId')}::{entry.get('metricName')}": entry
        for entry in checkpoint_entries
    }
    output: list[RecoveryOperation] = []
    for case_id in sorted(case_ids):
        for metric_name in metric_names:
            key = f"{case_id}::{metric_name}"
            entry = by_key.get(key)
            status = str(entry.get("status")) if entry else "NOT_EVALUATED"
            if status == "COMPLETE":
                continue
            if status not in {"UNAVAILABLE", "NOT_EVALUATED"}:
                raise RecoveryStateError(
                    f"multi-day recovery refuses unsupported checkpoint status: {status}"
                )
            output.append(
                RecoveryOperation(
                    case_id=case_id,
                    metric_name=metric_name,
                    reservation_tokens=_historical_reservation(entry, max(1, fallback)),
                    status=status,
                )
            )
    return output


def mandatory_metrics_complete(
    checkpoint_entries: Iterable[dict[str, Any]], total_operations: int
) -> bool:
    """Return true only when every mandatory case/metric operation is immutable COMPLETE."""

    entries = list(checkpoint_entries)
    keys = [
        (entry.get("caseId"), entry.get("metricName"))
        for entry in entries
    ]
    keyed_entries = [key for key in keys if key != (None, None)]
    unique_keys = (
        len(keyed_entries) == len(set(keyed_entries))
        if keyed_entries
        else True
    )
    return (
        len(entries) == total_operations
        and unique_keys
        and all(entry.get("status") == "COMPLETE" for entry in entries)
    )


def schedule_safe_slice(
    operations: Iterable[RecoveryOperation],
    *,
    remaining_tokens: int,
    safety_margin_tokens: int,
) -> dict[str, Any]:
    """Schedule a prefix that leaves the configured daily safety margin intact."""

    scheduled: list[RecoveryOperation] = []
    reservation = 0
    deferred: list[RecoveryOperation] = []
    stop = False
    for operation in operations:
        if operation.status == "COMPLETE":
            continue
        required = operation.reservation_tokens + safety_margin_tokens
        if stop or remaining_tokens - reservation < required:
            stop = True
            deferred.append(operation)
            continue
        scheduled.append(operation)
        reservation += operation.reservation_tokens
    return {
        "scheduled": scheduled,
        "deferred": deferred,
        "scheduledReservationTokens": reservation,
        "remainingAfterReservationTokens": max(0, remaining_tokens - reservation),
        "waiting": bool(deferred),
        "stopReason": INSUFFICIENT_TPD_FOR_NEXT_OPERATION if deferred else None,
    }


def multiday_tpd_preflight(
    tpd: dict[str, Any],
    operations: Iterable[RecoveryOperation],
    *,
    now: datetime | None = None,
    safety_margin_tokens: int | None = None,
    total_recovery_estimate_tokens: int = DEFAULT_TOTAL_RECOVERY_ESTIMATE_TOKENS,
) -> dict[str, Any]:
    """Accept a safe daily slice even when the whole recovery exceeds one TPD window."""

    current = now or datetime.now(UTC)
    if tpd.get("reason") == "PROVIDER_DAILY_QUOTA_ERROR":
        return {"status": "NO", "reason": "PROVIDER_DAILY_QUOTA_ERROR"}
    models = tpd.get("models")
    detail = models[0] if isinstance(models, list) and len(models) == 1 else None
    if not isinstance(detail, dict):
        return {"status": "UNKNOWN", "reason": "MULTI_DAY_TPD_BASELINE_REQUIRED"}
    if detail.get("method") not in ACCEPTED_BASELINE_METHODS:
        return {"status": "UNKNOWN", "reason": "MULTI_DAY_EXACT_TPD_BASELINE_REQUIRED"}
    if detail.get("model") != AUTHORIZED_JUDGE_MODEL:
        return {"status": "UNKNOWN", "reason": "MULTI_DAY_TPD_MODEL_INVALID"}
    if detail.get("dailyLimitTokens") != 200_000:
        return {"status": "UNKNOWN", "reason": "MULTI_DAY_TPD_LIMIT_INVALID"}
    if detail.get("source") not in {
        "groq-console-organization-usage-api",
        "operator-observed-fresh-window",
    }:
        return {"status": "UNKNOWN", "reason": "MULTI_DAY_TPD_SOURCE_INVALID"}
    if detail.get("windowDateUtc") != _utc_date(current):
        return {"status": "UNKNOWN", "reason": "MULTI_DAY_TPD_BASELINE_DATE_INVALID"}
    observed = parse_timestamp(detail.get("observedAt"))
    if (
        observed is None
        or observed > current
        or observed.astimezone(UTC).date() != current.astimezone(UTC).date()
        or (current - observed).total_seconds() > tpd_baseline_max_age_seconds()
    ):
        return {"status": "UNKNOWN", "reason": "MULTI_DAY_TPD_BASELINE_STALE"}
    required = (
        "model",
        "dailyLimitTokens",
        "baselineUsedTokens",
        "baselineId",
        "baselineFingerprint",
        "source",
    )
    if any(detail.get(field) is None for field in required):
        return {"status": "UNKNOWN", "reason": "MULTI_DAY_TPD_BASELINE_INCOMPLETE"}
    remaining_value = detail.get(
        "epochMinimumProvenRemainingTokens", detail.get("minimumProvenRemainingTokens")
    )
    if (
        isinstance(remaining_value, bool)
        or not isinstance(remaining_value, int)
        or remaining_value < 0
    ):
        return {"status": "UNKNOWN", "reason": "MULTI_DAY_TPD_REMAINING_INVALID"}
    if remaining_value > detail["dailyLimitTokens"]:
        return {"status": "UNKNOWN", "reason": "MULTI_DAY_TPD_REMAINING_INVALID"}
    margin = daily_safety_margin_tokens() if safety_margin_tokens is None else max(
        0, safety_margin_tokens
    )
    planned = schedule_safe_slice(
        operations,
        remaining_tokens=remaining_value,
        safety_margin_tokens=margin,
    )
    return {
        "status": "YES" if planned["scheduled"] or not planned["deferred"] else "WAITING",
        "reason": "MULTI_DAY_TPD_SLICE_EVALUATED",
        "windowDateUtc": detail["windowDateUtc"],
        "totalRecoveryEstimateTokens": total_recovery_estimate_tokens,
        "currentDaySafeBudgetTokens": max(0, remaining_value - margin),
        "dailySafetyMarginTokens": margin,
        "scheduledReservationTokens": planned["scheduledReservationTokens"],
        "currentDayRemainingAfterReservationTokens": planned["remainingAfterReservationTokens"],
        "remainingRecoveryEstimateTokens": max(
            0, total_recovery_estimate_tokens - planned["scheduledReservationTokens"]
        ),
        "scheduledOperationKeys": [item.key for item in planned["scheduled"]],
        "deferredOperationKeys": [item.key for item in planned["deferred"]],
        "waitingForNextTpdWindow": planned["waiting"],
        "dailyRecoveryStopReason": planned["stopReason"],
        "baseline": detail,
    }


class MultiDayRecoveryStore:
    """Atomic run-scoped recovery state with immutable UTC-day epochs."""

    def __init__(
        self,
        path: str | Path,
        identity: dict[str, Any],
        *,
        checkpoint_id: str,
    ):
        self.path = Path(path)
        self.identity = dict(identity)
        validate_authorized_recovery_identity(self.identity)
        self.checkpoint_id = checkpoint_id
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._state = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            state = {
                "schemaVersion": RECOVERY_SCHEMA,
                "identity": self.identity,
                "checkpointId": self.checkpoint_id,
                "authorization": {"status": "UNCONSUMED", "consumedAt": None},
                "status": "READY",
                "dailyRecoveryStopReason": None,
                "epochs": [],
                "requests": {},
            }
            self._write(state)
            return state
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RecoveryStateError("multi-day recovery state is unreadable") from error
        if (
            state.get("schemaVersion") != RECOVERY_SCHEMA
            or state.get("identity") != self.identity
            or state.get("checkpointId") != self.checkpoint_id
            or not isinstance(state.get("epochs"), list)
            or not isinstance(state.get("requests"), dict)
        ):
            raise RecoveryStateError("multi-day recovery lineage mismatch")
        authorization = state.get("authorization")
        if not isinstance(authorization, dict) or authorization.get("status") not in {
            "UNCONSUMED",
            "CONSUMED",
        }:
            raise RecoveryStateError("multi-day recovery authorization state is invalid")
        return state

    def _write(self, state: dict[str, Any] | None = None) -> None:
        value = state if state is not None else self._state
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)

    @property
    def authorization_status(self) -> str:
        return str(self._state["authorization"]["status"])

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._state))

    def _active_epoch_unlocked(self) -> dict[str, Any] | None:
        for epoch in reversed(self._state["epochs"]):
            if epoch.get("closedAt") is None:
                return epoch
        return None

    def active_epoch(self) -> dict[str, Any] | None:
        with self._lock:
            epoch = self._active_epoch_unlocked()
            return json.loads(json.dumps(epoch)) if epoch else None

    def epochs(self) -> list[dict[str, Any]]:
        with self._lock:
            return json.loads(json.dumps(self._state["epochs"]))

    def _close_epoch_unlocked(
        self, epoch: dict[str, Any], reason: str, now: datetime | None = None
    ) -> None:
        if epoch.get("closedAt") is not None:
            return
        if int(epoch.get("reservedPendingTokens", 0)) > 0:
            raise RecoveryStateError("cannot close a TPD epoch with in-flight requests")
        epoch["closedAt"] = _utc_timestamp(now)
        epoch["closeReason"] = reason

    def begin_epoch(
        self, baseline: dict[str, Any], *, now: datetime | None = None
    ) -> dict[str, Any]:
        current = now or datetime.now(UTC)
        date = _utc_date(current)
        if self._state.get("status") == "COMPLETE":
            raise RecoveryStateError("completed multi-day recovery lineage cannot be resumed")
        if (
            baseline.get("windowDateUtc") != date
            or baseline.get("method") not in ACCEPTED_BASELINE_METHODS
            or baseline.get("model") != self.identity.get("judgeModel")
        ):
            raise RecoveryStateError("fresh current-day exact TPD baseline is required")
        baseline_id = baseline.get("baselineId")
        fingerprint = baseline.get("baselineFingerprint")
        observed_at = baseline.get("observedAt")
        observed = parse_timestamp(observed_at)
        if (
            not baseline_id
            or not fingerprint
            or observed is None
            or observed.astimezone(UTC).date().isoformat() != date
        ):
            raise RecoveryStateError("TPD baseline identity is incomplete or stale")
        with self._lock:
            active = self._active_epoch_unlocked()
            if active and active["windowDateUtc"] == date:
                if (
                    active["ledgerEpoch"] != baseline_id
                    or active["baselineFingerprint"] != fingerprint
                    or active["baselineObservedAt"] != observed_at
                ):
                    raise RecoveryStateError("current UTC epoch baseline cannot be replaced")
                self._state["status"] = "RUNNING"
                self._state["dailyRecoveryStopReason"] = None
                self._write()
                return dict(active)
            if active:
                if int(active.get("reservedPendingTokens", 0)) > 0:
                    self._state["status"] = WAITING_FOR_NEXT_TPD_WINDOW
                    self._state["dailyRecoveryStopReason"] = MIDNIGHT_IN_FLIGHT_REQUESTS_PENDING
                    self._write()
                    raise DailyRecoveryDeferred(WAITING_FOR_NEXT_TPD_WINDOW)
                self._close_epoch_unlocked(active, "UTC_WINDOW_ROLLOVER", current)
            if any(epoch.get("windowDateUtc") == date for epoch in self._state["epochs"]):
                raise RecoveryStateError("closed UTC epoch cannot be reopened or replaced")
            epoch_ledger_used = int(
                baseline.get("epochLedgerUsedTokens", baseline.get("ledgerUsedTokens", 0))
            )
            remaining = int(
                baseline.get(
                    "epochMinimumProvenRemainingTokens",
                    baseline.get("minimumProvenRemainingTokens", 0),
                )
            )
            epoch = {
                "windowDateUtc": date,
                "provider": "groq",
                "model": baseline["model"],
                "dailyLimitTokens": int(baseline["dailyLimitTokens"]),
                "baselineSource": baseline["source"],
                "baselineObservedAt": observed_at,
                "baselineCountedUsedTokens": int(baseline["baselineUsedTokens"]),
                "baselineFingerprint": fingerprint,
                "ledgerEpoch": baseline_id,
                "initialLedgerUsedTokens": epoch_ledger_used,
                "evaluatorCountedTokens": epoch_ledger_used,
                "reservedPendingTokens": 0,
                "calculatedRemainingTokens": remaining,
                "firstJudgeRequestAt": None,
                "lastJudgeRequestAt": None,
                "closedAt": None,
                "closeReason": None,
                "scheduledOperationKeys": [],
                "deferredOperationKeys": [],
                "scheduledReservationTokens": 0,
                "totalRecoveryEstimateTokens": DEFAULT_TOTAL_RECOVERY_ESTIMATE_TOKENS,
            }
            self._state["epochs"].append(epoch)
            self._state["status"] = "RUNNING"
            self._state["dailyRecoveryStopReason"] = None
            self._write()
            return dict(epoch)

    def set_daily_plan(
        self,
        *,
        scheduled_operation_keys: Iterable[str],
        deferred_operation_keys: Iterable[str],
        scheduled_reservation_tokens: int,
        total_recovery_estimate_tokens: int = DEFAULT_TOTAL_RECOVERY_ESTIMATE_TOKENS,
    ) -> None:
        scheduled = list(scheduled_operation_keys)
        deferred = list(deferred_operation_keys)
        if len(scheduled) != len(set(scheduled)) or len(deferred) != len(set(deferred)):
            raise RecoveryStateError("daily recovery plan contains duplicate operations")
        if set(scheduled) & set(deferred):
            raise RecoveryStateError("daily recovery plan overlaps scheduled and deferred work")
        with self._lock:
            epoch = self._active_epoch_unlocked()
            if epoch is None:
                raise RecoveryStateError("daily recovery plan requires an active epoch")
            existing_scheduled = epoch.get("scheduledOperationKeys") or []
            existing_deferred = epoch.get("deferredOperationKeys") or []
            if existing_scheduled or existing_deferred:
                if not (
                    set(scheduled).issubset(set(existing_scheduled))
                    and set(deferred).issubset(set(existing_deferred))
                ):
                    raise RecoveryStateError("current UTC epoch recovery plan cannot be replaced")
                return
            epoch["scheduledOperationKeys"] = scheduled
            epoch["deferredOperationKeys"] = deferred
            epoch["scheduledReservationTokens"] = int(scheduled_reservation_tokens)
            epoch["totalRecoveryEstimateTokens"] = int(total_recovery_estimate_tokens)
            self._write()

    def close_current(self, reason: str, *, now: datetime | None = None) -> bool:
        with self._lock:
            active = self._active_epoch_unlocked()
            if active and int(active.get("reservedPendingTokens", 0)) > 0:
                self._state["status"] = WAITING_FOR_NEXT_TPD_WINDOW
                self._state["dailyRecoveryStopReason"] = reason
                self._write()
                return False
            if active:
                self._close_epoch_unlocked(active, reason, now)
            self._state["status"] = WAITING_FOR_NEXT_TPD_WINDOW
            self._state["dailyRecoveryStopReason"] = reason
            self._write()
            return True

    def complete(self, *, now: datetime | None = None) -> None:
        with self._lock:
            pending = [
                value
                for value in self._state["requests"].values()
                if value.get("status") == "DISPATCHED"
            ]
            if pending:
                raise RecoveryStateError("cannot complete recovery with pending judge requests")
            active = self._active_epoch_unlocked()
            if active:
                self._close_epoch_unlocked(active, "RECOVERY_COMPLETE", now)
            self._state["status"] = "COMPLETE"
            self._state["dailyRecoveryStopReason"] = None
            self._write()

    def _request_key(self, case_id: str | None, metric: str | None, attempt: int, date: str) -> str:
        return "\x1f".join((date, case_id or "", metric or "", str(attempt)))

    def _ensure_capacity_unlocked(
        self,
        *,
        case_id: str | None,
        metric: str | None,
        attempt: int,
        reservation_tokens: int,
        safety_margin_tokens: int,
        current: datetime,
    ) -> str:
        date = _utc_date(current)
        epoch = self._active_epoch_unlocked()
        if epoch is None:
            raise DailyRecoveryDeferred(WAITING_FOR_NEXT_TPD_WINDOW)
        if epoch["windowDateUtc"] != date:
            if int(epoch.get("reservedPendingTokens", 0)) == 0:
                self._close_epoch_unlocked(epoch, "UTC_WINDOW_ROLLOVER", current)
            self._state["status"] = WAITING_FOR_NEXT_TPD_WINDOW
            self._state["dailyRecoveryStopReason"] = (
                MIDNIGHT_IN_FLIGHT_REQUESTS_PENDING
                if int(epoch.get("reservedPendingTokens", 0)) > 0
                else "UTC_WINDOW_ROLLOVER"
            )
            self._write()
            raise DailyRecoveryDeferred(WAITING_FOR_NEXT_TPD_WINDOW)
        operation_key = f"{case_id}::{metric}"
        scheduled = epoch.get("scheduledOperationKeys")
        if isinstance(scheduled, list) and scheduled and operation_key not in scheduled:
            self._close_epoch_unlocked(epoch, INSUFFICIENT_TPD_FOR_NEXT_OPERATION, current)
            self._state["status"] = WAITING_FOR_NEXT_TPD_WINDOW
            self._state["dailyRecoveryStopReason"] = INSUFFICIENT_TPD_FOR_NEXT_OPERATION
            self._write()
            raise DailyRecoveryDeferred(INSUFFICIENT_TPD_FOR_NEXT_OPERATION)
        key = self._request_key(case_id, metric, attempt, date)
        existing = self._state["requests"].get(key)
        if isinstance(existing, dict) and existing.get("status") in {"DISPATCHED", "ACCOUNTED"}:
            raise DailyRecoveryDeferred("RECOVERY_REQUEST_ALREADY_DISPATCHED")
        available = int(epoch["calculatedRemainingTokens"]) - int(
            epoch.get("reservedPendingTokens", 0)
        )
        if available < reservation_tokens + safety_margin_tokens:
            self._close_epoch_unlocked(epoch, INSUFFICIENT_TPD_FOR_NEXT_OPERATION, current)
            self._state["status"] = WAITING_FOR_NEXT_TPD_WINDOW
            self._state["dailyRecoveryStopReason"] = INSUFFICIENT_TPD_FOR_NEXT_OPERATION
            self._write()
            raise DailyRecoveryDeferred(INSUFFICIENT_TPD_FOR_NEXT_OPERATION)
        material = "\x1f".join(
            (
                self.checkpoint_id,
                epoch["ledgerEpoch"],
                case_id or "",
                metric or "",
                str(attempt),
            )
        )
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"velora-ragas-recovery:{material}"))

    def ensure_capacity(
        self,
        *,
        case_id: str | None,
        metric: str | None,
        attempt: int,
        reservation_tokens: int,
        safety_margin_tokens: int,
        now: datetime | None = None,
    ) -> str:
        current = now or datetime.now(UTC)
        with self._lock:
            return self._ensure_capacity_unlocked(
                case_id=case_id,
                metric=metric,
                attempt=attempt,
                reservation_tokens=reservation_tokens,
                safety_margin_tokens=safety_margin_tokens,
                current=current,
            )

    def _mark_dispatched_unlocked(
        self,
        *,
        request_id: str,
        case_id: str | None,
        metric: str | None,
        attempt: int,
        reservation_tokens: int,
        current: datetime,
    ) -> dict[str, Any]:
        date = _utc_date(current)
        moment = _utc_timestamp(current)
        epoch = self._active_epoch_unlocked()
        if epoch is None or epoch["windowDateUtc"] != date:
            raise DailyRecoveryDeferred(WAITING_FOR_NEXT_TPD_WINDOW)
        key = self._request_key(case_id, metric, attempt, date)
        if key in self._state["requests"]:
            raise DailyRecoveryDeferred("RECOVERY_REQUEST_ALREADY_DISPATCHED")
        self._state["requests"][key] = {
            "requestId": request_id,
            "windowDateUtc": date,
            "ledgerEpoch": epoch["ledgerEpoch"],
            "caseId": case_id,
            "metricName": metric,
            "attempt": attempt,
            "reservationTokens": reservation_tokens,
            "countedTokens": None,
            "status": "DISPATCHED",
            "outcomeStatus": None,
            "providerCategory": None,
            "dispatchedAt": moment,
            "accountedAt": None,
        }
        epoch["reservedPendingTokens"] = int(epoch.get("reservedPendingTokens", 0)) + int(
            reservation_tokens
        )
        epoch["firstJudgeRequestAt"] = epoch.get("firstJudgeRequestAt") or moment
        epoch["lastJudgeRequestAt"] = moment
        if self._state["authorization"]["status"] == "UNCONSUMED":
            self._state["authorization"] = {
                "status": "CONSUMED",
                "consumedAt": moment,
            }
        self._write()
        return {
            "requestId": request_id,
            "ledgerEpoch": epoch["ledgerEpoch"],
            "windowDateUtc": date,
        }

    def prepare_request(
        self,
        *,
        case_id: str | None,
        metric: str | None,
        attempt: int,
        reservation_tokens: int,
        safety_margin_tokens: int,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Atomically reserve and persist one request before provider dispatch."""

        current = now or datetime.now(UTC)
        with self._lock:
            request_id = self._ensure_capacity_unlocked(
                case_id=case_id,
                metric=metric,
                attempt=attempt,
                reservation_tokens=reservation_tokens,
                safety_margin_tokens=safety_margin_tokens,
                current=current,
            )
            return self._mark_dispatched_unlocked(
                request_id=request_id,
                case_id=case_id,
                metric=metric,
                attempt=attempt,
                reservation_tokens=reservation_tokens,
                current=current,
            )

    def mark_dispatched(
        self,
        *,
        request_id: str,
        case_id: str | None,
        metric: str | None,
        attempt: int,
        reservation_tokens: int,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        current = now or datetime.now(UTC)
        with self._lock:
            self._ensure_capacity_unlocked(
                case_id=case_id,
                metric=metric,
                attempt=attempt,
                reservation_tokens=reservation_tokens,
                safety_margin_tokens=daily_safety_margin_tokens(),
                current=current,
            )
            return self._mark_dispatched_unlocked(
                request_id=request_id,
                case_id=case_id,
                metric=metric,
                attempt=attempt,
                reservation_tokens=reservation_tokens,
                current=current,
            )

    def mark_accounted(
        self,
        request_id: str,
        counted_tokens: int,
        *,
        outcome_status: str | None = None,
        provider_category: str | None = None,
        now: datetime | None = None,
    ) -> None:
        if (
            isinstance(counted_tokens, bool)
            or not isinstance(counted_tokens, int)
            or counted_tokens < 0
        ):
            raise RecoveryStateError("recovery request counted tokens are invalid")
        current = now or datetime.now(UTC)
        moment = _utc_timestamp(current)
        with self._lock:
            request = next(
                (
                    value
                    for value in self._state["requests"].values()
                    if value.get("requestId") == request_id
                ),
                None,
            )
            if request is None:
                raise RecoveryStateError("recovery request accounting identity is missing")
            if request.get("status") == "ACCOUNTED":
                if request.get("countedTokens") != counted_tokens:
                    raise RecoveryStateError("recovery request accounting cannot be replaced")
                if (
                    outcome_status is not None
                    and request.get("outcomeStatus") not in {None, outcome_status}
                ):
                    raise RecoveryStateError("recovery request outcome cannot be replaced")
                return
            epoch = next(
                (
                    value
                    for value in self._state["epochs"]
                    if value.get("ledgerEpoch") == request.get("ledgerEpoch")
                ),
                None,
            )
            if epoch is None or epoch.get("closedAt") is not None:
                raise RecoveryStateError("recovery request epoch is missing or already closed")
            request["status"] = "ACCOUNTED"
            request["countedTokens"] = int(counted_tokens)
            if outcome_status is not None:
                request["outcomeStatus"] = outcome_status
            if provider_category is not None:
                request["providerCategory"] = provider_category
            request["accountedAt"] = moment
            epoch["reservedPendingTokens"] = max(
                0,
                int(epoch.get("reservedPendingTokens", 0))
                - int(request.get("reservationTokens", 0)),
            )
            epoch["evaluatorCountedTokens"] = int(epoch.get("evaluatorCountedTokens", 0)) + int(
                counted_tokens
            )
            epoch["calculatedRemainingTokens"] = max(
                0,
                int(epoch["dailyLimitTokens"])
                - int(epoch["baselineCountedUsedTokens"])
                - int(epoch["evaluatorCountedTokens"]),
            )
            if (
                request.get("windowDateUtc") != _utc_date(current)
                and int(epoch.get("reservedPendingTokens", 0)) == 0
            ):
                self._close_epoch_unlocked(
                    epoch, "UTC_ROLLOVER_AFTER_IN_FLIGHT_ACCOUNTING", current
                )
                self._state["status"] = WAITING_FOR_NEXT_TPD_WINDOW
                self._state["dailyRecoveryStopReason"] = "UTC_WINDOW_ROLLOVER"
            self._write()

    def reconcile_ledger(self, ledger: GroqDailyTokenLedger) -> int:
        """Repair a crash between durable ledger append and recovery-state accounting."""

        with self._lock:
            pending = [
                dict(value)
                for value in self._state["requests"].values()
                if value.get("status") == "DISPATCHED"
            ]
        reconciled = 0
        for request in pending:
            row = ledger.request(str(request["requestId"]))
            if row is None:
                continue
            if row.get("ledgerEpoch") != request.get("ledgerEpoch"):
                raise RecoveryStateError("ledger request belongs to a different TPD epoch")
            counted = row.get("countedTokens")
            if not isinstance(counted, int) or counted < 0:
                raise RecoveryStateError("ledger request counted tokens are invalid")
            self.mark_accounted(
                str(request["requestId"]),
                counted,
                outcome_status=row.get("status"),
                provider_category=row.get("providerCategory"),
            )
            reconciled += 1
        return reconciled

    def request_epoch(self, request_id: str) -> dict[str, str] | None:
        with self._lock:
            for value in self._state["requests"].values():
                if value.get("requestId") == request_id:
                    return {
                        "ledgerEpoch": str(value["ledgerEpoch"]),
                        "windowDateUtc": str(value["windowDateUtc"]),
                    }
        return None

    def progress(
        self,
        checkpoint_entries: Iterable[dict[str, Any]],
        *,
        total_operations: int | None = None,
        scheduled_operations: int | None = None,
        deferred_operations: int | None = None,
    ) -> dict[str, Any]:
        entries = list(checkpoint_entries)
        complete = sum(entry.get("status") == "COMPLETE" for entry in entries)
        failed = sum(entry.get("status") == "UNAVAILABLE" for entry in entries)
        total = total_operations if total_operations is not None else len(entries)
        with self._lock:
            active_epoch = self._active_epoch_unlocked()
            dispatched = sum(
                value.get("status") == "DISPATCHED" for value in self._state["requests"].values()
            )
            today_requests = [
                value
                for value in self._state["requests"].values()
                if active_epoch
                and value.get("windowDateUtc") == active_epoch.get("windowDateUtc")
            ]
            calls_completed_today = sum(
                value.get("status") == "ACCOUNTED"
                and value.get("outcomeStatus") == "SUCCESS"
                for value in today_requests
            )
            calls_failed_today = sum(
                value.get("status") == "ACCOUNTED"
                and value.get("outcomeStatus") == "FAILURE"
                for value in today_requests
            )
            calls_pending_today = sum(
                value.get("status") == "DISPATCHED" for value in today_requests
            )
            active = active_epoch
            latest = self._state["epochs"][-1] if self._state["epochs"] else None
            status = self._state.get("status", "READY")
            stop_reason = self._state.get("dailyRecoveryStopReason")
        unresolved = max(0, total - complete)
        deferred = (
            deferred_operations
            if deferred_operations is not None
            else max(0, unresolved - failed - dispatched)
        )
        return {
            "totalMandatoryMetrics": total,
            "completedCalls": complete,
            "failedCalls": failed,
            "pendingCalls": dispatched,
            "callsCompletedToday": calls_completed_today,
            "callsFailedToday": calls_failed_today,
            "callsPendingToday": calls_pending_today,
            "deferredCalls": deferred,
            "scheduledCalls": scheduled_operations,
            "unresolvedCalls": unresolved,
            "waitingForNextTpdWindow": status == WAITING_FOR_NEXT_TPD_WINDOW,
            "dailyRecoveryStopReason": stop_reason,
            "activeWindowDateUtc": active.get("windowDateUtc") if active else None,
            "dailyLimitTokens": latest.get("dailyLimitTokens") if latest else None,
            "baselineCountedUsedTokens": (
                latest.get("baselineCountedUsedTokens") if latest else None
            ),
            "evaluatorCountedTokens": latest.get("evaluatorCountedTokens") if latest else None,
            "calculatedRemainingTokens": (
                latest.get("calculatedRemainingTokens") if latest else None
            ),
        }
