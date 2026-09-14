import json

import pytest

from rag_eval.adapters.runner_output import load_runner_report, validate_semantic_context_artifact
from rag_eval.dataset import dataset_sha256
from rag_eval.evaluate import semantic_payloads
from rag_eval.schemas import EvaluationRow

SOURCE_RUN = "source-run"
PRODUCTION_SHA = "a" * 40
DATASET = "rag-frozen-ami-v3"
DATASET_SHA = "d" * 64
CASE_ID = "C-1"
EXECUTION_ID = "assistant-1"
TRACE_ID = "trace-1"
RETRIEVED = ["reel:r1:chunk:0", "reel:r1:chunk:1"]
RERANKED = ["reel:r1:chunk:1"]


def _row() -> EvaluationRow:
    return EvaluationRow(
        id=CASE_ID,
        datasetVersion=DATASET,
        question="Question?",
        referenceAnswer="Reference answer.",
        expectedReelIds=["r1"],
        relevantEvidenceIds=RERANKED,
        category="test",
        fixtureGroup="frozen-ami",
    )


def _write_source(tmp_path):
    report = tmp_path / "runner-report.json"
    report.write_text(
        json.dumps(
            {
                "runId": SOURCE_RUN,
                "cases": [
                    {
                        "caseId": CASE_ID,
                        "status": "EVALUATED",
                        "assistantMessageId": EXECUTION_ID,
                        "userMessageId": "user-1",
                        "finalAnswer": "Answer.",
                        "citations": [],
                    }
                ],
            }
        )
    )
    traces = tmp_path / "traces.jsonl"
    traces.write_text(
        json.dumps(
            {
                "caseId": CASE_ID,
                "traceId": TRACE_ID,
                "retrievedChunkIds": RETRIEVED,
                "rerankedChunkIds": RERANKED,
                "workflowMetrics": {"diagnostics": {}},
            }
        )
        + "\n"
    )
    summary = tmp_path / "summary.json"
    summary.write_text(
        json.dumps(
            {
                "runId": SOURCE_RUN,
                "dataset": DATASET,
                "caseCount": 1,
                "correctAndGrounded": 1,
                "hardGatePassed": True,
                "variant": {"productionSha": PRODUCTION_SHA},
            }
        )
    )
    return report, traces, summary


def _context_row(**overrides):
    row = {
        "caseId": CASE_ID,
        "traceId": TRACE_ID,
        "retrievedChunkIds": RETRIEVED,
        "rerankedChunkIds": RERANKED,
        "retrievedContexts": [
            {
                "evidenceId": item,
                "reelId": "r1",
                "evidenceType": "TRANSCRIPT",
                "text": f"Context {item}",
                "rank": index + 1,
            }
            for index, item in enumerate(RETRIEVED)
        ],
        "rerankedContexts": [
            {
                "evidenceId": RERANKED[0],
                "reelId": "r1",
                "evidenceType": "TRANSCRIPT",
                "text": "Reranked context.",
                "rank": 1,
            }
        ],
    }
    row.update(overrides)
    return row


def _validate(tmp_path, context_row=None, **envelope):
    report, traces, summary = _write_source(tmp_path)
    artifact = tmp_path / "enriched.jsonl"
    envelope = dict(envelope)
    context_row = context_row or _context_row()
    if "sourceExecutionId" in envelope:
        context_row = {**context_row, "sourceExecutionId": envelope.pop("sourceExecutionId")}
    if envelope:
        artifact.write_text(json.dumps({"rows": [context_row], **envelope}))
    else:
        artifact.write_text(json.dumps(context_row) + "\n")
    return validate_semantic_context_artifact(
        artifact,
        report,
        traces,
        summary,
        {CASE_ID: _row()},
        source_run_id=SOURCE_RUN,
        production_sha=PRODUCTION_SHA,
        dataset_version=DATASET,
        dataset_sha256=DATASET_SHA,
    )


def test_valid_legacy_enriched_rows_are_source_bound(tmp_path):
    bound, metadata = _validate(tmp_path)

    assert metadata["provenanceMode"] == "SOURCE_BOUND_LEGACY_ROWS"
    assert metadata["caseCount"] == 1
    assert bound[CASE_ID]["retrievedContexts"][0]["text"] == "Context reel:r1:chunk:0"


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("sourceRunId", "other-run", "SOURCE_RUN_ID"),
        ("productionSha", "b" * 40, "PRODUCTION_SHA"),
        ("datasetVersion", "other-dataset", "DATASET_VERSION"),
        ("datasetSha256", "e" * 64, "DATASET_SHA256"),
        ("sourceExecutionId", "other-execution", "SOURCE_EXECUTION_ID"),
    ],
)
def test_explicit_provenance_mismatch_fails_closed(tmp_path, field, value, message):
    with pytest.raises(ValueError, match=message):
        _validate(tmp_path, **{field: value})


def test_trace_and_chunk_mismatches_fail_closed(tmp_path):
    with pytest.raises(ValueError, match="RAG_TRACE_ID_MISMATCH"):
        _validate(tmp_path, context_row=_context_row(traceId="other-trace"))
    with pytest.raises(ValueError, match="RETRIEVED_CHUNKS_MISMATCH"):
        _validate(
            tmp_path,
            context_row=_context_row(retrievedChunkIds=["reel:r1:chunk:9"]),
        )


def test_missing_context_text_fails_closed(tmp_path):
    row = _context_row()
    row["retrievedContexts"][0]["text"] = ""

    with pytest.raises(ValueError, match="RETRIEVED_CONTEXTS_TEXT_MISSING"):
        _validate(tmp_path, context_row=row)


def test_context_binding_makes_all_context_metrics_eligible_without_runner_call(
    tmp_path, monkeypatch
):
    report, traces, summary = _write_source(tmp_path)
    artifact = tmp_path / "enriched.jsonl"
    artifact.write_text(json.dumps(_context_row()) + "\n")
    called = []
    monkeypatch.setattr(
        "rag_eval.adapters.runner_output.subprocess.run",
        lambda *args, **kwargs: called.append(args),
    )

    bound, _metadata = validate_semantic_context_artifact(
        artifact,
        report,
        traces,
        summary,
        {CASE_ID: _row()},
        source_run_id=SOURCE_RUN,
        production_sha=PRODUCTION_SHA,
        dataset_version=DATASET,
        dataset_sha256=DATASET_SHA,
    )
    executions = load_runner_report(
        report,
        {CASE_ID: _row()},
        traces,
        require_trace=True,
        semantic_context_rows=bound,
    )
    payloads = semantic_payloads(_row(), executions[CASE_ID])

    assert not called
    assert set(payloads) == {
        "faithfulness",
        "factual_correctness",
        "response_relevancy",
        "context_precision",
        "context_recall",
    }
    assert payloads["faithfulness"]["retrieved_contexts"][0].startswith("Context ")


def test_canonical_dataset_hash_is_available():
    assert len(dataset_sha256(DATASET)) == 64
