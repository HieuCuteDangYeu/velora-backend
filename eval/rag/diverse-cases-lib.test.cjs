'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('./diverse-cases-lib.cjs');

const seg = (startSec, endSec, text) => ({ startSec, endSec, text });
const fixture = (id, band = '10-30min', extra = {}) => ({
  id, durationSec: 1200,
  stratum: { genre: 'tutorial', language: 'en', durationBand: band, audioCondition: 'clean-speech',
    visualType: 'slides', referenceTier: 'manual', ...extra },
});
const constantRandom = () => 0;

test('formatClock uses mm:ss and switches to h:mm:ss at one hour', () => {
  assert.equal(lib.formatClock(0), '0:00');
  assert.equal(lib.formatClock(754), '12:34');
  assert.equal(lib.formatClock(3600), '1:00:00');
  assert.equal(lib.formatClock(4507), '1:15:07');
});

test('buildWindows closes on the target length and on long silences', () => {
  const segments = [seg(0, 10, 'a'), seg(10, 30, 'b'), seg(30, 46, 'c'), seg(100, 110, 'd')];
  const w = lib.buildWindows(segments, { targetSec: 45, gapSec: 8 });
  assert.deepEqual(w.map((x) => [x.startSec, x.endSec, x.text]), [
    [0, 46, 'a b c'],
    [100, 110, 'd'],
  ]);
});

test('buildWindows joins CJK without spaces', () => {
  const w = lib.buildWindows([seg(0, 5, '你好世界'), seg(5, 9, '今天学习')]);
  assert.equal(w[0].text, '你好世界今天学习');
});

test('eligibleWindows halves the minimum length for CJK text', () => {
  const en = { startSec: 0, endSec: 1, text: 'x'.repeat(100) };
  const zh = { startSec: 0, endSec: 1, text: '汉'.repeat(100) };
  assert.equal(lib.eligibleWindows([en], { minChars: 160 }).length, 0);
  assert.equal(lib.eligibleWindows([zh], { minChars: 160 }).length, 1);
});

test('pickSpread draws at most one window per time bin across the video', () => {
  const windows = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((s) => ({ startSec: s, endSec: s + 40, text: 't' }));
  const picked = lib.pickSpread(windows, 4, 1000, constantRandom);
  assert.equal(picked.length, 4);
  const bins = picked.map((w) => Math.floor(((w.startSec + w.endSec) / 2) / 250));
  assert.deepEqual(bins, [0, 1, 2, 3]);
  assert.deepEqual(lib.pickSpread([], 3, 1000, constantRandom), []);
});

