'use strict';

const QUALITY_TARGETS = Object.freeze({
  recallAt5Overall: 0.9,
  recallAt5KeyBuckets: 0.85,
  citationRecallOverall: 0.85,
  citationRecallKeyBuckets: 0.85,
  citationRecallCombined: 0.8,
  citationRecallMultiReel: 0.9,
  evidenceCoverage: 0.9,
  evidenceCaptureCoverage: 0.9,
  exactAnswer: 0.9,
  primaryExecutionHealth: 0.9,
  clarificationPassRate: 1,
  faithfulness: 0.97,
  factualCorrectness: 0.85,
  responseRelevancy: 0.85,
  keyBucketSemantic: 0.8,
  semanticCoverage: 0.9,
  pairedRegressionTolerance: 0.03,
  minimumPairedCases: 10,
});

function asksForClarification(answer) {
  const text = String(answer || '').trim();
  const asksToDisambiguate =
    /\bwhich(?:\s+one)?\b|\bcan you clarify\b|\bplease (?:identify|specify|choose)\b|\blequel(?:le)?\b|\bcu[aá]l\b|\b(?:đoạn|video|clip|reel) nào\b/iu.test(
      text,
    );
  const refersToMedia =
    /\b(?:clip|reel|video|recording|episode|one|it|this|that)\b|(?:đoạn|video|clip|reel)\b|(?:vidéo|séquence|épisode)\b/iu.test(
      text,
    );
  return asksToDisambiguate && refersToMedia;
}

function evaluateClarificationPolicy(rows, responsesById) {
  const cases = rows
    .filter((row) => row.metadata?.answerType === 'CLARIFICATION')
    .map((row) => ({
      caseId: row.id,
      pass: asksForClarification(responsesById.get(row.id)?.output?.answer),
    }));
  const passed = cases.filter((entry) => entry.pass).length;
  return {
    cases: cases.length,
    passed,
    failed: cases.length - passed,
    passRate: cases.length ? passed / cases.length : null,
    caseResults: cases,
  };
}

