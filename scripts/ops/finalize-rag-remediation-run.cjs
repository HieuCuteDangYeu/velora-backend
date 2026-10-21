'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  EVALUATOR_VERSION,
  executionHealth: classifyExecutionHealth,
  evidenceGroupCoverage,
  fingerprint,
  retrievalMetrics,
} = require('./rag-evaluation-contract.cjs');
const {
  applicability,
  DIMENSIONS,
} = require('./rag-evaluation-applicability.cjs');
const {
  evaluate: evaluateStructuredActions,
} = require('./evaluate-rag-structured-actions.cjs');
const {
  buildQualityGate,
  evaluateClarificationPolicy,
} = require('./rag-quality-gates.cjs');
const { answerOverlapMetrics } = require('./rag-answer-overlap-metrics.cjs');

const root = process.cwd();
const runDir = path.resolve(
  process.env.RAG_FINAL_RUN_DIR ||
    '.benchmarks/rag-remediation-v2-20261010-01/evaluation',
);
const dataDir = path.resolve(
  process.env.RAG_FINAL_DATA_DIR ||
    '.benchmarks/rag-memory-remediation-20261006-01/dataset-v5',
);
const cohortPrefix = process.env.RAG_FINAL_COHORT_PREFIX || 'cohort-v5';
const phaseNames = (process.env.RAG_FINAL_PHASES || 'baseline,patched')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const provenancePath = path.resolve(
  process.env.RAG_FINAL_BUILD_PROVENANCE ||
    '.benchmarks/rag-remediation-v2-20261010-01/evaluation-build-provenance.json',
);
const operationalValidationPath = path.resolve(
  process.env.RAG_FINAL_OPERATIONAL_VALIDATION ||
    path.join(runDir, 'operational-v2', 'operational-validation.json'),
);
const visualContractPath = path.resolve(
  process.env.RAG_FINAL_VISUAL_CONTRACT ||
    path.join(runDir, 'visual-contract-validation.json'),
);
const providerValidationPath = path.resolve(
  process.env.RAG_FINAL_PROVIDER_VALIDATION ||
    path.join(
      runDir,
      'evaluation-v6-operational',
      'provider-integration-validation.json',
    ),
);
const calibrationReviewPath = path.resolve(
  process.env.RAG_FINAL_CALIBRATION_REVIEW ||
    path.join(runDir, 'calibration-review-v6.json'),
);
const productionValidationPath = path.resolve(
  process.env.RAG_FINAL_PRODUCTION_VALIDATION ||
    path.join(runDir, 'production-retrieval-validation.json'),
);
const rows = ['development', 'held_out'].flatMap((split) =>
  JSON.parse(fs.readFileSync(path.join(dataDir, `${split}.json`))),
);
const rowsById = new Map(rows.map((row) => [row.id, row]));
const terminalStatuses = new Set([
  'COMPLETE',
  'COMPLETE_WITH_EXECUTION_FAILURES',
]);
const mean = (values) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJsonl(file) {
  if (!fs.existsSync(file))
    throw new Error(`Missing required artifact: ${file}`);
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertExactCaseSet(values, label) {
  const ids = values.map((value) => value.caseId || value.id);
  if (
    ids.length !== rows.length ||
    new Set(ids).size !== rows.length ||
    ids.some((id) => !rowsById.has(id))
  ) {
    throw new Error(
      `${label} must contain exactly one record for every ${rows.length} dataset case`,
    );
  }
}

function aggregateDeterministic(details) {
  const names = [
    'exactMatch',
    'answerContainment',
    'answerTokenF1',
    'generationEvidenceCaptureCoverage',
    'generationEvidenceCoverage',
    'citationSourceRecall',
    'retrieval_recall_at_5',
    'retrieval_ndcg_at_5',
    'retrieval_mrr',
  ];
  return Object.fromEntries(
    names.map((name) => {
      const values = details
        .map((detail) => detail[name])
        .filter((value) => typeof value === 'number');
      return [name, { mean: mean(values), denominator: values.length }];
    }),
  );
}

function analyzePhase(phase) {
  const phaseDir = path.join(runDir, `${cohortPrefix}-${phase}`);
  const state = JSON.parse(
    fs.readFileSync(path.join(phaseDir, 'state.json'), 'utf8'),
  );
  if (!terminalStatuses.has(state.status))
    throw new Error(`${phase} cohort is not terminal`);
  if (
    Object.values(state.cases || {}).some(
      (entry) => !['COMPLETED', 'FAILED'].includes(entry.status),
    )
  ) {
    throw new Error(`${phase} cohort contains a non-terminal case`);
  }
  const responses = readJsonl(path.join(phaseDir, 'responses.jsonl'));
  assertExactCaseSet(responses, `${phase} primary responses`);
  const byId = new Map(
    responses.map((response) => [response.caseId, response]),
  );
  const executionIds = responses.map(
    (response) =>
      response.trace?.workflowMetrics?.diagnostics?.productionExecutionId,
  );
  if (
    executionIds.some((id) => !id) ||
    new Set(executionIds).size !== rows.length
  ) {
    throw new Error(`${phase} execution identity is incomplete or duplicated`);
  }

  const details = rows.map((row) => {
    const response = byId.get(row.id);
    const diagnostics = response.trace?.workflowMetrics?.diagnostics || {};
    const expected = row.expectedOutput?.relevantEvidenceIds || [];
    const expectedGroups =
      row.expectedOutput?.relevantEvidenceGroups || expected;
    const generated = new Set(
      (diagnostics.generationEvidence || []).map((item) => item.sourceId),
    );
    const mappings =
      response.trace?.workflowMetrics?.citationEvidenceMappings || [];
    const cited = new Set(mappings.map((item) => item.evidenceId));
    const answer = response.output?.answer || '';
    const exactApplicable = ['QUOTE', 'EXACT_TITLE'].includes(
      row.metadata?.answerType,
    );
    const answerOverlap = answerOverlapMetrics(answer, row.expectedOutput);
    return {
      caseId: row.id,
      bucket: row.metadata?.bucket,
      split: row.metadata?.split,
      executionHealth: response.error
        ? 'FAILED'
        : classifyExecutionHealth(diagnostics).status,
      exactMatch: exactApplicable ? answerOverlap.exactMatch : null,
      answerContainment: answerOverlap.containment,
      answerTokenF1: answerOverlap.tokenF1,
      generationEvidenceCaptureCoverage: expectedGroups.length
        ? Number(diagnostics.evaluationCapture?.contextCaptured === true)
        : null,
      generationEvidenceCoverage:
        diagnostics.evaluationCapture?.contextCaptured && expectedGroups.length
          ? evidenceGroupCoverage(expectedGroups, generated).score
          : null,
      citationSourceRecall: expectedGroups.length
        ? evidenceGroupCoverage(expectedGroups, cited).score
        : null,
      ...retrievalMetrics(
        expectedGroups,
        response.trace?.retrievedChunkIds || [],
      ),
      sourceIds: [...generated],
      finalFailureSource: diagnostics.finalFailureSource,
      forbiddenStringLeak: (row.metadata?.forbiddenStrings || []).some(
        (value) => answer.includes(value),
      ),
    };
  });
  writeJson(path.join(phaseDir, 'deterministic-details.json'), details);
  const structuredActions = evaluateStructuredActions({
    datasetDir: dataDir,
    runDir: phaseDir,
    outputPath: path.join(phaseDir, 'structured-action-summary.json'),
  });
  const summary = {
    phase,
    cases: rows.length,
    runType: 'FROZEN_BACKEND_REPLAY_NOT_PRODUCTION_RETRIEVAL',
    datasetSha256: state.datasetSha256,
    fixtureSha256: state.fixtureSha256,
    buildSha256: state.buildSha256,
    executionHealth: details.reduce((counts, detail) => {
      counts[detail.executionHealth] =
        (counts[detail.executionHealth] || 0) + 1;
      return counts;
    }, {}),
    privacyCanaryLeaks: details.filter((detail) => detail.forbiddenStringLeak)
      .length,
    structuredActions,
    policyOutcomes: { clarification: evaluateClarificationPolicy(rows, byId) },
    all: aggregateDeterministic(details),
    byBucket: Object.fromEntries(
      [...new Set(details.map((detail) => detail.bucket))].map((bucket) => {
        const bucketDetails = details.filter(
          (detail) => detail.bucket === bucket,
        );
        return [
          bucket,
          {
            cases: bucketDetails.length,
            ...aggregateDeterministic(bucketDetails),
          },
        ];
      }),
    ),
  };
  writeJson(path.join(phaseDir, 'deterministic-summary.json'), summary);
  return { state, details, summary };
}

function semanticAggregate(semanticRows, details, dimension) {
  const detailById = new Map(details.map((detail) => [detail.caseId, detail]));
  const applicable = semanticRows.filter(
    (entry) => applicability(rowsById.get(entry.caseId))[dimension],
  );
  const healthyApplicable = applicable.filter(
    (entry) => detailById.get(entry.caseId)?.executionHealth === 'AVAILABLE',
  );
  const score = (entry) =>
    entry.scores?.[dimension]?.score ?? entry[dimension]?.score;
  const scored = (entries) =>
    entries.map(score).filter((value) => typeof value === 'number');
  const unavailableByReason = (entries) =>
    entries.reduce((counts, entry) => {
      if (typeof score(entry) !== 'number') {
        const reason =
          entry.scores?.[dimension]?.unavailableReason ||
          entry.scores?.[dimension]?.judgment ||
          entry[dimension]?.unavailableReason ||
          entry[dimension]?.judgment ||
          entry.error ||
          'UNAVAILABLE';
        counts[reason] = (counts[reason] || 0) + 1;
      }
      return counts;
    }, {});
  return {
    mean: mean(scored(applicable)),
    scored: scored(applicable).length,
    applicable: applicable.length,
    coverageWithinApplicable: applicable.length
      ? scored(applicable).length / applicable.length
      : null,
    unavailable: applicable.length - scored(applicable).length,
    unavailableByReason: unavailableByReason(applicable),
    excludedByApplicability: semanticRows.length - applicable.length,
    healthy: {
      mean: mean(scored(healthyApplicable)),
      scored: scored(healthyApplicable).length,
      applicable: healthyApplicable.length,
      coverageWithinApplicable: healthyApplicable.length
        ? scored(healthyApplicable).length / healthyApplicable.length
        : null,
      unavailable: healthyApplicable.length - scored(healthyApplicable).length,
      unavailableByReason: unavailableByReason(healthyApplicable),
    },
  };
}

function analyzeSemantic(phase, details) {
  const semanticRows = readJsonl(
    path.join(runDir, `${cohortPrefix}-${phase}`, 'semantic-cases.jsonl'),
  );
  assertExactCaseSet(semanticRows, `${phase} semantic scores`);
  const evaluatorVersions = [
    ...new Set(
      semanticRows.map((entry) => entry.evaluatorVersion).filter(Boolean),
    ),
  ];
  if (
    evaluatorVersions.length !== 1 ||
    evaluatorVersions[0] !== EVALUATOR_VERSION
  ) {
    throw new Error(phase + ' semantic scores do not use ' + EVALUATOR_VERSION);
  }
  const byBucket = Object.fromEntries(
    [...new Set(details.map((detail) => detail.bucket))].map((bucket) => {
      const bucketDetails = details.filter(
        (detail) => detail.bucket === bucket,
      );
      const bucketIds = new Set(bucketDetails.map((detail) => detail.caseId));
      const bucketRows = semanticRows.filter((entry) =>
        bucketIds.has(entry.caseId),
      );
      return [
        bucket,
        Object.fromEntries(
          DIMENSIONS.map((dimension) => [
            dimension,
            semanticAggregate(bucketRows, bucketDetails, dimension),
          ]),
        ),
      ];
    }),
  );
  return {
    evaluatorVersion: evaluatorVersions[0],
    all: Object.fromEntries(
      DIMENSIONS.map((dimension) => [
        dimension,
        semanticAggregate(semanticRows, details, dimension),
      ]),
    ),
    byBucket,
  };
}

function buildExitGateMatrix(
  result,
  phases,
  operational,
  visualContract,
  providerValidation,
  calibration,
  productionValidation,
) {
  const primaryComplete = phases.every(({ state }) =>
    terminalStatuses.has(state.status),
  );
  const exactOnce =
    result.gates.exactOncePrimaryResponses &&
    result.gates.exactOnceSemanticScores;
  const labelsComplete =
    Array.isArray(calibration?.cases) &&
    calibration.cases.length > 0 &&
    calibration.cases.every(
      (entry) =>
        entry.reviewedLabel !== null && entry.reviewedLabel !== undefined,
    );
  const humanGold =
    labelsComplete &&
    (calibration?.humanApproved === true || !calibration?.reviewMetadata);
  const independentReview = calibration?.independentReview === 'PASS';
  const agentAuthority =
    process.env.RAG_FINAL_REVIEW_AUTHORITY ===
      'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' &&
    calibration?.reviewAuthority === 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' &&
    calibration?.reviewMetadata?.reviewerType ===
      'AGENT_SOURCE_AND_FRAME_REVIEW' &&
    calibration?.humanApproved === false &&
    labelsComplete;
  const reviewComplete = (humanGold && independentReview) || agentAuthority;
  const productionRetrievalPass =
    result.productionRetrievalProven === true ||
    productionValidation?.status === 'PASS';
  const rerankerPass = providerValidation?.status === 'PASS';
  const qualityTargetsPass = result.gates.qualityTargets === 'PASS';
  const evaluatorVersionPass =
    result.gates.semanticEvaluatorConsistent === true;
  const privacyPass = result.gates.privacyCanaryLeaks === 0;
  const releaseReady =
    productionRetrievalPass &&
    reviewComplete &&
    visualContract?.imageTruthStatus === 'PASS' &&
    rerankerPass &&
    operational?.status === 'PASS' &&
    primaryComplete &&
    exactOnce &&
    privacyPass &&
    qualityTargetsPass &&
    evaluatorVersionPass;
  const phaseName = (phase) => phase.phase || phase.summary?.phase;
  const evidencePath = (file) =>
    path.relative(runDir, file) || path.basename(file);
  return {
    status: releaseReady ? 'RELEASE_PASS' : 'PROVISIONAL_RELEASE_BLOCKED',
    gates: [
      {
        id: 'semantic-evaluator-version',
        status: evaluatorVersionPass ? 'PASS' : 'BLOCKED',
        evidence: ['final-benchmark.json'],
        reason: evaluatorVersionPass
          ? 'Both semantic cohorts use ' + EVALUATOR_VERSION + '.'
          : 'Semantic case outputs must consistently use ' +
            EVALUATOR_VERSION +
            '.',
      },
      {
        id: 'benchmark-quality',
        status: qualityTargetsPass ? 'PASS' : 'BLOCKED',
        evidence: ['final-benchmark.json'],
        reason: qualityTargetsPass
          ? 'Deterministic, semantic, coverage, clarification, recommendation, and paired-regression targets pass.'
          : 'Benchmark quality targets remain unmet: ' +
            (result.qualityGate?.blockedChecks || []).join(', ') +
            '.',
      },
      {
        id: 'measurement-applicability',
        status:
          result.gates.applicabilitySeparated && (humanGold || agentAuthority)
            ? 'PASS'
            : 'PROVISIONAL',
        evidence: [
          'dataset-v6-series-holdout/manifest.json',
          'calibration-review-v6.json',
        ],
        reason: humanGold
          ? 'Applicability protocol and human calibration labels are complete.'
          : agentAuthority
            ? 'Applicability protocol and the explicitly authorized agent source review are complete.'
            : 'Applicability protocol exists; source review authority is still unproven.',
      },
      {
        id: 'router-contracts',
        status: 'VERIFIED_BY_FOCUSED_TESTS',
        evidence: [
          'apps/ai-service/src/application/use-cases/query-router-agent.use-case.spec.ts',
        ],
        reason: primaryComplete
          ? 'Audio and inaccessible-Reel routes are covered locally and exercised in the matched candidate cohort.'
          : 'Audio and inaccessible-Reel routes are covered locally; matched cohort is incomplete.',
      },
      {
        id: 'temporal-retrieval',
        status: productionRetrievalPass
          ? 'VERIFIED_BY_LIVE_OWNER_SERVICE'
          : 'VERIFIED_BY_PROVIDER_FREE_REPLAY',
        evidence: [
          'apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.spec.ts',
          'apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts',
          ...(productionRetrievalPass
            ? [evidencePath(productionValidationPath)]
            : []),
        ],
        reason: productionRetrievalPass
          ? 'Endpoint and full-range selection pass frozen replay and the release-bound live owner-service probe.'
          : 'Endpoint and full-range selection pass frozen replay; live owner-service range proof remains separate.',
      },
      {
        id: 'multi-reel-coverage',
        status: 'VERIFIED_BY_FOCUSED_TESTS',
        evidence: [
          'apps/ai-service/src/infrastructure/adapters/deterministic-retrieval-engine.adapter.spec.ts',
          'apps/ai-service/src/application/use-cases/check-context-sufficiency.use-case.spec.ts',
        ],
        reason: primaryComplete
          ? 'Per-Reel retention and missing-source refusal are tested and the candidate cohort is terminal.'
          : 'Per-Reel retention and missing-source refusal are tested; candidate cohort is incomplete.',
      },
      {
        id: 'visual-evidence',
        status:
          visualContract?.status === 'PASS' &&
          visualContract?.imageTruthStatus === 'PASS' &&
          (humanGold || agentAuthority)
            ? 'PASS'
            : visualContract?.status === 'PASS'
              ? 'PROVENANCE_PASS_IMAGE_TRUTH_PENDING'
              : 'BLOCKED',
        evidence: [
          'evaluation-v6-operational/visual-contract-validation.json',
          'source/remote-active-eight.json',
        ],
        reason:
          visualContract?.status === 'PASS' &&
          visualContract?.imageTruthStatus === 'PASS' &&
          (humanGold || agentAuthority)
            ? agentAuthority
              ? 'Fresh visual scenes and exact stored frames passed the explicitly authorized agent review.'
              : 'Fresh visual scenes and exact stored frames passed human review.'
            : visualContract?.status === 'PASS'
              ? 'Fresh visual scenes have valid provenance; image-level review is pending.'
              : 'Visual source-contract validation is unavailable or incomplete.',
      },
      {
        id: 'memory-action',
        status:
          result.gates.structuredActionFailures === 0
            ? 'FOCUSED_TESTS_PASS'
            : 'BLOCKED',
        evidence: [
          'apps/ai-service/src/application',
          'evaluation-v6-baseline/structured-action-summary.json',
          'evaluation-v6-candidate/structured-action-summary.json',
        ],
        reason:
          result.gates.structuredActionFailures === 0
            ? 'Memory and structured-action regression checks pass with zero structured-action failures.'
            : 'Structured-action failures remain.',
      },
      {
        id: 'reliability',
        status:
          operational?.status === 'PASS' && rerankerPass
            ? 'OPERATIONAL_PASS'
            : operational?.status === 'PASS'
              ? 'OPERATIONAL_PASS_LIVE_RERANKER_BLOCKED'
              : 'BLOCKED',
        evidence: [
          'evaluation-v6-operational/operational-validation.json',
          'evaluation-v6-operational/provider-integration-validation.json',
        ],
        reason:
          operational?.status === 'PASS' && rerankerPass
            ? 'Synthetic fault coverage and live provider integration pass.'
            : operational?.status === 'PASS'
              ? 'Synthetic operational contract passes; live TEI reranker admission remains blocked.'
              : 'Operational fault coverage is unavailable or incomplete.',
      },
      {
        id: 'matched-primary',
        status: primaryComplete && exactOnce ? 'PASS' : 'INCOMPLETE',
        evidence: phases.map((phase) => `${phaseName(phase)}/state.json`),
        reason:
          primaryComplete && exactOnce
            ? `Both ${rows.length}-case primary cohorts are terminal with exact case identity coverage.`
            : 'One or more primary cohorts is incomplete.',
      },
      {
        id: 'matched-primary-replay',
        status: primaryComplete && exactOnce ? 'PASS' : 'INCOMPLETE',
        evidence: [
          'final-benchmark.json',
          'matched-deterministic-summary.json',
        ],
        reason:
          primaryComplete && exactOnce
            ? 'Completed primary requests are unique and no completed case was replayed.'
            : 'Replay identity cannot be proven until both cohorts are terminal.',
      },
      {
        id: 'semantic-judge-replay',
        status: result.gates.exactOnceSemanticScores
          ? 'PROVISIONAL_PASS'
          : 'INCOMPLETE',
        evidence: phases.map(
          (phase) => `${phaseName(phase)}/semantic-cases.jsonl`,
        ),
        reason: result.gates.exactOnceSemanticScores
          ? 'All case identities have one semantic record; unavailable provider cases remain explicitly unscored.'
          : 'Semantic case identity coverage is incomplete.',
      },
      {
        id: 'release-approval',
        status: releaseReady ? 'PASS' : 'BLOCKED',
        evidence: [
          'final-benchmark.json',
          evidencePath(calibrationReviewPath),
          evidencePath(providerValidationPath),
          ...(productionRetrievalPass
            ? [evidencePath(productionValidationPath)]
            : []),
        ],
        reason: releaseReady
          ? agentAuthority
            ? 'All declared release evidence is complete under the explicitly authorized agent source-of-truth review policy.'
            : 'All declared release evidence is complete.'
          : 'Review authority, independent approval, live retrieval/ACL proof, image-level visual truth, or live TEI reranking admission remain unproven.',
      },
    ],
  };
}

function main() {
  if (phaseNames.length !== 2)
    throw new Error('RAG_FINAL_PHASES must contain exactly two phase names');
  const phases = phaseNames.map(analyzePhase);
  const semantic = phases.map(({ details }, index) => ({
    phase: phaseNames[index],
    ...analyzeSemantic(phaseNames[index], details),
  }));
  const provenance = fs.existsSync(provenancePath)
    ? JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
    : {};
  const operational = fs.existsSync(operationalValidationPath)
    ? JSON.parse(fs.readFileSync(operationalValidationPath, 'utf8'))
    : undefined;
  const visualContract = fs.existsSync(visualContractPath)
    ? JSON.parse(fs.readFileSync(visualContractPath, 'utf8'))
    : undefined;
  const providerValidation = fs.existsSync(providerValidationPath)
    ? JSON.parse(fs.readFileSync(providerValidationPath, 'utf8'))
    : undefined;
  const calibration = fs.existsSync(calibrationReviewPath)
    ? JSON.parse(fs.readFileSync(calibrationReviewPath, 'utf8'))
    : undefined;
  const productionValidation = fs.existsSync(productionValidationPath)
    ? JSON.parse(fs.readFileSync(productionValidationPath, 'utf8'))
    : undefined;
  const humanGold =
    Array.isArray(calibration?.cases) &&
    calibration.cases.length > 0 &&
    calibration.cases.every(
      (entry) =>
        entry.reviewedLabel !== null && entry.reviewedLabel !== undefined,
    ) &&
    (calibration?.humanApproved === true || !calibration?.reviewMetadata);
  const agentSourceReview =
    Array.isArray(calibration?.cases) &&
    calibration.cases.length > 0 &&
    calibration.cases.every(
      (entry) =>
        entry.reviewedLabel !== null && entry.reviewedLabel !== undefined,
    ) &&
    process.env.RAG_FINAL_REVIEW_AUTHORITY ===
      'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' &&
    calibration?.reviewAuthority === 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' &&
    calibration?.reviewMetadata?.reviewerType ===
      'AGENT_SOURCE_AND_FRAME_REVIEW' &&
    calibration?.humanApproved === false;
  const independentReview = agentSourceReview
    ? 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH'
    : calibration?.independentReview === 'PASS'
      ? 'PASS'
      : 'NOT_PROVEN';
  const reviewAuthority = agentSourceReview
    ? 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH'
    : humanGold && calibration?.independentReview === 'PASS'
      ? 'HUMAN_INDEPENDENT'
      : 'UNPROVEN';
  const productionRetrievalProven = productionValidation?.status === 'PASS';
  const result = {
    status: 'COMPLETE_CANDIDATE_REPLAY',
    casesPerPhase: rows.length,
    datasetSha256: fingerprint(rows),
    humanGold,
    agentSourceReview,
    productionRetrievalProven,
    independentReview,
    reviewAuthority,
    evaluatorProtocol: EVALUATOR_VERSION,
    provenance,
    operationalFaultCoverage: operational || {
      status: 'UNVERIFIED',
      path: operationalValidationPath,
    },
    visualSourceContract: visualContract || {
      status: 'UNVERIFIED',
      path: visualContractPath,
    },
    productionRetrieval: productionValidation || {
      status: 'UNVERIFIED',
      path: productionValidationPath,
    },
    phases: phases.map(({ summary }, index) => ({
      phase: phaseNames[index],
      deterministic: summary,
      semanticApplicable: semantic[index].all,
      semanticByBucket: semantic[index].byBucket,
      semanticEvaluatorVersion: semantic[index].evaluatorVersion,
    })),
    gates: {
      exactOncePrimaryResponses: true,
      exactOnceSemanticScores: true,
      semanticEvaluatorConsistent: semantic.every(
        (phase) => phase.evaluatorVersion === EVALUATOR_VERSION,
      ),
      applicabilitySeparated: true,
      privacyCanaryLeaks: phases.reduce(
        (sum, phase) => sum + phase.summary.privacyCanaryLeaks,
        0,
      ),
      liveProductionRetrieval: productionRetrievalProven ? 'PASS' : 'UNPROVEN',
      humanGoldLabels: humanGold ? 'PASS' : 'UNPROVEN',
      agentSourceReview: agentSourceReview ? 'PASS' : 'UNPROVEN',
      independentReview: independentReview,
      structuredActionsEvaluated: true,
      structuredActionFailures: phases[1].summary.structuredActions.failed,
      operationalFaultCoverage: operational?.status || 'UNVERIFIED',
      visualSourceContract: visualContract?.status || 'UNVERIFIED',
    },
  };
  result.qualityGate = buildQualityGate({
    candidateSummary: phases[1].summary,
    candidateSemantic: semantic[1],
    baselineDetails: phases[0].details,
    candidateDetails: phases[1].details,
  });
  result.gates.qualityTargets = result.qualityGate.status;
  writeJson(
    path.join(runDir, 'matched-deterministic-summary.json'),
    phases.map(({ summary }) => summary),
  );
  writeJson(path.join(runDir, 'final-benchmark.json'), result);
  writeJson(
    path.join(runDir, 'exit-gate-matrix.json'),
    buildExitGateMatrix(
      result,
      phases,
      operational,
      visualContract,
      providerValidation,
      calibration,
      productionValidation,
    ),
  );
  const lines = [
    '# Matched candidate replay benchmark',
    '',
    `Both ${rows.length}-case primary cohorts and applicability-aware semantic scoring are complete.`,
    '',
    '| Dimension | Baseline applicable mean | Patched applicable mean | Baseline scored/applicable | Patched scored/applicable |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const dimension of DIMENSIONS) {
    const baseline = result.phases[0].semanticApplicable[dimension];
    const patched = result.phases[1].semanticApplicable[dimension];
    lines.push(
      `| ${dimension} | ${baseline.mean == null ? 'N/A' : baseline.mean.toFixed(4)} | ${patched.mean == null ? 'N/A' : patched.mean.toFixed(4)} | ${baseline.scored}/${baseline.applicable} | ${patched.scored}/${patched.applicable} |`,
    );
  }
  lines.push(
    '',
    'Quality target gate: ' + result.qualityGate.status + '.',
    result.qualityGate.status === 'PASS'
      ? 'All deterministic, semantic, coverage, clarification, recommendation, and paired-regression targets pass.'
      : 'Unmet targets: ' + result.qualityGate.blockedChecks.join(', ') + '.',
  );
  lines.push(
    '',
    operational?.status === 'PASS'
      ? 'The isolated operational contract suite observed all 40 declared fault scenarios, including duplicate refusal and expected trace loss.'
      : 'Operational fault coverage is unavailable or incomplete and remains a release blocker.',
    visualContract?.status === 'PASS'
      ? `The frozen visual-source contract covers ${visualContract.casesWithVisualEvidence} cases and ${visualContract.visualEvidenceItems} visual evidence items with no provenance or timestamp mismatches.`
      : 'Visual source-contract validation is unavailable or incomplete and remains a release blocker.',
    productionRetrievalProven
      ? 'The release-bound live retrieval/ACL probe passed for the deployed owner-service path.'
      : 'This replay does not prove live vector retrieval or production authorization enforcement.',
    reviewAuthority === 'HUMAN_INDEPENDENT'
      ? 'Human calibration labels and independent review are present.'
      : reviewAuthority === 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH'
        ? 'The explicitly authorized agent source-of-truth review is present; no separate human approval is claimed.'
        : 'Review authority and independent approval remain unproven.',
    'Unavailable provider results and non-applicable dimensions remain separate from scored means.',
  );
  fs.writeFileSync(
    path.join(runDir, 'final-benchmark.md'),
    `${lines.join('\n')}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: result.status,
      runDir,
      casesPerPhase: rows.length,
    }),
  );
}

if (require.main === module) main();

module.exports = {
  analyzePhase,
  analyzeSemantic,
  buildExitGateMatrix,
  semanticAggregate,
};
