'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepare } = require('./prepare-rag-review-packet.cjs');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

test('builds a review packet without treating generated output as gold', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-review-packet-'));
  const dataset = path.join(root, 'dataset');
  const baseline = path.join(root, 'baseline');
  const candidate = path.join(root, 'candidate');
  const output = path.join(root, 'packet.json');
  try {
    const row = {
      id: 'case-1',
      input: { question: 'What is visible at 4 seconds?' },
      expectedOutput: {
        referenceAnswer: 'A blue chair.',
        relevantEvidenceIds: ['reel:r:visual:1'],
        expectedEvidenceTypes: ['VISUAL'],
      },
      metadata: { split: 'DEVELOPMENT', requiresImageReview: true, referenceStartSec: 4 },
    };
    const response = {
      caseId: 'case-1',
      output: { answer: 'A chair.', citations: [] },
      trace: {
        retrievedChunkIds: ['reel:r:visual:1'],
        workflowMetrics: {
          diagnostics: {
            generationEvidence: [{ sourceId: 'reel:r:visual:1', evidenceText: 'A blue chair.' }],
            routeDecision: { intent: 'REEL_VIDEO_QUESTION' },
          },
        },
      },
    };
    const calibration = {
      version: 'v1',
      status: 'HUMAN_REVIEW_REQUIRED',
      cases: [{
        caseId: 'case-1',
        bucket: 'VISUAL',
        question: row.input.question,
        referenceAnswer: row.expectedOutput.referenceAnswer,
        relevantEvidenceIds: row.expectedOutput.relevantEvidenceIds,
        expectedEvidenceTypes: row.expectedOutput.expectedEvidenceTypes,
        requiresImageReview: true,
        reviewedLabel: null,
      }],
    };
    for (const split of ['development', 'held_out']) {
      write(path.join(dataset, `${split}.json`), split === 'development' ? [row] : []);
      write(path.join(dataset, `${split}-fixtures.json`), split === 'development'
        ? { 'case-1': { scenes: [{ id: 'reel:r:visual:1', evidenceText: 'A blue chair.', startTime: 4 }] } }
        : {});
    }
    write(path.join(root, 'calibration.json'), calibration);
    for (const dir of [baseline, candidate]) {
      write(path.join(dir, 'responses.jsonl'), `${JSON.stringify(response)}\n`);
    }

    const packet = prepare({
      datasetDir: dataset,
      calibrationPath: path.join(root, 'calibration.json'),
      baselineRunDir: baseline,
      candidateRunDir: candidate,
      outputPath: output,
    });

    assert.equal(packet.status, 'REVIEW_REQUIRED');
    assert.equal(packet.cases.length, 1);
    assert.equal(packet.cases[0].review.reviewedLabel, null);
    assert.equal(packet.cases[0].requiresImageReview, true);
    assert.equal(packet.cases[0].source.imageReview.status, 'IMAGE_ASSET_NOT_CAPTURED_IN_PACKET');
    assert.equal(packet.cases[0].candidate.answer, 'A chair.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
