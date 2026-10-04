const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createLangfuseClient, loadLangfuseRagTraces, loadLangfuseHierarchyShadowObservations } = require('./langfuse-rag-traces.cjs');
const {
  PrismaClient: ReelIndexingPrismaClient,
} = require('@prisma/reel-indexing-client');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const DEFAULTS = Object.freeze({
  minRagTraces: 50,
  minWorkflowMetricCoverage: 0.95,
  minRetrievalTimingTraces: 30,
  minHierarchyShadowObservations: 30,
  minBenchmarkCases: 30,
  minRecallDelta: -0.01,
  minReciprocalRankDelta: -0.01,
  minNdcgDelta: -0.01,
  maxHierarchyP95LatencyRatio: 1.5,
  minFreshCompletedIndexAttempts: 1,
  minFreshActiveVisualScenes: 1,
  minFreshVisualReels: 1,
  minVisualCitationTraces: 1,
});

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value || value === '--') continue;
    if (!value.startsWith('--')) continue;

    const [rawName, inlineValue] = value.slice(2).split('=', 2);
    const nextValue = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && nextValue && !nextValue.startsWith('--')) {
      index += 1;
    }
    args[rawName] = inlineValue ?? nextValue ?? 'true';
  }
  return args;
}

function readNumber(name, fallback, options = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${name} must be >= ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${name} must be <= ${options.max}.`);
  }
  return value;
}

function parseSince(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      'A release boundary is required. Pass --since <ISO timestamp> or set RAG_PRODUCTION_EVIDENCE_SINCE.',
    );
  }
  const since = new Date(value);
  if (!Number.isFinite(since.getTime())) {
    throw new Error(`Invalid --since value: ${value}`);
  }
  if (since.getTime() > Date.now()) {
    throw new Error('--since cannot be in the future.');
  }
  return since;
}

function percentile(values, percentileValue) {
  const finiteValues = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finiteValues.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(
      finiteValues.length - 1,
      Math.ceil((percentileValue / 100) * finiteValues.length) - 1,
    ),
  );
  return finiteValues[index];
}

function average(values) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return null;
  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkflowMetrics(value) {
  return (
    isRecord(value) &&
    Number.isFinite(value.retrievalRetryCount) &&
    Number.isFinite(value.answerRetryCount) &&
    Number.isFinite(value.citationRetryCount)
  );
}

function hasRetrievalNodeTimings(value) {
  return (
    isRecord(value) &&
    Number.isFinite(value.retrievalPlannerNode) &&
    Number.isFinite(value.retrievalNode) &&
    Number.isFinite(value.neuralRerankerNode)
  );
}

function getVisualCitationReelIds(citations) {
  if (!Array.isArray(citations)) return [];
  return citations.reduce((reelIds, citation) => {
    if (!isRecord(citation)) return reelIds;
    if (citation.sourceType !== 'REEL' || citation.evidenceType !== 'VISUAL') {
      return reelIds;
    }
    if (typeof citation.reelId === 'string' && citation.reelId.trim()) {
      reelIds.push(citation.reelId.trim());
    }
    return reelIds;
  }, []);
}

function readBenchmark(filePath) {
  if (!filePath) {
    return { valid: false, reason: 'No labelled benchmark report supplied.' };
  }
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      valid: false,
      reason: `Labelled benchmark report does not exist: ${resolvedPath}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    return {
      valid: false,
      reason: `Could not parse benchmark report: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isRecord(parsed) || !isRecord(parsed.delta)) {
    return { valid: false, reason: 'Benchmark report has an invalid shape.' };
  }

  const cases = Number(parsed.cases);
  const recallAtK = Number(parsed.delta.recallAtK);
  const reciprocalRank = Number(parsed.delta.reciprocalRank);
  const ndcgAtK = Number(parsed.delta.ndcgAtK);
  if (
    !Number.isFinite(cases) ||
    !Number.isFinite(recallAtK) ||
    !Number.isFinite(reciprocalRank) ||
    !Number.isFinite(ndcgAtK)
  ) {
    return {
      valid: false,
      reason: 'Benchmark report must contain numeric cases and delta recallAtK/reciprocalRank/ndcgAtK.',
    };
  }

  return {
    valid: true,
    path: resolvedPath,
    cases,
    k: Number.isFinite(Number(parsed.k)) ? Number(parsed.k) : null,
    direct: parsed.direct,
    hierarchical: parsed.hierarchical,
    delta: { recallAtK, reciprocalRank, ndcgAtK },
  };
}

function criterion(name, passed, actual, expected) {
  return { name, passed: Boolean(passed), actual, expected };
}

async function collectReadinessEvidence({ since, benchmarkPath }) {
  const indexing = new ReelIndexingPrismaClient();

  const thresholds = {
    minRagTraces: readNumber('RAG_READINESS_MIN_RAG_TRACES', DEFAULTS.minRagTraces, {
      min: 1,
    }),
    minWorkflowMetricCoverage: readNumber(
      'RAG_READINESS_MIN_WORKFLOW_METRIC_COVERAGE',
      DEFAULTS.minWorkflowMetricCoverage,
      { min: 0, max: 1 },
    ),
    minRetrievalTimingTraces: readNumber(
      'RAG_READINESS_MIN_RETRIEVAL_TIMING_TRACES',
      DEFAULTS.minRetrievalTimingTraces,
      { min: 1 },
    ),
    minHierarchyShadowObservations: readNumber(
      'RAG_READINESS_MIN_HIERARCHY_SHADOW_OBSERVATIONS',
      DEFAULTS.minHierarchyShadowObservations,
      { min: 1 },
    ),
    minBenchmarkCases: readNumber(
      'RAG_READINESS_MIN_BENCHMARK_CASES',
      DEFAULTS.minBenchmarkCases,
      { min: 1 },
    ),
    minRecallDelta: readNumber('RAG_READINESS_MIN_RECALL_DELTA', DEFAULTS.minRecallDelta),
    minReciprocalRankDelta: readNumber(
      'RAG_READINESS_MIN_MRR_DELTA',
      DEFAULTS.minReciprocalRankDelta,
    ),
    minNdcgDelta: readNumber('RAG_READINESS_MIN_NDCG_DELTA', DEFAULTS.minNdcgDelta),
    maxHierarchyP95LatencyRatio: readNumber(
      'RAG_READINESS_MAX_HIERARCHY_P95_LATENCY_RATIO',
      DEFAULTS.maxHierarchyP95LatencyRatio,
      { min: 0 },
    ),
    minFreshCompletedIndexAttempts: readNumber(
      'RAG_READINESS_MIN_FRESH_COMPLETED_INDEX_ATTEMPTS',
      DEFAULTS.minFreshCompletedIndexAttempts,
      { min: 1 },
    ),
    minFreshActiveVisualScenes: readNumber(
      'RAG_READINESS_MIN_FRESH_ACTIVE_VISUAL_SCENES',
      DEFAULTS.minFreshActiveVisualScenes,
      { min: 1 },
    ),
    minFreshVisualReels: readNumber(
      'RAG_READINESS_MIN_FRESH_VISUAL_REELS',
      DEFAULTS.minFreshVisualReels,
      { min: 1 },
    ),
    minVisualCitationTraces: readNumber(
      'RAG_READINESS_MIN_VISUAL_CITATION_TRACES',
      DEFAULTS.minVisualCitationTraces,
      { min: 1 },
    ),
  };

  try {
    const [traces, shadowObservations, completedIndexAttempts, activeVisualScenes, latestIndexAttempt] =
      await Promise.all([
        loadLangfuseRagTraces(createLangfuseClient(), { fromStartTime: since.toISOString(), toStartTime: new Date().toISOString(), environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || 'production' }),
        loadLangfuseHierarchyShadowObservations(createLangfuseClient(), { fromStartTime: since.toISOString(), toStartTime: new Date().toISOString(), environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || 'production' }),
        indexing.indexingAttempt.count({
          where: { createdAt: { gte: since }, status: 'COMPLETED' },
        }),
        indexing.reelVisualScene.findMany({
          where: { createdAt: { gte: since }, isActive: true },
          select: { reelId: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
        indexing.indexingAttempt.findFirst({
          orderBy: { createdAt: 'desc' },
          select: {
            reelId: true,
            indexAttemptId: true,
            status: true,
            stage: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ]);

    const metricsTraceCount = traces.filter((trace) => isWorkflowMetrics(trace.workflowMetrics)).length;
    const workflowMetricCoverage = traces.length > 0 ? metricsTraceCount / traces.length : 0;
    const retrievalTraces = traces.filter((trace) => trace.needsRetrieval);
    const retrievalTimingTraceCount = retrievalTraces.filter((trace) =>
      hasRetrievalNodeTimings(trace.nodeTimings),
    ).length;

    const directP50Ms = percentile(
      shadowObservations.map((item) => item.directMs),
      50,
    );
    const directP95Ms = percentile(
      shadowObservations.map((item) => item.directMs),
      95,
    );
    const hierarchicalP50Ms = percentile(
      shadowObservations.map((item) => item.hierarchicalMs),
      50,
    );
    const hierarchicalP95Ms = percentile(
      shadowObservations.map((item) => item.hierarchicalMs),
      95,
    );
    const hierarchyP95LatencyRatio =
      directP95Ms !== null && directP95Ms > 0 && hierarchicalP95Ms !== null
        ? hierarchicalP95Ms / directP95Ms
        : null;

    const freshVisualReelIds = new Set(activeVisualScenes.map((scene) => scene.reelId));
    let visualCitationTraceCount = 0;
    const visualCitationReelIds = new Set();
    for (const trace of traces) {
      const citedReels = getVisualCitationReelIds(trace.citations).filter((reelId) =>
        freshVisualReelIds.has(reelId),
      );
      if (citedReels.length === 0) continue;
      visualCitationTraceCount += 1;
      citedReels.forEach((reelId) => visualCitationReelIds.add(reelId));
    }

    const benchmark = readBenchmark(benchmarkPath);
    const benchmarkCriteria = benchmark.valid
      ? [
          criterion(
            'labelled benchmark case count',
            benchmark.cases >= thresholds.minBenchmarkCases,
            benchmark.cases,
            `>= ${thresholds.minBenchmarkCases}`,
          ),
          criterion(
            'Recall@K delta',
            benchmark.delta.recallAtK >= thresholds.minRecallDelta,
            benchmark.delta.recallAtK,
            `>= ${thresholds.minRecallDelta}`,
          ),
          criterion(
            'MRR delta',
            benchmark.delta.reciprocalRank >= thresholds.minReciprocalRankDelta,
            benchmark.delta.reciprocalRank,
            `>= ${thresholds.minReciprocalRankDelta}`,
          ),
          criterion(
            'nDCG@K delta',
            benchmark.delta.ndcgAtK >= thresholds.minNdcgDelta,
            benchmark.delta.ndcgAtK,
            `>= ${thresholds.minNdcgDelta}`,
          ),
        ]
      : [criterion('labelled benchmark report', false, benchmark.reason, 'valid report required')];

    const hierarchyCriteria = [
      criterion('fresh RAG trace count', traces.length >= thresholds.minRagTraces, traces.length, `>= ${thresholds.minRagTraces}`),
      criterion(
        'workflow-metrics coverage',
        workflowMetricCoverage >= thresholds.minWorkflowMetricCoverage,
        workflowMetricCoverage,
        `>= ${thresholds.minWorkflowMetricCoverage}`,
      ),
      criterion(
        'retrieval traces with planner/retrieval/reranker timings',
        retrievalTimingTraceCount >= thresholds.minRetrievalTimingTraces,
        retrievalTimingTraceCount,
        `>= ${thresholds.minRetrievalTimingTraces}`,
      ),
      criterion(
        'persisted hierarchy shadow observations',
        shadowObservations.length >= thresholds.minHierarchyShadowObservations,
        shadowObservations.length,
        `>= ${thresholds.minHierarchyShadowObservations}`,
      ),
      criterion(
        'hierarchy p95 latency ratio',
        hierarchyP95LatencyRatio !== null &&
          hierarchyP95LatencyRatio <= thresholds.maxHierarchyP95LatencyRatio,
        hierarchyP95LatencyRatio,
        `<= ${thresholds.maxHierarchyP95LatencyRatio}`,
      ),
      ...benchmarkCriteria,
    ];

    const visualCriteria = [
      criterion(
        'fresh completed index attempts',
        completedIndexAttempts >= thresholds.minFreshCompletedIndexAttempts,
        completedIndexAttempts,
        `>= ${thresholds.minFreshCompletedIndexAttempts}`,
      ),
      criterion(
        'fresh active visual-scene rows',
        activeVisualScenes.length >= thresholds.minFreshActiveVisualScenes,
        activeVisualScenes.length,
        `>= ${thresholds.minFreshActiveVisualScenes}`,
      ),
      criterion(
        'fresh reels with active visual scenes',
        freshVisualReelIds.size >= thresholds.minFreshVisualReels,
        freshVisualReelIds.size,
        `>= ${thresholds.minFreshVisualReels}`,
      ),
      criterion(
        'post-release RAG traces citing fresh visual evidence',
        visualCitationTraceCount >= thresholds.minVisualCitationTraces,
        visualCitationTraceCount,
        `>= ${thresholds.minVisualCitationTraces}`,
      ),
    ];

    const hierarchyReady = hierarchyCriteria.every((item) => item.passed);
    const visualRagEndToEndReady = visualCriteria.every((item) => item.passed);

    return {
      generatedAt: new Date().toISOString(),
      since: since.toISOString(),
      status: {
        hierarchyPromotionReady: hierarchyReady,
        visualRagEndToEndReady,
      },
      policy: {
        hierarchyServingRequiresProductionApprovalEnv:
          'RAG_HIERARCHICAL_RETRIEVAL_PROMOTION_APPROVED=true',
        overlapAndJaccardAreObservabilityOnly: true,
      },
      thresholds,
      productionObservations: {
        ragTraces: {
          total: traces.length,
          workflowMetricsCount: metricsTraceCount,
          workflowMetricCoverage,
          retrievalTraceCount: retrievalTraces.length,
          retrievalTimingTraceCount,
          firstCreatedAt: traces[0]?.createdAt?.toISOString() ?? null,
          lastCreatedAt: traces.at(-1)?.createdAt?.toISOString() ?? null,
        },
        hierarchyShadow: {
          observations: shadowObservations.length,
          directP50Ms,
          directP95Ms,
          hierarchicalP50Ms,
          hierarchicalP95Ms,
          hierarchyP95LatencyRatio,
          averageOverlapAtK: average(shadowObservations.map((item) => item.overlapAtK)),
          averageJaccard: average(shadowObservations.map((item) => item.jaccard)),
          firstCreatedAt: shadowObservations[0]?.createdAt?.toISOString() ?? null,
          lastCreatedAt: shadowObservations.at(-1)?.createdAt?.toISOString() ?? null,
        },
        visualIndex: {
          freshCompletedIndexAttempts: completedIndexAttempts,
          freshActiveVisualScenes: activeVisualScenes.length,
          freshVisualReels: freshVisualReelIds.size,
          visualCitationTraces: visualCitationTraceCount,
          visuallyCitedFreshReels: visualCitationReelIds.size,
          latestIndexAttempt: latestIndexAttempt
            ? {
                ...latestIndexAttempt,
                createdAt: latestIndexAttempt.createdAt.toISOString(),
                updatedAt: latestIndexAttempt.updatedAt.toISOString(),
              }
            : null,
        },
      },
      labelledBenchmark: benchmark,
      criteria: {
        hierarchy: hierarchyCriteria,
        visualRag: visualCriteria,
      },
    };
  } finally {
    await indexing.$disconnect();
  }
}

function printHumanSummary(report) {
  const lines = [
    'RAG production readiness',
    `Release boundary: ${report.since}`,
    `Hierarchy promotion: ${report.status.hierarchyPromotionReady ? 'READY' : 'BLOCKED'}`,
    `Visual RAG end-to-end: ${report.status.visualRagEndToEndReady ? 'READY' : 'BLOCKED'}`,
    '',
    'Hierarchy criteria:',
    ...report.criteria.hierarchy.map(
      (item) => `  ${item.passed ? 'PASS' : 'FAIL'}  ${item.name}: ${String(item.actual)} (expected ${item.expected})`,
    ),
    '',
    'Visual RAG criteria:',
    ...report.criteria.visualRag.map(
      (item) => `  ${item.passed ? 'PASS' : 'FAIL'}  ${item.name}: ${String(item.actual)} (expected ${item.expected})`,
    ),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = parseSince(args.since ?? process.env.RAG_PRODUCTION_EVIDENCE_SINCE);
  const target = args.target ?? 'all';
  if (!['all', 'hierarchy', 'visual'].includes(target)) {
    throw new Error('--target must be all, hierarchy, or visual.');
  }

  const report = await collectReadinessEvidence({
    since,
    benchmarkPath: args.benchmark ?? process.env.RAG_HIERARCHY_BENCHMARK_REPORT_PATH,
  });

  if (args.output) {
    const outputPath = path.resolve(process.cwd(), args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  printHumanSummary(report);
  if (args.json === 'true') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  const passed =
    target === 'hierarchy'
      ? report.status.hierarchyPromotionReady
      : target === 'visual'
        ? report.status.visualRagEndToEndReady
        : report.status.hierarchyPromotionReady && report.status.visualRagEndToEndReady;
  if (!passed) {
    process.exitCode = 2;
  }
}

module.exports = {
  collectReadinessEvidence,
  getVisualCitationReelIds,
  hasRetrievalNodeTimings,
  isWorkflowMetrics,
  percentile,
  readBenchmark,
};

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(
      `RAG readiness check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
