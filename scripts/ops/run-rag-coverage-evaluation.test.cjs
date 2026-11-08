'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildFingerprint,
  compiledRuntimeFiles,
  configureEvaluationProviders,
  parseGroqQuotaGroups,
  availableGroqKeyIndexes,
  isDailyQuotaFailure,
  nextUtcQuotaResumeAt,
  deferProviderQuotaFailure,
  contextCaptureStatusFromResponse,
} = require('./run-rag-coverage-evaluation.cjs');

test('local RAG evaluation strips Groq credentials and disables transcription', () => {
  const env = {
    GROQ_API_KEYS: 'local-test-key-one,local-test-key-two',
    GROQ_API_KEY: 'local-test-single-key',
    GROQ_API_KEY_QUOTA_GROUPS: 'org-a,org-b',
  };

  assert.deepEqual(configureEvaluationProviders(env), {
    groqEnabled: false,
    keyCount: 0,
  });
  assert.equal('GROQ_API_KEYS' in env, false);
  assert.equal('GROQ_API_KEY' in env, false);
  assert.equal('GROQ_API_KEY_QUOTA_GROUPS' in env, false);
  assert.equal(env.RAG_EVALUATION_GROQ_DISABLED, 'true');
});

test('Groq quota mode requires explicit opt-in and canonicalizes its key list', () => {
  const env = {
    RAG_EVALUATION_GROQ_ENABLED: 'true',
    GROQ_API_KEYS: 'local-test-key-one,local-test-key-one,local-test-key-two',
    RAG_EVALUATION_GROQ_DISABLED: 'true',
  };

  assert.deepEqual(configureEvaluationProviders(env), {
    groqEnabled: true,
    keyCount: 2,
  });
  assert.equal(env.GROQ_API_KEYS, 'local-test-key-one,local-test-key-two');
  assert.equal('GROQ_API_KEY' in env, false);
  assert.equal('RAG_EVALUATION_GROQ_DISABLED' in env, false);
});

test('serializes exact generation-context capture status from the trace diagnostic', () => {
  assert.equal(
    contextCaptureStatusFromResponse({
      trace: {
        workflowMetrics: {
          diagnostics: { evaluationCapture: { contextCaptured: true } },
        },
      },
    }),
    'CAPTURED',
  );
  assert.equal(
    contextCaptureStatusFromResponse({
      trace: {
        workflowMetrics: {
          diagnostics: { evaluationCapture: { contextCaptured: false } },
        },
      },
    }),
    'NOT_CAPTURED',
  );
  assert.equal(contextCaptureStatusFromResponse({}), 'NOT_CAPTURED');
});

test('Groq key quota defaults to a shared organization budget', () => {
  const groups = parseGroqQuotaGroups('', 3);
  const usage = { 'shared:openai/gpt-oss-120b': 140_000 };

  assert.deepEqual(groups, ['shared', 'shared', 'shared']);
  assert.deepEqual(
    availableGroqKeyIndexes(
      groups,
      new Set(['openai/gpt-oss-120b']),
      usage,
      5_500,
      145_000,
    ),
    [],
  );
});

test('explicit Groq quota groups let independent organization budgets proceed', () => {
  const groups = parseGroqQuotaGroups('org-a,org-a,org-b', 3);
  const usage = { 'org-a:openai/gpt-oss-120b': 140_000 };

  assert.deepEqual(
    availableGroqKeyIndexes(
      groups,
      new Set(['openai/gpt-oss-120b']),
      usage,
      5_500,
      145_000,
    ),
    [2],
  );
});

test('Groq quota group count must match the unique configured key count', () => {
  assert.throws(
    () => parseGroqQuotaGroups('org-a,org-b', 3),
    /one non-empty organization group per unique key/,
  );
});

test('daily Groq exhaustion leaves only the unfinished case pending until UTC reset', () => {
  const now = new Date('2026-10-26T21:30:00.000Z');
  const response = {
    error: {
      code: 'GROQ_KEY_POOL_EXHAUSTED',
      totalKeys: 13,
      exhaustedKeys: 13,
      cooldownKeys: 0,
    },
  };
  const state = {
    status: 'RUNNING',
    cases: { case1: { status: 'IN_FLIGHT', attemptCount: 2 } },
  };

  assert.equal(isDailyQuotaFailure(response), true);
  assert.equal(nextUtcQuotaResumeAt(now), '2026-10-27T00:01:30.000Z');
  const failure = deferProviderQuotaFailure(state, 'case1', response, now);
  assert.equal(failure.attemptCount, 2);
  assert.equal(state.cases.case1.status, 'PENDING');
  assert.equal(state.cases.case1.attemptCount, 2);
  assert.equal(state.status, 'WAITING_FOR_UTC_RESET');
  assert.equal(state.nextResumeAt, '2026-10-27T00:01:30.000Z');
});

test('temporary Groq cooldown does not trigger daily-reset deferral', () => {
  assert.equal(
    isDailyQuotaFailure({
      error: {
        code: 'GROQ_KEY_POOL_EXHAUSTED',
        totalKeys: 13,
        exhaustedKeys: 0,
        cooldownKeys: 13,
      },
    }),
    false,
  );
  assert.equal(
    isDailyQuotaFailure({ error: { code: 'TOKENS_PER_DAY_EXHAUSTED' } }),
    true,
  );
});

test('compiled build fingerprint covers AI adapters and shared runtime libraries', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rag-build-fingerprint-'),
  );
  const runtimeRoot = path.join(temporaryRoot, 'dist', 'apps', 'ai-service');
  const compiledBase = path.join(runtimeRoot, 'apps', 'ai-service', 'src');
  const useCase = path.join(
    compiledBase,
    'application',
    'use-cases',
    'answer.js',
  );
  const adapter = path.join(
    compiledBase,
    'infrastructure',
    'adapters',
    'retrieval.js',
  );
  const common = path.join(
    runtimeRoot,
    'libs',
    'common',
    'src',
    'semantic-index.js',
  );

  try {
    for (const file of [useCase, adapter, common]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${path.basename(file)} v1`);
    }

    const compiledFiles = compiledRuntimeFiles(compiledBase);
    assert.deepEqual(
      compiledFiles.map(([relativePath]) => relativePath),
      [
        'apps/ai-service/src/application/use-cases/answer.js',
        'apps/ai-service/src/infrastructure/adapters/retrieval.js',
        'libs/common/src/semantic-index.js',
      ],
    );

    const initial = buildFingerprint(compiledBase);
    fs.writeFileSync(adapter, 'retrieval v2');
    const adapterChanged = buildFingerprint(compiledBase);
    fs.writeFileSync(common, 'semantic-index v2');
    const commonChanged = buildFingerprint(compiledBase);

    assert.notEqual(adapterChanged, initial);
    assert.notEqual(commonChanged, adapterChanged);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
