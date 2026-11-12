'use strict';
/**
 * Shared helpers for the live semantic retrieval evaluation set
 * (`datasets/rag-semantic-live-v1.jsonl`). Pure and dependency-free so the
 * runner can be copied next to it into a service container.
 *
 * A case is a natural question plus graded relevant evidence IDs. It is scored
 * against the live index (see `semantic-live-eval.cjs`), never an offline
 * fixture. Questions come from `synthetic`, `regression` or `hand` sources;
 * `traffic` is allowed by the schema but unused until real usage exists.
 */
const crypto = require('node:crypto');

const DATASET_VERSION = 'rag-semantic-live-v1';
const SOURCES = new Set(['synthetic', 'traffic', 'regression', 'hand']);
const STATUSES = new Set(['CANDIDATE', 'REVIEWED', 'REJECTED', 'STALE']);
const SPLITS = new Set(['dev', 'heldout', 'fresh']);
const LANGUAGES = new Set(['en', 'vi']);

const STOP = new Set(
  'a an and are as at be by for from has have he her his i in is it its of on or she that the their them they this to was were what when where which who why how with you your me my we our do does did about say says said'.split(
    ' ',
  ),
);

const tokens = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .match(/[\p{L}\p{N}]+/gu) ?? [];

const contentTokens = (text) =>
  tokens(text).filter((t) => t.length > 1 && !STOP.has(t));

/**
 * How much of a question is copied from its source passage. `containment` is
 * the share of the question's content tokens found in the passage;
 * `longestRun` is the longest run of consecutive question tokens that also
 * appears consecutively in the passage. A question written from a chunk that
 * copies it scores high on both and makes retrieval look easier than it is.
 */
function leakage(question, passage) {
  const q = tokens(question);
  const p = tokens(passage);
  const passageSet = new Set(contentTokens(passage));
  const qContent = contentTokens(question);
  const containment = qContent.length
    ? qContent.filter((t) => passageSet.has(t)).length / qContent.length
    : 0;
  const grams = new Map();
  p.forEach((t, i) => {
    if (!grams.has(t)) grams.set(t, []);
    grams.get(t).push(i);
  });
  let longestRun = 0;
  for (let i = 0; i < q.length; i += 1) {
    for (const start of grams.get(q[i]) ?? []) {
      let n = 0;
      while (q[i + n] !== undefined && q[i + n] === p[start + n]) n += 1;
      if (n > longestRun) longestRun = n;
    }
  }
  return {
    containment: Number(containment.toFixed(3)),
    longestRun,
  };
}

const isLeaky = (
  question,
  passage,
  { maxContainment = 0.6, maxRun = 4 } = {},
) => {
  const l = leakage(question, passage);
  return l.containment > maxContainment || l.longestRun >= maxRun;
};

/** "Pet Chat Group Episode 22" and "... Episode 23" are one series. */
function seriesOf(title) {
  return (
    String(title ?? '')
      .replace(/\s*[-:,]?\s*(episode|ep\.?|tap|tập)\s*\d+\s*$/iu, '')
      .trim()
      .toLowerCase() || 'untitled'
  );
}

/** Deterministic seeded PRNG (mulberry32). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * All questions from one series land in one split. `fresh` is for reels first
 * indexed after the last tuning (`freshAfter`), so it stays a pristine holdout
 * that regrows as content arrives.
 */
function assignSplit({
  seriesId,
  firstIndexedAt,
  freshAfter,
  heldoutPercent = 40,
  seed = 'v1',
}) {
  if (
    freshAfter &&
    firstIndexedAt &&
    new Date(firstIndexedAt) > new Date(freshAfter)
  )
    return 'fresh';
  const bucket =
    parseInt(
      crypto
        .createHash('sha256')
        .update(`${seed}:${seriesId}`)
        .digest('hex')
        .slice(0, 8),
      16,
    ) % 100;
  return bucket < heldoutPercent ? 'heldout' : 'dev';
}

