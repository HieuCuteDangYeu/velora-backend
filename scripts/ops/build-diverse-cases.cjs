#!/usr/bin/env node
'use strict';
/**
 * Builds `eval/rag/datasets/rag-diverse-v1.jsonl` from the prepared diversity
 * fixtures (see prepare-diverse-fixtures.cjs).
 *
 *   # templated rows only (opening, clock time, chapter): no model calls
 *   node scripts/ops/build-diverse-cases.cjs generate --no-llm
 *
 *   # plus Haiku-written detail questions, N per video, spread over the video
 *   node scripts/ops/build-diverse-cases.cjs generate --detail-per-video 5 --seed 1
 *
 *   # Haiku checks every CANDIDATE row against the caption text in its gold
 *   # interval: REVIEWED when the interval answers it, REJECTED when not.
 *   node scripts/ops/build-diverse-cases.cjs review
 *
 *   node scripts/ops/build-diverse-cases.cjs validate
 *
 * Only videos whose reference is a caption (manual or auto) get rows.
 * Rows are CANDIDATE until reviewed. `generate` appends and never edits a row;
 * a video keeps the split it was first given.
 */
const fs = require('node:fs');
const path = require('node:path');
const sem = require('../../eval/rag/semantic-live-eval-lib.cjs');
const lib = require('../../eval/rag/diverse-cases-lib.cjs');

const DATASET = 'eval/rag/datasets/rag-diverse-v1.jsonl';
const FIXTURES = 'test-data/reel-integration/diverse';
const LANGUAGE_NAMES = { en: 'English', vi: 'Vietnamese', zh: 'Chinese', es: 'Spanish', hi: 'Hindi', ar: 'Arabic', fr: 'French', ko: 'Korean' };
const MAX_ATTEMPTS = 3;
const QUESTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['question'],
  properties: { question: { type: 'string' } },
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) { args._.push(argv[i]); continue; }
    const [name, inline] = argv[i].slice(2).split('=', 2);
    const next = argv[i + 1];
    if (inline !== undefined) args[name] = inline;
    else if (next && !next.startsWith('--')) { args[name] = next; i += 1; } else args[name] = true;
  }
  return args;
}

const readRows = (file) => (fs.existsSync(file) ? sem.parseJsonl(fs.readFileSync(file, 'utf8')) : []);
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

function detailPrompt(fixture, passage) {
  const language = LANGUAGE_NAMES[fixture.stratum.language] ?? 'English';
  return [
    `You write one search question for a video question-answering benchmark.`,
    `Below is a caption excerpt from a ${fixture.stratum.genre} video spoken in ${language}.`,
    `Automatic captions can contain recognition mistakes; ignore garbled words.`,
    ``,
    `Write ONE question in ${language} that a viewer could ask and that this excerpt answers.`,
    `Rules:`,
    `- It must be specific enough that this excerpt, and not the rest of the video, answers it.`,
    `- It must make sense on its own, without saying "the excerpt", "the passage" or "the speaker says in this part".`,
    `- Do not copy more than three words in a row from the excerpt; paraphrase.`,
    `- A question about a fact, number, name, reason or step stated in the excerpt. Not yes/no.`,
    ``,
    `Excerpt:`,
    passage,
  ].join('\n');
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'note'],
  properties: {
    verdict: { type: 'string', enum: ['answered', 'partly', 'not_answered'] },
    note: { type: 'string' },
  },
};

