const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildReviewedDataset } = require('./build-rag-v9-reviewed-dataset.cjs');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-v9-reviewed-'));
  const sourceDir = path.join(root, 'source-v8');
  const reviewFile = path.join(root, 'source-review-v1.json');
  const outputDir = path.join(root, 'source-v9');
  const cases = Array.from({ length: 44 }, (_, index) => {
    const id = `case-${String(index).padStart(2, '0')}`;
    return {
      id,
      input: { question: `Question ${index}`, reelIds: [`reel-${index}`] },
      expectedOutput: {
        answer: index === 0 ? 'old answer 0' : `answer ${index}`,
        evidenceIds: [`reel:reel-${index}:chunk:0`],
      },
      metadata: {
        datasetVersion: 'rag-v8-source-disjoint-20261026-03',
        split: index < 22 ? 'DEVELOPMENT' : 'HELD_OUT',
        bucket: index < 22 ? 'TRANSCRIPT' : 'MULTI_REEL',
        humanApproved: false,
        sourceEvidence: [{ evidenceId: `reel:reel-${index}:chunk:0` }],
      },
    };
  });
  const sourceManifest = {
    datasetVersion: 'rag-v8-source-disjoint-20261026-03',
    datasetSha256: fingerprint(cases),
    sourceSnapshotSha256: 'a'.repeat(64),
    visualReviewSha256: 'b'.repeat(64),
    caseCount: cases.length,
    sourceReelCount: cases.length,
    sourceReelIds: cases.map((item) => item.input.reelIds[0]),
    splitReelIds: {
      DEVELOPMENT: cases.slice(0, 22).map((item) => item.input.reelIds[0]),
      HELD_OUT: cases.slice(22).map((item) => item.input.reelIds[0]),
    },
    splitCounts: { DEVELOPMENT: 22, HELD_OUT: 22 },
    coverageByBucket: { TRANSCRIPT: 22, MULTI_REEL: 22 },
    v7SourceOverlap: 0,
  };
  const reviewCases = cases.map((item) => ({
    caseId: item.id,
    referenceStatus:
      item.id === 'case-00' ? 'REVISE_REFERENCE' : 'SOURCE_SUPPORTED',
    sourceEvidenceIds: item.metadata.sourceEvidence.map(
      (source) => source.evidenceId,
    ),
  }));
  const review = {
    schemaVersion: 'rag-agent-source-review-v1',
    reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
    humanApproved: false,
    sample: { size: 44 },
    cases: reviewCases,
    corrections: [
      {
        caseId: 'case-00',
        status: 'REVISE_REFERENCE',
        proposedAnswer: 'new answer',
        reason: 'source correction',
      },
      {
        caseId: 'case-02',
        status: 'REVISE_REFERENCE',
        proposedAnswer: 'another new answer',
        reason: 'second source correction',
      },
    ],
    acceptedAnswerProposals: { 'case-01': ['alt answer'] },
  };
  writeJson(path.join(sourceDir, 'manifest.json'), sourceManifest);
  writeJson(path.join(sourceDir, 'cases.json'), cases);
  writeJson(path.join(sourceDir, 'source-split.json'), { overlap: 0 });
  writeJson(reviewFile, review);
  return { root, sourceDir, reviewFile, outputDir, cases, review };
}

test('builds a new reviewed candidate without changing source inputs or evidence', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const result = buildReviewedDataset(data);
  const rows = JSON.parse(
    fs.readFileSync(path.join(result.outputDir, 'cases.json'), 'utf8'),
  );
  assert.equal(rows.length, 44);
  assert.equal(rows[0].input.question, data.cases[0].input.question);
  assert.deepEqual(
    rows[0].expectedOutput.evidenceIds,
    data.cases[0].expectedOutput.evidenceIds,
  );
  assert.equal(rows[0].expectedOutput.answer, 'new answer');
  assert.deepEqual(rows[1].expectedOutput.acceptedAnswers, ['alt answer']);
  assert.equal(rows[0].metadata.humanApproved, false);
  assert.equal(result.manifest.sourceReviewSampleSize, 44);
  assert.equal(result.manifest.correctedReferenceCount, 2);
  assert.equal(result.manifest.acceptedAnswerCaseCount, 1);
  assert.notEqual(
    result.manifest.datasetSha256,
    data.cases ? fingerprint(data.cases) : '',
  );
  assert.throws(() => buildReviewedDataset(data));
});

test('refuses a review report whose authority or sample shape is changed', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  data.review.sample.size = 43;
  writeJson(data.reviewFile, data.review);
  assert.throws(() => buildReviewedDataset(data), /incomplete or changed/);
});
