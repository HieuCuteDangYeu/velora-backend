'use strict';

const crypto = require('node:crypto');
const EVALUATOR_VERSION = 'velora-rag-evaluation-v7';
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

function normalizeEvidenceGroups(expected) {
  if (!Array.isArray(expected) || expected.length === 0) return [];
  if (expected.every((item) => typeof item === 'string'))
    return expected.map((id) => [id]);
  if (!expected.every(Array.isArray))
    throw new Error('Expected evidence must be IDs or alternative-ID groups');
  return expected.map((group) => {
    if (
      group.length === 0 ||
      !group.every((id) => typeof id === 'string' && id.length > 0)
    )
      throw new Error('Evidence alternative groups must contain source IDs');
    return [...new Set(group)];
  });
}

function evidenceGroupCoverage(expected, observed) {
  const groups = normalizeEvidenceGroups(expected);
  if (groups.length === 0) return null;
  const observedIds = observed instanceof Set ? observed : new Set(observed);
  const covered = groups.filter((group) =>
    group.some((id) => observedIds.has(id)),
  ).length;
  return { score: covered / groups.length, covered, required: groups.length };
}

function retrievalMetrics(expected, ranked) {
  const groups = normalizeEvidenceGroups(expected);
  if (!Array.isArray(ranked) || groups.length === 0) return null;
  const groupById = new Map();
  groups.forEach((group, index) => {
    for (const id of group) groupById.set(id, index);
  });
  const ids = [...new Set(ranked)];
  const seenGroups = new Set();
  const hits = ids.map((id) => {
    const group = groupById.get(id);
    if (group === undefined || seenGroups.has(group)) return 0;
    seenGroups.add(group);
    return 1;
  });
  const result = {};
  for (const k of [5, 10]) {
    result[`retrieval_recall_at_${k}`] =
      hits.slice(0, k).reduce((a, b) => a + b, 0) / groups.length;
    const dcg = hits
      .slice(0, k)
      .reduce((sum, hit, i) => sum + hit / Math.log2(i + 2), 0);
    const ideal = Array.from(
      { length: Math.min(groups.length, k) },
      (_, i) => 1 / Math.log2(i + 2),
    ).reduce((a, b) => a + b, 0);
    result[`retrieval_ndcg_at_${k}`] = dcg / ideal;
  }
  const first = hits.findIndex((hit) => hit === 1);
  result.retrieval_mrr = first < 0 ? 0 : 1 / (first + 1);
  return result;
}

function strictEvaluations(input, expectedOutput, output) {
  const expectedIds = expectedOutput?.evidenceIds ?? input?.evidenceIds ?? [];
  const allExpectedGroups = normalizeEvidenceGroups(
    expectedOutput?.relevantEvidenceGroups ?? expectedIds,
  );
  const citations = output?.citations ?? [];
  const modality = expectedOutput?.modality ?? input?.modality;
  const expectedEvidenceTypes = expectedOutput?.expectedEvidenceTypes;
  const expectedTypeByEvidenceId = new Map();
  if (
    Array.isArray(expectedEvidenceTypes) &&
    expectedEvidenceTypes.length === allExpectedGroups.length
  ) {
    allExpectedGroups.forEach((group, index) => {
      for (const id of group)
        expectedTypeByEvidenceId.set(id, expectedEvidenceTypes[index]);
    });
  }
  const expectedModalities = new Set(
    expectedEvidenceTypes?.length
      ? expectedEvidenceTypes
      : modality
        ? [modality]
        : [],
  );
  const citationHasExpectedModality = (citation) => {
    if (expectedTypeByEvidenceId.has(citation?.evidenceId))
      return (
        expectedTypeByEvidenceId.get(citation.evidenceId) ===
        citation.evidenceType
      );
    return (
      expectedModalities.size > 0 &&
      expectedModalities.has(citation?.evidenceType)
    );
  };
  const modalityGroups =
    modality &&
    Array.isArray(expectedEvidenceTypes) &&
    expectedEvidenceTypes.length === allExpectedGroups.length
      ? allExpectedGroups.filter(
          (_group, index) => expectedEvidenceTypes[index] === modality,
        )
      : allExpectedGroups;
  const values = {
    citation_modality_precision: citations.length
      ? citations.filter(citationHasExpectedModality).length /
        citations.length
      : allExpectedGroups.length === 0
        ? 1
        : 0,
  };
  // A Reel-only public citation is not proof that a particular chunk was retrieved.
  if (
    citations.length === 0 ||
    citations.every((c) => typeof c.evidenceId === 'string')
  ) {
    const ids = new Set(
      citations
        .filter(citationHasExpectedModality)
        .map((c) => c.evidenceId),
    );
    if (modalityGroups.length)
      values.citation_source_recall = evidenceGroupCoverage(
        modalityGroups,
        ids,
      ).score;
  }
  Object.assign(
    values,
    retrievalMetrics(allExpectedGroups, output?.retrievedEvidenceIds),
  );
  if (Array.isArray(output?.generationEvidence)) {
    const supplied = new Set(
      output.generationEvidence
        .filter(citationHasExpectedModality)
        .map((item) => item.sourceId),
    );
    if (modalityGroups.length)
      values.generation_evidence_coverage = evidenceGroupCoverage(
        modalityGroups,
        supplied,
      ).score;
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
    workflowLatencyMs: Number.isFinite(trace.latencyMs) ? trace.latencyMs : null,
    nodeTimings: trace.nodeTimings ?? {},
    retrievedEvidenceIds: trace.retrievedChunkIds,
    rerankedEvidenceIds: trace.rerankedChunkIds,
    ...(diagnostics.evaluationCapture?.contextCaptured &&
    Array.isArray(diagnostics.generationEvidence)
      ? { generationEvidence: diagnostics.generationEvidence }
      : {}),
    release: diagnostics.evaluationCapture?.release,
    executionHealth: executionHealth(diagnostics),
  };
}

