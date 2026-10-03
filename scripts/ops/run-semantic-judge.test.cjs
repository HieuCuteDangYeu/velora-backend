'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  computeStats,
  loadJson,
  parseArgs,
  saveJsonAtomic,
} = require('./run-semantic-judge.cjs');

test('parseArgs parses flags with values and booleans', () => {
  const args = parseArgs([
    '--state',
    'my-state.json',
    '--publish',
    '--concurrency=3',
    '--limit',
    '50',
  ]);

  assert.equal(args.state, 'my-state.json');
  assert.equal(args.publish, true);
  assert.equal(args.concurrency, '3');
  assert.equal(args.limit, '50');
});

test('computeStats correctly calculates mean, median, min, max', () => {
  const empty = computeStats([]);
  assert.deepEqual(empty, { mean: 0, median: 0, min: 0, max: 0, count: 0 });

  // Odd length
  const odd = computeStats([0.2, 0.8, 0.5]);
  assert.equal(odd.mean, 0.5);
  assert.equal(odd.median, 0.5);
  assert.equal(odd.min, 0.2);
  assert.equal(odd.max, 0.8);
  assert.equal(odd.count, 3);

  // Even length
  const even = computeStats([0.1, 0.3, 0.7, 0.9]);
  assert.equal(even.mean, 0.5);
  assert.equal(even.median, 0.5);
  assert.equal(even.min, 0.1);
  assert.equal(even.max, 0.9);
  assert.equal(even.count, 4);
});

test('saveJsonAtomic and loadJson perform atomic file writes safely', (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'judge-io-test-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const targetPath = join(tempDir, 'sub', 'test.json');
  const payload = { test: 'val', number: 42 };

  saveJsonAtomic(targetPath, payload);
  const loaded = loadJson(targetPath);

  assert.deepEqual(loaded, payload);
});

test('publishSemanticScores creates expected scores and flushes', async () => {
  const createdScores = [];
  let flushed = false;
  let shutdown = false;

  const mockClient = {
    score: {
      create: (score) => {
        createdScores.push(score);
      },
    },
    flush: async () => {
      flushed = true;
    },
    shutdown: async () => {
      shutdown = true;
    },
  };

  const { publishSemanticScores } = require('./run-semantic-judge.cjs');

  await publishSemanticScores({
    datasetRunId: 'test-run-123',
    caseEvaluations: {
      'CASE-001': {
        faithfulness: { score: 1.0, reasoning: 'Faithful' },
        factualCorrectness: { score: 0.8, reasoning: 'Mostly correct' },
        responseRelevancy: { score: 0.9, reasoning: 'Relevant' },
        contextCompleteness: { score: 1.0, reasoning: 'Complete' },
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
      },
    },
    langfuseClient: mockClient,
  });

  assert.equal(flushed, true);
  assert.equal(shutdown, true);
  // Each metric is published twice: once as standard name, once with semantic_ prefix
  assert.equal(createdScores.length, 8);
  const names = createdScores.map((s) => s.name);
  assert.ok(names.includes('faithfulness'));
  assert.ok(names.includes('semantic_faithfulness'));
  assert.ok(names.includes('factual_correctness'));
  assert.ok(names.includes('semantic_factual_correctness'));
  assert.ok(names.includes('response_relevancy'));
  assert.ok(names.includes('semantic_response_relevancy'));
  assert.ok(names.includes('context_completeness'));
  assert.ok(names.includes('semantic_context_completeness'));
  assert.equal(createdScores[0].datasetRunId, 'test-run-123');
  assert.equal(createdScores[0].metadata.caseId, 'CASE-001');
});