function buildQualityGate({
  candidateSummary,
  candidateSemantic,
  baselineDetails = [],
  candidateDetails = [],
}) {
  const checks = [];
  const metricValue = (summary, bucket, metric) => {
    const aggregate =
      !bucket || bucket === 'all'
        ? summary?.all?.[metric]
        : summary?.byBucket?.[bucket]?.[metric];
    return aggregate?.mean ?? null;
  };
  const addCheck = (name, actual, target, direction = 'MIN', extra = {}) => {
    const passed =
      typeof actual === 'number' &&
      (direction === 'MAX' ? actual <= target : actual >= target);
    checks.push({
      name,
      actual,
      target,
      direction,
      status: passed ? 'PASS' : 'BLOCKED',
      ...extra,
    });
  };

  addCheck(
    'retrieval-recall-at-5-overall',
    metricValue(candidateSummary, 'all', 'retrieval_recall_at_5'),
    QUALITY_TARGETS.recallAt5Overall,
  );
  for (const bucket of ['TRANSCRIPT', 'VISUAL', 'COMBINED', 'MULTI_REEL']) {
    addCheck(
      'retrieval-recall-at-5-' + bucket.toLowerCase(),
      metricValue(candidateSummary, bucket, 'retrieval_recall_at_5'),
      QUALITY_TARGETS.recallAt5KeyBuckets,
    );
  }
  addCheck(
    'citation-source-recall-overall',
    metricValue(candidateSummary, 'all', 'citationSourceRecall'),
    QUALITY_TARGETS.citationRecallOverall,
  );
  for (const bucket of ['TRANSCRIPT', 'VISUAL']) {
    addCheck(
      'citation-source-recall-' + bucket.toLowerCase(),
      metricValue(candidateSummary, bucket, 'citationSourceRecall'),
      QUALITY_TARGETS.citationRecallKeyBuckets,
    );
  }
  addCheck(
    'citation-source-recall-combined',
    metricValue(candidateSummary, 'COMBINED', 'citationSourceRecall'),
    QUALITY_TARGETS.citationRecallCombined,
  );
  addCheck(
    'citation-source-recall-multi-reel',
    metricValue(candidateSummary, 'MULTI_REEL', 'citationSourceRecall'),
    QUALITY_TARGETS.citationRecallMultiReel,
  );
  addCheck(
    'generation-evidence-coverage',
    metricValue(candidateSummary, 'all', 'generationEvidenceCoverage'),
    QUALITY_TARGETS.evidenceCoverage,
  );
  addCheck(
    'generation-evidence-capture-coverage',
    metricValue(candidateSummary, 'all', 'generationEvidenceCaptureCoverage'),
    QUALITY_TARGETS.evidenceCaptureCoverage,
  );
  addCheck(
    'exact-answer-match',
    metricValue(candidateSummary, 'all', 'exactMatch'),
    QUALITY_TARGETS.exactAnswer,
  );
  addCheck(
    'structured-actions-and-recommendation-prose',
    candidateSummary.structuredActions?.failed === undefined
      ? null
      : Number(candidateSummary.structuredActions.failed === 0),
    1,
  );
  const executionCases = candidateSummary.cases;
  const availableExecutions = candidateSummary.executionHealth?.AVAILABLE;
  addCheck(
    'primary-execution-health',
    typeof executionCases === 'number' &&
      executionCases > 0 &&
      typeof availableExecutions === 'number'
      ? availableExecutions / executionCases
      : null,
    QUALITY_TARGETS.primaryExecutionHealth,
  );
  const clarification = candidateSummary.policyOutcomes?.clarification;
  if (clarification?.cases > 0) {
    addCheck(
      'clarification-policy',
      clarification.passRate ?? null,
      QUALITY_TARGETS.clarificationPassRate,
    );
  }

  const semanticOverall = candidateSemantic?.all || {};
  const semanticByBucket = candidateSemantic?.byBucket || {};
  addCheck(
    'faithfulness-overall',
    semanticOverall.faithfulness?.mean ?? null,
    QUALITY_TARGETS.faithfulness,
  );
  for (const [dimension, target] of [
    ['factualCorrectness', QUALITY_TARGETS.factualCorrectness],
    ['responseRelevancy', QUALITY_TARGETS.responseRelevancy],
  ]) {
    addCheck(
      dimension + '-overall',
      semanticOverall[dimension]?.mean ?? null,
      target,
    );
    for (const bucket of ['TRANSCRIPT', 'COMBINED', 'MULTI_REEL']) {
      addCheck(
        dimension + '-' + bucket.toLowerCase(),
        semanticByBucket[bucket]?.[dimension]?.mean ?? null,
        QUALITY_TARGETS.keyBucketSemantic,
      );
    }
  }
  for (const [bucket, dimensions] of Object.entries(semanticByBucket)) {
    for (const [dimension, aggregate] of Object.entries(dimensions)) {
      if (!(aggregate.applicable > 0)) continue;
      addCheck(
        'semantic-coverage-' + bucket.toLowerCase() + '-' + dimension,
        aggregate.coverageWithinApplicable ?? null,
        QUALITY_TARGETS.semanticCoverage,
      );
    }
  }

  const candidateById = new Map(
    candidateDetails.map((detail) => [detail.caseId, detail]),
  );
  for (const bucket of [
    null,
    'TRANSCRIPT',
    'VISUAL',
    'COMBINED',
    'MULTI_REEL',
  ]) {
    for (const metric of [
      'retrieval_recall_at_5',
      'citationSourceRecall',
      'generationEvidenceCoverage',
      'generationEvidenceCaptureCoverage',
    ]) {
      const deltas = baselineDetails.flatMap((baselineDetail) => {
        const candidateDetail = candidateById.get(baselineDetail.caseId);
        if (
          !candidateDetail ||
          (bucket && baselineDetail.bucket !== bucket) ||
          (bucket && candidateDetail.bucket !== bucket) ||
          typeof baselineDetail[metric] !== 'number' ||
          typeof candidateDetail[metric] !== 'number'
        )
          return [];
        return [candidateDetail[metric] - baselineDetail[metric]];
      });
      const meanDelta = deltas.length
        ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
        : null;
      const variance =
        deltas.length > 1
          ? deltas.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) /
            (deltas.length - 1)
          : null;
      const margin95 =
        variance === null ? null : 1.96 * Math.sqrt(variance / deltas.length);
      const enoughMatchedCases =
        deltas.length >= QUALITY_TARGETS.minimumPairedCases;
      const passed =
        enoughMatchedCases &&
        meanDelta >= -QUALITY_TARGETS.pairedRegressionTolerance;
      checks.push({
        name:
          'paired-regression-' +
          (bucket?.toLowerCase() || 'all') +
          '-' +
          metric,
        actual: enoughMatchedCases ? meanDelta : null,
        target: -QUALITY_TARGETS.pairedRegressionTolerance,
        direction: 'MIN',
        matchedCases: deltas.length,
        confidenceInterval95:
          margin95 === null
            ? null
            : {
                lower: meanDelta - margin95,
                upper: meanDelta + margin95,
              },
        status: passed ? 'PASS' : 'BLOCKED',
      });
    }
  }

  const blockedChecks = checks
    .filter((check) => check.status !== 'PASS')
    .map((check) => check.name);
  return {
    status: blockedChecks.length ? 'BLOCKED' : 'PASS',
    targets: QUALITY_TARGETS,
    checks,
    blockedChecks,
  };
}

module.exports = {
  QUALITY_TARGETS,
  asksForClarification,
  buildQualityGate,
  evaluateClarificationPolicy,
};
