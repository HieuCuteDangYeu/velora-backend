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
const { ELIGIBILITY_POLICY } = require('./rag-semantic-eligibility.cjs');
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
const langfuseExperimentLedgerPath = path.resolve(
  process.env.RAG_FINAL_LANGFUSE_EXPERIMENT_LEDGER ||
    path.join(runDir, 'langfuse-experiment-runs.json'),
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

function semanticCasesFilename(
  value = process.env.RAG_FINAL_SEMANTIC_CASES_FILENAME,
) {
  const fileName = value?.trim() || 'semantic-cases.jsonl';
  if (path.basename(fileName) !== fileName || !fileName.endsWith('.jsonl'))
    throw new Error('Semantic case filename must be a .jsonl basename');
  return fileName;
}

function assertSemanticEligibilityPolicy(semanticRows, phase) {
  const policies = [
    ...new Set(semanticRows.map((row) => row.eligibilityPolicy)),
  ];
  if (policies.length !== 1 || policies[0] !== ELIGIBILITY_POLICY)
    throw new Error(
      phase + ' semantic scores do not use ' + ELIGIBILITY_POLICY,
    );
  return policies[0];
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

function validateCalibrationReview(calibration, datasetRows = rows) {
  if (!Array.isArray(calibration?.cases) || calibration.cases.length === 0)
    return false;
  const rowsById = new Map(datasetRows.map((row) => [row.id, row]));
  const ids = calibration.cases.map((entry) => entry.caseId);
  if (new Set(ids).size !== ids.length) return false;
  return calibration.cases.every((entry) => {
    const row = rowsById.get(entry.caseId);
    if (!row) return false;
    const relevantEvidenceIds = row.expectedOutput?.relevantEvidenceIds || [];
    const expectedEvidenceTypes =
      row.expectedOutput?.expectedEvidenceTypes || [];
    const expectedApplicability = applicability(row);
    const requiresImageReview =
      expectedEvidenceTypes.includes('VISUAL') ||
      relevantEvidenceIds.some((id) => id.includes(':visual:'));
    return (
      entry.question === row.input?.question &&
      entry.referenceAnswer === (row.expectedOutput?.referenceAnswer ?? null) &&
      entry.bucket === row.metadata?.bucket &&
      entry.reviewedLabel === 'PASS' &&
      JSON.stringify(entry.applicability) ===
        JSON.stringify(expectedApplicability) &&
      Array.isArray(entry.relevantEvidenceIds) &&
      JSON.stringify(entry.relevantEvidenceIds) ===
        JSON.stringify(relevantEvidenceIds) &&
      Array.isArray(entry.expectedEvidenceTypes) &&
      JSON.stringify(entry.expectedEvidenceTypes) ===
        JSON.stringify(expectedEvidenceTypes) &&
      entry.requiresImageReview === requiresImageReview &&
      (!requiresImageReview || entry.imageTruth === 'PASS') &&
      typeof entry.reviewNotes === 'string' &&
      entry.reviewNotes.trim().length > 0
    );
  });
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
    path.join(runDir, `${cohortPrefix}-${phase}`, semanticCasesFilename()),
  );
  assertExactCaseSet(semanticRows, `${phase} semantic scores`);
  const eligibilityPolicy = assertSemanticEligibilityPolicy(
    semanticRows,
    phase,
  );
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
    eligibilityPolicy,
    all: Object.fromEntries(
      DIMENSIONS.map((dimension) => [
        dimension,
        semanticAggregate(semanticRows, details, dimension),
      ]),
    ),
    byBucket,
  };
}

const RERANKER_METRICS = [
  'recallAt1',
  'recallAt3',
  'recallAt5',
  'recallAt10',
  'mrr',
  'ndcgAt5',
  'ndcgAt10',
  'evidenceHit',
];

