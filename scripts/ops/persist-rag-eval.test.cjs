'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadArtifacts, persistPayload } = require('./persist-rag-eval.cjs');

function fixture(runId = 'offline-rag-generalization-v1-test') {
  return {
    summary: {
      schemaVersion: 'rag-eval-summary-v1',
      runId,
      dataset: 'rag-generalization-v1',
      variant: {
        variantName: 'offline-fixture',
        evaluatorSha: 'evaluator-sha',
        productionSha: 'production-sha',
        configSnapshot: {
          roles: {
            ROUTER: {
              model: '@cf/test/router',
              timeoutMs: 30000,
              maxCompletionTokens: 512,
              secret: 'must-not-persist',
            },
          },
          apiKey: 'must-not-persist',
        },
      },
      caseCount: 1,
      executionFailureCount: 0,
      correct: 1,
      grounded: 1,
      correctAndGrounded: 1,
      hardGatePassed: true,
      accessControlViolations: 0,
      metrics: { mrr: 1 },
      semanticMetrics: {
        faithfulness: null,
        factual_correctness: null,
      },
      latencyMs: { endToEnd: { p50: 1, p95: 1, max: 1 } },
      reliability: { providerRequests: 0 },
      cost: { totalQueryCostUsd: 0 },
      slices: {},
    },
    caseRecord: {
      caseId: 'generic-01',
      datasetVersion: 'rag-generalization-v1',
      deterministic: {
        recallAt1: 1,
        recallAt3: 1,
        recallAt5: 1,
        recallAt10: 1,
        mrr: 1,
        ndcgAt5: 1,
        ndcgAt10: 1,
        evidenceHitRate: 1,
        citationPrecision: 1,
        citationRecall: 1,
        citationEvidenceHitRate: 1,
        wrongReelCitationCount: 0,
        wrongModalityCitationCount: 0,
        accessControlViolations: 0,
        answerCorrect: 1,
        grounded: 1,
        correctAndGrounded: 1,
      },
      semantic: {
        faithfulness: null,
        factual_correctness: null,
        response_relevancy: null,
        context_precision: null,
        context_recall: null,
      },
      cost: { totalQueryCostUsd: 0 },
      execution: {
        runId,
        caseId: 'generic-01',
        executionStatus: 'FIXTURE',
        input: { question: 'private question must not persist' },
        reference: { answer: 'private answer must not persist' },
        actual: {
          answer: 'private answer must not persist',
          retrievedContexts: [
            {
              evidenceId: 'evidence-1',
              reelId: 'reel-1',
              text: 'private retrieved context must not persist',
            },
          ],
          citations: [{ evidenceId: 'evidence-1', reelId: 'reel-1' }],
        },
        trace: { ragTraceId: 'trace-1' },
        modelCalls: [],
      },
    },
  };
}

function fakePrisma({ failCaseCreate = false } = {}) {
  const state = { run: null, cases: [] };
  const prisma = {
    ragEvaluationRun: {
      findUnique: async ({ where }) =>
        state.run && state.run.benchmarkRunId === where.benchmarkRunId
          ? { artifactHash: state.run.artifactHash }
          : null,
      create: async ({ data }) => {
        state.run = data;
        return data;
      },
    },
    ragEvaluationCase: {
      createMany: async ({ data }) => {
        if (failCaseCreate) throw new Error('case insert failed');
        state.cases.push(...data);
        return { count: data.length };
      },
    },
    $transaction: async (callback) => {
      const previous = { run: state.run, cases: [...state.cases] };
      try {
        return await callback(prisma);
      } catch (error) {
        state.run = previous.run;
        state.cases = previous.cases;
        throw error;
      }
    },
  };
  return { prisma, state };
}

