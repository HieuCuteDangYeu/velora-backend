'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixturePorts, runtimeInput } = require('./rag-coverage-fixture.cjs');
const { fingerprint } = require('./rag-evaluation-contract.cjs');
const fixture = () => ({ userId: 'alice', conversationId: 'chat-a', authorizedReelIds: ['a'],
  documents: [
    { id: 'reel:a', reelId: 'a', title: 'A', indexAttemptId: 'new', indexVersion: 'v2', tags: [] },
    { id: 'reel:b', reelId: 'b', title: 'B', indexAttemptId: 'b', indexVersion: 'v2', tags: [] },
  ], chunks: [
    { id: 'current', reelId: 'a', indexAttemptId: 'new', indexVersion: 'v2', evidenceText: 'Seven days', startTime: 0, endTime: 8 },
    { id: 'stale', reelId: 'a', indexAttemptId: 'old', indexVersion: 'v2', evidenceText: 'Eight days', startTime: 0, endTime: 8 },
    { id: 'denied', reelId: 'b', indexAttemptId: 'b', indexVersion: 'v2', evidenceText: 'PRIVATE_CANARY', startTime: 0, endTime: 8 },
  ], scenes: [
    { id: 'frame-0', reelId: 'a', indexAttemptId: 'new', indexVersion: 'v2', evidenceText: 'A red box', startTime: 0, endTime: 0 },
    { id: 'frame-6', reelId: 'a', indexAttemptId: 'new', indexVersion: 'v2', evidenceText: 'A blue box', startTime: 6, endTime: 6 },
  ], userMemories: [{ userId: 'alice', content: 'TypeScript' }, { userId: 'bob', content: 'PRIVATE_CANARY' }],
  conversationMemories: [{ conversationId: 'chat-a', summary: 'Friday' }, { conversationId: 'chat-b', summary: 'PRIVATE_CANARY' }],
});
test('access resolution and semantic queries cannot widen fixture authorization', async () => {
  const p = createFixturePorts(fixture());
  assert.deepEqual(await p.content.resolveReelContextAccess({ userId: 'bob', conversationId: 'chat-a' }), []);
  assert.deepEqual(await p.content.resolveReelContextAccess({ userId: 'alice', conversationId: 'chat-b' }), []);
  assert.deepEqual((await p.index.searchChunks({ filters: { reelIds: ['a', 'b'] } })).map((r) => r.id), ['current']);
  assert.equal(await p.index.getReelDocument('b'), null);
  assert.deepEqual(await p.index.searchChunks({ requiredIndexVersion: 'v1' }), []);
  assert.deepEqual(await p.index.searchChunks({ queryEmbeddingModel: 'foreign-model' }), []);
});
test('sampled point timestamps and adjacency retain exact source and access scopes', async () => {
  const p = createFixturePorts(fixture());
  assert.deepEqual((await p.index.searchVisualScenes({ sourceOrder: 'ASC', sourceTimestampSec: 0 })).map((r) => r.id), ['frame-0']);
  assert.deepEqual((await p.index.searchVisualScenes({ sourceOrder: 'ASC', sourceTimestampSec: 6 })).map((r) => r.id), ['frame-6']);
  assert.deepEqual(await p.index.searchVisualScenes({ sourceTimestampSec: 5 }), []);
  assert.deepEqual(await p.index.getAdjacentChunks({ chunkId: 'current', eligibleReelIds: ['a', 'b'], parentId: 'reel:a', requiredIndexVersion: 'v2' }), []);
});
test('replay search preserves source metadata, section parents and duration', async () => {
  const f = fixture();
  f.documents[0].sourceDurationMs = 300000;
  f.documents[0].sourceLengthClass = 'LONG';
  f.sections = [{ id: 'section-a', reelId: 'a', parentId: 'reel:a', indexAttemptId: 'new', indexVersion: 'v2', evidenceText: 'Seven days' }];
  f.chunks[0].parentId = 'section-a';
  const p = createFixturePorts(f);
  const sections = await p.index.searchSections({ filters: { parentIds: ['reel:a'] } });
  const chunks = await p.index.searchChunks({ filters: { parentIds: [sections[0].id] } });
  assert.equal(chunks[0].title, 'A');
  assert.equal(chunks[0].sourceDurationMs, 300000);
  assert.equal(chunks[0].sourceLengthClass, 'LONG');
});
test('memory ports isolate user and conversation and reject writes', async () => {
  const p = createFixturePorts(fixture());
  assert.deepEqual(await p.userMemory.findRelevantByUserId({ userId: 'alice', limit: 8 }), [{ userId: 'alice', content: 'TypeScript' }]);
  assert.equal((await p.conversationMemory.findByConversationId('chat-a')).summary, 'Friday');
  assert.equal(await p.conversationMemory.findByConversationId('absent'), null);
  await assert.rejects(p.userMemory.upsertMany([]), /writes are disabled/);
});
test('runtime boundary excludes all reference answers, source IDs and evaluator metadata', () => {
  const f = fixture(), row = { id: 'case-a', input: { question: 'What is said?', fixtureRef: 'case-a' },
    expectedOutput: { referenceAnswer: 'DO_NOT_LEAK' }, metadata: { fixtureSha256: fingerprint(f), reference: 'DO_NOT_LEAK' } };
  assert.deepEqual(runtimeInput(row, f), { userId: 'alice', conversationId: 'chat-a', message: 'What is said?', memory: { recentMessages: [] } });
  assert(!JSON.stringify(runtimeInput(row, f)).includes('DO_NOT_LEAK'));
  assert.throws(() => runtimeInput(row, { ...f, conversationId: 'tampered' }), /identity mismatch/);
});
test('fault injection is scoped, observable and preserves error category', () => {
  const p = createFixturePorts({ ...fixture(), fault: { stage: 'generation', type: 'HTTP_429' } });
  p.fault('route');
  assert.throws(() => p.fault('generation'), { code: 'GROQ_KEY_POOL_EXHAUSTED', httpStatus: 429 });
  assert.deepEqual(p.events, [{ stage: 'generation', type: 'HTTP_429', injected: true }]);
});
test('primary-stage injection permits a healthy retry while fallback injection remains exhausted', () => {
  const primary = createFixturePorts({ ...fixture(), fault: { stage: 'route', type: 'HTTP_429', variant: 'PRIMARY' } });
  assert.throws(() => primary.fault('route'), { httpStatus: 429 });
  assert.doesNotThrow(() => primary.fault('route'));
  const fallback = createFixturePorts({ ...fixture(), fault: { stage: 'route', type: 'HTTP_429', variant: 'FALLBACK' } });
  assert.throws(() => fallback.fault('route'), { httpStatus: 429 });
  assert.throws(() => fallback.fault('route'), { httpStatus: 429 });
});

