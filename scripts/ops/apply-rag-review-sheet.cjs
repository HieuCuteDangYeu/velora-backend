'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LABELS = new Set(['PASS', 'FAIL', 'ABSTAIN', 'REPLACE_REFERENCE']);
const IMAGE_LABELS = new Set(['PASS', 'FAIL']);
const INDEPENDENT_STATUSES = new Set(['PASS', 'FAIL']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
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

function parseTsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('Review sheet is empty');
  const header = lines[0].split('\t');
  const expected = ['caseId', 'bucket', 'question', 'reviewedLabel', 'imageTruth', 'reviewNotes'];
  if (header.join('\t') !== expected.join('\t')) throw new Error('Review sheet header does not match packet schema');
  return lines.slice(1).map((line, index) => {
    const values = line.split('\t');
    if (values.length !== expected.length) throw new Error(`Review sheet row ${index + 2} has the wrong column count`);
    return Object.fromEntries(expected.map((key, column) => [key, values[column].trim()]));
  });
}

function validateRows(rows, calibration) {
  const byId = new Map((calibration.cases || []).map((entry) => [entry.caseId, entry]));
  if (!byId.size) throw new Error('Calibration review has no cases');
  if (rows.length !== byId.size || new Set(rows.map((row) => row.caseId)).size !== byId.size) {
    throw new Error('Review sheet must contain exactly one row for every calibration case');
  }
  for (const row of rows) {
    const entry = byId.get(row.caseId);
    if (!entry) throw new Error(`Review sheet contains unknown case: ${row.caseId}`);
    if (!LABELS.has(row.reviewedLabel)) throw new Error(`Invalid reviewedLabel for ${row.caseId}`);
    if (entry.requiresImageReview) {
      if (!IMAGE_LABELS.has(row.imageTruth)) throw new Error(`Image truth is required for ${row.caseId}`);
    } else if (row.imageTruth) {
      throw new Error(`Non-visual case has image truth for ${row.caseId}`);
    }
  }
  return byId;
}

function apply({ sheetPath, calibrationPath, calibrationOutputPath, visualContractPath, visualContractOutputPath, reviewerId, reviewedAt, independentReviewerId, independentReviewedAt, independentStatus }) {
  if (!reviewerId || !reviewedAt) throw new Error('Primary reviewer ID and review timestamp are required');
  if (independentStatus && !INDEPENDENT_STATUSES.has(independentStatus)) {
    throw new Error(`Invalid independent review status: ${independentStatus}`);
  }
  if (independentStatus === 'PASS' && (!independentReviewerId || !independentReviewedAt || independentReviewerId === reviewerId)) {
    throw new Error('A passing independent review requires a distinct reviewer ID and timestamp');
  }
  const calibration = readJson(calibrationPath);
  const rows = parseTsv(sheetPath);
  const calibrationById = validateRows(rows, calibration);
  const nextCalibration = {
    ...calibration,
    status: independentStatus === 'PASS' ? 'HUMAN_REVIEW_COMPLETE' : 'HUMAN_REVIEW_CAPTURED',
    independentReview: independentStatus || null,
    reviewMetadata: {
      reviewerId,
      reviewedAt,
      independentReviewerId,
      independentReviewedAt,
    },
    cases: rows.map((row) => ({
      ...calibrationById.get(row.caseId),
      reviewedLabel: row.reviewedLabel,
      imageTruth: row.imageTruth || null,
      reviewNotes: row.reviewNotes || null,
      humanApproved: true,
    })),
  };
  writeJson(calibrationOutputPath, nextCalibration);

  const visualContract = readJson(visualContractPath);
  const imageRows = rows.filter((row) => calibrationById.get(row.caseId).requiresImageReview);
  const imageTruthStatus = imageRows.every((row) => row.imageTruth === 'PASS') ? 'PASS' : 'FAIL';
  const nextVisualContract = {
    ...visualContract,
    imageTruthStatus,
    imageTruthReview: {
      reviewerId,
      reviewedAt,
      cases: imageRows.map((row) => ({ caseId: row.caseId, imageTruth: row.imageTruth })),
    },
  };
  writeJson(visualContractOutputPath, nextVisualContract);
  return {
    calibrationOutputPath,
    visualContractOutputPath,
    cases: rows.length,
    imageReviewCases: imageRows.length,
    imageTruthStatus,
    independentReview: independentStatus || null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = apply({
    sheetPath: required(args, 'sheet'),
    calibrationPath: required(args, 'calibration'),
    calibrationOutputPath: required(args, 'calibration-output'),
    visualContractPath: required(args, 'visual-contract'),
    visualContractOutputPath: required(args, 'visual-contract-output'),
    reviewerId: args['reviewer-id'] || null,
    reviewedAt: args['reviewed-at'] || null,
    independentReviewerId: args['independent-reviewer-id'] || null,
    independentReviewedAt: args['independent-reviewed-at'] || null,
    independentStatus: args['independent-status'] || null,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main();

module.exports = { apply, parseTsv, validateRows };
