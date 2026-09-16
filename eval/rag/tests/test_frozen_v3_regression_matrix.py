import re
from pathlib import Path

from rag_eval.reports import build_summary, load_cases


RESULTS = Path(__file__).resolve().parents[1] / "results"
RUN = "production-rag-frozen-ami-v3-bb4782fb-20260916-01"


def _saved_cases() -> dict[str, dict]:
    return {
        case["caseId"]: case
        for case in load_cases(RESULTS / RUN)
    }


def test_saved_bb4782fb_lexical_score_is_diagnostic_not_semantic_correctness():
    cases = list(_saved_cases().values())
    summary = build_summary(cases, RUN)

    assert summary["lexicalMatch"] == 3
    assert summary["lexicalMatchAndGrounded"] == 3
    assert summary["correct"] is None
    assert summary["correctAndGrounded"] is None

    paraphrase = _saved_cases()["IN1002-1"]
    assert paraphrase["deterministic"]["answerCorrect"] == 0
    assert paraphrase["deterministic"]["grounded"] == 1
    assert "physically separate" in paraphrase["execution"]["actual"]["answer"].lower()


def test_saved_bb4782fb_separates_runner_corruption_from_rag_failures():
    cases = _saved_cases()

    reconciled_corruption = cases["IN1007-1"]["execution"]["actual"]["answer"]
    assert re.match(r"^[0-9a-f]{32}:[0-9a-f]{32}:", reconciled_corruption)

    for case_id in ("IN1005-2", "IN1007-2"):
        case = cases[case_id]
        assert case["deterministic"]["evidenceHitRate"] == 1
        assert case["execution"]["actual"]["answer"].startswith(
            "I do not have enough verified shared reel evidence"
        )