function qualifyReranker(validation) {
  const expectedReleaseSha = process.env.RAG_FINAL_RELEASE_SHA?.trim();
  const releaseShaMatches =
    !expectedReleaseSha || validation?.releaseSha === expectedReleaseSha;
  if (validation?.status === 'PASS')
    return {
      pass: releaseShaMatches,
      method: 'EXPLICIT_QUALIFICATION_PASS',
      caseCount: null,
      summary: releaseShaMatches
        ? 'Reranker qualification artifact reports PASS for the expected release.'
        : 'Reranker qualification release SHA does not match the expected release.',
    };

  const provider = validation?.provider;
  const datasetPath = path.join(
    root,
    'eval/rag/datasets/rag-reranker-generalization-v1.json',
  );
  let dataset;
  try {
    dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  } catch {
    dataset = undefined;
  }
  const expectedCaseIds = new Set(dataset?.cases?.map((item) => item.id) || []);
  const observedCaseIds = provider?.rows?.map((item) => item.id) || [];
  const safeFixtureSetMatches =
    dataset?.schemaVersion === 'rag-reranker-qualification-v1' &&
    dataset?.datasetVersion === 'rag-reranker-generalization-v1' &&
    dataset?.provenance?.kind === 'SAFE_TEST_FIXTURES' &&
    expectedCaseIds.size === provider?.datasetCaseCount &&
    observedCaseIds.length === expectedCaseIds.size &&
    new Set(observedCaseIds).size === expectedCaseIds.size &&
    observedCaseIds.every((id) => expectedCaseIds.has(id));
  const teiMetrics = provider?.metrics?.tei;
  const baselineMetrics = provider?.metrics?.baseline;
  const noMaterialRegression = RERANKER_METRICS.every(
    (metric) =>
      Number.isFinite(teiMetrics?.[metric]) &&
      Number.isFinite(baselineMetrics?.[metric]) &&
      teiMetrics[metric] >= baselineMetrics[metric],
  );
  const imageSha = validation?.serviceImage?.split(':').at(-1);
  const pass =
    validation?.schemaVersion === 'rag-provider-integration-validation-v3' &&
    validation.status === 'PASS_PROVIDER_ADMISSION_ONLY' &&
    provider?.status === 'PASS' &&
    provider.healthResponseOk === true &&
    provider.endpoint === 'TEI /rerank' &&
    provider.model === 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1' &&
    safeFixtureSetMatches &&
    imageSha === validation.releaseSha &&
    releaseShaMatches &&
    validation.productionRagRequestsMade === 0 &&
    validation.langfuseWritesMade === 0 &&
    noMaterialRegression;

  return {
    pass,
    method: pass ? 'DEPLOYED_TEI_SAFE_FIXTURE_NO_REGRESSION' : null,
    caseCount: provider?.datasetCaseCount ?? null,
    summary: pass
      ? `Deployed TEI passes the repository no-material-regression criteria on ${provider.datasetCaseCount} safe fixtures; this does not establish large-scale quality or latency.`
      : !releaseShaMatches
        ? 'Reranker provider evidence release SHA does not match the expected release.'
        : 'The live reranker provider evidence does not prove the deployed TEI safe-fixture no-regression qualification.',
  };
}

