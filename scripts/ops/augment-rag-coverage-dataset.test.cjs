'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { augment, writeBundle } = require('./augment-rag-coverage-dataset.cjs');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

function fixture() {
  const doc = {
    id: 'reel:r1',
    reelId: 'r1',
    title: 'Episode 1',
    indexAttemptId: 'attempt-old',
    indexVersion: 'reel-index-v2',
    tags: [],
  };
  return {
    userId: 'user-1',
    conversationId: 'conversation-1',
    authorizedReelIds: ['r1'],
    documents: [doc],
    chunks: [
      {
        id: 'reel:r1:chunk:0',
        reelId: 'r1',
        indexAttemptId: doc.indexAttemptId,
        indexVersion: doc.indexVersion,
        startTime: 0,
        endTime: 5,
        evidenceText: 'The speaker says hello.',
      },
    ],
    scenes: [],
  };
}

function activeSnapshot(startTime = 10) {
  const document = {
    id: 'reel:r1',
    reelId: 'r1',
    title: 'Episode 1',
    indexAttemptId: 'attempt-new',
    indexVersion: 'reel-index-v2',
    tags: [],
  };
  const scene = {
    id: 'reel:r1:visual:1',
    reelId: 'r1',
    indexAttemptId: document.indexAttemptId,
    indexVersion: document.indexVersion,
    isActive: true,
    evidenceType: 'VISUAL',
    embeddingModel: 'BAAI/bge-m3',
    embeddingVersion: 'bge-m3-tei-v1',
    embeddingDimensions: 1024,
    startTime,
    endTime: startTime,
    evidenceText: 'A person wearing a blue jacket.',
  };
  return {
    documents: [document],
    chunks: [],
    scenes: [scene],
  };
}

test('V7 augmentation preserves access, updates reviewed visuals, and adds visual coverage', () => {
  const bytes = Buffer.from('reviewed frame bytes');
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-frame-review-'));
  const framePath = path.join(frameDir, 'frame.bin');
  fs.writeFileSync(framePath, bytes);
  const frameSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const baseFixture = fixture();
  const rows = [
    {
      id: 'case-visual-abstention',
      input: {
        question: 'What is visible at 10 seconds?',
        fixtureRef: 'case-visual-abstention',
      },
      expectedOutput: {
        referenceAnswer: null,
        relevantEvidenceIds: [],
        expectedEvidenceTypes: [],
        assertions: [],
      },
      metadata: {
        datasetVersion: 'v6',
        bucket: 'ABSTENTION',
        split: 'DEVELOPMENT',
        answerType: 'ABSTENTION',
        fixtureSha256: fingerprint(baseFixture),
        humanApproved: false,
      },
    },
    {
      id: 'case-audio-control',
      input: {
        question: 'What sound is audible at 10 seconds?',
        fixtureRef: 'case-audio-control',
      },
      expectedOutput: {
        referenceAnswer: null,
        relevantEvidenceIds: [],
        expectedEvidenceTypes: [],
        assertions: [],
      },
      metadata: {
        datasetVersion: 'v6',
        bucket: 'ABSTENTION',
        split: 'DEVELOPMENT',
        answerType: 'ABSTENTION',
        fixtureSha256: fingerprint(baseFixture),
        humanApproved: false,
      },
    },
  ];
  const base = {
    rows,
    fixtures: {
      'case-visual-abstention': structuredClone(baseFixture),
      'case-audio-control': structuredClone(baseFixture),
    },
    manifest: { datasetSha256: 'base-dataset', sourceHash: 'base-source' },
  };
  const snapshot = activeSnapshot(12.5);
  const quoteReview = {
    reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
    reviewedAt: '2026-10-21T00:00:00.000Z',
    cases: [],
  };
  const visualReview = {
    reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
    reviewerType: 'AGENT_SOURCE_AND_FRAME_REVIEW',
    humanApproved: false,
    reviewedAt: '2026-10-21T00:00:00.000Z',
    frameReviews: [
      {
        caseId: 'case-visual-abstention',
        reelId: 'r1',
        sceneId: 'reel:r1:visual:1',
        decision: 'ANSWERABLE',
        question: 'What color is visible in the sampled frame at 12.5 seconds?',
        referenceAnswer: 'A person wearing a blue jacket.',
        framePath,
        frameSha256,
      },
      {
        sourceCaseId: 'case-audio-control',
        newCaseId: 'case-visual-new',
        reelId: 'r1',
        sceneId: 'reel:r1:visual:1',
        decision: 'ANSWERABLE',
        question: 'Describe the sampled visual frame at 12.5 seconds.',
        referenceAnswer: 'A person wearing a blue jacket.',
        framePath,
        frameSha256,
      },
    ],
  };
  try {
    const result = augment({
      base,
      activeSnapshot: snapshot,
      quoteReview,
      visualReview,
      version: 'v7-test',
    });
    const existing = result.rows.find(
      (row) => row.id === 'case-visual-abstention',
    );
    const audio = result.rows.find((row) => row.id === 'case-audio-control');
    const added = result.rows.find((row) => row.id === 'case-visual-new');
    assert.equal(result.rows.length, 3);
    assert.equal(existing.metadata.bucket, 'VISUAL');
    assert.equal(
      existing.input.question,
      'What color is visible in the sampled frame at 12.5 seconds?',
    );
    assert.equal(
      existing.expectedOutput.relevantEvidenceIds[0],
      'reel:r1:visual:1',
    );
    assert.equal(audio.metadata.bucket, 'ABSTENTION');
    assert.ok(
      result.fixtures[audio.input.fixtureRef].scenes.some(
        (scene) => scene.id === 'reel:r1:visual:1',
      ),
    );
    assert.equal(added.metadata.bucket, 'VISUAL');
    assert.equal(added.metadata.split, 'DEVELOPMENT');
    assert.equal(result.manifest.agentReviewedVisualFrames, 2);
    assert.equal(result.manifest.addedVisualCases, 1);

    const out = path.join(frameDir, 'dataset-v7');
    writeBundle(result, out);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(out, 'development.json'))).length,
      3,
    );
    assert.throws(() => writeBundle(result, out), /already exists/);
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
});

