#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const {
  EVALUATOR_VERSION,
  fingerprint,
} = require('./rag-evaluation-contract.cjs');

const {
  JudgePoolController,
  DEFAULT_GROQ_MODEL,
  judgeFingerprint,
} = require('./rag-semantic-judge.cjs');
const {
  DIMENSIONS,
  isApplicable,
} = require('./rag-evaluation-applicability.cjs');
const { dimensionAvailability } = require('./rag-semantic-eligibility.cjs');

const ELIGIBILITY_POLICY = 'dimension-evidence-v3';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith('--')) continue;
    const [name, inlineValue] = value.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      args[name] = inlineValue;
    } else {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        index += 1;
        args[name] = next;
      } else {
        args[name] = true;
      }
    }
  }
  return args;
}

function loadJson(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function semanticTaskMetadata(item) {
  return {
    answerType:
      typeof item?.metadata?.answerType === 'string'
        ? item.metadata.answerType.trim().slice(0, 80)
        : 'UNSPECIFIED',
    policyAssertions: Array.isArray(item?.expectedOutput?.assertions)
      ? item.expectedOutput.assertions
          .filter((assertion) => typeof assertion === 'string')
          .slice(0, 8)
          .map((assertion) => assertion.trim().slice(0, 240))
      : [],
    expectedEvidenceTypes: Array.isArray(
      item?.expectedOutput?.expectedEvidenceTypes,
    )
      ? item.expectedOutput.expectedEvidenceTypes
          .filter((type) => typeof type === 'string')
          .slice(0, 4)
          .map((type) => type.trim().slice(0, 32))
      : [],
  };
}

function saveJsonAtomic(filePath, data) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmpPath = `${resolved}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, resolved);
}

function computeStats(values) {
  if (!values.length) return { mean: 0, median: 0, min: 0, max: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    mean: Math.round((sum / sorted.length) * 10000) / 10000,
    median: Math.round(median * 10000) / 10000,
    min: Math.round(sorted[0] * 10000) / 10000,
    max: Math.round(sorted[sorted.length - 1] * 10000) / 10000,
    count: sorted.length,
  };
}

function availableStats(values) {
  return values.length
    ? computeStats(values)
    : { mean: null, median: null, min: null, max: null, count: 0 };
}
function formatMetric(value) {
  return value === null ? 'UNAVAILABLE' : value.toFixed(4);
}

async function publishSemanticScores({
  datasetRunId,
  caseEvaluations,
  langfuseClient,
}) {
  const client =
    langfuseClient ||
    new (require('@langfuse/client').LangfuseClient)({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL,
    });

  let published = 0;
  try {
    for (const [caseId, evaluation] of Object.entries(caseEvaluations)) {
      if (!evaluation || evaluation.error || !evaluation.traceId) continue;

      const metrics = [
        {
          name: 'faithfulness',
          score: evaluation.faithfulness?.score,
          reasoning: evaluation.faithfulness?.reasoning,
        },
        {
          name: 'factual_correctness',
          score: evaluation.factualCorrectness?.score,
          reasoning: evaluation.factualCorrectness?.reasoning,
        },
        {
          name: 'response_relevancy',
          score: evaluation.responseRelevancy?.score,
          reasoning: evaluation.responseRelevancy?.reasoning,
        },
        {
          name: 'context_completeness',
          score: evaluation.contextCompleteness?.score,
          reasoning: evaluation.contextCompleteness?.reasoning,
        },
      ];

      for (const m of metrics) {
        const item = evaluation.datasetItem;
        if (
          item &&
          !isApplicable(
            item,
            m.name === 'factual_correctness'
              ? 'factualCorrectness'
              : m.name === 'response_relevancy'
                ? 'responseRelevancy'
                : m.name === 'context_completeness'
                  ? 'contextCompleteness'
                  : 'faithfulness',
          )
        )
          continue;
        if (typeof m.score !== 'number') continue;

        client.score.create({
          traceId: evaluation.traceId,
          ...(evaluation.observationId
            ? { observationId: evaluation.observationId }
            : {}),
          name: m.name,
          value: m.score,
          dataType: 'NUMERIC',
          comment: m.reasoning,
          metadata: {
            caseId,
            evaluatorVersion: EVALUATOR_VERSION,
            datasetRunId,
            provider: evaluation.provider,
            model: evaluation.model,
          },
        });

        published += 1;
        // Also publish with standard prefix semantic_ for unambiguous filtering
        client.score.create({
          traceId: evaluation.traceId,
          ...(evaluation.observationId
            ? { observationId: evaluation.observationId }
            : {}),
          name: `semantic_${m.name}`,
          value: m.score,
          dataType: 'NUMERIC',
          comment: m.reasoning,
          metadata: {
            caseId,
            evaluatorVersion: EVALUATOR_VERSION,
            datasetRunId,
            provider: evaluation.provider,
            model: evaluation.model,
          },
        });
      }
    }
    await client.flush();
    return published;
  } finally {
    await client.shutdown();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  dotenv.config({ quiet: true });

  let statePath = args.state;
  if (!statePath) {
    const defaultState = '.benchmarks/langfuse-live-220-20261002-14.state.json';
    if (fs.existsSync(defaultState)) {
      statePath = defaultState;
    } else {
      throw new Error(
        'Usage: run-semantic-judge --state <path/to/.state.json> [--publish] [--concurrency <N>] [--limit <N>]',
      );
    }
  }

  const state = loadJson(statePath);
  const runId =
    state.runId || path.basename(statePath).replace(/\.state\.json$/, '');
  const datasetName =
    state.datasetName || args.dataset || 'velora/rag-scraped-v1-provisional';
  const outputPath =
    args.output ||
    path.join(
      path.dirname(statePath),
      [runId, EVALUATOR_VERSION].join('.') + '.json',
    );
  const casesOutputPath =
    args['cases-output'] ||
    path.join(
      path.dirname(outputPath),
      'semantic-cases-' + EVALUATOR_VERSION + '.jsonl',
    );
  const ledgerDir =
    args.ledger ||
    path.join(
      path.dirname(statePath),
      'judge-ledgers',
      `${runId}-${EVALUATOR_VERSION}`,
    );

  const concurrency = Math.max(
    1,
    Math.min(4, Number.parseInt(args.concurrency ?? '2', 10) || 2),
  );
  const limit = args.limit ? Number.parseInt(args.limit, 10) : Infinity;

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const lockPath = `${path.resolve(outputPath)}.lock`;
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  try {
    console.log(`[Judge] Initializing LLM-as-a-Judge for Run: ${runId}`);
    console.log(`[Judge] State: ${statePath}`);
    console.log(`[Judge] Output: ${outputPath}`);
    console.log(`[Judge] Concurrency: ${concurrency}`);

    // Load existing semantic results if available for resumption
    let semanticData = {
      schemaVersion: EVALUATOR_VERSION,
      evaluatorVersion: EVALUATOR_VERSION,
      eligibilityPolicy: ELIGIBILITY_POLICY,
      judgeFingerprint: judgeFingerprint(),
      sourceStateFingerprint: fingerprint(state),
      runId,
      datasetName,
      datasetRunId: state.datasetRunId || null,
      totalCases: 0,
      unavailableCases: 0,
      evaluatedCases: 0,
      metrics: {},
      cases: {},
      startedAt: new Date().toISOString(),
      completedAt: null,
    };

    if (fs.existsSync(outputPath)) {
      try {
        semanticData = loadJson(outputPath);
        if (
          semanticData.eligibilityPolicy !== ELIGIBILITY_POLICY ||
          semanticData.evaluatorVersion !== EVALUATOR_VERSION ||
          semanticData.judgeFingerprint !== judgeFingerprint() ||
          semanticData.sourceStateFingerprint !== fingerprint(state)
        )
          throw new Error('Semantic resume identity mismatch');
        console.log(
          `[Judge] Resuming from existing output: ${Object.keys(semanticData.cases).length} cases already scored`,
        );
      } catch (error) {
        throw new Error(
          `Refusing to replace incompatible semantic results: ${error.message}`,
        );
      }
    }

    // References must come from the saved experiment, never a mutable dataset read.
    console.log(
      `[Judge] Loading frozen dataset snapshot for "${datasetName}"...`,
    );
    const datasetItems = state.datasetSnapshot;
    if (
      !Array.isArray(datasetItems) ||
      fingerprint(datasetItems) !== state.snapshotFingerprint
    )
      throw new Error(
        'A verified frozen datasetSnapshot is required; do not refetch mutable references for judging',
      );
    console.log(
      `[Judge] Loaded ${datasetItems.length} dataset items from Langfuse`,
    );

    const itemMap = new Map(datasetItems.map((it) => [it.id, it]));

    // Setup Groq key pool & quota controllers
    const groqKeys = (process.env.GROQ_API_KEYS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (
      !groqKeys.length &&
      Object.values(state.cases).some((item) =>
        Array.isArray(item.output?.generationEvidence),
      )
    ) {
      throw new Error('GROQ_API_KEYS environment variable is required');
    }

    const tpmLimit = Number.parseInt(args['tpm-limit'] ?? '6500', 10) || 6500;
    const allowProviderFallback =
      args['allow-cloudflare-fallback'] === true ||
      process.env.RAG_SEMANTIC_JUDGE_ALLOW_CLOUDFLARE_FALLBACK === 'true';
    const pool = new JudgePoolController({
      groqApiKeys: groqKeys,
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
      allowProviderFallback,
      ledgerBaseDir: ledgerDir,
      tpmLimitPerKey: tpmLimit,
      maxRetries: 3,
    });
    console.log(
      `[Judge] Cloudflare fallback: ${allowProviderFallback ? 'enabled' : 'disabled'}`,
    );

    // Filter completed benchmark cases to evaluate
    const candidateCaseIds = Object.entries(state.cases)
      .filter(
        ([, caseEntry]) =>
          caseEntry.status === 'COMPLETED' || caseEntry.status === 'FAILED',
      )
      .map(([id]) => id)
      .slice(0, limit);

    semanticData.totalCases = candidateCaseIds.length;

    const pendingCaseIds = candidateCaseIds.filter(
      (id) => !semanticData.cases[id] || semanticData.cases[id].error,
    );

    console.log(
      `[Judge] Total candidate cases: ${candidateCaseIds.length}, Pending: ${pendingCaseIds.length}`,
    );

    let processedCount = candidateCaseIds.length - pendingCaseIds.length;

    // Process queue with concurrency
    const queue = [...pendingCaseIds];
    const workers = Array.from(
      { length: concurrency },
      async (_, workerIdx) => {
        while (queue.length > 0) {
          const caseId = queue.shift();
          if (!caseId) break;

          const caseEntry = state.cases[caseId];
          const item = itemMap.get(caseId);

          if (!item) {
            console.warn(
              `[Worker ${workerIdx}] Warning: Dataset item ${caseId} not found in Langfuse dataset.`,
            );
            semanticData.cases[caseId] = {
              error: `Dataset item ${caseId} not found`,
            };
            continue;
          }

          const question = item.input?.question;
          const referenceAnswer = item.expectedOutput?.acceptedAnswers?.length
            ? item.expectedOutput.acceptedAnswers
            : (item.expectedOutput?.answer ??
              item.expectedOutput?.referenceAnswer);
          const generatedAnswer = caseEntry.output?.answer;
          const context = caseEntry.output?.generationEvidence;
          const availability = dimensionAvailability(item, caseEntry.output);
          if (caseEntry.error || caseEntry.status === 'FAILED') {
            for (const dimension of DIMENSIONS) {
              if (availability[dimension] === 'AVAILABLE')
                availability[dimension] = 'PRIMARY_EXECUTION_FAILED';
            }
          }
          const dimensionsToEvaluate = DIMENSIONS.filter(
            (dimension) => availability[dimension] === 'AVAILABLE',
          );

          try {
            const evaluation = dimensionsToEvaluate.length
              ? await pool.evaluateCase({
                  caseId,
                  question,
                  referenceAnswer,
                  generatedAnswer,
                  context,
                  dimensions: dimensionsToEvaluate,
                  ...semanticTaskMetadata(item),
                })
              : {
                  caseId,
                  evaluatorVersion: EVALUATOR_VERSION,
                  provider: null,
                  model: null,
                  dimensionModels: [],
                  usage: { totalTokens: 0 },
                };
            for (const dimension of DIMENSIONS) {
              if (!evaluation[dimension]) {
                evaluation[dimension] = {
                  score: null,
                  unavailableReason: availability[dimension],
                };
              }
            }
            const applicableDimensions = DIMENSIONS.filter((dimension) =>
              isApplicable(item, dimension),
            );
            const status =
              applicableDimensions.length === 0
                ? 'NOT_APPLICABLE'
                : applicableDimensions.some(
                      (dimension) => availability[dimension] !== 'AVAILABLE',
                    )
                  ? 'PARTIALLY_EVALUATED'
                  : 'COMPLETED';

            semanticData.cases[caseId] = {
              ...evaluation,
              status,
              datasetItem: item,
              applicability: Object.fromEntries(
                DIMENSIONS.map((dimension) => [
                  dimension,
                  isApplicable(item, dimension),
                ]),
              ),
              dimensionAvailability: availability,
              executionHealth: caseEntry.output?.executionHealth ?? {
                status: 'UNKNOWN',
                failedStages: [],
              },
              traceId: caseEntry.output?.traceId,
            };
            processedCount += 1;

            console.log(
              `[Progress] [${processedCount}/${candidateCaseIds.length}] Case: ${caseId} | ` +
                `Faith: ${evaluation.faithfulness?.score?.toFixed(2) ?? 'N/A'} | ` +
                `Fact: ${evaluation.factualCorrectness?.score?.toFixed(2) ?? 'N/A'} | ` +
                `Rel: ${evaluation.responseRelevancy?.score?.toFixed(2) ?? 'N/A'} | ` +
                `Comp: ${evaluation.contextCompleteness?.score?.toFixed(2) ?? 'N/A'} ` +
                `(${evaluation.provider}:${evaluation.model})`,
            );

            // Checkpoint every case
            saveJsonAtomic(outputPath, semanticData);
          } catch (error) {
            console.error(
              `[Judge Error] Case ${caseId} failed: ${error.message}`,
            );
            semanticData.cases[caseId] = {
              caseId,
              status: 'UNAVAILABLE',
              error: error.message,
              evaluatorVersion: EVALUATOR_VERSION,
            };
            saveJsonAtomic(outputPath, semanticData);
          }
        }
      },
    );

    await Promise.all(workers);

    // Compute final statistics
    const validEvaluations = Object.values(semanticData.cases).filter(
      (ev) => ev && !ev.error,
    );
    const applicableScores = (dimension) =>
      validEvaluations
        .filter((ev) => ev.applicability?.[dimension] !== false)
        .map((ev) => ev[dimension]?.score)
        .filter((score) => typeof score === 'number');
    const faithfulnessScores = applicableScores('faithfulness');
    const factualCorrectnessScores = applicableScores('factualCorrectness');
    const responseRelevancyScores = applicableScores('responseRelevancy');
    const contextCompletenessScores = applicableScores('contextCompleteness');

    const dimensionMeans = [
      availableStats(faithfulnessScores).mean,
      availableStats(factualCorrectnessScores).mean,
      availableStats(responseRelevancyScores).mean,
      availableStats(contextCompletenessScores).mean,
    ].filter((value) => typeof value === 'number');
    const metrics = {
      faithfulness: availableStats(faithfulnessScores),
      factual_correctness: availableStats(factualCorrectnessScores),
      response_relevancy: availableStats(responseRelevancyScores),
      context_completeness: availableStats(contextCompletenessScores),
      overall_mean: dimensionMeans.length
        ? Math.round(
            (dimensionMeans.reduce((sum, value) => sum + value, 0) /
              dimensionMeans.length) *
              10000,
          ) / 10000
        : null,
    };

    const allEvaluations = Object.values(semanticData.cases);
    semanticData.evaluatedCases = validEvaluations.filter((evaluation) =>
      DIMENSIONS.some(
        (dimension) => typeof evaluation[dimension]?.score === 'number',
      ),
    ).length;
    semanticData.unavailableCases = allEvaluations.filter(
      (evaluation) => evaluation.status === 'UNAVAILABLE',
    ).length;
    semanticData.partiallyEvaluatedCases = validEvaluations.filter(
      (evaluation) => evaluation.status === 'PARTIALLY_EVALUATED',
    ).length;
    semanticData.notApplicableCases = validEvaluations.filter(
      (evaluation) => evaluation.status === 'NOT_APPLICABLE',
    ).length;
    semanticData.metrics = metrics;
    semanticData.completedAt = new Date().toISOString();

    saveJsonAtomic(outputPath, semanticData);
    const casesLines = Object.entries(semanticData.cases).map(
      ([caseId, evaluation]) => JSON.stringify({ caseId, ...evaluation }),
    );
    fs.writeFileSync(`${casesOutputPath}.tmp`, `${casesLines.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(`${casesOutputPath}.tmp`, casesOutputPath);

    console.log('\n======================================================');
    console.log('             SEMANTIC RAG EVALUATION REPORT           ');
    console.log('======================================================');
    console.log(`Run ID:                ${runId}`);
    console.log(
      `Evaluated Cases:       ${validEvaluations.length} / ${candidateCaseIds.length}`,
    );
    console.log(`Judge Model:           ${DEFAULT_GROQ_MODEL} (Groq pool)`);
    console.log('------------------------------------------------------');
    console.log(
      `Faithfulness:          Mean=${formatMetric(metrics.faithfulness.mean)} | Median=${formatMetric(metrics.faithfulness.median)}`,
    );
    console.log(
      `Factual Correctness:   Mean=${formatMetric(metrics.factual_correctness.mean)} | Median=${formatMetric(metrics.factual_correctness.median)}`,
    );
    console.log(
      `Response Relevancy:    Mean=${formatMetric(metrics.response_relevancy.mean)} | Median=${formatMetric(metrics.response_relevancy.median)}`,
    );
    console.log(
      `Context Completeness:  Mean=${formatMetric(metrics.context_completeness.mean)} | Median=${formatMetric(metrics.context_completeness.median)}`,
    );
    console.log('------------------------------------------------------');
    console.log(`Overall Semantic Mean: ${formatMetric(metrics.overall_mean)}`);
    console.log('======================================================\n');

    // Publish to Langfuse if requested
    if (args.publish) {
      if (!state.datasetRunId) {
        console.warn(
          '[Judge] No datasetRunId found in state file; skipping Langfuse score publication',
        );
      } else {
        console.log(
          `[Judge] Publishing semantic scores to Langfuse (Dataset Run: ${state.datasetRunId})...`,
        );
        const published = await publishSemanticScores({
          datasetRunId: state.datasetRunId,
          caseEvaluations: semanticData.cases,
        });
        console.log(
          `[Judge] Published ${published} case-dimension score pairs to matching Langfuse traces`,
        );
      }
    }

    console.log(`[Judge] Full results saved to: ${outputPath}`);
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Judge Fatal] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  availableStats,
  computeStats,
  loadJson,
  parseArgs,
  semanticTaskMetadata,
  publishSemanticScores,
  saveJsonAtomic,
};
