import json

import pytest

from rag_eval.checkpoint import JudgeCheckpointStore

IDENTITY = {
    "sourceRunId": "source-run",
    "productionSha": "a" * 40,
    "datasetVersion": "rag-frozen-ami-v3",
    "judgeProvider": "groq",
    "judgeModel": "openai/gpt-oss-120b",
    "evaluatorSha": "b" * 40,
}


def entry(status="COMPLETE", value=0.8):
    return {
        **IDENTITY,
        "sourceExecutionId": "assistant-1",
        "ragTraceId": "trace-1",
        "caseId": "IN1001-1",
        "metricName": "faithfulness",
        "status": status,
        "value": value,
        "calls": [],
    }


def test_checkpoint_is_atomic_and_round_trips_completed_metric(tmp_path):
    path = tmp_path / "checkpoint.json"
    store = JudgeCheckpointStore(path, IDENTITY)
    store.record(entry())

    restored = JudgeCheckpointStore(path, IDENTITY)
    assert restored.get("IN1001-1", "faithfulness")["value"] == 0.8
    assert len(restored.entries()) == 1


def test_checkpoint_rejects_mixed_source_identity(tmp_path):
    path = tmp_path / "checkpoint.json"
    JudgeCheckpointStore(path, IDENTITY).record(entry())
    with pytest.raises(ValueError, match="identity mismatch"):
        JudgeCheckpointStore(path, {**IDENTITY, "productionSha": "c" * 40})


def test_unavailable_entry_can_be_replaced_but_complete_entry_cannot(tmp_path):
    path = tmp_path / "checkpoint.json"
    store = JudgeCheckpointStore(path, IDENTITY)
    store.record(entry(status="UNAVAILABLE", value=None))
    store.record(entry(status="COMPLETE", value=0.9))
    assert store.get("IN1001-1", "faithfulness")["status"] == "COMPLETE"
    assert store.get("IN1001-1", "faithfulness")["value"] == 0.9
    store.record(entry(status="COMPLETE", value=0.1))
    assert store.get("IN1001-1", "faithfulness")["value"] == 0.9


def test_checkpoint_allows_revision_with_same_evaluator_compatibility(tmp_path):
    path = tmp_path / "checkpoint.json"
    JudgeCheckpointStore(path, IDENTITY).record(entry())

    restored = JudgeCheckpointStore(path, {**IDENTITY, "evaluatorSha": "c" * 40})

    assert restored.get("IN1001-1", "faithfulness")["value"] == 0.8


def test_legacy_checkpoint_lineage_id_is_stable_across_evaluator_revisions(tmp_path):
    path = tmp_path / "checkpoint.json"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": "ragas-judge-checkpoint-v1",
                "identity": IDENTITY,
                "entries": {},
            }
        ),
        encoding="utf-8",
    )

    first = JudgeCheckpointStore(path, IDENTITY)
    second = JudgeCheckpointStore(path, {**IDENTITY, "evaluatorSha": "c" * 40})

    assert first.checkpoint_id == second.checkpoint_id


def test_checkpoint_rejects_different_evaluator_compatibility(tmp_path):
    path = tmp_path / "checkpoint.json"
    identity = {**IDENTITY, "evaluatorCompatibility": "contract-a"}
    JudgeCheckpointStore(path, identity).record({**entry(), **identity})

    with pytest.raises(ValueError, match="identity mismatch"):
        JudgeCheckpointStore(
            path,
            {**identity, "evaluatorCompatibility": "contract-b"},
        )
