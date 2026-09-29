const assert = require('node:assert/strict');
const test = require('node:test');

const {
  toDatasetItem,
  validateRows,
} = require('./import-langfuse-dataset.cjs');

function row(index = 1) {
  return {
    id: `SCRAPED-CANDIDATE-${String(index).padStart(4, '0')}`,
    datasetVersion: 'rag-scraped-v1-provisional',
    question: 'What happens?',
    referenceAnswer: 'A deterministic answer.',
    expectedReelIds: [
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ],
    relevantEvidenceIds: [`reel:${index}:chunk:0`],
    expectedEvidenceTypes: ['TRANSCRIPT'],
    metadata: {
      annotationStatus: 'GENERATED_CANDIDATE',
      annotationSource: 'test',
      seriesId: 'series-1',
      sourceContentSha256: 'a'.repeat(64),
      indexSnapshotSha256: 'b'.repeat(64),
    },
  };
}

test('validates exactly 220 provisional rows and preserves correlation fields', () => {
  const rows = Array.from({ length: 220 }, (_, index) => row(index + 1));
  assert.equal(validateRows(rows).length, 220);
  assert.deepEqual(toDatasetItem(rows[0]), {
    id: 'SCRAPED-CANDIDATE-0001',
    input: {
      question: 'What happens?',
      reelIds: ['00000000-0000-4000-8000-000000000001'],
      evidenceIds: ['reel:1:chunk:0'],
      modality: 'TRANSCRIPT',
    },
    expectedOutput: {
      answer: 'A deterministic answer.',
      reelIds: ['00000000-0000-4000-8000-000000000001'],
      evidenceIds: ['reel:1:chunk:0'],
      modality: 'TRANSCRIPT',
    },
    metadata: {
      datasetVersion: 'rag-scraped-v1-provisional',
      annotationStatus: 'GENERATED_CANDIDATE',
      reelId: '00000000-0000-4000-8000-000000000001',
      evidenceIds: ['reel:1:chunk:0'],
      modality: 'TRANSCRIPT',
      seriesId: 'series-1',
      sourceContentSha256: 'a'.repeat(64),
      indexSnapshotSha256: 'b'.repeat(64),
      provenance: 'test',
    },
  });
});

test('rejects partial or promoted candidate rows', () => {
  assert.throws(() => validateRows([row()]), /exactly 220/);
  const invalid = Array.from({ length: 220 }, (_, index) => row(index + 1));
  invalid[0].metadata.annotationStatus = 'HUMAN_VERIFIED';
  assert.throws(() => validateRows(invalid), /GENERATED_CANDIDATE/);
});
