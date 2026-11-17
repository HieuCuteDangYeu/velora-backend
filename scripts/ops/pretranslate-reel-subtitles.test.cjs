'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { describeResult, parseArgs, summarize } = require('./pretranslate-reel-subtitles.cjs');

test('defaults to a safe preview of ten reels', () => {
  assert.deepEqual(parseArgs([]), { apply: false, limit: 10, after: undefined, help: false });
});

test('--apply and --resume run it, --dry-run previews it, and a cursor can be given', () => {
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.equal(parseArgs(['--resume']).apply, true);
  assert.equal(parseArgs(['--apply', '--dry-run']).apply, false);
  assert.equal(parseArgs(['--after=abc']).after, 'abc');
  assert.equal(parseArgs(['--limit=500']).limit, 500);
});

test('rejects unknown options, bad limits and an empty cursor', () => {
  assert.throws(() => parseArgs(['--force']), /Unknown option/);
  for (const bad of ['--limit=0', '--limit=501', '--limit=1.5', '--limit=abc']) {
    assert.throws(() => parseArgs([bad]), /--limit/);
  }
  assert.throws(() => parseArgs(['--after=']), /--after/);
});

test('describes what happened to one reel', () => {
  assert.equal(
    describeResult({ translated: ['vi'], alreadyStored: ['en'], failed: [] }),
    'translated vi · stored en',
  );
  assert.equal(describeResult({ translated: [], alreadyStored: [], failed: ['en'] }), 'FAILED en');
  assert.equal(describeResult({ translated: [], alreadyStored: [], failed: [] }), 'nothing to translate');
  assert.equal(describeResult({ skipped: 'no_transcript' }), 'skipped (no_transcript)');
});

test('totals the run and flags reels that need another pass', () => {
  assert.deepEqual(
    summarize([
      { result: { translated: ['vi', 'en'], alreadyStored: [], failed: [] } },
      { result: { translated: [], alreadyStored: ['vi'], failed: ['en'] } },
      { result: { skipped: 'no_transcript', translated: [], alreadyStored: [], failed: [] } },
      { result: { skipped: 'error', translated: [], alreadyStored: [], failed: [] } },
    ]),
    { translated: 2, alreadyStored: 1, failed: 1, skipped: 2, reelsWithFailures: 2 },
  );
});
