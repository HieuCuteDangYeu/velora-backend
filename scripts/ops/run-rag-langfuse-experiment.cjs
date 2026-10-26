#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

const root = path.resolve(__dirname, '../..');
const benchmarkRoot = path.join(root, '.benchmarks/rag-remediation-v7-20261022-01');
const defaultDatasetDir = path.join(
  benchmarkRoot,
  'dataset-v7-visual-reviewed-20261022-02',
);
const defaultRunDir = path.join(
  benchmarkRoot,
  'evaluation-v22-transcript-evidence-bounds-20261025-01',
);
const datasetVersion = 'rag-coverage-v7-visual-reviewed-20261022-02';
const evaluatorVersion = 'velora-rag-evaluation-v6';
const phases = ['baseline', 'candidate'];
const semanticFields = [
  ['faithfulness', 'semantic_faithfulness'],
  ['factualCorrectness', 'semantic_factual_correctness'],
  ['responseRelevancy', 'semantic_response_relevancy'],
  ['contextCompleteness', 'semantic_context_completeness'],
];
const deterministicFields = [
  ['exactMatch', 'deterministic_exact_match'],
  ['answerContainment', 'deterministic_answer_containment'],
  ['answerTokenF1', 'deterministic_answer_token_f1'],
  ['generationEvidenceCoverage', 'deterministic_generation_evidence_coverage'],
  [
    'generationEvidenceCaptureCoverage',
    'deterministic_generation_evidence_capture_coverage',
  ],
  ['citationSourceRecall', 'deterministic_citation_source_recall'],
  ['retrieval_recall_at_5', 'deterministic_retrieval_recall_at_5'],
];

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