function validateRow(row) {
  const errors = [];
  const need = (ok, message) => {
    if (!ok) errors.push(message);
  };
  need(row && typeof row === 'object', 'row must be an object');
  if (!row || typeof row !== 'object') return errors;
  need(typeof row.id === 'string' && row.id, 'id');
  need(
    row.datasetVersion === DATASET_VERSION,
    `datasetVersion must be ${DATASET_VERSION}`,
  );
  need(
    typeof row.question === 'string' && row.question.trim().length >= 8,
    'question',
  );
  need(LANGUAGES.has(row.language), 'language');
  need(SOURCES.has(row.source), 'source');
  need(STATUSES.has(row.status), 'status');
  need(SPLITS.has(row.split), 'split');
  need(typeof row.seriesId === 'string' && row.seriesId, 'seriesId');
  need(Array.isArray(row.tags), 'tags must be an array');
  need(
    Array.isArray(row.relevant) &&
      row.relevant.length > 0 &&
      row.relevant.every(
        (r) =>
          typeof r.evidenceId === 'string' && (r.grade === 1 || r.grade === 2),
      ),
    'relevant must list evidenceId with grade 1 or 2',
  );
  need(
    Array.isArray(row.relevant) && row.relevant.some((r) => r.grade === 2),
    'relevant needs at least one grade 2 item',
  );
  if (row.status === 'REVIEWED')
    need(
      row.review && row.review.reviewerId && row.review.reviewedAt,
      'REVIEWED rows need review.reviewerId and review.reviewedAt',
    );
  return errors;
}

function validateDataset(rows) {
  const errors = [];
  const ids = new Set();
  const questions = new Set();
  const splitBySeries = new Map();
  rows.forEach((row, index) => {
    for (const e of validateRow(row))
      errors.push(`row ${index + 1} (${row?.id}): ${e}`);
    if (!row?.id) return;
    if (ids.has(row.id)) errors.push(`duplicate id ${row.id}`);
    ids.add(row.id);
    const key = String(row.question).trim().toLowerCase();
    if (questions.has(key)) errors.push(`duplicate question in ${row.id}`);
    questions.add(key);
    const seen = splitBySeries.get(row.seriesId);
    if (seen && seen !== row.split)
      errors.push(
        `series ${row.seriesId} spans splits ${seen} and ${row.split}`,
      );
    splitBySeries.set(row.seriesId, row.split);
  });
  return errors;
}

/**
 * Cases whose primary evidence is no longer an active chunk are STALE, not
 * retrieval misses, so a reindex cannot silently lower the score.
 */
function markStale(rows, activeIds) {
  const active = activeIds instanceof Set ? activeIds : new Set(activeIds);
  return rows.map((row) => {
    if (row.status === 'REJECTED') return row;
    const primaryGone = row.relevant
      .filter((r) => r.grade === 2)
      .some((r) => !active.has(r.evidenceId));
    if (primaryGone && row.status !== 'STALE')
      return { ...row, status: 'STALE', staleFrom: row.status };
    if (!primaryGone && row.status === 'STALE')
      return {
        ...row,
        status: row.staleFrom ?? 'CANDIDATE',
        staleFrom: undefined,
      };
    return row;
  });
}

const PROMPTS = {
  en: (text) =>
    `Below is a passage from a short video's transcript. Write ONE natural question a viewer might ask about what is said or happens in this passage, answerable from the passage. Do not quote it verbatim and avoid reusing its distinctive phrases; paraphrase the idea. Do not mention timestamps, seconds, "segment", "passage" or episode numbers. Keep it under 25 words.\n\nPASSAGE:\n${text.slice(0, 900)}`,
  vi: (text) =>
    `Below is a passage from a short video's transcript. Write ONE natural question IN VIETNAMESE a viewer might ask about what is said or happens in this passage, answerable from the passage. Paraphrase the idea; do not mention timestamps, "segment", "passage" or episode numbers. Keep it under 25 words.\n\nPASSAGE:\n${text.slice(0, 900)}`,
};

