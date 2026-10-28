'use strict';

// Run only in an isolated evaluation process. No owner-service connections,
// persistence, message publication or expected answers enter the workflow.
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const langfuseForEvaluation =
  process.env.RAG_EVALUATION_LANGFUSE_ENABLED === 'true';
process.env.LANGFUSE_CAPTURE_CONTENT = 'false';
process.env.LANGFUSE_SAMPLE_RATE = langfuseForEvaluation ? '1' : '0';
process.env.LANGFUSE_ENABLED = langfuseForEvaluation ? 'true' : 'false';
if (langfuseForEvaluation)
  process.env.LANGFUSE_TRACING_ENVIRONMENT = 'rag-evaluation';
process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT = 'true';
const {
  createFixturePorts,
  runtimeInput,
} = require('./rag-coverage-fixture.cjs');
require('reflect-metadata');
const base = process.env.RAG_COMPILED_AI_BASE;
if (!base) throw new Error('RAG_COMPILED_AI_BASE is required');
const load = (file) => require(path.resolve(base, file));
const { Test } = require('@nestjs/testing');
const { PrismaService } = load('infrastructure/prisma/prisma.service.js');
const { BuildRagTraceSnapshotUseCase } = load(
  'application/use-cases/build-rag-trace-snapshot.use-case.js',
);
let langfuseSdk;
if (langfuseForEvaluation) {
  const { createLangfuseSdk } = load(
    'infrastructure/services/langfuse-telemetry.js',
  );
  langfuseSdk = createLangfuseSdk();
  if (!langfuseSdk)
    throw new Error(
      'Evaluation Langfuse was enabled without configured credentials',
    );
  langfuseSdk.start();
}
const { LangfuseTracingService } = load(
  'infrastructure/services/langfuse-tracing.service.js',
);
const { AiServiceModule } = load('ai-service.module.js');
let ports, trace;
let activeCaseId;
let currentFixture;
let toolCallCount = 0;
const runtimeKeys = (
  process.env.GROQ_API_KEYS ||
  process.env.GROQ_API_KEY ||
  ''
)
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const deterministicOperational =
  process.env.RAG_OPERATIONAL_DETERMINISTIC_LLM === 'true';
const originalFetch = global.fetch;
global.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  const url = typeof input === 'string' ? input : input.url;
  if (url && new URL(url).hostname === 'api.groq.com' && init?.body) {
    try {
      const body = JSON.parse(init.body),
        payload = await response.clone().json();
      const headers = new Headers(init.headers);
      const keyIndex = runtimeKeys.indexOf(
        (headers.get('authorization') || '').replace(/^Bearer /, ''),
      );
      if (payload.usage?.total_tokens)
        console.log(
          '__USAGE__' +
            JSON.stringify({
              caseId: activeCaseId,
              keyIndex,
              model: body.model,
              totalTokens: payload.usage.total_tokens,
              cachedTokens:
                payload.usage.prompt_tokens_details?.cached_tokens || 0,
              at: new Date().toISOString(),
            }),
        );
    } catch {}
  }
  return response;
};
const proxy = (name) =>
  new Proxy(
    {},
    {
      get: (_, method) => {
        if (
          [
            'then',
            'onModuleInit',
            'onModuleDestroy',
            'onApplicationBootstrap',
            'onApplicationShutdown',
            'beforeApplicationShutdown',
          ].includes(method)
        )
          return undefined;
        return (...args) => ports[name][method](...args);
      },
    },
  );
const noRmq = {
  send() {
    throw new Error('Owner-service RPC disabled in fixture evaluation');
  },
  emit() {
    return {
      subscribe() {
        return { unsubscribe() {} };
      },
    };
  },
};

function operationalEvidenceText() {
  return (
    currentFixture?.chunks?.[0]?.evidenceText ||
    currentFixture?.documents?.[0]?.description ||
    'No fixture evidence available.'
  );
}

