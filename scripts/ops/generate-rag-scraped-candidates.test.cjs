const assert = require('node:assert/strict');
const test = require('node:test');

const { generateCandidates } = require('./generate-rag-scraped-candidates.cjs');

test('generates provisional, single-reel candidates from indexed evidence', () => {
  const content = {
    reels: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        seriesId: 'series-a',
        title: 'Episode One',
        description: 'Description',
        tags: ['one'],
      },
    ],
  };
  const index = {
    reels: [
      {
        reelId: content.reels[0].id,
        document: {
          id: `reel:${content.reels[0].id}`,
          indexVersion: 'v2',
          embeddingVersion: 'e1',
        },
        chunks: [
          {
            id: `reel:${content.reels[0].id}:chunk:0`,
            kind: 'TRANSCRIPT',
            evidenceText: 'A verified line.',
            startTime: 0,
            endTime: 1,
            indexVersion: 'v2',
            embeddingVersion: 'e1',
          },
        ],
        visualScenes: [],
      },
    ],
  };

  const [candidate] = generateCandidates(content, index);
  assert.equal(candidate.datasetVersion, 'rag-scraped-v1-provisional');
  assert.equal(candidate.metadata.annotationStatus, 'GENERATED_CANDIDATE');
  assert.deepEqual(candidate.expectedReelIds, [content.reels[0].id]);
  assert.deepEqual(candidate.accessScope.authorizedReelIds, [
    content.reels[0].id,
  ]);
  assert.equal(candidate.referenceAnswer, 'A verified line.');
});
