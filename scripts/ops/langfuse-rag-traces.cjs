'use strict';

function createLangfuseClient(env = process.env) {
  if (
    !env.LANGFUSE_PUBLIC_KEY ||
    !env.LANGFUSE_SECRET_KEY ||
    !env.LANGFUSE_BASE_URL
  )
    throw new Error(
      'Langfuse trace reads require LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL',
    );
  const { LangfuseClient } = require('@langfuse/client');
  return new LangfuseClient({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASE_URL,
  });
}

function monitoringSnapshot(observation) {
  let output = observation.output;
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output);
    } catch {
      output = null;
    }
  }
  const snapshot = output?.ragTrace;
  if (
    output?.schemaVersion !== 'rag-monitoring-v1' ||
    !snapshot ||
    !observation.traceId ||
    !observation.endTime ||
    !snapshot.conversationId ||
    snapshot.conversationId !== observation.sessionId ||
    !Array.isArray(snapshot.retrievedChunkIds) ||
    !Array.isArray(snapshot.rerankedChunkIds) ||
    !snapshot.workflowMetrics?.diagnostics?.productionExecutionId ||
    snapshot.workflowMetrics.diagnostics.langfuseTraceId !== observation.traceId
  )
    throw new Error(
      `TRACE_PROVENANCE=INCOMPLETE observation=${observation.id}`,
    );
  return {
    ...snapshot,
    id: observation.traceId,
    observationId: observation.id,
    createdAt: new Date(observation.startTime),
  };
}

/** Read completed workflow roots through the Langfuse v2 observations API. */
async function loadObservations(client, name, decode, filters = {}) {
  const traces = [];
  const cursors = new Set();
  const ids = new Set();
  let cursor;
  do {
    const page = await client.api.observations.getMany({
      ...filters,
      name,
      fields: 'basic,time,io',
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page.data) || !page.meta)
      throw new Error('TRACE_PROVENANCE=INCOMPLETE invalid Langfuse page');
    for (const observation of page.data) {
      if (ids.has(observation.id))
        throw new Error(
          'TRACE_PROVENANCE=AMBIGUOUS repeated Langfuse observation',
        );
      ids.add(observation.id);
      traces.push(decode(observation));
    }
    cursor = page.meta.cursor;
    if (cursor && cursors.has(cursor))
      throw new Error('TRACE_PROVENANCE=INCOMPLETE repeated Langfuse cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return traces;
}

function loadLangfuseRagTraces(client, filters = {}) {
  return loadObservations(client, 'rag.workflow', monitoringSnapshot, filters);
}

function hierarchyShadowSnapshot(observation) {
  let output = observation.output;
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output);
    } catch {
      output = null;
    }
  }
  if (
    output?.schemaVersion !== 'rag-hierarchy-shadow-v1' ||
    !observation.traceId ||
    !observation.endTime ||
    !output.conversationId ||
    output.conversationId !== observation.sessionId ||
    !Number.isFinite(new Date(observation.startTime).getTime()) ||
    !['directMs', 'hierarchicalMs', 'overlapAtK', 'jaccard'].every(
      (key) => Number.isFinite(output[key]) && output[key] >= 0,
    ) ||
    output.overlapAtK > 1 ||
    output.jaccard > 1
  )
    throw new Error(
      `TRACE_PROVENANCE=INCOMPLETE hierarchy observation=${observation.id}`,
    );
  return {
    id: observation.id,
    traceId: observation.traceId,
    conversationId: output.conversationId,
    queryText:
      typeof output.query === 'string' && output.query !== '[REDACTED]'
        ? output.query
        : undefined,
    retrievalMode: output.retrievalMode,
    requiredEvidence: output.requiredEvidence,
    directChunkIds: output.directChunkIds,
    hierarchicalChunkIds: output.hierarchicalChunkIds,
    directMs: output.directMs,
    hierarchicalMs: output.hierarchicalMs,
    overlapAtK: output.overlapAtK,
    jaccard: output.jaccard,
    createdAt: new Date(observation.startTime),
  };
}

function loadLangfuseHierarchyShadowObservations(client, filters = {}) {
  return loadObservations(
    client,
    'rag.hierarchy-shadow',
    hierarchyShadowSnapshot,
    filters,
  );
}

async function loadSessionTraces(client, sessionIds) {
  const traces = [];
  const toStartTime = new Date().toISOString();
  for (const sessionId of sessionIds) {
    traces.push(
      ...(await loadLangfuseRagTraces(client, { sessionId, toStartTime })),
    );
  }
  return traces;
}

module.exports = {
  loadSessionTraces,
  createLangfuseClient,
  loadLangfuseRagTraces,
  monitoringSnapshot,
  hierarchyShadowSnapshot,
  loadLangfuseHierarchyShadowObservations,
};
