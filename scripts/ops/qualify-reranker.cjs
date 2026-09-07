#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ConfigService } = require('@nestjs/config');
const { TeiRerankerAdapter } = require(
  path.join(
    process.env.RAG_QUALIFICATION_DIST_ROOT || path.resolve(__dirname, '../..'),
    'dist/apps/ai-service/apps/ai-service/src/infrastructure/adapters/tei-reranker.adapter.js',
  ),
);
const { SimpleRerankerAdapter } = require(
  path.join(
    process.env.RAG_QUALIFICATION_DIST_ROOT || path.resolve(__dirname, '../..'),
    'dist/apps/ai-service/apps/ai-service/src/infrastructure/adapters/simple-reranker.adapter.js',
  ),
);

const repositoryRoot =
  process.env.RAG_QUALIFICATION_REPOSITORY_ROOT ||
  path.resolve(__dirname, '../..');
const datasetPath = path.join(
  repositoryRoot,
  'eval/rag/datasets/rag-reranker-generalization-v1.json',
);

function loadDataset() {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  if (dataset.schemaVersion !== 'rag-reranker-qualification-v1') {
    throw new Error('unsupported reranker qualification schema');
  }
  if (dataset.datasetVersion !== 'rag-reranker-generalization-v1') {
    throw new Error('unexpected reranker dataset version');
  }
  if (!dataset.provenance || dataset.provenance.kind !== 'SAFE_TEST_FIXTURES') {
    throw new Error('reranker dataset provenance is not safe-test-fixtures');
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length < 2) {
    throw new Error('reranker qualification requires at least two cases');
  }
  for (const item of dataset.cases) {
    if (
      !item.id ||
      !item.queryText ||
      !Array.isArray(item.candidates) ||
      item.candidates.length < 2 ||
      !Array.isArray(item.relevantIds) ||
      !item.relevantIds.length
    ) {
      throw new Error(`invalid reranker qualification case: ${item.id}`);
    }
    const ids = new Set(item.candidates.map((candidate) => candidate.id));
    if (ids.size !== item.candidates.length) {
      throw new Error(`duplicate candidate IDs: ${item.id}`);
    }
    if (item.relevantIds.some((id) => !ids.has(id))) {
      throw new Error(
        `relevance judgment references an unknown candidate: ${item.id}`,
      );
    }
  }
  return dataset;
}

function caseMetrics(ranked, item) {
  const ids = ranked.map((candidate) => candidate.id);
  const relevant = new Set(item.relevantIds);
  const firstRelevant = ids.findIndex((id) => relevant.has(id));
  const dcg = ids
    .slice(0, 5)
    .reduce(
      (sum, id, index) =>
        sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0),
      0,
    );
  const ideal = Array.from(
    { length: Math.min(relevant.size, 5) },
    (_, index) => 1 / Math.log2(index + 2),
  ).reduce((sum, value) => sum + value, 0);
  const firstWrongReel = ids.findIndex((id) => {
    const candidate = ranked.find((value) => value.id === id);
    return candidate && !item.expectedReelIds.includes(candidate.reelId);
  });
  return {
    rank: firstRelevant < 0 ? null : firstRelevant + 1,
    recallAt1: Number(ids.slice(0, 1).some((id) => relevant.has(id))),
    recallAt3: Number(ids.slice(0, 3).some((id) => relevant.has(id))),
    recallAt5: Number(ids.slice(0, 5).some((id) => relevant.has(id))),
    recallAt10: Number(ids.slice(0, 10).some((id) => relevant.has(id))),
    mrr: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    ndcgAt5: ideal ? dcg / ideal : null,
    ndcgAt10: ideal ? dcg / ideal : null,
    evidenceHit: Number(ids.some((id) => relevant.has(id))),
    wrongReelRank: firstWrongReel < 0 ? null : firstWrongReel + 1,
    ids,
  };
}

function aggregate(rows) {
  const keys = [
    'recallAt1',
    'recallAt3',
    'recallAt5',
    'recallAt10',
    'mrr',
    'ndcgAt5',
    'ndcgAt10',
    'evidenceHit',
  ];
  return Object.fromEntries(
    keys.map((key) => [
      key,
      rows.reduce((sum, row) => sum + row[key], 0) / rows.length,
    ]),
  );
}

function noMaterialRegression(neural, simple) {
  const metricKeys = [
    'recallAt1',
    'recallAt3',
    'recallAt5',
    'recallAt10',
    'mrr',
    'ndcgAt5',
    'ndcgAt10',
    'evidenceHit',
  ];
  return metricKeys.every((key) => neural[key] >= simple[key]);
}

async function main() {
  const dataset = loadDataset();
  const baseUrl =
    process.env.RERANKER_QUALIFICATION_BASE_URL || 'http://rag-reranker:80';
  const health = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`);
  if (!health.ok)
    throw new Error(`TEI reranker health failed: ${health.status}`);

  const config = new ConfigService({
    TEI_RERANKER_BASE_URL: baseUrl,
    AI_RAG_NEURAL_RERANK_ENABLED: 'true',
    AI_RAG_RERANK_MAX_LIMIT: '8',
    AI_RAG_NEURAL_RERANK_CANDIDATE_LIMIT: '20',
  });
  const simple = new SimpleRerankerAdapter(config);
  const neural = new TeiRerankerAdapter(config, {
    rerank: async () => {
      throw new Error(
        'neural reranker failed; fallback is disabled for qualification',
      );
    },
  });
  const neuralRows = [];
  const simpleRows = [];
  for (const item of dataset.cases) {
    const [neuralRanked, simpleRanked] = await Promise.all([
      neural.rerank({
        queryText: item.queryText,
        candidates: item.candidates,
        limit: item.candidates.length,
      }),
      simple.rerank({
        queryText: item.queryText,
        candidates: item.candidates,
        limit: item.candidates.length,
      }),
    ]);
    neuralRows.push({ id: item.id, ...caseMetrics(neuralRanked, item) });
    simpleRows.push({ id: item.id, ...caseMetrics(simpleRanked, item) });
  }
  const neuralMetrics = aggregate(neuralRows);
  const simpleMetrics = aggregate(simpleRows);
  const pass = noMaterialRegression(neuralMetrics, simpleMetrics);
  console.log(
    JSON.stringify({
      dataset: dataset.datasetVersion,
      caseCount: dataset.cases.length,
      neural: neuralMetrics,
      simple: simpleMetrics,
      neuralRows,
      simpleRows,
      qualification: pass ? 'PASS' : 'FAIL',
      interpretation: pass
        ? 'MiniLM has no material regression on the versioned safe fixture set; sample is small and not a statistical reliability claim.'
        : 'MiniLM regressed on at least one deterministic metric; stop before provider cutover.',
    }),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
