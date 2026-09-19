import hashlib
import json
from pathlib import Path

from rag_eval.dataset import load_dataset


def test_versioned_dataset_counts_and_frozen_contract():
    frozen = list(load_dataset("rag-frozen-ami-v1"))
    frozen_v2 = list(load_dataset("rag-frozen-ami-v2"))
    frozen_v3 = list(load_dataset("rag-frozen-ami-v3"))
    frozen_v4 = list(load_dataset("rag-frozen-ami-v4"))
    generic = list(load_dataset("rag-generalization-v1"))
    assert len(frozen) == 8
    assert len(frozen_v2) == 8
    assert len(frozen_v3) == 8
    assert len(frozen_v4) == 8
    assert len(generic) == 104
    assert [row.id for row in frozen] == [
        "IN1001-1",
        "IN1001-2",
        "IN1002-1",
        "IN1002-2",
        "IN1005-1",
        "IN1005-2",
        "IN1007-1",
        "IN1007-2",
    ]
    assert frozen[0].question == "Who is the video shot detector being presented to?"
    assert frozen[-1].referenceAnswer == "Down to about twelve bands."
    assert [row.id for row in frozen_v2] == [row.id for row in frozen]
    assert [row.id for row in frozen_v3] == [row.id for row in frozen_v2]
    assert [row.id for row in frozen_v4] == [row.id for row in frozen_v3]
    assert all(row.datasetVersion == "rag-frozen-ami-v2" for row in frozen_v2)
    assert all(row.datasetVersion == "rag-frozen-ami-v3" for row in frozen_v3)
    assert all(row.datasetVersion == "rag-frozen-ami-v4" for row in frozen_v4)
    assert sum(row.fixtureGroup == "router" for row in generic) == 65
    assert sum(row.fixtureGroup == "sufficiency" for row in generic) == 20
    assert sum(row.fixtureGroup == "verifier" for row in generic) == 15


def test_frozen_v2_preserves_semantics_and_uses_verified_index_snapshot():
    v1 = {row.id: row for row in load_dataset("rag-frozen-ami-v1")}
    v2 = {row.id: row for row in load_dataset("rag-frozen-ami-v2")}
    snapshot = json.loads(
        Path(__file__).parents[1]
        .joinpath("datasets/rag-frozen-ami-v2-index-snapshot.json")
        .read_text()
    )
    evidence = {
        item["id"]: item
        for reel in snapshot["reels"].values()
        for item in reel["evidence"]
    }
    old_reel_ids = {
        reel_id for row in v1.values() for reel_id in row.expectedReelIds
    }

    assert set(v2) == set(v1)
    assert len({reel_id for row in v2.values() for reel_id in row.expectedReelIds}) == 4
    assert not old_reel_ids.intersection(
        reel_id for row in v2.values() for reel_id in row.expectedReelIds
    )
    for case_id, old in v1.items():
        new = v2[case_id]
        assert new.question == old.question
        assert new.referenceAnswer == old.referenceAnswer
        assert new.expectedIntent == old.expectedIntent
        assert new.expectedReferenceTarget == old.expectedReferenceTarget
        assert new.expectedReelQuestionType == old.expectedReelQuestionType
        assert new.expectedEvidenceTypes == old.expectedEvidenceTypes
        assert new.category == old.category
        assert new.language == old.language
        assert new.fixtureGroup == old.fixtureGroup
        assert new.tags == old.tags
        assert new.accessScope == old.accessScope
        assert new.metadata["referenceStartSec"] == old.metadata["referenceStartSec"]
        assert new.metadata["referenceEndSec"] == old.metadata["referenceEndSec"]
        assert new.metadata["expectedConcepts"] == old.metadata["expectedConcepts"]
        assert new.metadata["previousDatasetVersion"] == "rag-frozen-ami-v1"
        assert new.metadata["productionBootstrapSha"] == (
            "1b1a87ae56688c6bf51e5a3db077d3f5b5916632"
        )
        assert all(
            evidence[evidence_id]["active"]
            and evidence[evidence_id]["reelId"] == new.expectedReelIds[0]
            for evidence_id in new.relevantEvidenceIds
        )