function reviewPrompt(row, passage) {
  // The excerpt itself carries no clock times, so a clock-time question cannot
  // be judged from it unless the reviewer is told which part of the video it is.
  const timing = row.type === 'timestamp'
    ? [`This excerpt is the speech from ${lib.formatClock(row.gold.startSec)} to ${lib.formatClock(row.gold.endSec)} of the video, so the time in the question falls inside it. Judge whether the excerpt says something definite and substantive that answers "what does the speaker say" at that time (not just filler or end-of-video boilerplate).`, ``]
    : [];
  return [
    `You check a question for a video question-answering benchmark.`,
    `The excerpt below is the caption text of the part of a video the question was written from.`,
    `Automatic captions can contain recognition mistakes; judge the meaning, not exact spelling.`,
    ``,
    `Question: ${row.question}`,
    ``,
    ...timing,
    `Excerpt:`,
    passage,
    ``,
    `Verdict:`,
    `- answered: the excerpt clearly contains the answer.`,
    `- partly: the excerpt touches the topic but the answer is incomplete, garbled or ambiguous.`,
    `- not_answered: the excerpt does not contain the answer, or the question is too vague to have one answer.`,
    `Give a one-sentence note saying why.`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const dataset = args.dataset || DATASET;
  const existing = readRows(dataset);

  if (command === 'validate') {
    const errors = lib.validateRows(existing);
    if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
    const count = (f) => existing.reduce((m, r) => { const k = f(r); m[k] = (m[k] ?? 0) + 1; return m; }, {});
    console.log(JSON.stringify({
      rows: existing.length, status: count((r) => r.status), split: count((r) => r.split),
      type: count((r) => r.type), band: count((r) => r.stratum.durationBand),
      tier: count((r) => r.referenceTier), crossLingual: count((r) => r.crossLingual),
    }));
    return;
  }
  if (command === 'review') {
    const dir = path.resolve(args['fixtures-dir'] || FIXTURES);
    const refs = new Map();
    const refFor = (row) => {
      const id = row.fixtureId.replace(/^diverse-/, '');
      if (!refs.has(id)) refs.set(id, JSON.parse(fs.readFileSync(path.join(dir, 'reference', `${id}.json`), 'utf8')));
      return refs.get(id);
    };
    const reviewer = 'claude-haiku-5-5';
    const redo = new Set(args.redo ? String(args.redo).split(',') : []);
    const stats = { reviewed: 0, rejected: 0, partly: 0, textChanged: 0, errors: 0 };
    const next = existing.map((row) => {
      if (row.status !== 'CANDIDATE' && !redo.has(row.type)) return row;
      const passage = lib.referenceTextFor(refFor(row).referenceSegments, row);
      // The reference file changed under the row: do not review text it was not written from.
      if (sem.textHash(passage) !== row.textHash) { stats.textChanged += 1; return row; }
      try {
        const out = sem.claudeJson(reviewPrompt(row, passage), REVIEW_SCHEMA);
        const verdict = out.verdict;
        const status = verdict === 'not_answered' ? 'REJECTED' : 'REVIEWED';
        if (status === 'REJECTED') stats.rejected += 1; else stats.reviewed += 1;
        if (verdict === 'partly') stats.partly += 1;
        return { ...row, status, review: { reviewerId: reviewer, kind: 'model', verdict, note: String(out.note ?? '').slice(0, 300), at: new Date().toISOString() } };
      } catch (e) {
        stats.errors += 1;
        console.error(`review error ${row.id}: ${String(e.message).slice(0, 160)}`);
        return row;
      }
    });
    const errors = lib.validateRows(next);
    if (errors.length) throw new Error(`refusing to write an invalid dataset:\n${errors.slice(0, 10).join('\n')}`);
    writeAtomic(dataset, sem.toJsonl(next));
    console.log(JSON.stringify(stats));
    return;
  }
  if (command !== 'generate') throw new Error('usage: build-diverse-cases.cjs generate|review|validate [options]');

  const dir = path.resolve(args['fixtures-dir'] || FIXTURES);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const eligible = manifest.fixtures.filter((f) => ['manual', 'auto-caption'].includes(f.stratum.referenceTier));
  const picked = eligible.filter((f) => !only || only.has(f.id) || only.has(f.stratum.youtubeId));
  const splits = lib.assignVideoSplits(eligible, {
    seed: String(args['split-seed'] ?? 'v1'), heldoutPercent: Number(args['heldout-percent'] ?? 40),
  });
  const splitOf = new Map(existing.map((r) => [r.fixtureId, r.split]));
  const noLlm = Boolean(args['no-llm']);
  const detailPerVideo = Number(args['detail-per-video'] ?? 5);
  const random = sem.rng(Number(args.seed ?? 1));
  const seenQuestions = new Set(existing.map((r) => `${r.fixtureId}|${r.question}`));
  const added = [];
  const stats = { videos: 0, templated: 0, detail: 0, leakyRejected: 0, noQuestion: 0, gaveUp: 0, modelErrors: 0 };

  for (const fixture of picked) {
    const ref = JSON.parse(fs.readFileSync(path.join(dir, 'reference', `${fixture.stratum.youtubeId}.json`), 'utf8'));
    const split = splitOf.get(fixture.id) ?? splits.get(fixture.id);
    const windows = lib.buildWindows(ref.referenceSegments);
    stats.videos += 1;

    const fresh = (rows) => rows.filter((r) => {
      const key = `${r.fixtureId}|${r.question}`;
      if (seenQuestions.has(key)) return false;
      seenQuestions.add(key);
      return true;
    });
    const templated = fresh(lib.templatedRows({ fixture, windows, chapters: ref.chapters, split, random }));
    stats.templated += templated.length;
    added.push(...templated);

    if (noLlm || detailPerVideo <= 0) continue;
    const pool = lib.eligibleWindows(windows);
    const chosen = lib.pickSpread(pool, detailPerVideo, fixture.durationSec, random);
    for (const window of chosen) {
      const questionLanguage = fixture.stratum.language === 'none' ? 'en' : fixture.stratum.language;
      let rejected = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          const retryNote = rejected
            ? `\n\nYour previous question ("${rejected}") copied too much of the excerpt's wording. Ask about the same fact using different words.`
            : '';
          const question = String(
            sem.claudeJson(detailPrompt(fixture, window.text) + retryNote, QUESTION_SCHEMA).question ?? '',
          ).trim();
          if (!question || /^NO_QUESTION\b/i.test(question)) { stats.noQuestion += 1; break; }
          if (lib.isLeakyDetail(question, window.text)) { rejected = question; stats.leakyRejected += 1; continue; }
          const [row] = fresh([lib.detailRow({
            fixture, window, question, questionLanguage, split, generator: 'claude-haiku-5-5',
          })]);
          if (row) { added.push(row); stats.detail += 1; }
          rejected = null;
          break;
        } catch (e) {
          stats.modelErrors += 1;
          console.error(`model error on ${fixture.id} @${window.startSec}s: ${String(e.message).slice(0, 160)}`);
          break;
        }
      }
      if (rejected) stats.gaveUp += 1;
    }
  }

  const merged = [...existing, ...added];
  const errors = lib.validateRows(merged);
  if (errors.length) throw new Error(`refusing to write an invalid dataset:\n${errors.slice(0, 10).join('\n')}`);
  writeAtomic(dataset, sem.toJsonl(merged));
  console.log(JSON.stringify({ added: added.length, total: merged.length, ...stats }));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
