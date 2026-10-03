#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const {
  JudgePoolController,
  DEFAULT_GROQ_MODEL,
} = require('./rag-semantic-judge.cjs');

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

function saveJsonAtomic(filePath, data) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmpPath = `${resolved}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, resolved);
}

function computeStats(values) {
  if (!values.length) return { mean: 0, median: 0, min: 0, max: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    mean: Math.round((sum / sorted.length) * 10000) / 10000,
    median: Math.round(median * 10000) / 10000,
    min: Math.round(sorted[0] * 10000) / 10000,
    max: Math.round(sorted[sorted.length - 1] * 10000) / 10000,
    count: sorted.length,
  };
}

async function fetchDatasetItems(datasetName) {
  const { LangfuseClient } = require('@langfuse/client');
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });

  const dataset = await client.dataset.get(datasetName);
  return dataset.items || [];
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

  try {
    for (const [caseId, evaluation] of Object.entries(caseEvaluations)) {
      if (!evaluation || evaluation.error) continue;

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
        if (typeof m.score !== 'number') continue;

        client.score.create({
          datasetRunId,
          name: m.name,
          value: m.score,
          dataType: 'NUMERIC',
          comment: m.reasoning,
          metadata: {
            caseId,
            provider: evaluation.provider,
            model: evaluation.model,
          },
        });

        // Also publish with standard prefix semantic_ for unambiguous filtering
        client.score.create({
          datasetRunId,
          name: `semantic_${m.name}`,
          value: m.score,
          dataType: 'NUMERIC',
          comment: m.reasoning,
          metadata: {
            caseId,
            provider: evaluation.provider,
            model: evaluation.model,
          },
        });
      }
    }
    await client.flush();
  } finally {
    await client.shutdown();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

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
  const runId = state.runId || path.basename(statePath).replace(/\.state\.json$/, '');
  const datasetName = state.datasetName || args.dataset || 'velora/rag-scraped-v1-provisional';
  const outputPath =
    args.output || path.join(path.dirname(statePath), `${runId}.semantic.json`);
  const ledgerDir =
    args.ledger || path.join(path.dirname(statePath), 'judge-ledgers', runId);

  const concurrency = Math.max(1, Math.min(4, Number.parseInt(args.concurrency ?? '2', 10) || 2));
  const limit = args.limit ? Number.parseInt(args.limit, 10) : Infinity;

  console.log(`[Judge] Initializing LLM-as-a-Judge for Run: ${runId}`);
  console.log(`[Judge] State: ${statePath}`);
  console.log(`[Judge] Output: ${outputPath}`);
  console.log(`[Judge] Concurrency: ${concurrency}`);

  // Load existing semantic results if available for resumption
  let semanticData = {
    schemaVersion: 'velora-rag-semantic-evaluation-v1',
    runId,
    datasetName,
    datasetRunId: state.datasetRunId || null,
    totalCases: 0,
    evaluatedCases: 0,
    metrics: {},
    cases: {},
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  if (fs.existsSync(outputPath)) {
    try {
      semanticData = loadJson(outputPath);
      console.log(
        `[Judge] Resuming from existing output: ${Object.keys(semanticData.cases).length} cases already scored`,
      );
    } catch {
      // Start fresh if unreadable
    }
  }

  // Fetch dataset items from Langfuse
  console.log(`[Judge] Fetching dataset items for "${datasetName}"...`);
  const datasetItems = await fetchDatasetItems(datasetName);
  console.log(`[Judge] Loaded ${datasetItems.length} dataset items from Langfuse`);

  const itemMap = new Map(datasetItems.map((it) => [it.id, it]));

  // Setup Groq key pool & quota controllers
  const groqKeys = (process.env.GROQ_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!groqKeys.length) {
    throw new Error('GROQ_API_KEYS environment variable is required');
  }

  const tpmLimit = Number.parseInt(args['tpm-limit'] ?? '6500', 10) || 6500;
  const pool = new JudgePoolController({
    groqApiKeys: groqKeys,
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
    ledgerBaseDir: ledgerDir,
    tpmLimitPerKey: tpmLimit,
    maxRetries: 3,
  });

  // Filter completed benchmark cases to evaluate
  const candidateCaseIds = Object.entries(state.cases)
    .filter(([, caseEntry]) => caseEntry.status === 'COMPLETED')
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
  const workers = Array.from({ length: concurrency }, async (_, workerIdx) => {
    while (queue.length > 0) {
      const caseId = queue.shift();
      if (!caseId) break;

      const caseEntry = state.cases[caseId];
      const item = itemMap.get(caseId);

      if (!item) {
        console.warn(`[Worker ${workerIdx}] Warning: Dataset item ${caseId} not found in Langfuse dataset.`);
        semanticData.cases[caseId] = {
          error: `Dataset item ${caseId} not found`,
        };
        continue;
      }

      const question = item.input?.question;
      const referenceAnswer = item.expectedOutput?.answer;
      const generatedAnswer = caseEntry.output?.answer;
      const citations = caseEntry.output?.citations || [];

      try {
        const evaluation = await pool.evaluateCase({
          caseId,
          question,
          referenceAnswer,
          generatedAnswer,
          context: citations,
        });

        semanticData.cases[caseId] = evaluation;
        processedCount += 1;

        console.log(
          `[Progress] [${processedCount}/${candidateCaseIds.length}] Case: ${caseId} | ` +
            `Faith: ${evaluation.faithfulness.score.toFixed(2)} | ` +
            `Fact: ${evaluation.factualCorrectness.score.toFixed(2)} | ` +
            `Rel: ${evaluation.responseRelevancy.score.toFixed(2)} | ` +
            `Comp: ${evaluation.contextCompleteness.score.toFixed(2)} ` +
            `(${evaluation.provider}:${evaluation.model})`,
        );

        // Checkpoint every case
        saveJsonAtomic(outputPath, semanticData);
      } catch (error) {
        console.error(`[Judge Error] Case ${caseId} failed: ${error.message}`);
        semanticData.cases[caseId] = {
          caseId,
          error: error.message,
        };
        saveJsonAtomic(outputPath, semanticData);
      }
    }
  });

  await Promise.all(workers);

  // Compute final statistics
  const validEvaluations = Object.values(semanticData.cases).filter(
    (ev) => ev && !ev.error && ev.faithfulness,
  );

  const faithfulnessScores = validEvaluations.map((ev) => ev.faithfulness.score);
  const factualCorrectnessScores = validEvaluations.map(
    (ev) => ev.factualCorrectness.score,
  );
  const responseRelevancyScores = validEvaluations.map(
    (ev) => ev.responseRelevancy.score,
  );
  const contextCompletenessScores = validEvaluations.map(
    (ev) => ev.contextCompleteness.score,
  );

  const metrics = {
    faithfulness: computeStats(faithfulnessScores),
    factual_correctness: computeStats(factualCorrectnessScores),
    response_relevancy: computeStats(responseRelevancyScores),
    context_completeness: computeStats(contextCompletenessScores),
    overall_mean:
      Math.round(
        ((computeStats(faithfulnessScores).mean +
          computeStats(factualCorrectnessScores).mean +
          computeStats(responseRelevancyScores).mean +
          computeStats(contextCompletenessScores).mean) /
          4) *
          10000,
      ) / 10000,
  };

  semanticData.evaluatedCases = validEvaluations.length;
  semanticData.metrics = metrics;
  semanticData.completedAt = new Date().toISOString();

  saveJsonAtomic(outputPath, semanticData);

  console.log('\n======================================================');
  console.log('             SEMANTIC RAG EVALUATION REPORT           ');
  console.log('======================================================');
  console.log(`Run ID:                ${runId}`);
  console.log(`Evaluated Cases:       ${validEvaluations.length} / ${candidateCaseIds.length}`);
  console.log(`Judge Model:           ${DEFAULT_GROQ_MODEL} (Groq pool)`);
  console.log('------------------------------------------------------');
  console.log(
    `Faithfulness:          Mean=${metrics.faithfulness.mean.toFixed(4)} | Median=${metrics.faithfulness.median.toFixed(4)}`,
  );
  console.log(
    `Factual Correctness:   Mean=${metrics.factual_correctness.mean.toFixed(4)} | Median=${metrics.factual_correctness.median.toFixed(4)}`,
  );
  console.log(
    `Response Relevancy:    Mean=${metrics.response_relevancy.mean.toFixed(4)} | Median=${metrics.response_relevancy.median.toFixed(4)}`,
  );
  console.log(
    `Context Completeness:  Mean=${metrics.context_completeness.mean.toFixed(4)} | Median=${metrics.context_completeness.median.toFixed(4)}`,
  );
  console.log('------------------------------------------------------');
  console.log(`Overall Semantic Mean: ${metrics.overall_mean.toFixed(4)}`);
  console.log('======================================================\n');

  // Publish to Langfuse if requested
  if (args.publish) {
    if (!state.datasetRunId) {
      console.warn('[Judge] No datasetRunId found in state file; skipping Langfuse score publication');
    } else {
      console.log(`[Judge] Publishing semantic scores to Langfuse (Dataset Run: ${state.datasetRunId})...`);
      await publishSemanticScores({
        datasetRunId: state.datasetRunId,
        caseEvaluations: semanticData.cases,
      });
      console.log('[Judge] Scores successfully published to Langfuse!');
    }
  }

  console.log(`[Judge] Full results saved to: ${outputPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Judge Fatal] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  computeStats,
  loadJson,
  parseArgs,
  publishSemanticScores,
  saveJsonAtomic,
};
