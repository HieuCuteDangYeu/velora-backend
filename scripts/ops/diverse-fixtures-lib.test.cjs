'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./diverse-fixtures-lib.cjs');

test('durationBand uses the production short cut-off and stable edges', () => {
  assert.equal(lib.durationBand(180), 'under-3min');
  assert.equal(lib.durationBand(181), '3-10min');
  assert.equal(lib.durationBand(599), '3-10min');
  assert.equal(lib.durationBand(600), '10-30min');
  assert.equal(lib.durationBand(1800), '30-60min');
  assert.equal(lib.durationBand(3600), '60-120min');
  assert.equal(lib.durationBand(7200), '60-120min');
  assert.equal(lib.durationBand(7201), 'over-2h');
  assert.throws(() => lib.durationBand(0));
});

test('expectedRoute sends no-audio files to NO_AUDIO regardless of length', () => {
  assert.equal(lib.expectedRoute({ durationSec: 3644, hasAudio: false }), 'NO_AUDIO');
  assert.equal(lib.expectedRoute({ durationSec: 200, hasAudio: true }), 'LONG');
  assert.equal(lib.expectedRoute({ durationSec: 120, hasAudio: true }), 'SHORT');
});

test('the committed sources manifest passes validation and has no duplicates', () => {
  const file = path.join(__dirname, '../../eval/rag/datasets/rag-diverse-sources-v1.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(lib.validateSources(doc), []);
  assert.equal(doc.sources.length, 40);
});

test('validateSources reports bad ids, duplicates and unknown labels', () => {
  const errors = lib.validateSources({
    tag: 't',
    sources: [
      { youtubeId: 'short', genre: 'cooking', language: 'en', audioCondition: 'clean-speech', visualType: 'slides' },
      { youtubeId: 'AAAAAAAAAAA', genre: 'bogus', language: 'en', audioCondition: 'clean-speech', visualType: 'slides' },
      { youtubeId: 'AAAAAAAAAAA', genre: 'cooking', language: 'xx', audioCondition: 'clean-speech', visualType: 'slides' },
    ],
  });
  assert.ok(errors.some((e) => e.includes('not a YouTube id')));
  assert.ok(errors.some((e) => e.includes('genre bogus')));
  assert.ok(errors.some((e) => e.includes('duplicated')));
  assert.ok(errors.some((e) => e.includes('language xx')));
});

test('parseJson3 drops empty and repeated events and joins segments', () => {
  const segs = lib.parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'hello ' }, { utf8: 'world' }] },
      { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'hello world' }] },
      { tStartMs: 3000, dDurationMs: 500, segs: [{ utf8: 'next  line' }] },
      { tStartMs: 4000 },
    ],
  });
  assert.deepEqual(segs, [
    { startSec: 0, endSec: 2, text: 'hello world' },
    { startSec: 3, endSec: 3.5, text: 'next line' },
  ]);
});

test('referenceTier prefers manual subtitles, then auto-captions, by language', () => {
  assert.equal(lib.referenceTier({ subtitles: { en: [{}] }, automatic_captions: { en: [{}] } }, 'en'), 'manual');
  assert.equal(lib.referenceTier({ automatic_captions: { 'en-orig': [{}] } }, 'en'), 'auto-caption');
  assert.equal(lib.referenceTier({ subtitles: { fr: [{}] } }, 'en'), 'none');
  assert.equal(lib.referenceTier({ subtitles: { en: [{}] } }, 'none'), 'none');
});

test('chaptersFrom maps yt-dlp chapters and tolerates none', () => {
  assert.deepEqual(lib.chaptersFrom({ chapters: [{ start_time: 0, end_time: 5, title: 'A' }] }), [
    { startSec: 0, endSec: 5, title: 'A' },
  ]);
  assert.deepEqual(lib.chaptersFrom({}), []);
});

test('validateSources checks derived fixtures point at a listed source', () => {
  const src = { youtubeId: 'AAAAAAAAAAA', genre: 'cooking', language: 'en', audioCondition: 'clean-speech', visualType: 'slides' };
  assert.deepEqual(lib.validateSources({ tag: 't', sources: [src], derived: [{ id: 'd', from: 'AAAAAAAAAAA', op: 'strip-audio' }] }), []);
  const errors = lib.validateSources({ tag: 't', sources: [src], derived: [{ id: 'd', from: 'BBBBBBBBBBB', op: 'mute' }] });
  assert.ok(errors.some((e) => e.includes('not a listed source')));
  assert.ok(errors.some((e) => e.includes('op mute')));
});