function executionHealth(diagnostics) {
  const failedStages = [];
  for (const stage of [
    'route',
    'retrievalPlan',
    'contextToolExecution',
    'contextSufficiency',
    'verification',
    'citationDiagnostics',
  ]) {
    if (diagnostics?.[stage]?.providerStatus === 'ERROR')
      failedStages.push(stage);
  }
  const answer = diagnostics?.answerCalls?.at(-1);
  if (
    answer &&
    (answer.errorCode ||
      answer.providerStatus === 'TIMEOUT' ||
      (typeof answer.providerStatus === 'number' &&
        answer.providerStatus >= 400))
  ) {
    failedStages.push('answer');
  }
  if (
    diagnostics?.finalFailureSource === 'PROVIDER_ERROR' ||
    diagnostics?.finalFailureSource === 'WORKFLOW'
  )
    failedStages.push('workflow');

  const route = diagnostics?.route;
  const routeDecision = diagnostics?.routeDecision;
  const contextSufficiency = diagnostics?.contextSufficiency;
  const structuralRoute =
    route?.providerStatus === 'NOT_CALLED' &&
    route?.decisionSource === 'STRUCTURAL' &&
    Boolean(routeDecision);
  const deterministicRefusal =
    diagnostics?.finalFailureSource === 'NO_CONTEXT' &&
    contextSufficiency?.sufficient === false &&
    [
      'DETERMINISTIC_NO_CONTEXT',
      'DETERMINISTIC_REQUIRED_MODALITY',
      'DETERMINISTIC_REQUIRED_TOOL',
    ].includes(contextSufficiency?.decisionSource);
  const routeAvailable = route?.providerStatus === 'SUCCESS' || structuralRoute;
  const requiredTools = routeDecision?.toolPlan?.requiredTools ?? [];
  const contextAvailable = !routeDecision?.needsRetrieval
    ? requiredTools.length === 0 ||
      (diagnostics?.contextToolExecution?.providerStatus === 'SUCCESS' &&
        (contextSufficiency?.providerStatus === 'SUCCESS' ||
          deterministicRefusal))
    : contextSufficiency?.providerStatus === 'SUCCESS' || deterministicRefusal;
  const verificationAvailable =
    !routeDecision?.needsVerification ||
    diagnostics?.verification?.providerStatus === 'SUCCESS' ||
    deterministicRefusal ||
    structuralRoute;
  return {
    status: failedStages.length
      ? 'DEGRADED'
      : routeAvailable &&
          routeDecision &&
          contextAvailable &&
          verificationAvailable
        ? 'AVAILABLE'
        : 'UNKNOWN',
    failedStages,
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
  normalizeEvidenceGroups,
  evidenceGroupCoverage,
  strictEvaluations,
  attachTrace,
  executionHealth,
};