test('rejects an answerable visual relabel when its retained question timestamp misses the scene', () => {
  const bytes = Buffer.from('source frame');
  const frameDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rag-frame-review-time-'),
  );
  const framePath = path.join(frameDir, 'frame.bin');
  fs.writeFileSync(framePath, bytes);
  const baseFixture = fixture();
  const row = {
    id: 'case-visual',
    input: {
      question: 'What is visible in the sampled frame at 10 seconds?',
      fixtureRef: 'case-visual',
    },
    expectedOutput: {
      referenceAnswer: null,
      relevantEvidenceIds: [],
      expectedEvidenceTypes: [],
      assertions: [],
    },
    metadata: {
      datasetVersion: 'v6',
      bucket: 'ABSTENTION',
      split: 'DEVELOPMENT',
      answerType: 'ABSTENTION',
      fixtureSha256: fingerprint(baseFixture),
      humanApproved: false,
    },
  };
  try {
    assert.throws(
      () =>
        augment({
          base: {
            rows: [row],
            fixtures: { 'case-visual': baseFixture },
            manifest: { datasetSha256: 'base', sourceHash: 'source' },
          },
          activeSnapshot: activeSnapshot(12.5),
          quoteReview: {
            reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
            cases: [],
          },
          visualReview: {
            reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
            reviewerType: 'AGENT_SOURCE_AND_FRAME_REVIEW',
            humanApproved: false,
            reviewedAt: '2026-10-21T00:00:00.000Z',
            frameReviews: [
              {
                caseId: 'case-visual',
                reelId: 'r1',
                sceneId: 'reel:r1:visual:1',
                decision: 'ANSWERABLE',
                referenceAnswer: 'A person wearing a blue jacket.',
                framePath,
                frameSha256: crypto
                  .createHash('sha256')
                  .update(bytes)
                  .digest('hex'),
              },
            ],
          },
          version: 'v7-test',
        }),
      /timestamp does not match reviewed scene/,
    );
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
});

