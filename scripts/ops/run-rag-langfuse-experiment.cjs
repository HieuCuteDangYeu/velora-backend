#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

const root = path.resolve(__dirname, '../..');
const benchmarkRoot = path.join(
  root,
  '.benchmarks/rag-remediation-v7-20261022-01',
);
const defaultDatasetDir = path.join(
  benchmarkRoot,
  'dataset-v7-visual-reviewed-20261022-02',
);
const defaultRunDir = path.join(
  benchmarkRoot,
  'evaluation-v22-transcript-evidence-bounds-20261025-01',
);
const defaultDatasetVersion = 'rag-coverage-v7-visual-reviewed-20261022-02';
const defaultEvaluatorVersion = 'velora-rag-evaluation-v6';
const defaultCohortPrefix = 'cohort-v22';
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

function datasetItem(row, datasetSha256, version = defaultDatasetVersion) {
  const versionTag = version.match(/^rag-coverage-(v\d+)/)?.[1] || 'cached';
  return {
    id: `rag-${versionTag}-${datasetSha256.slice(0, 12)}-${row.id}`,
    input: { query: row.input.question },
    expectedOutput: row.expectedOutput,
    metadata: {
      caseId: row.id,
      datasetVersion: row.metadata?.datasetVersion ?? version,
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
    fingerprint({
      input: actual.input,
      expectedOutput: actual.expectedOutput,
    }) ===
      fingerprint({
        input: expected.input,
        expectedOutput: expected.expectedOutput,
      }) &&
    metadataKeys.every(
      (key) => actual.metadata?.[key] === expected.metadata[key],
    )
  );
}

function loadRun(
  datasetDir = defaultDatasetDir,
  runDir = defaultRunDir,
  options = {},
) {
  const finalPath = path.join(runDir, 'final-benchmark.json');
  const final = fs.existsSync(finalPath) ? readJson(finalPath) : null;
  if (!options.allowNonpassingQuality && final?.qualityGate?.status !== 'PASS')
    throw new Error(
      'A passing quality gate is required unless cached diagnostic replay is explicitly allowed',
    );
  const manifestPath = path.join(datasetDir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : {};
  const currentDatasetVersion =
    options.datasetVersion || manifest.datasetVersion || defaultDatasetVersion;
  const cohortPrefix = options.cohortPrefix || defaultCohortPrefix;
  const rows = ['development', 'held_out'].flatMap((split) =>
    readJson(path.join(datasetDir, `${split}.json`)),
  );
  const datasetSha256 = fingerprint(rows);
  if (
    final &&
    (rows.length !== final.casesPerPhase ||
      datasetSha256 !== final.datasetSha256)
  )
    throw new Error('Frozen dataset rows do not match the final benchmark');
  const expectedEvaluatorVersion =
    options.evaluatorVersion ||
    final?.evaluatorProtocol ||
    defaultEvaluatorVersion;

  const cohorts = {};
  for (const phase of ['baseline', 'candidate']) {
    const directory = path.join(runDir, `${cohortPrefix}-${phase}`);
    const state = readJson(path.join(directory, 'state.json'));
    const responses = readJsonl(path.join(directory, 'responses.jsonl'));
    const semanticPath = path.join(directory, 'semantic.json');
    const deterministicPath = path.join(
      directory,
      'deterministic-details.json',
    );
    const semantic = fs.existsSync(semanticPath)
      ? readJson(semanticPath)
      : { evaluatorVersion: expectedEvaluatorVersion, cases: {} };
    const deterministic = fs.existsSync(deterministicPath)
      ? readJson(deterministicPath)
      : [];
    const expectedIds = new Set(rows.map((row) => row.id));
    const responseIds = new Set(responses.map((response) => response.caseId));
    if (
      !['COMPLETE', 'COMPLETE_WITH_EXECUTION_FAILURES'].includes(
        state.status,
      ) ||
      state.datasetSha256 !== datasetSha256 ||
      Object.keys(state.cases || {}).length !== rows.length ||
      responses.length !== rows.length ||
      responseIds.size !== rows.length ||
      [...expectedIds].some((caseId) => !responseIds.has(caseId)) ||
      (!options.allowNonpassingQuality &&
        Object.values(semantic.cases || {}).some((entry) => entry?.error)) ||
      (Object.keys(semantic.cases || {}).length > 0 &&
        semantic.evaluatorVersion !== expectedEvaluatorVersion) ||
      (deterministic.length > 0 && deterministic.length !== rows.length)
    ) {
      throw new Error(
        `${phase} cohort is not a complete, matching frozen snapshot`,
      );
    }
    cohorts[phase] = {
      state,
      responses: new Map(
        responses.map((response) => [response.caseId, response]),
      ),
      semantic: semantic.cases,
      deterministic: new Map(deterministic.map((item) => [item.caseId, item])),
    };
  }
  return {
    rows,
    cohorts,
    datasetSha256,
    final,
    datasetDir,
    runDir,
    datasetVersion: currentDatasetVersion,
    sourceArtifactCaseCount: manifest.caseCount || rows.length,
    sourceManifestSha256: manifest.datasetSha256 || datasetSha256,
    evaluatorVersion: expectedEvaluatorVersion,
    cohortPrefix,
  };
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

function cachedToolCalls(response) {
  const calls =
    response?.trace?.workflowMetrics?.diagnostics?.contextToolExecution?.calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .filter(
      (call) => typeof call?.toolName === 'string' && call.toolName.trim(),
    )
    .map((call) => ({
      name: /^[A-Za-z0-9_.:-]{1,100}$/.test(call.toolName)
        ? call.toolName
        : 'unknown_tool',
      status:
        typeof call.status === 'string' ? call.status.slice(0, 32) : 'UNKNOWN',
      itemCount: Number.isFinite(call.itemCount) ? call.itemCount : null,
      latencyMs: Number.isFinite(call.latencyMs) ? call.latencyMs : null,
    }));
}

function assertToolObservationReadback(observations, expectedByTraceId) {
  const byTraceId = new Map();
  for (const observation of observations) {
    if (!expectedByTraceId.has(observation.traceId)) continue;
    const entries = byTraceId.get(observation.traceId) || [];
    entries.push(observation);
    byTraceId.set(observation.traceId, entries);
  }

  let toolObservationCount = 0;
  for (const [traceId, expectedNames] of expectedByTraceId) {
    const traceObservations = byTraceId.get(traceId) || [];
    if (!traceObservations.length)
      throw new Error(`LANGFUSE_TOOL_READBACK_INCOMPLETE trace=${traceId}`);
    if (traceObservations.some((item) => item.environment !== 'rag-evaluation'))
      throw new Error(
        `LANGFUSE_TOOL_READBACK_INVALID environment trace=${traceId}`,
      );
    const actualNames = traceObservations
      .filter((item) => item.type === 'TOOL')
      .map((item) => item.name)
      .sort();
    if (
      JSON.stringify(actualNames) !== JSON.stringify([...expectedNames].sort())
    )
      throw new Error(
        `LANGFUSE_TOOL_READBACK_INCOMPLETE tools trace=${traceId}`,
      );
    toolObservationCount += actualNames.length;
  }
  return toolObservationCount;
}

async function readBackToolObservations(
  client,
  itemResults,
  responses,
  { fromStartTime, retryDelaysMs = [0, 1_000, 3_000, 7_000, 15_000] },
) {
  const expectedByTraceId = new Map();
  const caseIds = new Set();
  for (const item of itemResults) {
    const caseId = item?.item?.metadata?.caseId;
    const traceId = item?.traceId;
    const response = responses.get(caseId);
    if (
      typeof caseId !== 'string' ||
      typeof traceId !== 'string' ||
      !response ||
      caseIds.has(caseId) ||
      expectedByTraceId.has(traceId)
    )
      throw new Error(
        'LANGFUSE_TOOL_READBACK_INVALID experiment item identity',
      );
    caseIds.add(caseId);
    expectedByTraceId.set(
      traceId,
      cachedToolCalls(response).map((call) => call.name),
    );
  }

  let lastReadbackError;
  for (const delayMs of retryDelaysMs) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const observations = [];
    const observationIds = new Set();
    const cursors = new Set();
    const toStartTime = new Date().toISOString();
    let cursor;
    do {
      const page = await client.api.observations.getMany({
        environment: 'rag-evaluation',
        fromStartTime,
        toStartTime,
        fields: 'core,basic',
        limit: 1_000,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page?.data) || !page?.meta)
        throw new Error('LANGFUSE_TOOL_READBACK_INVALID observation page');
      for (const observation of page.data) {
        if (
          typeof observation.id !== 'string' ||
          observationIds.has(observation.id)
        )
          throw new Error(
            'LANGFUSE_TOOL_READBACK_INVALID duplicate observation',
          );
        observationIds.add(observation.id);
        observations.push(observation);
      }
      cursor = page.meta.cursor;
      if (cursor && cursors.has(cursor))
        throw new Error('LANGFUSE_TOOL_READBACK_INVALID repeated cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);

    try {
      return assertToolObservationReadback(observations, expectedByTraceId);
    } catch (error) {
      if (
        !String(error?.message).startsWith('LANGFUSE_TOOL_READBACK_INCOMPLETE')
      )
        throw error;
      lastReadbackError = error;
    }
  }
  throw lastReadbackError || new Error('LANGFUSE_TOOL_READBACK_INCOMPLETE');
}

async function replayCachedToolObservations(
  response,
  startActiveObservation,
  metadata = {},
) {
  const calls = cachedToolCalls(response);
  if (!calls.length) return 0;
  await startActiveObservation(
    'rag.cached-response-replay',
    async (chain) => {
      chain.update({
        metadata: {
          ...metadata,
          sourceMode: 'PERSISTED_CACHED_RESPONSE',
          toolCallCount: calls.length,
        },
      });
      for (const call of calls) {
        await startActiveObservation(
          call.name,
          async (tool) => {
            tool.update({
              input: { sourceMode: 'PERSISTED_CACHED_RESPONSE' },
              output: {
                status: call.status,
                itemCount: call.itemCount,
                originalLatencyMs: call.latencyMs,
              },
              metadata: {
                ...metadata,
                sourceMode: 'PERSISTED_CACHED_RESPONSE',
              },
            });
          },
          { asType: 'tool' },
        );
      }
      chain.update({
        output: {
          sourceMode: 'PERSISTED_CACHED_RESPONSE',
          toolCallCount: calls.length,
        },
      });
    },
    { asType: 'chain' },
  );
  return calls.length;
}

function evaluationsFor(
  caseId,
  cohort,
  currentDatasetVersion = defaultDatasetVersion,
) {
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
        metadata: { datasetVersion: currentDatasetVersion },
      });
  }
  return scores;
}

function runEvaluators(currentDatasetVersion) {
  const names = [
    ...semanticFields.map(([, name]) => name),
    ...deterministicFields.map(([, name]) => name),
  ];
  return [
    async ({ itemResults }) =>
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
                value:
                  values.reduce((sum, value) => sum + value, 0) / values.length,
                dataType: 'NUMERIC',
                comment: `${values.length} scored cases from ${currentDatasetVersion}`,
              },
            ]
          : [];
      }),
  ];
}

