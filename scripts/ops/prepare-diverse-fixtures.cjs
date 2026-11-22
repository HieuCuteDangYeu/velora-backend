#!/usr/bin/env node
'use strict';
/**
 * Download the diversified long-video benchmark sources with yt-dlp and write a
 * manifest that scripts/ops/reel-integration-load.cjs (--dataset=diverse)
 * can upload.
 *
 *   node scripts/ops/prepare-diverse-fixtures.cjs --dry-run
 *   node scripts/ops/prepare-diverse-fixtures.cjs --only=OdbOX7HtF9A,lnhxWA9tLTw
 *   node scripts/ops/prepare-diverse-fixtures.cjs --yt-dlp=/path/to/yt-dlp
 *
 * Output (untracked, matches the /test-data/reel-integration/ ignore rule):
 *   <output-dir>/videos/<id>.mp4        H.264/AAC, at most 720p
 *   <output-dir>/info/<id>.info.json    yt-dlp metadata
 *   <output-dir>/reference/<id>.json    captions + chapters + stratum labels
 *   <output-dir>/manifest.json          fixtures for the uploader
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./diverse-fixtures-lib.cjs');

const args = Object.fromEntries(
  process.argv.slice(2).filter((x) => x.startsWith('--')).map((x) => {
    const i = x.indexOf('=');
    return i < 0 ? [x.slice(2), 'true'] : [x.slice(2, i), x.slice(i + 1)];
  }),
);
const sourcesFile = path.resolve(args.sources || 'eval/rag/datasets/rag-diverse-sources-v1.json');
const out = path.resolve(args['output-dir'] || 'test-data/reel-integration/diverse');
const ytdlp = args['yt-dlp'] || process.env.YT_DLP || 'yt-dlp';
const maxHeight = Number(args['max-height'] || 720);
const dryRun = args['dry-run'] === 'true';
const force = args.force === 'true';
const only = args.only ? new Set(args.only.split(',')) : null;

function run(cmd, cmdArgs, { allowFail = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} failed (${r.status}): ${(r.stderr || '').slice(-1500)}`);
  }
  return r;
}
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration,size:stream=codec_name,codec_type,width,height', '-of', 'json', file]);
  const p = JSON.parse(r.stdout);
  const v = (p.streams || []).find((s) => s.codec_type === 'video');
  const a = (p.streams || []).find((s) => s.codec_type === 'audio');
  return {
    durationSec: Number(p.format.duration),
    bytes: Number(p.format.size),
    width: v?.width, height: v?.height,
    videoCodec: v?.codec_name, audioCodec: a?.codec_name, hasAudio: Boolean(a),
  };
}

// Reels are uploaded as MP4; make sure the codecs are ones the pipeline reads.
function ensureH264Aac(file, p) {
  const videoOk = p.videoCodec === 'h264';
  const audioOk = !p.hasAudio || p.audioCodec === 'aac';
  if (videoOk && audioOk) return false;
  const tmp = `${file}.reencode.mp4`;
  run('ffmpeg', ['-y', '-i', file, '-c:v', videoOk ? 'copy' : 'libx264',
    ...(videoOk ? [] : ['-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p']),
    ...(p.hasAudio ? ['-c:a', audioOk ? 'copy' : 'aac', ...(audioOk ? [] : ['-b:a', '96k'])] : ['-an']),
    '-movflags', '+faststart', tmp]);
  fs.renameSync(tmp, file);
  return true;
}

function download(src, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lang = src.language === 'none' ? null : src.language;
  const format =
    `bv*[vcodec^=avc1][height<=${maxHeight}]+ba[acodec^=mp4a]/` +
    `b[ext=mp4][height<=${maxHeight}]/bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]`;
  const result = run(ytdlp, [
    // A rate-limited subtitle fetch (HTTP 429) must not lose the video; the
    // reference tier is then recorded as "none" and can be retried with --force.
    '--no-warnings', '--no-playlist', '--ignore-errors', '--sleep-subtitles', '3',
    '-f', format, '--merge-output-format', 'mp4',
    '--write-info-json', '--no-write-comments',
    ...(lang
      ? ['--write-subs', '--write-auto-subs', '--sub-langs', `${lang},${lang}-orig`, '--sub-format', 'json3']
      : []),
    '-o', path.join(dir, '%(id)s.%(ext)s'),
    `https://www.youtube.com/watch?v=${src.youtubeId}`,
  ], { allowFail: true });
  const mp4 = path.join(dir, `${src.youtubeId}.mp4`);
  if (!fs.existsSync(mp4) || !fs.existsSync(path.join(dir, `${src.youtubeId}.info.json`))) {
    throw new Error(`yt-dlp produced no video (${result.status}): ${(result.stderr || '').slice(-800)}`);
  }
  if (result.status !== 0) console.warn(`warn  ${src.youtubeId}: yt-dlp exit ${result.status} (kept video): ${(result.stderr || '').trim().split('\n').pop().slice(0, 160)}`);
}

function prepareOne(src, doc) {
  const id = `diverse-${src.youtubeId}`;
  const videoPath = path.join(out, 'videos', `${src.youtubeId}.mp4`);
  const refPath = path.join(out, 'reference', `${src.youtubeId}.json`);
  if (!force && fs.existsSync(videoPath) && fs.existsSync(refPath)) {
    return { fixture: JSON.parse(fs.readFileSync(refPath, 'utf8')).fixture, skipped: true };
  }
  const work = path.join(out, 'work', src.youtubeId);
  download(src, work);
  const info = JSON.parse(fs.readFileSync(path.join(work, `${src.youtubeId}.info.json`), 'utf8'));
  fs.mkdirSync(path.dirname(videoPath), { recursive: true });
  fs.renameSync(path.join(work, `${src.youtubeId}.mp4`), videoPath);
  let p = probe(videoPath);
  const reencoded = ensureH264Aac(videoPath, p);
  if (reencoded) p = probe(videoPath);

  const tier = lib.referenceTier(info, src.language);
  let segments = [];
  if (tier !== 'none') {
    const cap = fs.readdirSync(work).find((f) => f.endsWith('.json3'));
    if (cap) segments = lib.parseJson3(JSON.parse(fs.readFileSync(path.join(work, cap), 'utf8')));
  }
  const referenceTierFinal = segments.length ? tier : 'none';
  const durationSec = Math.round(p.durationSec * 1000) / 1000;
  const labels = {
    ...src,
    durationBand: lib.durationBand(durationSec),
    hasAudioTrack: p.hasAudio,
    expectedRoute: lib.expectedRoute({ durationSec, hasAudio: p.hasAudio }),
    referenceTier: referenceTierFinal,
    hasChapters: lib.chaptersFrom(info).length > 0,
  };
  const title = String(info.title || src.youtubeId).replace(/\s+/g, ' ').slice(0, 80);
  const fixture = {
    id, fixtureId: id, source: 'yt-dlp',
    file: path.relative(out, videoPath), videoPath: path.relative(out, videoPath),
    mimeType: 'video/mp4', durationSec, durationSeconds: durationSec,
    title, description: `Diversity benchmark clip (${src.genre}, ${src.language}). Source: ${info.webpage_url}`,
    tags: ['integration-test', doc.tag, src.genre, `lang-${src.language}`, labels.durationBand],
    stratum: labels,
    probe: { ...p, reencoded },
  };
  writeJson(refPath, {
    fixture,
    attribution: {
      url: info.webpage_url, title: info.title, uploader: info.uploader || info.channel,
      license: info.license || null, uploadDate: info.upload_date || null,
    },
    chapters: lib.chaptersFrom(info),
    referenceSegments: segments,
  });
  writeJson(path.join(out, 'info', `${src.youtubeId}.info.json`), info);
  fs.rmSync(work, { recursive: true, force: true });
  return { fixture, skipped: false };
}

// A copy of a downloaded video with its audio stream removed (op strip-audio).
function deriveOne(d, fixtures) {
  const parentId = `diverse-${d.from}`;
  const refFile = path.join(out, 'reference', `${d.from}.json`);
  if (!fs.existsSync(refFile)) throw new Error(`parent ${d.from} is not prepared`);
  const parent = fixtures.find((f) => f.id === parentId) || JSON.parse(fs.readFileSync(refFile, 'utf8')).fixture;
  const videoPath = path.join(out, 'videos', `${d.id}.mp4`);
  run('ffmpeg', ['-y', '-i', path.join(out, 'videos', `${d.from}.mp4`), '-c:v', 'copy', '-an',
    '-movflags', '+faststart', videoPath]);
  const p = probe(videoPath);
  if (p.hasAudio) throw new Error('derived file still has an audio stream');
  const stratum = { ...parent.stratum, youtubeId: d.id, audioCondition: 'no-audio-track', language: 'none',
    hasAudioTrack: false, expectedRoute: lib.expectedRoute({ durationSec: p.durationSec, hasAudio: false }),
    referenceTier: 'none', hasChapters: false, derivedFrom: d.from };
  const fixture = { ...parent, id: d.id, fixtureId: d.id, file: path.relative(out, videoPath),
    videoPath: path.relative(out, videoPath), title: `${parent.title} (no audio)`.slice(0, 80),
    tags: parent.tags.filter((t) => !t.startsWith('lang-')).concat('lang-none', 'no-audio'),
    stratum, probe: { ...p, reencoded: false } };
  writeJson(path.join(out, 'reference', `${d.id}.json`), { fixture, derivedFrom: d.from, op: d.op,
    chapters: [], referenceSegments: [] });
  return fixture;
}

function main() {
  const doc = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));
  const errors = lib.validateSources(doc);
  if (errors.length) throw new Error(`invalid sources:\n  ${errors.join('\n  ')}`);
  const picked = doc.sources.filter((s) => !only || only.has(s.youtubeId));
  if (!picked.length) throw new Error('no sources matched --only');
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, output: out, ytdlp, maxHeight, count: picked.length,
      ids: picked.map((s) => s.youtubeId) }, null, 2));
    return;
  }
  const fixtures = [];
  const failures = [];
  for (const src of picked) {
    try {
      const { fixture, skipped } = prepareOne(src, doc);
      fixtures.push(fixture);
      console.log(`${skipped ? 'kept ' : 'ready'} ${src.youtubeId} ${fixture.stratum.durationBand} `
        + `${fixture.stratum.referenceTier} route=${fixture.stratum.expectedRoute} ${fixture.title}`);
    } catch (e) {
      failures.push({ youtubeId: src.youtubeId, error: String(e.message).slice(0, 400) });
      console.error(`FAIL  ${src.youtubeId} ${String(e.message).slice(0, 200)}`);
    }
  }
  for (const d of doc.derived ?? []) {
    if (only && !only.has(d.from) && !only.has(d.id)) continue;
    try {
      const fixture = deriveOne(d, fixtures);
      fixtures.push(fixture);
      console.log(`derived ${d.id} route=${fixture.stratum.expectedRoute}`);
    } catch (e) {
      failures.push({ youtubeId: d.id, error: String(e.message).slice(0, 400) });
      console.error(`FAIL  ${d.id} ${String(e.message).slice(0, 200)}`);
    }
  }
  // Merge with fixtures from earlier partial runs so --only does not drop them.
  const manifestFile = path.join(out, 'manifest.json');
  const prior = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')).fixtures : [];
  const byId = new Map(prior.map((f) => [f.id, f]));
  fixtures.forEach((f) => byId.set(f.id, f));
  writeJson(manifestFile, { version: 1, source: 'yt-dlp CC BY (uploader-declared)', tag: doc.tag,
    fixtures: [...byId.values()] });
  if (failures.length) {
    writeJson(path.join(out, 'failures.json'), failures);
    process.exitCode = 1;
  }
}

main();
