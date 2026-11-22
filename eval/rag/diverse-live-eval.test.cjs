'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ev = require('./diverse-live-eval.cjs');

const gold = { startSec: 100, endSec: 140 };
const hit = (id, reelId, startTime, endTime, evidenceType = 'TRANSCRIPT') => ({ id, reelId, startTime, endTime, evidenceType });

test('scoreHits needs the right reel and an overlapping span for a moment hit', () => {
  const hits = [
    hit('a', 'R2', 100, 140), // right span, wrong reel
    hit('b', 'R1', 500, 540), // right reel, wrong moment
    hit('c', 'R1', 90, 120), // right reel and moment
  ];
  const m = ev.scoreHits(hits, gold, 'R1');
  assert.equal(m.rr, 1 / 3);
  assert.equal(m.recall1, 0);
  assert.equal(m.recall5, 1);
  assert.equal(m.reelRr, 1 / 2);
  assert.equal(m.reelRecall1, 0);
  assert.equal(m.reelRecall5, 1);
  assert.deepEqual(m.relevantRanks, [3]);
});

test('scoreHits counts a long section covering the moment, and never a hit without a span', () => {
  assert.equal(ev.scoreHits([hit('s', 'R1', 0, 480, 'SECTION')], gold, 'R1').recall1, 1);
  assert.equal(ev.scoreHits([{ id: 'x', reelId: 'R1' }], gold, 'R1').recall1, 0);
  assert.equal(ev.scoreHits([], gold, 'R1').rr, 0);
});

test('nearRecall5 forgives a chunk boundary just beside the gold, but not another reel or a far moment', () => {
  const near = ev.scoreHits([hit('n', 'R1', 170, 210)], gold, 'R1'); // 30 s after the gold ends
  assert.equal(near.recall5, 0);
  assert.equal(near.nearRecall5, 1);
  assert.equal(ev.scoreHits([hit('f', 'R1', 400, 440)], gold, 'R1').nearRecall5, 0);
  assert.equal(ev.scoreHits([hit('o', 'R2', 100, 140)], gold, 'R1').nearRecall5, 0);
});

test('scoreHits respects the cutoff', () => {
  const hits = [...Array(5)].map((_, i) => hit(`n${i}`, 'R1', 900, 940)).concat(hit('late', 'R1', 100, 140));
  assert.equal(ev.scoreHits(hits, gold, 'R1', { cutoff: 5 }).recall10, 0);
  assert.equal(ev.scoreHits(hits, gold, 'R1', { cutoff: 30 }).recall10, 1);
});

const map = {
  entries: {
    f1: [{ reelId: 'old', success: false }, { reelId: 'r1a', success: true }, { reelId: 'r1b', success: true }],
    f2: [{ reelId: 'r2', success: true }],
    f3: [{ reelId: 'r3', success: false }],
    f4: [{ reelId: 'r4', success: true }],
    f5: [{ reelId: 'r5', success: true }],
  },
};

test('resolveReelId takes the newest successful upload and ignores failures', () => {
  assert.equal(ev.resolveReelId(map, 'f1'), 'r1b');
  assert.equal(ev.resolveReelId(map, 'f3'), null);
  assert.equal(ev.resolveReelId(map, 'missing'), null);
});

test('scopeFor: whole is unfiltered, reel is the gold reel, mixed adds seeded distractors', () => {
  const row = { id: 'case-1', fixtureId: 'f1' };
  assert.equal(ev.scopeFor('whole', row, map), null);
  assert.deepEqual(ev.scopeFor('reel', row, map), ['r1b']);
  const mixed = ev.scopeFor('mixed:2', row, map);
  assert.equal(mixed[0], 'r1b');
  assert.equal(mixed.length, 3);
  assert.deepEqual(mixed, ev.scopeFor('mixed:2', row, map)); // deterministic per case
  assert.ok(!mixed.slice(1).includes('r1b') && !mixed.includes('r3')); // no self, no unindexed
  assert.throws(() => ev.scopeFor('nope', row, map));
});

test('selectRows keeps REVIEWED rows and honours split and verdict filters', () => {
  const rows = [
    { id: '1', status: 'REVIEWED', split: 'dev', review: { verdict: 'answered' } },
    { id: '2', status: 'REVIEWED', split: 'heldout', review: { verdict: 'partly' } },
    { id: '3', status: 'CANDIDATE', split: 'dev', review: null },
    { id: '4', status: 'REJECTED', split: 'dev', review: { verdict: 'not_answered' } },
  ];
  assert.deepEqual(ev.selectRows(rows, {}).map((r) => r.id), ['1', '2']);
  assert.deepEqual(ev.selectRows(rows, { split: 'dev' }).map((r) => r.id), ['1']);
  assert.deepEqual(ev.selectRows(rows, { verdict: 'answered' }).map((r) => r.id), ['1']);
  const typed = rows.map((r, i) => ({ ...r, type: i === 0 ? 'detail' : 'opening' }));
  assert.deepEqual(ev.selectRows(typed, { types: 'detail,chapter' }).map((r) => r.id), ['1']);
});

test('summarizeBy marks small cells indicative and groups multi-tag items', () => {
  const item = (rr, tags) => ({ rr, recall1: rr === 1 ? 1 : 0, recall5: 1, recall10: 1, reelRr: 1, reelRecall1: 1, reelRecall5: 1, tags });
  const items = [item(1, ['a', 'b']), item(0.5, ['a'])];
  const by = ev.summarizeBy(items, (c) => c.tags);
  assert.equal(by.a.n, 2);
  assert.equal(by.a.rr, 0.75);
  assert.equal(by.b.n, 1);
  assert.equal(by.a.indicative, true);
  const many = Array.from({ length: ev.MIN_CELL }, () => item(1, ['z']));
  assert.equal(ev.summarizeBy(many, (c) => c.tags).z.indicative, false);
});

test('compareRuns pairs shared cases and warns on differing scope', () => {
  const run = (scope, rrs) => ({
    meta: { indexVersions: ['v'], scope, casesSha256: 'x' },
    perCase: rrs.map((rr, i) => ({ id: `c${i}`, rerank: { rr, recall1: rr === 1 ? 1 : 0, recall5: 1, reelRr: 1 } })),
  });
  const out = ev.compareRuns(run('whole', [0.5, 0.5, 1]), run('reel', [1, 1, 1]));
  assert.equal(out.sharedCases, 3);
  assert.ok(out.warnings.some((w) => w.includes('scopes differ')));
  assert.ok(out.metrics.rr.meanDiff > 0);
});

test('buildResult skips stages that nothing scored and counts unbound fixtures', () => {
  const perCase = [
    { id: 'a', split: 'dev', tags: ['t'], retrieval: { rr: 1, recall1: 1, recall5: 1, recall10: 1, reelRr: 1, reelRecall1: 1, reelRecall5: 1 } },
    { id: 'b', split: 'dev', tags: ['t'], unavailable: 'timeout' },
  ];
  const r = ev.buildResult({ unbound: ['f9'] }, perCase);
  assert.equal(r.cases, 2);
  assert.equal(r.unavailable, 1);
  assert.equal(r.unbound, 1);
  assert.deepEqual(Object.keys(r.stages), ['retrieval']);
  assert.equal(r.stages.retrieval.overall.n, 1);
});
