#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  applyQuoteReferenceReview,
  deriveEvidenceGroup,
} = require('./build-rag-coverage-dataset.cjs');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

const SPLITS = ['DEVELOPMENT', 'HELD_OUT', 'OPERATIONAL'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadBase(datasetDir) {
  const rows = [];
  const fixtures = {};
  for (const split of SPLITS) {
    const name = split.toLowerCase();
    rows.push(...readJson(path.join(datasetDir, `${name}.json`)));
    Object.assign(
      fixtures,
      readJson(path.join(datasetDir, `${name}-fixtures.json`)),
    );
  }
  return {
    rows,
    fixtures,
    manifest: readJson(path.join(datasetDir, 'manifest.json')),
  };
}

function validateVisualSnapshot(snapshot) {
  if (
    !Array.isArray(snapshot?.documents) ||
    !Array.isArray(snapshot?.chunks) ||
    !Array.isArray(snapshot?.scenes) ||
    snapshot.documents.length === 0
  )
    throw new Error('Active visual snapshot is incomplete');
  const documents = new Map(snapshot.documents.map((doc) => [doc.reelId, doc]));
  if (documents.size !== snapshot.documents.length)
    throw new Error('Active visual snapshot has duplicate Reel documents');
  const scenesByReel = new Map();
  for (const scene of snapshot.scenes) {
    const doc = documents.get(scene.reelId);
    if (
      !doc ||
      scene.evidenceType !== 'VISUAL' ||
      scene.isActive !== true ||
      !scene.indexAttemptId ||
      scene.indexAttemptId !== doc.indexAttemptId ||
      scene.indexVersion !== doc.indexVersion ||
      scene.embeddingModel !== 'BAAI/bge-m3' ||
      scene.embeddingVersion !== 'bge-m3-tei-v1' ||
      scene.embeddingDimensions !== 1024 ||
      !String(scene.evidenceText || '').trim() ||
      !Number.isFinite(scene.startTime) ||
      !Number.isFinite(scene.endTime)
    )
      throw new Error(`Visual scene provenance is invalid: ${scene.id}`);
    scenesByReel.set(scene.reelId, (scenesByReel.get(scene.reelId) || 0) + 1);
  }
  for (const reelId of documents.keys()) {
    if (!(scenesByReel.get(reelId) > 0))
      throw new Error(`Target Reel has no active scenes: ${reelId}`);
  }
  return documents;
}

function mergeSnapshotIntoFixtures(fixtures, snapshot, documents) {
  const targetIds = new Set(documents.keys());
  const updatedFixtureIds = [];
  const authorizedTargets = new Set();
  for (const [fixtureId, fixture] of Object.entries(fixtures)) {
    const authorized = new Set(
      fixture.authorizedReelIds ||
        (fixture.documents || []).map((doc) => doc.reelId),
    );
    const presentTargets = [...targetIds].filter(
      (reelId) =>
        authorized.has(reelId) &&
        fixture.documents?.some((doc) => doc.reelId === reelId),
    );
    if (presentTargets.length === 0) continue;
    const present = new Set(presentTargets);
    for (const reelId of presentTargets) authorizedTargets.add(reelId);
    fixture.documents = [
      ...(fixture.documents || []).filter((doc) => !present.has(doc.reelId)),
      ...presentTargets.map((reelId) => documents.get(reelId)),
    ];
    fixture.chunks = [
      ...(fixture.chunks || []).filter((row) => !present.has(row.reelId)),
      ...snapshot.chunks.filter(
        (row) =>
          present.has(row.reelId) &&
          row.indexAttemptId === documents.get(row.reelId).indexAttemptId,
      ),
    ];
    fixture.scenes = [
      ...(fixture.scenes || []).filter((row) => !present.has(row.reelId)),
      ...snapshot.scenes.filter((row) => present.has(row.reelId)),
    ];
    updatedFixtureIds.push(fixtureId);
  }
  if (authorizedTargets.size !== targetIds.size)
    throw new Error(
      'One or more target Reels are absent from authorized fixtures',
    );
  return { updatedFixtureIds, targetReelIds: [...targetIds] };
}

function fixtureSourceIds(fixture) {
  return new Set(
    [
      ...(fixture.documents || []),
      ...(fixture.chunks || []),
      ...(fixture.scenes || []),
    ].map((source) => source.id),
  );
}

function requestedFrameTimestamp(question) {
  const match = String(question || '').match(
    /\bframe at (\d+(?:\.\d+)?) seconds\b/i,
  );
  return match ? Number(match[1]) : undefined;
}

function applyFrameReview({
  rows,
  fixtures,
  review,
  version,
  snapshotFingerprint,
}) {
  if (
    review?.reviewAuthority !== 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' ||
    review?.reviewerType !== 'AGENT_SOURCE_AND_FRAME_REVIEW' ||
    review?.humanApproved !== false ||
    !Array.isArray(review.frameReviews)
  )
    throw new Error('Visual frame review authority or cases are invalid');
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const scenes = new Map(
    review.activeSnapshot.scenes.map((scene) => [scene.id, scene]),
  );
  const reviewedReelIds = new Set(
    review.frameReviews.map((entry) => entry.reelId).filter(Boolean),
  );
  if (
    review.activeSnapshot.documents.some(
      (doc) => !reviewedReelIds.has(doc.reelId),
    )
  )
    throw new Error('Every target Reel needs at least one reviewed frame');
  const reviewed = [];
  const added = [];
  const corrected = [];
  for (const entry of review.frameReviews) {
    if (!/^[a-f0-9]{64}$/i.test(entry.frameSha256 || '') || !entry.framePath)
      throw new Error(
        `Frame review lacks a checksum or file path: ${entry.sceneId}`,
      );
    const imagePath = path.resolve(entry.framePath);
    const frameHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(imagePath))
      .digest('hex');
    if (frameHash !== entry.frameSha256.toLowerCase())
      throw new Error(`Reviewed frame checksum mismatch: ${entry.sceneId}`);
    const scene = scenes.get(entry.sceneId);
    if (!scene || scene.reelId !== entry.reelId)
      throw new Error(
        `Reviewed scene is absent from the active snapshot: ${entry.sceneId}`,
      );
    if (!['ANSWERABLE', 'ABSTAIN'].includes(entry.decision))
      throw new Error(`Invalid frame-review decision: ${entry.sceneId}`);
    if (
      entry.decision === 'ANSWERABLE' &&
      !String(entry.referenceAnswer || '').trim()
    )
      throw new Error(
        `Answerable frame lacks a reviewed reference: ${entry.sceneId}`,
      );

    let row;
    let fixtureId;
    let existingVisualCase = false;
    if (entry.caseId) {
      row = rowsById.get(entry.caseId);
      if (
        !row ||
        !['ABSTENTION', 'VISUAL', 'COMBINED'].includes(row.metadata.bucket)
      )
        throw new Error(
          `Visual review target is not an abstention or visual case: ${entry.caseId}`,
        );
      existingVisualCase = ['VISUAL', 'COMBINED'].includes(row.metadata.bucket);
      fixtureId = row.input.fixtureRef;
    } else if (entry.newCaseId && entry.sourceCaseId) {
      const parent = rowsById.get(entry.sourceCaseId);
      if (!parent)
        throw new Error(`Visual case parent is missing: ${entry.sourceCaseId}`);
      if (rowsById.has(entry.newCaseId))
        throw new Error(`Duplicate visual case ID: ${entry.newCaseId}`);
      const fixture = structuredClone(fixtures[parent.input.fixtureRef]);
      if (!fixture?.authorizedReelIds?.includes(entry.reelId))
        throw new Error(
          `New visual case would widen Reel access: ${entry.newCaseId}`,
        );
      fixture.conversationId = `fixture-conversation-${entry.newCaseId}`;
      fixtureId = entry.newCaseId;
      fixtures[fixtureId] = fixture;
      const doc = fixture.documents.find(
        (item) => item.reelId === entry.reelId,
      );
      if (!doc)
        throw new Error(`Visual case fixture lacks Reel ${entry.reelId}`);
      row = {
        id: entry.newCaseId,
        input: {
          question:
            entry.question ||
            `What is visible in the sampled frame at ${scene.startTime} seconds of "${doc.title}"? Describe only visible details, separating readable text from objects.`,
          fixtureRef: fixtureId,
        },
        expectedOutput: {
          referenceAnswer: null,
          relevantEvidenceIds: [],
          relevantEvidenceGroups: [],
          expectedEvidenceTypes: [],
          assertions: [
            'Use only authorized evidence; do not invent unsupported facts.',
          ],
        },
        metadata: {
          ...structuredClone(parent.metadata),
          datasetVersion: version,
        },
      };
      rows.push(row);
      rowsById.set(row.id, row);
      added.push(row.id);
    } else {
      throw new Error(
        `Visual review must target an existing case or add a new one: ${entry.sceneId}`,
      );
    }

    const fixture = fixtures[fixtureId];
    if (
      !fixture?.authorizedReelIds?.includes(entry.reelId) ||
      !fixtureSourceIds(fixture).has(entry.sceneId)
    )
      throw new Error(
        `Reviewed visual source is not in the authorized fixture: ${entry.sceneId}`,
      );
    if (existingVisualCase && entry.decision !== 'ANSWERABLE')
      throw new Error(
        `Existing visual reference requires a reviewed answer or explicit dataset reannotation: ${row.id}`,
      );
    if (entry.decision === 'ANSWERABLE') {
      if (entry.caseId && entry.question?.trim()) {
        row.input.question = entry.question.trim();
      }
      const requestedTimestamp = requestedFrameTimestamp(row.input.question);
      if (
        requestedTimestamp !== undefined &&
        Math.abs(requestedTimestamp - scene.startTime) > 0.01
      ) {
        throw new Error(
          `Answerable visual question timestamp does not match reviewed scene: ${row.id}`,
        );
      }
    }
    row.metadata.datasetVersion = version;
    row.metadata.fixtureSha256 = fingerprint(fixture);
    row.metadata.visualSnapshotSha256 = snapshotFingerprint;
    row.metadata.visualFrameReview = {
      decision: entry.decision,
      sceneId: entry.sceneId,
      frameSha256: frameHash,
      captionAgreement: entry.captionAgreement ?? null,
      observation: entry.observation ?? null,
      correction: entry.correction ?? null,
      reviewAuthority: review.reviewAuthority,
      reviewedAt: review.reviewedAt,
    };
    if (entry.decision === 'ANSWERABLE') {
      row.metadata.requiresImageReview = true;
      row.metadata.humanApproved = false;
      row.metadata.referenceStartSec = scene.startTime;
      row.metadata.referenceEndSec = scene.endTime;
      if (existingVisualCase) {
        const correctedVisualReference = String(
          entry.correctedVisualReference ?? '',
        ).trim();
        if (entry.captionAgreement === 'PARTIAL' && !correctedVisualReference)
          throw new Error(
            `Partial visual reference requires a correction: ${row.id}`,
          );
        if (correctedVisualReference) {
          const originalReference = String(
            row.expectedOutput.referenceAnswer ?? '',
          );
          if (row.metadata.bucket === 'COMBINED') {
            const saidOffset = originalReference.indexOf('\nSaid:');
            if (saidOffset < 0)
              throw new Error(
                `Combined visual reference lacks a separable Said section: ${row.id}`,
              );
            row.expectedOutput.referenceAnswer =
              correctedVisualReference + originalReference.slice(saidOffset);
          } else {
            row.expectedOutput.referenceAnswer = correctedVisualReference;
          }
          row.metadata.annotationStatus = 'AGENT_REVIEWED_CORRECTED_CANDIDATE';
          row.metadata.visualReferenceCorrection = {
            priorReferenceSha256: crypto
              .createHash('sha256')
              .update(originalReference)
              .digest('hex'),
            correctedVisualReferenceSha256: crypto
              .createHash('sha256')
              .update(correctedVisualReference)
              .digest('hex'),
            rationale: entry.correction ?? null,
          };
          corrected.push({
            caseId: row.id,
            previousReference: originalReference,
            correctedVisualReference,
          });
        } else {
          row.metadata.annotationStatus = 'AGENT_REVIEWED_CANDIDATE';
        }
      } else {
        row.metadata.bucket = 'VISUAL';
        row.metadata.answerType = 'SCENE_DESCRIPTION';
        row.metadata.sourceScope = 'INDEXED_VISUAL_CAPTION';
        row.metadata.annotationStatus = 'AGENT_REVIEWED_CANDIDATE';
        row.expectedOutput.referenceAnswer = entry.referenceAnswer.trim();
        row.expectedOutput.relevantEvidenceIds = [entry.sceneId];
        row.expectedOutput.relevantEvidenceGroups = [[entry.sceneId]];
        row.expectedOutput.expectedEvidenceTypes = ['VISUAL'];
      }
    }
    reviewed.push({
      caseId: row.id,
      reelId: entry.reelId,
      sceneId: entry.sceneId,
      decision: entry.decision,
      captionAgreement: entry.captionAgreement ?? null,
    });
  }
  return { reviewed, added, corrected };
}