function assertCompleteExperimentResult(result, items, phase) {
  const itemResults = Array.isArray(result?.itemResults)
    ? result.itemResults
    : [];
  const resultCaseIds = new Set(
    itemResults.map((item) => item?.item?.metadata?.caseId),
  );
  if (
    itemResults.length !== items.length ||
    resultCaseIds.size !== items.length ||
    items.some((item) => !resultCaseIds.has(item.metadata.caseId)) ||
    itemResults.some((item) => typeof item?.traceId !== 'string') ||
    new Set(itemResults.map((item) => item.traceId)).size !== items.length ||
    itemResults.some(
      (item) =>
        !item?.datasetRunId || item.datasetRunId !== result.datasetRunId,
    )
  )
    throw new Error(
      `Langfuse ${phase} replay did not link every item to a dataset run`,
    );
}

async function getOrCreateDataset(
  client,
  name,
  rows,
  items,
  datasetSha256,
  currentDatasetVersion,
  sourceArtifactCaseCount,
  sourceManifestSha256,
) {
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
      description: `Frozen ${currentDatasetVersion} primary cohort (${rows.length} development/held-out cases of ${sourceArtifactCaseCount} artifact cases; operational cases are validated separately). Cached response replay makes no RAG or model calls.`,
      metadata: {
        datasetVersion: currentDatasetVersion,
        datasetSha256,
        sourceManifestSha256,
        cases: rows.length,
        sourceArtifactCaseCount,
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
  if (
    dataset.metadata?.datasetSha256 !== datasetSha256 ||
    (dataset.metadata?.sourceManifestSha256 &&
      dataset.metadata.sourceManifestSha256 !== sourceManifestSha256)
  )
    throw new Error(
      'Existing Langfuse dataset has a different frozen snapshot hash',
    );

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
      throw new Error(
        `Langfuse dataset item differs from the frozen ${currentDatasetVersion} snapshot: ${item.metadata.caseId}`,
      );
  }
  for (let start = 0; start < missing.length; start += 8) {
    await Promise.all(
      missing
        .slice(start, start + 8)
        .map((item) =>
          client.dataset.createItem({ datasetName: name, ...item }),
        ),
    );
  }
  dataset = await client.dataset.get(name, { fetchItemsPageSize: 100 });
  if (
    dataset.items.length !== rows.length ||
    new Set(dataset.items.map((item) => item.metadata?.caseId)).size !==
      rows.length ||
    items.some((item) => {
      const existingItem = dataset.items.find(
        (remote) => remote.metadata?.caseId === item.metadata.caseId,
      );
      return !sameDatasetItem(existingItem, item);
    })
  )
    throw new Error(
      `Langfuse dataset does not match the exact frozen ${currentDatasetVersion} cohort`,
    );
  return dataset;
}

