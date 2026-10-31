'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  sourceUrl, download, selectVariant, parseMedia, validateTs, mediaShape, frameFingerprint, verifyRemux, verifyEncodedTimelines,
} = require('./materialize-existing-hls.cjs');

const base = 'https://media.example.com/reels/one/stream.m3u8';
const media = (body) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n${body}\n#EXT-X-ENDLIST\n`;
function response(statusCode, headers, chunks) {
  return Object.assign(Readable.from(chunks), { statusCode, headers });
}

test('selects largest declared rendition and rejects external audio or ambiguous masters', () => {
  const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=360x640\n360/stream.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=720x1280\n720/stream.m3u8\n';
  assert.equal(selectVariant(text, base).url, 'https://media.example.com/reels/one/720/stream.m3u8');
  assert.equal(selectVariant(media('#EXTINF:2,\na.ts'), base), null);
  assert.throws(() => selectVariant(text.replace('BANDWIDTH=100', 'AUDIO="audio",BANDWIDTH=100'), base));
  assert.throws(() => selectVariant(text.replace('360x640', '999999x640'), base));
  assert.throws(() => selectVariant(text.replace('360/stream.m3u8', '#EXT-X-ENDLIST'), base));
});

test('TikTok byte ranges use declared masking offsets and same-resource implicit offsets', () => {
  const parsed = parseMedia(media('#EXTINF:2,\n#EXT-X-BYTERANGE:564@1234\nhttps://cdn.example.com/masked.png?token=private\n' +
    '#EXTINF:1,\n#EXT-X-BYTERANGE:752\nhttps://cdn.example.com/masked.png?token=private'), base);
  assert.deepEqual(parsed.segments.map((s) => s.range), [{ length: 564, start: 1234 }, { length: 752, start: 1798 }]);
  assert.equal(parsed.duration, 3);
});

for (const body of [
  '#EXTINF:2,\n#EXT-X-BYTERANGE:564\na.png',
  '#EXTINF:2,\n#EXT-X-BYTERANGE:564@0\na.png\n#EXTINF:2,\n#EXT-X-BYTERANGE:564\nb.png',
  '#EXTINF:2,\n#EXT-X-BYTERANGE:0@4\na.png',
  '#EXTINF:2,\n#EXT-X-BYTERANGE:12@-4\na.png',
  '#EXTINF:2,\n#EXT-X-BYTERANGE:12@9007199254740991\na.png',
  '#EXTINF:2,\n#EXT-X-BYTERANGE:12@0\n#EXT-X-BYTERANGE:12@0\na.png',
  '#EXTINF:2,\n#EXT-X-KEY:METHOD=AES-128,URI="key"\na.ts',
  '#EXTINF:2,\n#EXT-X-DISCONTINUITY\na.ts',
  '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.m4s',
  '#EXTINF:NaN,\na.ts', '#EXTINF:0,\na.ts', '#EXTINF:31,\na.ts',
  '#EXTINF:2,\na.ts\nb.ts', '#EXTINF:2,\n#EXTINF:2,\na.ts',
  '#EXTINF:2,\nfile:///tmp/a.ts', '#EXTINF:2,\nhttp://media.example.com/a.ts',
]) test(`rejects unsupported/malformed playlist case ${body.split('\n')[1]}`, () => {
  assert.throws(() => parseMedia(media(body), base));
});

test('requires bounded complete VOD and no post-ENDLIST data', () => {
  const text = media('#EXTINF:2,\na.ts');
  assert.throws(() => parseMedia(text.replace('#EXT-X-ENDLIST', ''), base));
  assert.throws(() => parseMedia(text + 'a.ts\n', base));
  assert.throws(() => parseMedia(media(Array(301).fill('#EXTINF:2,\na.ts').join('\n')), base));
  assert.throws(() => parseMedia(text.replace('TARGETDURATION:2', 'TARGETDURATION:1'), base));
});

for (const url of ['http://example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a',
  'https://user:secret@example.com/a', 'https://example.com:8443/a', 'https://device.local/a',
  'https://example.com/a#part', 'file:///tmp/segment.ts', 'https://example.com/\\secret'])
  test('rejects unsafe source URL', () => assert.throws(() => sourceUrl(url)));

test('sends and verifies exact HTTP Range, returning only TS bytes rather than PNG masking', async () => {
  const ts = Buffer.alloc(564);
  for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
  const range = { start: 1234, length: ts.length };
  const result = await download(base, { range, maxBytes: 564, get: async (url, signal, actual) => {
    assert.deepEqual(actual, range);
    return response(206, { 'content-range': 'bytes 1234-1797/1900', 'content-length': '564' }, [ts]);
  } });
  assert.deepEqual(result.bytes, ts);
  validateTs(result.bytes);
  assert.throws(() => validateTs(Buffer.concat([Buffer.from('PNG-mask'), ts])));
  const bad = Buffer.from(ts); bad[188] = 0;
  assert.throws(() => validateTs(bad));
});

for (const [status, headers, bytes] of [
  [200, {}, 564], [206, {}, 564],
  [206, { 'content-range': 'bytes 1235-1798/1900' }, 564],
  [206, { 'content-range': 'bytes 1234-1797/*' }, 564],
  [206, { 'content-range': 'bytes 1234-1797/1797' }, 564],
  [206, { 'content-range': 'bytes 1234-1797/1900', 'content-length': '565' }, 564],
  [206, { 'content-range': 'bytes 1234-1797/1900' }, 563],
  [206, { 'content-range': 'bytes 1234-1797/1900' }, 565],
  [206, { 'content-range': 'bytes 1234-1797/1900', 'content-encoding': 'gzip' }, 564],
]) test('rejects range-ignoring, truncated, oversized and malformed HTTP responses', async () => {
  await assert.rejects(download(base, { range: { start: 1234, length: 564 }, maxBytes: 564,
    get: async () => response(status, headers, [Buffer.alloc(bytes)]) }));
});

