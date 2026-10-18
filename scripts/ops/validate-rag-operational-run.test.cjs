'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('./validate-rag-operational-run.cjs');

test('accepts observed fault events, duplicate refusal, and expected trace loss', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-operational-validation-'));
  const datasetDir = path.join(root, 'dataset');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(datasetDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const rows = [
    { id: 'case-execution', metadata: { faultStage: 'execution', faultType: 'DUPLICATE' } },
    { id: 'case-trace', metadata: { faultStage: 'trace', faultType: 'MISSING' } },
  ];
  fs.writeFileSync(path.join(datasetDir, 'operational.json'), JSON.stringify(rows));
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
    cases: {
      'case-execution': { status: 'COMPLETED', productionExecutionId: 'exec-1', duplicatePrimaryRefused: true },
      'case-trace': { status: 'COMPLETED', traceMissingAsExpected: true },
    },
  }));
  fs.writeFileSync(path.join(runDir, 'responses.jsonl'), [
    JSON.stringify({ caseId: 'case-execution', trace: { workflowMetrics: { diagnostics: { productionExecutionId: 'exec-1' } } } }),
    JSON.stringify({ caseId: 'case-trace' }),
  ].join('\n') + '\n');
  const outputPath = path.join(runDir, 'validation.json');
  try {
    const result = validate({ datasetDir, runDir, outputPath });
    assert.equal(result.status, 'PASS');
    assert.equal(result.injectionExplicitlyObserved, 2);
    assert.equal(result.duplicatePrimaryRefusalCases, 1);
    assert.equal(result.traceLossCases, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
