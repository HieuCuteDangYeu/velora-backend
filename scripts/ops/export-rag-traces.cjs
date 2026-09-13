#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const PRIVATE_KEY =
  /(?:answer|authorization|cookie|content|draft|instruction|message|password|prompt|question|quote|reasoning|response|secret|text|title|token|transcript)/i;
const SAFE_STRING_KEYS = new Set([
  'actualJsonType',
  'availableEvidence',
  'decisionSource',
  'endpointContract',
  'errorCode',
  'evidenceType',
  'expectedType',
  'failureSource',
  'finishReason',
  'indexVersion',
  'intent',
  'model',
  'modelRole',
  'missingEvidence',
  'networkErrorCode',
  'networkErrorName',
  'networkErrorSyscall',
  'provider',
  'providerCategory',
  'providerCode',
  'providerStatus',
  'recommendedAction',
  'referenceTarget',
  'requiredEvidence',
  'reelQuestionType',
  'recommendationActionType',
  'responseContentType',
  'schemaConstraint',
  'schemaPath',
  'schemaVersion',
  'scope',
  'sourceType',
  'status',
  'usageSource',
  'version',
  'embeddingProvider',
  'embeddingModel',
  'embeddingVersion',
  'finalFailureSource',
  'finalSource',
  'answerGenerationStatus',
  'groundingVerification',
  'finalizationMode',
  'fallbackReason',
  'verifierDecision',
]);

const SAFE_DIAGNOSTIC_KEYS = new Set([
  'answerCalls',
  'answerRevisionExecuted',
  'availableEvidence',
  'contextSufficiency',
  'decisionSource',
  'draftAnswerExecuted',
  'answerGenerationStatus',
  'synthesizedAnswerPreserved',
  'missingEvidence',
  'recommendedAction',
  'extractiveFallbackUsed',
  'groundingVerification',
  'finalizationMode',
  'fallbackReason',
]);

function isSafeStringKey(key) {
  return SAFE_STRING_KEYS.has(key) || /(?:Id|Ids)$/.test(key);
}

function sanitize(value, key = '') {
  if (
    (PRIVATE_KEY.test(key) && !SAFE_DIAGNOSTIC_KEYS.has(key)) ||
    key === 'requestId'
  )
    return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (typeof value === 'string')
    return isSafeStringKey(key) ? value : undefined;
  if (Array.isArray(value))
    return value
      .map((item) => sanitize(item, key))
      .filter((item) => item !== undefined);
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .map(([childKey, childValue]) => [
          childKey,
          sanitize(childValue, childKey),
        ])
        .filter(([, childValue]) => childValue !== undefined),
    );
  return undefined;
}

function sanitizeCitations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    sourceType: item?.sourceType,
    reelId: item?.reelId,
    evidenceType: item?.evidenceType,
    startTime: item?.startTime,
    endTime: item?.endTime,
  }));
}

function semanticContextIds(traces) {
  return [
    ...new Set(
      traces.flatMap((trace) => [
        ...(Array.isArray(trace.retrievedChunkIds)
          ? trace.retrievedChunkIds
          : []),
        ...(Array.isArray(trace.rerankedChunkIds)
          ? trace.rerankedChunkIds
          : []),
      ]).filter((id) => typeof id === 'string' && id.length > 0),
    ),
  ];
}

function semanticContextTable(id) {
  if (/^reel:[^:]+:chunk:\d+$/.test(id)) {
    return { clientKey: 'reelChunk', evidenceType: 'TRANSCRIPT' };
  }
  if (/^reel:[^:]+:section:\d+$/.test(id)) {
    return { clientKey: 'reelSection', evidenceType: 'TRANSCRIPT' };
  }
  if (/^reel:[^:]+:visual:\d+$/.test(id)) {
    return { clientKey: 'reelVisualScene', evidenceType: 'VISUAL' };
  }
  if (/^reel:[^:]+$/.test(id)) {
    return { clientKey: 'reelDocument', evidenceType: 'METADATA' };
  }
  throw new Error(`SEMANTIC_CONTEXT_PROVENANCE=UNSUPPORTED_ID id=${id}`);
}

async function loadSemanticContexts(indexing, ids) {
  const groups = new Map();
  for (const id of ids) {
    const table = semanticContextTable(id);
    const group = groups.get(table.clientKey) || {
      ...table,
      ids: [],
    };
    group.ids.push(id);
    groups.set(table.clientKey, group);
  }

  const rows = (
    await Promise.all(
      [...groups.values()].map(async (group) => {
        const found = await indexing[group.clientKey].findMany({
          where: { id: { in: group.ids }, isActive: true },
          select: {
            id: true,
            reelId: true,
            evidenceText: true,
            retrievalText: true,
            indexAttemptId: true,
          },
        });
        return found.map((row) => ({
          evidenceId: row.id,
          reelId: row.reelId,
          evidenceType: group.evidenceType,
          text: row.retrievalText || row.evidenceText || '',
          indexAttemptId: row.indexAttemptId,
        }));
      }),
    )
  ).flat();

  const byId = new Map();
  for (const row of rows) {
    if (byId.has(row.evidenceId)) {
      throw new Error(
        `SEMANTIC_CONTEXT_PROVENANCE=AMBIGUOUS id=${row.evidenceId}`,
      );
    }
    if (!row.text.trim()) {
      throw new Error(
        `SEMANTIC_CONTEXT_PROVENANCE=EMPTY_TEXT id=${row.evidenceId}`,
      );
    }
    byId.set(row.evidenceId, row);
  }

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `SEMANTIC_CONTEXT_PROVENANCE=MISSING ids=${missing.join(',')}`,
    );
  }
  return byId;
}

