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
  'networkErrorCode',
  'networkErrorName',
  'networkErrorSyscall',
  'provider',
  'providerCategory',
  'providerCode',
  'providerStatus',
  'referenceTarget',
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
]);

function isSafeStringKey(key) {
  return SAFE_STRING_KEYS.has(key) || /(?:Id|Ids)$/.test(key);
}

function sanitize(value, key = '') {
  if (PRIVATE_KEY.test(key) || key === 'requestId') return undefined;
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

function buildTraceRows(cases, traces) {
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
    if (!item.conversationId || !item.userMessageId || !item.assistantMessageId)
      throw new Error(`case ${caseId} is missing request identifiers`);
    const matches = byConversation.get(item.conversationId) || [];
    if (matches.length === 0)
      throw new Error(`TRACE_PROVENANCE=MISSING case=${caseId}`);
    if (matches.length !== 1)
      throw new Error(
        `TRACE_PROVENANCE=AMBIGUOUS case=${caseId} count=${matches.length}`,
      );
    const trace = matches[0];
    return {
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
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (!Array.isArray(report.cases))
    throw new Error('runner report must contain cases');
  const conversationIds = report.cases.map((item) => item.conversationId);
  if (new Set(conversationIds).size !== conversationIds.length)
    throw new Error('runner report contains duplicate conversation IDs');
  const { PrismaClient } = require('@prisma/ai-client');
  const prisma = new PrismaClient();
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
    const rows = buildTraceRows(report.cases, traces);
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
        PRIVATE_EVIDENCE_TEXT_EXPORTED: 'NO',
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = { buildTraceRows, sanitize };
