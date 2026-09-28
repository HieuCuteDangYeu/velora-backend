import json

import pytest

from rag_eval.scraped_dataset import (
    build_dataset,
    build_definitions,
    is_scraped_dataset,
    select_stratified_pilot,
    validate_scraped_rows,
)


def _row(index: int, series: str) -> dict:
    reel_id = f"{index:08d}-aaaa-4aaa-8aaa-{'a' * 12}"
    return {
        "id": f"SCRAPED-{index:03d}",
        "datasetVersion": "rag-scraped-v1",
        "question": f"What is stated in reel {index}?",
        "referenceAnswer": f"Verified answer {index}.",
        "expectedIntent": "REEL_VIDEO_QUESTION",
        "expectedReferenceTarget": "SHARED_REEL",
        "expectedReelQuestionType": "TRANSCRIPT_CONTENT",
        "expectedEvidenceTypes": ["TRANSCRIPT"],
        "expectedReelIds": [reel_id],
        "relevantEvidenceIds": [f"reel:{reel_id}:chunk:0"],
        "accessScope": {
            "policy": "AUTHORIZED_CONTEXT_ONLY",
            "authorizedReelIds": [reel_id],
        },
        "tags": ["scraped", "transcript"],
        "category": "transcript",
        "language": "en",
        "fixtureGroup": "scraped-reel",
        "metadata": {
            "seriesId": series,
            "annotationStatus": "OWNER_VERIFIED",
            "annotationSource": "test-fixture",
            "sourceContentSha256": "a" * 64,
            "indexSnapshotSha256": "b" * 64,
        },
    }


def test_scraped_contract_requires_trusted_provenance_and_is_versioned():
    rows = [_row(1, "series-a")]
    assert is_scraped_dataset("rag-scraped-v1")
    assert is_scraped_dataset("rag-scraped-v1-pilot")
    assert not is_scraped_dataset("rag-scraped-current")
    validate_scraped_rows(rows, dataset_version="rag-scraped-v1")

    rows[0]["referenceAnswer"] = ""
    with pytest.raises(ValueError, match="referenceAnswer"):
        validate_scraped_rows(rows, dataset_version="rag-scraped-v1")


def test_pilot_selection_is_stable_and_round_robin_across_series():
    rows = [_row(index, f"series-{index % 3}") for index in range(1, 10)]
    selected = select_stratified_pilot(rows, size=6)
    assert [row["id"] for row in selected] == [
        "SCRAPED-001",
        "SCRAPED-002",
        "SCRAPED-003",
        "SCRAPED-004",
        "SCRAPED-005",
        "SCRAPED-006",
    ]
    assert {row["metadata"]["seriesId"] for row in selected} == {
        "series-0",
        "series-1",
        "series-2",
    }


def test_builder_writes_dataset_and_runner_definitions(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_text("\n".join(json.dumps(_row(index, "series-a")) for index in range(1, 3)))
    output = tmp_path / "rag-scraped-v1-pilot.jsonl"
    definitions = tmp_path / "definitions.json"

    result = build_dataset(source, output, definitions, pilot_size=2)

    assert result["selectedRows"] == 2
    assert len(output.read_text().splitlines()) == 2
    payload = json.loads(definitions.read_text())
    assert payload["ragBenchmark"]["datasetVersion"] == "rag-scraped-v1-pilot"
    assert payload["ragBenchmark"]["caseCount"] == 2
    assert build_definitions([_row(1, "series-a")], "rag-scraped-v1")["ragBenchmark"][
        "caseCount"
    ] == 1


def test_full_builder_refuses_a_partial_source_set(tmp_path):
    source = tmp_path / "source.jsonl"
    source.write_text(json.dumps(_row(1, "series-a")))

    with pytest.raises(ValueError, match="exactly 178 rows"):
        build_dataset(
            source,
            tmp_path / "rag-scraped-v1.jsonl",
            tmp_path / "definitions.json",
            dataset_version="rag-scraped-v1",
            pilot_size=None,
        )