test('source qrels group only same-Reel chunks covering the full requested interval', () => {
  const { deriveEvidenceGroup } = require('./build-rag-coverage-dataset.cjs');
  const row = {
    metadata: { referenceStartSec: 10, referenceEndSec: 20 },
  };
  const fixture = {
    chunks: [
      {
        id: 'reel:a:chunk:1',
        reelId: 'a',
        startTime: 10,
        endTime: 20,
        evidenceText: 'The meeting starts on Monday.',
      },
      {
        id: 'reel:a:chunk:2',
        reelId: 'a',
        startTime: 9,
        endTime: 21,
        evidenceText: 'The meeting starts on Monday. Bring the blue notebook.',
      },
      {
        id: 'reel:a:chunk:3',
        reelId: 'a',
        startTime: 10,
        endTime: 19,
        evidenceText: 'The meeting starts on Monday.',
      },
      {
        id: 'reel:b:chunk:1',
        reelId: 'b',
        startTime: 9,
        endTime: 21,
        evidenceText: 'The meeting starts on Monday. Bring the blue notebook.',
      },
    ],
  };

  assert.deepEqual(
    deriveEvidenceGroup(row, fixture, 'reel:a:chunk:1'),
    ['reel:a:chunk:1', 'reel:a:chunk:2'],
  );
});

