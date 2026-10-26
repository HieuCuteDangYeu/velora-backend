#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fingerprint } = require('./rag-evaluation-contract.cjs');
const {
  BENCHMARK_EVALUATOR_VERSION,
} = require('./run-langfuse-live-benchmark.cjs');

const root = path.resolve(__dirname, '../..');
const benchmarkDir = path.join(
  root,
  '.benchmarks/rag-remediation-v8-20261026-01',
);
const expectedSourceRunId = 'rag-v8-live-e30cc0838a9d-20261026-01';
const expectedSourceRelease = 'e30cc0838a9dade2e7d60ea11547409919a8dd6e';
const defaultV8Dir = path.join(
  benchmarkDir,
  'dataset-v8-source-disjoint-20261026-03',
);
const defaultV9Dir = path.join(
  benchmarkDir,
  'dataset-v9-agent-reviewed-20261026-01',
);
const defaultSourceState = path.join(
  benchmarkDir,
  'live-benchmark-state-v3/rag-v8-live-e30cc0838a9d-20261026-01.state.json',
);
const defaultOutput = path.join(
  defaultV9Dir,
  'cached-baseline-e30-20261026-01.state.json',
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildCachedBaselineState({
  v8Dir = defaultV8Dir,
  v9Dir = defaultV9Dir,
  sourceStateFile = defaultSourceState,
  outputFile = defaultOutput,
} = {}) {
  if (fs.existsSync(outputFile))
    throw new Error(`Refusing to overwrite cached baseline: ${outputFile}`);
  const v8Manifest = readJson(path.join(v8Dir, 'manifest.json'));
  const v8Cases = readJson(path.join(v8Dir, 'cases.json'));
  const v9Manifest = readJson(path.join(v9Dir, 'manifest.json'));
  const v9Cases = readJson(path.join(v9Dir, 'cases.json'));
  const sourceBytes = fs.readFileSync(sourceStateFile);
  const sourceState = JSON.parse(sourceBytes);
  if (
    v8Manifest.datasetSha256 !== fingerprint(v8Cases) ||
    v9Manifest.datasetSha256 !== fingerprint(v9Cases) ||
    v8Manifest.datasetVersion !== 'rag-v8-source-disjoint-20261026-03' ||
    v9Manifest.datasetVersion !== 'rag-v9-agent-reviewed-20261026-01' ||
    v8Cases.length !== 136 ||
    v9Cases.length !== v8Cases.length ||
    sourceState.runId !== expectedSourceRunId ||
    sourceState.serviceReleaseSha !== expectedSourceRelease ||
    sourceState.datasetName !== `velora/${v8Manifest.datasetVersion}` ||
    Object.keys(sourceState.cases ?? {}).length !== v8Cases.length ||
    fingerprint(sourceState.itemIds) !==
      fingerprint(v8Cases.map((item) => item.id))
  )
    throw new Error(
      'V8 source state and reviewed V9 dataset identities do not match',
    );

  const v8ById = new Map(v8Cases.map((item) => [item.id, item]));
  const sourceSnapshotById = new Map(
    (sourceState.datasetSnapshot ?? []).map((item) => [item.id, item]),
  );
  if (sourceSnapshotById.size !== v8Cases.length)
    throw new Error(
      'Cached source state does not contain the complete frozen V8 snapshot',
    );
  const traceIds = new Set();
  const executionIds = new Set();
  for (const item of v9Cases) {
    const original = v8ById.get(item.id);
    const sourceItem = sourceSnapshotById.get(item.id);
    const result = sourceState.cases[item.id];
    if (
      !original ||
      !sourceItem ||
      fingerprint(original.input) !== fingerprint(item.input) ||
      fingerprint(original.input) !== fingerprint(sourceItem.input) ||
      fingerprint(original.expectedOutput.evidenceIds) !==
        fingerprint(item.expectedOutput.evidenceIds) ||
      fingerprint(original.expectedOutput.relevantEvidenceGroups) !==
        fingerprint(item.expectedOutput.relevantEvidenceGroups) ||
      result?.status !== 'COMPLETED' ||
      result.attemptCount !== 1 ||
      result.output?.release !== expectedSourceRelease ||
      !result.output?.traceId ||
      !result.output?.productionExecutionId ||
      traceIds.has(result.output.traceId) ||
      executionIds.has(result.output.productionExecutionId)
    )
      throw new Error(
        `Cached baseline is incompatible with V9 case ${item.id}`,
      );
    traceIds.add(result.output.traceId);
    executionIds.add(result.output.productionExecutionId);
  }

  const itemIds = v9Cases.map((item) => item.id);
  const datasetSnapshot = v9Cases;
  const datasetFingerprint = sha256(
    JSON.stringify(
      datasetSnapshot.map(({ id, input, expectedOutput }) => ({
        id,
        input,
        expectedOutput,
      })),
    ),
  );
  const state = {
    ...sourceState,
    runId: 'rag-v9-cached-baseline-e30-20261026-01',
    datasetName: `velora/${v9Manifest.datasetVersion}`,
    datasetFingerprint,
    snapshotFingerprint: fingerprint(datasetSnapshot),
    datasetRunId: null,
    itemIds,
    datasetSnapshot,
    evaluatorVersion: BENCHMARK_EVALUATOR_VERSION,
    sourceStateFile: path.relative(root, sourceStateFile),
    sourceStateRunId: sourceState.runId,
    sourceStateSha256: sha256(sourceBytes),
    cachedReplayOnly: true,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputFile, `${JSON.stringify(state, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { outputFile, state };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const [name, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) args[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--'))
      args[name] = argv[++index];
    else args[name] = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = buildCachedBaselineState({
    v8Dir: args['v8-dir'] || defaultV8Dir,
    v9Dir: args['v9-dir'] || defaultV9Dir,
    sourceStateFile: args['source-state'] || defaultSourceState,
    outputFile: args.output || defaultOutput,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        outputFile: result.outputFile,
        runId: result.state.runId,
        datasetName: result.state.datasetName,
        sourceRunId: result.state.sourceStateRunId,
        sourceStateSha256: result.state.sourceStateSha256,
        serviceReleaseSha: result.state.serviceReleaseSha,
        caseCount: result.state.itemIds.length,
        productionRagRequestsMade: 0,
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module)
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  }

module.exports = { buildCachedBaselineState, parseArgs };
