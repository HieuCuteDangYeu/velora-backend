'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

const DEFAULT_FIELDS = [
  'caseId',
  'bucket',
  'question',
  'reviewedLabel',
  'imageTruth',
  'reviewNotes',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function required(args, key) {
  if (!args[key]) throw new Error(`Missing --${key}`);
  return path.resolve(args[key]);
}

function exactCaseMap(values, label) {
  const map = new Map();
  for (const value of values) {
    const id = value.caseId || value.id;
    if (!id || map.has(id)) throw new Error(`${label} contains duplicate or missing case ID`);
    map.set(id, value);
  }
  return map;
}

function safeCitation(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(
    [
      'sourceType',
      'reelId',
      'evidenceType',
      'title',
      'startTime',
      'endTime',
      'quote',
    ]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

function safeEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(
    [
      'evidenceId',
      'sourceId',
      'id',
      'reelId',
      'evidenceType',
      'title',
      'startTime',
      'endTime',
      'evidenceText',
      'retrievalText',
      'caption',
      'ocrText',
      'objects',
    ]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

function responseReviewView(response) {
  if (!response) return { status: 'MISSING_RESPONSE' };
  const trace = response.trace || {};
  const metrics = trace.workflowMetrics || {};
  const diagnostics = metrics.diagnostics || {};
  const contextSufficiency = diagnostics.contextSufficiency || {};
  const routeDecision = diagnostics.routeDecision || {};
  const retrievalPlan = diagnostics.retrievalPlanActual || diagnostics.retrievalPlan || {};
  return {
    status: response.error ? 'FAILED' : 'COMPLETED',
    error: response.error || null,
    answer: response.output?.answer || '',
    citations: (response.output?.citations || []).map(safeCitation).filter(Boolean),
    recommendedReels: response.output?.recommendedReels || [],
    suggestedQueries: response.output?.suggestedQueries || [],
    route: {
      intent: routeDecision.intent,
      referenceTarget: routeDecision.referenceTarget,
      reelQuestionType: routeDecision.reelQuestionType,
      requiredEvidence: routeDecision.requiredEvidence,
      decisionSource: diagnostics.route?.decisionSource,
    },
    retrieval: {
      retrievedChunkIds: trace.retrievedChunkIds || [],
      rerankedChunkIds: trace.rerankedChunkIds || [],
      plan: {
        mode: retrievalPlan.mode,
        sourceOrder: retrievalPlan.sourceOrder,
        sourceTimestampSec: retrievalPlan.sourceTimestampSec,
        sourceTimestampEndSec: retrievalPlan.sourceTimestampEndSec,
        requiresReelCoverage: retrievalPlan.requiresReelCoverage,
        searchLimit: retrievalPlan.searchLimit,
        rerankLimit: retrievalPlan.rerankLimit,
      },
    },
    contextSufficiency: {
      sufficient: contextSufficiency.sufficient,
      recommendedAction: contextSufficiency.recommendedAction,
      reason: contextSufficiency.reason,
      availableEvidence: contextSufficiency.availableEvidence || [],
      missingEvidence: contextSufficiency.missingEvidence || [],
      missingReelIds: contextSufficiency.missingReelIds || [],
    },
    generationEvidence: (diagnostics.generationEvidence || []).map(safeEvidence).filter(Boolean),
    verifier: {
      passed: trace.verifierPassed,
      confidence: trace.verifierConfidence,
      issues: trace.verifierIssues || [],
    },
  };
}

function fixtureEvidence(rows, fixturesByCaseId, evidenceIds) {
  const output = [];
  for (const evidenceId of evidenceIds || []) {
    let found;
    for (const row of rows) {
      const fixture = fixturesByCaseId.get(row.id) || {};
      const candidates = [
        ...(fixture.scenes || []),
        ...(fixture.evidence || []),
        ...(fixture.chunks || []),
        ...(fixture.documents || []),
      ];
      found = candidates.find((candidate) => candidate.id === evidenceId);
      if (found) break;
    }
    output.push(found ? safeEvidence(found) : { evidenceId, status: 'NOT_IN_LOCAL_FIXTURE' });
  }
  return output;
}

function escapeTsv(value) {
  return String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function buildReviewSheet(cases) {
  const lines = [DEFAULT_FIELDS.join('\t')];
  for (const entry of cases) {
    lines.push(
      [
        entry.caseId,
        entry.bucket,
        entry.question,
        entry.review.reviewedLabel,
        entry.review.imageTruth,
        entry.review.reviewNotes,
      ]
        .map(escapeTsv)
        .join('\t'),
    );
  }
  return `${lines.join('\n')}\n`;
}

function prepare({ datasetDir, calibrationPath, baselineRunDir, candidateRunDir, outputPath, sheetPath }) {
  const rows = ['development', 'held_out'].flatMap((split) =>
    readJson(path.join(datasetDir, `${split}.json`)),
  );
  const calibration = readJson(calibrationPath);
  const calibrationCases = calibration.cases || [];
  if (!calibrationCases.length) throw new Error('Calibration review has no cases');

  const rowById = exactCaseMap(rows, 'dataset');
  const calibrationById = exactCaseMap(calibrationCases, 'calibration review');
  for (const id of calibrationById.keys()) {
    if (!rowById.has(id)) throw new Error(`Calibration case is absent from dataset: ${id}`);
  }

  const baselineResponses = exactCaseMap(
    readJsonl(path.join(baselineRunDir, 'responses.jsonl')),
    'baseline responses',
  );
  const candidateResponses = exactCaseMap(
    readJsonl(path.join(candidateRunDir, 'responses.jsonl')),
    'candidate responses',
  );
  const fixtureByCaseId = new Map();
  for (const split of ['development', 'held_out']) {
    const fixturePath = path.join(datasetDir, `${split}-fixtures.json`);
    if (!fs.existsSync(fixturePath)) continue;
    for (const [caseId, fixture] of Object.entries(readJson(fixturePath))) {
      fixtureByCaseId.set(caseId, fixture);
    }
  }

  const cases = calibrationCases.map((calibrationCase) => {
    const row = rowById.get(calibrationCase.caseId);
    const metadata = row.metadata || {};
    const visualEvidenceIds = (calibrationCase.relevantEvidenceIds || []).filter((id) => id.includes(':visual:'));
    return {
      caseId: calibrationCase.caseId,
      bucket: calibrationCase.bucket,
      split: metadata.split,
      question: calibrationCase.question || row.input?.question,
      referenceAnswer: calibrationCase.referenceAnswer,
      relevantEvidenceIds: calibrationCase.relevantEvidenceIds || [],
      expectedEvidenceTypes: calibrationCase.expectedEvidenceTypes || [],
      applicability: calibrationCase.applicability || {},
      requiresImageReview: Boolean(calibrationCase.requiresImageReview || metadata.requiresImageReview),
      source: {
        referenceStartSec: metadata.referenceStartSec,
        referenceEndSec: metadata.referenceEndSec,
        sourceScope: metadata.sourceScope,
        fixtureEvidence: fixtureEvidence(rows, fixtureByCaseId, calibrationCase.relevantEvidenceIds || []),
        imageReview: visualEvidenceIds.length
          ? {
              status: 'IMAGE_ASSET_NOT_CAPTURED_IN_PACKET',
              evidenceIds: visualEvidenceIds,
              instruction: 'Open the authorized source frame at the stated timestamp and compare visible objects and readable text with the reference answer and candidate response.',
            }
          : null,
      },
      baseline: responseReviewView(baselineResponses.get(calibrationCase.caseId)),
      candidate: responseReviewView(candidateResponses.get(calibrationCase.caseId)),
      review: {
        reviewedLabel: calibrationCase.reviewedLabel ?? null,
        imageTruth: calibrationCase.imageTruth ?? null,
        reviewNotes: calibrationCase.reviewNotes ?? null,
      },
    };
  });

  const packet = {
    schemaVersion: 'rag-review-packet-v1',
    status: 'REVIEW_REQUIRED',
    generatedAt: new Date().toISOString(),
    dataset: {
      directory: datasetDir,
      fingerprint: fingerprint(rows),
      caseCount: rows.length,
      calibrationCaseCount: cases.length,
    },
    sourceCalibration: {
      path: calibrationPath,
      version: calibration.version || null,
      status: calibration.status || null,
    },
    instructions: {
      reviewedLabel: 'Set PASS, FAIL, ABSTAIN, or REPLACE_REFERENCE after checking the question, reference evidence, and both responses. Do not mark a generated caption as gold without checking the source.',
      imageTruth: 'For image cases set PASS or FAIL only after opening the exact frame. Leave null until the frame is available.',
      independentReview: 'After a second reviewer checks the completed labels, record independentReview=PASS in the source calibration artifact. This packet does not assert that review happened.',
      providerGate: 'The live TEI reranker qualification remains a separate provider check and cannot be satisfied by this packet.',
    },
    reviewers: {
      primary: { id: null, reviewedAt: null },
      independent: { id: null, reviewedAt: null, status: null },
    },
    cases,
  };
  writeJson(outputPath, packet);
  if (sheetPath) writeText(sheetPath, buildReviewSheet(cases));
  return packet;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packet = prepare({
    datasetDir: required(args, 'dataset-dir'),
    calibrationPath: required(args, 'calibration'),
    baselineRunDir: required(args, 'baseline-run'),
    candidateRunDir: required(args, 'candidate-run'),
    outputPath: required(args, 'output'),
    sheetPath: args.sheet ? path.resolve(args.sheet) : undefined,
  });
  console.log(
    JSON.stringify(
      {
        output: path.resolve(args.output),
        sheet: args.sheet ? path.resolve(args.sheet) : null,
        cases: packet.cases.length,
        imageReviewCases: packet.cases.filter((entry) => entry.requiresImageReview).length,
        status: packet.status,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) main();

module.exports = { buildReviewSheet, prepare, responseReviewView };
