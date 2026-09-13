"""Atomic metric-level checkpointing for saved-output semantic evaluations."""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

CHECKPOINT_SCHEMA = "ragas-judge-checkpoint-v1"


class JudgeCheckpointStore:
    """Persist one immutable source identity and case-by-metric outcomes."""

    def __init__(self, path: str | Path, identity: dict[str, Any]):
        self.path = Path(path)
        self.identity = dict(identity)
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._state = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {
                "schemaVersion": CHECKPOINT_SCHEMA,
                "identity": self.identity,
                "entries": {},
            }
        state = json.loads(self.path.read_text(encoding="utf-8"))
        if state.get("schemaVersion") != CHECKPOINT_SCHEMA:
            raise ValueError("judge checkpoint schema mismatch")
        if state.get("identity") != self.identity:
            raise ValueError("judge checkpoint source/provider identity mismatch")
        if not isinstance(state.get("entries"), dict):
            raise ValueError("judge checkpoint entries are invalid")
        return state

    @staticmethod
    def key(case_id: str, metric_name: str) -> str:
        return f"{case_id}::{metric_name}"

    def get(self, case_id: str, metric_name: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._state["entries"].get(self.key(case_id, metric_name))
            return dict(entry) if isinstance(entry, dict) else None

    def record(self, entry: dict[str, Any]) -> None:
        required = {
            "sourceRunId",
            "productionSha",
            "datasetVersion",
            "sourceExecutionId",
            "ragTraceId",
            "caseId",
            "metricName",
            "judgeProvider",
            "judgeModel",
            "evaluatorSha",
            "status",
        }
        if required - entry.keys():
            raise ValueError("judge checkpoint entry identity is incomplete")
        identity_keys = required - {
            "sourceExecutionId",
            "ragTraceId",
            "caseId",
            "metricName",
            "status",
        }
        if any(entry[key] != self.identity.get(key) for key in identity_keys):
            raise ValueError("judge checkpoint entry does not match source identity")
        key = self.key(entry["caseId"], entry["metricName"])
        with self._lock:
            existing = self._state["entries"].get(key)
            if isinstance(existing, dict) and existing.get("status") == "COMPLETE":
                return
            self._state["entries"][key] = {
                **entry,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            self._write_locked()

    def _write_locked(self) -> None:
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        temporary.write_text(
            json.dumps(self._state, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)

    def entries(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(entry) for entry in self._state["entries"].values()]