function validateBundle(rows, fixtures) {
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error('Augmented dataset has duplicate case IDs');
  const families = new Map();
  for (const row of rows) {
    const fixture = fixtures[row.input?.fixtureRef];
    if (!fixture || fingerprint(fixture) !== row.metadata.fixtureSha256)
      throw new Error(`Fixture fingerprint mismatch: ${row.id}`);
    const available = fixtureSourceIds(fixture);
    const groups =
      row.expectedOutput?.relevantEvidenceGroups ||
      (row.expectedOutput?.relevantEvidenceIds || []).map((id) => [id]);
    if (
      groups.some(
        (group) => group.length === 0 || group.some((id) => !available.has(id)),
      )
    )
      throw new Error(`Reference evidence is absent from fixture: ${row.id}`);
    for (const doc of fixture.documents || []) {
      const family =
        fixture.sourceType === 'CANONICAL_SNAPSHOT'
          ? String(doc.title || '').split(' Episode')[0]
          : fixture.family || fixture.conversationId;
      if (families.has(family) && families.get(family) !== row.metadata.split)
        throw new Error(`Source family split leakage: ${family}`);
      families.set(family, row.metadata.split);
    }
  }
}

function augment({ base, activeSnapshot, quoteReview, visualReview, version }) {
  const rows = structuredClone(base.rows);
  const fixtures = structuredClone(base.fixtures);
  const documents = validateVisualSnapshot(activeSnapshot);
  const snapshotFingerprint = fingerprint(activeSnapshot);
  const merge = mergeSnapshotIntoFixtures(fixtures, activeSnapshot, documents);
  for (const row of rows) {
    row.metadata.datasetVersion = version;
    row.metadata.fixtureSha256 = fingerprint(fixtures[row.input.fixtureRef]);
  }
  const reviewedQuoteCases = applyQuoteReferenceReview(rows, quoteReview);
  if (reviewedQuoteCases !== quoteReview.cases.length)
    throw new Error(
      `Only ${reviewedQuoteCases}/${quoteReview.cases.length} quote references matched source windows`,
    );
  const frames = applyFrameReview({
    rows,
    fixtures,
    review: { ...visualReview, activeSnapshot },
    version,
    snapshotFingerprint,
  });
  for (const row of rows) {
    const ids = row.expectedOutput?.relevantEvidenceIds || [];
    row.expectedOutput.relevantEvidenceGroups = ids.map((id) =>
      deriveEvidenceGroup(row, fixtures[row.input.fixtureRef], id),
    );
    row.metadata.fixtureSha256 = fingerprint(fixtures[row.input.fixtureRef]);
  }
  validateBundle(rows, fixtures);
  const outputManifest = {
    schemaVersion: 'rag-coverage-dataset-augmentation-v1',
    datasetVersion: version,
    baseDatasetSha256: base.manifest.datasetSha256,
    datasetSha256: fingerprint(rows),
    fixtureSha256: fingerprint(fixtures),
    visualSnapshotSha256: snapshotFingerprint,
    quoteReviewSha256:
      quoteReview.cases.length > 0
        ? fingerprint(quoteReview)
        : (base.manifest.quoteReviewSha256 ?? fingerprint(quoteReview)),
    visualReviewSha256: fingerprint(visualReview),
    sourceSnapshotSha256:
      base.manifest.sourceHash || base.manifest.sourceSnapshotSha256,
    agentReviewedQuoteCases:
      (base.manifest.agentReviewedQuoteCases ?? 0) + reviewedQuoteCases,
    agentReviewedVisualFrames: frames.reviewed.length,
    correctedVisualReferenceCount: frames.corrected.length,
    captionAgreementCounts: visualReview.frameReviews.reduce(
      (counts, entry) => {
        if (entry.captionAgreement)
          counts[entry.captionAgreement] =
            (counts[entry.captionAgreement] || 0) + 1;
        return counts;
      },
      {},
    ),
    addedVisualCases: frames.added.length,
    alternativeEvidenceGroups: rows.reduce(
      (count, row) =>
        count +
        (row.expectedOutput.relevantEvidenceGroups || []).filter(
          (group) => group.length > 1,
        ).length,
      0,
    ),
    humanApproved: false,
    reviewAuthority: visualReview.reviewAuthority,
    caseCount: rows.length,
    coverageByBucket: rows.reduce((counts, row) => {
      counts[row.metadata.bucket] = (counts[row.metadata.bucket] || 0) + 1;
      return counts;
    }, {}),
    coverageBySplit: rows.reduce((counts, row) => {
      counts[row.metadata.split] = (counts[row.metadata.split] || 0) + 1;
      return counts;
    }, {}),
  };
  return { rows, fixtures, manifest: outputManifest, merge };
}