function deterministicStructuredResult(input, stage) {
  const evidenceText = operationalEvidenceText();
  if (stage === 'route') {
    return {
      intent: 'REEL_VIDEO_QUESTION',
      referenceTarget: 'SHARED_REEL',
      reelQuestionType: 'TRANSCRIPT_CONTENT',
      requiredEvidence: ['TRANSCRIPT'],
      recommendationAction: {
        type: 'NONE',
        query: '',
        allowPersonalizedFallback: false,
        suggestedQueries: [],
      },
      tools: ['search_reel_content'],
      reason: 'Deterministic operational fixture route.',
    };
  }
  if (stage === 'context') {
    return {
      sufficient: true,
      confidence: 1,
      supportedEvidenceIds: ['e0'],
      reason: 'Fixture evidence is available.',
      userFacingReason: '',
      recommendedAction: 'ANSWER',
    };
  }
  if (stage === 'generation') {
    return {
      answer: evidenceText,
      claims: [{ claim: evidenceText, evidenceIds: ['e0'] }],
    };
  }
  if (stage === 'verification') {
    return {
      passed: true,
      confidence: 1,
      issues: [],
      answerQualityPassed: true,
      answerQualityIssues: [],
      requiresRevision: false,
      revisedInstruction: '',
      contradictions: [],
      supportedClaimMappings: [{ claim: evidenceText, evidenceIds: ['e0'] }],
    };
  }
  if (stage === 'citation') {
    return {
      claims: [
        {
          claim: evidenceText,
          supported: true,
          evidenceIds: ['e0'],
          confidence: 1,
        },
      ],
    };
  }
  return {};
}

function deterministicToolCompletion() {
  if (toolCallCount++ === 0) {
    return {
      content: '',
      toolCalls: [
        {
          id: 'fixture-search-reel-content',
          name: 'search_reel_content',
          arguments: {
            query: 'workshop',
            evidence: 'TRANSCRIPT',
            mode: 'REEL_HYBRID',
            limit: 8,
          },
        },
      ],
    };
  }
  return { content: '', toolCalls: [] };
}

function redactEvaluationSnapshot(value) {
  if (Array.isArray(value)) return value.map(redactEvaluationSnapshot);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          key !== 'generationEvidence' &&
          !/(?:user|conversation)(?:Id|Ids)?$/i.test(key),
      )
      .map(([key, child]) => [key, redactEvaluationSnapshot(child)]),
  );
}

