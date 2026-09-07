#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../..');
const defaultResultsRoot = path.join(repositoryRoot, 'eval/rag/results');
const defaultDatasetRoot = path.join(repositoryRoot, 'eval/rag/datasets');

const SAFE_VARIANT_KEYS = [
  'variantName',
  'gitSha',
  'evaluatorSha',
  'productionSha',
  'datasetVersion',
  'pricingVersion',
  'embeddingModel',
  'routerModel',
  'plannerModel',
  'answerModel',
  'verifierModel',
  'retrievalK',
  'rerankK',
  'promptVersion',
];

const SAFE_SNAPSHOT_KEYS = [
  'variantName',
  'gitSha',
  'productionSha',
  'datasetVersion',
  'structuredReasoningEffort',
  'routerOutputContract',
  'endpointContract',
  'structuredMaxTokensParameter',
  'routerPrimaryModel',
  'routerFallbackModel',
  'routerTimeoutMs',
  'routerFallbackTimeoutMs',
  'routerMaxCompletionTokens',
  'aiGatewayEnabled',
];

const SAFE_METRIC_KEYS = [
  'recallAt1',
  'recallAt3',
  'recallAt5',
  'recallAt10',
  'mrr',
  'ndcgAt5',
  'ndcgAt10',
  'evidenceHitRate',
  'citationPrecision',
  'citationRecall',
  'citationEvidenceHitRate',
  'wrongReelCitationCount',
  'wrongModalityCitationCount',
  'routerIntentAccuracy',
  'referenceTargetAccuracy',
  'requiredEvidenceAccuracy',
  'modalityAccuracy',
  'accessControlViolations',
  'answerCorrect',
  'grounded',
  'correctAndGrounded',
];

const SAFE_SEMANTIC_KEYS = [
  'faithfulness',
  'factual_correctness',
  'response_relevancy',
  'context_precision',
  'context_recall',
];

const SAFE_COST_KEYS = [
  'totalQueryCostUsd',
  'totalIndexingCostUsd',
  'evaluationJudgeCostUsd',
  'combinedExperimentCostUsd',
  'pricingStatus',
  'costUsd',
];

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertSafeRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    fail('run ID must be a single safe path segment');
  }
}

function assertSafeDatasetName(datasetName) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(datasetName)) {
    fail('dataset name must be a single safe path segment');
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function pickObject(source, keys) {
  const result = {};
  if (!source || typeof source !== 'object' || Array.isArray(source))
    return result;
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function safeRole(role) {
  return pickObject(role, ['model', 'timeoutMs', 'maxCompletionTokens']);
}

function safeProviderConfig(variant) {
  assertObject(variant, 'summary.variant');
  const snapshot = variant.configSnapshot;
  const output = pickObject(variant, SAFE_VARIANT_KEYS);
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    output.configSnapshot = pickObject(snapshot, SAFE_SNAPSHOT_KEYS);
    if (snapshot.gatewayPolicy && typeof snapshot.gatewayPolicy === 'object') {
      output.configSnapshot.gatewayPolicy = pickObject(snapshot.gatewayPolicy, [
        'enabled',
        'maxAttempts',
        'retryDelayMs',
        'backoff',
      ]);
    }
    if (snapshot.roles && typeof snapshot.roles === 'object') {
      output.configSnapshot.roles = Object.fromEntries(
        Object.entries(snapshot.roles)
          .filter(
            ([, role]) =>
              role && typeof role === 'object' && !Array.isArray(role),
          )
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([roleName, role]) => [roleName, safeRole(role)]),
      );
    }
  }
  return canonicalize(output);
}