async function runExperiment(client, dataset, phase, cohort, options) {
  const responseByCaseId = cohort.responses;
  const replayedToolObservations = new Map();
  const experimentOptions = {
    name: `RAG ${options.datasetVersion} cached-response replay`,
    runName: options.runName,
    description: `Replays persisted ${phase} responses for trace and score visibility. It makes no RAG or model calls.`,
    metadata: {
      phase,
      datasetVersion: options.datasetVersion,
      datasetSha256: options.datasetSha256,
      primaryCaseCount: options.primaryCaseCount,
      experimentItemCount: options.items.length,
      sourceArtifactCaseCount: options.sourceArtifactCaseCount,
      sourceManifestSha256: options.sourceManifestSha256,
      buildFingerprint: cohort.state.buildFingerprint,
      evaluatorVersion: options.evaluatorVersion,
      judgeProvider: 'groq',
      judgeModel: 'openai/gpt-oss-120b',
      sourceMode: 'PERSISTED_CACHED_RESPONSE',
      qualityGate: options.qualityGate,
    },
    task: async ({ metadata }) => {
      const caseId = metadata?.caseId;
      const response = responseByCaseId.get(caseId);
      if (!response) throw new Error(`Cached response missing for ${caseId}`);
      const toolObservationCount = await replayCachedToolObservations(
        response,
        options.startActiveObservation,
        {
          phase,
          datasetSha256: options.datasetSha256,
          sourceBuildFingerprint: cohort.state.buildFingerprint,
        },
      );
      replayedToolObservations.set(caseId, toolObservationCount);
      return experimentOutput(response);
    },
    evaluators: [
      async ({ metadata }) => {
        const caseId = metadata?.caseId;
        if (!caseId)
          throw new Error('Langfuse dataset item missing caseId metadata');
        return evaluationsFor(caseId, cohort, options.datasetVersion);
      },
    ],
    runEvaluators: runEvaluators(options.datasetVersion),
    maxConcurrency: 8,
  };
  const fromStartTime = new Date(Date.now() - 60_000).toISOString();
  const result =
    options.items.length === dataset.items.length
      ? await dataset.runExperiment(experimentOptions)
      : await client.experiment.run({
          ...experimentOptions,
          data: options.items,
        });
  await options.spanProcessor.forceFlush();
  await client.flush();
  assertCompleteExperimentResult(result, options.items, phase);
  if (replayedToolObservations.size !== options.items.length)
    throw new Error(
      `Langfuse ${phase} replay did not account for every item's tool observations`,
    );
  const attemptedToolObservationCount = [
    ...replayedToolObservations.values(),
  ].reduce((sum, count) => sum + count, 0);
  const toolObservationCount = await readBackToolObservations(
    client,
    result.itemResults,
    responseByCaseId,
    { fromStartTime },
  );
  if (toolObservationCount !== attemptedToolObservationCount)
    throw new Error(
      'LANGFUSE_TOOL_READBACK_INCOMPLETE observation count mismatch',
    );
  return {
    phase,
    runName: result.runName,
    datasetRunId: result.datasetRunId,
    datasetRunUrl: result.datasetRunUrl,
    experimentId: result.experimentId,
    itemCount: result.itemResults.length,
    scoredItems: result.itemResults.filter(
      (item) => item.evaluations.length > 0,
    ).length,
    toolObservationCount,
    toolObservationsReadBack: true,
    runEvaluations: result.runEvaluations,
  };
}

