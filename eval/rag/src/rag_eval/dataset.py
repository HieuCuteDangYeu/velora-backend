"""Ragas-backed dataset loading and immutable contract checks."""

import hashlib
from pathlib import Path

from ragas import Dataset

from rag_eval.schemas import EvaluationRow

ROOT = Path(__file__).resolve().parents[2]
KNOWN_DATASETS = {
    "rag-frozen-ami-v1": 8,
    "rag-frozen-ami-v2": 8,
    "rag-frozen-ami-v3": 8,
    "rag-generalization-v1": 104,
}
FROZEN_AMI_DATASET_PREFIX = "rag-frozen-ami-"


def dataset_path(name: str) -> Path:
    """Return the immutable JSONL source path for one versioned dataset."""

    return ROOT / "datasets" / f"{name}.jsonl"


def dataset_sha256(name: str) -> str:
    """Fingerprint the exact dataset bytes used by an evaluation."""

    return hashlib.sha256(dataset_path(name).read_bytes()).hexdigest()


def is_supported_live_dataset(name: str) -> bool:
    return name in KNOWN_DATASETS and name.startswith(FROZEN_AMI_DATASET_PREFIX)


def load_dataset(name: str) -> Dataset:
    if name not in KNOWN_DATASETS:
        raise ValueError(f"unknown versioned RAG dataset: {name}")
    dataset = Dataset.load(
        name=name,
        backend="local/jsonl",
        root_dir=str(ROOT),
        data_model=EvaluationRow,
    )
    if len(dataset) != KNOWN_DATASETS[name]:
        raise ValueError(f"{name} expected {KNOWN_DATASETS[name]} rows, found {len(dataset)}")
    return dataset
