'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateSourceUrl, publicLookup } = require('./stage-source.cjs');
const run = promisify(execFile);
const LIMITS = Object.freeze({ playlist: 1024 * 1024, segment: 64 * 1024 * 1024,
  total: 512 * 1024 * 1024, segments: 2000, duration: 600, timeout: 900_000 });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sourceUrl(value, base) {
  if (typeof value !== 'string' || /[\\\s\u0000-\u001f]/u.test(value))
    throw new Error('Unsafe HLS reference');
  const url = validateSourceUrl(base ? new URL(value, base).href : value);
  if (url.hash) throw new Error('HLS fragments are unsupported');
  return url;
}

function request(url, signal, range) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { lookup: publicLookup, signal,
      headers: { 'Accept-Encoding': 'identity', ...(range ? {
        Range: `bytes=${range.start}-${range.start + range.length - 1}`,
      } : {}) } }, resolve);
    req.on('error', () => reject(new Error('HLS request failed')));
  });
}

async function download(value, { range, maxBytes, signal, get = request, redirects = 3 }) {
  const url = sourceUrl(value);
  const response = await get(url, signal, range);
  try {
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      if (!redirects || !response.headers.location) throw new Error('HLS redirect rejected');
      response.destroy();
      return download(sourceUrl(response.headers.location, url).href,
        { range, maxBytes, signal, get, redirects: redirects - 1 });
    }
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding !== 'identity') throw new Error('Encoded HLS response rejected');
    if (response.statusCode !== (range ? 206 : 200))
      throw new Error('Unexpected HLS response status');
    if (range) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
      const end = range.start + range.length - 1;
      if (!match || Number(match[1]) !== range.start || Number(match[2]) !== end ||
          !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= end ||
          Number(match[3]) > LIMITS.total)
        throw new Error('Incorrect HLS Content-Range');
    }
    const declared = response.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) ||
        Number(declared) > maxBytes || (range && Number(declared) !== range.length)))
      throw new Error('Invalid HLS response length');
    let size = 0;
    const chunks = [];
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('HLS response exceeds byte budget');
      chunks.push(chunk);
    }
    if (!size || (declared !== undefined && size !== Number(declared)) ||
        (range && size !== range.length)) throw new Error('Truncated HLS response');
    return { bytes: Buffer.concat(chunks), url: url.href };
  } finally { response.destroy(); }
}

function lines(text) {
  if (Buffer.byteLength(text) > LIMITS.playlist || !text.startsWith('#EXTM3U\n') &&
      !text.startsWith('#EXTM3U\r\n') || /[\u0000\uFFFD]/u.test(text))
    throw new Error('Invalid HLS playlist');
  return text.split(/\r?\n/).filter(Boolean);
}