function runMayStart(previous, remoteRunFound) {
  if (previous?.status === 'COMPLETE' && previous.datasetRunId) return false;
  if (previous || remoteRunFound)
    throw new Error(
      'A prior Langfuse run is ambiguous; reconcile it before starting another replay',
    );
  return true;
}

function estimateLangfuseReplayUnits(run, requestedPhases, itemLimit) {
  const rows = itemLimit ? run.rows.slice(0, itemLimit) : run.rows;
  let units = 0;
  for (const phase of requestedPhases) {
    const cohort = run.cohorts[phase];
    const runMetricNames = new Set();
    for (const row of rows) {
      const toolCalls = cachedToolCalls(cohort.responses.get(row.id)).length;
      const scores = evaluationsFor(row.id, cohort, run.datasetVersion);
      for (const score of scores) runMetricNames.add(score.name);
      // Reserve a trace, task observation, replay spans, and every emitted score.
      units += 2 + (toolCalls > 0 ? 1 : 0) + toolCalls + scores.length;
    }
    units += runMetricNames.size;
  }
  // Keep 50% headroom for SDK-generated observations not represented in outputs.
  return Math.ceil(units * 1.5);
}

function assertBillingPeriodVerified(
  args,
  requiredHeadroomUnits,
  now = Date.now(),
) {
  if (args['billing-period-verified'] !== true || !args['billing-proof'])
    throw new Error(
      'Langfuse replay requires --billing-period-verified and --billing-proof pointing to a fresh Billing-page verification.',
    );
  const proof = readJson(path.resolve(args['billing-proof']));
  const usage = proof.langfuseUsage;
  const nowMs = typeof now === 'function' ? now() : now;
  const verifiedAt = Date.parse(usage?.usageAsOf ?? '');
  const periodStart = Date.parse(
    `${usage?.billingPeriodStart ?? ''}T00:00:00Z`,
  );
  const periodEnd = Date.parse(`${usage?.billingPeriodEnd ?? ''}T00:00:00Z`);
  const consumed = Number(usage?.currentBillingPeriodUnits);
  const limit = Number(usage?.hobbyMonthlyAllowance);
  const evidencePath =
    typeof usage?.evidence === 'string'
      ? path.resolve(root, usage.evidence)
      : '';
  if (
    !proof.schemaVersion?.startsWith('rag-remediation-phase-gate-status-') ||
    usage?.billingPeriodVerified !== true ||
    usage?.resetObserved !== true ||
    !Number.isFinite(verifiedAt) ||
    nowMs - verifiedAt > 70 * 60 * 1_000 ||
    verifiedAt > nowMs + 60 * 1_000 ||
    !Number.isFinite(periodStart) ||
    !Number.isFinite(periodEnd) ||
    nowMs < periodStart ||
    nowMs >= periodEnd ||
    !Number.isSafeInteger(consumed) ||
    !Number.isSafeInteger(limit) ||
    consumed < 0 ||
    limit <= consumed ||
    !evidencePath ||
    !fs.existsSync(evidencePath)
  )
    throw new Error(
      'Langfuse billing proof is stale, over limit, outside the current period, or does not prove a reset.',
    );
  if (limit - consumed < requiredHeadroomUnits)
    throw new Error(
      `Langfuse billing proof has ${limit - consumed} units available; replay requires an estimated ${requiredHeadroomUnits} units including headroom.`,
    );
}

