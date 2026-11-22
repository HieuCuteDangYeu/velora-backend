'use strict';
/**
 * Pure helpers for `rag-diverse-v1.jsonl`: caption windows, question rows,
 * video-level splits, validation and interval-overlap hit logic.
 *
 * Gold is a time interval on a fixture, not a chunk id, so re-chunking or
 * re-indexing a reel never makes a row stale. The runner resolves
 * fixtureId -> reelId from `.benchmarks/diverse-reel-map.json`.
 */
const crypto = require('node:crypto');
const sem = require('./semantic-live-eval-lib.cjs');

const TYPES = ['detail', 'opening', 'timestamp', 'chapter'];
const SPLITS = ['dev', 'heldout'];
const STATUSES = ['CANDIDATE', 'REVIEWED', 'REJECTED'];
const CAPTION_TIERS = ['manual', 'auto-caption'];

const sha = (text, n = 12) =>
  crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, n);

const isCjk = (text) => {
  const s = String(text);
  const cjk = (s.match(/[㐀-鿿]/gu) ?? []).length;
  return cjk > s.length * 0.3;
};

/** mm:ss, or h:mm:ss from one hour up: the shape the router parses as a timestamp. */
function formatClock(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Group caption segments into passages of about `targetSec`. A window closes
 * when it reaches the target or when silence longer than `gapSec` follows.
 */
function buildWindows(segments, { targetSec = 45, gapSec = 8 } = {}) {
  const windows = [];
  let cur = null;
  for (const seg of segments) {
    if (cur && (seg.startSec - cur.endSec > gapSec || seg.startSec - cur.startSec >= targetSec)) {
      windows.push(cur);
      cur = null;
    }
    if (!cur) cur = { startSec: seg.startSec, endSec: seg.endSec, parts: [] };
    cur.parts.push(seg.text);
    cur.endSec = Math.max(cur.endSec, seg.endSec);
  }
  if (cur) windows.push(cur);
  return windows.map((w) => ({
    startSec: w.startSec,
    endSec: w.endSec,
    text: w.parts.join(isCjk(w.parts.join('')) ? '' : ' ').replace(/\s+/g, ' ').trim(),
  }));
}

/** Windows with enough text to ask about (CJK packs more meaning per character). */
function eligibleWindows(windows, { minChars = 160, maxChars = 1200 } = {}) {
  return windows.filter((w) => {
    const min = isCjk(w.text) ? Math.round(minChars / 2) : minChars;
    return w.text.length >= min && w.text.length <= maxChars;
  });
}

/**
 * Pick up to `k` windows spread over the whole video: the duration is cut into
 * `k` equal bins and one eligible window is drawn per bin, so a 78-minute
 * video is asked about at the start, middle and end rather than only where
 * captions are dense.
 */
function pickSpread(windows, k, durationSec, random) {
  if (!windows.length || k <= 0) return [];
  const binLen = durationSec / k;
  const out = [];
  for (let i = 0; i < k; i += 1) {
    const inBin = windows.filter((w) => {
      const mid = (w.startSec + w.endSec) / 2;
      return mid >= i * binLen && mid < (i + 1) * binLen;
    });
    if (inBin.length) out.push(inBin[Math.floor(random() * inBin.length)]);
  }
  return out;
}

/**
 * Video-level split, decided from the manifest alone (before any model
 * output). Within each duration band the videos are ordered by a seeded hash
 * and the first `heldoutPercent` go to heldout, so both splits see every band.
 */
function assignVideoSplits(fixtures, { seed = 'v1', heldoutPercent = 40 } = {}) {
  const byBand = new Map();
  for (const f of fixtures) {
    const band = f.stratum.durationBand;
    if (!byBand.has(band)) byBand.set(band, []);
    byBand.get(band).push(f);
  }
  const splits = new Map();
  for (const list of byBand.values()) {
    const ordered = [...list].sort((a, b) => sha(`${seed}|${a.id}`, 16).localeCompare(sha(`${seed}|${b.id}`, 16)));
    const heldout = Math.round((ordered.length * heldoutPercent) / 100);
    ordered.forEach((f, i) => splits.set(f.id, i < heldout ? 'heldout' : 'dev'));
  }
  return splits;
}

function baseRow({ fixture, type, question, questionLanguage, gold, referenceText, split, generator }) {
  const audioLanguage = fixture.stratum.language;
  const s = fixture.stratum;
  return {
    id: `div-${sha(`${fixture.id}|${type}|${gold.startSec}|${question}`)}`,
    question,
    questionLanguage,
    audioLanguage,
    crossLingual: audioLanguage !== 'none' && questionLanguage !== audioLanguage,
    type,
    fixtureId: fixture.id,
    gold: { startSec: Math.round(gold.startSec * 1000) / 1000, endSec: Math.round(gold.endSec * 1000) / 1000 },
    textHash: sem.textHash(referenceText),
    split,
    referenceTier: s.referenceTier,
    stratum: {
      genre: s.genre, durationBand: s.durationBand, audioCondition: s.audioCondition,
      visualType: s.visualType, language: s.language,
    },
    status: 'CANDIDATE',
    generator,
    review: null,
  };
}

/** Questions that need no model: the video's opening, a clock time, a chapter. */
function templatedRows({ fixture, windows, chapters, split, random, timestampCount = 2, chapterCount = 3 }) {
  const rows = [];
  const usable = eligibleWindows(windows, { minChars: 80 });
  if (usable.length) {
    const first = usable[0];
    rows.push(baseRow({
      fixture, type: 'opening', question: 'What is the first thing said in this video?',
      questionLanguage: 'en', gold: first, referenceText: first.text, split, generator: 'template',
    }));
  }
  // Skip the first window (that is the opening question's territory).
  const later = usable.filter((w) => w.startSec > 60);
  for (const w of pickSpread(later, timestampCount, fixture.durationSec, random)) {
    const at = Math.round((w.startSec + w.endSec) / 2);
    rows.push(baseRow({
      fixture, type: 'timestamp', question: `What does the speaker say at ${formatClock(at)}?`,
      questionLanguage: 'en', gold: w, referenceText: w.text, split, generator: 'template',
    }));
  }
  // Chapter titles are sometimes slide text ("U of M System Mission ..."), so
  // skip untitled, tiny and over-long ones, then take a few spread over the video.
  const askable = chapters.filter(
    (c) => !/^<?untitled/i.test(c.title) && c.endSec - c.startSec >= 30 && c.title.length <= 100,
  );
  const stride = askable.length / Math.max(1, Math.min(chapterCount, askable.length));
  const spread = askable.length <= chapterCount
    ? askable
    : Array.from({ length: chapterCount }, (_, i) => askable[Math.floor(i * stride)]);
  for (const c of spread) {
    const inside = windows.filter((w) => w.startSec >= c.startSec && w.endSec <= c.endSec);
    const text = inside.map((w) => w.text).join(' ');
    if (text.length < 160) continue;
    rows.push(baseRow({
      fixture, type: 'chapter',
      question: `What is covered in the part of the video titled "${c.title}"?`,
      questionLanguage: 'en', gold: { startSec: c.startSec, endSec: c.endSec },
      referenceText: text, split, generator: 'template',
    }));
  }
  return rows;
}

function detailRow({ fixture, window, question, questionLanguage, split, generator }) {
  const row = baseRow({
    fixture, type: 'detail', question, questionLanguage, gold: window,
    referenceText: window.text, split, generator,
  });
  row.leakage = sem.leakage(question, window.text);
  return row;
}

const isLeakyDetail = (question, passage) =>
  sem.isLeaky(question, passage) || sem.sharesCjkRun(question, passage);

function validateRows(rows) {
  const errors = [];
  const ids = new Set();
  const questions = new Set();
  rows.forEach((r, i) => {
    const at = `row ${i} (${r.id})`;
    if (!r.id || ids.has(r.id)) errors.push(`${at}: id missing or duplicated`);
    ids.add(r.id);
    if (!r.question || !String(r.question).trim()) errors.push(`${at}: empty question`);
    const key = `${r.fixtureId}|${r.question}`;
    if (questions.has(key)) errors.push(`${at}: duplicate question on ${r.fixtureId}`);
    questions.add(key);
    if (!TYPES.includes(r.type)) errors.push(`${at}: type ${r.type}`);
    if (!SPLITS.includes(r.split)) errors.push(`${at}: split ${r.split}`);
    if (!STATUSES.includes(r.status)) errors.push(`${at}: status ${r.status}`);
    if (!r.fixtureId) errors.push(`${at}: fixtureId missing`);
    if (!(r.gold && r.gold.startSec >= 0 && r.gold.endSec > r.gold.startSec)) errors.push(`${at}: gold interval invalid`);
    if (!CAPTION_TIERS.includes(r.referenceTier)) errors.push(`${at}: referenceTier ${r.referenceTier} cannot back a caption question`);
    if (!r.textHash) errors.push(`${at}: textHash missing`);
  });
  // A video must live in one split.
  const splitOf = new Map();
  rows.forEach((r) => {
    if (splitOf.has(r.fixtureId) && splitOf.get(r.fixtureId) !== r.split) {
      errors.push(`fixture ${r.fixtureId} appears in both splits`);
    }
    splitOf.set(r.fixtureId, r.split);
  });
  return errors;
}

/**
 * The caption text a row was written from, rebuilt from the untracked
 * reference file at review or judge time (rows hold only the interval and a
 * text hash, so third-party caption text never lands in git).
 *
 * Windows are deterministic for a given reference, so the row's window is found
 * by its gold interval; chapter rows join the windows inside the chapter. Auto
 * captions overlap in time, so reading raw segments by interval would not
 * reproduce the hashed text.
 */
function referenceTextFor(segments, row, windowOptions) {
  const windows = buildWindows(segments, windowOptions);
  const same = (a, b) => Math.abs(a - b) < 0.002;
  if (row.type === 'chapter') {
    return windows
      .filter((w) => w.startSec >= row.gold.startSec - 0.002 && w.endSec <= row.gold.endSec + 0.002)
      .map((w) => w.text)
      .join(' ');
  }
  const w = windows.find((x) => same(x.startSec, row.gold.startSec) && same(x.endSec, row.gold.endSec));
  return w ? w.text : '';
}

/** Seconds from "m:ss" or "h:mm:ss" (the form timestamp questions use), or null. */
function parseClock(text) {
  const m = /\b(\d{1,2}(?::\d{2}){1,2})\b/.exec(text || '');
  return m ? m[1].split(':').reduce((t, part) => t * 60 + Number(part), 0) : null;
}

/**
 * What a timestamp question is asking about: the speech within `halfWidthSec` of the asked time,
 * not the whole gold window (about 50 s), which would fault a correct one-sentence answer for
 * missing the rest of the window. Falls back to the gold window text when the question has no time.
 */
function timestampReferenceText(segments, row, { halfWidthSec = 10 } = {}) {
  const at = parseClock(row.question);
  if (at === null) return referenceTextFor(segments, row);
  return segments
    .filter((s) => s.endSec > at - halfWidthSec && s.startSec < at + halfWidthSec)
    .map((s) => s.text)
    .join(' ')
    .trim();
}

/** Seconds two [start, end] intervals share. */
function overlapSec(a, b) {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

/**
 * A retrieved chunk or section counts as a hit when it shares at least
 * min(`minOverlapSec`, 30% of the gold interval) with the gold interval.
 * Hits without a time span never count.
 */
function isIntervalHit(hit, gold, { minOverlapSec = 5, minGoldShare = 0.3 } = {}) {
  if (typeof hit?.startTime !== 'number' || typeof hit?.endTime !== 'number') return false;
  const overlap = overlapSec({ startSec: hit.startTime, endSec: hit.endTime }, gold);
  const need = Math.min(minOverlapSec, minGoldShare * (gold.endSec - gold.startSec));
  return overlap > 0 && overlap >= need;
}

module.exports = {
  TYPES, SPLITS, STATUSES,
  formatClock, buildWindows, eligibleWindows, pickSpread, assignVideoSplits,
  templatedRows, detailRow, isLeakyDetail, validateRows, overlapSec, isIntervalHit, isCjk, referenceTextFor, parseClock, timestampReferenceText,
};
