'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const datasetPath = path.resolve(
  __dirname,
  '../../eval/rag/datasets/rag-reranker-generalization-v1.json',
);

test('reranker qualification dataset is versioned, provenance-backed, and label-complete', () => {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  assert.equal(dataset.schemaVersion, 'rag-reranker-qualification-v1');
  assert.equal(dataset.datasetVersion, 'rag-reranker-generalization-v1');
  assert.equal(dataset.provenance.kind, 'SAFE_TEST_FIXTURES');
  assert.ok(dataset.provenance.sources.length >= 2);
  assert.ok(dataset.cases.length >= 2);

  for (const item of dataset.cases) {
    const candidateIds = new Set(
      item.candidates.map((candidate) => candidate.id),
    );
    assert.equal(candidateIds.size, item.candidates.length);
    assert.ok(item.relevantIds.length > 0);
    for (const id of item.relevantIds) assert.ok(candidateIds.has(id));
  }
});
