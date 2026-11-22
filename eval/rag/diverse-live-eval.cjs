#!/usr/bin/env node
'use strict';
/**
 * Scores `datasets/rag-diverse-v1.jsonl` against the LIVE reel index.
 *
 * Gold is a time interval on an uploaded video, not a chunk id. A retrieved
 * chunk or section is a hit when it comes from the gold reel and overlaps the
 * interval (see isIntervalHit in diverse-cases-lib.cjs), so re-chunking never
 * invalidates a row. Reported at two levels:
 *   - moment: the right reel AND the right part of it (rr, recall1/5/10)
 *   - reel:   the right reel at all (reelRr, reelRecall1/5)
 *
 * Read-only against the index. Needs RabbitMQ, so run it inside the
 * content-service container (same recipe as semantic-live-eval.cjs):
 *
 *   docker cp eval/rag/diverse-live-eval.cjs eval/rag/diverse-cases-lib.cjs \
 *     eval/rag/semantic-live-eval.cjs eval/rag/semantic-live-eval-lib.cjs \
 *     eval/rag/datasets/rag-diverse-v1.jsonl .benchmarks/diverse-reel-map.json <content-service>:/usr/src/app/
 *   docker exec <content-service> node diverse-live-eval.cjs run \
 *     --cases rag-diverse-v1.jsonl --reel-map diverse-reel-map.json --out /tmp/div-a.json \
 *     [--scope whole|reel|mixed:4] [--split dev|heldout|all] [--verdict answered|any] [--types detail,chapter] [--no-rerank]
 *
 * `compare` is pure:  node eval/rag/diverse-live-eval.cjs compare a.json b.json [--stage rerank]
 *
 * Scopes: `whole` searches the entire index (every other reel competes, the
 * hardest setting); `reel` searches only the gold reel (a question about a video
 * shared in the chat: measures finding the moment inside a long video);
 * `mixed:N` searches the gold reel plus N other diversity reels, like a chat
 * that shared several videos.
 *
 * Only REVIEWED rows count. Rows whose video has no successfully indexed reel
 * are `unbound` and left out of every mean; they are counted, never scored as
 * a miss. Cells under MIN_CELL cases are marked indicative.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const sem = require('./semantic-live-eval-lib.cjs');
const runner = require('./semantic-live-eval.cjs');
const div = require('./diverse-cases-lib.cjs');

const MIN_CELL = 15;
const KEYS = ['rr', 'recall1', 'recall5', 'recall10', 'reelRr', 'reelRecall1', 'reelRecall5', 'nearRecall5'];
// A hit from the right reel within this many seconds of the gold interval is a near miss.
const NEAR_SEC = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

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

/** fixtureId -> reelId of the newest successfully indexed upload, or null. */
function resolveReelId(map, fixtureId) {
  const done = (map.entries?.[fixtureId] ?? []).filter((e) => e.success);
  return done.length ? done[done.length - 1].reelId : null;
}

/** Reel ids to search for a case, or null for the whole index. */
function scopeFor(scope, row, map) {
  const own = resolveReelId(map, row.fixtureId);
  if (scope === 'whole') return null;
  if (scope === 'reel') return [own];
  const m = /^mixed:(\d+)$/.exec(scope);
  if (!m) throw new Error(`--scope must be whole, reel or mixed:N (got ${scope})`);
  const others = Object.keys(map.entries ?? {})
    .filter((f) => f !== row.fixtureId)
    .map((f) => resolveReelId(map, f))
    .filter(Boolean);
  const random = sem.rng(parseInt(crypto.createHash('sha1').update(row.id).digest('hex').slice(0, 8), 16));
  return [own, ...sem.shuffle(others, random).slice(0, Number(m[1]))];
}

/**
 * Score one ranked hit list. `hits` are search hits in rank order
 * ({id, reelId, startTime, endTime, evidenceType}).
 */
function scoreHits(hits, gold, reelId, { cutoff = 30 } = {}) {
  const list = hits.slice(0, cutoff);
  const reelFlags = list.map((h) => h.reelId === reelId);
  const momentFlags = list.map((h, i) => reelFlags[i] && div.isIntervalHit(h, gold));
  const first = (flags) => flags.findIndex(Boolean);
  const rr = (flags) => { const i = first(flags); return i < 0 ? 0 : 1 / (i + 1); };
  const any = (flags, k) => (flags.slice(0, k).some(Boolean) ? 1 : 0);
  return {
    rr: rr(momentFlags),
    recall1: any(momentFlags, 1),
    recall5: any(momentFlags, 5),
    recall10: any(momentFlags, 10),
    reelRr: rr(reelFlags),
    reelRecall1: any(reelFlags, 1),
    reelRecall5: any(reelFlags, 5),
    // Lenient view: right reel and within NEAR_SEC of the gold interval, so a chunk
    // boundary that falls just beside the answer is not read as a total miss.
    nearRecall5: any(list.map((h, i) => reelFlags[i] && typeof h.startTime === 'number' && typeof h.endTime === 'number'
      && h.startTime < gold.endSec + NEAR_SEC && h.endTime > gold.startSec - NEAR_SEC), 5),
    top1Kind: list[0]?.evidenceType ?? null,
    relevantRanks: momentFlags.flatMap((f, i) => (f ? [i + 1] : [])).slice(0, 5),
  };
}

