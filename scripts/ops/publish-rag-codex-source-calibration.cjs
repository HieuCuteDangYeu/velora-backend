#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { fingerprint } = require('./rag-evaluation-contract.cjs');
const { DIMENSIONS } = require('./rag-evaluation-applicability.cjs');

const root = path.resolve(__dirname, '../..');
const runDir = path.join(
  root,
  '.benchmarks/rag-remediation-v7-20261022-01/evaluation-v22-transcript-evidence-bounds-20261025-01',
);
const datasetDir = path.join(
  root,
  '.benchmarks/rag-remediation-v7-20261022-01/dataset-v7-visual-reviewed-20261022-02',
);
const reviewPath = path.join(
  runDir,
  'codex-judge-source-review-v1/source-review-labels.json',
);
const codexReportPath = path.join(runDir, 'codex-judge-calibration-v1.json');
const datasetName = 'judge-calibration/codex-gpt-6-luna-source-v1';
const outputPath = path.join(
  runDir,
  'codex-judge-source-review-v1/langfuse-calibration.json',
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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
    throw new Error('Langfuse source-calibration output is not an object');
  return value;
}

function readCalibrationData() {
  const sourceReview = readJson(reviewPath);
  const codexReport = readJson(codexReportPath);
  const rows = ['development', 'held_out'].flatMap((split) =>
    readJson(path.join(datasetDir, `${split}.json`)),
  );
  const datasetSha256 = fingerprint(rows);
  if (
    sourceReview.sampleSize !== 80 ||
    sourceReview.labels.length !== 80 ||
    sourceReview.sourceDatasetSha256 !== datasetSha256 ||
    sourceReview.judgeFingerprint !== codexReport.judgeFingerprint ||
    sourceReview.reviewAuthority !== 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' ||
    sourceReview.humanApproved !== false ||
    codexReport.status !== 'COMPLETE'
  )
    throw new Error(
      'Source-reviewed labels do not match the frozen Codex sample',
    );
  const reviewIds = sourceReview.labels.map((row) => row.caseId);
  const predictionIds = Object.keys(codexReport.cases ?? {});
  if (
    new Set(reviewIds).size !== 80 ||
    new Set(predictionIds).size !== 80 ||
    reviewIds.some((id) => !codexReport.cases[id]) ||
    predictionIds.some((id) => !reviewIds.includes(id))
  )
    throw new Error('Source labels do not cover the exact Codex judge sample');
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const labelsById = new Map(
    sourceReview.labels.map((row) => [row.caseId, row]),
  );
  const cases = sourceReview.labels.map((review) => {
    const row = rowsById.get(review.caseId);
    const prediction = codexReport.cases[review.caseId];
    if (!row || !prediction || labelsById.size !== 80)
      throw new Error(`Source-review case is missing: ${review.caseId}`);
    for (const dimension of review.applicableDimensions) {
      if (
        !DIMENSIONS.includes(dimension) ||
        !Number.isFinite(review.labels?.[dimension]?.score) ||
        !Number.isFinite(prediction.codexScores?.[dimension]?.score)
      )
        throw new Error(
          `Calibration score is incomplete: ${review.caseId}/${dimension}`,
        );
    }
    return { review, prediction };
  });
  if (new Set(cases.map(({ review }) => review.caseId)).size !== 80)
    throw new Error('Source-review labels contain duplicate case IDs');
  const sourceReviewSha256 = fingerprint(sourceReview.labels);
  const sourceRun = Object.values(codexReport.langfuse?.runs ?? {})
    .filter(
      (run) =>
        run.status === 'COMPLETE' && run.itemCount === 80 && run.datasetRunId,
    )
    .at(-1);
  if (!sourceRun?.experimentId)
    throw new Error(
      'A completed Langfuse Codex judge experiment is required for source links',
    );
  return {
    cases,
    sourceReview,
    sourceReviewSha256,
    sourceDatasetSha256: datasetSha256,
    codexReport,
    sourceRun,
  };
}

