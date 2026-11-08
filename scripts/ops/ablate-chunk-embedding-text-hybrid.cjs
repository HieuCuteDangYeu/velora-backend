#!/usr/bin/env node
'use strict';
// Hybrid-path version of ablate-chunk-embedding-text.cjs: dense + lexical (a BM25 approximation, because the offline
// fixtures lack the planner's rewritten keyword query) fused by RRF with k=60, then the production TEI cross-encoder
// reranker over the top 12 using the evidence text. Same input file and run location as the dense-only script.
// The reranker accepts ONE text per request (its concurrency limit of 1 counts each text), so it is called per text.
// Hybrid-path ablation: dense + lexical (BM25 approximation) fused by RRF k=60, then TEI cross-encoder rerank of the top 12.
const fs = require('fs');
const tei = (
  process.env.TEI_EMBEDDING_BASE_URL || 'http://rag-embedding:80'
).replace(/\/+$/, '');
const rer = (
  process.env.TEI_RERANKER_BASE_URL || 'http://rag-reranker:80'
).replace(/\/+$/, '');
const input = JSON.parse(fs.readFileSync('/tmp/ablation-input.json'));
const reels = Object.keys(input.reelTags).sort();
const otherTags = (id) =>
  input.reelTags[reels[(reels.indexOf(id) + 1) % reels.length]].tags || [];
