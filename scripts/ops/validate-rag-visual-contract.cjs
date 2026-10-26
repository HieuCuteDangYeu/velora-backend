'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateSourceSnapshot({ datasetDir, snapshotPath, rows, visualRows }) {
  if (!snapshotPath)
    return {
      imageTruthStatus: 'NOT_REVIEWED',
      liveSceneBindingStatus: 'UNVERIFIED',
      reviewAuthority: null,
      humanApproved: null,
      reviewedFrameCount: 0,
      sourceSnapshotPath: null,
      failures: [],
    };

  const snapshot = readJson(snapshotPath);
  const manifestPath = path.join(datasetDir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : {};
  const failures = [];
  const reviewPath = path.resolve(process.cwd(), snapshot.reviewFile || '');
  let review;
  if (!snapshot.reviewFile || !fs.existsSync(reviewPath)) {
    failures.push({ kind: 'MISSING_FRAME_REVIEW', path: snapshot.reviewFile || null });
  } else {
    const reviewBytes = fs.readFileSync(reviewPath);
    if (sha256(reviewBytes) !== snapshot.reviewFileSha256)
      failures.push({ kind: 'FRAME_REVIEW_HASH_MISMATCH' });
    try {
      review = JSON.parse(reviewBytes.toString('utf8'));
    } catch {
      failures.push({ kind: 'INVALID_FRAME_REVIEW_JSON' });
    }
  }
  if (snapshot.schemaVersion !== 'rag-visual-source-live-review-v1')
    failures.push({ kind: 'UNSUPPORTED_SOURCE_SNAPSHOT' });
  if (snapshot.status !== 'PASS' || snapshot.imageTruthStatus !== 'PASS')
    failures.push({ kind: 'SOURCE_SNAPSHOT_NOT_PASSED' });
  if (snapshot.sourceDatasetSha256 !== manifest.datasetSha256)
    failures.push({ kind: 'SOURCE_DATASET_HASH_MISMATCH' });
  if (
    snapshot.reviewAuthority !== 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' ||
    snapshot.reviewerType !== 'AGENT_SOURCE_AND_FRAME_REVIEW' ||
    snapshot.humanApproved !== false
  )
    failures.push({ kind: 'SOURCE_REVIEW_AUTHORITY_INVALID' });
  if (
    !Array.isArray(snapshot.frames) ||
    snapshot.frames.length !== snapshot.requestedFrameCount ||
    snapshot.matchedActiveSceneCount !== snapshot.requestedFrameCount
  )
    failures.push({ kind: 'FRAME_OR_SCENE_COVERAGE_INCOMPLETE' });
  if (
    !review ||
    review.reviewAuthority !== snapshot.reviewAuthority ||
    review.humanApproved !== false ||
    !Array.isArray(review.frameReviews)
  )
    failures.push({ kind: 'SOURCE_REVIEW_DOCUMENT_INVALID' });

  const frameByCase = new Map();
  for (const frame of snapshot.frames || []) {
    if (frameByCase.has(frame.caseId))
      failures.push({ kind: 'DUPLICATE_REVIEWED_FRAME_CASE', caseId: frame.caseId });
    frameByCase.set(frame.caseId, frame);
    const imagePath = path.resolve(process.cwd(), frame.framePath || '');
    if (!frame.framePath || !fs.existsSync(imagePath)) {
      failures.push({ kind: 'MISSING_REVIEWED_FRAME', caseId: frame.caseId });
    } else {
      const actualHash = sha256(fs.readFileSync(imagePath));
      if (actualHash !== frame.frameSha256 || actualHash !== frame.reviewedFrameSha256)
        failures.push({ kind: 'REVIEWED_FRAME_HASH_MISMATCH', caseId: frame.caseId });
    }
    if (
      frame.imageTruth?.status !== 'PASS' ||
      frame.imageTruth?.reviewAuthority !== snapshot.reviewAuthority ||
      frame.imageTruth?.humanApproved !== false
    )
      failures.push({ kind: 'IMAGE_TRUTH_REVIEW_MISSING', caseId: frame.caseId });
    if (
      !Object.values(frame.checks || {}).every(Boolean) ||
      frame.activeSceneIndex?.isActive !== true ||
      frame.activeSceneIndex?.id !== frame.sceneId ||
      frame.activeIndexAttemptId !== frame.contentIndexAttemptId ||
      frame.sourceMediaAttemptId !== frame.contentMediaAttemptId ||
      frame.visualFrameManifestKeySha256 !== frame.reviewedManifestKeySha256
    )
      failures.push({ kind: 'LIVE_SCENE_SOURCE_BINDING_FAILED', caseId: frame.caseId });
    const reviewedFrame = review?.frameReviews?.find(
      (candidate) => candidate.caseId === frame.caseId,
    );
    if (
      !reviewedFrame ||
      reviewedFrame.sceneId !== frame.sceneId ||
      reviewedFrame.frameSha256 !== frame.reviewedFrameSha256 ||
      reviewedFrame.decision !== frame.reviewDecision
    )
      failures.push({ kind: 'FRAME_REVIEW_LINK_MISMATCH', caseId: frame.caseId });
  }

  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const row of visualRows) {
    const frame = frameByCase.get(row.id);
    if (!frame || frame.reviewDecision !== 'ANSWERABLE') {
      failures.push({ kind: 'VISUAL_CASE_HAS_NO_ANSWERABLE_FRAME_REVIEW', caseId: row.id });
      continue;
    }
    const expectedIds = row.expectedOutput?.relevantEvidenceIds || [];
    if (!expectedIds.includes(frame.sceneId))
      failures.push({ kind: 'VISUAL_CASE_SCENE_NOT_IN_GOLD_EVIDENCE', caseId: row.id });
    const questionTimestamp = row.input.question.match(/\bat\s+(\d+(?:\.\d+)?)\s+seconds\b/i)?.[1];
    if (
      questionTimestamp !== undefined &&
      (Math.abs(Number(questionTimestamp) - frame.activeSceneIndex.startTime) > 0.01 ||
        Math.abs(Number(questionTimestamp) - frame.reviewedFrameTimestampSec) > 0.01)
    )
      failures.push({ kind: 'VISUAL_FRAME_TIMESTAMP_MISMATCH', caseId: row.id });
  }

  const bindingFailures = failures.filter((entry) =>
    ['LIVE_SCENE_SOURCE_BINDING_FAILED', 'FRAME_REVIEW_LINK_MISMATCH'].includes(entry.kind),
  );
  return {
    imageTruthStatus: failures.length === 0 ? 'PASS' : 'BLOCKED',
    liveSceneBindingStatus: bindingFailures.length === 0 ? 'PASS' : 'FAIL',
    reviewAuthority: snapshot.reviewAuthority,
    humanApproved: snapshot.humanApproved,
    reviewedFrameCount: frameByCase.size,
    sourceSnapshotPath: path.relative(process.cwd(), snapshotPath),
    sourceSnapshotSha256: sha256(fs.readFileSync(snapshotPath)),
    failures,
  };
}

