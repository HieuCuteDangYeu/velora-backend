#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

const root = path.resolve(__dirname, '../..');
const runDir = path.join(root, '.benchmarks/rag-remediation-v8-20261026-01');
const defaultSourceDir = path.join(
  runDir,
  'dataset-v8-source-disjoint-20261026-03',
);
const defaultReviewFile = path.join(
  runDir,
  'source/agent-source-review-v1.json',
);
const defaultOutputDir = path.join(
  runDir,
  'dataset-v9-agent-reviewed-20261026-01',
);
const datasetVersion = 'rag-v9-agent-reviewed-20261026-01';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonOnce(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

function buildReviewedDataset({
  sourceDir = defaultSourceDir,
  reviewFile = defaultReviewFile,
  outputDir = defaultOutputDir,
} = {}) {
  const sourceManifest = readJson(path.join(sourceDir, 'manifest.json'));
  const sourceCases = readJson(path.join(sourceDir, 'cases.json'));
  const sourceSplit = readJson(path.join(sourceDir, 'source-split.json'));
  const review = readJson(reviewFile);
  if (
    sourceManifest.datasetVersion !== 'rag-v8-source-disjoint-20261026-03' ||
    sourceManifest.datasetSha256 !== fingerprint(sourceCases)
  )
    throw new Error('V8 source dataset fingerprint is invalid');
  if (
    review.schemaVersion !== 'rag-agent-source-review-v1' ||
    review.reviewAuthority !== 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' ||
    review.humanApproved !== false ||
    review.sample?.size !== 44 ||
    review.cases?.length !== 44 ||
    review.corrections?.length !== 2
  )
    throw new Error('Source review report is incomplete or changed');
  const reviewedById = new Map(review.cases.map((item) => [item.caseId, item]));
  const corrections = new Map(
    review.corrections.map((item) => [item.caseId, item]),
  );
  const uniqueReviewIds = new Set(reviewedById.keys());
  if (uniqueReviewIds.size !== 44)
    throw new Error('Source review report contains duplicate case IDs');
  const sourceCaseIds = new Set(sourceCases.map((item) => item.id));
  if (
    [...reviewedById.keys(), ...corrections.keys()].some(
      (caseId) => !sourceCaseIds.has(caseId),
    ) ||
    [...corrections.keys()].some((caseId) => !reviewedById.has(caseId))
  )
    throw new Error(
      'Source review refers to a case outside the frozen dataset',
    );

  const cases = sourceCases.map((sourceCase) => {
    const item = structuredClone(sourceCase);
    item.metadata.datasetVersion = datasetVersion;
    item.metadata.humanApproved = false;
    const reviewCase = reviewedById.get(item.id);
    item.metadata.sourceReviewStatus =
      reviewCase?.referenceStatus ?? 'NOT_IN_STRATIFIED_SAMPLE';
    if (reviewCase) {
      const expectedIds = item.metadata.sourceEvidence.map(
        (evidence) => evidence.evidenceId,
      );
      if (
        fingerprint(expectedIds) !== fingerprint(reviewCase.sourceEvidenceIds)
      )
        throw new Error(`Reviewed source identity changed for ${item.id}`);
    }
    const correction = corrections.get(item.id);
    if (correction) {
      if (
        correction.status !== 'REVISE_REFERENCE' ||
        !correction.proposedAnswer
      )
        throw new Error(`Invalid source correction for ${item.id}`);
      item.expectedOutput.answer = correction.proposedAnswer;
      item.metadata.annotationStatus = 'AGENT_REVIEWED_CORRECTED_CANDIDATE';
      item.metadata.reviewNote = correction.reason;
    }
    const variants = review.acceptedAnswerProposals?.[item.id] ?? [];
    if (variants.length) {
      if (
        variants.some((answer) => typeof answer !== 'string' || !answer.trim())
      )
        throw new Error(`Invalid accepted answer variant for ${item.id}`);
      const canonical = String(item.expectedOutput.answer ?? '')
        .trim()
        .toLowerCase();
      item.expectedOutput.acceptedAnswers = [
        ...new Set(
          variants
            .map((answer) => answer.trim())
            .filter((answer) => answer.toLowerCase() !== canonical),
        ),
      ];
    }
    return item;
  });
  if (
    cases.length !== sourceManifest.caseCount ||
    new Set(cases.map((item) => item.id)).size !== cases.length ||
    sourceCases.some(
      (item, index) =>
        fingerprint(item.input) !== fingerprint(cases[index].input) ||
        fingerprint(item.expectedOutput.evidenceIds) !==
          fingerprint(cases[index].expectedOutput.evidenceIds),
    )
  )
    throw new Error('Reviewed dataset changed case identity, input, or qrels');

  const coverageByBucket = cases.reduce((result, item) => {
    result[item.metadata.bucket] = (result[item.metadata.bucket] ?? 0) + 1;
    return result;
  }, {});
  const manifest = {
    schemaVersion: 'rag-v9-agent-reviewed-manifest-v1',
    datasetVersion,
    generatedAt: new Date().toISOString(),
    caseCount: cases.length,
    datasetSha256: fingerprint(cases),
    sourceSnapshotSha256: sourceManifest.sourceSnapshotSha256,
    visualReviewSha256: sourceManifest.visualReviewSha256,
    sourceReelCount: sourceManifest.sourceReelCount,
    sourceReelIds: sourceManifest.sourceReelIds,
    splitReelIds: sourceManifest.splitReelIds,
    splitCounts: sourceManifest.splitCounts,
    coverageByBucket,
    reviewAuthority: review.reviewAuthority,
    humanApproved: false,
    sourceDatasetVersion: sourceManifest.datasetVersion,
    sourceDatasetSha256: sourceManifest.datasetSha256,
    sourceReviewSha256: fingerprint(review.cases),
    sourceReviewSampleSize: review.sample.size,
    correctedReferenceCount: corrections.size,
    acceptedAnswerCaseCount: Object.keys(review.acceptedAnswerProposals ?? {})
      .length,
    v7SourceOverlap: sourceManifest.v7SourceOverlap,
  };

  fs.mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  writeJsonOnce(path.join(outputDir, 'cases.json'), cases);
  writeJsonOnce(
    path.join(outputDir, 'development.json'),
    cases.filter((item) => item.metadata.split === 'DEVELOPMENT'),
  );
  writeJsonOnce(
    path.join(outputDir, 'held_out.json'),
    cases.filter((item) => item.metadata.split === 'HELD_OUT'),
  );
  writeJsonOnce(path.join(outputDir, 'source-split.json'), sourceSplit);
  writeJsonOnce(path.join(outputDir, 'manifest.json'), manifest);
  fs.copyFileSync(
    reviewFile,
    path.join(outputDir, 'agent-source-review-v1.json'),
    fs.constants.COPYFILE_EXCL,
  );
  fs.chmodSync(path.join(outputDir, 'agent-source-review-v1.json'), 0o600);
  return { outputDir, manifest };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const [name, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) args[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--'))
      args[name] = argv[++index];
    else args[name] = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = buildReviewedDataset({
    sourceDir: args['source-dir'] || defaultSourceDir,
    reviewFile: args['review-file'] || defaultReviewFile,
    outputDir: args['output-dir'] || defaultOutputDir,
  });
  process.stdout.write(
    `${JSON.stringify({ outputDir: result.outputDir, ...result.manifest }, null, 2)}\n`,
  );
}

if (require.main === module)
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  }

module.exports = { buildReviewedDataset, parseArgs };
