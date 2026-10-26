const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildCachedBaselineState,
} = require('./build-rag-v9-cached-baseline-state.cjs');
const {
  BENCHMARK_EVALUATOR_VERSION,
} = require('./run-langfuse-live-benchmark.cjs');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

function makeFixture(root) {
  const v8Dir = path.join(root, 'v8');
  const v9Dir = path.join(root, 'v9');
  const sourceStateFile = path.join(root, 'source.state.json');
  const outputFile = path.join(root, 'output', 'baseline.state.json');
  const v8Cases = Array.from({ length: 136 }, (_, index) => ({
    id: `case-${String(index).padStart(3, '0')}`,
    input: { question: `Question ${index}`, reelIds: [`reel-${index}`] },
    expectedOutput: {
      answer: `Answer ${index}`,
      evidenceIds: [`reel:reel-${index}:chunk:0`],
      relevantEvidenceGroups: [[`reel:reel-${index}:chunk:0`]],
    },
    metadata: {
      bucket: 'TRANSCRIPT',
      datasetVersion: 'rag-v8-source-disjoint-20261026-03',
    },
  }));
  const v9Cases = structuredClone(v8Cases).map((item) => ({
    ...item,
    metadata: {
      ...item.metadata,
      datasetVersion: 'rag-v9-agent-reviewed-20261026-01',
    },
  }));
  const v8Manifest = {
    datasetVersion: 'rag-v8-source-disjoint-20261026-03',
    datasetSha256: fingerprint(v8Cases),
  };
  const v9Manifest = {
    datasetVersion: 'rag-v9-agent-reviewed-20261026-01',
    datasetSha256: fingerprint(v9Cases),
  };
  const sourceState = {
    runId: 'rag-v8-live-e30cc0838a9d-20261026-01',
    serviceReleaseSha: 'e30cc0838a9dade2e7d60ea11547409919a8dd6e',
    datasetName: 'velora/rag-v8-source-disjoint-20261026-03',
    datasetFingerprint: 'v8-dataset-fingerprint',
    snapshotFingerprint: fingerprint(v8Cases),
    itemIds: v8Cases.map((item) => item.id),
    datasetSnapshot: v8Cases,
    cases: Object.fromEntries(
      v8Cases.map((item, index) => [
        item.id,
        {
          status: 'COMPLETED',
          attemptCount: 1,
          output: {
            answer: `Saved answer ${index}`,
            traceId: `trace-${index}`,
            productionExecutionId: `execution-${index}`,
            release: 'e30cc0838a9dade2e7d60ea11547409919a8dd6e',
          },
        },
      ]),
    ),
  };
  writeJson(path.join(v8Dir, 'manifest.json'), {
    ...v8Manifest,
    caseCount: 136,
  });
  writeJson(path.join(v8Dir, 'cases.json'), v8Cases);
  writeJson(path.join(v9Dir, 'manifest.json'), {
    ...v9Manifest,
    caseCount: 136,
  });
  writeJson(path.join(v9Dir, 'cases.json'), v9Cases);
  writeJson(sourceStateFile, sourceState);
  return { v8Dir, v9Dir, sourceStateFile, outputFile, sourceState };
}

test('prepares a cached V9 baseline only from unique release-aligned completed V8 responses', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rag-v9-cached-baseline-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = makeFixture(root);
  const result = buildCachedBaselineState(data);
  assert.equal(result.state.runId, 'rag-v9-cached-baseline-e30-20261026-01');
  assert.equal(
    result.state.datasetName,
    'velora/rag-v9-agent-reviewed-20261026-01',
  );
  assert.equal(result.state.evaluatorVersion, BENCHMARK_EVALUATOR_VERSION);
  assert.equal(
    result.state.serviceReleaseSha,
    data.sourceState.serviceReleaseSha,
  );
  assert.equal(result.state.itemIds.length, 136);
  assert.equal(result.state.datasetRunId, null);
  assert.equal(result.state.cachedReplayOnly, true);
  assert.equal(result.state.cases['case-000'].output.answer, 'Saved answer 0');
  assert.equal(result.state.cases['case-000'].attemptCount, 1);
  assert.equal(fs.existsSync(result.outputFile), true);
  assert.equal('production request calls' in result.state, false);
  assert.throws(() => buildCachedBaselineState(data));
});

test('rejects cached response states with any mismatched source release or repeated trace', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rag-v9-cached-baseline-invalid-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = makeFixture(root);
  data.sourceState.cases['case-001'].output.release = '5'.repeat(40);
  writeJson(data.sourceStateFile, data.sourceState);
  assert.throws(
    () => buildCachedBaselineState(data),
    /incompatible with V9 case case-001/,
  );
});
