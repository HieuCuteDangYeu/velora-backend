'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { apply } = require('./apply-rag-review-sheet.cjs');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

test('applies completed labels and derives the image truth gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-review-apply-'));
  try {
    const calibrationPath = path.join(root, 'calibration.json');
    const visualPath = path.join(root, 'visual.json');
    write(calibrationPath, {
      status: 'HUMAN_REVIEW_REQUIRED',
      cases: [
        { caseId: 'visual', requiresImageReview: true, reviewedLabel: null },
        { caseId: 'text', requiresImageReview: false, reviewedLabel: null },
      ],
    });
    write(visualPath, { status: 'PASS', cases: 2 });
    write(path.join(root, 'sheet.tsv'), [
      'caseId\tbucket\tquestion\treviewedLabel\timageTruth\treviewNotes',
      'visual\tVISUAL\tframe?\tPASS\tPASS\tlooks correct',
      'text\tTRANSCRIPT\tquote?\tPASS\t\tgrounded',
      '',
    ].join('\n'));
    const applied = apply({
      sheetPath: path.join(root, 'sheet.tsv'),
      calibrationPath,
      calibrationOutputPath: path.join(root, 'calibration-out.json'),
      visualContractPath: visualPath,
      visualContractOutputPath: path.join(root, 'visual-out.json'),
      reviewerId: 'reviewer-a',
      reviewedAt: '2026-10-20T00:00:00Z',
      independentReviewerId: 'reviewer-b',
      independentReviewedAt: '2026-10-20T01:00:00Z',
      independentStatus: 'PASS',
    });
    assert.equal(applied.imageTruthStatus, 'PASS');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'calibration-out.json'))).independentReview, 'PASS');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'visual-out.json'))).imageTruthStatus, 'PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