async function remoteExperimentExists(client, runName) {
  const response = await client.api.experiments.list({
    fromStartTime: '2020-01-01T00:00:00.000Z',
    name: runName,
    limit: 10,
    fields: 'core',
  });
  if (!Array.isArray(response?.data))
    throw new Error(
      'Langfuse did not return experiment history; refusing replay',
    );
  return response.data.some((experiment) => experiment.name === runName);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) return selfTest(args);
  const billingPreflight = args['billing-preflight'] === true;
  if (!args.apply && !billingPreflight)
    throw new Error(
      'Langfuse dataset and experiment writes require --apply; use --self-test for local checks.',
    );
  const phaseFilter = args.phase || 'both';
  if (!['both', ...phases].includes(phaseFilter))
    throw new Error('--phase must be baseline or candidate or both');
  const itemLimit = args.limit ? Number.parseInt(args.limit, 10) : undefined;
  if (
    itemLimit !== undefined &&
    (!Number.isInteger(itemLimit) || itemLimit < 1)
  )
    throw new Error('--limit must be a positive integer');

  dotenv.config({ path: path.join(root, '.env') });
  const datasetDir = path.resolve(args['dataset-dir'] || defaultDatasetDir);
  const runDir = path.resolve(args['run-dir'] || defaultRunDir);
  const run = loadRun(datasetDir, runDir, {
    cohortPrefix: args['cohort-prefix'] || defaultCohortPrefix,
    allowNonpassingQuality: args['allow-nonpassing-quality'] === true,
  });
  const requestedPhases = phaseFilter === 'both' ? phases : [phaseFilter];
  const requiredHeadroomUnits = estimateLangfuseReplayUnits(
    run,
    requestedPhases,
    itemLimit,
  );
  assertBillingPeriodVerified(args, requiredHeadroomUnits);
  if (billingPreflight) {
    process.stdout.write(
      JSON.stringify({ status: 'BILLING_PROOF_PASS', requiredHeadroomUnits }) +
        '\n',
    );
    return;
  }
  process.env.LANGFUSE_ENABLED = 'true';
  process.env.LANGFUSE_SAMPLE_RATE = '1';
  process.env.LANGFUSE_TRACING_ENVIRONMENT = 'rag-evaluation';
  process.env.LANGFUSE_CAPTURE_CONTENT = 'true';
  process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT = 'true';
  const versionTag =
    run.datasetVersion.match(/v\d+/i)?.[0]?.toUpperCase() || 'RAG';
  const datasetName =
    args['dataset-name'] ||
    `${run.datasetVersion}-${run.datasetSha256.slice(0, 12)}`;
  const items = run.rows.map((row) =>
    datasetItem(row, run.datasetSha256, run.datasetVersion),
  );
  const { LangfuseClient } = require('@langfuse/client');
  const { LangfuseSpanProcessor } = require('@langfuse/otel');
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { startActiveObservation } = require('@langfuse/tracing');
  const { maskLangfuseData } = require(
    path.join(
      run.cohorts.candidate.state.compiledBase,
      'infrastructure/services/langfuse-telemetry.js',
    ),
  );
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
    environment: 'rag-evaluation',
    release: `${versionTag.toLowerCase()}-cached-${run.datasetSha256.slice(0, 12)}`,
    flushAt: 20,
    flushInterval: 5,
    mediaUploadEnabled: false,
    mask: ({ data }) => maskLangfuseData(data),
  });
  const sdk = new NodeSDK({
    serviceName: 'velora-rag-evaluation-replay',
    spanProcessors: [spanProcessor],
  });
  sdk.start();
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  const ledgerPath = path.join(runDir, 'langfuse-experiment-runs.json');
  const lockPath = path.join(runDir, 'langfuse-experiment.lock');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  let lockCreated = false;
  try {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600 },
    );
    lockCreated = true;
    const ledger = fs.existsSync(ledgerPath)
      ? readJson(ledgerPath)
      : { datasetName, datasetSha256: run.datasetSha256, runs: {} };
    if (
      ledger.datasetName !== datasetName ||
      ledger.datasetSha256 !== run.datasetSha256
    )
      throw new Error(
        'Langfuse experiment ledger belongs to a different frozen dataset',
      );
    const requested = phaseFilter === 'both' ? phases : [phaseFilter];
    const runPlans = requested.map((phase) => {
      const build = run.cohorts[phase].state.buildFingerprint;
      if (typeof build !== 'string' || !build)
        throw new Error(`${phase} cohort is missing its build fingerprint`);
      const evaluatorTag = run.evaluatorVersion.replace(
        /[^A-Za-z0-9._-]/g,
        '-',
      );
      const key = `${phase}-${run.datasetSha256.slice(0, 12)}-${build.slice(0, 12)}-${evaluatorTag}${itemLimit ? `-smoke-${itemLimit}` : ''}`;
      const runName = `${versionTag} ${phase} ${evaluatorTag} cached replay ${run.datasetSha256.slice(0, 12)} ${build.slice(0, 12)}${itemLimit ? ` smoke-${itemLimit}` : ''}`;
      return { phase, key, runName, previous: ledger.runs[key] };
    });
    for (const plan of runPlans) {
      if (plan.previous?.status === 'COMPLETE' && plan.previous.datasetRunId)
        continue;
      runMayStart(
        plan.previous,
        await remoteExperimentExists(client, plan.runName),
      );
    }
    const dataset = await getOrCreateDataset(
      client,
      datasetName,
      run.rows,
      items,
      run.datasetSha256,
      run.datasetVersion,
      run.sourceArtifactCaseCount,
      run.sourceManifestSha256,
    );
    const expectedIds = new Set(items.map((item) => item.metadata.caseId));
    if (dataset.items.some((item) => !expectedIds.has(item.metadata?.caseId)))
      throw new Error('Langfuse dataset includes unexpected items');
    const runItems = itemLimit
      ? dataset.items.slice(0, itemLimit)
      : dataset.items;
    for (const { phase, key, runName, previous } of runPlans) {
      if (!runMayStart(previous, false)) {
        process.stdout.write(
          `${key}: ${previous.datasetRunUrl || previous.datasetRunId}\n`,
        );
        continue;
      }
      ledger.runs[key] = {
        status: 'IN_PROGRESS',
        runName,
        startedAt: new Date().toISOString(),
        itemCount: runItems.length,
      };
      writeJsonAtomic(ledgerPath, ledger);
      const result = await runExperiment(
        client,
        dataset,
        phase,
        run.cohorts[phase],
        {
          runName,
          items: runItems,
          datasetSha256: run.datasetSha256,
          datasetVersion: run.datasetVersion,
          primaryCaseCount: run.rows.length,
          sourceArtifactCaseCount: run.sourceArtifactCaseCount,
          sourceManifestSha256: run.sourceManifestSha256,
          evaluatorVersion: run.evaluatorVersion,
          qualityGate: run.final?.qualityGate?.status || 'NOT_AVAILABLE',
          startActiveObservation,
          spanProcessor,
        },
      );
      ledger.runs[key] = {
        status: 'COMPLETE',
        completedAt: new Date().toISOString(),
        ...result,
      };
      writeJsonAtomic(ledgerPath, ledger);
      process.stdout.write(
        `${key}: ${result.datasetRunUrl || result.datasetRunId}\n`,
      );
    }
  } finally {
    if (lockCreated) fs.unlinkSync(lockPath);
    await client.flush();
    await client.shutdown();
    await sdk.shutdown();
  }
}

