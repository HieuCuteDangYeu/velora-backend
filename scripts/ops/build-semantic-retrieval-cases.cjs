#!/usr/bin/env node
'use strict';
// Builds the semantic retrieval cases used by ablate-chunk-embedding-text-hybrid.cjs: it samples one transcript chunk
// per reel, asks Claude Haiku 5.5 (claude CLI) to write one natural content question the chunk answers, and ranks that
// question against about 100 candidates from the gold reel plus other episodes of the same series. Input
// ./input.json is the fixture-derived { items, cases, reelTags } file; output ./input-sem.json has the same shape.
// Generates one natural content question per sampled transcript chunk with Haiku (claude CLI), then builds ranking cases.
const fs = require('fs'),
  { spawnSync } = require('child_process');
const inp = JSON.parse(fs.readFileSync('input.json'));
let seed = 12345;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const shuffle = (a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const isChunk = (i) => /:chunk:/.test(i.id) && i.text.length > 220;
const byReel = new Map();
for (const it of inp.items) {
  if (!byReel.has(it.reelId)) byReel.set(it.reelId, []);
  byReel.get(it.reelId).push(it);
}
const series = (t) =>
  String(t)
    .replace(/\s*episode\s*\d+\s*$/i, '')
    .trim();
const reelIds = [...byReel.keys()];
const seriesOf = (rid) => series(byReel.get(rid)[0].title);
const goldReels = shuffle(
  reelIds.filter((r) => byReel.get(r).some(isChunk)),
).slice(0, 80);
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  properties: { question: { type: 'string' } },
};
function ask(text) {
  const prompt = `Below is a passage from a short video's transcript. Write ONE natural question a viewer might ask about what is said or happens in this passage, answerable from the passage. Do not quote it verbatim, and do not mention timestamps, seconds, "segment", "passage" or episode numbers. Keep it under 25 words.\n\nPASSAGE:\n${text.slice(0, 900)}`;
  const r = spawnSync(
    'claude',
    [
      '-p',
      '--model',
      'claude-haiku-5-5',
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
      timeout: 120000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TERM: 'dumb',
        NO_COLOR: '1',
      },
    },
  );
  const e = JSON.parse(r.stdout);
  if (e.is_error || !e.structured_output) throw new Error('gen failed');
  return e.structured_output.question.trim();
}
const cases = [];
const need = new Set();
for (const rid of goldReels) {
  const chunks = byReel.get(rid).filter(isChunk);
  const gold = shuffle(chunks)[0];
  let q;
  try {
    q = ask(gold.text);
  } catch {
    continue;
  }
  const sameSeries = shuffle(
    reelIds.filter((r) => r !== rid && seriesOf(r) === seriesOf(rid)),
  );
  const others = shuffle(
    reelIds.filter((r) => r !== rid && !sameSeries.includes(r)),
  );
  const picks = [
    rid,
    ...sameSeries.slice(0, 4),
    ...others.slice(0, Math.max(0, 4 - sameSeries.length)),
  ];
  const candidates = picks.flatMap((r) =>
    byReel
      .get(r)
      .filter((i) => /:chunk:/.test(i.id) || /:visual:/.test(i.id))
      .map((i) => i.id),
  );
  candidates.forEach((c) => need.add(c));
  cases.push({
    id: 'sem-' + gold.id,
    bucket: 'SEMANTIC',
    question: q,
    gold: [gold.id],
    candidates: [...new Set(candidates)],
  });
  process.stderr.write(`\r${cases.length}`);
}
const items = inp.items.filter((i) => need.has(i.id));
fs.writeFileSync(
  'input-sem.json',
  JSON.stringify({ items, cases, reelTags: inp.reelTags }),
);
console.log(
  '\ncases',
  cases.length,
  'items',
  items.length,
  'mean candidates',
  (cases.reduce((s, c) => s + c.candidates.length, 0) / cases.length).toFixed(
    1,
  ),
);
console.log(
  cases
    .slice(0, 5)
    .map((c) => '- ' + c.question)
    .join('\n'),
);
