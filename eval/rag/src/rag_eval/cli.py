"""pnpm-facing CLI with offline-safe defaults."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from rag_eval.adapters.cloudflare_judge import (
    build_capacity_client,
    build_live_judge,
    capacity_message_class,
    classify_capacity_error,
)
from rag_eval.adapters.runner_output import (
    fixture_execution,
    invoke_typescript_runner,
    load_runner_report,
    validate_trace_provenance,
)
from rag_eval.compare import compare_files
from rag_eval.config_snapshot import load_runtime_snapshot
from rag_eval.dataset import ROOT, is_supported_live_dataset, load_dataset
from rag_eval.experiment import rag_experiment
from rag_eval.pricing import load_pricing
from rag_eval.reports import build_summary, load_cases, write_report
from rag_eval.schemas import EvaluationRow

RESULTS = ROOT / "results"


def _rows(dataset: Any) -> dict[str, EvaluationRow]:
    return {row.id: row for row in dataset}


def _dicts(experiment_result: Any) -> list[dict[str, Any]]:
    return [
        item.model_dump(mode="json") if hasattr(item, "model_dump") else dict(item)
        for item in experiment_result
    ]


def _variant(args: argparse.Namespace) -> dict[str, Any]:
    try:
        git_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT.parents[1],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        git_sha = "UNAVAILABLE"
    return {
        "variantName": args.variant,
        "gitSha": git_sha,
        "evaluatorSha": git_sha,
        "productionSha": args.production_sha,
        "datasetVersion": args.dataset,
        "pricingVersion": load_pricing()["version"],
        "embeddingModel": args.embedding_model,
        "routerModel": args.router_model,
        "plannerModel": args.planner_model,
        "answerModel": args.answer_model,
        "verifierModel": args.verifier_model,
        "retrievalK": args.retrieval_k,
        "rerankK": args.rerank_k,
        "promptVersion": args.prompt_version,
    }


def _repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT.parents[1] / path


def _export_trace_artifact(
    report_path: Path, output_path: Path, env_file: str | None
) -> None:
    if not env_file:
        raise SystemExit(
            "LIVE frozen evaluation requires --env-file for automatic trace export"
        )
    exporter = ROOT.parents[1] / "scripts/ops/export-rag-traces.cjs"
    completed = subprocess.run(
        [
            "node",
            str(exporter),
            "--runner-report",
            str(report_path),
            "--output",
            str(output_path),
            "--env-file",
            str(_repo_path(env_file)),
        ],
        cwd=ROOT.parents[1],
        check=True,
        capture_output=True,
        text=True,
    )
    if "TRACE_PROVENANCE=COMPLETE" not in completed.stdout:
        raise RuntimeError("trace exporter completed without complete provenance")


def _build_live_runner_args(
    args: argparse.Namespace, definitions_path: Path
) -> tuple[str, list[str]]:
    if args.run_id and args.resume:
        raise SystemExit("LIVE accepts either --run-id or --resume, not both")
    if args.resume:
        run_id = args.resume
        runner_args = ["--definitions-report", str(definitions_path), "--resume", run_id]
    else:
        run_id = args.run_id or f"ragas-live-{int(time.time())}"
        runner_args = ["--definitions-report", str(definitions_path), "--run-id", run_id]
    if args.env_file:
        runner_args += ["--env-file", str(_repo_path(args.env_file))]
    return run_id, runner_args


def _definition_reel_ids(definition: dict[str, Any]) -> list[str]:
    if isinstance(definition.get("reelId"), str):
        return [definition["reelId"]]
    expected = definition.get("expectedReelIds")
    return expected if isinstance(expected, list) else []


def validate_definitions_report(path: str, rows: dict[str, EvaluationRow]) -> None:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    definitions = payload.get("ragBenchmark", {}).get("cases")
    if not isinstance(definitions, list) or len(definitions) != len(rows):
        raise ValueError("definitions report case count does not match the selected dataset")
    by_id = {item.get("caseId"): item for item in definitions}
    if set(by_id) != set(rows):
        raise ValueError("definitions report case IDs do not match the selected dataset")
    for case_id, row in rows.items():
        definition = by_id[case_id]
        if definition.get("question") != row.question:
            raise ValueError(f"definitions report question mismatch for {case_id}")
        if definition.get("referenceAnswerText") != row.referenceAnswer:
            raise ValueError(f"definitions report reference mismatch for {case_id}")
        if sorted(set(_definition_reel_ids(definition))) != sorted(set(row.expectedReelIds)):
            raise ValueError(f"definitions report reel mismatch for {case_id}")
        if (
            row.expectedEvidenceTypes
            and definition.get("expectedEvidenceType") != row.expectedEvidenceTypes[0]
        ):
            raise ValueError(f"definitions report evidence type mismatch for {case_id}")
        if definition.get("referenceStartSec") != row.metadata.get(
            "referenceStartSec"
        ) or definition.get("referenceEndSec") != row.metadata.get("referenceEndSec"):
            raise ValueError(f"definitions report reference window mismatch for {case_id}")


async def run_offline(args: argparse.Namespace) -> Path:
    dataset = load_dataset(args.dataset)
    rows = _rows(dataset)
    run_id = args.run_id or f"offline-{args.dataset}-{int(time.time())}"
    variant = _variant(args)
    executions = {case_id: fixture_execution(row, run_id, variant) for case_id, row in rows.items()}
    result = await rag_experiment.arun(
        dataset,
        name=run_id,
        execution_results=executions,
        variant=variant,
    )
    directory = write_report(_dicts(result), run_id, RESULTS)
    summary = json.loads((directory / "summary.json").read_text(encoding="utf-8"))
    print_terminal_summary(summary)
    print(f"SAMPLE_RAGAS_RUN_ID={run_id}")
    print(f"SAMPLE_RAGAS_REPORT_PATH={directory}")
    return directory


async def run_live(args: argparse.Namespace) -> Path:
    if not args.confirm_live:
        raise SystemExit("LIVE requires --confirm-live; exactly-once runner state is authoritative")
    if not is_supported_live_dataset(args.dataset):
        raise SystemExit("live mode requires a supported rag-frozen-ami dataset")
    if not args.definitions_report:
        raise SystemExit("LIVE requires --definitions-report")
    dataset = load_dataset(args.dataset)
    rows = _rows(dataset)
    definitions_path = _repo_path(args.definitions_report)
    validate_definitions_report(str(definitions_path), rows)
    snapshot_path = (
        str(_repo_path(args.runtime_config_snapshot)) if args.runtime_config_snapshot else None
    )
    snapshot = load_runtime_snapshot(snapshot_path, args.production_sha, args.dataset)
    run_id, runner_args = _build_live_runner_args(args, definitions_path)
    report_path = invoke_typescript_runner(runner_args)
    trace_path = (
        _repo_path(args.trace_file)
        if args.trace_file
        else RESULTS / f"{run_id}-traces.jsonl"
    )
    if not args.trace_file:
        _export_trace_artifact(report_path, trace_path, args.env_file)
    validate_trace_provenance(trace_path, set(rows))
    executions = load_runner_report(
        report_path, rows, trace_path, require_trace=True
    )
    missing = set(rows) - set(executions)
    if missing:
        raise RuntimeError(f"runner report omitted cases: {sorted(missing)}")
    variant = _variant(args)
    variant["configSnapshot"] = snapshot
    variant["variantName"] = snapshot["variantName"]
    variant["traceProvenance"] = "COMPLETE"
    result = await rag_experiment.arun(
        dataset,
        name=run_id,
        execution_results=executions,
        variant=variant,
        semantic_suite=None,
    )
    directory = write_report(_dicts(result), run_id, RESULTS)
    summary = json.loads((directory / "summary.json").read_text())
    print_terminal_summary(summary)
    if args.live_judge:
        if not summary["hardGatePassed"]:
            raise RuntimeError("deterministic hard gate failed; saved results, no judge calls made")
        semantic_suite, _client, _model = build_live_judge()
        judged = await rag_experiment.arun(
            dataset,
            name=f"{run_id}-semantic",
            execution_results=executions,
            variant=variant,
            semantic_suite=semantic_suite,
        )
        directory = write_report(_dicts(judged), f"{run_id}-semantic", RESULTS)
    return directory


def print_terminal_summary(summary: dict[str, Any]) -> None:
    metric = summary["metrics"]
    semantic = summary["semanticMetrics"]
    cost = summary["cost"]
    latency = summary["latencyMs"]["endToEnd"]
    print("RAG Evaluation")
    print("-" * 50)
    print(f"Dataset                        {summary['dataset']}")
    print(f"Variant                        {summary['variant'].get('variantName')}")
    print(f"Cases                          {summary['caseCount']}")
    print(f"Correct                        {summary['correct']}/{summary['caseCount']}")
    print(f"Correct + grounded             {summary['correctAndGrounded']}/{summary['caseCount']}")
    print(f"Faithfulness                   {semantic.get('faithfulness')}")
    print(f"Factual Correctness            {semantic.get('factual_correctness')}")
    print(f"Response Relevancy             {semantic.get('response_relevancy')}")
    print(f"Context Precision              {semantic.get('context_precision')}")
    print(f"Context Recall                 {semantic.get('context_recall')}")
    print(f"Recall@5                       {metric.get('recallAt5')}")
    print(f"MRR                            {metric.get('mrr')}")
    print(f"Access Violations              {summary['accessControlViolations']}")
    print(f"P50 latency                    {latency.get('p50')}")
    print(f"P95 latency                    {latency.get('p95')}")
    print(f"Production Query Cost          {cost.get('totalQueryCostUsd')}")
    print(f"Evaluation Judge Cost          {cost.get('evaluationJudgeCostUsd')}")
    print("-" * 50)


def run_report(args: argparse.Namespace) -> None:
    directory = RESULTS / args.run
    cases = load_cases(directory)
    summary = build_summary(cases, args.run)
    print_terminal_summary(summary)


def run_compare(args: argparse.Namespace) -> None:
    comparison = compare_files(
        RESULTS / args.baseline / "summary.json", RESULTS / args.candidate / "summary.json"
    )
    print(json.dumps(comparison, indent=2, sort_keys=True))


async def run_capacity_check(args: argparse.Namespace) -> None:
    if not args.confirm_one_call and os.getenv("RAG_EVAL_CAPACITY_CHECK_CONFIRM") != "YES":
        raise SystemExit(
            "capacity check requires --confirm-one-call and performs exactly one provider call"
        )
    client, model = build_capacity_client()
    try:
        await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "Reply OK."}],
            max_tokens=2,
            temperature=0,
        )
    except Exception as error:
        status = getattr(error, "status_code", None)
        body = getattr(error, "body", {}) or {}
        provider: Any = body
        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            provider = body["error"]
        elif isinstance(body, dict) and isinstance(body.get("errors"), list):
            provider = body["errors"][0] if body["errors"] else {}
        code = provider.get("code") if isinstance(provider, dict) else None
        message = provider.get("message", "") if isinstance(provider, dict) else ""
        category = classify_capacity_error(status, code, message)
        response = getattr(error, "response", None)
        retry_after = response.headers.get("retry-after") if response is not None else None
        transient = category != "ACCOUNT_LIMITED" and status in {
            408,
            429,
            500,
            502,
            503,
            504,
        }
        print(f"CAPACITY_CHECK_STATUS=HTTP_{status or 'UNKNOWN'}")
        print(f"CAPACITY_CHECK_PROVIDER_CODE={code if code is not None else 'null'}")
        print(f"CAPACITY_CHECK_MESSAGE_CLASS={capacity_message_class(message)}")
        print(f"CAPACITY_CHECK_RETRY_AFTER={retry_after or 'null'}")
        print(f"CAPACITY_CHECK_TRANSIENT={str(transient).lower()}")
        print("CAPACITY_AVAILABLE=NO")
        print(f"PROVIDER_CATEGORY={category}")
        return
    print("CAPACITY_CHECK_STATUS=HTTP_200")
    print("CAPACITY_CHECK_PROVIDER_CODE=null")
    print("CAPACITY_CHECK_MESSAGE_CLASS=SUCCESS")
    print("CAPACITY_CHECK_RETRY_AFTER=null")
    print("CAPACITY_CHECK_TRANSIENT=false")
    print("CAPACITY_AVAILABLE=YES")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="rag-eval")
    commands = root.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--dataset", default="rag-frozen-ami-v1")
    common.add_argument("--variant", default="offline-fixture")
    common.add_argument("--run-id")
    common.add_argument("--production-sha")
    common.add_argument("--embedding-model")
    common.add_argument("--router-model")
    common.add_argument("--planner-model")
    common.add_argument("--answer-model")
    common.add_argument("--verifier-model")
    common.add_argument("--retrieval-k", type=int)
    common.add_argument("--rerank-k", type=int)
    common.add_argument("--prompt-version")
    commands.add_parser("offline", parents=[common])
    live = commands.add_parser("live", parents=[common])
    live.add_argument("--confirm-live", action="store_true")
    live.add_argument("--resume")
    live.add_argument("--definitions-report")
    live.add_argument("--env-file")
    live.add_argument("--trace-file")
    live.add_argument("--live-judge", action="store_true")
    live.add_argument("--runtime-config-snapshot")
    report = commands.add_parser("report")
    report.add_argument("--run", required=True)
    compare = commands.add_parser("compare")
    compare.add_argument("--baseline", required=True)
    compare.add_argument("--candidate", required=True)
    capacity = commands.add_parser("capacity-check")
    capacity.add_argument("--confirm-one-call", action="store_true")
    return root


def main() -> None:
    args = parser().parse_args()
    if args.command == "offline":
        asyncio.run(run_offline(args))
    elif args.command == "live":
        asyncio.run(run_live(args))
    elif args.command == "report":
        run_report(args)
    elif args.command == "compare":
        run_compare(args)
    elif args.command == "capacity-check":
        asyncio.run(run_capacity_check(args))
    else:
        raise ValueError(f"Unsupported rag-eval command: {args.command}")