(async () => {
  let builder = Test.createTestingModule({ imports: [AiServiceModule] })
    .overrideProvider(PrismaService)
    .useValue({});
  if (!langfuseForEvaluation)
    builder = builder.overrideProvider(LangfuseTracingService).useValue({
      withRoot: (_, operation) =>
        operation({ traceId: 'local-fixture-' + crypto.randomUUID() }),
      setRootOutput() {},
      observe: (_, operation) => operation(),
      observeSync: (_, operation) => operation(),
      recordSemanticCalls() {},
      recordHierarchyShadow() {},
    });
  builder = builder
    .overrideProvider('IChatTokenPublisher')
    .useValue({ publishToken() {} });
  for (const token of [
    'CONTENT_RMQ',
    'INDEX_RMQ',
    'CONVERSATION_RMQ',
    'MONITORING_SERVICE_RMQ',
  ])
    builder = builder.overrideProvider(token).useValue(noRmq);
  if (process.env.RAG_FROZEN_BACKEND_EMBEDDINGS === 'true') {
    builder = builder
      .overrideProvider('IEmbeddingService')
      .useValue({
        async generateVector() {
          return {
            values: Array(1024).fill(0),
            dimensions: 1024,
            model: 'BAAI/bge-m3',
            version: 'bge-m3-tei-v1',
          };
        },
        async countTokens(_, text) {
          return Math.ceil(text.length / 4);
        },
      })
      .overrideProvider('IRerankerService')
      .useValue({
        async rerank({ candidates, limit }) {
          return candidates.slice(0, limit);
        },
      });
  }
  for (const [token, name] of [
    ['IContentService', 'content'],
    ['IReelSemanticIndexService', 'index'],
    ['IUserMemoryRepository', 'userMemory'],
    ['IConversationMemoryRepository', 'conversationMemory'],
  ])
    builder = builder.overrideProvider(token).useValue(proxy(name));
  const app = await builder.compile();
  await app.init();
  if (langfuseForEvaluation) {
    const tracing = app.get(LangfuseTracingService);
    const withRoot = tracing.withRoot.bind(tracing);
    tracing.withRoot = (metadata, operation) =>
      withRoot(
        {
          ...metadata,
          userId: undefined,
          conversationId: undefined,
          userMessage: undefined,
        },
        operation,
      );
    const setRootOutput = tracing.setRootOutput.bind(tracing);
    tracing.setRootOutput = (root, output, answer, snapshot) =>
      setRootOutput(
        root,
        output,
        undefined,
        snapshot ? redactEvaluationSnapshot(snapshot) : undefined,
      );
    const recordHierarchyShadow = tracing.recordHierarchyShadow.bind(tracing);
    tracing.recordHierarchyShadow = (observation) =>
      recordHierarchyShadow({
        ...observation,
        userId: undefined,
        conversationId: undefined,
      });
  }
  const snapshot = app.get(BuildRagTraceSnapshotUseCase),
    original = snapshot.execute.bind(snapshot);
  snapshot.execute = (input) => {
    trace = original(input);
    return trace;
  };
  const structured = app.get('IStructuredLlmService'),
    generate = structured.generateObject.bind(structured);
  structured.generateObject = (input) => {
    const role = String(input.modelRole || '').toUpperCase();
    const stage = /ROUT/.test(role)
      ? 'route'
      : /CONTEXT/.test(role)
        ? 'context'
        : /VERIF/.test(role)
          ? 'verification'
          : /ANSWER/.test(role)
            ? 'generation'
            : /CITATION/.test(role)
              ? 'citation'
              : 'other';
    ports.fault(stage);
    if (deterministicOperational)
      return Promise.resolve(deterministicStructuredResult(input, stage));
    return generate(input);
  };
  for (const [token, method, stage] of [
    ['IEmbeddingService', 'generateVector', 'embedding'],
    ['IRerankerService', 'rerank', 'reranker'],
    ['IToolCallingLlmService', 'complete', 'tool'],
  ]) {
    const service = app.get(token),
      call = service[method].bind(service);
    service[method] = async (input) => {
      ports.fault(stage);
      if (deterministicOperational && stage === 'tool')
        return deterministicToolCompletion();
      const result = await call(input);
      if (
        stage === 'embedding' &&
        ports.fixtureFault?.type === 'IDENTITY_MISMATCH'
      ) {
        ports.events.push({
          stage: 'embedding',
          type: 'IDENTITY_MISMATCH',
          injected: true,
        });
        return { ...result, model: 'foreign-fixture-model' };
      }
      return result;
    };
  }
  const workflow = app.get('IRagChatWorkflow');
  const { GroqKeyPool } = load(
    'infrastructure/services/groq-key-pool.service.js',
  );
  const keyPool = app.get(GroqKeyPool);
  const seen = new Set();
  console.log(
    '__READY__' +
      JSON.stringify({
        isolation: 'FROZEN_BACKEND_REPLAY',
        runtimeAnswersFromModels: true,
      }),
  );
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const request = JSON.parse(line);
    if (request.stop) break;
    const { row, fixture } = request;
    activeCaseId = row.id;
    if (request.keyStartIndex != null)
      keyPool.roundRobinIndex = request.keyStartIndex;
    if (seen.has(row.id)) {
      console.log(
        '__RESULT__' +
          JSON.stringify({
            caseId: row.id,
            error: { code: 'DUPLICATE_PRIMARY_REFUSED' },
          }),
      );
      continue;
    }
    seen.add(row.id);
    trace = undefined;
    ports = createFixturePorts(fixture);
    currentFixture = fixture;
    toolCallCount = 0;
    try {
      const output = await workflow.execute(runtimeInput(row, fixture));
      console.log(
        '__RESULT__' +
          JSON.stringify({
            caseId: row.id,
            output,
            trace: fixture.fault?.stage === 'trace' ? undefined : trace,
            fixtureEvents: ports.events,
          }),
      );
    } catch (error) {
      const quota = {};
      for (const key of ['totalKeys', 'exhaustedKeys', 'cooldownKeys']) {
        if (Number.isInteger(error?.[key])) quota[key] = error[key];
      }
      console.log(
        '__RESULT__' +
          JSON.stringify({
            caseId: row.id,
            error: { name: error.name, code: error.code, ...quota },
            trace,
            fixtureEvents: ports.events,
          }),
      );
    }
  }
  await app.close();
  await langfuseSdk?.shutdown();
})().catch(async (error) => {
  await langfuseSdk?.shutdown();
  console.error(
    '__BOOT_FAILURE__' +
      JSON.stringify({ name: error.name, message: error.message }),
  );
  process.exitCode = 1;
});
