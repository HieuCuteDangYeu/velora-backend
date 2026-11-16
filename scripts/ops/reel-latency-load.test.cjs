'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, percentile, summarize, parseMasterPlaylist, parseMediaPlaylist, evaluateSlos } = require('./reel-latency-load.cjs');

test('percentile uses nearest rank and ignores non-finite values', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([NaN, 7], 0.5), 7);
});

test('summarize counts errors by status and only times successful samples', () => {
  const stats = summarize([
    { ok: true, ms: 100 },
    { ok: true, ms: 300 },
    { ok: false, status: 500, ms: 9000 },
    { ok: false, status: null, error: 'ETIMEDOUT', ms: 9000 },
  ]);
  assert.equal(stats.count, 4);
  assert.equal(stats.errorRate, 0.5);
  assert.deepEqual(stats.errors, { 500: 1, ETIMEDOUT: 1 });
  assert.equal(stats.max, 300);
});

test('parseArgs handles inline and spaced values', () => {
  assert.deepEqual(parseArgs(['--stages=1,5', '--scenarios', 'feed,rag', '--flag']), { stages: '1,5', scenarios: 'feed,rag', flag: 'true' });
});

test('master playlist yields variants in listed order with absolute URLs', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=480x854\n480p/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=720x1280\n720p/index.m3u8\n';
  const variants = parseMasterPlaylist(master, 'https://cdn.example/reels/a/master.m3u8');
  assert.equal(variants.length, 2);
  assert.equal(variants[0].url, 'https://cdn.example/reels/a/480p/index.m3u8');
  assert.equal(variants[0].bandwidth, 800000);
  assert.equal(variants[1].resolution, '720x1280');
});

test('media playlist yields the init map and first segment', () => {
  const media = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nseg0.m4s\n#EXTINF:4.0,\nseg1.m4s\n';
  assert.deepEqual(parseMediaPlaylist(media, 'https://cdn.example/a/480p/index.m3u8'), {
    init: 'https://cdn.example/a/480p/init.mp4',
    segment: 'https://cdn.example/a/480p/seg0.m4s',
  });
  assert.deepEqual(parseMediaPlaylist('#EXTM3U\n#EXTINF:4,\nseg0.ts\n', 'https://c/x/i.m3u8'), { init: null, segment: 'https://c/x/seg0.ts' });
});

test('SLO evaluation applies the api default to api_* scenarios and flags errors', () => {
  const report = { stages: { s1: { api_feed_cold: { p95: 650, count: 10, errorRate: 0 }, stream_startup: { p95: 900, count: 10, errorRate: 0.02 }, hls_master: { p95: 5000, count: 3, errorRate: 0 } } } };
  const checks = evaluateSlos(report, { api: 500, stream_startup: 1200, errorRate: 0.01 });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c.pass]));
  assert.equal(byName['s1/api_feed_cold p95'], false);
  assert.equal(byName['s1/stream_startup p95'], true);
  assert.equal(byName['s1/stream_startup errorRate'], false);
  assert.equal('s1/hls_master p95' in byName, false);
});
