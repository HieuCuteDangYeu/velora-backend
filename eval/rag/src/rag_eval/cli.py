"""pnpm-facing CLI with offline-safe defaults."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from rag_eval.adapters.cloudflare_judge import (
    build_capacity_client,
    capacity_message_class,
    classify_capacity_error,
)
from rag_eval.adapters.evaluation_judge import build_live_judge
from rag_eval.adapters.runner_output import (
    fixture_execution,
    invoke_typescript_runner,
    load_runner_report,
    validate_semantic_context_artifact,
    validate_trace_provenance,
)
from rag_eval.checkpoint import JudgeCheckpointStore
from rag_eval.compare import compare_files
from rag_eval.config_snapshot import load_runtime_snapshot
from rag_eval.dataset import ROOT, dataset_sha256, is_supported_live_dataset, load_dataset
from rag_eval.experiment import rag_experiment
from rag_eval.metrics.semantic import SEMANTIC_NAMES
from rag_eval.preflight import (
    first_request_tpm_headroom,
    probe_groq,
    reserve_groq_probe_requests,
    run_preflight,
    scheduler_ready,
    scheduler_snapshot,
    tpd_headroom,
)
from rag_eval.pricing import load_pricing
from rag_eval.recovery import (
    DEFAULT_TOTAL_RECOVERY_ESTIMATE_TOKENS,
    INSUFFICIENT_TPD_FOR_NEXT_OPERATION,
    DailyRecoveryDeferred,
    MultiDayRecoveryStore,
    RecoveryStateError,
    mandatory_metrics_complete,
    multiday_tpd_preflight,
    recovery_operations,
    source_provenance_fingerprint,
)
from rag_eval.reports import build_summary, load_cases, write_report
from rag_eval.schemas import EvaluationRow

RESULTS = Path(os.getenv("RAG_EVAL_RESULTS_DIR", str(ROOT / "results")))


def _rows(dataset: Any) -> dict[str, EvaluationRow]:
    return {row.id: row for row in dataset}


def validate_replay_dataset_compatibility(
    source_rows: dict[str, EvaluationRow], evaluation_rows: dict[str, EvaluationRow]
) -> None:
    if set(source_rows) != set(evaluation_rows):
        raise ValueError("evaluation dataset case IDs do not match the saved source dataset")
    immutable_fields = (
        "question",
        "expectedIntent",
        "expectedReferenceTarget",
        "expectedReelQuestionType",
        "expectedEvidenceTypes",
        "expectedReelIds",
        "relevantEvidenceIds",
        "accessScope",
    )
    for case_id, source in source_rows.items():
        evaluation = evaluation_rows[case_id]
        for field in immutable_fields:
            if getattr(source, field) != getattr(evaluation, field):
                raise ValueError(
                    f"evaluation dataset changed saved execution contract for {case_id}"
                )
        for key in ("referenceStartSec", "referenceEndSec"):
            if source.metadata.get(key) != evaluation.metadata.get(key):
                raise ValueError(f"evaluation dataset changed reference window for {case_id}")


def _dicts(experiment_result: Any) -> list[dict[str, Any]]:
    return [
        item.model_dump(mode="json") if hasattr(item, "model_dump") else dict(item)
        for item in experiment_result
    ]


def _deterministic_resume_signature(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "caseId": case.get("caseId"),
            "datasetVersion": case.get("datasetVersion"),
            "productionSha": case.get("variant", {}).get("productionSha"),
            "hardGatePassed": case.get("hardGatePassed"),
            "deterministic": case.get("deterministic"),
            "productionExecutionId": case.get("execution", {})
            .get("trace", {})
            .get("productionExecutionId"),
            "ragTraceId": case.get("execution", {}).get("trace", {}).get("ragTraceId"),
        }
        for case in sorted(cases, key=lambda item: str(item.get("caseId")))
    ]


def _reuse_saved_deterministic_report(
    directory: Path, cases: list[dict[str, Any]], run_id: str
) -> dict[str, Any]:
    try:
        existing_cases = load_cases(directory)
        summary = json.loads((directory / "summary.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("existing deterministic report is unreadable") from error
    if _deterministic_resume_signature(existing_cases) != _deterministic_resume_signature(cases):
        raise RuntimeError("existing deterministic report provenance mismatch")
    if summary.get("runId") != run_id or summary.get("caseCount") != len(cases):
        raise RuntimeError("existing deterministic report summary mismatch")
    return summary


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
        "judgeProvider": os.getenv("RAG_EVAL_JUDGE_PROVIDER"),
        "judgeModel": os.getenv("RAG_EVAL_JUDGE_MODEL"),
        "embeddingProvider": os.getenv("RAG_EVAL_EMBEDDING_PROVIDER"),
    }


def _repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT.parents[1] / path


def _saved_runner_report(run_id: str, source_report: str | None = None) -> Path:
    if source_report:
        return _repo_path(source_report)
    return ROOT.parents[1] / "test-data/reel-integration/ami/reports" / f"{run_id}.json"


def _validate_source_summary(
    path: Path,
    args: argparse.Namespace,
    expected_case_ids: set[str],
    *,
    dataset_name: str | None = None,
    source_run_id: str | None = None,
) -> dict[str, Any]:
    summary = json.loads(path.read_text(encoding="utf-8"))
    expected_dataset = dataset_name or args.dataset
    expected_run = source_run_id or args.resume
    if (
        summary.get("dataset") != expected_dataset
        or summary.get("caseCount") != len(expected_case_ids)
        or summary.get("hardGatePassed") is not True
        or summary.get("variant", {}).get("productionSha") != args.production_sha
    ):
        raise ValueError("saved deterministic summary does not match the requested source run")
    if summary.get("runId") != expected_run:
        raise ValueError("saved deterministic summary run ID does not match the source run")
    return {
        "runId": summary.get("runId"),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "datasetSha256": dataset_sha256(expected_dataset),
    }


def _export_trace_artifact(report_path: Path, output_path: Path, env_file: str | None) -> None:
    if not env_file:
        raise SystemExit("LIVE frozen evaluation requires --env-file for automatic trace export")
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
    if not _trace_export_completed(completed.stdout):
        raise RuntimeError("trace exporter completed without complete provenance")


def _trace_export_completed(stdout: str) -> bool:
    if "TRACE_PROVENANCE=COMPLETE" in stdout:
        return True
    for line in stdout.splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and payload.get("TRACE_PROVENANCE") == "COMPLETE":
            return True
    return False


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


def _recovery_path(value: str | None, default: Path) -> Path:
    return _repo_path(value) if value else default


def _positive_int_from_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _positive_float_from_env(name: str, default: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _env_true(name: str) -> bool:
    return os.getenv(name, "false").strip().lower() in {"1", "true", "yes"}


def _print_multiday_recovery(
    store: MultiDayRecoveryStore,
    checkpoint: JudgeCheckpointStore,
    *,
    total_operations: int,
    plan: dict[str, Any] | None = None,
) -> None:
    progress = store.progress(
        checkpoint.entries(),
        total_operations=total_operations,
        scheduled_operations=len((plan or {}).get("scheduledOperationKeys", [])),
        deferred_operations=(
            len((plan or {}).get("deferredOperationKeys", [])) if plan is not None else None
        ),
    )
    snapshot = store.snapshot()
    epochs = snapshot.get("epochs") or []
    latest = epochs[-1] if epochs else {}
    print(f"MULTI_DAY_RECOVERY_STATUS={snapshot.get('status', 'UNKNOWN')}")
    authorization = snapshot.get("authorization", {}).get("status", "UNKNOWN")
    print(f"MULTI_DAY_RECOVERY_AUTHORIZATION={authorization}")
    total_estimate = latest.get(
        "totalRecoveryEstimateTokens", DEFAULT_TOTAL_RECOVERY_ESTIMATE_TOKENS
    )
    print(f"TOTAL_RECOVERY_ESTIMATE_TOKENS={total_estimate}")
    safe_budget = (plan or {}).get("currentDaySafeBudgetTokens", "UNKNOWN")
    print(f"CURRENT_DAY_SAFE_BUDGET_TOKENS={safe_budget}")
    scheduled_reservation = (plan or {}).get(
        "scheduledReservationTokens", latest.get("scheduledReservationTokens", 0)
    )
    print(f"SCHEDULED_RESERVATION_TOKENS={scheduled_reservation}")
    remaining_after_reservation = (plan or {}).get(
        "currentDayRemainingAfterReservationTokens",
        latest.get("calculatedRemainingTokens", "UNKNOWN"),
    )
    print(
        "CURRENT_DAY_REMAINING_AFTER_RESERVATION_TOKENS="
        f"{remaining_after_reservation}"
    )
    remaining_estimate = (plan or {}).get("remainingRecoveryEstimateTokens", "UNKNOWN")
    print(f"REMAINING_RECOVERY_ESTIMATE_TOKENS={remaining_estimate}")
    baseline_used = latest.get("baselineCountedUsedTokens", "UNKNOWN")
    print(f"DAILY_BASELINE_COUNTED_USED_TOKENS={baseline_used}")
    print(f"DAILY_EVALUATOR_COUNTED_TOKENS={latest.get('evaluatorCountedTokens', 'UNKNOWN')}")
    print(f"DAILY_CALCULATED_REMAINING_TOKENS={latest.get('calculatedRemainingTokens', 'UNKNOWN')}")
    print(f"COMPLETED_CALLS={progress['callsCompletedToday']}")
    print(f"FAILED_CALLS={progress['callsFailedToday']}")
    print(f"PENDING_CALLS={progress['callsPendingToday']}")
    print(f"COMPLETED_CHECKPOINTS={progress['completedCalls']}")
    print(f"UNAVAILABLE_CHECKPOINTS={progress['failedCalls']}")
    print(f"DEFERRED_CALLS={progress['deferredCalls']}")
    print(f"WAITING_FOR_NEXT_TPD_WINDOW={'YES' if progress['waitingForNextTpdWindow'] else 'NO'}")
    print(f"DAILY_RECOVERY_STOP_REASON={progress['dailyRecoveryStopReason'] or 'NONE'}")
    if plan is not None:
        print(
            "CAN_RUN_SAFE_DAILY_SLICE="
            f"{'YES' if plan.get('status') == 'YES' else 'NO'}"
        )


async def run_live(args: argparse.Namespace) -> Path:
    if not args.confirm_live:
        raise SystemExit("LIVE requires --confirm-live; exactly-once runner state is authoritative")
    if not is_supported_live_dataset(args.dataset):
        raise SystemExit("live mode requires a supported rag-frozen-ami dataset")
    if not args.definitions_report:
        raise SystemExit("LIVE requires --definitions-report")
    if args.resume and not args.trace_file:
        raise SystemExit("saved live evaluation requires --trace-file")
    semantic_context_value = getattr(args, "semantic_context_file", None)
    multi_day_recovery = bool(getattr(args, "multi_day_recovery", False))
    if semantic_context_value and not (args.resume and args.trace_file):
        raise SystemExit(
            "--semantic-context-file is supported only for saved --resume evaluations"
        )
    if multi_day_recovery and not (args.resume and args.live_judge and semantic_context_value):
        raise SystemExit(
            "--multi-day-recovery requires saved --resume --live-judge with --semantic-context-file"
        )
    source_dataset_name = getattr(args, "source_dataset", None) or args.dataset
    evaluation_run_id = getattr(args, "evaluation_run_id", None)
    if source_dataset_name != args.dataset and not args.resume:
        raise SystemExit("--source-dataset is supported only for saved --resume evaluations")
    if evaluation_run_id and not args.resume:
        raise SystemExit("--evaluation-run-id is supported only for saved --resume evaluations")
    dataset = load_dataset(args.dataset)
    rows = _rows(dataset)
    source_dataset = load_dataset(source_dataset_name)
    source_rows = _rows(source_dataset)
    if source_dataset_name != args.dataset:
        validate_replay_dataset_compatibility(source_rows, rows)
    definitions_path = _repo_path(args.definitions_report)
    validate_definitions_report(str(definitions_path), source_rows)
    snapshot_path = (
        str(_repo_path(args.runtime_config_snapshot)) if args.runtime_config_snapshot else None
    )
    snapshot = load_runtime_snapshot(snapshot_path, args.production_sha, source_dataset_name)
    source_run_id, runner_args = _build_live_runner_args(args, definitions_path)
    run_id = evaluation_run_id or source_run_id
    source_attestation = None
    source_summary_path = None
    if args.resume and args.trace_file:
        source_summary_value = args.source_summary or os.getenv("RAGAS_SOURCE_SUMMARY_PATH")
        if not source_summary_value:
            raise ValueError(
                "saved live evaluation requires --source-summary or RAGAS_SOURCE_SUMMARY_PATH"
            )
        source_summary_path = _repo_path(source_summary_value)
        source_attestation = _validate_source_summary(
            source_summary_path,
            args,
            set(source_rows),
            dataset_name=source_dataset_name,
            source_run_id=source_run_id,
        )
        source_report_value = getattr(args, "source_report", None) or os.getenv(
            "RAGAS_SOURCE_REPORT_PATH"
        )
        report_path = _saved_runner_report(source_run_id, source_report_value)
        if not report_path.exists():
            raise ValueError("saved runner report is missing for the requested source run")
        saved_report = json.loads(report_path.read_text(encoding="utf-8"))
        saved_cases = saved_report.get("cases")
        saved_ids = [case.get("caseId") for case in saved_cases or []]
        if (
            saved_report.get("runId") != source_run_id
            or len(saved_ids) != len(set(saved_ids))
            or set(saved_ids) != set(source_rows)
            or any(
                case.get("status") != "EVALUATED"
                or not case.get("userMessageId")
                or not case.get("assistantMessageId")
                for case in saved_cases or []
            )
        ):
            raise ValueError("saved runner report is incomplete or mixed across source runs")
    else:
        report_path = invoke_typescript_runner(runner_args)
    trace_path = (
        _repo_path(args.trace_file) if args.trace_file else RESULTS / f"{run_id}-traces.jsonl"
    )
    if not args.trace_file:
        _export_trace_artifact(report_path, trace_path, args.env_file)
    validate_trace_provenance(trace_path, set(source_rows))
    semantic_context_rows = None
    semantic_context_binding = None
    if semantic_context_value:
        if source_summary_path is None:
            raise ValueError("semantic context binding requires a saved source summary")
        semantic_context_rows, semantic_context_binding = validate_semantic_context_artifact(
            _repo_path(semantic_context_value),
            report_path,
            trace_path,
            source_summary_path,
            source_rows,
            source_run_id=source_run_id,
            production_sha=args.production_sha,
            dataset_version=source_dataset_name,
            dataset_sha256=dataset_sha256(source_dataset_name),
        )
    elif args.resume and args.live_judge:
        raise SystemExit(
            "saved semantic judge requires --semantic-context-file"
        )
    executions = load_runner_report(
        report_path,
        rows,
        trace_path,
        require_trace=True,
        semantic_context_rows=semantic_context_rows,
    )
    missing = set(rows) - set(executions)
    if missing:
        raise RuntimeError(f"runner report omitted cases: {sorted(missing)}")
    if source_attestation and (
        len(executions) != len(rows)
        or any(
            execution.runId != source_run_id
            or execution.executionStatus != "COMPLETED"
            or not execution.trace.get("productionExecutionId")
            or not execution.trace.get("ragTraceId")
            for execution in executions.values()
        )
    ):
        raise ValueError("saved execution set is incomplete or lacks immutable provenance")
    variant = _variant(args)
    variant["configSnapshot"] = snapshot
    variant["variantName"] = snapshot["variantName"]
    variant["traceProvenance"] = "COMPLETE"
    if source_attestation:
        variant["savedSourceMode"] = "SAVED_RUN_ONLY"
        variant["sourceRunId"] = source_run_id
        variant["sourceDatasetVersion"] = source_dataset_name
        variant["sourceSummarySha256"] = source_attestation["sha256"]
        variant["sourceDatasetSha256"] = source_attestation["datasetSha256"]
    if semantic_context_binding:
        variant["semanticContextBinding"] = semantic_context_binding
    result = await rag_experiment.arun(
        dataset,
        name=run_id,
        execution_results=executions,
        variant=variant,
        semantic_suite=None,
    )
    deterministic_cases = _dicts(result)
    deterministic_directory = RESULTS / run_id
    if args.resume and deterministic_directory.exists():
        directory = deterministic_directory
        summary = _reuse_saved_deterministic_report(directory, deterministic_cases, run_id)
    else:
        directory = write_report(deterministic_cases, run_id, RESULTS)
        summary = json.loads((directory / "summary.json").read_text())
    print_terminal_summary(summary)
    if args.live_judge:
        if not summary["hardGatePassed"]:
            raise RuntimeError("deterministic hard gate failed; saved results, no judge calls made")
        if multi_day_recovery:
            ledger_value = getattr(args, "ledger_path", None) or os.getenv(
                "RAGAS_GROQ_DAILY_LEDGER_PATH"
            )
            if ledger_value:
                os.environ["RAGAS_GROQ_DAILY_LEDGER_PATH"] = str(_repo_path(ledger_value))
        semantic_suite, _client, _model = build_live_judge()
        checkpoint_value = os.getenv("RAGAS_JUDGE_CHECKPOINT_PATH")
        checkpoint_path = (
            _repo_path(checkpoint_value)
            if checkpoint_value
            else RESULTS / f"{run_id}-judge-checkpoint.json"
        )
        checkpoint = JudgeCheckpointStore(
            checkpoint_path,
            {
                "sourceRunId": source_run_id,
                "productionSha": args.production_sha,
                "datasetVersion": args.dataset,
                "sourceDatasetVersion": source_dataset_name,
                "judgeProvider": os.getenv("RAG_EVAL_JUDGE_PROVIDER", "cloudflare"),
                "judgeModel": os.getenv("RAG_EVAL_JUDGE_MODEL"),
                "evaluatorSha": variant.get("evaluatorSha"),
            },
        )
        semantic_suite.configure_checkpoint(checkpoint, checkpoint.identity)
        recovery_store: MultiDayRecoveryStore | None = None
        recovery_plan: dict[str, Any] | None = None
        total_operations = len(rows) * len(SEMANTIC_NAMES)
        if multi_day_recovery:
            if source_attestation is None or semantic_context_binding is None:
                raise RecoveryStateError(
                    "multi-day recovery requires immutable saved source provenance"
                )
            judge_provider = os.getenv("RAG_EVAL_JUDGE_PROVIDER", "cloudflare")
            judge_model = os.getenv("RAG_EVAL_JUDGE_MODEL")
            recovery_identity = {
                "sourceRunId": source_run_id,
                "productionSha": args.production_sha,
                "datasetVersion": args.dataset,
                "datasetSha256": dataset_sha256(args.dataset),
                "judgeProvider": judge_provider,
                "judgeModel": judge_model,
                "sourceProvenanceFingerprint": source_provenance_fingerprint(executions),
                "semanticContextBindingSha256": semantic_context_binding["bindingSha256"],
            }
            recovery_state_value = getattr(args, "recovery_state", None) or os.getenv(
                "RAGAS_MULTI_DAY_RECOVERY_STATE_PATH"
            )
            recovery_store = MultiDayRecoveryStore(
                _recovery_path(
                    recovery_state_value, RESULTS / f"{run_id}-multiday-recovery.json"
                ),
                recovery_identity,
                checkpoint_id=checkpoint.checkpoint_id,
            )
            operations = recovery_operations(
                rows.keys(), SEMANTIC_NAMES, checkpoint.entries()
            )
            usage_value = getattr(args, "tpd_usage_attestation", None) or os.getenv(
                "RAGAS_GROQ_TPD_USAGE_ATTESTATION_PATH"
            )
            rolling_24h_value = getattr(args, "tpd_rolling_24h_metrics", None) or os.getenv(
                "RAGAS_GROQ_TPD_ROLLING_24H_METRICS_PATH"
            )
            last_hour_value = getattr(args, "tpd_last_hour_metrics", None) or os.getenv(
                "RAGAS_GROQ_TPD_LAST_HOUR_METRICS_PATH"
            )
            metrics_observed_at = getattr(args, "tpd_metrics_observed_at", None) or os.getenv(
                "RAGAS_GROQ_TPD_METRICS_OBSERVED_AT"
            )
            metrics_all_projects = bool(
                getattr(args, "tpd_metrics_all_projects", False)
                or _env_true("RAGAS_GROQ_TPD_METRICS_ALL_PROJECTS")
            )
            empty_value = getattr(args, "tpd_empty_attestation", None) or os.getenv(
                "RAGAS_GROQ_TPD_EMPTY_ATTESTATION_PATH"
            )
            limit_value = getattr(args, "tpd_limit_attestation", None) or os.getenv(
                "RAGAS_GROQ_TPD_LIMIT_ATTESTATION_PATH"
            )
            ledger_path = os.getenv("RAGAS_GROQ_DAILY_LEDGER_PATH")
            if os.getenv("GROQ_API_KEY"):
                reserve_groq_probe_requests(
                    (str(judge_model),),
                    ledger_path,
                    run_id=f"{run_id}:preflight",
                )
            tpd = tpd_headroom(
                None,
                (str(judge_model),),
                ledger_path=ledger_path,
                limit_attestation_path=str(_repo_path(limit_value)) if limit_value else None,
                usage_attestation_path=str(_repo_path(usage_value)) if usage_value else None,
                empty_attestation_path=str(_repo_path(empty_value)) if empty_value else None,
                rolling_24h_metrics_path=(
                    str(_repo_path(rolling_24h_value)) if rolling_24h_value else None
                ),
                last_hour_metrics_path=(
                    str(_repo_path(last_hour_value)) if last_hour_value else None
                ),
                metrics_observed_at=metrics_observed_at,
                metrics_all_projects=metrics_all_projects,
            )
            recovery_plan = multiday_tpd_preflight(tpd, operations)
            if recovery_plan["status"] == "UNKNOWN":
                raise RecoveryStateError(
                    f"multi-day recovery preflight failed: {recovery_plan['reason']}"
                )
            scheduler = scheduler_snapshot("groq")
            first_tokens = _positive_int_from_env(
                "RAGAS_PREFLIGHT_FIRST_OPERATION_TOKENS",
                scheduler.get("tpmTarget") or 1,
            )
            probe_timeout = _positive_float_from_env(
                "RAGAS_PREFLIGHT_TIMEOUT_SECONDS", 10.0
            )
            api_key = os.getenv("GROQ_API_KEY")
            probes = (
                await probe_groq(
                    (str(judge_model),),
                    os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
                    api_key,
                    probe_timeout,
                )
                if api_key
                else []
            )
            tpd = tpd_headroom(
                None,
                (str(judge_model),),
                ledger_path=ledger_path,
                limit_attestation_path=str(_repo_path(limit_value)) if limit_value else None,
                usage_attestation_path=str(_repo_path(usage_value)) if usage_value else None,
                empty_attestation_path=str(_repo_path(empty_value)) if empty_value else None,
                rolling_24h_metrics_path=(
                    str(_repo_path(rolling_24h_value)) if rolling_24h_value else None
                ),
                last_hour_metrics_path=(
                    str(_repo_path(last_hour_value)) if last_hour_value else None
                ),
                metrics_observed_at=metrics_observed_at,
                metrics_all_projects=metrics_all_projects,
            )
            recovery_plan = multiday_tpd_preflight(tpd, operations)
            if recovery_plan["status"] == "UNKNOWN":
                raise RecoveryStateError(
                    f"multi-day recovery preflight failed after probe accounting: "
                    f"{recovery_plan['reason']}"
                )
            probe = probes[0] if probes else {"status": None, "headers": {}}
            provider_reachable = bool(probes and probe.get("networkReachable"))
            scheduler_pass = scheduler_ready(scheduler)
            first_headroom, first_remaining = first_request_tpm_headroom(
                probe, first_tokens
            )
            slice_pass = recovery_plan["status"] == "YES"
            preflight_pass = (
                provider_reachable and scheduler_pass and first_headroom and slice_pass
            )
            print(f"PROVIDER_REACHABLE={'YES' if provider_reachable else 'NO'}")
            print(f"TPM_SCHEDULER_READY={'YES' if scheduler_pass else 'NO'}")
            print(
                "TPM_REMAINING_TOKENS="
                f"{first_remaining if first_remaining is not None else 'UNKNOWN'}"
            )
            print(f"FIRST_REQUEST_TPM_HEADROOM={'YES' if first_headroom else 'NO'}")
            print(f"CAN_RUN_SAFE_DAILY_SLICE={'YES' if slice_pass else 'NO'}")
            print(f"PREFLIGHT_PASS={'YES' if preflight_pass else 'NO'}")
            if not provider_reachable or not scheduler_pass or not first_headroom:
                raise RecoveryStateError(
                    "multi-day recovery provider/TPM preflight failed; no judge request sent"
                )
            try:
                recovery_store.begin_epoch(recovery_plan["baseline"])
            except DailyRecoveryDeferred:
                _print_multiday_recovery(
                    recovery_store,
                    checkpoint,
                    total_operations=total_operations,
                    plan=recovery_plan,
                )
                return directory
            recovery_store.set_daily_plan(
                scheduled_operation_keys=recovery_plan["scheduledOperationKeys"],
                deferred_operation_keys=recovery_plan["deferredOperationKeys"],
                scheduled_reservation_tokens=recovery_plan["scheduledReservationTokens"],
                total_recovery_estimate_tokens=recovery_plan["totalRecoveryEstimateTokens"],
            )
            if recovery_plan["status"] == "WAITING":
                recovery_store.close_current(INSUFFICIENT_TPD_FOR_NEXT_OPERATION)
                _print_multiday_recovery(
                    recovery_store,
                    checkpoint,
                    total_operations=total_operations,
                    plan=recovery_plan,
                )
                return directory
            semantic_suite.configure_multiday_recovery(recovery_store)
        try:
            judged = await rag_experiment.arun(
                dataset,
                name=f"{run_id}-semantic",
                execution_results=executions,
                variant=variant,
                semantic_suite=semantic_suite,
            )
        except DailyRecoveryDeferred as error:
            if recovery_store is None:
                raise
            recovery_store.close_current(str(error))
            _print_multiday_recovery(
                recovery_store,
                checkpoint,
                total_operations=total_operations,
                plan=recovery_plan,
            )
            return directory
        if recovery_store is not None:
            if not mandatory_metrics_complete(checkpoint.entries(), total_operations):
                if recovery_plan and recovery_plan.get("waitingForNextTpdWindow"):
                    recovery_store.close_current(INSUFFICIENT_TPD_FOR_NEXT_OPERATION)
                _print_multiday_recovery(
                    recovery_store,
                    checkpoint,
                    total_operations=total_operations,
                    plan=recovery_plan,
                )
                if recovery_plan and recovery_plan.get("waitingForNextTpdWindow"):
                    return directory
                raise RuntimeError(
                    "semantic recovery remains incomplete after the scheduled slice; "
                    "final aggregates withheld"
                )
            recovery_store.complete()
            _print_multiday_recovery(
                recovery_store,
                checkpoint,
                total_operations=total_operations,
                plan=recovery_plan,
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
    print(
        f"Lexical match (diagnostic)     {summary['lexicalMatch']}/{summary['caseCount']}"
    )
    print(
        "Lexical match + grounded       "
        f"{summary['lexicalMatchAndGrounded']}/{summary['caseCount']}"
    )
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
    live.add_argument("--source-dataset")
    live.add_argument("--evaluation-run-id")
    live.add_argument("--definitions-report")
    live.add_argument("--env-file")
    live.add_argument("--trace-file")
    live.add_argument("--semantic-context-file")
    live.add_argument("--live-judge", action="store_true")
    live.add_argument("--multi-day-recovery", action="store_true")
    live.add_argument("--recovery-state")
    live.add_argument("--ledger-path")
    live.add_argument("--tpd-limit-attestation")
    live.add_argument("--tpd-usage-attestation")
    live.add_argument("--tpd-empty-attestation")
    live.add_argument("--tpd-rolling-24h-metrics")
    live.add_argument("--tpd-last-hour-metrics")
    live.add_argument("--tpd-metrics-observed-at")
    live.add_argument("--tpd-metrics-all-projects", action="store_true")
    live.add_argument("--runtime-config-snapshot")
    live.add_argument("--source-report")
    live.add_argument("--source-summary")
    report = commands.add_parser("report")
    report.add_argument("--run", required=True)
    compare = commands.add_parser("compare")
    compare.add_argument("--baseline", required=True)
    compare.add_argument("--candidate", required=True)
    capacity = commands.add_parser("capacity-check")
    capacity.add_argument("--confirm-one-call", action="store_true")
    preflight = commands.add_parser("preflight")
    preflight.add_argument("--models")
    preflight.add_argument("--first-model")
    preflight.add_argument("--first-operation-tokens", type=int)
    preflight.add_argument("--tpd-attestation")
    preflight.add_argument("--tpd-limit-attestation")
    preflight.add_argument("--tpd-window-attestation")
    preflight.add_argument("--tpd-cost-attestation")
    preflight.add_argument("--tpd-usage-attestation")
    preflight.add_argument("--tpd-empty-attestation")
    preflight.add_argument("--tpd-rolling-24h-metrics")
    preflight.add_argument("--tpd-last-hour-metrics")
    preflight.add_argument("--tpd-metrics-observed-at")
    preflight.add_argument("--tpd-metrics-all-projects", action="store_true")
    preflight.add_argument("--pricing-path")
    preflight.add_argument("--ledger-path")
    preflight.add_argument("--multi-day-recovery", action="store_true")
    preflight.add_argument("--recovery-operations")
    preflight.add_argument("--timeout", type=float, default=10.0)
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
    elif args.command == "preflight":
        raise SystemExit(asyncio.run(run_preflight(args)))
    else:
        raise ValueError(f"Unsupported rag-eval command: {args.command}")