test('validates each redirect, preserves range and bounds redirect loops', async () => {
  let calls = 0;
  await assert.rejects(download(base, { maxBytes: 100, get: async () => {
    calls++; return response(302, { location: 'https://127.0.0.1/private' }, []);
  } }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(download(base, { maxBytes: 100, get: async () => {
    calls++; return response(302, { location: '/loop' }, []);
  } }), /redirect/);
  assert.equal(calls, 4);
  calls = 0;
  const range = { start: 0, length: 3 };
  const result = await download(base, { range, maxBytes: 3, get: async (url, signal, actual) => {
    assert.deepEqual(actual, range);
    return ++calls === 1 ? response(307, { location: '/next' }, []) :
      response(206, { 'content-range': 'bytes 0-2/3' }, [Buffer.from('abc')]);
  } });
  assert.equal(result.bytes.toString(), 'abc');
});

test('ordinary segments enforce byte budgets even without Content-Length', async () => {
  await assert.rejects(download(base, { maxBytes: 5,
    get: async () => response(200, {}, [Buffer.alloc(3), Buffer.alloc(3)]) }));
  await assert.rejects(download(base, { maxBytes: 5,
    get: async () => response(200, { 'content-length': '4' }, [Buffer.alloc(3)]) }));
});

function probe(width = 360, duration = 2, offset = 0) {
  return { streams: [{ codec_type: 'video', width, height: 640, start_time: '0', sample_aspect_ratio: '1:1' },
    { codec_type: 'audio', start_time: String(offset), duration: String(duration) }], format: { duration: String(duration) } };
}

test('remux verifies timeline/framing and all decoded frames/audio without external protocols', async () => {
  const commands = [];
  const execute = async (command, args) => {
    commands.push([command, args]);
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
    if (command === 'ffprobe') return { stdout: JSON.stringify(probe()) };
    return { stdout: args.includes('framemd5') ? '#tb 0: 1/30\n0, 0, 0, 1, 100, abc\n' : 'SHA256=audio\n' };
  };
  const result = await verifyRemux('/local/source.m3u8', '/local/source.mp4', 2000, { execute });
  assert.equal(result.width, 360);
  assert.equal(commands.length, 6);
  assert.throws(() => mediaShape({ streams: [], format: {} }));
});

for (const changed of [probe(720), probe(360, 3), probe(360, 2, 0.2)])
  test('remux rejects dimension, duration and audio synchronization changes', async () => {
    await assert.rejects(verifyRemux('source.m3u8', 'source.mp4', 2000, { execute: async (command, args) => {
      assert.equal(command, 'ffprobe');
      return { stdout: JSON.stringify(args.at(-1).endsWith('.mp4') ? changed : probe()) };
    } }));
  });

test('remux rejects altered decoded frames even with identical dimensions/duration', async () => {
  await assert.rejects(verifyRemux('source.m3u8', 'source.mp4', 2000, { execute: async (command, args) => {
    if (command === 'ffprobe') return { stdout: JSON.stringify(probe()) };
    return { stdout: `#tb 0: 1/30\n0, 0, 0, 1, 100, ${args.includes('source.mp4') ? 'changed' : 'original'}\n` };
  } }), /decoded content/);
});

test('decoded frame comparison binds relative indexed timestamps and preserves remux timebase changes', () => {
  const original = '#tb 0: 1/1000\n0, 0, 1400, 40, 100, a\n0, 0, 1440, 40, 100, b\n';
  const normalized = '#tb 0: 1/25\n0, 0, 0, 1, 100, a\n0, 0, 1, 1, 100, b\n';
  assert.equal(frameFingerprint(original), frameFingerprint(normalized));
  assert.notEqual(frameFingerprint(original), frameFingerprint(normalized.replace('0, 0, 1,', '0, 0, 2,')));
  assert.throws(() => frameFingerprint('0, 0, 1, 1, 100, a'));
});

test('missing HLS audio duration is checked through packet timing rather than guessed', async () => {
  let packetProbes = 0;
  await verifyRemux('source.m3u8', 'source.mp4', 2000, { execute: async (command, args) => {
    if (command === 'ffprobe') {
      if (args.includes('-show_packets')) {
        packetProbes++;
        return { stdout: JSON.stringify({ packets: [{ pts_time: '0', duration_time: '1' }, { pts_time: '1', duration_time: '1' }] }) };
      }
      const metadata = probe();
      if (args.at(-1).endsWith('.m3u8')) delete metadata.streams[1].duration;
      return { stdout: JSON.stringify(metadata) };
    }
    return { stdout: args.includes('framemd5') ? '#tb 0: 1/30\n0, 0, 0, 1, 100, abc\n' : 'SHA256=audio' };
  } });
  assert.equal(packetProbes, 1);
});

test('every encoded rendition checks framing and audio timeline after the existing encoder', async () => {
  const files = [];
  await verifyEncodedTimelines('source.mp4', '/encoded', { variants: [{ width: 360, height: 640 }] },
    { execute: async (command, args) => { files.push(args.at(-1)); return { stdout: JSON.stringify(probe()) }; } });
  assert.deepEqual(files, ['source.mp4', '/encoded/0/stream.m3u8']);
  await assert.rejects(verifyEncodedTimelines('source.mp4', '/encoded', { variants: [{ width: 720, height: 1280 }] },
    { execute: async () => ({ stdout: JSON.stringify(probe()) }) }), /framing/);
});