test('loads and sanitizes immutable evaluation provenance without private content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-persist-'));
  const resultsRoot = path.join(root, 'results');
  const datasetRoot = path.join(root, 'datasets');
  const run = fixture();
  fs.mkdirSync(path.join(resultsRoot, run.summary.runId), { recursive: true });
  fs.mkdirSync(datasetRoot, { recursive: true });
  fs.writeFileSync(
    path.join(resultsRoot, run.summary.runId, 'summary.json'),
    `${JSON.stringify(run.summary)}\n`,
  );
  fs.writeFileSync(
    path.join(resultsRoot, run.summary.runId, 'cases.jsonl'),
    `${JSON.stringify(run.caseRecord)}\n`,
  );
  fs.writeFileSync(
    path.join(datasetRoot, 'rag-generalization-v1.jsonl'),
    '{"id":"generic-01"}\n',
  );

  const loaded = loadArtifacts({
    runId: run.summary.runId,
    resultsRoot,
    datasetRoot,
  });
  assert.equal(loaded.payload.run.datasetName, 'rag-generalization-v1');
  assert.equal(loaded.payload.run.ragasRun, false);
  assert.deepEqual(loaded.payload.cases[0].reelId, 'reel-1');
  assert.equal(loaded.payload.cases[0].traceId, 'trace-1');
  assert.equal(
    JSON.stringify(loaded.payload).includes('private question'),
    false,
  );
  assert.equal(
    JSON.stringify(loaded.payload).includes('private answer'),
    false,
  );
  assert.equal(
    JSON.stringify(loaded.payload).includes('private retrieved context'),
    false,
  );
  assert.equal(
    JSON.stringify(loaded.payload).includes('must-not-persist'),
    false,
  );
});

test('persists once and accepts an exact artifact replay as an idempotent no-op', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-persist-'));
  const resultsRoot = path.join(root, 'results');
  const datasetRoot = path.join(root, 'datasets');
  const run = fixture();
  fs.mkdirSync(path.join(resultsRoot, run.summary.runId), { recursive: true });
  fs.mkdirSync(datasetRoot, { recursive: true });
  fs.writeFileSync(
    path.join(resultsRoot, run.summary.runId, 'summary.json'),
    JSON.stringify(run.summary),
  );
  fs.writeFileSync(
    path.join(resultsRoot, run.summary.runId, 'cases.jsonl'),
    `${JSON.stringify(run.caseRecord)}\n`,
  );
  fs.writeFileSync(
    path.join(datasetRoot, 'rag-generalization-v1.jsonl'),
    '{"id":"generic-01"}\n',
  );
  const { payload } = loadArtifacts({
    runId: run.summary.runId,
    resultsRoot,
    datasetRoot,
  });
  const { prisma, state } = fakePrisma();

  assert.deepEqual(await persistPayload(prisma, payload), {
    status: 'PERSISTED',
    benchmarkRunId: run.summary.runId,
  });
  assert.deepEqual(await persistPayload(prisma, payload), {
    status: 'IDEMPOTENT_NOOP',
    benchmarkRunId: run.summary.runId,
  });
  assert.equal(state.cases.length, 1);
});

test('does not leave a partial run when case persistence fails', async () => {
  const run = fixture();
  const payload = require('./persist-rag-eval.cjs').buildPersistencePayload({
    runId: run.summary.runId,
    summary: run.summary,
    cases: [run.caseRecord],
    summaryBytes: Buffer.from(JSON.stringify(run.summary)),
    casesBytes: Buffer.from(`${JSON.stringify(run.caseRecord)}\n`),
    datasetBytes: Buffer.from('{"id":"generic-01"}\n'),
  });
  const { prisma, state } = fakePrisma({ failCaseCreate: true });

  await assert.rejects(persistPayload(prisma, payload), /case insert failed/);
  assert.equal(state.run, null);
  assert.deepEqual(state.cases, []);
});

test('rejects a different artifact for an existing immutable run', async () => {
  const run = fixture();
  const payload = require('./persist-rag-eval.cjs').buildPersistencePayload({
    runId: run.summary.runId,
    summary: run.summary,
    cases: [run.caseRecord],
    summaryBytes: Buffer.from(JSON.stringify(run.summary)),
    casesBytes: Buffer.from(`${JSON.stringify(run.caseRecord)}\n`),
    datasetBytes: Buffer.from('{"id":"generic-01"}\n'),
  });
  const { prisma } = fakePrisma();
  await persistPayload(prisma, payload);
  await assert.rejects(
    persistPayload(prisma, {
      ...payload,
      run: { ...payload.run, artifactHash: 'different' },
    }),
    /immutable RAG evaluation run already exists/,
  );
});