function sourceDatasetItems(data, sourceTraceIds) {
  return data.cases.map(({ review, prediction }) => {
    const labels = Object.fromEntries(
      review.applicableDimensions.map((dimension) => [
        dimension,
        review.labels[dimension].score,
      ]),
    );
    const passLabels = Object.fromEntries(
      Object.entries(labels).map(([dimension, score]) => [
        dimension,
        score >= 0.8,
      ]),
    );
    const codexScores = Object.fromEntries(
      review.applicableDimensions.map((dimension) => [
        dimension,
        prediction.codexScores[dimension].score,
      ]),
    );
    const traceId = sourceTraceIds.get(review.caseId);
    if (!traceId)
      throw new Error(`Source Codex trace is missing: ${review.caseId}`);
    return {
      id: `codex-source-${data.sourceReviewSha256.slice(0, 12)}-${review.caseId}`,
      input: {
        caseId: review.caseId,
        bucket: review.bucket,
        answerType: review.answerType,
        judgeFingerprint: data.codexReport.judgeFingerprint,
      },
      expectedOutput: { sourceScores: labels, passLabels },
      metadata: {
        caseId: review.caseId,
        bucket: review.bucket,
        answerType: review.answerType,
        applicableDimensions: review.applicableDimensions,
        sourceDatasetSha256: data.sourceDatasetSha256,
        sourceReviewSha256: data.sourceReviewSha256,
        sourceReviewAuthority: review.reviewAuthority,
        reviewerType: review.reviewerType,
        humanApproved: false,
        judgeFingerprint: data.codexReport.judgeFingerprint,
        judgeModel: data.codexReport.model,
        sourceTraceId: traceId,
      },
      sourceTraceId: traceId,
      _local: { labels, passLabels, codexScores, sourceTraceId: traceId },
    };
  });
}

function evaluatorsFor(records) {
  const byCase = new Map(
    records.map((item) => [item.metadata.caseId, item._local]),
  );
  return [
    async ({ metadata, output }) => {
      const local = byCase.get(metadata?.caseId);
      if (!local)
        throw new Error(`Source label not found: ${metadata?.caseId}`);
      const actual = outputRecord(output);
      return Object.keys(local.labels).flatMap((dimension) => [
        {
          name: `source_label_agreement_${dimension}`,
          value: Number(
            actual.codexPassLabels?.[dimension] === local.passLabels[dimension],
          ),
          dataType: 'NUMERIC',
        },
        {
          name: `source_label_absolute_error_${dimension}`,
          value: Math.abs(
            local.codexScores[dimension] - local.labels[dimension],
          ),
          dataType: 'NUMERIC',
        },
      ]);
    },
  ];
}

function runEvaluators() {
  return [
    async ({ itemResults }) => {
      const scores = new Map();
      for (const item of itemResults) {
        for (const evaluation of item.evaluations ?? []) {
          const values = scores.get(evaluation.name) ?? [];
          if (typeof evaluation.value === 'number')
            values.push(evaluation.value);
          scores.set(evaluation.name, values);
        }
      }
      return [...scores].flatMap(([name, values]) =>
        values.length
          ? [
              {
                name: `mean_${name}`,
                value:
                  values.reduce((sum, value) => sum + value, 0) / values.length,
                dataType: 'NUMERIC',
                comment: `${values.length} source-reviewed Codex judge cases`,
              },
            ]
          : [],
      );
    },
  ];
}

