'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('./validate-rag-visual-contract.cjs');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function reviewedFixture(root) {
  const datasetDir = path.join(root, 'dataset');
  fs.mkdirSync(datasetDir, { recursive: true });
  const row = {
    id: 'visual-case',
    input: { question: 'What is visible in the sampled frame at 4.075 seconds?' },
    expectedOutput: { relevantEvidenceIds: ['reel:r:visual:1'] },
  };
  const scene = {
    id: 'reel:r:visual:1',
    startTime: 4.075,
    endTime: 4.075,
    evidenceType: 'VISUAL',
    evidenceText: 'A person and a blue chair.',
    indexAttemptId: 'attempt-1',
    indexVersion: 'reel-index-v2',
    embeddingModel: 'BAAI/bge-m3',
    embeddingVersion: 'bge-m3-tei-v1',
    embeddingDimensions: 1024,
  };
  const imagePath = path.join(root, 'frame.jpg');
  fs.writeFileSync(imagePath, Buffer.from('exact-frame'));
  const frameHash = sha256(fs.readFileSync(imagePath));
  const reviewPath = path.join(root, 'review.json');
  fs.writeFileSync(
    reviewPath,
    JSON.stringify({
      reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
      humanApproved: false,
      frameReviews: [
        {
          caseId: row.id,
          sceneId: scene.id,
          frameSha256: frameHash,
          decision: 'ANSWERABLE',
        },
      ],
    }),
  );
  const datasetSha256 = 'fixture-dataset-sha256';
  fs.writeFileSync(
    path.join(datasetDir, 'manifest.json'),
    JSON.stringify({ datasetSha256 }),
  );
  fs.writeFileSync(path.join(datasetDir, 'development.json'), JSON.stringify([row]));
  fs.writeFileSync(path.join(datasetDir, 'held_out.json'), JSON.stringify([]));
  fs.writeFileSync(
    path.join(datasetDir, 'development-fixtures.json'),
    JSON.stringify({ [row.id]: { scenes: [scene] } }),
  );
  fs.writeFileSync(path.join(datasetDir, 'held_out-fixtures.json'), JSON.stringify({}));
  const sourceSnapshotPath = path.join(root, 'source-snapshot.json');
  fs.writeFileSync(
    sourceSnapshotPath,
    JSON.stringify({
      schemaVersion: 'rag-visual-source-live-review-v1',
      status: 'PASS',
      imageTruthStatus: 'PASS',
      sourceDatasetSha256: datasetSha256,
      reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
      reviewerType: 'AGENT_SOURCE_AND_FRAME_REVIEW',
      humanApproved: false,
      reviewFile: reviewPath,
      reviewFileSha256: sha256(fs.readFileSync(reviewPath)),
      requestedFrameCount: 1,
      matchedActiveSceneCount: 1,
      frames: [
        {
          caseId: row.id,
          sceneId: scene.id,
          reviewDecision: 'ANSWERABLE',
          questionTimestampSec: 4.075,
          reviewedFrameTimestampSec: 4.075,
          framePath: imagePath,
          frameSha256: frameHash,
          reviewedFrameSha256: frameHash,
          sourceMediaAttemptId: 'media-1',
          contentMediaAttemptId: 'media-1',
          visualFrameManifestKeySha256: 'manifest-hash',
          reviewedManifestKeySha256: 'manifest-hash',
          activeIndexAttemptId: 'attempt-1',
          contentIndexAttemptId: 'attempt-1',
          activeSceneIndex: {
            id: scene.id,
            isActive: true,
            indexAttemptId: 'attempt-1',
            startTime: 4.075,
          },
          expectedEvidenceIds: [scene.id],
          checks: { sourceSceneBound: true },
          imageTruth: {
            status: 'PASS',
            reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
            humanApproved: false,
            observation: 'The frame supports the answer.',
          },
        },
      ],
    }),
  );
  return { datasetDir, sourceSnapshotPath, imagePath, root };
}

test('validates visual scene provenance and requested timestamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-visual-contract-'));
  const datasetDir = path.join(root, 'dataset');
  fs.mkdirSync(datasetDir, { recursive: true });
  const row = {
    id: 'visual-case',
    input: { question: 'What is visible in the sampled frame at 4.075 seconds?' },
    expectedOutput: { relevantEvidenceIds: ['reel:r:visual:1'] },
  };
  const scene = {
    id: 'reel:r:visual:1',
    startTime: 4.075,
    endTime: 4.075,
    evidenceType: 'VISUAL',
    evidenceText: 'A person and a blue chair.',
    indexAttemptId: 'attempt-1',
    indexVersion: 'reel-index-v2',
    embeddingModel: 'BAAI/bge-m3',
    embeddingVersion: 'bge-m3-tei-v1',
    embeddingDimensions: 1024,
  };
  fs.writeFileSync(path.join(datasetDir, 'development.json'), JSON.stringify([row]));
  fs.writeFileSync(path.join(datasetDir, 'held_out.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(datasetDir, 'development-fixtures.json'), JSON.stringify({ 'visual-case': { scenes: [scene] } }));
  fs.writeFileSync(path.join(datasetDir, 'held_out-fixtures.json'), JSON.stringify({}));
  try {
    const result = validate({ datasetDir, outputPath: path.join(root, 'result.json') });
    assert.equal(result.status, 'PASS');
    assert.equal(result.visualEvidenceItems, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requires a hash-bound source frame and active live-scene match for image-truth PASS', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-visual-live-source-'));
  const fixture = reviewedFixture(root);
  try {
    const result = validate({
      datasetDir: fixture.datasetDir,
      outputPath: path.join(root, 'valid.json'),
      sourceSnapshotPath: fixture.sourceSnapshotPath,
    });
    assert.equal(result.status, 'PASS');
    assert.equal(result.liveSceneBindingStatus, 'PASS');
    assert.equal(result.imageTruthStatus, 'PASS');
    assert.equal(result.reviewedFrameCount, 1);

    fs.writeFileSync(fixture.imagePath, Buffer.from('changed-frame'));
    const tampered = validate({
      datasetDir: fixture.datasetDir,
      outputPath: path.join(root, 'tampered.json'),
      sourceSnapshotPath: fixture.sourceSnapshotPath,
    });
    assert.equal(tampered.status, 'FAIL');
    assert.equal(tampered.imageTruthStatus, 'BLOCKED');
    assert(tampered.failures.some((failure) => failure.kind === 'REVIEWED_FRAME_HASH_MISMATCH'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