function selfTest(args = {}) {
  const run = loadRun(
    path.resolve(args['dataset-dir'] || defaultDatasetDir),
    path.resolve(args['run-dir'] || defaultRunDir),
    {
      cohortPrefix: args['cohort-prefix'] || defaultCohortPrefix,
      allowNonpassingQuality: args['allow-nonpassing-quality'] === true,
    },
  );
  const items = run.rows.map((row) =>
    datasetItem(row, run.datasetSha256, run.datasetVersion),
  );
  assert(items.length > 0);
  assert(run.sourceArtifactCaseCount >= run.rows.length);
  assert.match(run.sourceManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert(items.every((item) => typeof item.input.query === 'string'));
  assert(items.every((item) => item.metadata.humanApproved === false));
  for (const phase of phases) {
    assert.equal(run.cohorts[phase].responses.size, run.rows.length);
    assert.equal(
      Object.keys(run.cohorts[phase].state.cases || {}).length,
      run.rows.length,
    );
    if (Object.keys(run.cohorts[phase].semantic).length > 0)
      assert.equal(
        Object.keys(run.cohorts[phase].semantic).length,
        run.rows.length,
      );
  }
  if (!args['allow-nonpassing-quality'])
    assert.equal(run.final?.qualityGate?.status, 'PASS');
  process.stdout.write(
    `${run.datasetVersion} Langfuse cached experiment self-check passed (${run.rows.length} primary/${run.sourceArtifactCaseCount} artifact cases)\n`,
  );
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
  runExperiment,
  assertCompleteExperimentResult,
  assertToolObservationReadback,
  cachedToolCalls,
  replayCachedToolObservations,
  runMayStart,
  remoteExperimentExists,
  readBackToolObservations,
  assertBillingPeriodVerified,
  estimateLangfuseReplayUnits,
  loadRun,
  sameDatasetItem,
  runExperiment,
};
