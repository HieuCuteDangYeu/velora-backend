'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const lib = require('./semantic-live-eval-lib.cjs');

const PASSAGE =
  'After the whole pip thing I was in a funk for days, and my sister finally dragged me to the lake so that I would stop moping around the house.';

const row = (overrides = {}) => ({
  id: 'sem-live-1',
  datasetVersion: lib.DATASET_VERSION,
  question: 'Why did the narrator go to the lake?',
  language: 'en',
  source: 'synthetic',
  status: 'CANDIDATE',
  split: 'dev',
  seriesId: 'pet chat group',
  tags: ['paraphrase'],
  relevant: [{ evidenceId: 'reel:a:chunk:0', grade: 2 }],
  ...overrides,
});

test('leakage flags copied wording but not a paraphrase', () => {
  const copied = lib.leakage(
    'I was in a funk for days after the whole pip thing',
    PASSAGE,
  );
  assert.ok(copied.longestRun >= 4);
  assert.ok(
    lib.isLeaky('I was in a funk for days after the whole pip thing', PASSAGE),
  );
  const paraphrase = 'Why did the narrator end up at the water with a sibling?';
  assert.equal(lib.isLeaky(paraphrase, PASSAGE), false);
});

test('seriesOf strips the episode suffix and is case-insensitive', () => {
  assert.equal(lib.seriesOf('Pet Chat Group Episode 22'), 'pet chat group');
  assert.equal(lib.seriesOf('Pet Chat Group - Episode 3'), 'pet chat group');
  assert.equal(lib.seriesOf(''), 'untitled');
});

test('assignSplit is deterministic, keeps a series together and honours fresh', () => {
  const a = lib.assignSplit({ seriesId: 'pet chat group' });
  assert.equal(a, lib.assignSplit({ seriesId: 'pet chat group' }));
  const splits = new Set(
    Array.from({ length: 200 }, (_, i) =>
      lib.assignSplit({ seriesId: `series-${i}` }),
    ),
  );
  assert.deepEqual([...splits].sort(), ['dev', 'heldout']);
  assert.equal(
    lib.assignSplit({
      seriesId: 'x',
      firstIndexedAt: '2026-12-01T00:00:00Z',
      freshAfter: '2026-11-12T00:00:00Z',
    }),
    'fresh',
  );
  assert.notEqual(
    lib.assignSplit({
      seriesId: 'x',
      firstIndexedAt: '2026-10-01T00:00:00Z',
      freshAfter: '2026-11-12T00:00:00Z',
    }),
    'fresh',
  );
});

test('validateRow accepts a good row and names each defect', () => {
  assert.deepEqual(lib.validateRow(row()), []);
  const bad = lib.validateRow(
    row({ language: 'fr', relevant: [{ evidenceId: 'x', grade: 1 }] }),
  );
  assert.ok(bad.includes('language'));
  assert.ok(bad.includes('relevant needs at least one grade 2 item'));
  assert.ok(
    lib
      .validateRow(row({ status: 'REVIEWED' }))
      .some((e) => e.startsWith('REVIEWED rows need review')),
  );
});

test('validateDataset catches duplicates and a series that spans splits', () => {
  const errors = lib.validateDataset([
    row(),
    row({ id: 'sem-live-2', question: 'Why did the narrator go to the lake?' }),
    row({
      id: 'sem-live-3',
      question: 'What helped the narrator stop moping?',
      split: 'heldout',
    }),
  ]);
  assert.ok(errors.some((e) => e.includes('duplicate question')));
  assert.ok(errors.some((e) => e.includes('spans splits')));
});

test('markStale flags a vanished primary chunk and restores it when it returns', () => {
  const rows = [
    row(),
    row({
      id: 'sem-live-2',
      question: 'Second question here?',
      relevant: [{ evidenceId: 'reel:b:chunk:1', grade: 2 }],
    }),
  ];
  const stale = lib.markStale(rows, new Set(['reel:a:chunk:0']));
  assert.equal(stale[0].status, 'CANDIDATE');
  assert.equal(stale[1].status, 'STALE');
  const back = lib.markStale(
    stale,
    new Set(['reel:a:chunk:0', 'reel:b:chunk:1']),
  );
  assert.equal(back[1].status, 'CANDIDATE');
});