function sourceCalibrationMetrics(records, thresholds = {}) {
  const minSevereExamples = thresholds.minSevereExamples ?? 10;
  const minAbsoluteAgreement = thresholds.minAbsoluteAgreement ?? 0.85;
  const maxMeanAbsoluteError = thresholds.maxMeanAbsoluteError ?? 0.15;
  const minSevereFailureRecall = thresholds.minSevereFailureRecall ?? 0.9;
  const category = (score) =>
    score >= 0.8 ? 'PASS' : score >= 0.5 ? 'PARTIAL' : 'FAIL';
  const metrics = {};
  for (const dimension of DIMENSIONS) {
    const pairs = records.flatMap((record) => {
      const labels = record._local?.labels ?? record.labels;
      const codexScores = record._local?.codexScores ?? record.codexScores;
      const rawGold = labels?.[dimension];
      const gold = typeof rawGold === 'number' ? rawGold : rawGold?.score;
      const predicted = codexScores?.[dimension];
      return Number.isFinite(gold) && Number.isFinite(predicted)
        ? [{ gold, predicted }]
        : [];
    });
    if (!pairs.length) continue;
    const sourceFailures = pairs.filter((pair) => pair.gold < 0.8);
    const severeFailures = pairs.filter((pair) => pair.gold < 0.5);
    const categoryAgreement =
      pairs.filter((pair) => category(pair.gold) === category(pair.predicted))
        .length / pairs.length;
    const passFailAgreement =
      pairs.filter((pair) => pair.gold >= 0.8 === pair.predicted >= 0.8)
        .length / pairs.length;
    const severeFailureRecall = severeFailures.length
      ? severeFailures.filter((pair) => pair.predicted < 0.5).length /
        severeFailures.length
      : null;
    const meanAbsoluteError =
      pairs.reduce(
        (sum, pair) => sum + Math.abs(pair.gold - pair.predicted),
        0,
      ) / pairs.length;
    const enoughSevereExamples = severeFailures.length >= minSevereExamples;
    metrics[dimension] = {
      count: pairs.length,
      meanAbsoluteError,
      categoryAgreement,
      passFailAgreement,
      sourceFailureCount: sourceFailures.length,
      sourceFailureRecall: sourceFailures.length
        ? sourceFailures.filter((pair) => pair.predicted < 0.8).length /
          sourceFailures.length
        : null,
      severeFailureCount: severeFailures.length,
      severeFailureRecall,
      enoughSevereExamples,
      passed:
        meanAbsoluteError <= maxMeanAbsoluteError + 1e-12 &&
        passFailAgreement >= minAbsoluteAgreement &&
        enoughSevereExamples &&
        severeFailureRecall >= minSevereFailureRecall,
    };
  }
  return {
    thresholds: {
      maxMeanAbsoluteError,
      minPassFailAgreement: minAbsoluteAgreement,
      minSevereFailureRecall,
      minSevereExamples,
    },
    metrics,
    status:
      Object.keys(metrics).length === DIMENSIONS.length &&
      Object.values(metrics).every((metric) => metric.passed)
        ? 'PASS'
        : 'BLOCK',
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

async function findExistingExperiment(
  client,
  runName,
  fromStartTime,
  options = {},
) {
  const maxAttempts = options.maxAttempts ?? 12;
  const delayMs = options.delayMs ?? 5_000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const page = await client.api.experiments.list({
      fromStartTime,
      name: runName,
      fields: 'core,metadata,scores',
      scoreLimit: 50,
      limit: 20,
    });
    const matches = (page.data ?? []).filter((item) => item.name === runName);
    if (matches.length > 1)
      throw new Error(
        `Duplicate Langfuse source-calibration runs found: ${runName}`,
      );
    if (matches.length === 1) return matches[0];
    if (attempt + 1 < maxAttempts)
      await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function waitForSourceReadback(
  client,
  experimentId,
  fromStartTime,
  items,
  options = {},
) {
  const maxAttempts = options.maxAttempts ?? 12;
  const delayMs = options.delayMs ?? 5_000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const rows = await readExperimentItems(
        client,
        experimentId,
        fromStartTime,
      );
      verifySourceCalibrationItems(rows, items);
      return rows;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt + 1 === maxAttempts ||
        !/readback is \d+\/\d+ items|scores are missing/.test(message)
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    'Langfuse source-calibration readback did not become complete',
  );
}

async function readSourceTraceIds(client, experimentId, fromStartTime) {
  const rows = await readExperimentItems(client, experimentId, fromStartTime);
  const traceIds = new Map();
  for (const row of rows) {
    const caseId = row.experimentItemMetadata?.caseId;
    if (!caseId || !row.traceId || traceIds.has(caseId))
      throw new Error(
        'Existing Codex experiment has incomplete or duplicate case traces',
      );
    traceIds.set(caseId, row.traceId);
  }
  if (traceIds.size !== 80)
    throw new Error(
      `Existing Codex experiment readback is ${traceIds.size}/80 items`,
    );
  return traceIds;
}

function verifySourceCalibrationItems(rows, items) {
  const expectedById = new Map(
    items.map((item) => [item.metadata.caseId, item._local]),
  );
  if (rows.length !== expectedById.size)
    throw new Error(
      `Langfuse calibration readback is ${rows.length}/${expectedById.size} items`,
    );
  const caseIds = new Set();
  const traceIds = new Set();
  const sourceTraceIds = new Set();
  for (const row of rows) {
    const caseId = row.experimentItemMetadata?.caseId;
    const expected = expectedById.get(caseId);
    if (
      !expected ||
      caseIds.has(caseId) ||
      !row.traceId ||
      traceIds.has(row.traceId)
    )
      throw new Error(
        `Langfuse calibration trace identity is missing or duplicated: ${caseId}`,
      );
    caseIds.add(caseId);
    traceIds.add(row.traceId);
    const expectsScores = Object.keys(expected.labels).length > 0;
    if (
      expectsScores &&
      (!Array.isArray(row.scores) || row.scores.length === 0)
    )
      throw new Error(`Langfuse calibration scores are missing: ${caseId}`);
    const output = outputRecord(row.output);
    if (output.sourceTraceId !== expected.sourceTraceId)
      throw new Error(`Langfuse calibration source trace changed: ${caseId}`);
    sourceTraceIds.add(output.sourceTraceId);
  }
  if (sourceTraceIds.size !== expectedById.size)
    throw new Error('Langfuse calibration source-trace coverage is incomplete');
  return {
    itemCount: rows.length,
    scoredItems: rows.filter((row) => (row.scores?.length ?? 0) > 0).length,
    uniqueExperimentTraceIds: traceIds.size,
    uniqueSourceTraceIds: sourceTraceIds.size,
  };
}

async function selfTest() {
  const source = [
    {
      metadata: {
        caseId: 'case-1',
        applicableDimensions: ['responseRelevancy'],
      },
      _local: {
        labels: { responseRelevancy: 0.8 },
        passLabels: { responseRelevancy: true },
        codexScores: { responseRelevancy: 0.55 },
        sourceTraceId: 'source-trace-1',
      },
    },
    {
      metadata: { caseId: 'case-2', applicableDimensions: [] },
      _local: {
        labels: {},
        passLabels: {},
        codexScores: {},
        sourceTraceId: 'source-trace-2',
      },
    },
  ];
  assert.equal(evaluatorsFor(source).length, 1);
  assert.equal(runEvaluators().length, 1);
  assert.deepEqual(
    await findExistingExperiment(
      {
        api: {
          experiments: {
            list: async () => ({
              data: [{ id: 'experiment-1', name: 'calibration-run' }],
            }),
          },
        },
      },
      'calibration-run',
      '2026-10-26T00:00:00.000Z',
      { delayMs: 0 },
    ),
    { id: 'experiment-1', name: 'calibration-run' },
  );
  const verified = verifySourceCalibrationItems(
    [
      {
        traceId: 'experiment-trace-1',
        experimentItemMetadata: { caseId: 'case-1' },
        output: JSON.stringify({
          sourceTraceId: 'source-trace-1',
          codexPassLabels: { responseRelevancy: false },
        }),
        scores: [
          { name: 'source_label_agreement_responseRelevancy', value: 0 },
        ],
      },
      {
        traceId: 'experiment-trace-2',
        experimentItemMetadata: { caseId: 'case-2' },
        output: JSON.stringify({ sourceTraceId: 'source-trace-2' }),
        scores: [],
      },
    ],
    source,
  );
  assert.deepEqual(verified, {
    itemCount: 2,
    scoredItems: 1,
    uniqueExperimentTraceIds: 2,
    uniqueSourceTraceIds: 2,
  });
  assert.throws(
    () => verifySourceCalibrationItems([], source),
    /readback is 0\/2/,
  );
  let readbackAttempt = 0;
  await waitForSourceReadback(
    {
      api: {
        experiments: {
          listItems: async () => ({
            data:
              ++readbackAttempt === 1
                ? []
                : [
                    {
                      traceId: 'experiment-trace-1',
                      experimentItemMetadata: { caseId: 'case-1' },
                      output: { sourceTraceId: 'source-trace-1' },
                      scores: [{ name: 'agreement', value: 1 }],
                    },
                    {
                      traceId: 'experiment-trace-2',
                      experimentItemMetadata: { caseId: 'case-2' },
                      output: { sourceTraceId: 'source-trace-2' },
                      scores: [],
                    },
                  ],
          }),
        },
      },
    },
    'experiment-1',
    '2026-10-26T00:00:00.000Z',
    source,
    { maxAttempts: 2, delayMs: 0 },
  );
  assert.equal(readbackAttempt, 2);
  const metrics = sourceCalibrationMetrics(
    [
      {
        labels: { responseRelevancy: { score: 0 } },
        codexScores: { responseRelevancy: 0.2 },
      },
      {
        labels: { responseRelevancy: { score: 1 } },
        codexScores: { responseRelevancy: 0.9 },
      },
    ],
    { minSevereExamples: 1 },
  );
  assert.equal(metrics.metrics.responseRelevancy.severeFailureRecall, 1);
  assert.equal(metrics.metrics.responseRelevancy.passed, true);
  assert.equal(
    sourceCalibrationMetrics([
      {
        labels: { responseRelevancy: { score: 0.5 } },
        codexScores: { responseRelevancy: 0.9 },
      },
    ]).status,
    'BLOCK',
  );
  process.stdout.write(
    'Codex source-calibration publisher self-check passed\n',
  );
}

async function getOrCreateDataset(client, items, sourceReview, data) {
  let dataset;
  try {
    dataset = await client.dataset.get(datasetName, {
      fetchItemsPageSize: 100,
    });
  } catch (error) {
    if ((error?.status ?? error?.statusCode) !== 404) throw error;
  }
  if (!dataset) {
    await client.createDataset({
      name: datasetName,
      description:
        'Compact, source-reviewed labels for the Codex GPT-6 Luna RAG judge. Includes only case identifiers, score labels, and links to existing judge traces; not human-approved.',
      metadata: {
        sourceReviewSha256: data.sourceReviewSha256,
        sourceDatasetSha256: data.sourceDatasetSha256,
        judgeFingerprint: data.codexReport.judgeFingerprint,
        reviewAuthority: sourceReview.reviewAuthority,
        reviewerType: sourceReview.reviewerType,
        humanApproved: false,
        scoreThreshold: 0.8,
      },
      inputSchema: {
        type: 'object',
        required: ['caseId', 'bucket', 'judgeFingerprint'],
        properties: {
          caseId: { type: 'string' },
          bucket: { type: 'string' },
          answerType: { type: 'string' },
          judgeFingerprint: { type: 'string' },
        },
      },
    });
    dataset = await client.dataset.get(datasetName, {
      fetchItemsPageSize: 100,
    });
  }
  if (dataset.metadata?.sourceReviewSha256 !== data.sourceReviewSha256)
    throw new Error(
      'Langfuse source-calibration dataset belongs to another label snapshot',
    );
  const existing = new Map(
    (dataset.items ?? []).map((item) => [item.id, item]),
  );
  const missing = [];
  for (const item of items) {
    const prior = existing.get(item.id);
    if (!prior) {
      missing.push(item);
      continue;
    }
    if (
      fingerprint({
        input: prior.input,
        expectedOutput: prior.expectedOutput,
        metadata: prior.metadata,
        sourceTraceId: prior.sourceTraceId,
      }) !==
      fingerprint({
        input: item.input,
        expectedOutput: item.expectedOutput,
        metadata: item.metadata,
        sourceTraceId: item.sourceTraceId,
      })
    )
      throw new Error(
        `Langfuse source-calibration item differs: ${item.metadata.caseId}`,
      );
  }
  for (let index = 0; index < missing.length; index += 8) {
    await Promise.all(
      missing
        .slice(index, index + 8)
        .map((item) => client.dataset.createItem({ datasetName, ...item })),
    );
  }
  dataset = await client.dataset.get(datasetName, { fetchItemsPageSize: 100 });
  if (
    dataset.items.length !== items.length ||
    items.some((item) => {
      const remote = dataset.items.find((entry) => entry.id === item.id);
      return (
        !remote ||
        fingerprint({
          id: remote.id,
          input: remote.input,
          expectedOutput: remote.expectedOutput,
          sourceTraceId: remote.sourceTraceId,
        }) !==
          fingerprint({
            id: item.id,
            input: item.input,
            expectedOutput: item.expectedOutput,
            sourceTraceId: item.sourceTraceId,
          })
      );
    })
  )
    throw new Error(
      'Langfuse source-calibration dataset readback is incomplete',
    );
  return dataset;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  if (!args.includes('--apply'))
    throw new Error('Publishing Codex source calibration requires --apply');
  const destination = path.resolve(
    args.includes('--output') ? args[args.indexOf('--output') + 1] : outputPath,
  );
  let recovery;
  if (fs.existsSync(destination)) {
    const prior = readJson(destination);
    if (prior.status === 'COMPLETE') {
      process.stdout.write(`${prior.datasetRunUrl}\n`);
      return;
    }
    if (!['IN_PROGRESS', 'VERIFYING'].includes(prior.status))
      throw new Error('Source-calibration receipt has an unknown state');
    recovery = prior;
  }
  const data = readCalibrationData();
  const { sourceReview, codexReport } = data;
  const runName = `Codex source labels ${data.sourceReviewSha256.slice(0, 12)}`;
  const startedAt = recovery?.startedAt || new Date().toISOString();
  if (
    recovery &&
    ((recovery.sourceReviewSha256 &&
      recovery.sourceReviewSha256 !== data.sourceReviewSha256) ||
      (recovery.judgeFingerprint &&
        recovery.judgeFingerprint !== codexReport.judgeFingerprint) ||
      (recovery.runName && recovery.runName !== runName))
  )
    throw new Error(
      'Existing source-calibration receipt belongs to another frozen review',
    );
  dotenv.config({ path: path.join(root, '.env') });
  for (const key of [
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_BASE_URL',
  ])
    if (!process.env[key])
      throw new Error(`Missing ${key} for Langfuse source calibration`);
  const { LangfuseClient } = require('@langfuse/client');
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  let sdk;
  try {
    const sourceTraceIds = await readSourceTraceIds(
      client,
      data.sourceRun.experimentId,
      '2026-10-26T00:00:00.000Z',
    );
    const records = sourceDatasetItems(data, sourceTraceIds);
    const items = records.map(({ _local, ...item }) => item);
    if (items.length !== 80 || sourceTraceIds.size !== 80)
      throw new Error(
        'Source calibration requires 80 exact case-to-trace links',
      );
    const candidateState = readJson(
      path.join(runDir, 'cohort-v22-candidate/state.json'),
    );
    const { createLangfuseSdk } = require(
      path.join(
        candidateState.compiledBase,
        'infrastructure/services/langfuse-telemetry.js',
      ),
    );
    process.env.LANGFUSE_ENABLED = 'true';
    process.env.LANGFUSE_SAMPLE_RATE = '1';
    process.env.LANGFUSE_TRACING_ENVIRONMENT = 'rag-evaluation';
    process.env.LANGFUSE_CAPTURE_CONTENT = 'false';
    process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT = 'false';
    process.env.LANGFUSE_RELEASE = `codex-judge-${codexReport.judgeFingerprint.slice(0, 12)}`;
    process.env.OTEL_SERVICE_NAME = 'velora-rag-codex-source-calibration';
    sdk = createLangfuseSdk();
    sdk?.start();
    const dataset = await getOrCreateDataset(client, items, sourceReview, data);
    const datasetByCase = new Map(
      dataset.items.map((item) => [item.metadata?.caseId, item]),
    );
    const experimentData = records.map((record) =>
      datasetByCase.get(record.metadata.caseId),
    );
    const recordById = new Map(
      records.map((item) => [item.metadata.caseId, item]),
    );
    const expectedScoredItems = records.filter(
      (item) => Object.keys(item._local.labels).length > 0,
    ).length;
    const baseRegistration = {
      datasetName,
      datasetId: dataset.id,
      sourceReviewSha256: data.sourceReviewSha256,
      sourceDatasetSha256: data.sourceDatasetSha256,
      judgeFingerprint: codexReport.judgeFingerprint,
      sourceExperimentId: data.sourceRun.experimentId,
      runName,
      itemCount: records.length,
      expectedScoredItems,
      startedAt,
    };
    let registration = recovery ? { ...baseRegistration, ...recovery } : null;
    if (registration?.status === 'IN_PROGRESS') {
      writeJsonAtomic(destination, {
        ...registration,
        ...baseRegistration,
        status: 'IN_PROGRESS',
      });
      const existing = await findExistingExperiment(client, runName, startedAt);
      if (!existing)
        throw new Error(
          'No matching Langfuse experiment is visible; do not replay until its creation is reconciled',
        );
      if (
        existing.datasetId !== dataset.id ||
        existing.itemCount !== records.length
      )
        throw new Error(
          'Existing Langfuse run has the wrong dataset or item count',
        );
      registration = {
        ...baseRegistration,
        status: 'VERIFYING',
        experimentId: existing.id,
        datasetRunId: existing.id,
        runEvaluations: existing.scores ?? [],
        datasetRunUrl: `${process.env.LANGFUSE_BASE_URL.replace(/\/$/, '')}/project/${dataset.projectId}/datasets/${dataset.id}/runs/${existing.id}`,
      };
      writeJsonAtomic(destination, registration);
    }
    if (registration?.status === 'VERIFYING') {
      if (!registration.experimentId || registration.datasetId !== dataset.id)
        throw new Error('Source-calibration recovery identity is incomplete');
      registration.sourceCalibrationGate ??= sourceCalibrationMetrics(records);
      registration.approvalStatus ??= 'AWAITING_USER_REVIEW';
    } else {
      const runRegistration = {
        ...baseRegistration,
        status: 'IN_PROGRESS',
      };
      writeJsonAtomic(destination, runRegistration);
      const result = await client.experiment.run({
        name: 'Codex GPT-6 Luna RAG judge source calibration',
        runName,
        description:
          'Replays cached Codex GPT-6 Luna scores against agent source-reviewed labels; no judge or RAG model calls are made. Labels are not human-approved.',
        metadata: {
          sourceReviewSha256: data.sourceReviewSha256,
          sourceDatasetSha256: data.sourceDatasetSha256,
          judgeFingerprint: codexReport.judgeFingerprint,
          judgeModel: codexReport.model,
          codexCliVersion: codexReport.codexCliVersion,
          reviewAuthority: sourceReview.reviewAuthority,
          humanApproved: false,
          scoreThreshold: 0.8,
        },
        data: experimentData,
        task: async ({ metadata }) => {
          const item = recordById.get(metadata?.caseId);
          if (!item)
            throw new Error(`Cached Codex output missing: ${metadata?.caseId}`);
          const local = item._local;
          return {
            sourceTraceId: local.sourceTraceId,
            sourceScores: local.labels,
            sourcePassLabels: local.passLabels,
            codexScores: local.codexScores,
            codexPassLabels: Object.fromEntries(
              Object.entries(local.codexScores).map(([dimension, score]) => [
                dimension,
                score >= 0.8,
              ]),
            ),
          };
        },
        evaluators: evaluatorsFor(records),
        runEvaluators: runEvaluators(),
        maxConcurrency: 8,
      });
      if (!result.experimentId || result.itemResults.length !== records.length)
        throw new Error(
          'Codex source calibration experiment item coverage is incomplete',
        );
      const scoredItems = result.itemResults.filter(
        (item) => item.evaluations?.length,
      ).length;
      registration = {
        ...baseRegistration,
        status: 'VERIFYING',
        experimentId: result.experimentId,
        datasetRunId: result.datasetRunId,
        datasetRunUrl:
          result.datasetRunUrl ||
          `${process.env.LANGFUSE_BASE_URL.replace(/\/$/, '')}/project/${dataset.projectId}/datasets/${dataset.id}/runs/${result.datasetRunId}`,
        scoredItems,
        runEvaluations: result.runEvaluations,
        sourceCalibrationGate: sourceCalibrationMetrics(records),
        approvalStatus: 'AWAITING_USER_REVIEW',
      };
      writeJsonAtomic(destination, registration);
      if (scoredItems !== expectedScoredItems)
        throw new Error(
          `Langfuse source calibration scored ${scoredItems}/${expectedScoredItems} applicable cases`,
        );
    }
    await client.flush();
    const readback = await waitForSourceReadback(
      client,
      registration.experimentId,
      startedAt,
      records,
    );
    registration.readback = verifySourceCalibrationItems(readback, records);
    registration.scoredItems = registration.readback.scoredItems;
    registration.status = 'COMPLETE';
    if (registration.readback.scoredItems !== expectedScoredItems)
      throw new Error(
        'Source-calibration readback score coverage differs from applicability',
      );
    registration.completedAt = new Date().toISOString();
    writeJsonAtomic(destination, registration);
    process.stdout.write(JSON.stringify(registration, null, 2) + '\n');
  } finally {
    await client.flush();
    await client.shutdown();
    await sdk?.shutdown();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

module.exports = {
  readCalibrationData,
  sourceDatasetItems,
  evaluatorsFor,
  verifySourceCalibrationItems,
  sourceCalibrationMetrics,
  getOrCreateDataset,
  readExperimentItems,
  runEvaluators,
};
