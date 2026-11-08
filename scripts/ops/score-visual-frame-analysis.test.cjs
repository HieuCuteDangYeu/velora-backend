'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeText,
  referenceOcr,
  renderAnswer,
} = require('./score-visual-frame-analysis.cjs');

test('extracts the reviewed on-screen text from a reference answer', () => {
  assert.equal(
    referenceOcr('A man in a robe.\nReadable text: “Stay still”.'),
    'Stay still',
  );
  assert.equal(
    referenceOcr('A man.\nReadable text: none clearly legible.'),
    undefined,
  );
  assert.equal(referenceOcr(null), undefined);
});

test('compares on-screen text ignoring case and punctuation', () => {
  assert.equal(normalizeText('Stay,  STILL!'), 'stay still');
  assert.ok(
    normalizeText('Stay still. stone archway').includes(
      normalizeText('Stay still'),
    ),
  );
});

test('renders an analysis as an answer-like description', () => {
  assert.equal(
    renderAnswer({
      caption: 'A man.',
      ocrText: 'Hi',
      objects: ['coat', 'hat'],
    }),
    'A man.\nReadable text: “Hi”\ncoat hat',
  );
  assert.equal(renderAnswer({ caption: 'A man.', objects: [] }), 'A man.');
});
