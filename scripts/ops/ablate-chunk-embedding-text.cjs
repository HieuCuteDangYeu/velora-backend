#!/usr/bin/env node
'use strict';
// Offline ablation: how much does embedding title and tags into every chunk change dense retrieval?
// Ranks each benchmark case's candidate chunks and scenes against its question under four embedding texts
// (evidence only, title + evidence, title + tags + evidence, title + another reel's tags) and reports
// recall@1, recall@3 and MRR. It embeds with the production TEI service, so run it where that service is reachable
// (it was run inside the reel-indexing container) and keep the request rate low.
// Input /tmp/ablation-input.json is built from the benchmark fixtures: { items: [{id, reelId, title, tags, text}],
// cases: [{id, bucket, question, gold: [ids], candidates: [ids]}], reelTags: {reelId: {title, tags}} } where items are
// the fixture chunks and scenes, cases are rows with relevantEvidenceIds present in their fixture, and
// gold = relevantEvidenceIds. See docs/rag-chunk-metadata-embedding-ablation-20261106.md.
const fs = require('fs');
const base = (
  process.env.TEI_EMBEDDING_BASE_URL || 'http://rag-embedding:80'
).replace(/\/+$/, '');
const input = JSON.parse(fs.readFileSync('/tmp/ablation-input.json'));
const reels = Object.keys(input.reelTags).sort();
const otherTags = (reelId) => {
  const i = reels.indexOf(reelId);
  const o = input.reelTags[reels[(i + 1) % reels.length]];
  return o.tags || [];
};
const variants = {
  A_evidence_only: (it) => it.text,
  B_title_evidence: (it) => [it.title, it.text].filter(Boolean).join('\n'),
  C_title_tags_evidence: (it) =>
    [it.title, it.tags.length ? it.tags.join(' ') : '', it.text]
      .filter(Boolean)
      .join('\n'),
  D_wrong_tags: (it) =>
    [it.title, otherTags(it.reelId).join(' '), it.text]
      .filter(Boolean)
      .join('\n'),
};
const cache = new Map();
async function embed(texts) {
  const need = [...new Set(texts)].filter((t) => !cache.has(t));
  for (let i = 0; i < need.length; i += 4) {
    const batch = need.slice(i, i + 4);
    const res = await fetch(base + '/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: batch, truncate: true }),
    });
    if (!res.ok) throw new Error('embed ' + res.status);
    const vecs = await res.json();
    batch.forEach((t, k) => cache.set(t, vecs[k]));
    await new Promise((r) => setTimeout(r, 120));
    if (i % 200 === 0) process.stderr.write(`\r${cache.size} embedded`);
  }
  return texts.map((t) => cache.get(t));
}
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
(async () => {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const qv = new Map();
  const qs = await embed(input.cases.map((c) => c.question));
  input.cases.forEach((c, i) => qv.set(c.id, qs[i]));
  const out = {};
  for (const [name, fn] of Object.entries(variants)) {
    const ids = input.items.map((i) => i.id);
    const vecs = await embed(input.items.map(fn));
    const iv = new Map(ids.map((id, k) => [id, vecs[k]]));
    const per = {};
    for (const c of input.cases) {
      const ranked = c.candidates
        .map((id) => ({ id, s: dot(qv.get(c.id), iv.get(id)) }))
        .sort((a, b) => b.s - a.s);
      const rank = Math.min(
        ...c.gold
          .map((g) => ranked.findIndex((r) => r.id === g) + 1)
          .filter((x) => x > 0),
      );
      const b = (per[c.bucket] = per[c.bucket] || {
        n: 0,
        r1: 0,
        r3: 0,
        mrr: 0,
      });
      b.n++;
      if (rank <= 1) b.r1++;
      if (rank <= 3) b.r3++;
      b.mrr += 1 / rank;
    }
    const tot = { n: 0, r1: 0, r3: 0, mrr: 0 };
    for (const b of Object.values(per)) {
      for (const k of Object.keys(tot)) tot[k] += b[k];
    }
    out[name] = {
      overall: {
        n: tot.n,
        recall1: +(tot.r1 / tot.n).toFixed(3),
        recall3: +(tot.r3 / tot.n).toFixed(3),
        mrr: +(tot.mrr / tot.n).toFixed(3),
      },
      byBucket: Object.fromEntries(
        Object.entries(per).map(([k, b]) => [
          k,
          {
            n: b.n,
            recall1: +(b.r1 / b.n).toFixed(2),
            recall3: +(b.r3 / b.n).toFixed(2),
            mrr: +(b.mrr / b.n).toFixed(3),
          },
        ]),
      ),
    };
  }
  console.log('\n' + JSON.stringify(out));
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
