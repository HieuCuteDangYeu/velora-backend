#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { fingerprint } = require('./rag-evaluation-contract.cjs');
const {
  benchmarkEvaluations,
  BENCHMARK_EVALUATOR_VERSION,
} = require('./run-langfuse-live-benchmark.cjs');

const root = path.resolve(__dirname, '../..');
const runDir = path.join(root, '.benchmarks/rag-remediation-v8-20261026-01');
const datasetDir = path.join(runDir, 'dataset-v8-source-disjoint-20261026-03');
const defaultStateFile = path.join(
  runDir,
  'live-benchmark-state-v3/rag-v8-live-2360fcb32fd0-20261026-01.state.json',
);
const defaultOutput = path.join(runDir, 'langfuse-live-experiment.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createEvaluationSdk(env = process.env) {
  const { LangfuseSpanProcessor } = require('@langfuse/otel');
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace-base');
  return new NodeSDK({
    serviceName: 'velora-rag-v8-live-result-replay',
    sampler: new TraceIdRatioBasedSampler(1),
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_BASE_URL,
        environment: 'rag-evaluation',
        release: env.LANGFUSE_RELEASE,
        flushAt: 20,
        flushInterval: 5,
        mediaUploadEnabled: false,
        additionalHeaders: { 'x-langfuse-ingestion-version': '4' },
      }),
    ],
  });
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function outputRecord(value) {
  if (typeof value === 'string') value = JSON.parse(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Langfuse experiment output is not an object');
  return value;
}

function verifyExperimentItems(rows, entries, expectedReleaseSha) {
  const expectedById = new Map(
    entries.map(({ item, result }) => [item.id, result.output]),
  );
  if (rows.length !== expectedById.size)
    throw new Error(
      `Langfuse experiment readback returned ${rows.length}/${expectedById.size} items`,
    );
  const itemIds = new Set();
  const experimentTraceIds = new Set();
  const productionTraceIds = new Set();
  const executionIds = new Set();
  const traceReleaseValues = new Set();
  let releaseAlignedItems = 0;
  for (const row of rows) {
    const caseId = row.experimentItemMetadata?.caseId;
    const expected = expectedById.get(caseId);
    if (!expected || itemIds.has(caseId))
      throw new Error(
        `Langfuse experiment item identity is missing or duplicated: ${caseId}`,
      );
    itemIds.add(caseId);
    if (!row.traceId || experimentTraceIds.has(row.traceId))
      throw new Error(
        `Langfuse experiment trace identity is missing or duplicated: ${caseId}`,
      );
    experimentTraceIds.add(row.traceId);
    if (!Array.isArray(row.scores) || row.scores.length === 0)
      throw new Error(`Langfuse experiment scores are missing: ${caseId}`);
    const output = outputRecord(row.output);
    if (
      output.traceId !== expected.traceId ||
      output.productionExecutionId !== expected.productionExecutionId ||
      productionTraceIds.has(output.traceId) ||
      executionIds.has(output.productionExecutionId)
    )
      throw new Error(
        `Langfuse experiment production provenance differs: ${caseId}`,
      );
    productionTraceIds.add(output.traceId);
    executionIds.add(output.productionExecutionId);
    traceReleaseValues.add(output.release || 'MISSING');
    if (output.release === expectedReleaseSha) releaseAlignedItems += 1;
  }
  if (
    itemIds.size !== expectedById.size ||
    experimentTraceIds.size !== expectedById.size ||
    productionTraceIds.size !== expectedById.size ||
    executionIds.size !== expectedById.size
  )
    throw new Error(
      'Langfuse experiment readback has incomplete trace or execution coverage',
    );
  return {
    itemCount: rows.length,
    scoredItems: rows.filter((row) => row.scores.length > 0).length,
    uniqueExperimentTraces: experimentTraceIds.size,
    uniqueProductionTraces: productionTraceIds.size,
    uniqueProductionExecutions: executionIds.size,
    traceReleaseValues: [...traceReleaseValues].sort(),
    releaseAlignedItems,
    releaseIdentityStatus:
      releaseAlignedItems === expectedById.size ? 'PASS' : 'BLOCK',
  };
}

async function readExperimentItems(client, experimentId, fromStartTime) {
  const rows = [];
  let cursor;
  do {
    const page = await client.api.experiments.listItems({
      fromStartTime,
      experimentId,
      limit: 100,
      fields: 'core,dataset,io,itemMetadata,scores',
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.data);
    cursor = page.meta?.cursor;
  } while (cursor);
  return rows;
}

function aggregateBucketItemScores(rows) {
  const groups = new Map();
  for (const item of rows) {
    const bucket = item.experimentItemMetadata?.bucket;
    if (!['COMBINED', 'MULTI_REEL'].includes(bucket)) continue;
    for (const score of item.scores ?? []) {
      const relevant =
        bucket === 'COMBINED'
          ? ['modality_match', 'reel_citation_match', 'citation_source_recall']
          : ['reel_citation_match', 'citation_source_recall'];
      if (!relevant.includes(score.name) || typeof score.value !== 'number')
        continue;
      const key = `${bucket.toLowerCase()}_${score.name}`;
      const values = groups.get(key) ?? [];
      values.push(score.value);
      groups.set(key, values);
    }
  }
  return Object.fromEntries(
    [...groups].map(([name, values]) => [
      name,
      {
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        count: values.length,
      },
    ]),
  );
}

async function readBaselineExperiment(
  client,
  experimentId,
  datasetId,
  datasetSha256,
  fromStartTime,
) {
  const page = await client.api.experiments.list({
    fromStartTime,
    id: experimentId,
    fields: 'core,metadata,scores',
    scoreLimit: 50,
    limit: 10,
  });
  const run = page.data?.find((item) => item.id === experimentId);
  if (
    !run ||
    run.datasetId !== datasetId ||
    run.itemCount !== 136 ||
    run.metadata?.datasetSha256 !== datasetSha256 ||
    run.metadata?.evaluatorVersion !== BENCHMARK_EVALUATOR_VERSION
  )
    throw new Error(
      'Baseline experiment does not match the frozen 136-case dataset',
    );
  const rows = await readExperimentItems(client, experimentId, fromStartTime);
  const caseIds = rows.map((item) => item.experimentItemMetadata?.caseId);
  if (
    rows.length !== run.itemCount ||
    caseIds.some((id) => !id) ||
    new Set(caseIds).size !== run.itemCount
  )
    throw new Error('Baseline experiment item readback is incomplete');
  return {
    experimentId,
    datasetId: run.datasetId,
    itemCount: run.itemCount,
    runScores: metricScoreMap(run.scores ?? []),
    releaseSha: run.metadata?.serviceReleaseSha,
    bucketMetrics: aggregateBucketItemScores(rows),
  };
}

async function waitForExperimentReadback(
  client,
  experimentId,
  fromStartTime,
  entries,
  expectedReleaseSha,
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const rows = await readExperimentItems(
        client,
        experimentId,
        fromStartTime,
      );
      return verifyExperimentItems(rows, entries, expectedReleaseSha);
    } catch (error) {
      const canRetry =
        /readback returned \d+\/\d+ items|experiment scores are missing/.test(
          error instanceof Error ? error.message : String(error),
        ) && attempt < 11;
      if (!canRetry) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw new Error('Langfuse experiment readback did not become complete');
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i]?.startsWith('--')) continue;
    const [name, inline] = argv[i].slice(2).split('=', 2);
    if (inline !== undefined) result[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--'))
      result[name] = argv[++i];
    else result[name] = true;
  }
  return result;
}