function writeBundle(bundle, outputDir) {
  if (fs.existsSync(outputDir))
    throw new Error(`Output directory already exists: ${outputDir}`);
  fs.mkdirSync(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  const temporary = `${outputDir}.tmp-${process.pid}`;
  fs.mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const split of SPLITS) {
      const name = split.toLowerCase();
      const rows = bundle.rows.filter((row) => row.metadata.split === split);
      fs.writeFileSync(
        path.join(temporary, `${name}.json`),
        `${JSON.stringify(rows, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      const fixtures = Object.fromEntries(
        rows.map((row) => [row.id, bundle.fixtures[row.input.fixtureRef]]),
      );
      fs.writeFileSync(
        path.join(temporary, `${name}-fixtures.json`),
        `${JSON.stringify(fixtures, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
    }
    fs.writeFileSync(
      path.join(temporary, 'manifest.json'),
      `${JSON.stringify(bundle.manifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    fs.renameSync(temporary, outputDir);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  const [baseDir, snapshotPath, quoteReviewPath, visualReviewPath, outputDir] =
    process.argv.slice(2);
  if (
    !baseDir ||
    !snapshotPath ||
    !quoteReviewPath ||
    !visualReviewPath ||
    !outputDir
  )
    throw new Error(
      'Usage: augment-rag-coverage-dataset <base-dir> <active-snapshot.json> <quote-review.json> <visual-review.json> <new-output-dir>',
    );
  const bundle = augment({
    base: loadBase(baseDir),
    activeSnapshot: readJson(snapshotPath),
    quoteReview: readJson(quoteReviewPath),
    visualReview: readJson(visualReviewPath),
    version:
      process.env.RAG_COVERAGE_DATASET_VERSION ||
      'rag-coverage-v7-visual-reviewed-20261021-01',
  });
  writeBundle(bundle, outputDir);
  console.log(JSON.stringify(bundle.manifest));
}

module.exports = {
  augment,
  loadBase,
  validateVisualSnapshot,
  mergeSnapshotIntoFixtures,
  applyFrameReview,
  validateBundle,
  writeBundle,
};