test('assignVideoSplits is deterministic and uses both splits inside each band', () => {
  const fixtures = ['a', 'b', 'c', 'd', 'e'].map((x) => fixture(x));
  const one = lib.assignVideoSplits(fixtures, { seed: 's' });
  const two = lib.assignVideoSplits(fixtures, { seed: 's' });
  assert.deepEqual([...one], [...two]);
  const counts = [...one.values()].reduce((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { heldout: 2, dev: 3 });
});

test('templatedRows makes an opening, spread timestamps and chapter rows', () => {
  const text = (n) => `sentence number ${n} `.repeat(14);
  const windows = [0, 70, 400, 900].map((s, i) => ({ startSec: s, endSec: s + 40, text: text(i) }));
  const rows = lib.templatedRows({
    fixture: fixture('f1'), windows,
    chapters: [
      { startSec: 380, endSec: 700, title: 'Setup' },
      { startSec: 0, endSec: 380, title: '<Untitled Chapter 1>' },
      { startSec: 700, endSec: 710, title: 'Too short' },
    ],
    split: 'dev', random: constantRandom, timestampCount: 2,
  });
  const types = rows.map((r) => r.type);
  assert.equal(types.filter((t) => t === 'opening').length, 1);
  assert.ok(types.filter((t) => t === 'timestamp').length >= 1);
  const chapters = rows.filter((r) => r.type === 'chapter');
  assert.equal(chapters.length, 1);
  assert.match(chapters[0].question, /"Setup"/);
  assert.deepEqual(chapters[0].gold, { startSec: 380, endSec: 700 });
  assert.ok(rows.every((r) => r.split === 'dev' && r.status === 'CANDIDATE' && r.textHash));
  assert.deepEqual(lib.validateRows(rows), []);
});

test('timestamp questions never target the opening minute', () => {
  const windows = [0, 30, 90, 600].map((s) => ({ startSec: s, endSec: s + 40, text: 'word '.repeat(60) }));
  const rows = lib.templatedRows({ fixture: fixture('f2'), windows, chapters: [], split: 'dev', random: constantRandom });
  for (const r of rows.filter((x) => x.type === 'timestamp')) assert.ok(r.gold.startSec > 60);
});

test('non-English audio makes templated English questions cross-lingual', () => {
  const windows = [0, 100].map((s) => ({ startSec: s, endSec: s + 40, text: 'palabra '.repeat(40) }));
  const rows = lib.templatedRows({
    fixture: fixture('f3', '10-30min', { language: 'es' }), windows, chapters: [],
    split: 'dev', random: constantRandom,
  });
  assert.ok(rows.length > 0 && rows.every((r) => r.crossLingual === true && r.audioLanguage === 'es'));
});

test('validateRows catches bad gold, missing reference tier and split drift', () => {
  const good = lib.detailRow({
    fixture: fixture('f4'), window: { startSec: 10, endSec: 50, text: 'hello there' },
    question: 'What is said?', questionLanguage: 'en', split: 'dev', generator: 'g',
  });
  assert.deepEqual(lib.validateRows([good]), []);
  const bad = { ...good, id: 'x', question: 'Other?', gold: { startSec: 5, endSec: 5 }, referenceTier: 'none', split: 'heldout' };
  const errors = lib.validateRows([good, bad]);
  assert.ok(errors.some((e) => e.includes('gold interval invalid')));
  assert.ok(errors.some((e) => e.includes('referenceTier')));
  assert.ok(errors.some((e) => e.includes('both splits')));
});

test('isIntervalHit needs real overlap and ignores hits without a time span', () => {
  const gold = { startSec: 100, endSec: 140 };
  assert.equal(lib.isIntervalHit({ startTime: 90, endTime: 110 }, gold), true);
  assert.equal(lib.isIntervalHit({ startTime: 0, endTime: 300 }, gold), true);
  assert.equal(lib.isIntervalHit({ startTime: 138, endTime: 200 }, gold), false);
  assert.equal(lib.isIntervalHit({ startTime: 140, endTime: 200 }, gold), false);
  assert.equal(lib.isIntervalHit({}, gold), false);
  // A short gold interval (8 s) needs 30% of itself, i.e. 2.4 s of overlap.
  assert.equal(lib.isIntervalHit({ startTime: 100, endTime: 102 }, { startSec: 100, endSec: 108 }), false);
  assert.equal(lib.isIntervalHit({ startTime: 100, endTime: 103 }, { startSec: 100, endSec: 108 }), true);
});

test('templatedRows caps chapter questions, spreads them, and skips over-long titles', () => {
  const windows = Array.from({ length: 10 }, (_, i) => ({ startSec: i * 100, endSec: i * 100 + 90, text: 'content '.repeat(40) }));
  const chapters = Array.from({ length: 10 }, (_, i) => ({ startSec: i * 100, endSec: i * 100 + 100, title: `Part ${i}` }));
  chapters.push({ startSec: 1000, endSec: 1100, title: 'x'.repeat(101) });
  const rows = lib.templatedRows({ fixture: fixture('f5'), windows, chapters, split: 'dev', random: constantRandom })
    .filter((r) => r.type === 'chapter');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.gold.startSec), [0, 300, 600]);
  assert.ok(rows.every((r) => !r.question.includes('xxxx')));
});

test('rows carry no caption text, and referenceTextFor rebuilds the hashed text from overlapping captions', () => {
  // Auto captions overlap: the second segment starts before the first one ends.
  const segments = [seg(0, 20, 'intro words here '.repeat(12)), seg(18, 40, 'secret caption words '.repeat(10)), seg(100, 120, 'later part '.repeat(20))];
  const windows = lib.buildWindows(segments);
  const row = lib.detailRow({
    fixture: fixture('f6'), window: windows[0],
    question: 'What is said?', questionLanguage: 'en', split: 'dev', generator: 'g',
  });
  assert.equal(JSON.stringify(row).includes('secret caption'), false);
  const sem = require('./semantic-live-eval-lib.cjs');
  assert.equal(sem.textHash(lib.referenceTextFor(segments, row)), row.textHash);
  assert.notEqual(lib.referenceTextFor(segments, { ...row, gold: { startSec: 1, endSec: 2 } }), windows[0].text);
});

test('referenceTextFor joins the windows inside a chapter row', () => {
  const segments = [seg(0, 30, 'one '.repeat(60)), seg(60, 90, 'two '.repeat(60)), seg(300, 330, 'three '.repeat(60))];
  const windows = lib.buildWindows(segments);
  const [row] = lib.templatedRows({
    fixture: fixture('f7'), windows, chapters: [{ startSec: 0, endSec: 120, title: 'First half' }],
    split: 'dev', random: constantRandom, timestampCount: 0,
  }).filter((r) => r.type === 'chapter');
  const sem = require('./semantic-live-eval-lib.cjs');
  assert.equal(sem.textHash(lib.referenceTextFor(segments, row)), row.textHash);
});