function summarize(items) {
  const out = { n: items.length, indicative: items.length < MIN_CELL };
  for (const k of KEYS) out[k] = Number(mean(items.map((c) => c[k])).toFixed(4));
  return out;
}

function summarizeBy(items, keyFn) {
  const groups = new Map();
  for (const c of items) {
    for (const key of new Set([].concat(keyFn(c)))) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, summarize(v)]));
}

const tagsOf = (row) => [
  `type:${row.type}`, `band:${row.stratum.durationBand}`, `genre:${row.stratum.genre}`,
  `lang:${row.stratum.language}`, `audio:${row.stratum.audioCondition}`,
  `visual:${row.stratum.visualType}`, `tier:${row.referenceTier}`,
  `cross:${row.crossLingual ? 'yes' : 'no'}`, `verdict:${row.review?.verdict ?? 'none'}`,
];

function selectRows(rows, args) {
  let out = rows.filter((r) => r.status === 'REVIEWED');
  if (args.split && args.split !== 'all') out = out.filter((r) => r.split === args.split);
  if (args.types) { const types = new Set(String(args.types).split(',')); out = out.filter((r) => types.has(r.type)); }
  if ((args.verdict ?? 'any') === 'answered') out = out.filter((r) => r.review?.verdict === 'answered');
  if (args.only) { const ids = new Set(String(args.only).split(',')); out = out.filter((r) => ids.has(r.fixtureId)); }
  if (args.limit) out = out.slice(0, Number(args.limit));
  return out;
}

function buildResult(meta, perCase) {
  const stages = {};
  for (const stage of ['retrieval', 'rerank']) {
    const scored = perCase.filter((c) => c[stage]).map((c) => ({ ...c[stage], tags: c.tags, split: c.split }));
    if (!scored.length) continue;
    stages[stage] = {
      overall: summarize(scored),
      bySplit: summarizeBy(scored, (c) => c.split),
      byTag: summarizeBy(scored, (c) => c.tags),
    };
  }
  return {
    meta, cases: perCase.length, unavailable: perCase.filter((c) => c.unavailable).length,
    unbound: meta.unbound?.length ?? 0, stages, perCase,
  };
}