/**
 * Builds CANDIDATE rows from an item snapshot (`{ items }`, each with
 * id, reelId, title, text, tags, indexVersion, firstIndexedAt). `askFn(prompt)`
 * returns a question string; it is injected so tests need no model.
 */
async function buildCandidateRows({
  items,
  askFn,
  seed = 12345,
  total = 100,
  perSeriesMax = 6,
  viShare = 0.2,
  freshAfter,
  heldoutPercent = 40,
  splitSeed = 'v1',
  minChars = 220,
  existingQuestions = [],
  generator = 'unknown',
  now = new Date(),
}) {
  const random = rng(seed);
  const usable = items.filter(
    (i) => /:chunk:/.test(i.id) && String(i.text ?? '').length >= minChars,
  );
  const seenQuestions = new Set(
    existingQuestions.map((q) => q.trim().toLowerCase()),
  );
  const perSeries = new Map();
  const reelsBySeries = new Map();
  for (const u of usable) {
    const s = seriesOf(u.title);
    reelsBySeries.set(s, new Set([...(reelsBySeries.get(s) ?? []), u.reelId]));
  }
  // A series is "fresh" only when every one of its reels is new: a new episode
  // of an old series is near-identical to content already tuned on.
  const firstIndexedBySeries = new Map();
  for (const i of items) {
    const s = seriesOf(i.title);
    const at = i.firstIndexedAt;
    if (
      at &&
      (!firstIndexedBySeries.has(s) || at < firstIndexedBySeries.get(s))
    )
      firstIndexedBySeries.set(s, at);
  }
  const rows = [];
  const stats = { asked: 0, leaky: 0, failed: 0, duplicate: 0 };
  for (const item of shuffle(usable, random)) {
    if (rows.length >= total) break;
    const seriesId = seriesOf(item.title);
    if ((perSeries.get(seriesId) ?? 0) >= perSeriesMax) continue;
    const language = random() < viShare ? 'vi' : 'en';
    let question;
    stats.asked += 1;
    try {
      question = String(
        await askFn(PROMPTS[language](item.text), { language, item }),
      ).trim();
    } catch {
      stats.failed += 1;
      continue;
    }
    if (!question) {
      stats.failed += 1;
      continue;
    }
    // Vietnamese questions over English text are cross-lingual by construction,
    // so the lexical filter only applies to same-language questions.
    const lk = leakage(question, item.text);
    if (language === 'en' && isLeaky(question, item.text)) {
      stats.leaky += 1;
      continue;
    }
    const key = question.toLowerCase();
    if (seenQuestions.has(key)) {
      stats.duplicate += 1;
      continue;
    }
    seenQuestions.add(key);
    perSeries.set(seriesId, (perSeries.get(seriesId) ?? 0) + 1);
    rows.push({
      id: `sem-live-${crypto.createHash('sha1').update(`${item.id}:${question}`).digest('hex').slice(0, 12)}`,
      datasetVersion: DATASET_VERSION,
      question,
      language,
      source: 'synthetic',
      status: 'CANDIDATE',
      split: assignSplit({
        seriesId,
        firstIndexedAt: firstIndexedBySeries.get(seriesId),
        freshAfter,
        heldoutPercent,
        seed: splitSeed,
      }),
      reelId: item.reelId,
      seriesId,
      // `same-series`: other reels of this series are in the index, so the
      // question must be told apart from near-identical sibling episodes.
      tags: [
        language === 'vi' ? 'vi' : 'paraphrase',
        ...(reelsBySeries.get(seriesId).size > 1 ? ['same-series'] : []),
      ],
      relevant: [{ evidenceId: item.id, grade: 2 }],
      indexVersion: item.indexVersion ?? null,
      createdAt: now.toISOString(),
      generator,
      leakage: lk,
    });
  }
  return { rows, stats };
}