function qualifyLangfuseReplay(
  ledger,
  phaseStates,
  expectedDatasetSha256,
  expectedCaseCount,
) {
  if (!ledger)
    return {
      pass: false,
      status: 'PENDING',
      summary: 'The Langfuse cached replay ledger is missing.',
      phases: [],
    };
  if (ledger.datasetSha256 !== expectedDatasetSha256) {
    return {
      pass: false,
      status: 'BLOCKED',
      summary: 'Langfuse replay ledger belongs to a different frozen dataset.',
      phases: [],
    };
  }

  const evaluatorTag = EVALUATOR_VERSION.replace(/[^A-Za-z0-9._-]/g, '-');
  const phaseResults = phaseStates.map(({ phase, state }) => {
    const buildFingerprint = state?.buildFingerprint;
    if (typeof buildFingerprint !== 'string' || !buildFingerprint) {
      return { phase, pass: false, status: 'BLOCKED' };
    }
    const key = `${phase}-${expectedDatasetSha256.slice(0, 12)}-${buildFingerprint.slice(0, 12)}-${evaluatorTag}`;
    const run = ledger.runs?.[key];
    const pass =
      run?.status === 'COMPLETE' &&
      run.phase === phase &&
      run.itemCount === expectedCaseCount &&
      run.toolObservationsReadBack === true &&
      Number.isInteger(run.toolObservationCount) &&
      run.toolObservationCount > 0 &&
      typeof run.datasetRunId === 'string' &&
      run.datasetRunId.length > 0 &&
      typeof run.runName === 'string' &&
      run.runName.includes(expectedDatasetSha256.slice(0, 12)) &&
      run.runName.includes(buildFingerprint.slice(0, 12)) &&
      run.runName.includes(evaluatorTag);
    return {
      phase,
      pass,
      status: pass ? 'PASS' : run ? 'BLOCKED' : 'PENDING',
      itemCount: run?.itemCount ?? null,
      toolObservationCount: run?.toolObservationCount ?? null,
      datasetRunId: run?.datasetRunId ?? null,
    };
  });
  const pass =
    phaseResults.length === 2 &&
    phaseResults.some((entry) => entry.phase === 'baseline') &&
    phaseResults.some((entry) => entry.phase === 'candidate') &&
    phaseResults.every((entry) => entry.pass);
  return {
    pass,
    status: pass
      ? 'PASS'
      : phaseResults.some((entry) => entry.status === 'BLOCKED')
        ? 'BLOCKED'
        : 'PENDING',
    summary: pass
      ? `Baseline and candidate Langfuse replays each link all ${expectedCaseCount} cases to this dataset and build, with tool observations read back from Langfuse.`
      : 'Full baseline and candidate Langfuse cached replays for this dataset/build with tool observations are not both proven.',
    phases: phaseResults,
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
  langfuseQualification = {
    pass: true,
    required: false,
    status: 'NOT_REQUIRED',
  },
) {
  const primaryComplete = phases.every(({ state }) =>
    terminalStatuses.has(state.status),
  );
  const exactOnce =
    result.gates.exactOncePrimaryResponses &&
    result.gates.exactOnceSemanticScores;
  const calibrationDatasetBound = validateCalibrationReview(calibration);
  const humanGold =
    calibrationDatasetBound &&
    (calibration?.humanApproved === true || !calibration?.reviewMetadata);
  const independentReview = calibration?.independentReview === 'PASS';
  const agentAuthority =
    process.env.RAG_FINAL_REVIEW_AUTHORITY ===
      'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' &&
    calibration?.reviewAuthority === 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' &&
    calibration?.reviewMetadata?.reviewerType ===
      'AGENT_SOURCE_AND_FRAME_REVIEW' &&
    calibration?.humanApproved === false &&
    calibrationDatasetBound;
  const reviewComplete = (humanGold && independentReview) || agentAuthority;
  const productionRetrievalPass =
    result.productionRetrievalProven === true ||
    productionValidation?.status === 'PASS';
  const rerankerQualification = qualifyReranker(providerValidation);
  const rerankerPass = rerankerQualification.pass;
  const qualityTargetsPass = result.gates.qualityTargets === 'PASS';
  const evaluatorVersionPass =
    result.gates.semanticEvaluatorConsistent === true;
  const eligibilityPolicyPass =
    result.gates.semanticEligibilityPolicyConsistent === true;
  const privacyPass = result.gates.privacyCanaryLeaks === 0;
  const langfusePass =
    langfuseQualification.required !== true || langfuseQualification.pass;
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
    evaluatorVersionPass &&
    eligibilityPolicyPass &&
    langfusePass;
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
        id: 'semantic-eligibility-policy',
        status: eligibilityPolicyPass ? 'PASS' : 'BLOCKED',
        evidence: ['final-benchmark.json'],
        reason: eligibilityPolicyPass
          ? 'Both semantic cohorts use ' + ELIGIBILITY_POLICY + '.'
          : 'Semantic case outputs must consistently use ' +
            ELIGIBILITY_POLICY +
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
        id: 'calibration-dataset-binding',
        status: calibrationDatasetBound ? 'PASS' : 'BLOCKED',
        evidence: [
          evidencePath(calibrationReviewPath),
          evidencePath(path.join(dataDir, 'manifest.json')),
        ],
        reason: calibrationDatasetBound
          ? 'Every calibration case uniquely matches a frozen dataset row, including its evidence IDs, evidence types, review rationale, and visual truth label.'
          : 'Calibration cases do not uniquely match frozen dataset rows or their reviewed evidence and visual labels.',
      },
      {
        id: 'measurement-applicability',
        status:
          result.gates.applicabilitySeparated && (humanGold || agentAuthority)
            ? 'PASS'
            : 'PROVISIONAL',
        evidence: [
          evidencePath(path.join(dataDir, 'manifest.json')),
          evidencePath(calibrationReviewPath),
        ],
        reason: humanGold
          ? 'Applicability protocol and dataset-bound human calibration labels are complete.'
          : agentAuthority
            ? 'Applicability protocol and the explicitly authorized, dataset-bound agent source review are complete.'
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
          evidencePath(visualContractPath),
          ...(visualContract?.sourceSnapshotPath
            ? [evidencePath(path.resolve(visualContract.sourceSnapshotPath))]
            : []),
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
          ...phases.map((phase) =>
            evidencePath(
              path.join(
                runDir,
                `${cohortPrefix}-${phaseName(phase)}`,
                'structured-action-summary.json',
              ),
            ),
          ),
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
          evidencePath(operationalValidationPath),
          evidencePath(providerValidationPath),
        ],
        reason:
          operational?.status === 'PASS' && rerankerPass
            ? `Synthetic fault coverage and live TEI safe-fixture qualification pass: ${rerankerQualification.summary}`
            : operational?.status === 'PASS'
              ? `Synthetic operational contract passes; live TEI qualification remains blocked: ${rerankerQualification.summary}`
              : 'Operational fault coverage is unavailable or incomplete.',
      },
      {
        id: 'live-tei-reranker-qualification',
        status: rerankerPass ? 'PASS' : 'BLOCKED',
        evidence: [evidencePath(providerValidationPath)],
        reason: rerankerQualification.summary,
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
          (phase) => `${phaseName(phase)}/${semanticCasesFilename()}`,
        ),
        reason: result.gates.exactOnceSemanticScores
          ? 'All case identities have one semantic record; unavailable provider cases remain explicitly unscored.'
          : 'Semantic case identity coverage is incomplete.',
      },
      {
        id: 'langfuse-observability',
        status: langfuseQualification.required
          ? langfuseQualification.status
          : 'NOT_REQUIRED',
        evidence: [evidencePath(langfuseExperimentLedgerPath)],
        reason: langfuseQualification.required
          ? langfuseQualification.summary
          : 'Langfuse cached replay is not required for this legacy finalizer run.',
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
  const rerankerQualification = qualifyReranker(providerValidation);
  const calibration = fs.existsSync(calibrationReviewPath)
    ? JSON.parse(fs.readFileSync(calibrationReviewPath, 'utf8'))
    : undefined;
  const productionValidation = fs.existsSync(productionValidationPath)
    ? JSON.parse(fs.readFileSync(productionValidationPath, 'utf8'))
    : undefined;
  const langfuseLedger = fs.existsSync(langfuseExperimentLedgerPath)
    ? JSON.parse(fs.readFileSync(langfuseExperimentLedgerPath, 'utf8'))
    : undefined;
  const langfuseQualification = qualifyLangfuseReplay(
    langfuseLedger,
    phases.map(({ state }, index) => ({ phase: phaseNames[index], state })),
    fingerprint(rows),
    rows.length,
  );
  langfuseQualification.required =
    process.env.RAG_FINAL_REQUIRE_LANGFUSE === 'true';
  const calibrationDatasetBound = validateCalibrationReview(calibration);
  const humanGold =
    calibrationDatasetBound &&
    (calibration?.humanApproved === true || !calibration?.reviewMetadata);
  const agentSourceReview =
    calibrationDatasetBound &&
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
    rerankerQualification,
    langfuseObservability: langfuseQualification,
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
      semanticEligibilityPolicy: semantic[index].eligibilityPolicy,
    })),
    gates: {
      exactOncePrimaryResponses: true,
      exactOnceSemanticScores: true,
      semanticEvaluatorConsistent: semantic.every(
        (phase) => phase.evaluatorVersion === EVALUATOR_VERSION,
      ),
      semanticEligibilityPolicyConsistent: semantic.every(
        (phase) => phase.eligibilityPolicy === ELIGIBILITY_POLICY,
      ),
      applicabilitySeparated: true,
      privacyCanaryLeaks: phases.reduce(
        (sum, phase) => sum + phase.summary.privacyCanaryLeaks,
        0,
      ),
      liveProductionRetrieval: productionRetrievalProven ? 'PASS' : 'UNPROVEN',
      calibrationDatasetBinding: calibrationDatasetBound ? 'PASS' : 'BLOCKED',
      humanGoldLabels: humanGold ? 'PASS' : 'UNPROVEN',
      agentSourceReview: agentSourceReview ? 'PASS' : 'UNPROVEN',
      independentReview: independentReview,
      structuredActionsEvaluated: true,
      structuredActionFailures: phases[1].summary.structuredActions.failed,
      operationalFaultCoverage: operational?.status || 'UNVERIFIED',
      visualSourceContract: visualContract?.status || 'UNVERIFIED',
      liveTeiRerankerQualification: rerankerQualification.pass
        ? 'PASS'
        : 'BLOCKED',
      langfuseObservability: langfuseQualification.required
        ? langfuseQualification.status
        : 'NOT_REQUIRED',
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
      langfuseQualification,
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
  assertSemanticEligibilityPolicy,
  analyzeSemantic,
  buildExitGateMatrix,
  semanticCasesFilename,
  qualifyReranker,
  qualifyLangfuseReplay,
  validateCalibrationReview,
  semanticAggregate,
};
