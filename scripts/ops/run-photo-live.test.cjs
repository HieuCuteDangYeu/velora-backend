'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runRow, selectRows, resolveReelId, statusOf } = require('./run-photo-live.cjs');
const photo = require('../../eval/rag/photo-cases-lib.cjs');

const BOT = 'b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7';
const frameRow = {
  id: 'r1', category: 'frame', split: 'dev', caption: '', tags: ['cat:frame'],
  images: [{ file: 'photos/a.jpg', mimeType: 'image/jpeg', bytes: 10 }],
  expect: { outcome: 'RECOMMEND_SOURCE', sourceFixtureId: 'fx', sourceSec: 5 },
};

/** Fake backend: records calls; `fail` makes one path answer with an error. */
function fakeDeps({ fail = {}, reply = { content: 'here', recommended: ['REEL'] } } = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (fail[path]) throw new Error(`${method} ${path} failed (${fail[path]})`);
    if (path === '/conversations') return { id: 'c1' };
    if (path === '/media/upload-url') return { uploadUrl: 'https://r2.invalid/put', key: 'chat-images/u/k.jpg' };
    if (path === '/media/finalize-upload') return { fileKey: 'chat-images/u/k.jpg', fileUrl: 'https://cdn.invalid/k.jpg', mimeType: 'image/jpeg', width: 10, height: 10, status: 'ready' };
    if (path === '/conversations/c1/messages' && method === 'POST') return { id: 'm1', createdAt: '2026-01-01T00:00:00.000Z' };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const wait = async () => (reply ? { id: 'b1', senderId: BOT, content: reply.content, metadata: { recommendedReels: reply.recommended.map((id) => ({ id })) } } : null);
  return { calls, deps: { request, put: async () => {}, readPhoto: (i) => i.file, reelIdFor: () => 'REEL', wait } };
}

test('runRow uploads, finalizes, posts an image message with the placeholder for an empty caption, and scores the reply', async () => {
  const { calls, deps } = fakeDeps();
  const out = await runRow(frameRow, deps);
  assert.deepEqual(calls.map((c) => c.path), ['/conversations', '/media/upload-url', '/media/finalize-upload', '/conversations/c1/messages']);
  assert.deepEqual(calls[1].body, { fileType: 'image/jpeg', purpose: 'chat' });
  const post = calls[3].body;
  assert.equal(post.type, 'image');
  assert.equal(post.content, photo.DEFAULT_CAPTION_PLACEHOLDER);
  assert.equal(post.media.fileKey, 'chat-images/u/k.jpg');
  assert.equal(out.score.pass, true);
  assert.equal(out.score.hit1, true);
  assert.equal(out.reply.answer, 'here');
});

test('a 4xx at finalize is recorded as a clean rejection, not an error', async () => {
  const { deps } = fakeDeps({ fail: { '/media/finalize-upload': 400 } });
  const row = { ...frameRow, expect: { outcome: 'GRACEFUL_ERROR' } };
  const out = await runRow(row, deps);
  assert.deepEqual([out.rejected.stage, out.rejected.status, out.error], ['finalize', 400, undefined]);
  assert.equal(out.score.pass, true);
});

test('a 5xx or a missing reply is a failed attempt', async () => {
  const five = await runRow(frameRow, fakeDeps({ fail: { '/media/upload-url': 503 } }).deps);
  assert.equal(five.error, true);
  assert.equal(five.score.pass, false);
  const silent = await runRow(frameRow, fakeDeps({ reply: null }).deps);
  assert.equal(silent.reply, null);
  assert.equal(silent.score.pass, false);
});

test('selectRows filters by split, category and limit; helpers parse ids and statuses', () => {
  const rows = [{ split: 'dev', category: 'frame' }, { split: 'heldout', category: 'frame' }, { split: 'dev', category: 'edge' }];
  assert.equal(selectRows(rows, { split: 'dev' }).length, 2);
  assert.equal(selectRows(rows, { category: 'edge,offtopic' }).length, 1);
  assert.equal(selectRows(rows, { limit: 1 }).length, 1);
  assert.equal(resolveReelId({ entries: { a: [{ reelId: 'x', success: false }, { reelId: 'y', success: true }] } }, 'a'), 'y');
  assert.equal(resolveReelId({ entries: {} }, 'a'), null);
  assert.equal(statusOf(new Error('POST /x failed (413)')), 413);
  assert.equal(statusOf(new Error('boom')), null);
});