function validate({ datasetDir, outputPath, sourceSnapshotPath }) {
  const rows = ['development', 'held_out'].flatMap((split) => readJson(path.join(datasetDir, `${split}.json`)));
  const fixtures = Object.assign({}, ...['development', 'held_out'].map((split) => readJson(path.join(datasetDir, `${split}-fixtures.json`))));
  const visualRows = rows.filter((row) => (row.expectedOutput?.relevantEvidenceIds || []).some((id) => id.includes(':visual:')));
  const failures = [];
  let evidenceCount = 0;
  for (const row of visualRows) {
    const fixture = fixtures[row.id] || {};
    const byId = new Map((fixture.scenes || []).map((scene) => [scene.id, scene]));
    const timestamp = row.input.question.match(/frame at (\d+(?:\.\d+)?) seconds/i)?.[1];
    for (const evidenceId of row.expectedOutput.relevantEvidenceIds.filter((id) => id.includes(':visual:'))) {
      evidenceCount += 1;
      const scene = byId.get(evidenceId);
      const evidenceText = scene && [scene.evidenceText, scene.retrievalText, scene.caption, scene.ocrText, ...(scene.objects || [])].filter(Boolean).join(' ').trim();
      const sceneTime = scene?.startTime ?? (typeof scene?.timestampMs === 'number' ? scene.timestampMs / 1000 : undefined);
      const issues = [];
      if (!scene) issues.push('MISSING_SCENE');
      if (scene && !evidenceText) issues.push('EMPTY_VISUAL_EVIDENCE');
      if (scene && scene.evidenceType && scene.evidenceType !== 'VISUAL') issues.push('WRONG_EVIDENCE_TYPE');
      if (scene && !scene.indexAttemptId) issues.push('MISSING_INDEX_ATTEMPT');
      if (scene && scene.indexVersion !== 'reel-index-v2') issues.push('STALE_INDEX_VERSION');
      if (scene && scene.embeddingModel !== 'BAAI/bge-m3') issues.push('WRONG_EMBEDDING_MODEL');
      if (scene && scene.embeddingVersion !== 'bge-m3-tei-v1') issues.push('WRONG_EMBEDDING_VERSION');
      if (scene && scene.embeddingDimensions !== 1024) issues.push('WRONG_EMBEDDING_DIMENSIONS');
      if (timestamp !== undefined && (sceneTime === undefined || Math.abs(Number(timestamp) - sceneTime) > 0.01)) issues.push('TIMESTAMP_MISMATCH');
      if (issues.length) failures.push({ caseId: row.id, evidenceId, issues });
    }
  }
  const visualReview = validateSourceSnapshot({
    datasetDir,
    snapshotPath: sourceSnapshotPath,
    rows,
    visualRows,
  });
  const allFailures = [...failures, ...visualReview.failures];
  const result = {
    status: allFailures.length === 0 ? 'PASS' : 'FAIL',
    datasetDir,
    cases: rows.length,
    casesWithVisualEvidence: visualRows.length,
    visualEvidenceItems: evidenceCount,
    failures: allFailures,
    ...visualReview,
    note: 'This validates frozen visual-source identity, live scene binding, exact source frames, image-level source review, timestamps, and embedding/index provenance. It does not establish provider-backed caption quality.',
  };
  writeJson(outputPath, result);
  return result;
}

if (require.main === module) {
  const [datasetDir, outputPath, sourceSnapshotPath] = process.argv.slice(2);
  if (!datasetDir || !outputPath) throw new Error('Usage: validate-rag-visual-contract <dataset-dir> <output.json>');
  console.log(JSON.stringify(validate({ datasetDir, outputPath, sourceSnapshotPath }), null, 2));
}

module.exports = { validate, validateSourceSnapshot };
