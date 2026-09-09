'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(
  ROOT,
  'eval/rag/config/groq-model-partition-burst-v1.json',
);

test('failed Qwen partition evidence remains immutable and sanitized', () => {
  const candidate = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  assert.equal(candidate.schemaVersion, 'rag-groq-model-partition-v1');
  assert.equal(candidate.status, 'QUALIFICATION_FAILED_SEMANTIC_REGRESSION');
  assert.equal(candidate.lastQualification.providerCalls, 12);
  assert.equal(candidate.lastQualification.semanticPassByRole.CONTEXT_SUFFICIENCY, '2/3');
  assert.equal(candidate.lastQualification.semanticPassByRole.VERIFIER_ESCALATION, '1/3');
  assert.equal(candidate.lastQualification.productionApproval, 'NO');
});
