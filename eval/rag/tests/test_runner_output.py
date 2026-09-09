import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import rag_eval.adapters.runner_output as runner_output


def test_checked_in_jsonl_fixture_has_multiple_rows_and_trailing_newline():
    fixture = Path(__file__).parent / "fixtures" / "two-rows.jsonl"

    assert fixture.read_bytes().endswith(b"\n")
    assert runner_output.load_jsonl(fixture) == [{"row": 1}, {"row": 2}]


def test_jsonl_loader_accepts_multiple_rows_and_trailing_newline(tmp_path):
    path = tmp_path / "rows.jsonl"
    path.write_text('{"row": 1}\n{"row": 2}\n')

    assert runner_output.load_jsonl(path) == [{"row": 1}, {"row": 2}]


def test_jsonl_loader_reports_malformed_line_number(tmp_path):
    path = tmp_path / "rows.jsonl"
    path.write_text('{"row": 1}\nnot-json\n')

    with pytest.raises(ValueError, match=r"line 2"):
        runner_output.load_jsonl(path)


def test_json_loader_reads_one_document(tmp_path):
    path = tmp_path / "document.json"
    path.write_text('{"row": 1}\n')

    assert runner_output.load_json(path) == {"row": 1}


def test_load_runner_report_accepts_jsonl_trace_rows(tmp_path):
    report = tmp_path / "report.json"
    report.write_text(
        '{"runId":"run-jsonl","cases":[{"caseId":"C-1","status":"EVALUATED",'
        '"finalAnswer":"Actual","citations":[]}]}'
    )
    traces = tmp_path / "traces.jsonl"
    traces.write_text(
        '{"caseId":"C-1","traceId":"trace-1","intent":"NORMAL_CHAT",'
        '"workflowMetrics":{"diagnostics":{}}}\n'
    )
    from rag_eval.schemas import EvaluationRow

    row = EvaluationRow(
        id="C-1",
        datasetVersion="test",
        question="Question?",
        referenceAnswer="Actual",
        expectedIntent="NORMAL_CHAT",
        category="test",
        fixtureGroup="test",
    )

    result = runner_output.load_runner_report(report, {row.id: row}, traces)

    assert result["C-1"].trace["ragTraceId"] == "trace-1"


@pytest.mark.parametrize(
    ("trace_rows", "message"),
    [
        ([], "TRACE_PROVENANCE=INCOMPLETE"),
        ([{"caseId": "C-1"}, {"caseId": "C-1"}], "TRACE_PROVENANCE=AMBIGUOUS"),
    ],
)
def test_live_trace_provenance_rejects_missing_or_ambiguous_rows(
    tmp_path, trace_rows, message
):
    traces = tmp_path / "traces.jsonl"
    traces.write_text("\n".join(json.dumps(row) for row in trace_rows))

    with pytest.raises(ValueError, match=message):
        runner_output.validate_trace_provenance(traces, {"C-1"})


def test_live_trace_provenance_accepts_exactly_one_trace_per_case(tmp_path):
    traces = tmp_path / "traces.jsonl"
    traces.write_text('{"caseId":"C-1"}\n{"caseId":"C-2"}\n')

    assert runner_output.validate_trace_provenance(traces, {"C-1", "C-2"}) == "COMPLETE"


def test_live_load_requires_trace_provenance(tmp_path):
    report = tmp_path / "report.json"
    report.write_text(
        '{"runId":"run","cases":[{"caseId":"C-1","status":"EVALUATED",'
        '"finalAnswer":"Actual","citations":[]}]}'
    )
    from rag_eval.schemas import EvaluationRow

    row = EvaluationRow(
        id="C-1",
        datasetVersion="test",
        question="Question?",
        referenceAnswer="Actual",
        category="test",
        fixtureGroup="test",
    )

    with pytest.raises(ValueError, match="TRACE_PROVENANCE=MISSING"):
        runner_output.load_runner_report(report, {row.id: row}, require_trace=True)


def test_load_runner_report_normalizes_canonical_chunk_ids_for_citations(tmp_path):
    report = tmp_path / "report.json"
    report.write_text(
        '{"runId":"run-canonical","cases":[{"caseId":"C-1","status":"EVALUATED",'
        '"finalAnswer":"Actual","citations":[{"reelId":"r1","evidenceType":"TRANSCRIPT"}]}]}'
    )
    traces = tmp_path / "traces.jsonl"
    traces.write_text(
        '{"caseId":"C-1","traceId":"trace-1","retrievedChunkIds":["reel:r1:chunk:0"],'
        '"rerankedChunkIds":["reel:r1:chunk:0"],"workflowMetrics":{'
        '"citationEvidenceMappings":[{"citationIndex":0,"evidenceId":"reel:r1:chunk:0"}]}}\n'
    )
    from rag_eval.schemas import EvaluationRow

    row = EvaluationRow(
        id="C-1",
        datasetVersion="test",
        question="Question?",
        referenceAnswer="Actual",
        expectedReelIds=["r1"],
        relevantEvidenceIds=["reel:r1:chunk:0"],
        category="test",
        fixtureGroup="test",
    )

    result = runner_output.load_runner_report(report, {row.id: row}, traces)["C-1"]

    assert result.actual["rerankedContexts"][0]["reelId"] == "r1"
    assert result.actual["citations"][0]["evidenceId"] == "reel:r1:chunk:0"


