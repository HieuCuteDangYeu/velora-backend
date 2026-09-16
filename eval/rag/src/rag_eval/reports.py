"""Single report schema for every RAG evaluation dataset and variant."""

import json
from collections import defaultdict
from pathlib import Path
from statistics import fmean
from typing import Any

from rag_eval.metrics.cost import aggregate_costs, safe_cost_per
from rag_eval.metrics.operational import judge_metrics, latency_summary, reliability_metrics
from rag_eval.metrics.semantic import SEMANTIC_NAMES
from rag_eval.pricing import load_pricing


def _mean(values: list[float | None]) -> float | None:
    available = [float(item) for item in values if item is not None]
    return fmean(available) if available else None


def _lexical_metric(case: dict[str, Any], key: str, legacy_key: str) -> float | None:
    """Read the renamed lexical diagnostic while remaining able to summarize old runs."""
    deterministic = case["deterministic"]
    value = deterministic.get(key)
    return value if value is not None else deterministic.get(legacy_key)


def build_summary(cases: list[dict[str, Any]], run_id: str) -> dict[str, Any]:
    cases = sorted(cases, key=lambda item: item["caseId"])
    executions = [item["execution"] for item in cases]
    metrics = {
        key: _mean([item["deterministic"].get(key) for item in cases])
        for key in (cases[0]["deterministic"] if cases else {})
    }
    semantic = {
        key: _mean([item["semantic"].get(key) for item in cases])
        for key in (cases[0]["semantic"] if cases else {})
    }
    semantic_coverage = {
        name: {
            "available": sum(item["semantic"].get(name) is not None for item in cases),
            "total": len(cases),
            "complete": all(item["semantic"].get(name) is not None for item in cases),
        }
        for name in SEMANTIC_NAMES
    }
    calls = [call for execution in executions for call in execution.get("modelCalls", [])]
    costs = aggregate_costs(calls, load_pricing())
    lexical_match = sum(
        _lexical_metric(item, "lexicalAnswerMatch", "answerCorrect") == 1
        for item in cases
    )
    grounded = sum(item["deterministic"].get("grounded") == 1 for item in cases)
    lexical_match_grounded = sum(
        _lexical_metric(
            item, "lexicalAnswerMatchAndGrounded", "correctAndGrounded"
        )
        == 1
        for item in cases
    )
    successful_retrieval = sum(item["deterministic"].get("evidenceHitRate") == 1 for item in cases)
    slices: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for case in cases:
        for tag in case["tags"]:
            slices[tag].append(case)
    return {
        "schemaVersion": "rag-eval-summary-v1",
        "runId": run_id,
        "dataset": cases[0]["datasetVersion"] if cases else None,
        "variant": cases[0].get("variant", {}) if cases else {},
        "caseCount": len(cases),
        "executionFailureCount": sum(
            item["execution"]["executionStatus"] not in {"COMPLETED", "FIXTURE"} for item in cases
        ),
        # Binary semantic correctness is intentionally not inferred from the
        # deterministic lexical-overlap heuristic. Consumers should use the
        # semantic metrics once semanticEvaluationComplete is true.
        "correct": None,
        "grounded": grounded,
        "correctAndGrounded": None,
        "lexicalMatch": lexical_match,
        "lexicalMatchAndGrounded": lexical_match_grounded,
        "hardGatePassed": all(item["hardGatePassed"] for item in cases),
        "accessControlViolations": sum(
            item["deterministic"]["accessControlViolations"] for item in cases
        ),
        "metrics": metrics,
        "semanticMetrics": semantic,
        "semanticMetricCoverage": semantic_coverage,
        "semanticEvaluationComplete": bool(cases)
        and all(item["complete"] for item in semantic_coverage.values()),
        "latencyMs": latency_summary(executions),
        "reliability": reliability_metrics(executions),
        "judge": judge_metrics(executions),
        "cost": {
            **costs,
            "averageProductionCostPerQuery": safe_cost_per(costs["totalQueryCostUsd"], len(cases)),
            "costPerCorrectAnswer": None,
            "costPerGroundedAnswer": safe_cost_per(costs["totalQueryCostUsd"], grounded),
            "costPerCorrectGroundedAnswer": None,
            "costPerSuccessfulRetrieval": safe_cost_per(
                costs["totalQueryCostUsd"], successful_retrieval
            ),
        },
        "slices": {
            tag: {
                "cases": len(items),
                "lexicalMatchAndGroundedRate": _mean(
                    [
                        _lexical_metric(
                            item,
                            "lexicalAnswerMatchAndGrounded",
                            "correctAndGrounded",
                        )
                        for item in items
                    ]
                ),
                "accessControlViolations": sum(
                    item["deterministic"]["accessControlViolations"] for item in items
                ),
            }
            for tag, items in sorted(slices.items())
        },
    }


def write_report(cases: list[dict[str, Any]], run_id: str, output_root: Path) -> Path:
    directory = output_root / run_id
    directory.mkdir(parents=True, exist_ok=False)
    ordered = sorted(cases, key=lambda item: item["caseId"])
    summary = build_summary(ordered, run_id)
    (directory / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (directory / "cases.jsonl").write_text(
        "".join(json.dumps(case, sort_keys=True) + "\n" for case in ordered),
        encoding="utf-8",
    )
    metric = summary["metrics"]
    semantic = summary["semanticMetrics"]
    cost = summary["cost"]
    lines = [
        "# RAG Evaluation",
        "",
        f"- Dataset: {summary['dataset']}",
        f"- Variant: {summary['variant'].get('variantName', 'offline-fixture')}",
        f"- Cases: {summary['caseCount']}",
        f"- Lexical answer match (diagnostic): {summary['lexicalMatch']}/{summary['caseCount']}",
        f"- Lexical match and grounded (diagnostic): {summary['lexicalMatchAndGrounded']}/{summary['caseCount']}",
        f"- Access violations: {summary['accessControlViolations']}",
        f"- Faithfulness: {semantic.get('faithfulness')}",
        f"- Factual correctness: {semantic.get('factual_correctness')}",
        f"- Recall@5: {metric.get('recallAt5')}",
        f"- MRR: {metric.get('mrr')}",
        f"- Production query cost: {cost.get('totalQueryCostUsd')}",
        f"- Evaluation judge cost: {cost.get('evaluationJudgeCostUsd')}",
        f"- Semantic evaluation complete: {summary['semanticEvaluationComplete']}",
        f"- Hard gate: {'PASS' if summary['hardGatePassed'] else 'FAIL'}",
        "",
    ]
    (directory / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    return directory


def load_cases(run_directory: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in (run_directory / "cases.jsonl").read_text(encoding="utf-8").splitlines()
        if line
    ]