const variants = {
  A_evidence_only: (it) => ({
    vec: it.text,
    lex: [it.title, it.title, it.text].join(' '),
  }),
  C_title_tags_evidence: (it) => ({
    vec: [it.title, it.tags.join(' '), it.text].filter(Boolean).join('\n'),
    lex: [it.title, it.title, it.title, it.tags.join(' '), it.text].join(' '),
  }),
  D_wrong_tags: (it) => ({
    vec: [it.title, otherTags(it.reelId).join(' '), it.text]
      .filter(Boolean)
      .join('\n'),
    lex: [
      it.title,
      it.title,
      it.title,
      otherTags(it.reelId).join(' '),
      it.text,
    ].join(' '),
  }),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMB = '/tmp/ablation-emb.json';
const cache = new Map(
  fs.existsSync(EMB) ? Object.entries(JSON.parse(fs.readFileSync(EMB))) : [],
);
async function embed(texts) {
  const need = [...new Set(texts)].filter((t) => !cache.has(t));
  for (let i = 0; i < need.length; i += 4) {
    const batch = need.slice(i, i + 4);
    const res = await fetch(tei + '/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: batch, truncate: true }),
    });
    if (!res.ok) throw new Error('embed ' + res.status);
    (await res.json()).forEach((v, k) => cache.set(batch[k], v));
    await sleep(120);
    if (i % 400 === 0) {
      process.stderr.write(`\r${cache.size} embedded`);
      fs.writeFileSync(EMB, JSON.stringify(Object.fromEntries(cache)));
    }
  }
  fs.writeFileSync(EMB, JSON.stringify(Object.fromEntries(cache)));
  return texts.map((t) => cache.get(t));
}
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const STOP = new Set(
  'a an and are as at be by for from has have he her his i in is it its of on or she that the their them they this to was were what when where which who why with you your me my we our'.split(
    ' ',
  ),
);
const toks = (s) =>
  String(s)
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
const qToks = (q) => [
  ...new Set(toks(q).filter((t) => !STOP.has(t) && t.length > 1)),
];
function bm25Scores(query, docs, idf, avgLen) {
  const qs = qToks(query);
  return docs.map((d) => {
    const tf = {};
    d.forEach((t) => (tf[t] = (tf[t] || 0) + 1));
    let s = 0;
    for (const t of qs) {
      const f = tf[t] || 0;
      if (!f) continue;
      s +=
        ((idf.get(t) || 0) * (f * 2.2)) /
        (f + 1.2 * (0.25 + (0.75 * d.length) / avgLen));
    }
    return s;
  });
}
const rerankCache = new Map();
async function rerank(query, texts) {
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += 1) {
    const idx = [];
    const batch = [];
    for (let k = i; k < Math.min(i + 1, texts.length); k++) {
      const key = query + '\u0000' + texts[k];
      if (rerankCache.has(key)) out[k] = rerankCache.get(key);
      else {
        idx.push(k);
        batch.push(texts[k]);
      }
    }
    if (!batch.length) continue;
    let res;
    for (let attempt = 0; attempt < 12; attempt++) {
      res = await fetch(rer + '/rerank', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: query.slice(0, 400),
          texts: batch.map((t) => t.slice(0, 1500)),
          return_text: false,
          truncate: true,
        }),
      });
      if (res.status !== 429) break;
      await sleep(1500 * (attempt + 1));
    }
    if (!res.ok) throw new Error('rerank ' + res.status);
    for (const r of await res.json()) {
      const k = idx[r.index];
      out[k] = r.score;
      rerankCache.set(query + '\u0000' + texts[k], r.score);
    }
    await sleep(150);
  }
  return out;
}
(async () => {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const qv = new Map();
  const qe = await embed(input.cases.map((c) => c.question));
  input.cases.forEach((c, i) => qv.set(c.id, qe[i]));
  const result = {};
  for (const [name, fn] of Object.entries(variants)) {
    const built = new Map(input.items.map((i) => [i.id, fn(i)]));
    const vecs = await embed(input.items.map((i) => built.get(i.id).vec));
    const iv = new Map(input.items.map((it, k) => [it.id, vecs[k]]));
    const lexTok = new Map(
      input.items.map((i) => [i.id, toks(built.get(i.id).lex)]),
    );
    const df = new Map();
    for (const t of lexTok.values())
      for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
    const N = input.items.length;
    const idf = new Map(
      [...df].map(([w, n]) => [w, Math.log(1 + (N - n + 0.5) / (n + 0.5))]),
    );
    const avgLen = [...lexTok.values()].reduce((s, t) => s + t.length, 0) / N;
    const stages = { dense: {}, rrf: {}, rerank: {} };
    for (const c of input.cases) {
      const dense = c.candidates
        .map((id) => ({ id, s: dot(qv.get(c.id), iv.get(id)) }))
        .sort((a, b) => b.s - a.s);
      const lexS = bm25Scores(
        c.question,
        c.candidates.map((id) => lexTok.get(id)),
        idf,
        avgLen,
      );
      const lex = c.candidates
        .map((id, k) => ({ id, s: lexS[k] }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      const dr = new Map(dense.map((x, k) => [x.id, k + 1])),
        lr = new Map(lex.map((x, k) => [x.id, k + 1]));
      const fused = c.candidates
        .map((id) => ({
          id,
          s: 1 / (60 + dr.get(id)) + (lr.has(id) ? 1 / (60 + lr.get(id)) : 0),
        }))
        .sort((a, b) => b.s - a.s);
      const top = fused.slice(0, 12);
      const sc = await rerank(
        c.question,
        top.map((x) => {
          const it = byId.get(x.id);
          return [it.text, it.title].filter(Boolean).join('\n');
        }),
      );
      const reranked = top
        .map((x, k) => ({ id: x.id, s: sc[k] }))
        .sort((a, b) => b.s - a.s)
        .concat(fused.slice(12));
      for (const [st, list] of [
        ['dense', dense],
        ['rrf', fused],
        ['rerank', reranked],
      ]) {
        const rank = Math.min(
          ...c.gold
            .map((g) => list.findIndex((r) => r.id === g) + 1)
            .filter((x) => x > 0),
        );
        const b = (stages[st][c.bucket] = stages[st][c.bucket] || {
          n: 0,
          r1: 0,
          r3: 0,
          mrr: 0,
        });
        b.n++;
        if (rank <= 1) b.r1++;
        if (rank <= 3) b.r3++;
        b.mrr += isFinite(rank) ? 1 / rank : 0;
      }
    }
    result[name] = {};
    for (const st of Object.keys(stages)) {
      const tot = { n: 0, r1: 0, r3: 0, mrr: 0 };
      for (const b of Object.values(stages[st]))
        for (const k of Object.keys(tot)) tot[k] += b[k];
      result[name][st] = {
        overall: {
          n: tot.n,
          recall1: +(tot.r1 / tot.n).toFixed(3),
          recall3: +(tot.r3 / tot.n).toFixed(3),
          mrr: +(tot.mrr / tot.n).toFixed(3),
        },
        mrrByBucket: Object.fromEntries(
          Object.entries(stages[st]).map(([k, b]) => [
            k,
            +(b.mrr / b.n).toFixed(3),
          ]),
        ),
      };
    }
    process.stderr.write(`\n${name} done`);
  }
  console.log('\n' + JSON.stringify(result));
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
