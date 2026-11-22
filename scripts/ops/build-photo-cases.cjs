#!/usr/bin/env node
'use strict';
/**
 * Builds `eval/rag/datasets/rag-photo-v1.jsonl` and the image files for the photo-turn
 * benchmark. Local only: ffmpeg on the downloaded diversity videos, no network, no model.
 *
 *   node scripts/ops/build-photo-cases.cjs build [--dry-run] [--seed v1]
 *   node scripts/ops/build-photo-cases.cjs validate
 *
 * Categories:
 *   frame      a frame cut from an indexed video, then perturbed (crop, JPEG q40, low-res, dark, tilt)
 *   caption    the same kind of frame with an empty, Vietnamese, over-long or contradicting caption
 *   offtopic   a drawn card (math, receipt, code...) that has nothing to do with Velora reels
 *   injection  a drawn card whose text tries to steer the bot
 *   edge       PNG, WebP, an image just under and just over the 4 MiB cap, a corrupt file
 *              (not 3 images in one turn: a chat image message carries one image and the bot turn reads only that
 *              one, see conversation-service bot-turn-image.ts, so that limit is only reachable through ai.stream_question)
 *
 * Images go to test-data/reel-integration/diverse/photos/ (untracked, like the videos).
 * Rows are CANDIDATE: the expected outcome is exact by construction for frame rows (the source video)
 * and rule-based for the rest, so no model review is needed, but nothing here has been run against the bot yet.
 * Only videos with a successful upload in .benchmarks/diverse-reel-map.json get frame rows.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lib = require('../../eval/rag/photo-cases-lib.cjs');
const div = require('../../eval/rag/diverse-cases-lib.cjs');

const DATASET = 'eval/rag/datasets/rag-photo-v1.jsonl';
const ROOT = 'test-data/reel-integration/diverse';
const PHOTOS = path.join(ROOT, 'photos');
const MAP = '.benchmarks/diverse-reel-map.json';
const FONT = process.env.PHOTO_FONT || '/usr/share/fonts/truetype/lato/Lato-Medium.ttf';

const argv = process.argv.slice(2);
const command = argv[0];
const flags = Object.fromEntries(argv.slice(1).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const seed = flags.seed || 'v1';
const dry = Boolean(flags['dry-run']);

const readManifest = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const hash = (s, n = 8) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);

function indexedFixtures() {
  const entries = JSON.parse(fs.readFileSync(MAP, 'utf8')).entries;
  const ok = new Set(Object.entries(entries).filter(([, v]) => v.some((e) => e.success)).map(([k]) => k));
  return readManifest().fixtures.filter((f) => ok.has(f.id));
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

const mimeOf = (rel) => (rel.endsWith('.png') ? 'image/png' : rel.endsWith('.webp') ? 'image/webp' : 'image/jpeg');

/** Image entry for a row. A dry run writes no files, so it carries the name and type only. */
function describeFile(rel) {
  if (dry) return { file: `photos/${rel}`, mimeType: mimeOf(rel), bytes: null, sha256: null };
  const buf = fs.readFileSync(path.join(PHOTOS, rel));
  const mimeType = mimeOf(rel);
  return { file: `photos/${rel}`, mimeType, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** Cut one frame from a video and apply a perturbation. Returns the file name inside PHOTOS. */
function cutFrame(fixture, sec, perturbation, tag = '') {
  const p = lib.PERTURBATIONS[perturbation];
  const rel = `${fixture.id.replace('diverse-', '')}-${Math.round(sec)}s-${perturbation}${tag}.${p.ext}`;
  if (!dry) {
    const vf = p.vf ? ['-vf', p.vf] : [];
    ffmpeg(['-ss', String(sec), '-i', path.join(ROOT, fixture.videoPath || fixture.file), '-frames:v', '1', ...vf, '-q:v', String(p.qv), path.join(PHOTOS, rel)]);
  }
  return rel;
}

/** Draw a white card with the given lines. */
function drawCard(card, rel) {
  if (dry) return;
  const tmp = path.join(PHOTOS, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  // Wrap at 38 characters so nothing runs off the 1280 px card (the injection marker sits at the end of a line).
  const wrapped = [];
  card.lines.forEach((line, i) => {
    let cur = '';
    for (const word of line.split(' ')) {
      if (cur && `${cur} ${word}`.length > 38) { wrapped.push({ text: cur, title: i === 0 }); cur = word; } else cur = cur ? `${cur} ${word}` : word;
    }
    wrapped.push({ text: cur, title: i === 0 });
  });
  if (wrapped.length > 8) throw new Error(`card ${card.id} needs ${wrapped.length} lines, the card fits 8`);
  const filters = wrapped.map((l, i) => {
    const f = path.join(tmp, `${card.id}-${i}.txt`);
    fs.writeFileSync(f, l.text);
    return `drawtext=fontfile=${FONT}:textfile=${f}:fontcolor=black:fontsize=${l.title ? 56 : 44}:x=60:y=${60 + i * 80}`;
  });
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=1280x720', '-vf', filters.join(','), '-frames:v', '1', path.join(PHOTOS, rel)]);
}

/** Noise PNG: about 1.46 bytes per pixel, so the size is set by the dimensions. */
function noisePng(rel, w, h) {
  if (dry) return;
  ffmpeg(['-f', 'lavfi', '-i', `nullsrc=s=${w}x${h},format=rgb24,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255'`, '-frames:v', '1', path.join(PHOTOS, rel)]);
}

function build() {
  const fixtures = indexedFixtures();
  if (!fixtures.length) throw new Error('no indexed fixtures in the reel map');
  const splits = div.assignVideoSplits(fixtures, { seed });
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const splitOfHash = (key) => (parseInt(hash(`${seed}|${key}`, 4), 16) % 100 < 40 ? 'heldout' : 'dev');
  fs.mkdirSync(PHOTOS, { recursive: true });
  const rows = [];

  // 1. frame rows
  for (const plan of lib.planFrames(fixtures, { seed })) {
    const f = byId.get(plan.fixtureId);
    const rel = cutFrame(f, plan.sec, plan.perturbation);
    rows.push(lib.frameRow({ fixture: f, plan, split: splits.get(f.id), image: describeFile(rel), caption: plan.caption }));
  }

  // 2. caption variants, on fresh frames from every third video
  const eligible = fixtures.filter((f) => f.stratum.visualType !== 'static').sort((a, b) => a.id.localeCompare(b.id));
  const variants = [
    { name: 'empty-a', caption: '' }, { name: 'empty-b', caption: '' },
    { name: 'vi-a', caption: lib.CAPTIONS_VI[0] }, { name: 'vi-b', caption: lib.CAPTIONS_VI[1] },
    { name: 'long', caption: lib.LONG_CAPTION },
    { name: 'contradict', caption: 'find me cooking videos about pasta', outcome: 'JUDGE_ONLY' },
  ];
  variants.forEach((v, i) => {
    const f = eligible[(i * 3) % eligible.length];
    const [sec] = lib.pickTimestamps(f.durationSec, 1, `caption|${seed}|${f.id}|${v.name}`);
    const plan = { fixtureId: f.id, sec, perturbation: 'exact' };
    const rel = cutFrame(f, sec, 'exact', `-${v.name}`);
    const row = lib.frameRow({ fixture: f, plan, split: splits.get(f.id), image: describeFile(rel), caption: v.caption, category: 'caption', extraTags: [`caption:${v.name}`] });
    if (v.outcome) row.expect = { outcome: v.outcome, note: 'caption names a topic the photo does not show; judged for grounding only' };
    rows.push(row);
  });

  // 3. drawn cards
  for (const [category, cards] of [['offtopic', lib.OFFTOPIC_CARDS], ['injection', lib.INJECTION_CARDS]]) {
    for (const card of cards) {
      const rel = `card-${category}-${card.id}.png`;
      drawCard(card, rel);
      rows.push(lib.cardRow({ card, category, split: splitOfHash(`${category}|${card.id}`), image: describeFile(rel) }));
    }
  }

  // 4. edge inputs
  const edgeFixture = eligible[0];
  const edgeSplit = splits.get(edgeFixture.id);
  const [edgeSec] = lib.pickTimestamps(edgeFixture.durationSec, 1, `edge|${seed}|${edgeFixture.id}`);
  const edgePlan = { fixtureId: edgeFixture.id, sec: edgeSec, perturbation: 'exact' };
  const edgeRow = (name, images, extra = {}) => {
    const row = lib.frameRow({ fixture: edgeFixture, plan: edgePlan, split: edgeSplit, images, caption: 'find reels like this', category: 'edge', extraTags: [`edge:${name}`] });
    row.id = lib.rowId(['edge', name, images.map((i) => i.file)]);
    if (extra.expect) row.expect = extra.expect;
    return row;
  };
  const edgeImage = describeFile;

  const base = `${edgeFixture.id.replace('diverse-', '')}-${Math.round(edgeSec)}s`;
  if (!dry) {
    ffmpeg(['-ss', String(edgeSec), '-i', path.join(ROOT, edgeFixture.videoPath || edgeFixture.file), '-frames:v', '1', path.join(PHOTOS, `${base}-edge.png`)]);
    ffmpeg(['-ss', String(edgeSec), '-i', path.join(ROOT, edgeFixture.videoPath || edgeFixture.file), '-frames:v', '1', '-c:v', 'libwebp', path.join(PHOTOS, `${base}-edge.webp`)]);
  }
  rows.push(edgeRow('png', [edgeImage(`${base}-edge.png`)]));
  rows.push(edgeRow('webp', [edgeImage(`${base}-edge.webp`)]));

  noisePng('edge-under-cap.png', 2000, 1300); // about 3.8 MB (noise PNG is about 1.46 bytes per pixel)
  noisePng('edge-over-cap.png', 2400, 1400); // about 4.9 MB
  rows.push(edgeRow('under-cap', [edgeImage('edge-under-cap.png')], { expect: { outcome: 'JUDGE_ONLY', note: 'random noise just under 4 MiB: accepted and described as noise, no reel expected' } }));
  rows.push(edgeRow('oversize', [edgeImage('edge-over-cap.png')], { expect: { outcome: 'GRACEFUL_ERROR', note: 'over AI_VISION_MAX_IMAGE_BYTES: a clear reply, no crash' } }));

  if (!dry) {
    const rnd = crypto.createHash('sha256').update(`corrupt|${seed}`).digest();
    fs.writeFileSync(path.join(PHOTOS, 'edge-corrupt.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), rnd, rnd, rnd]));
  }
  rows.push(edgeRow('corrupt', [edgeImage('edge-corrupt.jpg')], { expect: { outcome: 'GRACEFUL_ERROR', note: 'JPEG header followed by random bytes' } }));


  // ordinary rows must not exceed the cap, the two sized edge rows are checked on purpose
  if (!dry) {
    for (const [rel, over] of [['edge-under-cap.png', false], ['edge-over-cap.png', true]]) {
      const size = fs.statSync(path.join(PHOTOS, rel)).size;
      if ((size > lib.MAX_IMAGE_BYTES) !== over) throw new Error(`${rel} is ${size} bytes; wanted ${over ? 'over' : 'under'} ${lib.MAX_IMAGE_BYTES}`);
    }
    fs.rmSync(path.join(PHOTOS, '.tmp'), { recursive: true, force: true });
  }

  const errors = lib.validateRows(rows, { knownFixtureIds: new Set(fixtures.map((f) => f.id)) });
  if (errors.length) throw new Error(`invalid rows:\n${errors.join('\n')}`);
  if (dry) {
    console.log(`dry run: ${rows.length} rows, nothing written`);
  } else {
    fs.writeFileSync(DATASET, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`wrote ${rows.length} rows to ${DATASET}`);
  }
  const count = (key) => rows.reduce((m, r) => ((m[key(r)] = (m[key(r)] || 0) + 1), m), {});
  console.log('by category', count((r) => r.category), 'by split', count((r) => r.split));
}

function validate() {
  const rows = fs.readFileSync(DATASET, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const errors = lib.validateRows(rows, { knownFixtureIds: new Set(readManifest().fixtures.map((f) => f.id)) });
  for (const r of rows) for (const img of r.images) if (!fs.existsSync(path.join(ROOT, img.file))) errors.push(`${r.id}: missing file ${img.file}`);
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log(`ok: ${rows.length} rows`);
}

if (command === 'build') build();
else if (command === 'validate') validate();
else { console.error('usage: build-photo-cases.cjs build [--dry-run] [--seed v1] | validate'); process.exit(2); }
