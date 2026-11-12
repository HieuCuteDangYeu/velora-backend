'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const lib = require('../../eval/rag/semantic-live-eval-lib.cjs');
const {
  applySheet,
  buildSheet,
  parseCsv,
  proposeExtras,
  toCsv,
} = require('./review-semantic-live-cases.cjs');

const row = (n, extra = {}) => ({
  id: `sem-live-${n}`,
  datasetVersion: lib.DATASET_VERSION,
  question: `Why did the narrator do thing number ${n}?`,
  language: 'en',
  source: 'synthetic',
  status: 'CANDIDATE',
  split: 'dev',
  seriesId: `series-${n}`,
  tags: ['paraphrase'],
  relevant: [{ evidenceId: `reel:r${n}:chunk:0`, grade: 2 }],
  ...extra,
});

const texts = new Map([
  ['reel:r1:chunk:0', 'He said "hello", then left,\nand never came back.'],
  ['reel:r1:chunk:1', 'A neighbouring passage.'],
  ['reel:r2:chunk:0', 'Second gold.'],
]);

test('CSV survives quotes, commas and newlines in transcript text', () => {
  const sheet = buildSheet([row(1)], texts);
  const parsed = parseCsv(toCsv(sheet));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].goldText, texts.get('reel:r1:chunk:0'));
  assert.throws(() => parseCsv('a,b\r\n1,2\r\n'), /sheet header/);
});

test('buildSheet shows the text of each suggested chunk', () => {
  const sheet = buildSheet(
    [
      row(1, {
        proposedRelevant: [{ evidenceId: 'reel:r1:chunk:1', grade: 2 }],
      }),
    ],
    texts,
  );
  assert.match(
    sheet[0].proposalText,
    /^\[1\] \(grade 2\) A neighbouring passage\./,
  );
  assert.equal(parseCsv(toCsv(sheet))[0].proposalText, sheet[0].proposalText);
});

test('parseCsv refuses a sheet whose cells were split into extra columns', () => {
  const sheet = buildSheet([row(1)], texts);
  const good = toCsv(sheet);
  assert.equal(parseCsv(good).length, 1);
  const lines = good.split('\r\n');
  lines[1] += ',spilled over,from a split cell';
  assert.throws(() => parseCsv(lines.join('\r\n')), /past the last column/);
  // Empty trailing columns, as some spreadsheets add, are harmless.
  lines[1] = good.split('\r\n')[1] + ',,';
  assert.equal(parseCsv(lines.join('\r\n')).length, 1);
});

test('suggestions are listed one per line, with no separator a spreadsheet splits on', () => {
  const sheet = buildSheet(
    [
      row(1, {
        proposedRelevant: [
          { evidenceId: 'a', grade: 1 },
          { evidenceId: 'b', grade: 2 },
        ],
      }),
    ],
    texts,
  );
  assert.equal(sheet[0].proposals, 'a|1\nb|2');
});

test('buildSheet lists only candidates', () => {
  const sheet = buildSheet([row(1), row(2, { status: 'REJECTED' })], texts);
  assert.deepEqual(
    sheet.map((s) => s.caseId),
    ['sem-live-1'],
  );
});

test('applySheet reviews, rejects, skips, and merges accepted proposals', () => {
  const rows = [
    row(1, { proposedRelevant: [{ evidenceId: 'reel:r1:chunk:1', grade: 1 }] }),
    row(2),
    row(3),
  ];
  const sheet = parseCsv(toCsv(buildSheet(rows, texts)));
  sheet[0].verdict = 'accept';
  sheet[0].acceptProposals = 'Y';
  sheet[0].notes = 'checked against the video';
  sheet[1].verdict = 'REJECT';
  const { rows: next, counts } = applySheet(rows, sheet, {
    reviewerId: 'rev-1',
    reviewedAt: '2026-11-12T00:00:00Z',
  });
  assert.deepEqual(counts, { accepted: 1, rejected: 1, skipped: 1 });
  assert.equal(next[0].status, 'REVIEWED');
  assert.deepEqual(
    next[0].relevant.map((r) => [r.evidenceId, r.grade]),
    [
      ['reel:r1:chunk:0', 2],
      ['reel:r1:chunk:1', 1],
    ],
  );
  assert.equal(next[0].proposedRelevant, undefined);
  assert.equal(next[0].review.notes, 'checked against the video');
  assert.equal(next[1].status, 'REJECTED');
  assert.equal(next[2].status, 'CANDIDATE');
  assert.deepEqual(
    lib.validateDataset(next.filter((r) => r.status !== 'REJECTED')),
    [],
  );
});

test('applySheet refuses a bad verdict, an already-reviewed row and a stale sheet', () => {
  const rows = [row(1)];
  const base = parseCsv(toCsv(buildSheet(rows, texts)));
  const who = { reviewerId: 'rev-1', reviewedAt: '2026-11-12T00:00:00Z' };
  assert.throws(
    () => applySheet(rows, [{ ...base[0], verdict: 'maybe' }], who),
    /ACCEPT or REJECT/,
  );
  assert.throws(
    () =>
      applySheet(
        rows,
        [
          {
            ...base[0],
            verdict: 'ACCEPT',
            goldEvidenceId: 'reel:other:chunk:0',
          },
        ],
        who,
      ),
    /gold chunk differs/,
  );
  assert.throws(
    () =>
      applySheet(
        [row(1, { status: 'REVIEWED' })],
        [{ ...base[0], verdict: 'ACCEPT' }],
        who,
      ),
    /only CANDIDATE/,
  );
  assert.throws(
    () =>
      applySheet(rows, [{ ...base[0], verdict: 'ACCEPT' }], {
        reviewedAt: 'x',
      }),
    /--reviewer/,
  );
});

test('proposeExtras grades unseen top hits and keeps relevant untouched', async () => {
  const rows = [
    row(1),
    row(2, {
      status: 'REVIEWED',
      review: { reviewerId: 'r', reviewedAt: 'x' },
    }),
  ];
  const run = {
    perCase: [
      {
        id: 'sem-live-1',
        retrieval: {
          ranked: [
            'reel:r1:chunk:0',
            'reel:r1:chunk:1',
            'reel:missing:chunk:0',
          ],
        },
        rerank: { ranked: ['reel:r1:chunk:1', 'reel:r1:chunk:0'] },
      },
    ],
  };
  const asked = [];
  const { rows: next, asked: n } = await proposeExtras(rows, {
    run,
    textById: texts,
    askFn: async (_q, passage) => {
      asked.push(passage);
      return 1;
    },
  });
  assert.equal(
    n,
    1,
    'gold and chunks absent from the snapshot are not graded; the overlap is graded once',
  );
  assert.deepEqual(next[0].proposedRelevant, [
    { evidenceId: 'reel:r1:chunk:1', grade: 1 },
  ]);
  assert.deepEqual(next[0].relevant, rows[0].relevant);
  assert.equal(next[1].proposedRelevant, undefined);
});