function selectVariant(text, base) {
  const input = lines(text);
  if (!input.some((line) => line.startsWith('#EXT-X-STREAM-INF:'))) return null;
  const variants = [];
  for (let i = 1; i < input.length; i++) {
    const line = input[i];
    if (/^#EXT-X-(?:VERSION:[1-7]|INDEPENDENT-SEGMENTS)$/.test(line)) continue;
    if (!line.startsWith('#EXT-X-STREAM-INF:')) throw new Error('Unsupported HLS master');
    const resolution = /(?:[:,])RESOLUTION=(\d+)x(\d+)(?:,|$)/.exec(line);
    const bandwidth = /(?:[:,])BANDWIDTH=(\d+)(?:,|$)/.exec(line);
    if (!resolution || !bandwidth || /(?:AUDIO|VIDEO|SUBTITLES|CLOSED-CAPTIONS)=/.test(line) ||
        !input[i + 1] || input[i + 1].startsWith('#')) throw new Error('Unsupported HLS rendition');
    const width = Number(resolution[1]), height = Number(resolution[2]);
    if (!width || !height || width > 4096 || height > 4096 ||
        Number(bandwidth[1]) <= 0 || Number(bandwidth[1]) > 100_000_000)
      throw new Error('Unbounded HLS rendition');
    variants.push({ url: sourceUrl(input[++i], base).href, width, height,
      bandwidth: Number(bandwidth[1]) });
  }
  if (!variants.length || variants.length > 8) throw new Error('Invalid rendition count');
  return variants.sort((a, b) => b.width * b.height - a.width * a.height || b.bandwidth - a.bandwidth)[0];
}

function parseMedia(text, base) {
  const input = lines(text), segments = [];
  const seen = new Set();
  let duration, range, previous, ended = false, target, total = 0;
  for (const line of input.slice(1)) {
    if (ended) throw new Error('Data after HLS end');
    if (line.startsWith('#EXTINF:')) {
      if (duration !== undefined) throw new Error('Missing HLS segment');
      const match = /^#EXTINF:(\d+(?:\.\d+)?),[^\r\n]*$/.exec(line);
      duration = match ? Number(match[1]) : NaN;
      if (!(duration > 0 && duration <= 30)) throw new Error('Invalid HLS duration');
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      if (duration === undefined || range) throw new Error('Misplaced HLS range');
      const match = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?$/.exec(line);
      if (!match) throw new Error('Malformed HLS range');
      range = { length: Number(match[1]), start: match[2] === undefined ? null : Number(match[2]) };
      if (!Number.isSafeInteger(range.length) || range.length <= 0 || range.length > LIMITS.segment ||
          range.start !== null && (!Number.isSafeInteger(range.start) || range.start < 0))
        throw new Error('Unbounded HLS range');
    } else if (!line.startsWith('#')) {
      if (duration === undefined) throw new Error('Missing HLS duration');
      const url = sourceUrl(line, base).href;
      if (range?.start === null) {
        if (!previous?.range || previous.url !== url) throw new Error('Implicit HLS offset has no predecessor');
        range.start = previous.range.start + previous.range.length;
      }
      if (range && (!Number.isSafeInteger(range.start + range.length) ||
          range.start + range.length > LIMITS.total)) throw new Error('Unbounded HLS range');
      previous = { url, duration, range };
      segments.push(previous);
      total += duration;
      duration = undefined; range = undefined;
      if (segments.length > LIMITS.segments || total > LIMITS.duration)
        throw new Error('HLS exceeds segment or duration budget');
    } else if (line === '#EXT-X-ENDLIST') ended = true;
    else if (/^#EXT-X-TARGETDURATION:\d+$/.test(line)) {
      if (target) throw new Error('Duplicate HLS target');
      target = Number(line.split(':')[1]);
    } else {
      if (!/^#EXT-X-(?:VERSION:[1-7]|MEDIA-SEQUENCE:0|PLAYLIST-TYPE:VOD|INDEPENDENT-SEGMENTS)$/.test(line))
        throw new Error('Unsupported HLS tag');
      const tag = line.split(':')[0];
      if (seen.has(tag)) throw new Error('Duplicate HLS tag');
      seen.add(tag);
    }
  }
  if (!ended || duration !== undefined || range || !segments.length ||
      !target || target > 30 || segments.some((s) => Math.round(s.duration) > target))
    throw new Error('Incomplete HLS VOD');
  return { segments, duration: total };
}

function validateTs(bytes) {
  if (bytes.length < 188 * 3 || bytes.length % 188 !== 0)
    throw new Error('Expected complete MPEG-TS packets');
  for (let i = 0; i < bytes.length; i += 188)
    if (bytes[i] !== 0x47) throw new Error('Invalid MPEG-TS sync byte');
}

function mediaShape(probe) {
  const video = probe.streams?.filter((s) => s.codec_type === 'video');
  const audio = probe.streams?.filter((s) => s.codec_type === 'audio');
  if (video?.length !== 1 || audio?.length > 1 || probe.streams.length !== video.length + audio.length)
    throw new Error('Unsupported HLS streams');
  const v = video[0], a = audio[0];
  if (![v.width, v.height].every((size) => Number.isInteger(size) && size > 0 && size <= 4096))
    throw new Error('Invalid media framing');
  const rotation = Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation || v.tags?.rotate || 0);
  const duration = Number(probe.format?.duration);
  const start = Number(v.start_time);
  const audioOffset = a ? Number(a.start_time) - start : null;
  if (!Number.isFinite(duration) || duration <= 0 || duration > LIMITS.duration + 1 ||
      !Number.isFinite(start) || !Number.isFinite(rotation) ||
      a && !Number.isFinite(audioOffset)) throw new Error('Invalid media timeline');
  // Compare audio end relative to video start; container duration can differ after remux.
  const audioEndOffset = a ? Number(a.start_time) + Number(a.duration) - start : null;
  if (a && !Number.isFinite(audioEndOffset)) throw new Error('Invalid audio duration');
  return { width: v.width, height: v.height, sar: v.sample_aspect_ratio || '1:1',
    rotation, duration, start, audioOffset, audioEndOffset };
}

async function probeMedia(file, execute, options) {
  const probe = JSON.parse((await execute('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file',
    '-show_streams', '-show_format', '-of', 'json', file], options)).stdout);
  const audio = probe.streams?.find((s) => s.codec_type === 'audio');
  if (audio && !Number.isFinite(Number(audio.duration))) {
    // HLS demuxers often omit stream duration; use bounded packet timing instead.
    const packets = JSON.parse((await execute('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file',
      '-select_streams', 'a:0', '-show_packets', '-show_entries', 'packet=pts_time,duration_time',
      '-of', 'json', file], options)).stdout).packets;
    if (!packets?.length || packets.length > 100_000) throw new Error('Invalid audio packet inventory');
    let end = -Infinity, previous = -Infinity;
    for (const packet of packets) {
      const pts = Number(packet.pts_time), duration = Number(packet.duration_time);
      if (!Number.isFinite(pts) || !Number.isFinite(duration) || duration <= 0 || pts < previous)
        throw new Error('Invalid audio packet timeline');
      previous = pts; end = Math.max(end, pts + duration);
    }
    audio.start_time = packets[0].pts_time;
    audio.duration = end - Number(audio.start_time);
  }
  return mediaShape(probe);
}