// ---------------------------------------------------------------- metrics

/** `ranked` is an array of evidence IDs, best first; `grades` maps id -> 1|2. */
function caseMetrics(ranked, grades, { cutoff = 30 } = {}) {
  const list = ranked.slice(0, cutoff);
  const firstRel = list.findIndex((id) => grades.get(id) === 2);
  const firstAny = list.findIndex((id) => grades.get(id) > 0);
  const gain = (g) => (g === 2 ? 3 : g === 1 ? 1 : 0);
  const dcg = (ids) =>
    ids
      .slice(0, 10)
      .reduce((s, id, i) => s + gain(grades.get(id)) / Math.log2(i + 2), 0);
  const ideal = dcg(
    [...grades.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
  );
  const hit = (k) =>
    list.slice(0, k).some((id) => grades.get(id) === 2) ? 1 : 0;
  return {
    rr: firstRel < 0 ? 0 : 1 / (firstRel + 1),
    rrAny: firstAny < 0 ? 0 : 1 / (firstAny + 1),
    recall1: hit(1),
    recall5: hit(5),
    recall10: hit(10),
    ndcg10: ideal ? dcg(list) / ideal : 0,
  };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function summarize(perCase) {
  const keys = ['rr', 'rrAny', 'recall1', 'recall5', 'recall10', 'ndcg10'];
  const out = { n: perCase.length };
  for (const k of keys)
    out[k] = Number(mean(perCase.map((c) => c[k])).toFixed(4));
  return out;
}

/** Group per-case metrics by a key function and summarize each group. */
function summarizeBy(perCase, keyFn) {
  const groups = new Map();
  for (const c of perCase)
    for (const key of new Set([].concat(keyFn(c))))
      groups.set(key, [...(groups.get(key) ?? []), c]);
  return Object.fromEntries([...groups].map(([k, v]) => [k, summarize(v)]));
}

/** Paired bootstrap over case-level differences (b minus a). */
function pairedBootstrap(a, b, { iterations = 2000, seed = 7 } = {}) {
  if (a.length !== b.length || !a.length)
    throw new Error('paired samples must be equal length and non-empty');
  const diffs = a.map((x, i) => b[i] - x);
  const random = rng(seed);
  const means = [];
  for (let it = 0; it < iterations; it += 1) {
    let s = 0;
    for (let i = 0; i < diffs.length; i += 1)
      s += diffs[Math.floor(random() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((x, y) => x - y);
  return {
    n: diffs.length,
    meanDiff: Number(mean(diffs).toFixed(4)),
    ci95: [
      Number(means[Math.floor(0.025 * iterations)].toFixed(4)),
      Number(means[Math.ceil(0.975 * iterations) - 1].toFixed(4)),
    ],
    wins: diffs.filter((d) => d > 0).length,
    losses: diffs.filter((d) => d < 0).length,
  };
}

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`invalid JSON on line ${i + 1}`);
      }
    });
}

const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Calls Claude Haiku through the claude CLI and returns structured output. */
function claudeJson(
  prompt,
  schema,
  { model = 'claude-haiku-5-5', timeout = 120000 } = {},
) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(
    'claude',
    [
      '-p',
      '--model',
      model,
      '--tools',
      '',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources',
      '',
    ],
    {
      input: prompt,
      encoding: 'utf8',
      timeout,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TERM: 'dumb',
        NO_COLOR: '1',
      },
    },
  );
  const e = JSON.parse(r.stdout);
  if (e.is_error || !e.structured_output) throw new Error('claude call failed');
  return e.structured_output;
}

module.exports = {
  DATASET_VERSION,
  assignSplit,
  buildCandidateRows,
  caseMetrics,
  claudeJson,
  isLeaky,
  leakage,
  markStale,
  pairedBootstrap,
  parseJsonl,
  rng,
  seriesOf,
  shuffle,
  summarize,
  summarizeBy,
  toJsonl,
  validateDataset,
  validateRow,
};
