'use strict';
/**
 * Pure helpers for the diversified RAG benchmark fixtures. No network, no
 * filesystem: prepare-diverse-fixtures.cjs does the I/O around these.
 */

const GENRES = [
  'lecture-slides', 'tutorial', 'cooking', 'news-interview', 'podcast',
  'documentary-nature', 'sports', 'music', 'screen-recording', 'vlog-travel',
  'gameplay', 'animation',
];
const LANGUAGES = ['en', 'vi', 'zh', 'es', 'hi', 'ar', 'fr', 'ko', 'none'];
const AUDIO_CONDITIONS = [
  'clean-speech', 'noisy', 'music-over-speech', 'music-only', 'no-speech',
  'silent-track', 'no-audio-track',
];
const VISUAL_TYPES = [
  'talking-head', 'slides', 'scene-heavy', 'screen-recording', 'static',
  'blackboard',
];
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

// Production cut-off between SHORT and LONG routing (MEDIA_SHORT_MAX_DURATION_SECONDS).
const SHORT_MAX_SECONDS = 180;
const LONG_MAX_SECONDS = 7200;

/** Duration bands used to stratify results. Upper bounds are exclusive. */
function durationBand(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('duration must be positive');
  if (seconds <= SHORT_MAX_SECONDS) return 'under-3min';
  if (seconds < 600) return '3-10min';
  if (seconds < 1800) return '10-30min';
  if (seconds < 3600) return '30-60min';
  if (seconds <= LONG_MAX_SECONDS) return '60-120min';
  return 'over-2h';
}

/** Route the indexer should pick, given what the probe saw. */
function expectedRoute({ durationSec, hasAudio }) {
  if (!hasAudio) return 'NO_AUDIO';
  return durationSec > SHORT_MAX_SECONDS ? 'LONG' : 'SHORT';
}

function validateSources(doc) {
  const errors = [];
  if (!doc || !Array.isArray(doc.sources) || !doc.sources.length) {
    return ['sources must be a non-empty array'];
  }
  if (!doc.tag || typeof doc.tag !== 'string') errors.push('tag is required');
  const seen = new Set();
  doc.sources.forEach((s, i) => {
    const at = `sources[${i}]`;
    if (!YOUTUBE_ID.test(s.youtubeId ?? '')) errors.push(`${at}.youtubeId is not a YouTube id`);
    else if (seen.has(s.youtubeId)) errors.push(`${at}.youtubeId ${s.youtubeId} is duplicated`);
    else seen.add(s.youtubeId);
    if (!GENRES.includes(s.genre)) errors.push(`${at}.genre ${s.genre} is not allowed`);
    if (!LANGUAGES.includes(s.language)) errors.push(`${at}.language ${s.language} is not allowed`);
    if (!AUDIO_CONDITIONS.includes(s.audioCondition)) errors.push(`${at}.audioCondition ${s.audioCondition} is not allowed`);
    if (!VISUAL_TYPES.includes(s.visualType)) errors.push(`${at}.visualType ${s.visualType} is not allowed`);
  });
  (doc.derived ?? []).forEach((d, i) => {
    const at = `derived[${i}]`;
    if (!d.id || typeof d.id !== 'string') errors.push(`${at}.id is required`);
    if (!seen.has(d.from)) errors.push(`${at}.from ${d.from} is not a listed source`);
    if (d.op !== 'strip-audio') errors.push(`${at}.op ${d.op} is not supported`);
  });
  return errors;
}

/**
 * Parse YouTube json3 captions into segments. Auto-captions repeat the same
 * words across overlapping events, so empty and exact-duplicate events are
 * dropped.
 */
function parseJson3(doc) {
  const out = [];
  let last = '';
  for (const ev of doc?.events ?? []) {
    if (!Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number') continue;
    const text = ev.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text || text === last) continue;
    last = text;
    const startSec = ev.tStartMs / 1000;
    const endSec = startSec + (ev.dDurationMs ?? 0) / 1000;
    out.push({ startSec: round3(startSec), endSec: round3(endSec), text });
  }
  return out;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** Which tier of reference an info.json supports for a language. */
function referenceTier(info, language) {
  if (language === 'none') return 'none';
  const has = (table) =>
    Object.keys(table ?? {}).some((k) => k === language || k.startsWith(`${language}-`));
  if (has(info?.subtitles)) return 'manual';
  if (has(info?.automatic_captions)) return 'auto-caption';
  return 'none';
}

function chaptersFrom(info) {
  return (info?.chapters ?? []).map((c) => ({
    startSec: c.start_time,
    endSec: c.end_time,
    title: c.title,
  }));
}

module.exports = {
  GENRES, LANGUAGES, AUDIO_CONDITIONS, VISUAL_TYPES,
  SHORT_MAX_SECONDS, LONG_MAX_SECONDS,
  durationBand, expectedRoute, validateSources, parseJson3, referenceTier, chaptersFrom,
};