def test_frozen_v3_preserves_semantics_and_tracks_current_canonical_index():
    v2 = {row.id: row for row in load_dataset("rag-frozen-ami-v2")}
    v3 = {row.id: row for row in load_dataset("rag-frozen-ami-v3")}
    snapshot_path = Path(__file__).parents[1].joinpath(
        "datasets/rag-frozen-ami-v3-index-snapshot.json"
    )
    snapshot = json.loads(snapshot_path.read_text())
    evidence = {
        item["id"]: item
        for reel in snapshot["reels"].values()
        for item in reel["evidence"]
    }

    assert set(v3) == set(v2)
    assert len(snapshot["reels"]) == 4
    assert snapshot["datasetVersion"] == "rag-frozen-ami-v3"
    assert snapshot["productionSha"] == "6d781cae89790e56a437edc780e883e6943c5469"
    assert snapshot["indexIdentity"] == {
        "provider": "self-hosted-tei",
        "model": "BAAI/bge-m3",
        "version": "bge-m3-tei-v1",
        "dimensions": 1024,
        "indexVersion": "reel-index-v2",
    }

    semantic_fields = (
        "question",
        "referenceAnswer",
        "expectedIntent",
        "expectedReferenceTarget",
        "expectedReelQuestionType",
        "expectedEvidenceTypes",
        "expectedReelIds",
        "language",
        "category",
        "tags",
        "accessScope",
        "fixtureGroup",
    )
    changed_evidence_cases = []
    for case_id, old in v2.items():
        new = v3[case_id]
        for field in semantic_fields:
            assert getattr(new, field) == getattr(old, field)
        for metadata_key in ("referenceStartSec", "referenceEndSec", "expectedConcepts"):
            assert new.metadata[metadata_key] == old.metadata[metadata_key]
        if new.relevantEvidenceIds != old.relevantEvidenceIds:
            changed_evidence_cases.append(case_id)
        assert new.metadata["immutable"] is True
        assert new.metadata["previousDatasetVersion"] == "rag-frozen-ami-v2"
        assert new.metadata["productionBootstrapSha"] == snapshot["productionSha"]
        assert new.metadata["indexVersion"] == "reel-index-v2"
        assert new.metadata["indexEmbeddingProvider"] == "self-hosted-tei"
        assert new.metadata["indexEmbeddingModel"] == "BAAI/bge-m3"
        assert new.metadata["indexEmbeddingVersion"] == "bge-m3-tei-v1"
        assert new.metadata["indexEmbeddingDimensions"] == 1024
        assert new.metadata["indexAttemptId"] == next(
            reel["indexAttemptId"]
            for reel in snapshot["reels"].values()
            if reel["reelId"] == new.expectedReelIds[0]
        )
        for evidence_id in new.relevantEvidenceIds:
            item = evidence[evidence_id]
            assert item["active"] is True
            assert item["reelId"] == new.expectedReelIds[0]
            assert item["embeddingProvider"] == "self-hosted-tei"
            assert item["embeddingModel"] == "BAAI/bge-m3"
            assert item["embeddingVersion"] == "bge-m3-tei-v1"
            assert item["embeddingDimensions"] == 1024
            assert item["indexVersion"] == "reel-index-v2"
    assert changed_evidence_cases == ["IN1001-1", "IN1001-2"]
    assert all(
        item["embeddingVersion"] != "cf-bge-m3-v1"
        for item in evidence.values()
    )


def test_frozen_v4_uses_self_contained_factual_correctness_references():
    v3 = {row.id: row for row in load_dataset("rag-frozen-ami-v3")}
    v4 = {row.id: row for row in load_dataset("rag-frozen-ami-v4")}
    expected_references = {
        "IN1001-1": "The video shot detector is being presented to Olivier.",
        "IN1001-2": (
            "The video shot detector project was carried out during an internship at EDIAP "
            "under Jean-Marc's supervision."
        ),
        "IN1002-1": "They protect the data by keeping backups in different physical places.",
        "IN1002-2": (
            "They say CDs are not enough for backups because one CD holds less than one gigabyte."
        ),
        "IN1005-1": (
            "Someone tells the algorithm that the two marbles share a salient feature and should "
            "be in the same cluster."
        ),
        "IN1005-2": "The example label used for the marble put into a bag is blue.",
        "IN1007-1": "The speaker is currently using fifteen frequency bands.",
        "IN1007-2": (
            "The speaker says the number of bands can go down to about twelve and still be okay."
        ),
    }

    assert set(v4) == set(v3) == set(expected_references)
    for case_id, old in v3.items():
        new = v4[case_id]
        assert new.referenceAnswer == expected_references[case_id]
        assert new.question == old.question
        assert new.expectedIntent == old.expectedIntent
        assert new.expectedReferenceTarget == old.expectedReferenceTarget
        assert new.expectedReelQuestionType == old.expectedReelQuestionType
        assert new.expectedEvidenceTypes == old.expectedEvidenceTypes
        assert new.expectedReelIds == old.expectedReelIds
        assert new.relevantEvidenceIds == old.relevantEvidenceIds
        assert new.metadata["immutable"] is True
        assert new.metadata["previousDatasetVersion"] == "rag-frozen-ami-v3"
        assert new.metadata["replacementReason"] == (
            "SELF_CONTAINED_FACTUAL_CORRECTNESS_REFERENCES"
        )

    assert v4["IN1001-2"].metadata["expectedConcepts"] == [
        "EDIAP",
        "Jean-Marc",
        "internship",
    ]


def test_historical_frozen_files_remain_byte_identical():
    dataset_root = Path(__file__).parents[1].joinpath("datasets")

    def digest(name):
        return hashlib.sha256(dataset_root.joinpath(name).read_bytes()).hexdigest()

    assert digest("rag-frozen-ami-v1.jsonl") == (
        "3b18b6c92dcd3208bf60439359da3d8eded0bd390004a754311c036a926c3d2b"
    )
    assert digest("rag-frozen-ami-v2.jsonl") == (
        "a987586845c84a7cc16b083d64706603d2cce165d69c4c602316b8db90e9f5ee"
    )
    assert digest("rag-frozen-ami-v2-index-snapshot.json") == (
        "7449f0a22f9d580076924195025358562b016105a670cf4a049e919393986ff6"
    )
    assert digest("rag-frozen-ami-v3.jsonl") == (
        "856e34483522da55e8d09cf0ab542b29add224f49572ae98f363a9db2520d391"
    )
    assert digest("rag-frozen-ami-v3-index-snapshot.json") == (
        "dcaf9b73a67ce0e872a4731912161e9a81f6d7822b1586539deb45c8e645061f"
    )
    assert digest("rag-frozen-ami-v4.jsonl") == (
        "1af3b6762bea8ea13dfcf361ccf5552a7be3ccd9967fb870d2a78a95831bfc32"
    )


def test_generic_dataset_has_required_analysis_slices():
    tags = {tag for row in load_dataset("rag-generalization-v1") for tag in row.tags}
    assert {
        "routing",
        "transcript",
        "visual",
        "metadata",
        "quantitative",
        "causal",
        "relation",
        "summary",
        "multilingual",
        "noisy-asr",
        "normal-chat",
        "access-control",
        "provider-failure",
    } <= tags
