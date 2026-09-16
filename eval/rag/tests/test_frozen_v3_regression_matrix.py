import re

from rag_eval.reports import build_summary


RUN = "production-rag-frozen-ami-v3-bb4782fb-20260916-01"


def _case(
    case_id: str,
    *,
    lexical_match: int,
    answer: str,
    grounded: int = 1,
    evidence_hit_rate: int = 1,
) -> dict:
    return {
        "caseId": case_id,
        "datasetVersion": "rag-frozen-ami-v3",
        "tags": [],
        "semantic": {
            "faithfulness": None,
            "factual_correctness": None,
            "response_relevancy": None,
            "context_precision": None,
            "context_recall": None,
        },
        "deterministic": {
            "lexicalAnswerMatch": lexical_match,
            "grounded": grounded,
            "lexicalAnswerMatchAndGrounded": lexical_match * grounded,
            "accessControlViolations": 0,
            "evidenceHitRate": evidence_hit_rate,
        },
        "execution": {
            "executionStatus": "COMPLETED",
            "modelCalls": [],
            "latencyMs": 1,
            "actual": {"answer": answer},
        },
        "hardGatePassed": True,
    }


def _saved_cases() -> dict[str, dict]:
    cases = [
        _case("IN1001-1", lexical_match=1, answer="Expected wording one."),
        _case("IN1001-2", lexical_match=1, answer="Expected wording two."),
        _case("IN1002-1", lexical_match=0, answer="Backups stay physically separate."),
        _case("IN1002-2", lexical_match=1, answer="Expected wording three."),
        _case(
            "IN1005-1",
            lexical_match=0,
            answer="A grounded paraphrase with different surface wording.",
        ),
        _case(
            "IN1005-2",
            lexical_match=0,
            answer="I do not have enough verified shared reel evidence to answer that.",
        ),
        _case(
            "IN1007-1",
            lexical_match=0,
            answer="0123456789abcdef0123456789abcdef:fedcba9876543210fedcba9876543210:ciphertext",
        ),
        _case(
            "IN1007-2",
            lexical_match=0,
            answer="I do not have enough verified shared reel evidence to answer that.",
        ),
    ]
    return {case["caseId"]: case for case in cases}


def test_saved_bb4782fb_lexical_score_is_diagnostic_not_semantic_correctness():
    cases = list(_saved_cases().values())
    summary = build_summary(cases, RUN)

    assert summary["lexicalMatch"] == 3
    assert summary["lexicalMatchAndGrounded"] == 3
    assert summary["correct"] is None
    assert summary["correctAndGrounded"] is None

    paraphrase = _saved_cases()["IN1002-1"]
    assert paraphrase["deterministic"]["lexicalAnswerMatch"] == 0
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
