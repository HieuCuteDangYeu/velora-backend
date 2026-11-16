#!/usr/bin/env node
'use strict';
/**
 * Offline replay of the rerank step as chat runs it, using the REAL
 * `EvidenceDiversitySelector` class (apps/ai-service), not a copy, on saved
 * live-eval runs written with `--rerank-format production`.
 *
 * Production order of events (TeiRerankerAdapter.rerank): bound the retrieved
 * chunks to AI_RAG_NEURAL_RERANK_CANDIDATE_LIMIT (12), score them with the
 * cross-encoder, then `EvidenceDiversitySelector.select(scored, limit)` keeps
 * the top `limit` (planner default 8, capped by AI_RAG_RERANK_MAX_LIMIT 10)
 * using MMR (lambda, same-reel and temporal-overlap penalties, Jaccard text
 * similarity). Only those `limit` chunks reach the answer model, so ranks and
 * hit@k below are computed on that selected list.
 *
 * Variants:
 *   rerank          selector on all scored candidates (what chat does today)
 *   floor-{t}       candidates scoring >= t go through the selector first; if
 *                   fewer than `limit` come out, the below-t ones fill the rest,
 *                   ordered by retrieval rank (their relevance is replaced by a
 *                   retrieval-rank score below t) and also through the selector
 *   drop-{t}        only candidates scoring >= t are selectable
 *
 *   node eval/rag/rerank-selector-replay.cjs --items .benchmarks/items.json \
 *     [--limit 8] [--mmr-lambda 0.72 --same-reel 0.25 --temporal 0.7 --max-limit 10] \
 *     --run name=run.json:cases.jsonl ...
 *
 * Defaults mirror the homelab ai-service env read on 2026-11-16.
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./semantic-live-eval-lib.cjs');

const SELECTOR_TS = path.join(
  __dirname,
  '..',
  '..',
  'apps/ai-service/src/infrastructure/adapters/evidence-diversity-selector.ts',
);

function loadSelector(env) {
  require('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
      module: 'commonjs',
      moduleResolution: 'node',
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      target: 'es2022',
      esModuleInterop: true,
    },
  });
  const { EvidenceDiversitySelector } = require(SELECTOR_TS);
  return new EvidenceDiversitySelector({
    get: (key) => env[key],
  });
}

function candidateFor(item, hit) {
  // Shape of ReelContextSearchResult fields the selector reads.
  return {
    chunkId: item.id,
    reelId: item.reelId,
    title: item.title,
    description: item.description ?? undefined,
    tags: item.tags ?? [],
    evidenceText: item.text,
    retrievalText: item.text,
    chunkText: item.text,
    evidenceType: 'TRANSCRIPT',
    startTime: item.startTime,
    endTime: item.endTime,
    score: hit.rrfScore ?? 0,
  };
}

function selectVariant(selector, scored, limit, floor, drop) {
  if (floor === null) return selector.select(scored, limit);
  const high = scored.filter((s) => s.relevanceScore >= floor);
  const low = scored
    .filter((s) => s.relevanceScore < floor)
    // Demoted candidates are ordered by their RETRIEVAL rank (the reranker found
    // them uninformative), with a relevance below the floor so the selector
    // still treats every high candidate as better.
    .map((s) => ({
      ...s,
      relevanceScore: floor * (1 - s.retrievalRank / (scored.length + 1)),
    }));
  const out = high.length ? selector.select(high, limit) : [];
  if (!drop && out.length < limit && low.length)
    out.push(...selector.select(low, limit - out.length));
  return out;
}

const FLOORS = [0.003, 0.01, 0.03, 0.1];

function evaluate({ run, cases, byId, selector, limit, candidateLimit }) {
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const variants = [
    ['rerank', null, false],
    ...FLOORS.flatMap((t) => [
      [`floor-${t}`, t, false],
      [`drop-${t}`, t, true],
    ]),
  ];
  return variants.map(([name, floor, drop]) => {
    const per = [];
    for (const c of run.perCase) {
      if (c.unavailable || !c.hits) continue;
      const row = caseById.get(c.id);
      if (!row) continue;
      const scored = c.hits
        .slice(0, candidateLimit)
        .filter((h) => typeof h.rerankScore === 'number' && byId.has(h.id))
        .map((h, index) => ({
          candidate: candidateFor(byId.get(h.id), h),
          relevanceScore: h.rerankScore,
          retrievalRank: index + 1,
        }));
      const grades = new Map(row.relevant.map((r) => [r.evidenceId, r.grade]));
      const ranked = selectVariant(selector, scored, limit, floor, drop).map(
        (x) => x.chunkId,
      );
      per.push({
        ...lib.caseMetrics(ranked, grades, { cutoff: limit }),
        id: c.id,
        top: ranked[0],
      });
    }
    return { variant: name, per };
  });
}

function summarize(rows) {
  return rows.map(({ variant, per }) => {
    const m = (k) => per.reduce((s, x) => s + x[k], 0) / per.length;
    return {
      variant,
      n: per.length,
      mrr: m('rr'),
      hit1: m('recall1'),
      hit5: m('recall5'),
    };
  });
}

function main(argv) {
  const args = { run: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    const value = argv[(i += 1)];
    if (name === 'run') args.run.push(value);
    else args[name] = value;
  }
  if (!args.items || !args.run.length)
    throw new Error(
      'usage: --items <snapshot.json> --run name=run.json:cases.jsonl ...',
    );
  const limit = Number(args.limit ?? 8);
  const env = {
    AI_RAG_MMR_LAMBDA: args['mmr-lambda'] ?? '0.72',
    AI_RAG_MMR_SAME_REEL_PENALTY: args['same-reel'] ?? '0.25',
    AI_RAG_MMR_TEMPORAL_OVERLAP_PENALTY: args.temporal ?? '0.70',
    AI_RAG_RERANK_MAX_LIMIT: args['max-limit'] ?? '10',
  };
  const selector = loadSelector(env);
  const items = JSON.parse(fs.readFileSync(args.items, 'utf8')).items;
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = { settings: { limit, ...env }, results: {}, perCase: {} };
  for (const spec of args.run) {
    const eq = spec.indexOf('=');
    const name = spec.slice(0, eq);
    const [runFile, casesFile] = spec.slice(eq + 1).split(':');
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    const cases = lib.parseJsonl(fs.readFileSync(casesFile, 'utf8'));
    const rows = evaluate({
      run,
      cases,
      byId,
      selector,
      limit,
      candidateLimit: run.meta.rerankTop ?? 12,
    });
    out.results[name] = summarize(rows);
    out.perCase[name] = Object.fromEntries(
      rows.map((r) => [
        r.variant,
        r.per.map((p) => ({
          id: p.id,
          rr: p.rr,
          hit1: p.recall1,
          hit5: p.recall5,
          top: p.top,
        })),
      ]),
    );
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  }
}

module.exports = { evaluate, loadSelector, selectVariant, summarize };
