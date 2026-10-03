'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  JudgePoolController,
  buildJudgePrompt,
  callGroqJudge,
  clampScore,
  extractJson,
  formatRetrievedContext,
  normalizeJudgeOutput,
} = require('./rag-semantic-judge.cjs');

test('formatRetrievedContext formats citations cleanly and handles edge cases', () => {
  assert.equal(formatRetrievedContext(null), 'No context retrieved.');
  assert.equal(formatRetrievedContext([]), 'No context retrieved.');
  assert.equal(formatRetrievedContext('raw string context'), 'raw string context');

  const citations = [
    {
      title: 'Episode 1',
      evidenceType: 'TRANSCRIPT',
      startTime: 10.5,
      endTime: 20.0,
      quote: 'Hello world transcript quote',
    },
  ];
  const formatted = formatRetrievedContext(citations);
  assert.match(formatted, /\[Source 1\]/);
  assert.match(formatted, /Title: Episode 1/);
  assert.match(formatted, /Time: 10\.5s - 20s/);
  assert.match(formatted, /Quote: "Hello world transcript quote"/);
});

test('buildJudgePrompt generates prompt with all 4 RAG dimensions', () => {
  const prompt = buildJudgePrompt({
    question: 'Who is Olivier?',
    referenceAnswer: 'The recipient.',
    generatedAnswer: 'Olivier is the recipient.',
    context: 'Context quote',
  });
  assert.match(prompt, /1\. Faithfulness/);
  assert.match(prompt, /2\. Factual Correctness/);
  assert.match(prompt, /3\. Response Relevancy/);
  assert.match(prompt, /4\. Context Completeness/);
  assert.match(prompt, /Who is Olivier\?/);
  assert.match(prompt, /The recipient\./);
  assert.match(prompt, /Olivier is the recipient\./);
  assert.match(prompt, /Context quote/);
});

test('clampScore handles boundary and malformed inputs', () => {
  assert.equal(clampScore(1.0), 1.0);
  assert.equal(clampScore(0.0), 0.0);
  assert.equal(clampScore(1.5), 1.0);
  assert.equal(clampScore(-0.5), 0.0);
  assert.equal(clampScore('0.85'), 0.85);
  assert.equal(clampScore('invalid'), 0.0);
  assert.equal(clampScore(0.333333), 0.333);
});

test('extractJson parses direct JSON and markdown fenced blocks', () => {
  assert.deepEqual(extractJson('{"hello": "world"}'), { hello: 'world' });
  assert.deepEqual(
    extractJson('```json\n{"status": "ok"}\n```'),
    { status: 'ok' },
  );
  assert.deepEqual(
    extractJson('Some text before\n```\n{"key": 123}\n```\nSome text after'),
    { key: 123 },
  );
  assert.deepEqual(
    extractJson('Here is the evaluation: {"score": 1} - end of response.'),
    { score: 1 },
  );
  assert.equal(extractJson('invalid text without json'), null);
});

test('normalizeJudgeOutput handles camelCase, snake_case, and missing keys', () => {
  const validOutput = JSON.stringify({
    faithfulness: { score: 0.95, reasoning: 'Directly supported' },
    factual_correctness: { score: 1.0, reasoning: 'Matches reference' },
    response_relevancy: { score: 0.9, reasoning: 'Direct response' },
    context_completeness: { score: 0.85, reasoning: 'Contains facts' },
  });

  const normalized = normalizeJudgeOutput(validOutput);
  assert.equal(normalized.faithfulness.score, 0.95);
  assert.equal(normalized.faithfulness.reasoning, 'Directly supported');
  assert.equal(normalized.factualCorrectness.score, 1.0);
  assert.equal(normalized.factualCorrectness.reasoning, 'Matches reference');
  assert.equal(normalized.responseRelevancy.score, 0.9);
  assert.equal(normalized.responseRelevancy.reasoning, 'Direct response');
  assert.equal(normalized.contextCompleteness.score, 0.85);
  assert.equal(normalized.contextCompleteness.reasoning, 'Contains facts');
});

test('callGroqJudge formats payload and handles successful mock response', async () => {
  const mockFetch = async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'openai/gpt-oss-120b');
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.max_completion_tokens, 1536);

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                faithfulness: { score: 1.0, reasoning: 'Good' },
                factualCorrectness: { score: 1.0, reasoning: 'Accurate' },
                responseRelevancy: { score: 1.0, reasoning: 'Relevant' },
                contextCompleteness: { score: 1.0, reasoning: 'Complete' },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    };
  };

  const result = await callGroqJudge({
    apiKey: 'mock-key',
    prompt: 'test prompt',
    fetchFn: mockFetch,
  });

  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'openai/gpt-oss-120b');
  assert.equal(result.usage.totalTokens, 150);
});

test('JudgePoolController rotates keys and records results in quota ledger', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'judge-pool-test-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const calledKeys = [];
  const mockFetch = async (url, options) => {
    const authHeader = options.headers.Authorization;
    calledKeys.push(authHeader.replace('Bearer ', ''));

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                faithfulness: { score: 1.0, reasoning: 'Faithful' },
                factualCorrectness: { score: 1.0, reasoning: 'Correct' },
                responseRelevancy: { score: 1.0, reasoning: 'Relevant' },
                contextCompleteness: { score: 1.0, reasoning: 'Complete' },
              }),
            },
          },
        ],
        usage: { total_tokens: 120 },
      }),
    };
  };

  const pool = new JudgePoolController({
    groqApiKeys: ['key-alpha', 'key-beta'],
    ledgerBaseDir: tempDir,
    tpmLimitPerKey: 5000,
  });

  const res1 = await pool.evaluateCase({
    caseId: 'CASE-001',
    question: 'Q1',
    referenceAnswer: 'A1',
    generatedAnswer: 'A1',
    context: 'C1',
    fetchFn: mockFetch,
  });

  const res2 = await pool.evaluateCase({
    caseId: 'CASE-002',
    question: 'Q2',
    referenceAnswer: 'A2',
    generatedAnswer: 'A2',
    context: 'C2',
    fetchFn: mockFetch,
  });

  assert.equal(res1.caseId, 'CASE-001');
  assert.equal(res1.faithfulness.score, 1.0);
  assert.equal(res2.caseId, 'CASE-002');
  assert.deepEqual(calledKeys, ['key-alpha', 'key-beta']);

  // Calling CASE-001 again should hit ledger without calling provider
  const res1Repeat = await pool.evaluateCase({
    caseId: 'CASE-001',
    question: 'Q1',
    referenceAnswer: 'A1',
    generatedAnswer: 'A1',
    context: 'C1',
    fetchFn: mockFetch,
  });
  assert.equal(res1Repeat.caseId, 'CASE-001');
  assert.equal(calledKeys.length, 2); // No additional provider call
});
