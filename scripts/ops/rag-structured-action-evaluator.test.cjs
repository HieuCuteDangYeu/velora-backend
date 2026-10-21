'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateRecommendation,
} = require('./rag-structured-action-evaluator.cjs');

test('validates accessible relevant Reel recommendations', () => {
  const row = {
    input: { question: 'Recommend more clips about dogs.' },
    metadata: { expectedRecommendationAction: 'RECOMMEND_REELS' },
  };
  const fixture = {
    recommendations: [{ id: 'dog-1', title: 'Dogs', tags: ['dogs'] }],
  };
  assert.deepEqual(
    evaluateRecommendation({
      row,
      fixture,
      output: {
        answer: 'Here are accessible Reels:\n- Dogs',
        recommendedReels: [{ id: 'dog-1', title: 'Dogs' }],
        suggestedQueries: [],
      },
    }).pass,
    true,
  );
  assert.equal(
    evaluateRecommendation({
      row,
      fixture,
      output: { recommendedReels: [{ id: 'private' }], suggestedQueries: [] },
    }).pass,
    false,
  );
});

test('validates query suggestions separately from recommendations', () => {
  const row = {
    input: { question: 'Suggest search queries for clips about dogs.' },
    metadata: { expectedRecommendationAction: 'SUGGEST_QUERIES' },
  };
  assert.equal(
    evaluateRecommendation({
      row,
      fixture: {},
      output: {
        answer: 'Try these searches:\n- dog training clips',
        recommendedReels: [],
        suggestedQueries: ['dog training clips'],
      },
    }).pass,
    true,
  );
});

test('rejects free-form recommendation claims that do not match returned Reels', () => {
  const row = {
    input: { question: 'Recommend more clips about dogs.' },
    metadata: { expectedRecommendationAction: 'RECOMMEND_REELS' },
  };
  const result = evaluateRecommendation({
    row,
    fixture: {
      recommendations: [{ id: 'dog-1', title: 'Dogs', tags: ['dogs'] }],
    },
    output: {
      answer: 'Try this clip:\n- Puppy Playtime with sign language',
      recommendedReels: [{ id: 'dog-1', title: 'Dogs' }],
      suggestedQueries: [],
    },
  });

  assert.equal(result.actionPass, true);
  assert.equal(result.prosePass, false);
  assert.equal(result.pass, false);
});
