"""Validation and deterministic selection for scraped-reel benchmarks."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

SCRAPED_DATASET_PATTERN = re.compile(
    r"^rag-scraped-v\d+(?:-pilot(?:-provisional)?)?$")
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
MAX_SCRAPED_REELS = 178
TRUSTED_ANNOTATION_STATUSES = {"HUMAN_VERIFIED", "OWNER_VERIFIED"}
PROVISIONAL_ANNOTATION_STATUSES = TRUSTED_ANNOTATION_STATUSES | {
    "GENERATED_CANDIDATE"
}


def is_scraped_dataset(name: str) -> bool:
    return bool(SCRAPED_DATASET_PATTERN.fullmatch(name))


def _load_rows(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        rows: list[dict[str, Any]] = []
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}: invalid JSONL at line {line_number}") from error
            if not isinstance(row, dict):
                raise ValueError(
                    f"{path}: line {line_number} must be a JSON object"
                ) from None
            rows.append(row)
        return rows
    if isinstance(value, list) and all(isinstance(row, dict) for row in value):
        return value
    if isinstance(value, dict):
        return [value]
    raise ValueError(f"{path}: expected a JSON array or JSONL objects")


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_scraped_rows(
    rows: list[dict[str, Any]],
    *,
    dataset_version: str,
    max_reels: int = MAX_SCRAPED_REELS,
) -> list[dict[str, Any]]:
    """Validate benchmark rows without accepting synthetic references."""

    if not is_scraped_dataset(dataset_version):
        raise ValueError(f"unsupported scraped dataset version: {dataset_version}")
    if not rows:
        raise ValueError("scraped benchmark must contain at least one row")
    if len(rows) > max_reels:
        raise ValueError(f"scraped benchmark cannot exceed {max_reels} rows")

    seen_case_ids: set[str] = set()
    seen_reel_ids: set[str] = set()
    for row in rows:
        case_id = row.get("id")
        if not _nonempty_string(case_id) or case_id in seen_case_ids:
            raise ValueError(f"invalid or duplicate scraped case id: {case_id!r}")
        seen_case_ids.add(case_id)
        if row.get("datasetVersion") != dataset_version:
            raise ValueError(f"{case_id}: datasetVersion does not match {dataset_version}")
        for field in ("question", "referenceAnswer", "category", "fixtureGroup"):
            if not _nonempty_string(row.get(field)):
                raise ValueError(f"{case_id}: {field} is required")
        if row["fixtureGroup"] != "scraped-reel":
            raise ValueError(f"{case_id}: fixtureGroup must be scraped-reel")

        reel_ids = row.get("expectedReelIds")
        if not isinstance(reel_ids, list) or len(reel_ids) != 1:
            raise ValueError(f"{case_id}: exactly one expectedReelIds entry is required")
        reel_id = reel_ids[0]
        if not isinstance(reel_id, str) or not UUID_PATTERN.fullmatch(reel_id):
            raise ValueError(f"{case_id}: expectedReelIds must contain a reel UUID")
        if reel_id in seen_reel_ids:
            raise ValueError(f"{case_id}: each pilot row must represent a distinct reel")
        seen_reel_ids.add(reel_id)

        evidence_types = row.get("expectedEvidenceTypes")
        evidence_ids = row.get("relevantEvidenceIds")
        if not isinstance(evidence_types, list) or not evidence_types:
            raise ValueError(f"{case_id}: expectedEvidenceTypes is required")
        if not isinstance(evidence_ids, list) or not evidence_ids or any(
            not _nonempty_string(item) for item in evidence_ids
        ):
            raise ValueError(f"{case_id}: relevantEvidenceIds is required")

        metadata = row.get("metadata")
        if not isinstance(metadata, dict):
            raise ValueError(f"{case_id}: metadata is required")
        if not _nonempty_string(metadata.get("seriesId")):
            raise ValueError(f"{case_id}: metadata.seriesId is required for stratification")
        allowed_statuses = (
            PROVISIONAL_ANNOTATION_STATUSES
            if dataset_version.endswith("-provisional")
            else TRUSTED_ANNOTATION_STATUSES
        )
        if metadata.get("annotationStatus") not in allowed_statuses:
            raise ValueError(
                f"{case_id}: annotationStatus is not allowed for {dataset_version}"
            )
        for field in ("annotationSource", "sourceContentSha256", "indexSnapshotSha256"):
            value = metadata.get(field)
            if not _nonempty_string(value):
                raise ValueError(f"{case_id}: metadata.{field} is required")
        if not re.fullmatch(r"[0-9a-f]{64}", metadata["sourceContentSha256"], re.IGNORECASE):
            raise ValueError(f"{case_id}: sourceContentSha256 must be a SHA-256 hex digest")
        if not re.fullmatch(r"[0-9a-f]{64}", metadata["indexSnapshotSha256"], re.IGNORECASE):
            raise ValueError(f"{case_id}: indexSnapshotSha256 must be a SHA-256 hex digest")

        access_scope = row.get("accessScope")
        if not isinstance(access_scope, dict):
            raise ValueError(f"{case_id}: accessScope is required")
        if access_scope.get("authorizedReelIds") != reel_ids:
            raise ValueError(f"{case_id}: accessScope must authorize only its reel")

    return rows


def select_stratified_pilot(
    rows: list[dict[str, Any]], size: int = 20
) -> list[dict[str, Any]]:
    """Select a stable round-robin sample across series without score-shopping."""

    if size <= 0:
        raise ValueError("pilot size must be positive")
    if size > len(rows):
        raise ValueError(f"pilot size {size} exceeds available rows {len(rows)}")
    by_series: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_series[str(row["metadata"]["seriesId"])].append(row)
    queues = [sorted(items, key=lambda item: item["id"]) for _, items in sorted(by_series.items())]
    selected: list[dict[str, Any]] = []
    while len(selected) < size:
        progressed = False
        for queue in queues:
            if queue and len(selected) < size:
                selected.append(queue.pop(0))
                progressed = True
        if not progressed:
            break
    return sorted(selected, key=lambda item: item["id"])


def _with_dataset_version(row: dict[str, Any], dataset_version: str) -> dict[str, Any]:
    return {**row, "datasetVersion": dataset_version}


def build_definitions(rows: list[dict[str, Any]], dataset_version: str) -> dict[str, Any]:
    return {
        "schemaVersion": "rag-scraped-benchmark-v1",
        "datasetVersion": dataset_version,
        "ragBenchmark": {
            "datasetVersion": dataset_version,
            "caseCount": len(rows),
            "cases": [
                {
                    "caseId": row["id"],
                    "reelId": row["expectedReelIds"][0],
                    "expectedReelIds": row["expectedReelIds"],
                    "question": row["question"],
                    "referenceAnswerText": row["referenceAnswer"],
                    "expectedEvidenceType": row["expectedEvidenceTypes"][0],
                    "referenceStartSec": row["metadata"].get("referenceStartSec"),
                    "referenceEndSec": row["metadata"].get("referenceEndSec"),
                    "expectedConcepts": row["metadata"].get("expectedConcepts", []),
                }
                for row in rows
            ],
        },
    }


def build_dataset(
    input_path: Path,
    output_path: Path,
    definitions_path: Path,
    *,
    dataset_version: str = "rag-scraped-v1",
    pilot_size: int | None = None,
) -> dict[str, Any]:
    source_rows = _load_rows(input_path)
    validate_scraped_rows(source_rows, dataset_version="rag-scraped-v1")
    if pilot_size is not None and dataset_version == "rag-scraped-v1":
        dataset_version = "rag-scraped-v1-pilot"
    if pilot_size is None and len(source_rows) != MAX_SCRAPED_REELS:
        raise ValueError(
            f"full scraped benchmark requires exactly {MAX_SCRAPED_REELS} rows"
        )
    selected = (
        select_stratified_pilot(source_rows, pilot_size)
        if pilot_size is not None
        else source_rows
    )
    rows = [_with_dataset_version(row, dataset_version) for row in selected]
    validate_scraped_rows(rows, dataset_version=dataset_version)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    definitions_path.parent.mkdir(parents=True, exist_ok=True)
    definitions_path.write_text(
        json.dumps(build_definitions(rows, dataset_version), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return {
        "datasetVersion": dataset_version,
        "sourceRows": len(source_rows),
        "selectedRows": len(rows),
        "datasetSha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
        "datasetPath": str(output_path),
        "definitionsPath": str(definitions_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a validated scraped-reel RAGAS dataset")
    parser.add_argument("--input", type=Path, required=True, help="trusted annotation JSONL/JSON")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--definitions-output", type=Path, required=True)
    parser.add_argument("--dataset-version", default="rag-scraped-v1")
    parser.add_argument(
        "--pilot-size",
        type=int,
        default=None,
        help="explicitly select a deterministic stratified pilot instead of the full set",
    )
    parser.add_argument("--full", action="store_true", help="use all validated rows (default)")
    args = parser.parse_args()
    result = build_dataset(
        args.input,
        args.output,
        args.definitions_output,
        dataset_version=args.dataset_version,
        pilot_size=None if args.full else args.pilot_size,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
