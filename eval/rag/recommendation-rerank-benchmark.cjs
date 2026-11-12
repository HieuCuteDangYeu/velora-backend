'use strict';
/**
 * Offline benchmark for the feed's neural rerank (content-service
 * `applyNeuralRerank`). Read-only: it reads ReelViewEvent / Reel, and calls
 * ai-service for embeddings and `ai.rerank_texts`; it writes nothing.
 *
 * Labels come from non-REPLAY view events: positive = completed or
 * WATCH_END/COMPLETE at >= 70% watched, negative = skipped. Per viewer with
 * >= 8 of each, interest tags (or the titles of the 5 most recent positives)
 * are built from the TRAIN positives only and the scorers are compared on the
 * held-out reels by AUC, over one chronological and SPLITS random 60/40
 * splits. It also replays the production blend (top-20 reordered by a centered
 * cross-encoder shift) with min-max and rank normalization.
 *
 * It needs the live Prisma client, RabbitMQ and the reranker, so run it inside
 * the content-service container (no deps to install; remove it afterwards):
 *
 *   docker cp eval/rag/recommendation-rerank-benchmark.cjs <content-service>:/usr/src/app/
 *   docker exec <content-service> node recommendation-rerank-benchmark.cjs
 *   docker exec -u root <content-service> rm /usr/src/app/recommendation-rerank-benchmark.cjs
 *
 * Env: SPLITS (default 30). Takes ~5-10 minutes: the TEI reranker scores one
 * text per request (~40-60 ms), so it shares capacity with live RAG chat.
 *
 * Caveats (2026-11-12 run): only 2 viewers had usable labels, the catalog has
 * 16 distinct tags (253 of 257 reels share two), and only reels the viewer saw
 * are scored. Treat differences below ~0.05 AUC as noise.
 */
const { PrismaClient } = require('@prisma/content-client');
const { ClientProxyFactory, Transport } = require('@nestjs/microservices');
const { firstValueFrom, timeout } = require('rxjs');
const SPLITS = Number(process.env.SPLITS ?? 30),
  TOPK = 20,
  RECENT = 5;
const rng = (seed) => {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
};
const auc = (pos, neg) => {
  let w = 0;
  for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const cos = (a, b) => {
  let d = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / Math.sqrt(na * nb);
};
const minmax = (xs) => {
  const lo = Math.min(...xs),
    hi = Math.max(...xs);
  return xs.map((x) => (hi - lo < 1e-9 ? 0.5 : (x - lo) / (hi - lo)));
};
const rankNorm = (xs) => {
  const n = xs.length;
  if (n < 2) return xs.map(() => 0.5);
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const r = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && xs[idx[j + 1]] === xs[idx[i]]) j++;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  if (Math.max(...xs) - Math.min(...xs) < 1e-6) return xs.map(() => 0.5);
  return r.map((v) => v / (n - 1));
};
const ai = ClientProxyFactory.create({
  transport: Transport.RMQ,
  options: {
    urls: [process.env.RABBITMQ_URL],
    queue: 'ai_queue',
    queueOptions: { durable: true },
  },
});
const rpc = (p, d, ms = 150000) =>
  firstValueFrom(ai.send(p, d).pipe(timeout(ms)));

