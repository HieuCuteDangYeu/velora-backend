import json
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace

import pytest

from rag_eval import cli
from rag_eval.cli import _build_live_runner_args, validate_definitions_report
from rag_eval.dataset import is_supported_live_dataset, load_dataset


def _definitions_for(dataset):
    return {
        "ragBenchmark": {
            "cases": [
                {
                    "caseId": row.id,
                    "reelId": row.expectedReelIds[0],
                    "question": row.question,
                    "referenceAnswerText": row.referenceAnswer,
                    "expectedEvidenceType": row.expectedEvidenceTypes[0],
                    "referenceStartSec": row.metadata["referenceStartSec"],
                    "referenceEndSec": row.metadata["referenceEndSec"],
                }
                for row in dataset
            ]
        }
    }


def test_v2_definitions_must_come_from_the_selected_dataset(tmp_path):
    dataset = list(load_dataset("rag-frozen-ami-v2"))
    path = tmp_path / "definitions.json"
    path.write_text(json.dumps(_definitions_for(dataset)))

    validate_definitions_report(str(path), {row.id: row for row in dataset})


def test_v3_definitions_use_the_normal_selected_dataset_contract(tmp_path):
    dataset = list(load_dataset("rag-frozen-ami-v3"))
    path = tmp_path / "definitions-v3.json"
    path.write_text(json.dumps(_definitions_for(dataset)))

    validate_definitions_report(str(path), {row.id: row for row in dataset})


def test_live_dataset_contract_accepts_supported_frozen_versions_only():
    assert is_supported_live_dataset("rag-frozen-ami-v1")
    assert is_supported_live_dataset("rag-frozen-ami-v2")
    assert is_supported_live_dataset("rag-frozen-ami-v3")
    assert not is_supported_live_dataset("rag-generalization-v1")


def test_definitions_reel_mismatch_is_rejected(tmp_path):
    dataset = list(load_dataset("rag-frozen-ami-v2"))
    payload = _definitions_for(dataset)
    payload["ragBenchmark"]["cases"][0]["reelId"] = (
        "11111111-1111-4111-8111-111111111111"
    )
    path = tmp_path / "definitions.json"
    path.write_text(json.dumps(payload))

    with pytest.raises(ValueError, match="reel mismatch"):
        validate_definitions_report(str(path), {row.id: row for row in dataset})


def _runner_args(**overrides):
    values = {
        "run_id": None,
        "resume": None,
        "env_file": ".env.test.local",
    }
    values.update(overrides)
    return Namespace(**values)


def test_live_new_run_propagates_run_id_without_resume():
    run_id, args = _build_live_runner_args(
        _runner_args(run_id="test-run"), Path("/tmp/definitions.json")
    )

    assert run_id == "test-run"
    assert "--run-id" in args
    assert args[args.index("--run-id") + 1] == "test-run"
    assert "--resume" not in args


def test_live_resume_propagates_resume_without_run_id():
    run_id, args = _build_live_runner_args(
        _runner_args(resume="test-run"), Path("/tmp/definitions.json")
    )

    assert run_id == "test-run"
    assert "--resume" in args
    assert args[args.index("--resume") + 1] == "test-run"
    assert "--run-id" not in args


def test_live_rejects_ambiguous_run_id_and_resume():
    with pytest.raises(SystemExit, match="either --run-id or --resume"):
        _build_live_runner_args(
            _runner_args(run_id="run-a", resume="run-b"), Path("/tmp/definitions.json")
        )


def test_trace_export_accepts_structured_completion_marker(tmp_path, monkeypatch):
    report_path = tmp_path / "runner-report.json"
    report_path.write_text("{}")
    env_path = tmp_path / "eval.env"
    env_path.write_text("")

    monkeypatch.setattr(
        cli.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            stdout='{"TRACE_PROVENANCE":"COMPLETE","TRACE_ROWS_EXPORTED":8}\n'
        ),
    )

    cli._export_trace_artifact(
        report_path, tmp_path / "traces.jsonl", str(env_path)
    )
