#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { fingerprint } = require('./rag-evaluation-contract.cjs');
const {
  buildDimensionPrompt,
} = require('./rag-semantic-judge.cjs');
const { DIMENSIONS, isApplicable } = require('./rag-evaluation-applicability.cjs');

const work = path.resolve(__dirname, '../..');
const benchmark = path.join(work, '.benchmarks/rag-remediation-v7-20261022-01');
const datasetDir = path.join(
  benchmark,
  'dataset-v7-visual-reviewed-20261022-02',
);
const evaluationDir = path.join(
  benchmark,
  'evaluation-v22-transcript-evidence-bounds-20261025-01',
);
const model = 'gpt-6-luna';
const dimensionKeys = [...DIMENSIONS];
const langfuseDatasetName = 'judge-calibration/codex-gpt-6-luna-v1';
const langfuseScoreVersion = 'codex-groq-applicability-v2-otel';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function saveJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value?.startsWith('--')) continue;
    const [name, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) args[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--'))
      args[name] = argv[++i];
    else args[name] = true;
  }
  return args;
}

function stableOrder(caseId, datasetSha256) {
  return crypto
    .createHash('sha256')
    .update(`${datasetSha256}:${caseId}`)
    .digest('hex');
}

function referenceAnswer(expectedOutput) {
  if (Array.isArray(expectedOutput?.acceptedAnswers) && expectedOutput.acceptedAnswers.length)
    return expectedOutput.acceptedAnswers;
  return expectedOutput?.answer ?? expectedOutput?.referenceAnswer ?? '';
}

function caseScore(entry) {
  const scores = dimensionKeys
    .map((dimension) => entry?.[dimension]?.score)
    .filter((score) => typeof score === 'number');
  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
}

function scoreValue(value) {
  if (typeof value === 'number') return value;
  return typeof value?.score === 'number' ? value.score : null;
}

function selectCalibrationCases(rows, semanticCases, datasetSha256, perBucket = 8) {
  const buckets = [...new Set(rows.map((row) => row.metadata?.bucket).filter(Boolean))].sort();
  const selected = [];
  for (const bucket of buckets) {
    const candidates = rows
      .filter(
        (row) =>
          row.metadata?.split === 'DEVELOPMENT' &&
          row.metadata?.bucket === bucket &&
          (dimensionKeys.some((dimension) => isApplicable(row, dimension)) ||
            row.metadata?.bucket === 'RECOMMENDATION'),
      )
      .map((row) => ({ row, groq: semanticCases[row.id], score: caseScore(semanticCases[row.id]) }))
      .filter((item) => item.groq && !item.groq.error)
      .sort(
        (left, right) =>
          (left.score ?? 0.5) - (right.score ?? 0.5) ||
          stableOrder(left.row.id, datasetSha256).localeCompare(
            stableOrder(right.row.id, datasetSha256),
          ),
      );
    if (candidates.length < perBucket)
      throw new Error(`Insufficient eligible development cases in ${bucket}`);
    const low = candidates.slice(0, 2);
    const high = candidates.slice(-2);
    const edgeIds = new Set([...low, ...high].map((item) => item.row.id));
    const middle = candidates
      .filter((item) => !edgeIds.has(item.row.id))
      .sort((left, right) =>
        stableOrder(left.row.id, datasetSha256).localeCompare(
          stableOrder(right.row.id, datasetSha256),
        ),
      )
      .slice(0, perBucket - low.length - high.length);
    selected.push(...low, ...middle, ...high);
  }
  if (selected.length !== buckets.length * perBucket)
    throw new Error('Calibration sample is not balanced by bucket');
  return selected.map((item) => ({
    row: item.row,
    groq: item.groq,
    groqMean: item.score,
  }));
}