function pickSafeMetrics(source, keys) {
  return pickObject(source, keys);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function firstUniqueString(values) {
  const unique = [
    ...new Set(values.filter((value) => typeof value === 'string' && value)),
  ];
  return unique.length === 1 ? unique[0] : null;
}

function safeCategory(value) {
  return typeof value === 'string' &&
    /^[A-Z0-9][A-Z0-9_.:-]{0,119}$/.test(value)
    ? value
    : null;
}

function explicitProvenance(caseRecord) {
  const execution = caseRecord.execution || {};
  const actual = execution.actual || {};
  const trace = execution.trace || {};
  const contexts = Array.isArray(actual.retrievedContexts)
    ? actual.retrievedContexts
    : [];
  const reranked = Array.isArray(actual.rerankedContexts)
    ? actual.rerankedContexts
    : [];
  const citations = Array.isArray(actual.citations) ? actual.citations : [];

  const reelId = firstUniqueString([
    actual.reelId,
    trace.reelId,
    trace.indexedReelId,
    trace.retrievalExecution && trace.retrievalExecution.reelId,
    ...contexts.map((item) => item && item.reelId),
    ...reranked.map((item) => item && item.reelId),
    ...citations.map((item) => item && item.reelId),
  ]);
  const indexAttemptId = firstUniqueString([
    actual.indexAttemptId,
    trace.indexAttemptId,
    trace.retrievalExecution && trace.retrievalExecution.indexAttemptId,
  ]);
  const traceId = firstUniqueString([
    caseRecord.traceId,
    actual.traceId,
    trace.traceId,
    trace.ragTraceId,
  ]);
  return { reelId, indexAttemptId, traceId };
}

function failureCategory(caseRecord) {
  const execution = caseRecord.execution || {};
  const calls = Array.isArray(execution.modelCalls) ? execution.modelCalls : [];
  const trace = execution.trace || {};
  const value =
    calls.find((call) => typeof call.providerCategory === 'string')
      ?.providerCategory ||
    (typeof trace.failureCategory === 'string'
      ? trace.failureCategory
      : null) ||
    (typeof trace.providerCategory === 'string'
      ? trace.providerCategory
      : null);
  const category = safeCategory(value);
  if (category) return category;
  return execution.executionStatus &&
    !['COMPLETED', 'FIXTURE'].includes(execution.executionStatus)
    ? execution.executionStatus
    : null;
}

function caseMetrics(caseRecord) {
  const execution = caseRecord.execution || {};
  const calls = Array.isArray(execution.modelCalls) ? execution.modelCalls : [];
  return {
    deterministic: pickSafeMetrics(caseRecord.deterministic, SAFE_METRIC_KEYS),
    semantic: pickSafeMetrics(caseRecord.semantic, SAFE_SEMANTIC_KEYS),
    cost: pickSafeMetrics(caseRecord.cost, SAFE_COST_KEYS),
    operational: {
      providerAttemptCount: calls.length,
      providerCategories: [
        ...new Set(
          calls
            .map((call) => call && call.providerCategory)
            .map(safeCategory)
            .filter((value) => value !== null),
        ),
      ],
    },
  };
}

function validateArtifacts(summary, cases, runId) {
  assertObject(summary, 'summary');
  if (summary.schemaVersion !== 'rag-eval-summary-v1') {
    fail('unsupported RAG summary schema');
  }
  if (summary.runId !== runId)
    fail('summary runId does not match requested run');
  if (typeof summary.dataset !== 'string' || !summary.dataset)
    fail('summary dataset is required');
  assertSafeDatasetName(summary.dataset);
  if (!Number.isInteger(summary.caseCount) || summary.caseCount <= 0) {
    fail('summary caseCount must be a positive integer');
  }
  if (summary.caseCount !== cases.length)
    fail('summary caseCount does not match cases.jsonl');
  const seen = new Set();
  for (const [index, item] of cases.entries()) {
    assertObject(item, `case ${index + 1}`);
    if (typeof item.caseId !== 'string' || !item.caseId)
      fail(`case ${index + 1} caseId is required`);
    if (seen.has(item.caseId)) fail(`duplicate caseId: ${item.caseId}`);
    seen.add(item.caseId);
    if (item.datasetVersion !== summary.dataset)
      fail(`dataset mismatch for ${item.caseId}`);
    assertObject(item.execution, `${item.caseId}.execution`);
    if (
      item.execution.runId !== runId ||
      item.execution.caseId !== item.caseId
    ) {
      fail(`execution identity mismatch for ${item.caseId}`);
    }
    if (
      ![
        'COMPLETED',
        'FIXTURE',
        'PROVIDER_FAILURE',
        'NO_RESPONSE',
        'ROUTER_UNAVAILABLE',
        'RECONCILED_FAILURE',
      ].includes(item.execution.executionStatus)
    ) {
      fail(`unsupported execution status for ${item.caseId}`);
    }
    assertObject(item.deterministic, `${item.caseId}.deterministic`);
    assertObject(item.semantic, `${item.caseId}.semantic`);
  }
}

function buildPersistencePayload({
  runId,
  summary,
  cases,
  summaryBytes,
  casesBytes,
  datasetBytes,
}) {
  validateArtifacts(summary, cases, runId);
  if (
    !Buffer.isBuffer(summaryBytes) ||
    !Buffer.isBuffer(casesBytes) ||
    !Buffer.isBuffer(datasetBytes)
  ) {
    fail('artifact bytes are required for immutable provenance hashes');
  }
  const providerConfig = safeProviderConfig(summary.variant || {});
  const semanticMetrics = summary.semanticMetrics || {};
  const ragasRun =
    cases.some(
      (item) =>
        Array.isArray(item.execution.modelCalls) &&
        item.execution.modelCalls.some(
          (call) => call && call.scope === 'EVALUATION_JUDGE',
        ),
    ) ||
    Object.values(semanticMetrics).some((value) => typeof value === 'number');
  const hardGatePass = booleanOrNull(summary.hardGatePassed);
  const allCompleted = cases.every((item) =>
    ['COMPLETED', 'FIXTURE'].includes(item.execution.executionStatus),
  );
  const status = allCompleted
    ? hardGatePass === false
      ? 'COMPLETED_HARD_GATE_FAILED'
      : 'COMPLETED'
    : 'COMPLETED_WITH_EXECUTION_FAILURES';
  const variant = summary.variant || {};
  const productionSha =
    (typeof variant.productionSha === 'string' && variant.productionSha) ||
    (variant.configSnapshot &&
      typeof variant.configSnapshot.gitSha === 'string' &&
      variant.configSnapshot.gitSha) ||
    'unknown';
  const summaryMetrics = pickSafeMetrics(summary, [
    'caseCount',
    'executionFailureCount',
    'correct',
    'grounded',
    'correctAndGrounded',
    'hardGatePassed',
    'accessControlViolations',
    'metrics',
    'semanticMetrics',
    'latencyMs',
    'reliability',
    'cost',
    'slices',
  ]);
  return {
    run: {
      benchmarkRunId: runId,
      datasetName: summary.dataset,
      datasetVersion: variant.datasetVersion || summary.dataset,
      datasetHash: sha256(datasetBytes),
      productionSha,
      configHash: sha256(JSON.stringify(providerConfig)),
      providerConfig,
      status,
      hardGatePass,
      ragasRun,
      summaryMetrics,
      artifactHash: sha256(
        Buffer.concat([summaryBytes, Buffer.from('\n'), casesBytes]),
      ),
      startedAt: null,
      completedAt: null,
    },
    cases: cases.map((item) => {
      const deterministic = item.deterministic || {};
      const semantic = item.semantic || {};
      const provenance = explicitProvenance(item);
      return {
        caseId: item.caseId,
        ...provenance,
        status: item.execution.executionStatus,
        recallAt1: numberOrNull(deterministic.recallAt1),
        recallAt3: numberOrNull(deterministic.recallAt3),
        recallAt5: numberOrNull(deterministic.recallAt5),
        recallAt10: numberOrNull(deterministic.recallAt10),
        mrr: numberOrNull(deterministic.mrr),
        ndcgAt5: numberOrNull(deterministic.ndcgAt5),
        ndcgAt10: numberOrNull(deterministic.ndcgAt10),
        evidenceHit: numberOrNull(deterministic.evidenceHitRate),
        citationPrecision: numberOrNull(deterministic.citationPrecision),
        citationRecall: numberOrNull(deterministic.citationRecall),
        wrongReel:
          typeof deterministic.wrongReelCitationCount === 'number'
            ? deterministic.wrongReelCitationCount > 0
            : null,
        wrongModality:
          typeof deterministic.wrongModalityCitationCount === 'number'
            ? deterministic.wrongModalityCitationCount > 0
            : null,
        accessViolation:
          typeof deterministic.accessControlViolations === 'number'
            ? deterministic.accessControlViolations > 0
            : null,
        answerCorrect: numberOrNull(deterministic.answerCorrect),
        grounded: numberOrNull(deterministic.grounded),
        faithfulness: numberOrNull(semantic.faithfulness),
        factualCorrectness: numberOrNull(semantic.factual_correctness),
        responseRelevancy: numberOrNull(semantic.response_relevancy),
        contextPrecision: numberOrNull(semantic.context_precision),
        contextRecall: numberOrNull(semantic.context_recall),
        failureCategory: failureCategory(item),
        metrics: caseMetrics(item),
      };
    }),
  };
}

function loadArtifacts({
  runId,
  resultsRoot = defaultResultsRoot,
  datasetRoot = defaultDatasetRoot,
}) {
  assertSafeRunId(runId);
  const directory = path.join(resultsRoot, runId);
  const summaryPath = path.join(directory, 'summary.json');
  const casesPath = path.join(directory, 'cases.jsonl');
  const summaryBytes = fs.readFileSync(summaryPath);
  const casesBytes = fs.readFileSync(casesPath);
  const summary = JSON.parse(summaryBytes.toString('utf8'));
  const cases = casesBytes
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail(`cases.jsonl line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
  assertObject(summary, 'summary');
  if (typeof summary.dataset !== 'string' || !summary.dataset)
    fail('summary dataset is required');
  assertSafeDatasetName(summary.dataset);
  const datasetPath = path.join(datasetRoot, `${summary.dataset}.jsonl`);
  if (!fs.existsSync(datasetPath))
    fail(`dataset provenance file is missing: ${summary.dataset}`);
  const datasetBytes = fs.readFileSync(datasetPath);
  return {
    summary,
    cases,
    payload: buildPersistencePayload({
      runId,
      summary,
      cases,
      summaryBytes,
      casesBytes,
      datasetBytes,
    }),
  };
}

async function persistPayload(prisma, payload) {
  const existing = await prisma.ragEvaluationRun.findUnique({
    where: { benchmarkRunId: payload.run.benchmarkRunId },
    select: { artifactHash: true },
  });
  if (existing) {
    if (existing.artifactHash === payload.run.artifactHash) {
      return {
        status: 'IDEMPOTENT_NOOP',
        benchmarkRunId: payload.run.benchmarkRunId,
      };
    }
    fail(
      `immutable RAG evaluation run already exists with a different artifact: ${payload.run.benchmarkRunId}`,
    );
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.ragEvaluationRun.create({ data: payload.run });
    await transaction.ragEvaluationCase.createMany({
      data: payload.cases.map((item) => ({
        benchmarkRunId: payload.run.benchmarkRunId,
        ...item,
      })),
    });
  });
  return { status: 'PERSISTED', benchmarkRunId: payload.run.benchmarkRunId };
}

function parseArguments(argv) {
  let runId;
  let resultsRoot = defaultResultsRoot;
  let datasetRoot = defaultDatasetRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--run') runId = argv[++index];
    else if (argument === '--results-root')
      resultsRoot = path.resolve(argv[++index]);
    else if (argument === '--dataset-root')
      datasetRoot = path.resolve(argv[++index]);
    else fail(`unknown argument: ${argument}`);
  }
  if (!runId) fail('--run is required');
  assertSafeRunId(runId);
  return { runId, resultsRoot, datasetRoot };
}

async function main() {
  if (process.env.RAG_EVAL_PERSIST_CONFIRM !== 'YES') {
    fail(
      'set RAG_EVAL_PERSIST_CONFIRM=YES to authorize the evaluation database write',
    );
  }
  if (!process.env.REEL_INDEXING_DATABASE_URL) {
    fail(
      'REEL_INDEXING_DATABASE_URL is required; no fallback database target is allowed',
    );
  }
  const options = parseArguments(process.argv.slice(2));
  const { payload } = loadArtifacts(options);
  const { PrismaClient } = require('@prisma/reel-indexing-client');
  const prisma = new PrismaClient();
  try {
    const result = await persistPayload(prisma, payload);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `RAG evaluation persistence failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  buildPersistencePayload,
  canonicalize,
  explicitProvenance,
  failureCategory,
  loadArtifacts,
  parseArguments,
  persistPayload,
  safeProviderConfig,
  sha256,
  validateArtifacts,
};
