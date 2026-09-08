'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const config = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      '../../eval/rag/config/groq-production-budget-v1.json',
    ),
    'utf8',
  ),
);

test('records the effective retrieval-tool policy in the static budget', () => {
  assert.equal(config.providerCalls, 0);
  assert.deepEqual(config.retrievalToolPolicy, {
    enabled: true,
    maxSteps: 3,
    maxParallelCalls: 2,
    maxCompletionTokens: 500,
    timeoutMs: 8000,
    maxOutputTokensPerLogicalRequest: 1500,
  });
});

test('keeps the normal role buckets explicit and bounded', () => {
  assert.equal(config.roleBuckets.QWEN_NORMAL, 4057);
  assert.equal(config.roleBuckets.QWEN_WITH_ANSWER_REVISION, 5741);
  assert.equal(config.roleBuckets.GPT120_NORMAL, 6756);
  assert.deepEqual(config.verifierBudget, {
    previousApplicationMaxCompletionTokens: 650,
    applicationMaxCompletionTokens: 1024,
    estimatedInputTokens: 1352,
    estimatedTotalTokens: 2376,
    observedLiveFailure: 'STRUCTURED_COMPLETION_TRUNCATED',
  });
  assert.ok(config.roleBuckets.GPT120_NORMAL > 6400);
  assert.ok(config.roleBuckets.GPT120_NORMAL <= 8000);
  assert.equal(
    config.roleBuckets.GPT20_NORMAL_WITH_RETRIEVAL_TOOL_OUTPUT_CEILING,
    6263,
  );
  assert.ok(
    config.roleBuckets.GPT20_NORMAL_WITH_RETRIEVAL_TOOL_OUTPUT_CEILING <= 6400,
  );
});