test('markStale catches a chunk whose id survived a reindex but whose text changed', () => {
  const hash = lib.textHash('the original passage');
  const rows = [
    row({
      relevant: [{ evidenceId: 'reel:a:chunk:0', grade: 2, textHash: hash }],
    }),
    row({
      id: 'sem-live-2',
      question: 'Second question here?',
      relevant: [{ evidenceId: 'reel:b:chunk:1', grade: 2 }],
    }),
  ];
  const same = new Map([
    ['reel:a:chunk:0', lib.textHash('the  original\npassage ')],
    ['reel:b:chunk:1', lib.textHash('anything')],
  ]);
  assert.deepEqual(
    lib.markStale(rows, same).map((r) => r.status),
    ['CANDIDATE', 'CANDIDATE'],
    'whitespace is not a change; a row without a hash is only checked by id',
  );
  const changed = new Map(same).set(
    'reel:a:chunk:0',
    lib.textHash('different text now'),
  );
  const stale = lib.markStale(rows, changed);
  assert.equal(stale[0].status, 'STALE');
  assert.equal(stale[0].staleReason, 'changed');
  assert.equal(stale[1].status, 'CANDIDATE');
  const back = lib.markStale(stale, same);
  assert.equal(back[0].status, 'CANDIDATE');
  assert.equal('staleReason' in back[0], false);
  const gone = lib.markStale(rows, new Map([['reel:b:chunk:1', 'x']]));
  assert.equal(gone[0].staleReason, 'missing');
});

test('validateRow rejects a malformed textHash', () => {
  const ok = row({
    relevant: [
      {
        evidenceId: 'reel:a:chunk:0',
        grade: 2,
        textHash: lib.textHash('x'),
      },
    ],
  });
  assert.deepEqual(lib.validateRow(ok), []);
  const bad = row({
    relevant: [{ evidenceId: 'reel:a:chunk:0', grade: 2, textHash: 'nope' }],
  });
  assert.ok(lib.validateRow(bad).some((e) => e.includes('textHash')));
});

test('caseMetrics scores rank, recall and graded nDCG', () => {
  const grades = new Map([
    ['gold', 2],
    ['partial', 1],
  ]);
  const first = lib.caseMetrics(['gold', 'partial', 'x'], grades);
  assert.equal(first.rr, 1);
  assert.equal(first.recall1, 1);
  assert.equal(first.ndcg10, 1);
  const third = lib.caseMetrics(['x', 'y', 'gold'], grades);
  assert.ok(Math.abs(third.rr - 1 / 3) < 1e-9);
  assert.equal(third.recall1, 0);
  assert.equal(third.recall5, 1);
  const miss = lib.caseMetrics(['x', 'y'], grades);
  assert.equal(miss.rr, 0);
  assert.equal(miss.ndcg10, 0);
});

test('summarizeBy groups by every tag a case carries', () => {
  const per = [
    {
      tags: ['vi', 'a'],
      rr: 1,
      rrAny: 1,
      recall1: 1,
      recall5: 1,
      recall10: 1,
      ndcg10: 1,
    },
    {
      tags: ['a'],
      rr: 0,
      rrAny: 0,
      recall1: 0,
      recall5: 0,
      recall10: 0,
      ndcg10: 0,
    },
  ];
  const by = lib.summarizeBy(per, (c) => c.tags);
  assert.equal(by.a.n, 2);
  assert.equal(by.a.rr, 0.5);
  assert.equal(by.vi.n, 1);
  // A tag listed twice on one case must not count that case twice.
  const dup = lib.summarizeBy([per[0]], () => ['vi', 'vi']);
  assert.equal(dup.vi.n, 1);
});

test('pairedBootstrap detects a consistent gain and a null difference', () => {
  const a = Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.5 : 0.25));
  const gain = lib.pairedBootstrap(
    a,
    a.map((x) => x + 0.1),
  );
  assert.equal(gain.meanDiff, 0.1);
  assert.ok(gain.ci95[0] > 0.09);
  const same = lib.pairedBootstrap(a, a);
  assert.deepEqual(same.ci95, [0, 0]);
  assert.throws(() => lib.pairedBootstrap([1], [1, 2]));
});