function loadLocalRun(stateFile = defaultStateFile) {
  const state = readJson(stateFile);
  let manifest;
  let cases;
  if (Array.isArray(state.datasetSnapshot)) {
    cases = state.datasetSnapshot;
    manifest = {
      datasetVersion: cases[0]?.metadata?.datasetVersion,
      datasetSha256: state.snapshotFingerprint,
      caseCount: cases.length,
    };
  } else {
    manifest = readJson(path.join(datasetDir, 'manifest.json'));
    cases = readJson(path.join(datasetDir, 'cases.json'));
  }
  const items = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  if (
    manifest.datasetSha256 !== fingerprint(cases) ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw new Error('Frozen V8 dataset fingerprint or case identity mismatch');
  const itemIds = items.map((item) => item.id);
  if (
    manifest.datasetSha256 !== fingerprint(cases) ||
    state.datasetName !== 'velora/rag-v8-source-disjoint-20261026-03' ||
    typeof state.datasetFingerprint !== 'string' ||
    JSON.stringify(state.itemIds) !== JSON.stringify(itemIds) ||
    !/^[0-9a-f]{40}$/i.test(state.serviceReleaseSha || '')
  )
    throw new Error(
      'V8 live run identity does not match its frozen dataset and release',
    );
  const casesById = new Map(items.map((item) => [item.id, item]));
  const entries = itemIds.map((id) => ({
    item: casesById.get(id),
    result: state.cases?.[id],
  }));
  const completed = entries.filter(
    (entry) => entry.result?.status === 'COMPLETED',
  );
  const notTerminal = entries.filter(
    (entry) => !['COMPLETED', 'EXCLUDED'].includes(entry.result?.status),
  );
  const badIdentity = completed.filter(
    ({ result }) =>
      !result.output?.traceId || !result.output?.productionExecutionId,
  );
  const traceIds = completed.map(({ result }) => result.output.traceId);
  const executionIds = completed.map(
    ({ result }) => result.output.productionExecutionId,
  );
  if (
    notTerminal.length ||
    completed.length !== items.length ||
    badIdentity.length ||
    new Set(traceIds).size !== items.length ||
    new Set(executionIds).size !== items.length
  )
    throw new Error(
      'V8 live run is incomplete or lacks unique trace/execution provenance',
    );
  return {
    manifest,
    items,
    state,
    stateFile,
    datasetFingerprint: state.datasetFingerprint,
    entries,
  };
}

function aggregateRunEvaluations(itemResults) {
  const values = new Map();
  const bucketValues = new Map();
  const bucketMetrics = {
    COMBINED: new Set([
      'modality_match',
      'reel_citation_match',
      'citation_source_recall',
    ]),
    MULTI_REEL: new Set(['reel_citation_match', 'citation_source_recall']),
  };
  for (const item of itemResults) {
    const bucket = item.item?.metadata?.bucket || item.metadata?.bucket;
    for (const score of item.evaluations ?? []) {
      const rows = values.get(score.name) ?? [];
      if (typeof score.value === 'number') rows.push(score.value);
      values.set(score.name, rows);
      if (bucketMetrics[bucket]?.has(score.name)) {
        const key = `${bucket.toLowerCase()}_${score.name}`;
        const bucketRows = bucketValues.get(key) ?? [];
        if (typeof score.value === 'number') bucketRows.push(score.value);
        bucketValues.set(key, bucketRows);
      }
    }
  }
  return [...values, ...bucketValues].flatMap(([name, rows]) =>
    rows.length
      ? [
          {
            name: `mean_${name}`,
            value: rows.reduce((sum, value) => sum + value, 0) / rows.length,
            dataType: 'NUMERIC',
            comment: `${rows.length} persisted live backend responses`,
          },
        ]
      : [],
  );
}

function aggregateBucketMetrics(entries) {
  const groups = new Map();
  for (const { item, result } of entries) {
    const bucket = item.metadata?.bucket;
    if (!['COMBINED', 'MULTI_REEL'].includes(bucket)) continue;
    for (const score of benchmarkEvaluations(
      item.input,
      item.expectedOutput,
      result.output,
    )) {
      if (
        ![
          'modality_match',
          'reel_citation_match',
          'citation_source_recall',
        ].includes(score.name) ||
        typeof score.value !== 'number'
      )
        continue;
      const key = `${bucket.toLowerCase()}_${score.name}`;
      const values = groups.get(key) ?? [];
      values.push(score.value);
      groups.set(key, values);
    }
  }
  return Object.fromEntries(
    [...groups].map(([name, values]) => [
      name,
      {
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        count: values.length,
      },
    ]),
  );
}

function metricScoreMap(scores = []) {
  return new Map(
    scores
      .filter((score) => typeof score.value === 'number')
      .map((score) => [score.name, score.value]),
  );
}

function benchmarkExitGates(
  run,
  readback,
  runEvaluations,
  baseline = null,
  options = {},
) {
  const minHealthAvailability = options.minHealthAvailability ?? 0.95;
  const minQualityDelta = options.minQualityDelta ?? -0.01;
  const minCombinedScore = options.minCombinedScore ?? 0.9;
  const minMultiReelCitationScore = options.minMultiReelCitationScore ?? 0.9;
  const health = run.entries.reduce(
    (counts, { result }) => {
      const status = result.output.executionHealth?.status || 'UNKNOWN';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    },
    { AVAILABLE: 0, DEGRADED: 0, UNKNOWN: 0 },
  );
  const availableRate = health.AVAILABLE / run.entries.length;
  const traceCoverage =
    readback.itemCount === run.entries.length &&
    readback.scoredItems === run.entries.length &&
    readback.uniqueExperimentTraces === run.entries.length &&
    readback.uniqueProductionTraces === run.entries.length &&
    readback.uniqueProductionExecutions === run.entries.length
      ? 'PASS'
      : 'BLOCK';
  const releaseIdentity = readback.releaseIdentityStatus;
  const executionHealth =
    availableRate >= minHealthAvailability ? 'PASS' : 'BLOCK';
  const candidate = metricScoreMap(runEvaluations);
  const comparisonMetrics = [
    'retrieval_recall_at_5',
    'retrieval_mrr',
    'retrieval_ndcg_at_5',
    'answer_token_f1',
  ];
  const deltas = baseline
    ? Object.fromEntries(
        comparisonMetrics.map((name) => {
          const before = baseline.runScores.get(`mean_${name}`);
          const after = candidate.get(`mean_${name}`);
          return [
            name,
            {
              baseline: before ?? null,
              candidate: after ?? null,
              delta:
                Number.isFinite(before) && Number.isFinite(after)
                  ? after - before
                  : null,
            },
          ];
        }),
      )
    : null;
  const retrievalNonRegression = baseline
    ? Object.values(deltas).every(
        (row) => row.delta !== null && row.delta >= minQualityDelta,
      )
      ? 'PASS'
      : 'BLOCK'
    : 'NOT_EVALUATED';
  const buckets = aggregateBucketMetrics(run.entries);
  const compareBucketMetrics = (bucket, names) => {
    if (!baseline) return null;
    return Object.fromEntries(
      names.map((name) => {
        const key = `${bucket}_${name}`;
        const before = baseline.bucketMetrics[key]?.mean;
        const after = buckets[key]?.mean;
        return [
          name,
          {
            baseline: before ?? null,
            candidate: after ?? null,
            delta:
              Number.isFinite(before) && Number.isFinite(after)
                ? after - before
                : null,
          },
        ];
      }),
    );
  };
  const combinedDeltas = compareBucketMetrics('combined', [
    'modality_match',
    'reel_citation_match',
    'citation_source_recall',
  ]);
  const multiReelDeltas = compareBucketMetrics('multi_reel', [
    'reel_citation_match',
    'citation_source_recall',
  ]);
  const combinedNonRegression = Boolean(
    combinedDeltas &&
    Object.values(combinedDeltas).every(
      (row) => row.delta !== null && row.delta >= minQualityDelta,
    ),
  );
  const multiReelNonRegression = Boolean(
    multiReelDeltas &&
    Object.values(multiReelDeltas).every(
      (row) => row.delta !== null && row.delta >= minQualityDelta,
    ),
  );
  const combinedPass =
    (buckets.combined_modality_match?.mean ?? -1) >= minCombinedScore &&
    (buckets.combined_reel_citation_match?.mean ?? -1) >= minCombinedScore &&
    (buckets.combined_citation_source_recall?.mean ?? -1) >= minCombinedScore;
  const multiReelPass =
    (buckets.multi_reel_reel_citation_match?.mean ?? -1) >=
      minMultiReelCitationScore &&
    (buckets.multi_reel_citation_source_recall?.mean ?? -1) >=
      minMultiReelCitationScore;
  const combinedQuality =
    combinedPass && (!baseline || combinedNonRegression) ? 'PASS' : 'BLOCK';
  const multiReelQuality =
    multiReelPass && (!baseline || multiReelNonRegression) ? 'PASS' : 'BLOCK';
  const gates = [
    traceCoverage,
    releaseIdentity,
    executionHealth,
    retrievalNonRegression,
    combinedQuality,
    multiReelQuality,
  ];
  return {
    status: gates.every((gate) => gate === 'PASS') ? 'PASS' : 'BLOCK',
    thresholds: {
      minHealthAvailability,
      minQualityDelta,
      minCombinedScore,
      minMultiReelCitationScore,
    },
    traceCoverage,
    releaseIdentity,
    executionHealth,
    availableRate,
    health,
    retrievalNonRegression,
    retrievalDeltas: deltas,
    combinedNonRegression: baseline
      ? combinedNonRegression
        ? 'PASS'
        : 'BLOCK'
      : 'NOT_EVALUATED',
    combinedDeltas,
    combinedQuality,
    multiReelNonRegression: baseline
      ? multiReelNonRegression
        ? 'PASS'
        : 'BLOCK'
      : 'NOT_EVALUATED',
    multiReelDeltas,
    multiReelQuality,
    bucketMetrics: buckets,
    baselineExperimentId: baseline?.experimentId ?? null,
  };
}

function runEvaluators() {
  return [async ({ itemResults }) => aggregateRunEvaluations(itemResults)];
}

async function selfTest() {
  const values = runEvaluators();
  assert.equal(values.length, 1);
  const sdk = createEvaluationSdk({
    LANGFUSE_PUBLIC_KEY: 'pk-test',
    LANGFUSE_SECRET_KEY: 'sk-test',
    LANGFUSE_BASE_URL: 'https://langfuse.test',
    LANGFUSE_RELEASE: 'release-test',
  });
  assert.equal(typeof sdk.start, 'function');
  assert.equal(
    sha256(Buffer.from('v8')),
    crypto.createHash('sha256').update('v8').digest('hex'),
  );
  assert.deepEqual(outputRecord('{"traceId":"production-trace"}'), {
    traceId: 'production-trace',
  });
  assert.deepEqual(
    verifyExperimentItems(
      [
        {
          traceId: 'experiment-trace-1',
          experimentItemMetadata: { caseId: 'case-1' },
          output: JSON.stringify({
            traceId: 'production-trace-1',
            productionExecutionId: 'execution-1',
            release: '2360fcb32fd09da0c106fcb18bb819045c8ac705',
          }),
          scores: [{ name: 'retrieval_recall_at_5', value: 1 }],
        },
      ],
      [
        {
          item: { id: 'case-1' },
          result: {
            output: {
              traceId: 'production-trace-1',
              productionExecutionId: 'execution-1',
              release: '2360fcb32fd09da0c106fcb18bb819045c8ac705',
            },
          },
        },
      ],
      '2360fcb32fd09da0c106fcb18bb819045c8ac705',
    ),
    {
      itemCount: 1,
      scoredItems: 1,
      uniqueExperimentTraces: 1,
      uniqueProductionTraces: 1,
      uniqueProductionExecutions: 1,
      traceReleaseValues: ['2360fcb32fd09da0c106fcb18bb819045c8ac705'],
      releaseAlignedItems: 1,
      releaseIdentityStatus: 'PASS',
    },
  );
  let readbackAttempts = 0;
  const expectedEntries = [
    {
      item: { id: 'case-1' },
      result: {
        output: {
          traceId: 'production-trace-1',
          productionExecutionId: 'execution-1',
          release: '2360fcb32fd09da0c106fcb18bb819045c8ac705',
        },
      },
    },
  ];
  const experimentRows = [
    {
      traceId: 'experiment-trace-1',
      experimentItemMetadata: { caseId: 'case-1' },
      output: {
        traceId: 'production-trace-1',
        productionExecutionId: 'execution-1',
        release: '2360fcb32fd09da0c106fcb18bb819045c8ac705',
      },
      scores: [{ name: 'retrieval_recall_at_5', value: 1 }],
    },
  ];
  assert.deepEqual(
    await waitForExperimentReadback(
      {
        api: {
          experiments: {
            listItems: async () => ({
              data: ++readbackAttempts === 1 ? [] : experimentRows,
            }),
          },
        },
      },
      'experiment-1',
      '2026-10-26T00:00:00.000Z',
      expectedEntries,
      '2360fcb32fd09da0c106fcb18bb819045c8ac705',
    ),
    {
      itemCount: 1,
      scoredItems: 1,
      uniqueExperimentTraces: 1,
      uniqueProductionTraces: 1,
      uniqueProductionExecutions: 1,
      traceReleaseValues: ['2360fcb32fd09da0c106fcb18bb819045c8ac705'],
      releaseAlignedItems: 1,
      releaseIdentityStatus: 'PASS',
    },
  );
  assert.equal(readbackAttempts, 2);
  const gateRelease = '2360fcb32fd09da0c106fcb18bb819045c8ac705';
  const makeGateEntry = (id, bucket, reelIds, evidenceIds, modalities) => ({
    item: {
      id,
      metadata: { bucket },
      input: { reelIds, evidenceIds, modality: 'TRANSCRIPT' },
      expectedOutput: {
        answer: 'a',
        reelIds,
        evidenceIds,
        relevantEvidenceGroups: evidenceIds.map((value) => [value]),
        expectedEvidenceTypes: modalities,
        modality: 'TRANSCRIPT',
      },
    },
    result: {
      output: {
        answer: 'a',
        executionHealth: { status: 'AVAILABLE' },
        traceId: `production-${id}`,
        productionExecutionId: `execution-${id}`,
        release: gateRelease,
        retrievedEvidenceIds: evidenceIds,
        citations: evidenceIds.map((evidenceId, index) => ({
          reelId: reelIds[Math.min(index, reelIds.length - 1)],
          evidenceId,
          evidenceType: modalities[index],
        })),
      },
    },
  });
  const combinedIds = ['reel:r1:visual:0', 'reel:r1:chunk:0'];
  const multiIds = ['reel:r1:chunk:0', 'reel:r2:chunk:0'];
  const gateRun = {
    entries: [
      makeGateEntry('combined', 'COMBINED', ['r1'], combinedIds, [
        'VISUAL',
        'TRANSCRIPT',
      ]),
      makeGateEntry('multi', 'MULTI_REEL', ['r1', 'r2'], multiIds, [
        'TRANSCRIPT',
        'TRANSCRIPT',
      ]),
    ],
  };
  const gateReadback = {
    itemCount: 2,
    scoredItems: 2,
    uniqueExperimentTraces: 2,
    uniqueProductionTraces: 2,
    uniqueProductionExecutions: 2,
    releaseIdentityStatus: 'PASS',
  };
  const gateScores = [
    'retrieval_recall_at_5',
    'retrieval_mrr',
    'retrieval_ndcg_at_5',
    'answer_token_f1',
  ].map((name) => ({ name: `mean_${name}`, value: 1 }));
  const baseline = {
    experimentId: 'baseline-run',
    runScores: new Map(gateScores.map((score) => [score.name, score.value])),
    bucketMetrics: {
      combined_modality_match: { mean: 1, count: 1 },
      combined_reel_citation_match: { mean: 1, count: 1 },
      combined_citation_source_recall: { mean: 1, count: 1 },
      multi_reel_reel_citation_match: { mean: 1, count: 1 },
      multi_reel_citation_source_recall: { mean: 1, count: 1 },
    },
  };
  assert.equal(
    benchmarkExitGates(gateRun, gateReadback, gateScores, baseline).status,
    'PASS',
  );
  assert.equal(
    benchmarkExitGates(
      {
        entries: [
          ...gateRun.entries,
          {
            ...gateRun.entries[0],
            result: {
              output: {
                ...gateRun.entries[0].result.output,
                executionHealth: { status: 'UNKNOWN' },
              },
            },
          },
        ],
      },
      gateReadback,
      gateScores,
      baseline,
    ).status,
    'BLOCK',
  );
  assert.equal(
    verifyExperimentItems(
      [
        {
          traceId: 'experiment-trace-1',
          experimentItemMetadata: { caseId: 'case-1' },
          output: {
            traceId: 'production-trace-1',
            productionExecutionId: 'execution-1',
            release: 'old-release',
          },
          scores: [{ name: 'recall', value: 1 }],
        },
      ],
      expectedEntries,
      '2360fcb32fd09da0c106fcb18bb819045c8ac705',
    ).releaseIdentityStatus,
    'BLOCK',
  );
  assert.throws(
    () =>
      verifyExperimentItems(
        [
          {
            traceId: 'experiment-trace-1',
            experimentItemMetadata: { caseId: 'case-1' },
            output: {
              traceId: 'production-trace-1',
              productionExecutionId: 'execution-1',
            },
            scores: [{ name: 'recall', value: 1 }],
          },
          {
            traceId: 'experiment-trace-2',
            experimentItemMetadata: { caseId: 'case-1' },
            output: {
              traceId: 'production-trace-2',
              productionExecutionId: 'execution-2',
            },
            scores: [{ name: 'recall', value: 1 }],
          },
        ],
        [
          {
            item: { id: 'case-1' },
            result: {
              output: {
                traceId: 'production-trace-1',
                productionExecutionId: 'execution-1',
              },
            },
          },
          {
            item: { id: 'case-2' },
            result: {
              output: {
                traceId: 'production-trace-2',
                productionExecutionId: 'execution-2',
              },
            },
          },
        ],
      ),
    /identity is missing or duplicated/,
  );
  assert.deepEqual(
    aggregateRunEvaluations([
      { evaluations: [{ name: 'retrieval_recall_at_5', value: 1 }] },
      { evaluations: [{ name: 'retrieval_recall_at_5', value: 0.5 }] },
    ]),
    [
      {
        name: 'mean_retrieval_recall_at_5',
        value: 0.75,
        dataType: 'NUMERIC',
        comment: '2 persisted live backend responses',
      },
    ],
  );
  const bucketAggregate = aggregateRunEvaluations([
    {
      item: { metadata: { bucket: 'COMBINED' } },
      evaluations: [{ name: 'modality_match', value: 0.5 }],
    },
    {
      item: { metadata: { bucket: 'MULTI_REEL' } },
      evaluations: [{ name: 'reel_citation_match', value: 1 }],
    },
  ]);
  assert.equal(
    bucketAggregate.find(
      (score) => score.name === 'mean_combined_modality_match',
    )?.value,
    0.5,
  );
  assert.equal(
    bucketAggregate.find(
      (score) => score.name === 'mean_multi_reel_reel_citation_match',
    )?.value,
    1,
  );
  process.stdout.write('V8 live experiment publisher self-check passed\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) return selfTest();
  if (!args.apply)
    throw new Error('Langfuse live experiment writes require --apply');
  const stateFile = path.resolve(
    String(args['state-file'] || defaultStateFile),
  );
  const run = loadLocalRun(stateFile);
  const minHealthAvailability = Number(args['min-health-availability'] ?? 0.95);
  const baselineExperimentId = String(
    args['baseline-experiment-id'] || '',
  ).trim();
  if (
    !Number.isFinite(minHealthAvailability) ||
    minHealthAvailability < 0 ||
    minHealthAvailability > 1
  )
    throw new Error('--min-health-availability must be between 0 and 1');
  const outputFile = path.resolve(
    String(
      args.output ||
        (stateFile === defaultStateFile
          ? defaultOutput
          : path.join(
              path.dirname(stateFile),
              `${run.state.runId}.langfuse-experiment.json`,
            )),
    ),
  );
  let recovery = null;
  if (fs.existsSync(outputFile)) {
    const previous = readJson(outputFile);
    if (previous.status === 'COMPLETE') {
      process.stdout.write(
        `${previous.datasetRunUrl || previous.datasetRunId}\n`,
      );
      if (args['require-exit-gates'] && previous.exitGates?.status !== 'PASS')
        process.exitCode = 2;
      return;
    }
    if (previous.status !== 'VERIFYING' || !previous.experimentId)
      throw new Error(
        'A Langfuse live replay may have started; reconcile it before retrying',
      );
    recovery = previous;
  }
  const sourceStateSha256 = sha256(fs.readFileSync(stateFile));
  const startedAt = recovery?.startedAt || new Date().toISOString();
  if (recovery && recovery.sourceStateSha256 !== sourceStateSha256)
    throw new Error(
      'Langfuse replay recovery state does not match the frozen source state',
    );
  dotenv.config({ path: path.join(root, '.env') });
  for (const name of [
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_BASE_URL',
  ])
    if (!process.env[name])
      throw new Error(`Missing ${name} for Langfuse experiment`);
  process.env.LANGFUSE_ENABLED = 'true';
  process.env.LANGFUSE_SAMPLE_RATE = '1';
  process.env.LANGFUSE_TRACING_ENVIRONMENT = 'rag-evaluation';
  process.env.LANGFUSE_CAPTURE_CONTENT = 'true';
  process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT = 'true';
  process.env.LANGFUSE_RELEASE = run.state.serviceReleaseSha;
  process.env.OTEL_SERVICE_NAME = 'velora-rag-v8-live-result-replay';
  const sdk = createEvaluationSdk();
  sdk?.start();
  const { LangfuseClient } = require('@langfuse/client');
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  try {
    const dataset = await client.dataset.get(run.state.datasetName, {
      fetchItemsPageSize: 100,
    });
    const langfuseItems = [...dataset.items].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    if (dataset.items.length !== run.items.length)
      throw new Error(
        'Langfuse V8 dataset count does not match the frozen local dataset',
      );
    const langfuseDatasetFingerprint = sha256(
      JSON.stringify(
        langfuseItems.map(({ id, input, expectedOutput }) => ({
          id,
          input,
          expectedOutput,
        })),
      ),
    );
    if (langfuseDatasetFingerprint !== run.state.datasetFingerprint)
      throw new Error(
        'Langfuse V8 dataset fingerprint differs from the live run',
      );
    const localById = new Map(run.items.map((item) => [item.id, item]));
    for (const item of dataset.items) {
      const local = localById.get(item.id);
      if (
        !local ||
        fingerprint({
          input: item.input,
          expectedOutput: item.expectedOutput,
          metadata: item.metadata,
        }) !==
          fingerprint({
            input: local.input,
            expectedOutput: local.expectedOutput,
            metadata: local.metadata,
          })
      )
        throw new Error(`Langfuse V8 dataset readback differs: ${item.id}`);
    }
    const baseline = baselineExperimentId
      ? await readBaselineExperiment(
          client,
          baselineExperimentId,
          dataset.id,
          run.manifest.datasetSha256,
          '2026-10-26T00:00:00.000Z',
        )
      : null;
    if (args['require-exit-gates'] && !baseline)
      throw new Error(
        '--baseline-experiment-id is required for the release gate',
      );
    let registration = recovery;
    if (!registration) {
      const stateCases = run.state.cases;
      writeJsonAtomic(outputFile, {
        status: 'IN_PROGRESS',
        datasetName: run.state.datasetName,
        datasetSha256: run.manifest.datasetSha256,
        benchmarkRunId: run.state.runId,
        serviceReleaseSha: run.state.serviceReleaseSha,
        sourceStateSha256,
        startedAt,
      });
      const result = await client.experiment.run({
        name: 'V8 live RAG production benchmark',
        runName: `${run.state.runId} cached response replay ${BENCHMARK_EVALUATOR_VERSION}`,
        description:
          'Replays persisted production API responses and their linked rag.workflow traces; it makes no new RAG or model calls.',
        metadata: {
          datasetVersion: run.manifest.datasetVersion,
          datasetSha256: run.manifest.datasetSha256,
          serviceReleaseSha: run.state.serviceReleaseSha,
          baselineExperimentId: baseline?.experimentId ?? null,
          evaluatorVersion: BENCHMARK_EVALUATOR_VERSION,
          sourceTraceReleaseValues: [
            ...new Set(
              run.entries.map(
                ({ result }) => result.output.release || 'MISSING',
              ),
            ),
          ].sort(),
          benchmarkRunId: run.state.runId,
          sourceStateSha256,
          sourceMode: 'PERSISTED_LIVE_BACKEND_RESPONSE_REPLAY',
          productionRagRequestAttempts: Object.values(stateCases).reduce(
            (sum, entry) => sum + (entry.attemptCount ?? 0),
            0,
          ),
        },
        data: dataset.items.map((item) => ({
          ...item,
          metadata: {
            ...item.metadata,
            caseId: item.id,
            sourceProductionTraceId: stateCases[item.id]?.output?.traceId,
            sourceProductionExecutionId:
              stateCases[item.id]?.output?.productionExecutionId,
          },
        })),
        task: async ({ metadata }) => {
          const entry = stateCases[metadata?.caseId];
          if (entry?.status !== 'COMPLETED')
            throw new Error(
              `Persisted live response missing: ${metadata?.caseId}`,
            );
          return entry.output;
        },
        evaluators: [
          async ({ input, expectedOutput, output }) => [
            ...benchmarkEvaluations(input, expectedOutput, output),
            {
              name: 'trace_release_aligned',
              value: Number(output?.release === run.state.serviceReleaseSha),
              dataType: 'NUMERIC',
              comment: `RAG trace release ${output?.release || 'MISSING'}; benchmark image ${run.state.serviceReleaseSha}`,
            },
          ],
        ],
        runEvaluators: runEvaluators(),
        maxConcurrency: 8,
      });
      if (
        result.itemResults.length !== run.items.length ||
        result.itemResults.some((item) => !item.evaluations?.length) ||
        !result.experimentId
      )
        throw new Error(
          'Langfuse live replay trace or score coverage is incomplete',
        );
      registration = {
        status: 'VERIFYING',
        datasetName: run.state.datasetName,
        datasetSha256: run.manifest.datasetSha256,
        benchmarkRunId: run.state.runId,
        serviceReleaseSha: run.state.serviceReleaseSha,
        baselineExperimentId: baseline?.experimentId ?? null,
        datasetRunId: result.datasetRunId,
        experimentId: result.experimentId,
        datasetRunUrl:
          result.datasetRunUrl ||
          `${process.env.LANGFUSE_BASE_URL.replace(/\/$/, '')}/project/${dataset.projectId}/datasets/${dataset.id}/runs/${result.datasetRunId}`,
        itemCount: result.itemResults.length,
        scoredItems: result.itemResults.filter(
          (item) => item.evaluations.length > 0,
        ).length,
        runEvaluations: result.runEvaluations,
        evaluatorVersion: BENCHMARK_EVALUATOR_VERSION,
        sourceTraceReleaseValues: [
          ...new Set(
            run.entries.map(({ result }) => result.output.release || 'MISSING'),
          ),
        ].sort(),
        sourceStateSha256,
        startedAt,
        verifyingAt: new Date().toISOString(),
      };
      writeJsonAtomic(outputFile, registration);
    }
    await client.flush();
    registration.readback = await waitForExperimentReadback(
      client,
      registration.experimentId,
      startedAt,
      run.entries,
      run.state.serviceReleaseSha,
    );
    registration.exitGates = benchmarkExitGates(
      run,
      registration.readback,
      registration.runEvaluations ?? [],
      baseline,
      { minHealthAvailability },
    );
    registration.status = 'COMPLETE';
    registration.completedAt = new Date().toISOString();
    writeJsonAtomic(outputFile, registration);
    await client.flush();
    process.stdout.write(JSON.stringify(registration, null, 2) + '\n');
    if (args['require-exit-gates'] && registration.exitGates.status !== 'PASS')
      process.exitCode = 2;
  } finally {
    await client.flush();
    await client.shutdown();
    await sdk?.shutdown();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = {
  loadLocalRun,
  outputRecord,
  readExperimentItems,
  readBaselineExperiment,
  aggregateBucketItemScores,
  waitForExperimentReadback,
  runEvaluators,
  aggregateRunEvaluations,
  verifyExperimentItems,
  benchmarkExitGates,
};
