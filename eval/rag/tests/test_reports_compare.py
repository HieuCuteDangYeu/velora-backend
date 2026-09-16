import json

from rag_eval.adapters.runner_output import fixture_execution
from rag_eval.compare import compare_summaries
from rag_eval.dataset import load_dataset
from rag_eval.evaluate import evaluate_case, frozen_answer_correct
from rag_eval.reports import build_summary, write_report


def fixture_cases():
    rows = list(load_dataset("rag-frozen-ami-v1"))[:2]
    return [
        {
            **evaluate_case(row, fixture_execution(row, "run-a", {"variantName": "a"})),
            "variant": {"variantName": "a"},
        }
        for row in rows
    ]


def test_frozen_rule_preserves_project_specific_threshold():
    assert frozen_answer_correct("Olivier", "Olivier.") == 1
    assert (
        frozen_answer_correct(
            "IDIAP and Jean-Marc", "During an internship at IDIAP under Jean-Marc."
        )
        == 1
    )
    assert (
        frozen_answer_correct("somewhere else", "During an internship at IDIAP under Jean-Marc.")
        == 0
    )


def test_frozen_hard_gate_does_not_treat_lexical_overlap_as_semantic_truth():
    row = list(load_dataset("rag-frozen-ami-v1"))[0]
    execution = fixture_execution(row, "semantic-gate", {"variantName": "semantic-gate"})
    execution.actual["answer"] = "A lexically unrelated paraphrase placeholder."

    result = evaluate_case(row, execution)

    assert result["deterministic"]["answerCorrect"] == 0
    assert result["deterministic"]["grounded"] == 1
    assert result["hardGatePassed"] is True


def test_report_is_deterministic_and_sliced(tmp_path):
    cases = fixture_cases()
    first = build_summary(cases, "run-a")
    second = build_summary(list(reversed(cases)), "run-a")
    assert first == second
    assert first["correctAndGrounded"] == 2
    assert first["slices"]["AMI"]["cases"] == 2
    directory = write_report(cases, "run-a", tmp_path)
    assert (directory / "summary.json").exists()
    assert len((directory / "cases.jsonl").read_text().splitlines()) == 2
    assert json.loads((directory / "summary.json").read_text())["hardGatePassed"] is True


def test_variant_comparison_handles_null_semantic_metrics():
    baseline = build_summary(fixture_cases(), "baseline")
    candidate = build_summary(fixture_cases(), "candidate")
    comparison = compare_summaries(baseline, candidate)
    assert comparison["deltas"]["correctAndGrounded"] == 0
    assert comparison["deltas"]["faithfulness"] is None
