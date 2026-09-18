from rag_eval.reports import build_summary


def test_summary_reports_semantic_coverage_without_filling_missing_values():
    deterministic = {
        "lexicalAnswerMatch": 1,
        "grounded": 1,
        "lexicalAnswerMatchAndGrounded": 1,
        "accessControlViolations": 0,
        "recallAt1": 1,
        "recallAt3": 1,
        "recallAt5": 1,
        "recallAt10": 1,
        "mrr": 1,
        "ndcgAt5": 1,
        "ndcgAt10": 1,
        "evidenceHitRate": 1,
        "citationPrecision": 1,
        "citationRecall": 1,
        "citationEvidenceHitRate": 1,
        "wrongReelCitationCount": 0,
        "wrongModalityCitationCount": 0,
        "routerIntentAccuracy": 1,
        "referenceTargetAccuracy": 1,
        "requiredEvidenceAccuracy": 1,
        "modalityAccuracy": 1,
    }
    case = {
        "caseId": "C-1",
        "datasetVersion": "test",
        "tags": [],
        "semantic": {
            "faithfulness": None,
            "factual_correctness": 0.8,
            "response_relevancy": 0.7,
            "context_precision": 0.9,
            "context_recall": 1.0,
        },
        "deterministic": deterministic,
        "execution": {"executionStatus": "COMPLETED", "modelCalls": [], "latencyMs": 1},
        "hardGatePassed": True,
    }
    summary = build_summary([case], "run")
    assert summary["semanticMetricCoverage"]["faithfulness"] == {
        "available": 0,
        "total": 1,
        "complete": False,
    }
    assert summary["semanticEvaluationComplete"] is False
    assert summary["semanticMetrics"]["faithfulness"] is None
    assert summary["correct"] is None
    assert summary["correctAndGrounded"] is None
    assert summary["lexicalMatch"] == 1
    assert summary["lexicalMatchAndGrounded"] == 1
