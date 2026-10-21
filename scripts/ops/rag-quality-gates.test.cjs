'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  asksForClarification,
  buildQualityGate,
  evaluateClarificationPolicy,
} = require('./rag-quality-gates.cjs');

const buckets = ['TRANSCRIPT', 'VISUAL', 'COMBINED', 'MULTI_REEL', 'METADATA'];
const dimensions = [
  'faithfulness',
  'factualCorrectness',
  'responseRelevancy',
  'contextCompleteness',
];
const score = (mean) => ({ mean, denominator: 50 });
const dimension = (name) => ({
  mean: name === 'faithfulness' ? 0.99 : 0.9,
  scored: 10,
  applicable: 10,
  coverageWithinApplicable: 0.95,
});

function passingInput() {
  const deterministic = {
    cases: 50,
    executionHealth: { AVAILABLE: 50, DEGRADED: 0, FAILED: 0, UNKNOWN: 0 },
    all: {
      exactMatch: score(0.95),
      generationEvidenceCaptureCoverage: score(0.95),
      generationEvidenceCoverage: score(0.95),
      citationSourceRecall: score(0.95),
      retrieval_recall_at_5: score(0.95),
    },
    byBucket: Object.fromEntries(
      buckets.map((bucket) => [
        bucket,
        {
          exactMatch: score(0.95),
          generationEvidenceCaptureCoverage: score(0.95),
          generationEvidenceCoverage: score(0.95),
          citationSourceRecall: score(0.95),
          retrieval_recall_at_5: score(0.95),
        },
      ]),
    ),
    policyOutcomes: {
      clarification: { cases: 10, passed: 10, failed: 0, passRate: 1 },
    },
    structuredActions: { failed: 0 },
    structuredActions: { failed: 0 },
  };
  const semantic = {
    all: Object.fromEntries(dimensions.map((name) => [name, dimension(name)])),
    byBucket: Object.fromEntries(
      buckets.map((bucket) => [
        bucket,
        Object.fromEntries(dimensions.map((name) => [name, dimension(name)])),
      ]),
    ),
  };
  const details = buckets.flatMap((bucket) =>
    Array.from({ length: 10 }, (_, index) => ({
      caseId: bucket + '-' + index,
      bucket,
      retrieval_recall_at_5: 0.95,
      citationSourceRecall: 0.95,
      generationEvidenceCaptureCoverage: 1,
      generationEvidenceCoverage: 0.95,
    })),
  );
  return {
    candidateSummary: deterministic,
    candidateSemantic: semantic,
    baselineDetails: details,
    candidateDetails: details,
  };
}

test('quality gate requires the declared absolute and paired targets', () => {
  const input = passingInput();
  assert.equal(buildQualityGate(input).status, 'PASS');

  const degraded = {
    ...input,
    candidateDetails: input.candidateDetails.map((detail) =>
      detail.bucket === 'VISUAL'
        ? { ...detail, citationSourceRecall: 0.5 }
        : detail,
    ),
  };
  const result = buildQualityGate(degraded);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(
    result.blockedChecks.includes(
      'paired-regression-visual-citationSourceRecall',
    ),
  );
});

test('missing evidence captures block even when conditional evidence coverage passes', () => {
  const input = passingInput();
  input.candidateSummary.all.generationEvidenceCaptureCoverage = score(
    133 / 210,
  );
  input.candidateSummary.all.generationEvidenceCoverage = score(0.977);

  const result = buildQualityGate(input);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(
    result.blockedChecks.includes('generation-evidence-capture-coverage'),
  );
});

test('citation gates block weak transcript and visual buckets despite a strong mean', () => {
  const input = passingInput();
  input.candidateSummary.all.citationSourceRecall = score(0.9);
  input.candidateSummary.byBucket.TRANSCRIPT.citationSourceRecall = score(0.6);
  input.candidateSummary.byBucket.VISUAL.citationSourceRecall = score(0.3);

  const result = buildQualityGate(input);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockedChecks.includes('citation-source-recall-transcript'));
  assert.ok(result.blockedChecks.includes('citation-source-recall-visual'));
});

test('clarification policy requires a genuine disambiguating question', () => {
  assert.equal(
    asksForClarification('Which shared Reel or clip do you mean?'),
    true,
  );
  assert.equal(asksForClarification('The first clip shows a dog.'), false);
  const result = evaluateClarificationPolicy(
    [
      { id: 'a', metadata: { answerType: 'CLARIFICATION' } },
      { id: 'b', metadata: { answerType: 'CLARIFICATION' } },
    ],
    new Map([
      ['a', { output: { answer: 'Which clip do you mean?' } }],
      ['b', { output: { answer: 'The first clip shows a dog.' } }],
    ]),
  );
  assert.deepEqual(
    { cases: result.cases, passed: result.passed, passRate: result.passRate },
    { cases: 2, passed: 1, passRate: 0.5 },
  );
});
