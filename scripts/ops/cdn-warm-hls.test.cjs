'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { firstUris, initUri, percentile, parseArgs } = require('./cdn-warm-hls.cjs');

test('firstUris returns playlist URI lines in order, skipping tags and blanks', () => {
  const playlist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n480p/index.m3u8\n\n#EXT-X-STREAM-INF:BANDWIDTH=2\n720p/index.m3u8\n';
  assert.deepEqual(firstUris(playlist), ['480p/index.m3u8', '720p/index.m3u8']);
  assert.deepEqual(firstUris(playlist, 1), ['480p/index.m3u8']);
});

test('initUri reads the fMP4 init segment of a media playlist and is null without one', () => {
  assert.equal(initUri('#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="700@0"\n#EXTINF:4,\nseg0.m4s\n'), 'init.mp4');
  assert.equal(initUri('#EXTM3U\n#EXTINF:4,\nseg0.ts\n'), null);
});

test('percentile and parseArgs behave', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.deepEqual(parseArgs(['--concurrency', '4', '--base-url=https://x.test', '--flag']), { concurrency: '4', 'base-url': 'https://x.test', flag: 'true' });
});
