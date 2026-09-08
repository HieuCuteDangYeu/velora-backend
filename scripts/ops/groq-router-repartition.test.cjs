'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const config = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'eval/rag/config/groq-router-repartition-v1.json'),
    'utf8',
  ),
);

test('qualified Groq role partition is static-only and bucket-safe', () => {
  assert.equal(config.schemaVersion, 'rag-groq-router-repartition-v1');
  assert.equal(config.status, 'QUALIFIED_CANDIDATE_NOT_DEPLOYED');
  assert.equal(config.qualificationLimits.routerCalls, 6);
  assert.equal(config.qualificationCases.length, 6);
  assert.equal(config.qualificationEvidence.ROUTER, '6/6 semantic pass; 0 critical failures');
  assert.equal(config.qualificationEvidence.CONTEXT_SUFFICIENCY, '2/3 semantic pass; REJECTED_FOR_QWEN');
  assert.equal(config.qualificationEvidence.VERIFIER_ESCALATION, '1/3 semantic pass; REJECTED_FOR_QWEN');

  for (const bucket of Object.values(config.normalBuckets)) {
    assert.ok(bucket.estimatedTokens60s <= 6_400);
  }
  for (const bucket of Object.values(config.conditionalBuckets)) {
    assert.ok(bucket.estimatedTokens60s < 8_000);
  }
  assert.equal(config.roleModels.ROUTER, 'qwen/qwen3.8-27b');
  assert.equal(config.roleModels.CONTEXT_SUFFICIENCY, 'openai/gpt-oss-20b');
  assert.equal(config.roleModels.VERIFIER, 'openai/gpt-oss-120b');
});