function writeJsonAtomic(file, value) {
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

function datasetItem(row, datasetSha256) {
  return {
    id: `rag-v7-${datasetSha256.slice(0, 12)}-${row.id}`,
    input: { query: row.input.question },
    expectedOutput: row.expectedOutput,
    metadata: {
      caseId: row.id,
      datasetVersion: row.metadata?.datasetVersion ?? datasetVersion,
      datasetSha256,
      bucket: row.metadata?.bucket ?? 'UNSPECIFIED',
      split: row.metadata?.split ?? 'UNSPECIFIED',
      answerType: row.metadata?.answerType ?? 'UNSPECIFIED',
      language: row.metadata?.language ?? 'UNSPECIFIED',
      annotationStatus: row.metadata?.annotationStatus ?? 'UNSPECIFIED',
      reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
      humanApproved: false,
    },
  };
}

function sameDatasetItem(actual, expected) {
  if (!actual) return false;
  const metadataKeys = [
    'caseId',
    'datasetVersion',
    'datasetSha256',
    'bucket',
    'split',
    'answerType',
    'language',
    'annotationStatus',
    'reviewAuthority',
    'humanApproved',
  ];
  return (
    fingerprint({ input: actual.input, expectedOutput: actual.expectedOutput }) ===
      fingerprint({ input: expected.input, expectedOutput: expected.expectedOutput }) &&
    metadataKeys.every(
      (key) => actual.metadata?.[key] === expected.metadata[key],
    )
  );
}

function loadRun(datasetDir = defaultDatasetDir, runDir = defaultRunDir) {
  const final = readJson(path.join(runDir, 'final-benchmark.json'));
  if (final.qualityGate?.status !== 'PASS')
    throw new Error('V22 quality gate must pass before Langfuse experiment replay');
  const rows = ['development', 'held_out'].flatMap((split) =>
    readJson(path.join(datasetDir, `${split}.json`)),
  );
  const datasetSha256 = fingerprint(rows);
  if (rows.length !== final.casesPerPhase || datasetSha256 !== final.datasetSha256)
    throw new Error('Frozen dataset rows do not match the V22 final benchmark');

  const cohorts = {};
  for (const phase of ['baseline', 'candidate']) {
    const directory = path.join(runDir, `cohort-v22-${phase}`);
    const state = readJson(path.join(directory, 'state.json'));
    const responses = readJsonl(path.join(directory, 'responses.jsonl'));
    const semantic = readJson(path.join(directory, 'semantic.json'));
    const deterministic = readJson(path.join(directory, 'deterministic-details.json'));
    const expectedIds = new Set(rows.map((row) => row.id));
    const responseIds = new Set(responses.map((response) => response.caseId));
    if (
      state.status !==
        (phase === 'candidate' ? 'COMPLETE' : 'COMPLETE_WITH_EXECUTION_FAILURES') ||
      state.datasetSha256 !== datasetSha256 ||
      Object.keys(state.cases || {}).length !== rows.length ||
      responses.length !== rows.length ||
      responseIds.size !== rows.length ||
      [...expectedIds].some((caseId) => !responseIds.has(caseId)) ||
      Object.values(semantic.cases || {}).some((entry) => entry?.error) ||
      semantic.evaluatorVersion !== evaluatorVersion ||
      deterministic.length !== rows.length
    ) {
      throw new Error(`${phase} cohort is not a complete, matching V22 snapshot`);
    }
    cohorts[phase] = {
      state,
      responses: new Map(responses.map((response) => [response.caseId, response])),
      semantic: semantic.cases,
      deterministic: new Map(deterministic.map((item) => [item.caseId, item])),
    };
  }
  return { rows, cohorts, datasetSha256, final };
}

function experimentOutput(response) {
  const diagnostics = response.trace?.workflowMetrics?.diagnostics ?? {};
  return {
    response: response.output?.answer ?? '',
    citations: (response.output?.citations ?? []).map((citation) => ({
      sourceType: citation.sourceType,
      reelId: citation.reelId,
      evidenceType: citation.evidenceType,
      sourceId: citation.sourceId,
      startTime: citation.startTime,
      endTime: citation.endTime,
      quote: citation.quote,
    })),
    retrievedChunkIds: response.trace?.retrievedChunkIds ?? [],
    rerankedChunkIds: response.trace?.rerankedChunkIds ?? [],
    generationEvidence: (diagnostics.generationEvidence ?? []).map((item) => ({
      evidenceId: item.evidenceId,
      sourceId: item.sourceId,
      reelId: item.reelId,
      evidenceType: item.evidenceType,
      startTime: item.startTime,
      endTime: item.endTime,
      indexVersion: item.indexVersion,
      evidenceText: item.evidenceText,
    })),
    contextSufficiency: diagnostics.contextSufficiency
      ? {
          sufficient: diagnostics.contextSufficiency.sufficient,
          availableEvidence: diagnostics.contextSufficiency.availableEvidence,
          missingEvidence: diagnostics.contextSufficiency.missingEvidence,
          missingReelIds: diagnostics.contextSufficiency.missingReelIds,
          supportedEvidenceIds:
            diagnostics.contextSufficiency.supportedEvidenceIds,
        }
      : undefined,
    verification: diagnostics.verification
      ? {
          passed: diagnostics.verification.finalPassed,
          confidence: diagnostics.verification.confidence,
          answerQualityPassed: diagnostics.verification.answerQualityPassed,
          requiresRevision: diagnostics.verification.requiresRevision,
        }
      : undefined,
    finalization: diagnostics.finalization
      ? {
          finalSource: diagnostics.finalization.finalSource,
          finalFailureSource: diagnostics.finalization.finalFailureSource,
          finalizationMode: diagnostics.finalization.finalizationMode,
          extractiveFallbackUsed:
            diagnostics.finalization.extractiveFallbackUsed,
          citationCoverageResult:
            diagnostics.finalization.citationCoverageResult,
        }
      : undefined,
    workflowLatencyMs: response.trace?.latencyMs,
    sourceTraceId: diagnostics.langfuseTraceId,
    productionExecutionId: diagnostics.productionExecutionId,
  };
}

function evaluationsFor(caseId, cohort) {
  const semantic = cohort.semantic[caseId];
  const deterministic = cohort.deterministic.get(caseId);
  const scores = [];
  for (const [field, name] of semanticFields) {
    const value = semantic?.[field]?.score;
    if (typeof value === 'number')
      scores.push({
        name,
        value,
        dataType: 'NUMERIC',
        comment: `${semantic.evaluatorVersion}; ${semantic.provider}:${semantic.model}`,
        metadata: {
          evaluatorVersion: semantic.evaluatorVersion,
          provider: semantic.provider,
          model: semantic.model,
        },
      });
  }
  for (const [field, name] of deterministicFields) {
    const value = deterministic?.[field];
    if (typeof value === 'number')
      scores.push({
        name,
        value,
        dataType: 'NUMERIC',
        comment: 'Persisted deterministic V22 evaluation result',
        metadata: { datasetVersion },
      });
  }
  return scores;
}

function runEvaluators() {
  const names = [
    ...semanticFields.map(([, name]) => name),
    ...deterministicFields.map(([, name]) => name),
  ];
  return [async ({ itemResults }) =>
    names.flatMap((name) => {
      const values = itemResults
        .flatMap((item) => item.evaluations ?? [])
        .filter(
          (score) => score.name === name && typeof score.value === 'number',
        )
        .map((score) => score.value);
      return values.length
        ? [
            {
              name: `mean_${name}`,
              value: values.reduce((sum, value) => sum + value, 0) / values.length,
              dataType: 'NUMERIC',
              comment: `${values.length} scored cases from ${datasetVersion}`,
            },
          ]
        : [];
    }),
  ];
}

async function getOrCreateDataset(client, name, rows, items, datasetSha256) {
  let dataset;
  try {
    dataset = await client.dataset.get(name, { fetchItemsPageSize: 100 });
  } catch (error) {
    const status = error?.status ?? error?.statusCode;
    if (status !== 404) throw error;
  }
  if (!dataset) {
    await client.createDataset({
      name,
      description:
        'Frozen V7 RAG regression cohort. Cached V22 response replay for Langfuse tracing and score comparison; experiment tasks make no RAG or model calls.',
      metadata: {
        datasetVersion,
        datasetSha256,
        cases: rows.length,
        reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
        humanApproved: false,
      },
      inputSchema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: { query: { type: 'string' } },
      },
    });
    dataset = await client.dataset.get(name, { fetchItemsPageSize: 100 });
  }
  if (dataset.metadata?.datasetSha256 !== datasetSha256)
    throw new Error('Existing Langfuse dataset has a different frozen snapshot hash');

  const existing = new Map(
    dataset.items.map((item) => [item.metadata?.caseId, item]),
  );
  const missing = [];
  for (const item of items) {
    const prior = existing.get(item.metadata.caseId);
    if (!prior) {
      missing.push(item);
      continue;
    }
    if (!sameDatasetItem(prior, item))
      throw new Error(`Langfuse dataset item differs from the frozen V7 snapshot: ${item.metadata.caseId}`);
  }
  for (let start = 0; start < missing.length; start += 8) {
    await Promise.all(
      missing.slice(start, start + 8).map((item) =>
        client.dataset.createItem({ datasetName: name, ...item }),
      ),
    );
  }
  dataset = await client.dataset.get(name, { fetchItemsPageSize: 100 });
  if (
    dataset.items.length !== rows.length ||
    new Set(dataset.items.map((item) => item.metadata?.caseId)).size !== rows.length ||
    items.some((item) => {
      const existingItem = dataset.items.find(
        (remote) => remote.metadata?.caseId === item.metadata.caseId,
      );
      return !sameDatasetItem(existingItem, item);
    })
  )
    throw new Error('Langfuse dataset does not match the exact frozen V7 cohort');
  return dataset;
}