(async () => {
  const prisma = new PrismaClient();
  await ai.connect();
  const q = async (sql) =>
    (await prisma.$queryRawUnsafe(sql)).map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [
          k,
          typeof v === 'bigint' ? Number(v) : v,
        ]),
      ),
    );
  const labelRows = await q(`select "userId" u, "reelId" r,
      bool_or(completed or (("eventType" in ('WATCH_END','COMPLETE')) and coalesce("percentageWatched",0) >= 70)) pos,
      bool_or(skipped or "eventType"='SKIP') skip, min("occurredAt") first_at
    from "ReelViewEvent" where "eventType" <> 'REPLAY' group by 1,2`);
  const byViewer = new Map();
  for (const r of labelRows) {
    if (!r.pos && !r.skip) continue;
    const l = byViewer.get(r.u) ?? [];
    l.push({
      reel: r.r,
      label: r.pos ? 1 : 0,
      at: new Date(r.first_at).getTime(),
    });
    byViewer.set(r.u, l);
  }
  const eligible = [...byViewer.values()].filter(
    (l) =>
      l.filter((x) => x.label).length >= 8 &&
      l.filter((x) => !x.label).length >= 8,
  );
  const reelIds = [...new Set(eligible.flat().map((x) => x.reel))];
  const reels = new Map(
    (
      await prisma.reel.findMany({
        where: { id: { in: reelIds } },
        select: { id: true, title: true, description: true, tags: true },
      })
    ).map((r) => [r.id, r]),
  );
  const docOf = (r) =>
    [r.title, r.description, r.tags.join(' ')]
      .map((x) => x && x.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 1000) || r.id;
  const emb = new Map();
  for (let i = 0; i < reelIds.length; i += 50) {
    const res = await rpc('ai.generate_embedding_batch', {
      items: reelIds
        .slice(i, i + 50)
        .map((id) => ({
          id,
          text: docOf(reels.get(id)),
          taskType: 'RETRIEVAL_DOCUMENT',
        })),
    });
    res.embeddings.forEach((e) => emb.set(e.id, e.values));
  }
  const qEmb = new Map(),
    cross = new Map();
  const queryEmb = async (t) => {
    if (!qEmb.has(t))
      qEmb.set(
        t,
        (
          await rpc('ai.generate_embedding', {
            text: t,
            taskType: 'RETRIEVAL_QUERY',
          })
        ).embedding.values,
      );
    return qEmb.get(t);
  };
  const crossScores = async (t, ids) => {
    const need = ids.filter((id) => !cross.has(t + '|' + id));
    for (let i = 0; i < need.length; i += 50) {
      const chunk = need.slice(i, i + 50);
      const { scores } = await rpc('ai.rerank_texts', {
        queryText: t,
        texts: chunk.map((id) => docOf(reels.get(id))),
        budgetMs: 140000,
      });
      chunk.forEach((id, k) => cross.set(t + '|' + id, scores[k]));
    }
    return ids.map((id) => cross.get(t + '|' + id));
  };
  const a = (items, key) =>
    auc(
      items.filter((i) => i.label).map((i) => i[key]),
      items.filter((i) => !i.label).map((i) => i[key]),
    );
  // production behaviour: base order, top-K reordered by centered normalized cross score
  const blend = (items, baseKey, crossKey, norm, w) => {
    const base = minmax(items.map((i) => i[baseKey]));
    const order = items.map((_, i) => i).sort((x, y) => base[y] - base[x]);
    const head = order.slice(0, TOPK),
      tail = order.slice(TOPK);
    const cn = norm(head.map((i) => items[i][crossKey]));
    const cnOf = new Map(head.map((i, k) => [i, cn[k]]));
    const nh = [...head].sort(
      (x, y) =>
        base[y] + w * (cnOf.get(y) - 0.5) - (base[x] + w * (cnOf.get(x) - 0.5)),
    );
    const pos = [],
      neg = [];
    [...nh, ...tail].forEach((idx, p, arr) =>
      (items[idx].label ? pos : neg).push(arr.length - p),
    );
    return auc(pos, neg);
  };

  const evalSplit = async (train, test) => {
    const trainPos = train.filter((x) => x.label);
    const tagW = new Map();
    for (const x of trainPos)
      for (const t of reels.get(x.reel).tags) {
        const k = t.trim().toLowerCase();
        tagW.set(k, (tagW.get(k) ?? 0) + 1);
      }
    const tagQuery = [...tagW.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 20)
      .map(([t]) => t)
      .join(' ');
    const recent = [...trainPos]
      .sort((x, y) => y.at - x.at)
      .slice(0, RECENT)
      .map((x) => (reels.get(x.reel).title ?? '').trim())
      .filter(Boolean);
    const titleQuery =
      [...new Set(recent)].join('. ').slice(0, 400) || tagQuery;
    if (
      !tagQuery ||
      test.filter((x) => x.label).length < 2 ||
      test.filter((x) => !x.label).length < 2
    )
      return null;
    const [qTag, qTitle] = [
      await queryEmb(tagQuery),
      await queryEmb(titleQuery),
    ];
    const [cTag, cTitle] = [
      await crossScores(
        tagQuery,
        test.map((x) => x.reel),
      ),
      await crossScores(
        titleQuery,
        test.map((x) => x.reel),
      ),
    ];
    const centroid = emb
      .get(trainPos[0].reel)
      .map((_, d) => mean(trainPos.map((x) => emb.get(x.reel)[d])));
    const items = test.map((x, i) => {
      const tags = reels.get(x.reel).tags.map((t) => t.trim().toLowerCase());
      const maxW = Math.max(...tagW.values());
      return {
        label: x.label,
        tag: tags.length ? mean(tags.map((t) => (tagW.get(t) ?? 0) / maxW)) : 0,
        biTag: cos(qTag, emb.get(x.reel)),
        crossTag: cTag[i],
        biTitle: cos(qTitle, emb.get(x.reel)),
        crossTitle: cTitle[i],
        centroid: cos(centroid, emb.get(x.reel)),
      };
    });
    const out = {
      n: items.length,
      pos: items.filter((i) => i.label).length,
      titleQuery,
    };
    for (const k of [
      'tag',
      'biTag',
      'crossTag',
      'biTitle',
      'crossTitle',
      'centroid',
    ])
      out[k] = a(items, k);
    for (const [qn, bk, ck] of [
      ['Tag', 'biTag', 'crossTag'],
      ['Title', 'biTitle', 'crossTitle'],
    ]) {
      out['base' + qn] = blend(items, bk, ck, minmax, 0);
      out['mm04' + qn] = blend(items, bk, ck, minmax, 0.4);
      out['rk04' + qn] = blend(items, bk, ck, rankNorm, 0.4);
      out['rk10' + qn] = blend(items, bk, ck, rankNorm, 1.0);
    }
    return out;
  };

  let vi = 0;
  for (const labeled of eligible) {
    vi++;
    labeled.sort((x, y) => x.at - y.at);
    const cut = Math.floor(labeled.length * 0.6);
    const chrono = await evalSplit(labeled.slice(0, cut), labeled.slice(cut));
    const rand = rng(1234 + vi),
      res = [];
    for (let s = 0; s < SPLITS; s++) {
      const arr = [...labeled];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      const r = await evalSplit(arr.slice(0, cut), arr.slice(cut));
      if (r) res.push(r);
      if (s % 10 === 9) console.error('viewer', vi, 'split', s + 1);
    }
    const f = (k) =>
      `${mean(res.map((r) => r[k])).toFixed(3)}±${sd(res.map((r) => r[k])).toFixed(2)}`;
    console.log(
      `\n== viewer ${vi}: ${labeled.filter((x) => x.label).length} pos / ${labeled.filter((x) => !x.label).length} neg | ${res.length} random 60/40 splits, mean AUC ±sd`,
    );
    if (chrono)
      console.log(
        ' chrono sample title-query:',
        JSON.stringify(chrono.titleQuery.slice(0, 120)),
      );
    console.log(
      ' scorers alone   : tagOverlap',
      f('tag'),
      '| biTag',
      f('biTag'),
      '| crossTag',
      f('crossTag'),
      '| biTitle',
      f('biTitle'),
      '| crossTitle',
      f('crossTitle'),
      '| positives-centroid(ref)',
      f('centroid'),
    );
    for (const qn of ['Tag', 'Title'])
      console.log(
        ` top-${TOPK} blend, ${qn} query: base(bi only)`,
        f('base' + qn),
        '| minmax w.4 (prod)',
        f('mm04' + qn),
        '| rank w.4',
        f('rk04' + qn),
        '| rank w1.0',
        f('rk10' + qn),
      );
    const w = (k1, k2) =>
      `${res.filter((r) => r[k1] > r[k2]).length}/${res.length}`;
    console.log(
      ` wins: crossTitle>crossTag ${w('crossTitle', 'crossTag')} | biTitle>biTag ${w('biTitle', 'biTag')} | rank.4>minmax.4 (tag) ${w('rk04Tag', 'mm04Tag')} | rank.4(title)>base(title) ${w('rk04Title', 'baseTitle')} | crossTitle>centroid ${w('crossTitle', 'centroid')}`,
    );
    if (chrono)
      console.log(
        ' chrono split (n=' + chrono.n + ', pos=' + chrono.pos + '): crossTag',
        chrono.crossTag.toFixed(3),
        'crossTitle',
        chrono.crossTitle.toFixed(3),
        'biTitle',
        chrono.biTitle.toFixed(3),
        'centroid',
        chrono.centroid.toFixed(3),
        '| title blend rank.4',
        chrono.rk04Title.toFixed(3),
        'vs base',
        chrono.baseTitle.toFixed(3),
      );
  }
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => {
  console.log(
    'ERR',
    String(e && (e.message || JSON.stringify(e))).slice(0, 300),
  );
  process.exit(1);
});
