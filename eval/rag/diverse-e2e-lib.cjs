'use strict';
/**
 * Pure scoring for the end-to-end layer of the diverse-video benchmark. The runner
 * (scripts/ops/run-diverse-e2e.cjs) puts each question to the live bot with only the gold video
 * shared in the chat; this decides what the reply proves.
 *
 * Two kinds of evidence per row:
 *   - deterministic: did the bot cite the right reel, and a span that overlaps the gold interval?
 *   - judged (Haiku, added later by `judge`): is the answer right against the reference passage?
 * A reply that cites nothing is not a miss by itself: opening and timestamp questions may be
 * answered from the transcript path without a citation card, so `momentHit` is reported next to the judge.
 */
const div = require('./diverse-cases-lib.cjs');

const MIN_CELL = 15;
const REFUSAL = /\b(?:cannot|can't|could not|couldn't|unable to|not enough|insufficient|no relevant|không thể|chưa đủ|không có thông tin|không tìm thấy)\b/i;

// The strict-scope router's refusal ("I can only help with Velora ...") and the unshared-reel refusal:
// the bot declined a question about the shared video instead of answering it.
const SCOPE_REFUSAL = /I can only help with Velora|hasn.t been shared in this conversation/i;

const citationsOf = (message) => {
  const list = message?.metadata?.citations ?? message?.citations;
  return Array.isArray(list) ? list : [];
};

/** Seconds, whatever unit the citation used: values past the reel's length are taken as milliseconds. */
function spanOf(citation, durationSec) {
  const s = citation?.startTime ?? citation?.startSec;
  const e = citation?.endTime ?? citation?.endSec;
  if (typeof s !== 'number' || typeof e !== 'number') return null;
  const scale = durationSec && e > durationSec * 1.5 ? 1000 : 1;
  return { startTime: s / scale, endTime: e / scale };
}

/** `reply`: { answer, citations } or null. `reelId`: production reel of the row's video. */
function scoreReply(row, reply, { reelId, durationSec } = {}) {
  if (!reelId) return { unbound: true, answered: false };
  if (!reply) return { answered: false, citedReel: false, momentHit: false, refused: false, citationCount: 0 };
  const citations = reply.citations || [];
  const own = citations.filter((c) => c?.reelId === reelId);
  const momentHit = own.some((c) => {
    const span = spanOf(c, durationSec);
    return span ? div.isIntervalHit(span, row.gold) : false;
  });
  return {
    answered: Boolean((reply.answer || '').trim()),
    citedReel: own.length > 0,
    momentHit,
    refused: REFUSAL.test(reply.answer || ''),
    scopeRefused: SCOPE_REFUSAL.test(reply.answer || ''),
    citationCount: citations.length,
  };
}

const mean = (xs) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : null);

function summarizeCell(items) {
  const scored = items.filter((i) => !i.score.unbound);
  const judged = scored.filter((i) => i.judge && typeof i.judge.factualCorrectness === 'number');
  return {
    n: scored.length,
    answerRate: mean(scored.map((i) => (i.score.answered ? 1 : 0))),
    refusalRate: mean(scored.map((i) => (i.score.refused ? 1 : 0))),
    scopeRefusalRate: mean(scored.map((i) => (SCOPE_REFUSAL.test(i.reply?.answer || '') ? 1 : 0))),
    citedReelRate: mean(scored.map((i) => (i.score.citedReel ? 1 : 0))),
    momentHitRate: mean(scored.map((i) => (i.score.momentHit ? 1 : 0))),
    judged: judged.length,
    factual: mean(judged.map((i) => i.judge.factualCorrectness)),
    relevancy: mean(judged.map((i) => i.judge.responseRelevancy)),
    correctRate: mean(judged.map((i) => (i.judge.factualCorrectness >= 0.7 ? 1 : 0))),
    // Chapter and range summaries: faithful to the transcript and covering its main points (see summaryCorrectness).
    summaryCorrectRate: mean(
      judged
        .filter((i) => typeof i.judge.summaryCorrectness === 'number')
        .map((i) => (i.judge.summaryCorrectness >= 0.7 ? 1 : 0)),
    ),
    indicative: scored.length < MIN_CELL,
  };
}

const tagsOf = (row) => [
  `type:${row.type}`, `band:${row.stratum.durationBand}`, `genre:${row.stratum.genre}`,
  `lang:${row.stratum.language}`, `audio:${row.stratum.audioCondition}`,
  `visual:${row.stratum.visualType}`, `tier:${row.referenceTier}`, `cross:${row.crossLingual ? 'yes' : 'no'}`,
];

function summarize(items) {
  const groups = new Map();
  for (const item of items) {
    for (const tag of tagsOf(item.row)) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(item);
    }
  }
  return {
    overall: summarizeCell(items),
    byTag: Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, summarizeCell(v)])),
  };
}

/** Rows to send: `perVideo` rows of each type for every bound video, evenly spread, so no video dominates. */
function pickRows(rows, { types = null, perVideoPerType = 2, split = 'all', verdict = 'any', limit = null } = {}) {
  const typeSet = types ? new Set(types) : null;
  const eligible = rows.filter((r) => r.status === 'REVIEWED'
    && (split === 'all' || r.split === split)
    && (!typeSet || typeSet.has(r.type))
    && (verdict === 'any' || r.review?.verdict === verdict));
  const buckets = new Map();
  for (const r of eligible) {
    const key = `${r.fixtureId}|${r.type}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const out = [];
  for (const list of buckets.values()) {
    if (list.length <= perVideoPerType) { out.push(...list); continue; }
    for (let i = 0; i < perVideoPerType; i += 1) out.push(list[Math.floor(((i + 0.5) * list.length) / perVideoPerType)]);
  }
  return limit ? out.slice(0, Number(limit)) : out;
}

/**
 * A chapter row asks about "the part titled X": a YouTube chapter title the bot never sees, because Velora
 * videos have no chapters. The same gold interval asked the way a user can ask it, by time, keeps the
 * reference and the gold unchanged: "Summarize what is said from 12:10 to 15:30 in the video."
 */
function chapterByInterval(row) {
  if (row.type !== 'chapter') return row;
  const clock = (sec) => div.formatClock(sec);
  return {
    ...row,
    id: `${row.id}-iv`,
    question: `Summarize what is said from ${clock(row.gold.startSec)} to ${clock(row.gold.endSec)} in the video.`,
  };
}

module.exports = { chapterByInterval, MIN_CELL, REFUSAL, SCOPE_REFUSAL, citationsOf, spanOf, scoreReply, summarizeCell, summarize, tagsOf, pickRows };
