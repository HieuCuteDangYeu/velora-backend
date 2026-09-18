"""Deterministic variant comparison over canonical summaries."""

import json
from pathlib import Path
from typing import Any


def compare_summaries(baseline: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    for summary in (baseline, candidate):
        if str(summary.get("status", "")).startswith("INVALID_"):
            raise ValueError("Invalid experiment configuration cannot be a quality baseline")

    def delta(section: str, key: str) -> float | None:
        left = baseline.get(section, {}).get(key)
        right = candidate.get(section, {}).get(key)
        return None if left is None or right is None else right - left

    def lexical_match_grounded(summary: dict[str, Any]) -> float | None:
        value = summary.get("lexicalMatchAndGrounded")
        if value is not None:
            return value
        # Summaries written before the lexical diagnostic was renamed stored
        # the same heuristic under this misleading legacy field.
        return summary.get("correctAndGrounded")

    baseline_lexical = lexical_match_grounded(baseline)
    candidate_lexical = lexical_match_grounded(candidate)

    return {
        "schemaVersion": "rag-eval-comparison-v1",
        "baselineRunId": baseline["runId"],
        "candidateRunId": candidate["runId"],
        "deltas": {
            "lexicalMatchAndGrounded": (
                None
                if baseline_lexical is None or candidate_lexical is None
                else candidate_lexical - baseline_lexical
            ),
            "recallAt5": delta("metrics", "recallAt5"),
            "mrr": delta("metrics", "mrr"),
            "faithfulness": delta("semanticMetrics", "faithfulness"),
            "p95LatencyMs": (
                None
                if baseline["latencyMs"]["endToEnd"]["p95"] is None
                or candidate["latencyMs"]["endToEnd"]["p95"] is None
                else candidate["latencyMs"]["endToEnd"]["p95"]
                - baseline["latencyMs"]["endToEnd"]["p95"]
            ),
            "averageProductionCostPerQuery": delta("cost", "averageProductionCostPerQuery"),
        },
    }


def compare_files(baseline: Path, candidate: Path) -> dict[str, Any]:
    return compare_summaries(
        json.loads(baseline.read_text(encoding="utf-8")),
        json.loads(candidate.read_text(encoding="utf-8")),
    )