test('buildCandidateRows drops leaky, duplicate and failed questions deterministically', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `reel:r${i}:chunk:0`,
    reelId: `r${i}`,
    title: `Show ${i % 4} Episode ${i}`,
    text: PASSAGE + ` Variant ${i}.`,
    indexVersion: 'v1',
    firstIndexedAt: '2026-10-01T00:00:00Z',
  }));
  let n = 0;
  const askFn = async () => {
    n += 1;
    if (n === 1) return 'I was in a funk for days after the whole pip thing';
    if (n === 2) throw new Error('model down');
    return `Why did the narrator head to the water, attempt ${n}?`;
  };
  const run = () =>
    lib.buildCandidateRows({
      items,
      askFn,
      total: 5,
      perSeriesMax: 2,
      viShare: 0,
      minChars: 50,
    });
  const out = await run();
  assert.equal(out.rows.length, 5);
  for (const r of out.rows) {
    const item = items.find((i) => i.id === r.relevant[0].evidenceId);
    assert.equal(r.relevant[0].textHash, lib.textHash(item.text));
  }
  assert.equal(out.stats.leaky, 1);
  assert.equal(out.stats.failed, 1);
  const perSeries = {};
  for (const r of out.rows)
    perSeries[r.seriesId] = (perSeries[r.seriesId] ?? 0) + 1;
  assert.ok(Object.values(perSeries).every((c) => c <= 2));
  assert.deepEqual(lib.validateDataset(out.rows), []);
  assert.ok(
    out.rows.every((r) => r.status === 'CANDIDATE' && r.source === 'synthetic'),
  );
  n = 0;
  assert.deepEqual(
    (await run()).rows.map((r) => r.id),
    out.rows.map((r) => r.id),
  );
});

test('buildScopes is deterministic and mixes the requested number of foreign-script reels', () => {
  const mkItem = (reelId, title, text) => ({
    id: `reel:${reelId}:chunk:0`,
    reelId,
    title,
    text,
  });
  const items = [
    mkItem('g', 'Gold Show Episode 1', 'plain english words'),
    ...Array.from({ length: 6 }, (_, i) =>
      mkItem(`e${i}`, `Other ${i} Episode 1`, 'more english words'),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      mkItem(`z${i}`, `Zh Show Episode ${i}`, '你 就 是 这 样 叫 远 山'),
    ),
    mkItem('it', '[IT:fixture] short', '你 好 你 好'),
  ];
  const cases = [
    row({ relevant: [{ evidenceId: 'reel:g:chunk:0', grade: 2 }] }),
  ];
  const a = lib.buildScopes({ items, cases, size: 5, foreign: 2 });
  assert.deepEqual(a, lib.buildScopes({ items, cases, size: 5, foreign: 2 }));
  const ids = a['sem-live-1'];
  assert.equal(ids.length, 5);
  assert.equal(ids[0], 'g');
  assert.equal(ids.filter((r) => r.startsWith('z')).length, 2);
  assert.ok(!ids.includes('it'));
  assert.notDeepEqual(
    a,
    lib.buildScopes({ items, cases, size: 5, foreign: 2, seed: 'other' }),
  );
  assert.throws(
    () => lib.buildScopes({ items, cases, size: 5, foreign: 5 }),
    /foreign/,
  );
  assert.throws(
    () => lib.buildScopes({ items, cases, size: 12, foreign: 0 }),
    /only/,
  );
});

test('a series is fresh only when all of its reels are newer than the cutoff', async () => {
  const mk = (id, title, at) => ({
    id: `reel:${id}:chunk:0`,
    reelId: id,
    title,
    text: PASSAGE + ` ${id}`,
    firstIndexedAt: at,
  });
  const items = [
    mk('old', 'Old Show Episode 1', '2026-10-01T00:00:00Z'),
    mk('newer', 'Old Show Episode 2', '2026-12-01T00:00:00Z'),
    mk('brand', 'Brand New Episode 1', '2026-12-01T00:00:00Z'),
  ];
  let n = 0;
  const { rows } = await lib.buildCandidateRows({
    items,
    askFn: async () =>
      `Why did the narrator choose the water, take ${(n += 1)}?`,
    freshAfter: '2026-11-12T00:00:00Z',
    viShare: 0,
    minChars: 50,
  });
  const split = Object.fromEntries(rows.map((r) => [r.reelId, r.split]));
  assert.equal(split.brand, 'fresh');
  assert.notEqual(split.newer, 'fresh');
  assert.equal(split.old, split.newer);
});

test('the committed dataset, when present, passes validation', () => {
  const file = path.join(__dirname, 'datasets', 'rag-semantic-live-v1.jsonl');
  if (!fs.existsSync(file)) return;
  assert.deepEqual(
    lib.validateDataset(lib.parseJsonl(fs.readFileSync(file, 'utf8'))),
    [],
  );
});