function contextsForIds(ids, semanticContexts) {
  if (!Array.isArray(ids)) return [];
  return ids.map((id, index) => {
    const context = semanticContexts.get(id);
    if (!context) {
      throw new Error(`SEMANTIC_CONTEXT_PROVENANCE=MISSING id=${id}`);
    }
    return {
      evidenceId: context.evidenceId,
      reelId: context.reelId,
      evidenceType: context.evidenceType,
      text: context.text,
      rank: index + 1,
    };
  });
}

function buildTraceRows(cases, traces, semanticContexts = null) {
  const expected = new Map(cases.map((item) => [item.caseId, item]));
  if (expected.size !== cases.length)
    throw new Error('runner report contains duplicate case IDs');
  const byConversation = new Map();
  for (const trace of traces) {
    const rows = byConversation.get(trace.conversationId) || [];
    rows.push(trace);
    byConversation.set(trace.conversationId, rows);
  }
  return [...expected].map(([caseId, item]) => {
    const isReconciledFailure =
      item.status === 'FAILED_RECONCILED' ||
      item.status === 'RECONCILED_FAILURE';
    if (
      !item.conversationId ||
      !item.userMessageId ||
      (!isReconciledFailure && !item.assistantMessageId)
    )
      throw new Error(`case ${caseId} is missing request identifiers`);
    const matches = byConversation.get(item.conversationId) || [];
    if (matches.length === 0)
      throw new Error(`TRACE_PROVENANCE=MISSING case=${caseId}`);
    if (matches.length !== 1)
      throw new Error(
        `TRACE_PROVENANCE=AMBIGUOUS case=${caseId} count=${matches.length}`,
      );
    const trace = matches[0];
    const row = {
      caseId,
      traceId: trace.id,
      intent: trace.intent,
      needsRetrieval: trace.needsRetrieval,
      retrievedChunkIds: trace.retrievedChunkIds,
      rerankedChunkIds: trace.rerankedChunkIds,
      citations: sanitizeCitations(trace.citations),
      verifierPassed: trace.verifierPassed,
      verifierConfidence: trace.verifierConfidence,
      latencyMs: trace.latencyMs,
      nodeTimings: sanitize(trace.nodeTimings, 'nodeTimings'),
      workflowMetrics: sanitize(trace.workflowMetrics, 'workflowMetrics'),
    };
    if (semanticContexts) {
      row.retrievedContexts = contextsForIds(
        trace.retrievedChunkIds,
        semanticContexts,
      );
      row.rerankedContexts = contextsForIds(
        trace.rerankedChunkIds,
        semanticContexts,
      );
    }
    return row;
  });
}

async function main() {
  const reportPath = arg('--runner-report');
  const outputPath = arg('--output');
  const envFile = arg('--env-file');
  if (!reportPath || !outputPath || !envFile)
    throw new Error('--runner-report, --output, and --env-file are required');
  dotenv.config({ path: envFile });
  if (!process.env.AI_DATABASE_URL)
    throw new Error('AI_DATABASE_URL is required for read-only trace export');
  const includeSemanticContext = process.argv.includes(
    '--include-semantic-context',
  );
  if (includeSemanticContext && !process.env.REEL_INDEXING_DATABASE_URL)
    throw new Error(
      'REEL_INDEXING_DATABASE_URL is required with --include-semantic-context',
    );
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (!Array.isArray(report.cases))
    throw new Error('runner report must contain cases');
  const conversationIds = report.cases.map((item) => item.conversationId);
  if (new Set(conversationIds).size !== conversationIds.length)
    throw new Error('runner report contains duplicate conversation IDs');
  const { PrismaClient } = require('@prisma/ai-client');
  const prisma = new PrismaClient();
  let indexing;
  try {
    const traces = await prisma.ragTrace.findMany({
      where: { conversationId: { in: conversationIds } },
      select: {
        id: true,
        conversationId: true,
        intent: true,
        needsRetrieval: true,
        retrievedChunkIds: true,
        rerankedChunkIds: true,
        citations: true,
        verifierPassed: true,
        verifierConfidence: true,
        latencyMs: true,
        nodeTimings: true,
        workflowMetrics: true,
      },
    });
    let semanticContexts = null;
    if (includeSemanticContext) {
      const { PrismaClient: IndexingClient } = require(
        '@prisma/reel-indexing-client',
      );
      indexing = new IndexingClient();
      semanticContexts = await loadSemanticContexts(
        indexing,
        semanticContextIds(traces),
      );
    }
    const rows = buildTraceRows(report.cases, traces, semanticContexts);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      temporary,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
    fs.renameSync(temporary, outputPath);
    console.log(
      JSON.stringify({
        TRACE_PROVENANCE: 'COMPLETE',
        TRACE_ROWS_EXPORTED: rows.length,
        PRIVATE_EVIDENCE_TEXT_EXPORTED: includeSemanticContext ? 'YES' : 'NO',
        SEMANTIC_CONTEXT_ROWS_EXPORTED: semanticContexts?.size || 0,
      }),
    );
  } finally {
    await prisma.$disconnect();
    if (indexing) await indexing.$disconnect();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = {
  buildTraceRows,
  loadSemanticContexts,
  sanitize,
  semanticContextIds,
  semanticContextTable,
};
