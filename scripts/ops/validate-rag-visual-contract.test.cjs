'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('./validate-rag-visual-contract.cjs');

test('validates visual scene provenance and requested timestamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-visual-contract-'));
  const datasetDir = path.join(root, 'dataset');
  fs.mkdirSync(datasetDir, { recursive: true });
  const row = {
    id: 'visual-case',
    input: { question: 'What is visible in the sampled frame at 4.075 seconds?' },
    expectedOutput: { relevantEvidenceIds: ['reel:r:visual:1'] },
  };
  const scene = {
    id: 'reel:r:visual:1',
    startTime: 4.075,
    endTime: 4.075,
    evidenceType: 'VISUAL',
    evidenceText: 'A person and a blue chair.',
    indexAttemptId: 'attempt-1',
    indexVersion: 'reel-index-v2',
    embeddingModel: 'BAAI/bge-m3',
    embeddingVersion: 'bge-m3-tei-v1',
    embeddingDimensions: 1024,
  };
  fs.writeFileSync(path.join(datasetDir, 'development.json'), JSON.stringify([row]));
  fs.writeFileSync(path.join(datasetDir, 'held_out.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(datasetDir, 'development-fixtures.json'), JSON.stringify({ 'visual-case': { scenes: [scene] } }));
  fs.writeFileSync(path.join(datasetDir, 'held_out-fixtures.json'), JSON.stringify({}));
  try {
    const result = validate({ datasetDir, outputPath: path.join(root, 'result.json') });
    assert.equal(result.status, 'PASS');
    assert.equal(result.visualEvidenceItems, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
