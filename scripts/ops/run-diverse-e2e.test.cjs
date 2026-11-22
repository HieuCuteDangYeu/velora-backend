'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { askOne } = require('./run-diverse-e2e.cjs');

const row = { id: 'r1', type: 'detail', question: 'q?', fixtureId: 'diverse-x', gold: { startSec: 10, endSec: 60 }, stratum: { genre: 'tutorial', durationBand: '3-10min', audioCondition: 'clean-speech', visualType: 'slides', language: 'en' }, referenceTier: 'manual', crossLingual: false };

function fakeBackend() {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/conversations') return { id: 'c1' };
    if (path.endsWith('/messages')) return { id: 'm1', createdAt: '2026-01-01T00:00:00Z' };
    return {};
  };
  const wait = async () => ({ id: 'b1', content: 'answer', metadata: { citations: [{ reelId: 'R', startTime: 20, endTime: 40 }] } });
  return { calls, request, wait };
}

test('reel scope shares the gold reel with the bot, then scores the cited moment', async () => {
  const { calls, request, wait } = fakeBackend();
  const item = await askOne(request, row, 'R', 600, { wait });
  assert.ok(calls.some((c) => c.path === '/content/reels/R/share' && c.body.conversationId === 'c1'));
  assert.equal(item.score.momentHit, true);
  assert.equal(item.reply.answer, 'answer');
});

test('whole scope shares nothing', async () => {
  const { calls, request, wait } = fakeBackend();
  await askOne(request, row, 'R', 600, { wait, scope: 'whole' });
  assert.ok(!calls.some((c) => c.path.includes('/share')));
});

test('a backend failure is recorded on the item, not thrown', async () => {
  const request = async () => { throw new Error('POST /conversations failed (500)'); };
  const item = await askOne(request, row, 'R', 600, { wait: async () => null });
  assert.match(item.error, /500/);
  assert.equal(item.score.answered, false);
});

test('grounded phrasing names the shared video in the message', async () => {
  const { calls, request, wait } = fakeBackend();
  await askOne(request, row, 'R', 600, { wait, grounded: true });
  const sent = calls.find((c) => c.path.endsWith('/messages'));
  assert.match(sent.body.content, /^About the video I just shared: q\?$/);
});