function frameFingerprint(text) {
  const timebase = /^#tb\s+0:\s+(\d+)\/(\d+)$/m.exec(text);
  if (!timebase || !Number(timebase[1]) || !Number(timebase[2])) throw new Error('Missing decoded timebase');
  const tick = Number(timebase[1]) / Number(timebase[2]);
  let first, previous = -Infinity;
  const frames = text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const fields = line.split(',').map((value) => value.trim());
    const pts = Number(fields[2]), duration = Number(fields[3]);
    if (fields.length !== 6 || !Number.isFinite(pts) || !Number.isFinite(duration) || duration <= 0 || pts < previous)
      throw new Error('Invalid decoded frame timeline');
    first ??= pts; previous = pts;
    return [Math.round((pts - first) * tick * 1000), Math.round(duration * tick * 1000), fields[4], fields[5]].join(',');
  });
  if (!frames.length) throw new Error('Empty decoded video');
  return frames.join('\n');
}

async function verifyRemux(playlist, mp4, expectedDurationMs, { execute = run, signal } = {}) {
  const options = { timeout: 180_000, maxBuffer: 32 * 1024 * 1024, signal };
  const probe = (file) => probeMedia(file, execute, options);
  const before = await probe(playlist), after = await probe(mp4);
  for (const field of ['width', 'height', 'sar', 'rotation'])
    if (before[field] !== after[field]) throw new Error('Remux framing mismatch');
  if (Math.abs(before.duration * 1000 - expectedDurationMs) > 250 ||
      Math.abs(after.duration - before.duration) > 0.25 || Math.abs(after.start) > 0.25 ||
      (before.audioOffset === null) !== (after.audioOffset === null) ||
      before.audioOffset !== null && (Math.abs(before.audioOffset - after.audioOffset) > 0.05 ||
        Math.abs(before.audioEndOffset - after.audioEndOffset) > 0.05))
    throw new Error('Remux duration or synchronization mismatch');
  // Compare every decoded video frame (therefore indexed samples too) and all PCM audio.
  for (const type of before.audioOffset === null ? ['video'] : ['video', 'audio']) {
    const fingerprints = [];
    for (const file of [playlist, mp4]) {
      const args = ['-v', 'error', '-xerror', '-nostdin', '-noautorotate',
        '-protocol_whitelist', 'file', '-i', file, '-map', type === 'video' ? '0:v:0' : '0:a:0'];
      const { stdout } = await execute('ffmpeg', args.concat(type === 'video'
        ? ['-an', '-fps_mode', 'passthrough', '-f', 'framemd5', '-']
        : ['-vn', '-c:a', 'pcm_s16le', '-f', 'hash', '-hash', 'sha256', '-']), options);
      const fingerprint = type === 'video' ? frameFingerprint(stdout) : stdout.trim();
      if (!fingerprint) throw new Error('Empty decode evidence');
      fingerprints.push(hash(fingerprint));
    }
    if (fingerprints[0] !== fingerprints[1]) throw new Error('Remux decoded content mismatch');
  }
  return after;
}

