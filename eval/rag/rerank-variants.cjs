#!/usr/bin/env node
'use strict';
/**
 * Offline replay of rerank variants on saved live-eval runs (no index, no
 * services, no model calls). Needs runs written with per-hit signals
 * (`perCase[].hits[]` with `rerankScore`), i.e. semantic-live-eval.cjs from
 * 2026-11-16 or later.
 *
 *   node eval/rag/rerank-variants.cjs \
 *     --items .benchmarks/semantic-live-items.json \
 *     --run whole=.benchmarks/run-whole.json:eval/rag/datasets/rag-semantic-live-v1.jsonl \
 *     --run x2=.benchmarks/run-x2.json:eval/rag/datasets/rag-semantic-live-v1-crosslingual.jsonl
 *
 * Variants (applied to the first `rerankTop` hits; the tail keeps retrieval order):
 *   retrieval        retrieval order
 *   rerank           cross-encoder order (what production does)
 *   rrf-w{w}-k{k}    weighted reciprocal-rank fusion of the retrieval and rerank ranks
 *   floor-{t}        hits whose rerank score is below t go after the rest, in retrieval order
 *   drop-{t}         hits whose rerank score is below t are removed
 *   script-oracle    REFERENCE ONLY: drops candidates whose script (CJK vs Latin)
 *                    differs from the question's; shows the ceiling and the
 *                    cross-lingual cost of a naive same-script filter
 */
const fs = require('node:fs');
const lib = require('./semantic-live-eval-lib.cjs');

const CJK = /[㐀-鿿]/gu;
const isCjkText = (text) => {
  const t = String(text ?? '').replace(/\s+/gu, '');
  return t.length > 0 && (t.match(CJK) ?? []).length / t.length > 0.5;
};

function variantsFor() {
  const v = [
    ['retrieval', (hits) => hits.map((h) => h.id)],
    ['rerank', (hits) => rerankOrder(hits)],
  ];
  for (const k of [60, 10])
    for (const w of [0.25, 0.5, 0.75])
      v.push([`rrf-w${w}-k${k}`, (hits) => rrf(hits, w, k)]);
  for (const t of [0.0005, 0.001, 0.003, 0.01, 0.03, 0.1]) {
    v.push([`floor-${t}`, (hits) => floor(hits, t, false)]);
    v.push([`drop-${t}`, (hits) => floor(hits, t, true)]);
  }
  return v;
}

const scored = (hits) => hits.filter((h) => typeof h.rerankScore === 'number');
const tailOf = (hits) => hits.filter((h) => typeof h.rerankScore !== 'number');

function rerankOrder(hits) {
  const top = scored(hits).sort((a, b) => b.rerankScore - a.rerankScore);
  return [...top, ...tailOf(hits)].map((h) => h.id);
}

function rrf(hits, w, k) {
  const top = scored(hits);
  const bySem = [...top].sort((a, b) => b.rerankScore - a.rerankScore);
  const semRank = new Map(bySem.map((h, i) => [h.id, i + 1]));
  const retRank = new Map(hits.map((h, i) => [h.id, i + 1]));
  const fused = top
    .map((h) => ({
      id: h.id,
      s: w / (k + semRank.get(h.id)) + (1 - w) / (k + retRank.get(h.id)),
    }))
    .sort((a, b) => b.s - a.s);
  return [...fused.map((x) => x.id), ...tailOf(hits).map((h) => h.id)];
}

function floor(hits, t, drop) {
  const top = scored(hits);
  const high = top
    .filter((h) => h.rerankScore >= t)
    .sort((a, b) => b.rerankScore - a.rerankScore);
  const low = top.filter((h) => h.rerankScore < t);
  return [...high, ...(drop ? [] : low), ...tailOf(hits)].map((h) => h.id);
}

function evaluate({ run, cases, cjkOf, searchLimit }) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rows = [];
  const variants = [
    ...variantsFor(),
    [
      'script-oracle',
      (hits, question) => {
        const qCjk = (question.match(CJK) ?? []).length > 0;
        const kept = hits.filter((h) => cjkOf(h.id) === qCjk);
        return rerankOrder(kept.length ? kept : hits);
      },
    ],
  ];
  for (const [name, fn] of variants) {
    const per = [];
    let zhFirst = 0;
    for (const c of run.perCase) {
      if (c.unavailable || !c.hits) continue;
      const row = byId.get(c.id);
      if (!row) continue;
      const grades = new Map(row.relevant.map((r) => [r.evidenceId, r.grade]));
      const ranked = fn(c.hits, row.question);
      per.push(lib.caseMetrics(ranked, grades, { cutoff: searchLimit }));
      if (ranked[0] && cjkOf(ranked[0]) && !cjkOf(row.relevant[0].evidenceId))
        zhFirst += 1;
    }
    const m = (key) => per.reduce((s, x) => s + x[key], 0) / per.length;
    rows.push({
      variant: name,
      n: per.length,
      mrr: m('rr'),
      hit1: m('recall1'),
      hit5: m('recall5'),
      zhFirst,
    });
  }
  return rows;
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
  const items = JSON.parse(fs.readFileSync(args.items, 'utf8')).items;
  const textById = new Map(items.map((i) => [i.id, i.text]));
  const reelCjk = new Map();
  const cjkOf = (id) => {
    if (!reelCjk.has(id)) reelCjk.set(id, isCjkText(textById.get(id)));
    return reelCjk.get(id);
  };
  const out = {};
  for (const spec of args.run) {
    const [name, rest] = [
      spec.slice(0, spec.indexOf('=')),
      spec.slice(spec.indexOf('=') + 1),
    ];
    const [runFile, casesFile] = rest.split(':');
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    const cases = lib.parseJsonl(fs.readFileSync(casesFile, 'utf8'));
    out[name] = evaluate({
      run,
      cases,
      cjkOf,
      searchLimit: run.meta.searchLimit ?? 30,
    });
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { evaluate, floor, rerankOrder, rrf };