test('V7 can replace existing visual abstentions without adding cases or answering audio questions', () => {
  const bytes = Buffer.from('reviewed frame bytes');
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-frame-reuse-'));
  const framePath = path.join(frameDir, 'frame.bin');
  fs.writeFileSync(framePath, bytes);
  const frameSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const baseFixture = fixture();
  const rows = [
    {
      id: 'case-visual-abstention',
      input: {
        question:
          'What color is the speaker jacket in the frame at 10 seconds?',
        fixtureRef: 'case-visual-abstention',
      },
      expectedOutput: {
        referenceAnswer: null,
        relevantEvidenceIds: [],
        relevantEvidenceGroups: [],
        expectedEvidenceTypes: [],
        assertions: [],
      },
      metadata: {
        datasetVersion: 'v6',
        bucket: 'ABSTENTION',
        split: 'DEVELOPMENT',
        answerType: 'ABSTENTION',
        fixtureSha256: fingerprint(baseFixture),
        humanApproved: false,
      },
    },
    {
      id: 'case-audio-abstention',
      input: {
        question: 'What sound effect is audible at 10 seconds?',
        fixtureRef: 'case-audio-abstention',
      },
      expectedOutput: {
        referenceAnswer: null,
        relevantEvidenceIds: [],
        relevantEvidenceGroups: [],
        expectedEvidenceTypes: [],
        assertions: [],
      },
      metadata: {
        datasetVersion: 'v6',
        bucket: 'ABSTENTION',
        split: 'DEVELOPMENT',
        answerType: 'ABSTENTION',
        fixtureSha256: fingerprint(baseFixture),
        humanApproved: false,
      },
    },
  ];

  try {
    const result = augment({
      base: {
        rows,
        fixtures: {
          'case-visual-abstention': structuredClone(baseFixture),
          'case-audio-abstention': structuredClone(baseFixture),
        },
        manifest: { datasetSha256: 'base-dataset', sourceHash: 'base-source' },
      },
      activeSnapshot: activeSnapshot(),
      quoteReview: {
        reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
        cases: [],
      },
      visualReview: {
        reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
        reviewerType: 'AGENT_SOURCE_AND_FRAME_REVIEW',
        humanApproved: false,
        reviewedAt: '2026-10-21T00:00:00.000Z',
        frameReviews: [
          {
            caseId: 'case-visual-abstention',
            reelId: 'r1',
            sceneId: 'reel:r1:visual:1',
            decision: 'ANSWERABLE',
            referenceAnswer: 'A person wearing a blue jacket.',
            framePath,
            frameSha256,
          },
          {
            caseId: 'case-audio-abstention',
            reelId: 'r1',
            sceneId: 'reel:r1:visual:1',
            decision: 'ABSTAIN',
            framePath,
            frameSha256,
          },
        ],
      },
      version: 'v7-test',
    });

    const visual = result.rows.find(
      (row) => row.id === 'case-visual-abstention',
    );
    const audio = result.rows.find((row) => row.id === 'case-audio-abstention');
    assert.equal(result.rows.length, rows.length);
    assert.equal(result.manifest.addedVisualCases, 0);
    assert.equal(visual.metadata.bucket, 'VISUAL');
    assert.equal(
      visual.expectedOutput.referenceAnswer,
      'A person wearing a blue jacket.',
    );
    assert.equal(audio.metadata.bucket, 'ABSTENTION');
    assert.equal(audio.expectedOutput.referenceAnswer, null);
    assert.equal(result.manifest.agentReviewedVisualFrames, 2);
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
});

test('V7 augmentation rejects a frame checksum mismatch', () => {
  const bytes = Buffer.from('source frame');
  const frameDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rag-frame-review-bad-'),
  );
  const framePath = path.join(frameDir, 'frame.bin');
  fs.writeFileSync(framePath, bytes);
  try {
    const baseFixture = fixture();
    const row = {
      id: 'case-visual',
      input: {
        question: 'What is visible at 10 seconds?',
        fixtureRef: 'case-visual',
      },
      expectedOutput: {
        referenceAnswer: null,
        relevantEvidenceIds: [],
        expectedEvidenceTypes: [],
        assertions: [],
      },
      metadata: {
        datasetVersion: 'v6',
        bucket: 'ABSTENTION',
        split: 'DEVELOPMENT',
        answerType: 'ABSTENTION',
        fixtureSha256: fingerprint(baseFixture),
        humanApproved: false,
      },
    };
    assert.throws(
      () =>
        augment({
          base: {
            rows: [row],
            fixtures: { 'case-visual': baseFixture },
            manifest: { datasetSha256: 'base', sourceHash: 'source' },
          },
          activeSnapshot: activeSnapshot(),
          quoteReview: {
            reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
            cases: [],
          },
          visualReview: {
            reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
            reviewerType: 'AGENT_SOURCE_AND_FRAME_REVIEW',
            humanApproved: false,
            reviewedAt: '2026-10-21T00:00:00.000Z',
            frameReviews: [
              {
                caseId: 'case-visual',
                reelId: 'r1',
                sceneId: 'reel:r1:visual:1',
                decision: 'ANSWERABLE',
                referenceAnswer: 'A person in blue.',
                framePath,
                frameSha256: '0'.repeat(64),
              },
            ],
          },
          version: 'v7-test',
        }),
      /checksum mismatch/,
    );
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
});
