#!/usr/bin/env node
'use strict';
/**
 * End-to-end layer of the diverse-video benchmark: each question goes to the live Velora bot as a chat
 * turn with only the gold video shared in the conversation, then the reply is scored
 * (eval/rag/diverse-e2e-lib.cjs) and judged by Haiku against the reference passage.
 *
 *   BACKEND_URL=... VELORA_TEST_EMAIL=... VELORA_TEST_PASSWORD=... \
 *   node scripts/ops/run-diverse-e2e.cjs run   --out .benchmarks/diverse-e2e-1.json \
 *       [--types opening,timestamp,chapter,detail] [--per-video 2] [--scope reel|whole] [--grounded] [--only ID,ID] [--split dev|heldout|all] [--limit N] [--pause-ms 3000] [--dry-run]
 *   node scripts/ops/run-diverse-e2e.cjs judge --out .benchmarks/diverse-e2e-1.json
 *   node scripts/ops/run-diverse-e2e.cjs report --out .benchmarks/diverse-e2e-1.json
 *
 * `run` is resumable (the file is rewritten after every row). It uses the production AI, one turn at a time.
 * `judge` needs the `claude` CLI (Haiku, same as ops:rag:judge). Credentials come from the environment and are never printed.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const live = require('./run-photo-live.cjs');
const lib = require('../../eval/rag/diverse-e2e-lib.cjs');
const div = require('../../eval/rag/diverse-cases-lib.cjs');

const CASES = 'eval/rag/datasets/rag-diverse-v1.jsonl';
const MAP = '.benchmarks/diverse-reel-map.json';
const REFERENCE_DIR = 'test-data/reel-integration/diverse/reference';
const BOT_USER_ID = process.env.BOT_USER_ID || 'b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7';

const readRows = () => fs.readFileSync(CASES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const writeAtomic = (file, data) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2)); fs.renameSync(`${file}.tmp`, file); };

function referenceFor(fixtureId) {
  const file = `${REFERENCE_DIR}/${fixtureId.replace(/^diverse-/, '')}.json`;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// `grounded` names the shared video in the message, so the run measures retrieval and answering
// separately from whether the scope router recognises a bare question as being about the shared reel.
const GROUNDED_PREFIX = 'About the video I just shared: ';

async function askOne(request, row, reelId, durationSec, { wait = live.waitForBotReply, scope = 'reel', grounded = false } = {}) {
  const out = { id: row.id, row, reelId, scope, grounded, startedAt: new Date().toISOString() };
  try {
    const conversation = await request('POST', '/conversations', { participantIds: [BOT_USER_ID], type: 'GROUP', isGroup: true, name: `Diverse e2e ${row.id}` });
    if (!conversation?.id) throw new Error('conversation create returned no id');
    out.conversationId = conversation.id;
    // scope 'whole': nothing is shared, so the bot searches the whole index (every other reel competes).
    if (scope === 'reel') await request('POST', `/content/reels/${reelId}/share`, { conversationId: conversation.id, sharedWithUserId: BOT_USER_ID });
    const sent = await request('POST', `/conversations/${conversation.id}/messages`, {
      clientMessageId: `diverse-e2e-${row.id}-${crypto.randomUUID()}`, content: grounded ? `${GROUNDED_PREFIX}${row.question}` : row.question, type: 'text', signalType: 0,
    });
    const bot = await wait(request, conversation.id, sent?.createdAt, { attempts: 75 });
    out.reply = bot ? { answer: typeof bot.content === 'string' ? bot.content : '', citations: lib.citationsOf(bot), messageId: bot.id ?? null } : null;
  } catch (error) {
    out.error = String(error.message).slice(0, 200);
  }
  out.score = lib.scoreReply(row, out.reply || null, { reelId, durationSec });
  out.finishedAt = new Date().toISOString();
  return out;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const [name, inline] = argv[i].slice(2).split('=', 2);
    if (inline !== undefined) args[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { args[name] = argv[i + 1]; i += 1; } else args[name] = true;
  }
  return args;
}

const load = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { meta: { startedAt: new Date().toISOString() }, items: [] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCommand(args) {
  const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  const types = args.types ? String(args.types).split(',') : null;
  const picked = lib.pickRows(readRows(), { types, perVideoPerType: Number(args['per-video'] ?? 2), split: args.split ?? 'all', verdict: args.verdict ?? 'answered', limit: args.limit });
  const only = args.only ? new Set(String(args.only).split(',').map((id) => id.replace(/^diverse-/, ''))) : null;
  const rows = picked.filter((r) => live.resolveReelId(map, r.fixtureId) && (!only || only.has(r.fixtureId.replace(/^diverse-/, ''))));
  if (args['dry-run']) {
    const by = {};
    for (const r of rows) by[r.type] = (by[r.type] || 0) + 1;
    console.log(`dry run: ${rows.length} rows (${picked.length - rows.length} unbound dropped)`, by, 'videos:', new Set(rows.map((r) => r.fixtureId)).size);
    return;
  }
  for (const key of ['BACKEND_URL', 'VELORA_TEST_EMAIL', 'VELORA_TEST_PASSWORD']) if (!process.env[key]) throw new Error(`${key} is not set`);
  const creds = { email: process.env.VELORA_TEST_EMAIL, password: process.env.VELORA_TEST_PASSWORD };
  const request = live.apiClient(process.env.BACKEND_URL, creds);
  await request('POST', '/auth/login', creds);
  const done = load(args.out);
  const finished = new Set(done.items.filter((i) => !i.error).map((i) => i.id));
  const pauseMs = Number(args['pause-ms'] ?? 3000);
  for (const row of rows) {
    if (finished.has(row.id)) continue;
    const reelId = live.resolveReelId(map, row.fixtureId);
    const durationSec = referenceFor(row.fixtureId).fixture?.durationSec;
    const item = await askOne(request, row, reelId, durationSec, { scope: args.scope === 'whole' ? 'whole' : 'reel', grounded: Boolean(args.grounded) });
    done.items = done.items.filter((i) => i.id !== row.id).concat(item);
    done.summary = lib.summarize(done.items);
    writeAtomic(args.out, done);
    console.log(`${row.id} ${row.type} answered=${item.score.answered} cited=${item.score.citedReel} moment=${item.score.momentHit}${item.error ? ' ERROR ' + item.error : ''}`);
    await sleep(pauseMs);
  }
  console.log(JSON.stringify(done.summary.overall));
}

function judgeCommand(args) {
  const { runClaudeDimension } = require('./run-claude-rag-judge.cjs');
  const { buildDimensionPrompt } = require('./rag-judge-prompts.cjs');
  const done = load(args.out);
  let judgedNow = 0;
  for (const item of done.items) {
    if (item.judge || !item.reply?.answer || item.score.unbound) continue;
    const ref = referenceFor(item.row.fixtureId);
    const referenceAnswer = div.referenceTextFor(ref.referenceSegments, item.row);
    if (!referenceAnswer) continue;
    const input = {
      question: item.row.question, generatedAnswer: item.reply.answer, referenceAnswer,
      answerType: item.row.type === 'opening' ? 'FIRST_COMPLETE_SENTENCE' : 'ANSWER',
    };
    try {
      const factual = runClaudeDimension('factualCorrectness', buildDimensionPrompt('factualCorrectness', input));
      const relevancy = runClaudeDimension('responseRelevancy', buildDimensionPrompt('responseRelevancy', input));
      item.judge = { factualCorrectness: factual.score, responseRelevancy: relevancy.score, note: String(factual.reasoning).slice(0, 240), model: 'claude-haiku-5-5' };
      judgedNow += 1;
    } catch (error) {
      item.judgeError = String(error.message).slice(0, 160);
    }
    if (judgedNow % 5 === 0) writeAtomic(args.out, done);
  }
  done.summary = lib.summarize(done.items);
  writeAtomic(args.out, done);
  console.log(`judged ${judgedNow} rows`);
  console.log(JSON.stringify(done.summary.overall));
}

function reportCommand(args) {
  const done = load(args.out);
  const s = lib.summarize(done.items);
  const pct = (v) => (v === null || v === undefined ? '  -  ' : v.toFixed(2));
  console.log('tag'.padEnd(34), 'n'.padStart(4), 'answer scopeRef cited moment judged correct factual relevancy');
  const line = (k, c) => console.log(k.padEnd(34), String(c.n).padStart(4), pct(c.answerRate).padStart(6), pct(c.scopeRefusalRate).padStart(8), pct(c.citedReelRate).padStart(5), pct(c.momentHitRate).padStart(6), String(c.judged).padStart(6), pct(c.correctRate).padStart(7), pct(c.factual).padStart(7), pct(c.relevancy).padStart(8), c.indicative ? ' (indicative)' : '');
  line('overall', s.overall);
  for (const [k, c] of Object.entries(s.byTag)) line(k, c);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!['run', 'judge', 'report'].includes(command) || !args.out && command !== 'run') { console.error('usage: run-diverse-e2e.cjs run|judge|report --out FILE'); process.exit(2); }
  if (command === 'run') { if (!args.out && !args['dry-run']) { console.error('--out is required'); process.exit(2); } return runCommand(args); }
  return command === 'judge' ? judgeCommand(args) : reportCommand(args);
}

module.exports = { askOne, referenceFor };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
