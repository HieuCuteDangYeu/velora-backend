"""Ragas-backed dataset loading and immutable contract checks."""

import hashlib
import json
import os
from pathlib import Path

from ragas import Dataset

from rag_eval.schemas import EvaluationRow
from rag_eval.scraped_dataset import is_scraped_dataset, validate_scraped_rows

ROOT = Path(__file__).resolve().parents[2]
KNOWN_DATASETS = {
    "rag-frozen-ami-v1": 8,
    "rag-frozen-ami-v2": 8,
    "rag-frozen-ami-v3": 8,
    "rag-frozen-ami-v4": 8,
    "rag-generalization-v1": 104,
}
ACTIVE_FROZEN_DATASETS = {"rag-frozen-ami-v3", "rag-frozen-ami-v4"}
FROZEN_AMI_DATASET_PREFIX = "rag-frozen-ami-"


def dataset_path(name: str) -> Path:
    """Return the immutable JSONL source path for one versioned dataset."""

    root = Path(os.getenv("RAG_EVAL_DATASET_ROOT", str(ROOT)))
    return root / "datasets" / f"{name}.jsonl"


def dataset_sha256(name: str) -> str:
    """Fingerprint the exact dataset bytes used by an evaluation."""

    return hashlib.sha256(dataset_path(name).read_bytes()).hexdigest()


def is_supported_live_dataset(name: str) -> bool:
    return (
        name in ACTIVE_FROZEN_DATASETS
    ) or is_scraped_dataset(name)


def load_dataset(name: str) -> Dataset:
    if name not in KNOWN_DATASETS and not is_scraped_dataset(name):
        raise ValueError(f"unknown versioned RAG dataset: {name}")
    path = dataset_path(name)
    expected_count = KNOWN_DATASETS.get(name)
    if is_scraped_dataset(name):
        raw_rows = [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        validate_scraped_rows(raw_rows, dataset_version=name)
        expected_count = len(raw_rows)
    dataset = Dataset.load(
        name=name,
        backend="local/jsonl",
        root_dir=str(dataset_path(name).parent.parent),
        data_model=EvaluationRow,
    )
    if len(dataset) != expected_count:
        raise ValueError(f"{name} expected {expected_count} rows, found {len(dataset)}")
    return dataset