function schemaFor(dimension) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [dimension],
    properties: {
      [dimension]: {
        type: 'object',
        additionalProperties: false,
        required: ['score', 'reasoning'],
        properties: {
          score: { type: 'number', minimum: 0, maximum: 1 },
          reasoning: { type: 'string', maxLength: 500 },
        },
      },
    },
  };
}

function codexEnvironment() {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TERM: 'dumb',
    NO_COLOR: '1',
  };
  for (const key of [
    'CODEX_HOME',
    'SSL_CERT_FILE',
    'CODEX_CA_CERTIFICATE',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function installedCodexVersion() {
  const version = spawnSync('codex', ['--version'], {
    encoding: 'utf8',
    env: codexEnvironment(),
    maxBuffer: 1024 * 1024,
  });
  if (version.status !== 0 || !version.stdout?.trim())
    throw new Error('Unable to determine the installed Codex CLI version');
  return version.stdout.trim();
}

function hasChatGptAuthentication(status) {
  return /Logged in using ChatGPT/i.test(
    `${status?.stdout ?? ''}\n${status?.stderr ?? ''}`,
  );
}

function runCodexDimension(dimension, prompt) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rag-judge-'));
  const schemaPath = path.join(directory, 'schema.json');
  const outputPath = path.join(directory, 'output.json');
  fs.writeFileSync(schemaPath, JSON.stringify(schemaFor(dimension)), {
    mode: 0o600,
  });
  try {
    const run = spawnSync(
      'codex',
      [
        'exec',
        '--model',
        model,
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--output-schema',
        schemaPath,
        '-o',
        outputPath,
        '-',
      ],
      {
        cwd: directory,
        env: codexEnvironment(),
        input: prompt,
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (run.error) throw run.error;
    if (run.status !== 0)
      throw new Error(`Codex judge failed with exit ${run.status}`);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'))[dimension];
    if (
      !result ||
      typeof result.score !== 'number' ||
      result.score < 0 ||
      result.score > 1 ||
      typeof result.reasoning !== 'string'
    )
      throw new Error(`Codex judge returned an invalid ${dimension} score`);
    return result;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function buildCalibrationPrompt(dimension, row, response) {
  const diagnostics = response.trace?.workflowMetrics?.diagnostics ?? {};
  return buildDimensionPrompt(dimension, {
    question: row.input?.question,
    referenceAnswer: referenceAnswer(row.expectedOutput),
    generatedAnswer: response.output?.answer ?? '',
    context: diagnostics.generationEvidence ?? [],
    answerType: row.metadata?.answerType,
    policyAssertions: row.expectedOutput?.assertions,
    expectedEvidenceTypes: row.expectedOutput?.expectedEvidenceTypes,
  });
}

function buildLangfuseItem(item, response, datasetSha256) {
  const diagnostics = response.trace?.workflowMetrics?.diagnostics ?? {};
  return {
    id: `codex-cal-${datasetSha256.slice(0, 12)}-${item.row.id}`,
    input: {
      question: item.row.input?.question ?? '',
      referenceAnswer: referenceAnswer(item.row.expectedOutput),
      generatedAnswer: response.output?.answer ?? '',
      generationEvidence: diagnostics.generationEvidence ?? [],
      answerType: item.row.metadata?.answerType ?? null,
      policyAssertions: item.row.expectedOutput?.assertions ?? [],
      expectedEvidenceTypes: item.row.expectedOutput?.expectedEvidenceTypes ?? [],
    },
    expectedOutput: null,
    metadata: {
      caseId: item.row.id,
      bucket: item.row.metadata?.bucket ?? 'UNSPECIFIED',
      split: item.row.metadata?.split ?? 'UNSPECIFIED',
      sourceDatasetSha256: datasetSha256,
      judgeFingerprint: null,
      reviewAuthority: 'GROQ_COMPARATOR_NOT_GOLD',
      humanApproved: false,
    },
  };
}

function langfuseScoreNames() {
  return dimensionKeys.flatMap((dimension) => [
    `codex_${dimension}`,
    `groq_comparator_${dimension}`,
    `agreement_at_0_8_${dimension}`,
    `severe_failure_recall_${dimension}`,
  ]);
}

async function getOrCreateLangfuseDataset(client, items, datasetSha256) {
  let dataset;
  try {
    dataset = await client.dataset.get(langfuseDatasetName, {
      fetchItemsPageSize: 100,
    });
  } catch (error) {
    const status = error?.status ?? error?.statusCode;
    if (status !== 404) throw error;
  }
  if (!dataset) {
    await client.createDataset({
      name: langfuseDatasetName,
      description:
        'Balanced V7 development sample for Codex GPT-6 Luna judge comparison. Groq scores are a comparator, not source-reviewed ground truth.',
      metadata: {
        sourceDatasetSha256: datasetSha256,
        judge: model,
        comparator: 'Groq V22; not ground truth',
        humanApproved: false,
      },
      inputSchema: {
        type: 'object',
        required: ['question', 'generatedAnswer', 'generationEvidence'],
        properties: {
          question: { type: 'string' },
          referenceAnswer: {},
          generatedAnswer: { type: 'string' },
          generationEvidence: { type: 'array' },
          answerType: {},
          policyAssertions: { type: 'array' },
          expectedEvidenceTypes: { type: 'array' },
        },
      },
    });
    dataset = await client.dataset.get(langfuseDatasetName, {
      fetchItemsPageSize: 100,
    });
  }
  if (dataset.metadata?.sourceDatasetSha256 !== datasetSha256)
    throw new Error('Langfuse Codex calibration dataset belongs to another V7 snapshot');
  const existing = new Map(
    dataset.items.map((entry) => [entry.metadata?.caseId, entry]),
  );
  for (const item of items) {
    const prior = existing.get(item.metadata.caseId);
    if (!prior) continue;
    if (
      fingerprint({ input: prior.input, expectedOutput: prior.expectedOutput ?? null }) !==
        fingerprint({ input: item.input, expectedOutput: null }) ||
      prior.metadata?.sourceDatasetSha256 !== datasetSha256 ||
      prior.metadata?.reviewAuthority !== 'GROQ_COMPARATOR_NOT_GOLD'
    )
      throw new Error(`Langfuse Codex calibration item differs: ${item.metadata.caseId}`);
  }
  const missing = items.filter((item) => !existing.has(item.metadata.caseId));
  for (let start = 0; start < missing.length; start += 8) {
    await Promise.all(
      missing.slice(start, start + 8).map((item) =>
        client.dataset.createItem({ datasetName: langfuseDatasetName, ...item }),
      ),
    );
  }
  dataset = await client.dataset.get(langfuseDatasetName, {
    fetchItemsPageSize: 100,
  });
  if (
    dataset.items.length !== items.length ||
    new Set(dataset.items.map((item) => item.metadata?.caseId)).size !== items.length ||
    items.some((item) => !dataset.items.some((entry) => entry.metadata?.caseId === item.metadata.caseId))
  )
    throw new Error('Langfuse Codex calibration dataset is not the exact frozen sample');
  return dataset;
}

async function publishLangfuseExperiment(data, report) {
  if (report.status !== 'COMPLETE')
    throw new Error('Complete the Codex calibration sample before publishing to Langfuse');
  dotenv.config({ path: path.join(work, '.env') });
  for (const name of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL']) {
    if (!process.env[name]) throw new Error(`Missing ${name} for Langfuse experiment`);
  }
  process.env.LANGFUSE_TRACING_ENVIRONMENT = 'rag-evaluation';
  process.env.LANGFUSE_ENABLED = 'true';
  process.env.LANGFUSE_SAMPLE_RATE = '1';
  process.env.LANGFUSE_CAPTURE_CONTENT = 'true';
  process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT = 'true';
  process.env.OTEL_SERVICE_NAME = 'velora-rag-codex-judge-calibration';
  const sampleSha256 = fingerprint({
    judgeFingerprint: report.judgeFingerprint,
    scoreVersion: langfuseScoreVersion,
    sampleIds: data.selected.map((item) => item.row.id),
  });
  const priorRun = report.langfuse?.runs?.[sampleSha256];
  if (priorRun?.status === 'COMPLETE' && priorRun.datasetRunId) return priorRun;
  const items = data.selected.map((item) =>
    buildLangfuseItem(item, data.responses.get(item.row.id), data.datasetSha256),
  );
  for (const item of items)
    item.metadata.judgeFingerprint = report.judgeFingerprint;
  const candidateState = readJson(
    path.join(evaluationDir, 'cohort-v22-candidate/state.json'),
  );
  const { createLangfuseSdk } = require(path.join(
    candidateState.compiledBase,
    'infrastructure/services/langfuse-telemetry.js',
  ));
  const sdk = createLangfuseSdk();
  sdk?.start();
  const { LangfuseClient } = require('@langfuse/client');
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  try {
    const dataset = await getOrCreateLangfuseDataset(
      client,
      items,
      data.datasetSha256,
    );
    const recordById = new Map(
      Object.entries(report.cases).map(([caseId, value]) => [caseId, value]),
    );
    const result = await client.experiment.run({
      name: 'Codex GPT-6 Luna RAG judge calibration',
      runName: `V22 80-case Codex comparison ${sampleSha256.slice(0, 12)}`,
      description:
        'Replays persisted Codex judge outputs as Langfuse traces. Groq scores are comparison-only and not human or source-review labels.',
      metadata: {
        sourceDatasetSha256: data.datasetSha256,
        calibrationSampleSha256: sampleSha256,
        scoreVersion: langfuseScoreVersion,
        judgeFingerprint: report.judgeFingerprint,
        judgeProvider: report.provider,
        judgeModel: report.model,
        codexCliVersion: report.codexCliVersion,
        evaluatorVersion: report.evaluatorVersion,
        comparator: report.comparisonReference,
        sourceMode: 'PERSISTED_CODEX_JUDGE_OUTPUT',
      },
      data: items,
      task: async ({ metadata }) => {
        const record = recordById.get(metadata?.caseId);
        if (!record) throw new Error(`Codex result missing for ${metadata?.caseId}`);
        return {
          model: report.model,
          codexCliVersion: report.codexCliVersion,
          scores: record.codexScores,
        };
      },
      evaluators: [async ({ metadata }) => {
        const record = recordById.get(metadata?.caseId);
        if (!record) throw new Error(`Calibration comparator missing for ${metadata?.caseId}`);
        return dimensionKeys.flatMap((dimension) => {
          const codex = record.codexScores[dimension]?.score;
          const groq = record.groqScores[dimension];
          if (
            !isApplicable(
              { metadata: { bucket: record.bucket, answerType: record.answerType } },
              dimension,
            )
          )
            return [];
          if (typeof codex !== 'number' || typeof groq !== 'number') return [];
          const scores = [
            { name: `codex_${dimension}`, value: codex },
            { name: `groq_comparator_${dimension}`, value: groq },
            {
              name: `agreement_at_0_8_${dimension}`,
              value: Number((codex >= 0.8) === (groq >= 0.8)),
            },
          ];
          if (groq < 0.5)
            scores.push({
              name: `severe_failure_recall_${dimension}`,
              value: Number(codex < 0.5),
            });
          return scores.map((score) => ({
            ...score,
            dataType: 'NUMERIC',
            comment: `${report.judgeFingerprint}; Groq is comparator only, not ground truth`,
            metadata: {
              judgeModel: report.model,
              comparatorProvider: report.comparatorProvider,
              comparatorModel: report.comparatorModel,
              judgeFingerprint: report.judgeFingerprint,
              sourceAuthority: 'GROQ_COMPARATOR_NOT_GOLD',
            },
          }));
        });
      }],
      runEvaluators: [async ({ itemResults }) =>
        langfuseScoreNames().flatMap((name) => {
          const values = itemResults
            .flatMap((item) => item.evaluations ?? [])
            .filter((score) => score.name === name && typeof score.value === 'number')
            .map((score) => score.value);
          return values.length
            ? [{
                name: `mean_${name}`,
                value: values.reduce((sum, value) => sum + value, 0) / values.length,
                dataType: 'NUMERIC',
                comment: `${values.length} paired cases; comparison only, not ground truth`,
              }]
            : [];
        }),
      ],
      maxConcurrency: 1,
    });
    await client.flush();
    return {
      status: 'COMPLETE',
      sampleSha256,
      datasetRunId: result.datasetRunId,
      datasetRunUrl:
        result.datasetRunUrl ||
        (result.datasetRunId && dataset.projectId && dataset.id
          ? `${process.env.LANGFUSE_BASE_URL.replace(/\/$/, '')}/project/${dataset.projectId}/datasets/${dataset.id}/runs/${result.datasetRunId}`
          : null),
      experimentId: result.experimentId,
      itemCount: result.itemResults.length,
      scoredItems: result.itemResults.filter((item) => item.evaluations.length > 0).length,
      runEvaluations: result.runEvaluations,
    };
  } finally {
    await client.flush();
    await client.shutdown();
    await sdk?.shutdown();
  }
}

function calibrationMetrics(records) {
  const result = {};
  for (const dimension of dimensionKeys) {
    const pairs = records
      .map((record) => ({
        record,
        codex: record.codexScores?.[dimension]?.score,
        groq: scoreValue(record.groqScores?.[dimension]),
      }))
      .filter(
        (pair) =>
          isApplicable(
            { metadata: { bucket: pair.record.bucket, answerType: pair.record.answerType } },
            dimension,
          ) &&
          typeof pair.codex === 'number' &&
          typeof pair.groq === 'number',
      );
    const severe = pairs.filter((pair) => pair.groq < 0.5);
    result[dimension] = {
      pairedCases: pairs.length,
      meanAbsoluteDifference: pairs.length
        ? pairs.reduce((sum, pair) => sum + Math.abs(pair.codex - pair.groq), 0) /
          pairs.length
        : null,
      passFailAgreementAt0_8: pairs.length
        ? pairs.filter((pair) => (pair.codex >= 0.8) === (pair.groq >= 0.8)).length /
          pairs.length
        : null,
      severeFailureRecallAt0_5: severe.length
        ? severe.filter((pair) => pair.codex < 0.5).length / severe.length
        : null,
    };
  }
  return result;
}

function loadCalibrationData() {
  const rows = ['development', 'held_out'].flatMap((split) =>
    readJson(path.join(datasetDir, `${split}.json`)),
  );
  const datasetSha256 = fingerprint(rows);
  const final = readJson(path.join(evaluationDir, 'final-benchmark.json'));
  if (final.datasetSha256 !== datasetSha256 || final.qualityGate?.status !== 'PASS')
    throw new Error('Codex calibration requires the passed frozen V22 dataset');
  const semantic = readJson(
    path.join(evaluationDir, 'cohort-v22-candidate/semantic.json'),
  );
  const responses = readJsonl(
    path.join(evaluationDir, 'cohort-v22-candidate/responses.jsonl'),
  );
  const responseById = new Map(responses.map((response) => [response.caseId, response]));
  const selected = selectCalibrationCases(rows, semantic.cases, datasetSha256, 8);
  return { rows, datasetSha256, semantic, responses: responseById, selected };
}

function selfTest() {
  const data = loadCalibrationData();
  assert.deepEqual(dimensionKeys, [
    'faithfulness',
    'factualCorrectness',
    'responseRelevancy',
    'contextCompleteness',
  ]);
  assert.equal(data.selected.length, 80);
  assert.equal(new Set(data.selected.map((item) => item.row.id)).size, 80);
  const buckets = data.selected.reduce((counts, item) => {
    const key = item.row.metadata.bucket;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  assert(Object.values(buckets).every((count) => count === 8));
  for (const dimension of dimensionKeys) {
    const prompt = buildCalibrationPrompt(
      dimension,
      data.selected[0].row,
      data.responses.get(data.selected[0].row.id),
    );
    assert(!prompt.includes(data.selected[0].row.id));
  }
  const item = buildLangfuseItem(
    data.selected[0],
    data.responses.get(data.selected[0].row.id),
    data.datasetSha256,
  );
  assert.equal(item.expectedOutput, null);
  assert.equal(item.metadata.reviewAuthority, 'GROQ_COMPARATOR_NOT_GOLD');
  assert(!JSON.stringify(item.input).includes('groqScores'));
  const paired = calibrationMetrics([
    {
      codexScores: { faithfulness: { score: 0.4 } },
      groqScores: { faithfulness: 0.3 },
    },
  ]).faithfulness;
  assert.equal(paired.pairedCases, 1);
  assert(Math.abs(paired.meanAbsoluteDifference - 0.1) < 1e-12);
  assert.equal(paired.passFailAgreementAt0_8, 1);
  assert.equal(paired.severeFailureRecallAt0_5, 1);
  assert.equal(
    calibrationMetrics([
      {
        bucket: 'RECOMMENDATION',
        answerType: 'RECOMMEND_REELS',
        codexScores: { responseRelevancy: { score: 0.2 } },
        groqScores: { responseRelevancy: 0.9 },
      },
    ]).responseRelevancy.pairedCases,
    0,
  );
  assert.equal(scoreValue(0.4), 0.4);
  assert.equal(scoreValue({ score: 0.4 }), 0.4);
  assert.equal(
    hasChatGptAuthentication({ stderr: 'Logged in using ChatGPT' }),
    true,
  );
  process.stdout.write('Codex calibration sample self-check passed (80 cases, 8 per bucket)\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) return selfTest();
  const data = loadCalibrationData();
  const version = 'codex-gpt-6-luna-judge-v1';
  const codexCliVersion = installedCodexVersion();
  const comparator = Object.values(data.semantic.cases)[0] ?? {};
  const judgeFingerprint = fingerprint({
    version,
    model,
    codexCliVersion,
    evaluatorVersion: 'velora-rag-evaluation-v6-dimension-prompts',
    datasetSha256: data.datasetSha256,
    sampleIds: data.selected.map((item) => item.row.id),
    effort: 'default',
  });
  const outputPath =
    args.output || path.join(evaluationDir, 'codex-judge-calibration-v1.json');
  let report = fs.existsSync(outputPath)
    ? readJson(outputPath)
    : {
        version,
        provider: 'codex-chatgpt-subscription',
        model,
        codexCliVersion,
        effort: 'default',
        judgeFingerprint,
        evaluatorVersion: 'velora-rag-evaluation-v6-dimension-prompts',
        comparisonReference: 'Groq V22; comparator only, not human gold',
        comparatorProvider: comparator.provider ?? null,
        comparatorModel: comparator.model ?? null,
        sourceDatasetSha256: data.datasetSha256,
        sampleSize: data.selected.length,
        selection: '8 development cases per bucket, balanced across low/high Groq score and stable hash sample',
        cases: {},
        status: 'IN_PROGRESS',
      };
  if (
    report.judgeFingerprint !== judgeFingerprint ||
    report.codexCliVersion !== codexCliVersion ||
    report.sourceDatasetSha256 !== data.datasetSha256 ||
    report.sampleSize !== data.selected.length
  )
    throw new Error('Existing Codex calibration checkpoint does not match this frozen sample');
  const codexLogin = spawnSync('codex', ['login', 'status'], {
    encoding: 'utf8',
    env: codexEnvironment(),
    maxBuffer: 1024 * 1024,
  });
  if (codexLogin.status !== 0 || !hasChatGptAuthentication(codexLogin))
    throw new Error('Codex judge requires saved ChatGPT subscription authentication');
  const limit = args.limit ? Number.parseInt(args.limit, 10) : data.selected.length;
  if (!Number.isInteger(limit) || limit < 1 || limit > data.selected.length)
    throw new Error('--limit must be between 1 and the calibration sample size');
  const work = data.selected.slice(0, limit);
  for (const item of work) {
    const caseId = item.row.id;
    const prior = report.cases[caseId] ?? {
      caseId,
      bucket: item.row.metadata.bucket,
      split: item.row.metadata.split,
      answerType: item.row.metadata.answerType,
      groqScores: Object.fromEntries(
        dimensionKeys.map((dimension) => [dimension, item.groq[dimension]?.score ?? null]),
      ),
      codexScores: {},
    };
    prior.answerType ??= item.row.metadata.answerType;
    const response = data.responses.get(caseId);
    for (const dimension of dimensionKeys) {
      if (!isApplicable(item.row, dimension)) continue;
      if (typeof prior.codexScores[dimension]?.score === 'number') continue;
      const availability = item.groq.dimensionAvailability?.[dimension];
      if (availability && availability !== 'AVAILABLE') {
        prior.codexScores[dimension] = { unavailableReason: availability };
        continue;
      }
      try {
        prior.codexScores[dimension] = runCodexDimension(
          dimension,
          buildCalibrationPrompt(dimension, item.row, response),
        );
      } catch (error) {
        prior.codexScores[dimension] = {
          error: /429|rate|limit|quota|usage/i.test(String(error.message))
            ? 'CODEX_USAGE_LIMIT'
            : 'CODEX_JUDGE_ERROR',
        };
        report.cases[caseId] = prior;
        report.metrics = calibrationMetrics(Object.values(report.cases));
        saveJsonAtomic(outputPath, report);
        throw new Error(
          `Codex judge paused at ${caseId}/${dimension}; checkpoint saved (${prior.codexScores[dimension].error})`,
        );
      }
      report.cases[caseId] = prior;
      report.metrics = calibrationMetrics(Object.values(report.cases));
      saveJsonAtomic(outputPath, report);
    }
  }
  report.status = Object.keys(report.cases).length === data.selected.length &&
    Object.values(report.cases).every(c => dimensionKeys.every(d => !isApplicable(data.selected.find(x=>x.row.id===c.caseId).row,d) || typeof c.codexScores[d]?.score==='number'))
      ? 'COMPLETE'
      : 'IN_PROGRESS';
  report.metrics = calibrationMetrics(Object.values(report.cases));
  report.completedAt = report.status === 'COMPLETE' ? new Date().toISOString() : null;
  saveJsonAtomic(outputPath, report);
  process.stdout.write(JSON.stringify({
    status: report.status,
    judgeFingerprint,
    selectedCases: data.selected.length,
    processedCases: Object.keys(report.cases).length,
    metrics: report.metrics,
    outputPath,
  }) + '\n');
  if (args['publish-langfuse']) {
    const langfuse = await publishLangfuseExperiment(data, report);
    report.langfuse ??= { runs: {} };
    report.langfuse.runs[langfuse.sampleSha256] = langfuse;
    saveJsonAtomic(outputPath, report);
    process.stdout.write(`${langfuse.datasetRunUrl || langfuse.datasetRunId}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  calibrationMetrics,
  selectCalibrationCases,
  schemaFor,
  buildCalibrationPrompt,
  buildLangfuseItem,
  langfuseScoreNames,
  installedCodexVersion,
  hasChatGptAuthentication,
  runCodexDimension,
  codexEnvironment,
  model,
  scoreValue,
};
