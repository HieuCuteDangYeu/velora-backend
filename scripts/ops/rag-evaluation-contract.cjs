'use strict';

const crypto = require('node:crypto');
const EVALUATOR_VERSION = 'velora-rag-evaluation-v2';
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const fingerprint = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

function retrievalMetrics(expected, ranked) {
  if (!Array.isArray(ranked) || !expected.length) return null;
  const relevant = new Set(expected);
  const ids = [...new Set(ranked)];
  const result = {};
  for (const k of [5, 10]) {
    const hits = ids.slice(0, k).map((id) => (relevant.has(id) ? 1 : 0));
    result[`retrieval_recall_at_${k}`] =
      hits.reduce((a, b) => a + b, 0) / relevant.size;
    const dcg = hits.reduce((sum, hit, i) => sum + hit / Math.log2(i + 2), 0);
    const ideal = Array.from(
      { length: Math.min(relevant.size, k) },
      (_, i) => 1 / Math.log2(i + 2),
    ).reduce((a, b) => a + b, 0);
    result[`retrieval_ndcg_at_${k}`] = dcg / ideal;
  }
  const first = ids.findIndex((id) => relevant.has(id));
  result.retrieval_mrr = first < 0 ? 0 : 1 / (first + 1);
  return result;
}

function strictEvaluations(input, expectedOutput, output) {
  const expectedIds = expectedOutput?.evidenceIds ?? input?.evidenceIds ?? [];
  const citations = output?.citations ?? [];
  const modality = expectedOutput?.modality ?? input?.modality;
  const values = {
    citation_modality_precision: citations.length
      ? citations.filter((c) => c.evidenceType === modality).length /
        citations.length
      : 0,
  };
  // A Reel-only public citation is not proof that a particular chunk was retrieved.
  if (
    citations.length === 0 ||
    citations.every((c) => typeof c.evidenceId === 'string')
  ) {
    const ids = new Set(
      citations
        .filter((c) => c.evidenceType === modality)
        .map((c) => c.evidenceId),
    );
    if (expectedIds.length)
      values.citation_source_recall =
        expectedIds.filter((id) => ids.has(id)).length / expectedIds.length;
  }
  Object.assign(
    values,
    retrievalMetrics(expectedIds, output?.retrievedEvidenceIds),
  );
  if (Array.isArray(output?.generationEvidence)) {
    const supplied = new Set(
      output.generationEvidence
        .filter((item) => item.evidenceType === modality)
        .map((item) => item.sourceId),
    );
    if (expectedIds.length)
      values.generation_evidence_coverage =
        expectedIds.filter((id) => supplied.has(id)).length /
        expectedIds.length;
  }
  return Object.entries(values).map(([name, value]) => ({
    name,
    value,
    dataType: 'NUMERIC',
  }));
}

function attachTrace(output, trace, conversationId) {
  if (trace.conversationId !== conversationId)
    throw new Error('Trace conversation identity mismatch');
  const diagnostics = trace.workflowMetrics?.diagnostics ?? {};
  if (!diagnostics.productionExecutionId)
    throw new Error('Trace execution provenance is missing');
  if (
    typeof trace.answer === 'string' &&
    trace.answer.trim() !== output.answer.trim()
  )
    throw new Error('Trace answer does not match saved output');
  if (Array.isArray(trace.citations)) {
    if (
      trace.citations.length !== (output.citations ?? []).length ||
      trace.citations.some(
        (citation, index) =>
          citation.reelId !== output.citations[index].reelId ||
          citation.evidenceType !== output.citations[index].evidenceType,
      )
    )
      throw new Error('Trace citation identity mismatch');
  }
  return {
    ...output,
    citations: (output.citations ?? []).map((citation, index) => ({
      ...citation,
      evidenceId: trace.workflowMetrics?.citationEvidenceMappings?.find(
        (mapping) => mapping.citationIndex === index,
      )?.evidenceId,
    })),
    ragTraceId: trace.id ?? trace.traceId,
    traceId: diagnostics.langfuseTraceId,
    productionExecutionId: diagnostics.productionExecutionId,
    retrievedEvidenceIds: trace.retrievedChunkIds,
    rerankedEvidenceIds: trace.rerankedChunkIds,
    ...(diagnostics.evaluationCapture?.contextCaptured &&
    Array.isArray(diagnostics.generationEvidence)
      ? { generationEvidence: diagnostics.generationEvidence }
      : {}),
    release: diagnostics.evaluationCapture?.release,
  };
}

function verifyDataset(state, items) {
  const shaped = [...items].sort((a, b) => a.id.localeCompare(b.id));
  if (state.snapshotFingerprint) {
    if (fingerprint(shaped) !== state.snapshotFingerprint)
      throw new Error('Frozen dataset identity mismatch');
  } else if (state.datasetFingerprint) {
    const candidates = [
      shaped.map(({ id, input, expectedOutput }) => ({
        id,
        input,
        expectedOutput,
      })),
      shaped.map(({ id, input, expectedOutput }) => ({
        id,
        input: {
          reelIds: input.reelIds,
          modality: input.modality,
          question: input.question,
          evidenceIds: input.evidenceIds,
        },
        expectedOutput: {
          answer: expectedOutput.answer,
          reelIds: expectedOutput.reelIds,
          modality: expectedOutput.modality,
          evidenceIds: expectedOutput.evidenceIds,
        },
      })),
    ];
    if (
      !candidates.some(
        (candidate) =>
          crypto
            .createHash('sha256')
            .update(JSON.stringify(candidate))
            .digest('hex') === state.datasetFingerprint,
      )
    )
      throw new Error('Legacy dataset identity mismatch');
  }
  if (
    state.itemIds &&
    JSON.stringify(shaped.map((item) => item.id)) !==
      JSON.stringify(state.itemIds)
  )
    throw new Error('Dataset item identity mismatch');
}

module.exports = {
  verifyDataset,
  EVALUATOR_VERSION,
  canonical,
  fingerprint,
  retrievalMetrics,
  strictEvaluations,
  attachTrace,
};
