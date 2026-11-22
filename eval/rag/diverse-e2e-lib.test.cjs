'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('./diverse-e2e-lib.cjs');

const row = (over = {}) => ({
  id: 'r1', type: 'detail', fixtureId: 'diverse-x', gold: { startSec: 100, endSec: 150 }, referenceTier: 'manual', crossLingual: false,
  stratum: { genre: 'tutorial', durationBand: '10-30min', audioCondition: 'clean-speech', visualType: 'slides', language: 'en' }, ...over,
});
const cite = (reelId, startTime, endTime) => ({ reelId, startTime, endTime });

test('moment hit needs the right reel and an overlapping span', () => {
  const hit = lib.scoreReply(row(), { answer: 'ok', citations: [cite('A', 110, 140)] }, { reelId: 'A', durationSec: 600 });
  assert.equal(hit.momentHit, true);
  const wrongReel = lib.scoreReply(row(), { answer: 'ok', citations: [cite('B', 110, 140)] }, { reelId: 'A', durationSec: 600 });
  assert.deepEqual([wrongReel.citedReel, wrongReel.momentHit], [false, false]);
  const wrongMoment = lib.scoreReply(row(), { answer: 'ok', citations: [cite('A', 300, 340)] }, { reelId: 'A', durationSec: 600 });
  assert.deepEqual([wrongMoment.citedReel, wrongMoment.momentHit], [true, false]);
});

test('citation times in milliseconds are read as seconds', () => {
  const s = lib.scoreReply(row(), { answer: 'ok', citations: [cite('A', 110_000, 140_000)] }, { reelId: 'A', durationSec: 600 });
  assert.equal(s.momentHit, true);
});

test('no reply, unbound rows and refusals', () => {
  assert.equal(lib.scoreReply(row(), null, { reelId: 'A' }).answered, false);
  assert.equal(lib.scoreReply(row(), null, { reelId: null }).unbound, true);
  assert.equal(lib.scoreReply(row(), { answer: "I can't verify that from the video.", citations: [] }, { reelId: 'A' }).refused, true);
});

test('pickRows spreads rows per video and type, and drops other verdicts', () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) rows.push(row({ id: `d${i}`, status: 'REVIEWED', review: { verdict: 'answered' }, split: 'dev' }));
  rows.push(row({ id: 'u', status: 'REVIEWED', review: { verdict: 'unanswerable' }, split: 'dev' }));
  const picked = lib.pickRows(rows, { perVideoPerType: 2, verdict: 'answered' });
  assert.equal(picked.length, 2);
  assert.ok(!picked.some((r) => r.id === 'u'));
});

test('summarize cuts by tag, marks small cells indicative, averages judge scores', () => {
  const items = [
    { row: row(), score: { answered: true, citedReel: true, momentHit: true, refused: false }, judge: { factualCorrectness: 1, responseRelevancy: 1 } },
    { row: row(), score: { answered: true, citedReel: true, momentHit: false, refused: false }, judge: { factualCorrectness: 0.2, responseRelevancy: 0.5 } },
    { row: row(), score: { unbound: true } },
  ];
  const s = lib.summarize(items);
  assert.equal(s.overall.n, 2);
  assert.equal(s.overall.momentHitRate, 0.5);
  assert.equal(s.overall.correctRate, 0.5);
  assert.equal(s.overall.indicative, true);
  assert.equal(s.byTag['type:detail'].n, 2);
});

test('the strict-scope refusal is counted apart from an honest "cannot verify"', () => {
  const s = lib.scoreReply(row(), { answer: 'I can only help with Velora: its Reels and videos.', citations: [] }, { reelId: 'A' });
  assert.equal(s.scopeRefused, true);
  const ok = lib.summarize([{ row: row(), reply: { answer: 'I can only help with Velora.' }, score: s }]);
  assert.equal(ok.overall.scopeRefusalRate, 1);
});