def test_load_runner_report_collects_nested_structured_call_diagnostics(tmp_path):
    report = tmp_path / "report.json"
    report.write_text(
        '{"runId":"run-calls","cases":[{"caseId":"C-1","status":"EVALUATED",'
        '"finalAnswer":"Actual","citations":[]}]}'
    )
    traces = tmp_path / "traces.jsonl"
    traces.write_text(
        '{"caseId":"C-1","workflowMetrics":{"diagnostics":{"route":{'
        '"modelRole":"ROUTER","model":"@cf/test/router","providerStatus":200,'
        '"latencyMs":12,"usage":{"inputTokens":10,"outputTokens":4,"totalTokens":14},'
        '"attempt":1}}}}\n'
    )
    from rag_eval.schemas import EvaluationRow

    row = EvaluationRow(
        id="C-1",
        datasetVersion="test",
        question="Question?",
        referenceAnswer="Actual",
        category="test",
        fixtureGroup="test",
    )

    result = runner_output.load_runner_report(report, {row.id: row}, traces)["C-1"]

    assert result.modelCalls[0].modelRole == "ROUTER"
    assert result.modelCalls[0].totalTokens == 14


def test_load_runner_report_collects_failure_semantic_calls_without_request_ids(tmp_path):
    report = tmp_path / "report.json"
    report.write_text(
        '{"runId":"run-failure-calls","cases":[{"caseId":"C-1",'
        '"status":"FAILED_RECONCILED","finalAnswer":"","citations":[]}]}'
    )
    traces = tmp_path / "traces.jsonl"
    diagnostic = {
        "modelRole": "ROUTER",
        "model": "@cf/test/router",
        "attempt": 1,
        "configuredTimeoutMs": 30000,
        "configuredMaxCompletionTokens": 512,
        "latencyMs": 30123,
        "providerStatus": 503,
        "providerCode": 9021,
        "providerCategory": "TRANSIENT_PROVIDER_FAILURE",
        "errorCode": "STRUCTURED_COMPLETION_PROVIDER_ERROR",
        "transient": True,
        "retryAfterMs": 1000,
        "networkErrorName": "UND_ERR_SOCKET",
        "networkErrorCode": "ECONNRESET",
        "networkErrorSyscall": "read",
        "endpointContract": "CHAT_JSON_SCHEMA",
        "responseContentType": "absent",
        "contentPresent": False,
        "toolCallsPresent": False,
        "schemaPath": None,
        "schemaConstraint": None,
        "schemaVersion": "router-semantic-v4",
        "usage": {"inputTokens": 100, "outputTokens": 0, "totalTokens": 100},
        "requestId": "must-not-persist",
    }
    traces.write_text(
        json.dumps(
            {
                "caseId": "C-1",
                "workflowMetrics": {
                    "diagnostics": {
                        "route": diagnostic,
                        "failure": {"semanticCalls": [diagnostic]},
                    }
                },
            }
        )
        + "\n"
    )
    from rag_eval.schemas import EvaluationRow

    row = EvaluationRow(
        id="C-1",
        datasetVersion="test",
        question="Question?",
        referenceAnswer="",
        category="test",
        fixtureGroup="test",
    )

    result = runner_output.load_runner_report(report, {row.id: row}, traces)["C-1"]

    assert len(result.modelCalls) == 1
    call = result.modelCalls[0]
    assert call.modelRole == "ROUTER"
    assert call.providerStatus == 503
    assert call.providerCode == 9021
    assert call.providerCategory == "TRANSIENT_PROVIDER_FAILURE"
    assert call.errorCode == "STRUCTURED_COMPLETION_PROVIDER_ERROR"
    assert call.transient is True
    assert call.retryAfterMs == 1000
    assert call.networkErrorCode == "ECONNRESET"
    assert call.configuredTimeoutMs == 30000
    assert call.inputTokens == 100
    assert not hasattr(call, "requestId")


def test_invoke_typescript_runner_parses_report_path(monkeypatch):
    def fake_run(*_args, **_kwargs):
        return SimpleNamespace(stdout='progress\n{"reportPath": "/tmp/report.json"}\n')

    monkeypatch.setattr(runner_output.subprocess, "run", fake_run)

    assert runner_output.invoke_typescript_runner(["--run-id", "test"]) == Path(
        "/tmp/report.json"
    )


def test_invoke_typescript_runner_ignores_json_scalar_progress_lines(monkeypatch):
    def fake_run(*_args, **_kwargs):
        return SimpleNamespace(
            stdout='progress\n"completed"\n{"reportPath": "/tmp/report.json"}\n'
        )

    monkeypatch.setattr(runner_output.subprocess, "run", fake_run)

    assert runner_output.invoke_typescript_runner(["--run-id", "test"]) == Path(
        "/tmp/report.json"
    )


def test_invoke_typescript_runner_surfaces_bounded_sanitized_failure(monkeypatch):
    error = subprocess.CalledProcessError(
        17,
        ["node", "runner"],
        output=(
            "password=supersecret "
            "Authorization: Bearer bearer-secret "
            "postgresql://dbuser:dbpassword@example.test/db"
        ),
        stderr=(
            "Cookie: session=session-secret "
            "cloudflare_api_token=cloudflare-secret "
            "index failed at validation"
        ),
    )
    error.stdout = error.output

    def fake_run(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(runner_output.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError) as raised:
        runner_output.invoke_typescript_runner(["--run-id", "test"])

    message = str(raised.value)
    assert "TypeScript runner failed with exit code 17" in message
    assert "index failed at validation" in message
    for secret in (
        "supersecret",
        "bearer-secret",
        "dbpassword",
        "session-secret",
        "cloudflare-secret",
    ):
        assert secret not in message
    assert len(message) < 4200
