const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createLangfuseClient, loadLangfuseHierarchyShadowObservations } = require('./langfuse-rag-traces.cjs');
const {
  PrismaClient: ReelIndexingPrismaClient,
} = require('@prisma/reel-indexing-client');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value || value === '--' || !value.startsWith('--')) continue;
    const [name, inlineValue] = value.slice(2).split('=', 2);
    const nextValue = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && nextValue && !nextValue.startsWith('--')) {
      index += 1;
    }
    args[name] = inlineValue ?? nextValue ?? 'true';
  }
  return args;
}

function parseDate(value, flagName) {
  if (!value) return null;
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new Error(`${flagName} must be an ISO timestamp.`);
  }
  return result;
}

function parsePositiveInteger(value, fallback, flagName) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))];
}

function metrics(rankedIds, relevantIds, k) {
  const relevant = new Set(relevantIds);
  const ranked = [...new Set(rankedIds)].slice(0, k);
  const hits = ranked.filter((id) => relevant.has(id));
  const firstRelevantRank = ranked.findIndex((id) => relevant.has(id));
  const dcg = ranked.reduce(
    (score, id, index) => score + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealHitCount = Math.min(relevant.size, k);
  let idealDcg = 0;
  for (let index = 0; index < idealHitCount; index += 1) {
    idealDcg += 1 / Math.log2(index + 2);
  }

  return {
    recallAtK: relevant.size > 0 ? hits.length / relevant.size : 0,
    reciprocalRank: firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0,
    ndcgAtK: idealDcg > 0 ? dcg / idealDcg : 0,
  };
}

function averageMetricRows(rows) {
  if (rows.length === 0) {
    return { recallAtK: 0, reciprocalRank: 0, ndcgAtK: 0 };
  }

  return rows.reduce(
    (result, row) => ({
      recallAtK: result.recallAtK + row.recallAtK / rows.length,
      reciprocalRank: result.reciprocalRank + row.reciprocalRank / rows.length,
      ndcgAtK: result.ndcgAtK + row.ndcgAtK / rows.length,
    }),
    { recallAtK: 0, reciprocalRank: 0, ndcgAtK: 0 },
  );
}

function evaluateCases(cases, k) {
  const validCases = cases.filter((item) => item.id && item.relevantIds.length > 0);
  const direct = averageMetricRows(
    validCases.map((item) => metrics(item.directRankedIds, item.relevantIds, k)),
  );
  const hierarchical = averageMetricRows(
    validCases.map((item) => metrics(item.hierarchicalRankedIds, item.relevantIds, k)),
  );

  return {
    cases: validCases.length,
    k,
    direct,
    hierarchical,
    delta: {
      recallAtK: hierarchical.recallAtK - direct.recallAtK,
      reciprocalRank: hierarchical.reciprocalRank - direct.reciprocalRank,
      ndcgAtK: hierarchical.ndcgAtK - direct.ndcgAtK,
    },
  };
}

function truncate(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

async function loadCandidateEvidence(indexing, ids) {
  if (ids.length === 0) return new Map();
  const [chunks, visualScenes] = await Promise.all([
    indexing.reelChunk.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        reelId: true,
        evidenceText: true,
        startTime: true,
        endTime: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    indexing.reelVisualScene.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        reelId: true,
        evidenceText: true,
        startTime: true,
        endTime: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const evidenceById = new Map();
  for (const item of [...chunks, ...visualScenes]) {
    if (evidenceById.has(item.id)) continue;
    evidenceById.set(item.id, {
      id: item.id,
      reelId: item.reelId,
      evidenceText: truncate(item.evidenceText, 500),
      startTime: item.startTime,
      endTime: item.endTime,
    });
  }
  return evidenceById;
}

async function exportLabelTemplate({ since, until, limit, output }) {
  const indexing = new ReelIndexingPrismaClient();

  try {
    const observations = (await loadLangfuseHierarchyShadowObservations(createLangfuseClient(), {
      ...(since ? { fromStartTime: since.toISOString() } : {}),
      toStartTime: (until || new Date()).toISOString(),
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || 'production',
    })).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    if (observations.some((item) => !item.queryText))
      throw new Error('HIERARCHY_LABEL_QUERY=MISSING: label export requires query capture via LANGFUSE_CAPTURE_CONTENT in an isolated evaluation environment');

    const allCandidateIds = [
      ...new Set(
        observations.flatMap((item) => [
          ...asStringArray(item.directChunkIds),
          ...asStringArray(item.hierarchicalChunkIds),
        ]),
      ),
    ];
    const evidenceById = await loadCandidateEvidence(indexing, allCandidateIds);

    const template = {
      generatedAt: new Date().toISOString(),
      instructions: [
        'Review each query and the candidate evidence.',
        'Set relevantIds to every candidate ID that directly contains evidence relevant to answering the query.',
        'Do not label an item relevant merely because it is top-ranked or semantically similar.',
        'Leave relevantIds empty to exclude a case from scoring until it has been reviewed.',
      ],
      cases: observations.map((observation) => {
        const directRankedIds = asStringArray(observation.directChunkIds);
        const hierarchicalRankedIds = asStringArray(observation.hierarchicalChunkIds);
        const candidateIds = [...new Set([...directRankedIds, ...hierarchicalRankedIds])];
        return {
          id: observation.id,
          observedAt: observation.createdAt.toISOString(),
          query: observation.queryText,
          retrievalMode: observation.retrievalMode,
          requiredEvidence: observation.requiredEvidence,
          directMs: observation.directMs,
          hierarchicalMs: observation.hierarchicalMs,
          directRankedIds,
          hierarchicalRankedIds,
          candidates: candidateIds.map(
            (candidateId) => evidenceById.get(candidateId) ?? { id: candidateId, evidenceText: null },
          ),
          relevantIds: [],
        };
      }),
    };

    const resolvedOutput = path.resolve(process.cwd(), output);
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    fs.writeFileSync(resolvedOutput, `${JSON.stringify(template, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { output: resolvedOutput, cases: template.cases.length };
  } finally {
    await indexing.$disconnect();
  }
}

function scoreLabelFile({ labelsPath, k, output }) {
  const resolvedLabelsPath = path.resolve(process.cwd(), labelsPath);
  const parsed = JSON.parse(fs.readFileSync(resolvedLabelsPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cases)) {
    throw new Error('Label file must contain a cases array exported by this command.');
  }

  const cases = parsed.cases.map((item) => ({
    id: typeof item.id === 'string' ? item.id : '',
    relevantIds: asStringArray(item.relevantIds),
    directRankedIds: asStringArray(item.directRankedIds),
    hierarchicalRankedIds: asStringArray(item.hierarchicalRankedIds),
  }));
  const report = evaluateCases(cases, k);
  const resolvedOutput = path.resolve(process.cwd(), output);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { output: resolvedOutput, report };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args['export-template']) {
    const result = await exportLabelTemplate({
      since: parseDate(args.since, '--since'),
      until: parseDate(args.until, '--until'),
      limit: parsePositiveInteger(args.limit, 100, '--limit'),
      output: args['export-template'],
    });
    process.stdout.write(`Exported ${result.cases} hierarchy shadow cases to ${result.output}\n`);
    return;
  }

  if (args.labels) {
    const result = scoreLabelFile({
      labelsPath: args.labels,
      k: parsePositiveInteger(args.k, 5, '--k'),
      output: args.output ?? 'artifacts/rag-hierarchy-benchmark.json',
    });
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    process.stdout.write(`Wrote labelled benchmark report to ${result.output}\n`);
    if (result.report.cases === 0) {
      process.exitCode = 2;
    }
    return;
  }

  throw new Error(
    'Use --export-template <path> to create a labelling file, or --labels <path> [--output <path>] to score labelled cases.',
  );
}

module.exports = {
  asStringArray,
  evaluateCases,
  metrics,
  scoreLabelFile,
};

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(
      `Hierarchy benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
