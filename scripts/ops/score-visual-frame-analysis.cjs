#!/usr/bin/env node
'use strict';
// Scores frame analyses against the frame-reviewed references with the Haiku judge.
// Usage (from repo root): node scripts/ops/score-visual-frame-analysis.cjs <stored|analysis.jsonl> [limit]
//   stored         scores the evidence text already indexed in production for the same frames
//   analysis.jsonl output of run-visual-frame-analysis-offline.cjs
// Each analysis is rendered as an answer-like description (caption, optional readable text, objects),
// then judged for factual correctness and response relevancy. OCR is also compared by exact match.
const fs = require('node:fs');
const path = require('node:path');
const { buildDimensionPrompt } = require('./rag-judge-prompts.cjs');
const { runClaudeDimension } = require('./run-claude-rag-judge.cjs');

const root = path.resolve(__dirname, '../..');
const packetPath = path.join(
  root,
  '.benchmarks/rag-remediation-v8-20261027-01/visual-frame-review-complete-20261027-01/review-packet-v2-dataset-bound.json',
);
const capturePath = path.join(
  root,
  '.benchmarks/rag-remediation-v7-20261022-01/visual-frame-review-complete-20261027-02/capture.json',
);
const datasetDir = path.join(
  root,
  '.benchmarks/rag-remediation-v8-20261027-01/dataset-v8-frame-reviewed-20261027-01',
);
const DIMENSIONS = ['factualCorrectness', 'responseRelevancy'];

// The benchmark dataset holds the corrected references, including the
// "Readable text:" line; the review packet's own references predate them.
function loadDatasetRows() {
  return new Map(
    ['development', 'held_out'].flatMap((split) =>
      JSON.parse(
        fs.readFileSync(path.join(datasetDir, `${split}.json`), 'utf8'),
      ).map((row) => [row.id, row]),
    ),
  );
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function referenceOcr(referenceAnswer) {
  const match = String(referenceAnswer ?? '').match(
    /Readable text:\s*[“"]([^”"]+)[”"]/,
  );
  return match ? match[1] : undefined;
}

function renderAnswer(analysis) {
  return [
    analysis.caption,
    analysis.ocrText ? `Readable text: “${analysis.ocrText}”` : undefined,
    analysis.objects?.length ? analysis.objects.join(' ') : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : NaN;
}

function main() {
  const [source, limitArg] = process.argv.slice(2);
  if (!source)
    throw new Error(
      'Usage: score-visual-frame-analysis <stored|analysis.jsonl> [limit]',
    );
  const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  const datasetRows = loadDatasetRows();
  const reviewById = new Map(
    packet.frameReviews
      .filter((r) => datasetRows.has(r.caseId))
      .map((r) => {
        const row = datasetRows.get(r.caseId);
        return [
          r.caseId,
          {
            question: row.input.question,
            referenceAnswer:
              row.expectedOutput?.referenceAnswer ??
              row.expectedOutput?.acceptedAnswers?.[0] ??
              '',
            assertions: row.expectedOutput?.assertions,
            expectedEvidenceTypes: row.expectedOutput?.expectedEvidenceTypes,
          },
        ];
      }),
  );
  let analyses;
  if (source === 'stored') {
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    analyses = capture.frameReviews.map((r) => ({
      caseId: r.caseId,
      rendered: r.indexedEvidenceText,
    }));
  } else {
    analyses = fs
      .readFileSync(source, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((r) => !r.error)
      .map((r) => ({
        caseId: r.caseId,
        rendered: renderAnswer(r),
        ocr: r.ocrText,
      }));
  }
  const seen = new Set();
  analyses = analyses.filter((a) => {
    if (!reviewById.has(a.caseId) || seen.has(a.caseId)) return false;
    seen.add(a.caseId);
    return true;
  });
  if (limitArg) analyses = analyses.slice(0, Number(limitArg));

  const scores = Object.fromEntries(DIMENSIONS.map((d) => [d, []]));
  let ocrCases = 0;
  let ocrExact = 0;
  for (const analysis of analyses) {
    const review = reviewById.get(analysis.caseId);
    for (const dimension of DIMENSIONS) {
      const prompt = buildDimensionPrompt(dimension, {
        question: review.question,
        referenceAnswer: review.referenceAnswer ?? '',
        generatedAnswer: analysis.rendered,
        answerType: 'SCENE_DESCRIPTION',
        policyAssertions: review.assertions,
        expectedEvidenceTypes: review.expectedEvidenceTypes,
      });
      scores[dimension].push(runClaudeDimension(dimension, prompt).score);
    }
    const truth = referenceOcr(review.referenceAnswer);
    if (truth) {
      ocrCases += 1;
      const observed = analysis.ocr ?? analysis.rendered;
      if (normalizeText(observed).includes(normalizeText(truth))) ocrExact += 1;
    }
    process.stderr.write(
      `\r${scores.factualCorrectness.length}/${analyses.length}`,
    );
  }
  process.stderr.write('\n');
  console.log(
    JSON.stringify({
      source,
      frames: analyses.length,
      factualCorrectness: Number(mean(scores.factualCorrectness).toFixed(3)),
      responseRelevancy: Number(mean(scores.responseRelevancy).toFixed(3)),
      ocrReferenceCases: ocrCases,
      ocrContainsReferenceText: ocrExact,
    }),
  );
}

if (require.main === module) main();

module.exports = { normalizeText, referenceOcr, renderAnswer };