async function verifyEncodedTimelines(source, outputDir, profile, { execute = run } = {}) {
  const probe = (file) => probeMedia(file, execute, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  const original = await probe(source);
  for (const [index, expected] of profile.variants.entries()) {
    const encoded = await probe(path.join(outputDir, String(index), 'stream.m3u8'));
    if (encoded.width !== expected.width || encoded.height !== expected.height || encoded.rotation !== 0 ||
        encoded.sar !== '1:1' || Math.abs(encoded.duration - original.duration) > 0.25 ||
        (encoded.audioOffset === null) !== (original.audioOffset === null) ||
        original.audioOffset !== null && (Math.abs(encoded.audioOffset - original.audioOffset) > 0.1 ||
          Math.abs(encoded.audioEndOffset - original.audioEndOffset) > 0.1))
      throw new Error('Encoded framing, duration or audio synchronization differs');
  }
}

async function materializeExistingHls({ url, outputDir, expectedDurationMs }, dependencies = {}) {
  if (!Number.isInteger(expectedDurationMs) || expectedDurationMs <= 0 || expectedDurationMs > LIMITS.duration * 1000)
    throw new Error('Published duration is required within the source budget');
  sourceUrl(url);
  const signal = AbortSignal.timeout(LIMITS.timeout);
  const fetch = (value, range, maxBytes) => download(value,
    { range, maxBytes, signal, get: dependencies.get });
  fs.mkdirSync(outputDir, { mode: 0o700 });
  const available = fs.statfsSync(outputDir);
  if (Number(available.bavail) * Number(available.bsize) < LIMITS.total * 3)
    throw new Error('Insufficient materialization disk budget');
  const master = await fetch(url, undefined, LIMITS.playlist);
  const variant = selectVariant(master.bytes.toString('utf8'), master.url);
  const media = variant ? await fetch(variant.url, undefined, LIMITS.playlist) : master;
  const parsed = parseMedia(media.bytes.toString('utf8'), media.url);
  if (Math.abs(parsed.duration * 1000 - expectedDurationMs) > 250)
    throw new Error('Published playlist duration differs from inventory');
  const records = [];
  let total = 0;
  for (const [index, segment] of parsed.segments.entries()) {
    const { bytes } = await fetch(segment.url, segment.range, Math.min(LIMITS.segment, LIMITS.total - total));
    validateTs(bytes);
    total += bytes.length;
    const name = `segment_${String(index).padStart(6, '0')}.ts`;
    fs.writeFileSync(path.join(outputDir, name), bytes, { flag: 'wx', mode: 0o600 });
    records.push({ name, bytes: bytes.length, sha256: hash(bytes), duration: segment.duration,
      sourceSha256: hash(segment.url), range: segment.range ?? null });
  }
  const playlist = path.join(outputDir, 'source.m3u8');
  fs.writeFileSync(playlist, ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:30',
    '#EXT-X-MEDIA-SEQUENCE:0', ...records.flatMap((s) => [`#EXTINF:${s.duration},`, s.name]),
    '#EXT-X-ENDLIST', ''].join('\n'), { flag: 'wx', mode: 0o600 });
  const mp4 = path.join(outputDir, 'source.mp4');
  const execute = dependencies.execute || run;
  await execute('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-n', '-protocol_whitelist', 'file',
    '-i', playlist, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart',
    '-fs', String(LIMITS.total), mp4], { timeout: 180_000, maxBuffer: 1024 * 1024, signal });
  fs.chmodSync(mp4, 0o600);
  if (fs.statSync(mp4).size > LIMITS.total) throw new Error('Remux exceeds source byte budget');
  const shape = await verifyRemux(playlist, mp4, expectedDurationMs, { execute, signal });
  if (variant && (shape.width !== variant.width || shape.height !== variant.height))
    throw new Error('Rendition framing differs from its declaration');
  const { sha256 } = require('./hls.cjs');
  const provenance = { masterSha256: hash(master.bytes), sourceUrlSha256: hash(url),
    playlistSha256: hash(media.bytes), sourceSha256: await sha256(mp4), shape, segments: records };
  fs.writeFileSync(path.join(outputDir, 'provenance.json'), JSON.stringify(provenance, null, 2),
    { flag: 'wx', mode: 0o600 });
  return { source: mp4, provenance };
}

module.exports = { LIMITS, sourceUrl, download, selectVariant, parseMedia, validateTs,
  mediaShape, frameFingerprint, verifyRemux, verifyEncodedTimelines, materializeExistingHls };