test('agent source review corrects quote gold only for the matching source window', () => {
  const { applyQuoteReferenceReview } = require('./build-rag-coverage-dataset.cjs');
  const rows = [
    {
      expectedOutput: {
        referenceAnswer: 'woman.',
        relevantEvidenceIds: ['reel:r:chunk:1'],
      },
      metadata: {
        answerType: 'QUOTE',
        referenceStartSec: 11.68,
        referenceEndSec: 56.38,
        annotationStatus: 'GENERATED_CANDIDATE',
        humanApproved: false,
      },
    },
    {
      expectedOutput: {
        referenceAnswer: 'Keep this label.',
        relevantEvidenceIds: ['reel:r:chunk:2'],
      },
      metadata: {
        answerType: 'QUOTE',
        referenceStartSec: 20,
        referenceEndSec: 60,
        annotationStatus: 'GENERATED_CANDIDATE',
        humanApproved: false,
      },
    },
  ];
  const review = {
    reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
    reviewedAt: '2026-10-21T00:00:00.000Z',
    cases: [
      {
        evidenceId: 'reel:r:chunk:1',
        sourceStartSec: 11.68,
        sourceEndSec: 56.38,
        reviewedReference: 'Get away from me.',
        decision: 'CORRECTED',
        sourceMatch: true,
      },
    ],
  };

  assert.equal(applyQuoteReferenceReview(rows, review), 1);
  assert.equal(rows[0].expectedOutput.referenceAnswer, 'Get away from me.');
  assert.equal(rows[0].metadata.annotationStatus, 'AGENT_REVIEWED_CANDIDATE');
  assert.equal(rows[0].metadata.humanApproved, false);
  assert.equal(rows[1].expectedOutput.referenceAnswer, 'Keep this label.');
});

test('frozen 440-case bundle rejects corruption, nonexistent gold IDs and source-family leakage', { skip: !process.env.RAG_COVERAGE_DATASET_DIR }, () => {
  const fs = require('node:fs'), path = require('node:path');
  const { validate } = require('./build-rag-coverage-dataset.cjs');
  const dir = process.env.RAG_COVERAGE_DATASET_DIR;
  const rows = [], fixtures = {};
  for (const split of ['development', 'held_out', 'operational']) {
    rows.push(...JSON.parse(fs.readFileSync(path.join(dir, split + '.json'))));
    Object.assign(fixtures, JSON.parse(fs.readFileSync(path.join(dir, split + '-fixtures.json'))));
  }
  assert.equal(validate({ rows, fixtures }).cases, 440);
  const corrupt = structuredClone(rows); corrupt[0].metadata.fixtureSha256 = 'invalid';
  assert.throws(() => validate({ rows: corrupt, fixtures }), /fingerprint mismatch/);
  const absent = structuredClone(rows); absent[0].expectedOutput.relevantEvidenceIds = ['nonexistent-source'];
  assert.throws(() => validate({ rows: absent, fixtures }), /Reference source absent/);
  const leaked = structuredClone(rows);
  const dev = leaked.find((r) => r.metadata.split === 'DEVELOPMENT' && fixtures[r.id].sourceType === 'CANONICAL_SNAPSHOT');
  dev.metadata.split = 'HELD_OUT';
  assert.throws(() => validate({ rows: leaked, fixtures }), /split leakage/);
});
test('real compiled retrieval engine uses frozen ports with native timestamp selection', { skip: !process.env.RAG_COMPILED_AI_BASE }, async () => {
  require('reflect-metadata');
  const path = require('node:path');
  const { DeterministicRetrievalEngineAdapter } = require(path.resolve(process.env.RAG_COMPILED_AI_BASE, 'infrastructure/adapters/deterministic-retrieval-engine.adapter.js'));
  const p = createFixturePorts(fixture());
  const noCall = async () => { throw new Error('Unexpected model call for native source read'); };
  const engine = new DeterministicRetrievalEngineAdapter({ generateObject: noCall }, { generateVector: noCall }, p.content, p.index, { rerank: noCall }, { record: noCall }, { get: () => undefined }, { get: () => undefined });
  const result = await engine.retrieve({ userId: 'alice', conversationId: 'chat-a', accessibleReelIds: ['a'],
    route: { requiredEvidence: ['VISUAL'], reelQuestionType: 'VISUAL_CONTENT' },
    plan: { mode: 'REEL_HYBRID', query: 'What is visible at 6 seconds?', queries: ['What is visible at 6 seconds?'], sourceOrder: 'ASC', sourceTimestampSec: 6, searchLimit: 8, rerankLimit: 5, shouldRerank: false } });
  assert.deepEqual(result.map((r) => r.chunkId), ['frame-6']);
  assert.equal(result[0].evidenceText, 'A blue box');
});