async function runExperiment(client, dataset, phase, cohort, options) {
  const responseByCaseId = cohort.responses;
  const result = await client.experiment.run({
    name: `RAG ${datasetVersion} cached-response replay`,
    runName: options.runName,
    description:
      `Replays persisted ${phase} responses for trace and score visibility. It makes no RAG or model calls.`,
    metadata: {
      phase,
      datasetVersion,
      datasetSha256: options.datasetSha256,
      buildFingerprint: cohort.state.buildFingerprint,
      evaluatorVersion,
      judgeProvider: 'groq',
      judgeModel: 'openai/gpt-oss-120b',
      sourceMode: 'PERSISTED_CACHED_RESPONSE',
      qualityGate: options.qualityGate,
    },
    data: options.items,
    task: async ({ metadata }) => {
      const caseId = metadata?.caseId;
      const response = responseByCaseId.get(caseId);
      if (!response) throw new Error(`Cached response missing for ${caseId}`);
      return experimentOutput(response);
    },
    evaluators: [async ({ metadata }) => {
      const caseId = metadata?.caseId;
      if (!caseId) throw new Error('Langfuse dataset item missing caseId metadata');
      return evaluationsFor(caseId, cohort);
    }],
    runEvaluators: runEvaluators(),
    maxConcurrency: 8,
  });
  await client.flush();
  return {
    phase,
    runName: result.runName,
    datasetRunId: result.datasetRunId,
    datasetRunUrl: result.datasetRunUrl,
    experimentId: result.experimentId,
    itemCount: result.itemResults.length,
    scoredItems: result.itemResults.filter((item) => item.evaluations.length > 0).length,
    runEvaluations: result.runEvaluations,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) return selfTest();
  if (!args.apply)
    throw new Error('Langfuse dataset and experiment writes require --apply; use --self-test for local checks.');
  const phaseFilter = args.phase || 'both';
  if (!['both', ...phases].includes(phaseFilter))
    throw new Error('--phase must be baseline or candidate or both');
  const itemLimit = args.limit ? Number.parseInt(args.limit, 10) : undefined;
  if (itemLimit !== undefined && (!Number.isInteger(itemLimit) || itemLimit < 1))
    throw new Error('--limit must be a positive integer');

  dotenv.config({ path: path.join(root, '.env') });
  process.env.LANGFUSE_ENABLED = 'true';
  process.env.LANGFUSE_SAMPLE_RATE = '1';
  process.env.LANGFUSE_TRACING_ENVIRONMENT = 'rag-evaluation';
  process.env.LANGFUSE_CAPTURE_CONTENT = 'true';
  process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT = 'true';
  const run = loadRun();
  const datasetName =
    args['dataset-name'] ||
    `rag-coverage-v7-visual-reviewed-20261022-02-${run.datasetSha256.slice(0, 12)}`;
  const items = run.rows.map((row) => datasetItem(row, run.datasetSha256));
  const { LangfuseClient } = require('@langfuse/client');
  const { LangfuseSpanProcessor } = require('@langfuse/otel');
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { maskLangfuseData } = require(path.join(
    run.cohorts.candidate.state.compiledBase,
    'infrastructure/services/langfuse-telemetry.js',
  ));
  const sdk = new NodeSDK({
    serviceName: 'velora-rag-evaluation-replay',
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_BASE_URL,
        environment: 'rag-evaluation',
        release: `v22-cached-${run.datasetSha256.slice(0, 12)}`,
        flushAt: 20,
        flushInterval: 5,
        mediaUploadEnabled: false,
        mask: ({ data }) => maskLangfuseData(data),
      }),
    ],
  });
  sdk.start();
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  try {
    const dataset = await getOrCreateDataset(
      client,
      datasetName,
      run.rows,
      items,
      run.datasetSha256,
    );
    const expectedIds = new Set(items.map((item) => item.metadata.caseId));
    if (dataset.items.some((item) => !expectedIds.has(item.metadata?.caseId)))
      throw new Error('Langfuse dataset includes unexpected items');
    const runItems = itemLimit ? dataset.items.slice(0, itemLimit) : dataset.items;
    const requested = phaseFilter === 'both' ? phases : [phaseFilter];
    const ledgerPath = path.join(defaultRunDir, 'langfuse-experiment-runs.json');
    const ledger = fs.existsSync(ledgerPath)
      ? readJson(ledgerPath)
      : { datasetName, datasetSha256: run.datasetSha256, runs: {} };
    if (ledger.datasetName !== datasetName || ledger.datasetSha256 !== run.datasetSha256)
      throw new Error('Langfuse experiment ledger belongs to a different frozen dataset');
    for (const phase of requested) {
      const key = itemLimit ? `${phase}-smoke-${itemLimit}` : phase;
      const previous = ledger.runs[key];
      if (previous?.status === 'COMPLETE' && previous.datasetRunId) {
        process.stdout.write(`${key}: ${previous.datasetRunUrl || previous.datasetRunId}\n`);
        continue;
      }
      const runName = `V22 ${phase} ${itemLimit ? `smoke-${itemLimit}` : 'cached replay'} ${run.datasetSha256.slice(0, 12)}`;
      ledger.runs[key] = {
        status: 'IN_PROGRESS',
        runName,
        startedAt: new Date().toISOString(),
        itemCount: runItems.length,
      };
      writeJsonAtomic(ledgerPath, ledger);
      const result = await runExperiment(client, dataset, phase, run.cohorts[phase], {
        runName,
        items: runItems,
        datasetSha256: run.datasetSha256,
        qualityGate: run.final.qualityGate.status,
      });
      ledger.runs[key] = {
        status: 'COMPLETE',
        completedAt: new Date().toISOString(),
        ...result,
      };
      writeJsonAtomic(ledgerPath, ledger);
      process.stdout.write(`${key}: ${result.datasetRunUrl || result.datasetRunId}\n`);
    }
  } finally {
    await client.flush();
    await client.shutdown();
    await sdk.shutdown();
  }
}

function selfTest() {
  const run = loadRun();
  const items = run.rows.map((row) => datasetItem(row, run.datasetSha256));
  assert.equal(items.length, 400);
  assert.equal(new Set(items.map((item) => item.id)).size, 400);
  assert(items.every((item) => typeof item.input.query === 'string'));
  assert(items.every((item) => item.metadata.humanApproved === false));
  for (const phase of phases) {
    assert.equal(run.cohorts[phase].responses.size, 400);
    assert.equal(Object.keys(run.cohorts[phase].semantic).length, 400);
  }
  assert.equal(run.final.qualityGate.status, 'PASS');
  process.stdout.write('V22 Langfuse cached experiment self-check passed\n');
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });

module.exports = {
  datasetItem,
  evaluationsFor,
  experimentOutput,
  loadRun,
  sameDatasetItem,
};