async function run(args, deps = runner.rabbitDeps()) {
  const rows = selectRows(sem.parseJsonl(fs.readFileSync(args.cases, 'utf8')), args);
  const mapRaw = fs.readFileSync(args['reel-map'], 'utf8');
  const map = JSON.parse(mapRaw);
  const scope = String(args.scope ?? 'whole');
  const bound = rows.filter((r) => resolveReelId(map, r.fixtureId));
  const unbound = [...new Set(rows.filter((r) => !resolveReelId(map, r.fixtureId)).map((r) => r.fixtureId))];
  if (!bound.length) throw new Error('no REVIEWED row has an indexed reel yet');

  const searchLimit = Number(args['search-limit'] ?? 30);
  const rerankTop = Number(args['rerank-top'] ?? 12);
  const retries = Number(args.retries ?? 3);
  const retryDelay = Number(args['retry-delay-ms'] ?? 2000);
  const ai = deps.client('ai_queue');
  const index = deps.client('reel_index_query');
  await Promise.all([ai.connect(), index.connect()]);
  let retriedCalls = 0;
  const rpc = async (c, pattern, data, ms) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await deps.firstValueFrom(c.send(pattern, data).pipe(deps.timeout(ms))); }
      catch (error) {
        if (attempt >= retries) throw error;
        retriedCalls += 1;
        await sleep(retryDelay * (attempt + 1));
      }
    }
  };

  const indexVersions = new Set();
  const perCase = [];
  for (const [i, row] of bound.entries()) {
    const reelId = resolveReelId(map, row.fixtureId);
    const entry = { id: row.id, split: row.split, tags: tagsOf(row), fixtureId: row.fixtureId, reelId, type: row.type };
    try {
      const { embedding } = await rpc(ai, 'ai.generate_embedding', { text: row.question, taskType: 'RETRIEVAL_QUERY' }, 20000);
      const reelIds = scopeFor(scope, row, map);
      const hits = await rpc(index, 'index.search_chunks', {
        queryText: row.question, queryEmbedding: embedding.values,
        queryEmbeddingModel: embedding.model, queryEmbeddingVersion: embedding.version,
        limit: searchLimit, candidateLimit: 200, ...(reelIds ? { filters: { reelIds } } : {}),
      }, 15000);
      if (!Array.isArray(hits)) throw new Error('search returned a non-array');
      hits.forEach((h) => h.indexVersion && indexVersions.add(h.indexVersion));
      entry.retrieval = scoreHits(hits, row.gold, reelId, { cutoff: searchLimit });
      entry.hits = hits.slice(0, 10).map((h) => ({
        id: h.id, reelId: h.reelId, startTime: h.startTime ?? null, endTime: h.endTime ?? null,
        evidenceType: h.evidenceType ?? null,
        moment: h.reelId === reelId && div.isIntervalHit(h, row.gold),
      }));
      if (!args['no-rerank'] && hits.length > 1) {
        const top = hits.slice(0, rerankTop);
        const { scores } = await rpc(ai, 'ai.rerank_texts', {
          queryText: row.question, texts: top.map((h) => runner.rerankText(h, null)), budgetMs: 8000,
        }, 12000);
        if (!Array.isArray(scores) || scores.length !== top.length) throw new Error('rerank returned the wrong number of scores');
        const reordered = top.map((h, k) => ({ h, s: scores[k] })).sort((a, b) => b.s - a.s).map((x) => x.h).concat(hits.slice(rerankTop));
        entry.rerank = scoreHits(reordered, row.gold, reelId, { cutoff: searchLimit });
      }
    } catch (error) {
      entry.unavailable = String(error?.message ?? error).slice(0, 200);
    }
    perCase.push(entry);
    process.stderr.write(`\r${i + 1}/${bound.length}`);
    await sleep(Number(args['delay-ms'] ?? 150));
  }
  process.stderr.write('\n');
  await Promise.all([ai.close(), index.close()]);

  const result = buildResult({
    casesSha256: crypto.createHash('sha256').update(fs.readFileSync(args.cases)).digest('hex'),
    reelMapSha256: crypto.createHash('sha256').update(mapRaw).digest('hex'),
    scope, searchLimit, rerankTop, indexVersions: [...indexVersions].sort(), retriedCalls, unbound,
    selection: { split: args.split ?? 'all', verdict: args.verdict ?? 'any', types: args.types ?? 'all' },
    startedAt: new Date().toISOString(),
  }, perCase);
  fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ cases: result.cases, unavailable: result.unavailable, unbound: unbound.length }));
  for (const [stage, s] of Object.entries(result.stages)) console.log(stage, JSON.stringify(s.overall));
  return result;
}

function compareRuns(a, b, stage = 'rerank') {
  const warnings = [];
  if (JSON.stringify(a.meta.indexVersions) !== JSON.stringify(b.meta.indexVersions)) warnings.push('index versions differ');
  if (a.meta.scope !== b.meta.scope) warnings.push(`scopes differ: ${a.meta.scope} vs ${b.meta.scope}`);
  if (a.meta.casesSha256 !== b.meta.casesSha256) warnings.push('case files differ; only shared cases are compared');
  const bById = new Map(b.perCase.filter((c) => c[stage]).map((c) => [c.id, c]));
  const shared = a.perCase.filter((c) => c[stage] && bById.has(c.id));
  if (shared.length < 2) throw new Error(`fewer than 2 shared scored cases for stage ${stage}`);
  const metrics = {};
  for (const k of ['rr', 'recall1', 'recall5', 'reelRr']) {
    metrics[k] = {
      a: Number(mean(shared.map((c) => c[stage][k])).toFixed(4)),
      ...sem.pairedBootstrap(shared.map((c) => c[stage][k]), shared.map((c) => bById.get(c.id)[stage][k])),
    };
  }
  return { stage, sharedCases: shared.length, warnings, metrics };
}

module.exports = { MIN_CELL, buildResult, compareRuns, resolveReelId, run, scopeFor, scoreHits, selectRows, summarize, summarizeBy, tagsOf };

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args._[0] === 'run') {
      if (!args.cases || !args.out || !args['reel-map']) throw new Error('usage: run --cases <jsonl> --reel-map <json> --out <json> [--scope whole|reel|mixed:N] [--split ...] [--verdict answered|any] [--no-rerank]');
      return run(args);
    }
    if (args._[0] === 'compare') {
      const [aFile, bFile] = args._.slice(1);
      if (!aFile || !bFile) throw new Error('usage: compare <a.json> <b.json> [--stage retrieval|rerank]');
      const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
      return console.log(JSON.stringify(compareRuns(read(aFile), read(bFile), args.stage ?? 'rerank'), null, 2));
    }
    throw new Error('usage: diverse-live-eval.cjs run|compare ...');
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
