'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { firstValueFrom, of, throwError, timeout } = require('rxjs');
const lib = require('./semantic-live-eval-lib.cjs');
const { compareRuns, run, selectCases } = require('./semantic-live-eval.cjs');

const mk = (n, overrides = {}) => ({
  id: `sem-live-${n}`,
  datasetVersion: lib.DATASET_VERSION,
  question: `Why did the narrator do thing number ${n}?`,
  language: 'en',
  source: 'synthetic',
  status: 'REVIEWED',
  split: 'dev',
  seriesId: `series-${n}`,
  tags: ['paraphrase'],
  relevant: [{ evidenceId: `reel:r${n}:chunk:0`, grade: 2 }],
  review: { reviewerId: 'tester', reviewedAt: '2026-11-12T00:00:00Z' },
  ...overrides,
});

test('selectCases defaults to REVIEWED and filters by split and limit', () => {
  const rows = [
    mk(1),
    mk(2, { split: 'heldout' }),
    mk(3, { status: 'CANDIDATE', review: undefined }),
  ];
  assert.deepEqual(
    selectCases(rows, {}).map((r) => r.id),
    ['sem-live-1', 'sem-live-2'],
  );
  assert.deepEqual(
    selectCases(rows, { split: 'heldout' }).map((r) => r.id),
    ['sem-live-2'],
  );
  assert.equal(selectCases(rows, { 'include-candidates': true }).length, 3);
  assert.equal(selectCases(rows, { limit: 1 }).length, 1);
  assert.throws(
    () => selectCases([mk(1, { language: 'xx' })], {}),
    /invalid dataset/,
  );
});

// Fake services: the index returns the gold chunk 2nd for case 1 and 1st for
// case 2; the "reranker" promotes any text containing GOLD. Case 3's search fails.
function fakeDeps(log, { rerankFailsFirst = false } = {}) {
  const failed = new Set();
  const gold = { 1: 'reel:r1:chunk:0', 2: 'reel:r2:chunk:0' };
  const client = (queue) => ({
    connect: async () => {},
    close: async () => {},
    send(pattern, data) {
      log.push(`${queue}:${pattern}`);
      if (pattern === 'ai.generate_embedding')
        return of({
          embedding: {
            values: [0.1, 0.2],
            model: 'bge-m3',
            version: 'v1',
            dimensions: 2,
          },
        });
      if (pattern === 'index.search_chunks') {
        const n = Number(/number (\d)/.exec(data.queryText)[1]);
        if (n === 3) return throwError(() => new Error('index unavailable'));
        const other = {
          id: 'reel:x:chunk:9',
          text: 'unrelated',
          indexVersion: 'iv-1',
        };
        const hit = { id: gold[n], text: 'GOLD passage', indexVersion: 'iv-1' };
        return of(n === 1 ? [other, hit] : [hit, other]);
      }
      if (pattern === 'ai.rerank_texts') {
        if (rerankFailsFirst && !failed.has(data.queryText)) {
          failed.add(data.queryText);
          return throwError(() => new Error('RERANKER_OVERLOADED (429)'));
        }
        return of({
          scores: data.texts.map((t) => (t.includes('GOLD') ? 0.9 : 0.1)),
        });
      }
      throw new Error(`unexpected ${pattern}`);
    },
  });
  return { client, firstValueFrom, timeout };
}

test('run scores retrieval and rerank, and reports failed cases as unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semlive-'));
  const cases = path.join(dir, 'cases.jsonl');
  fs.writeFileSync(cases, lib.toJsonl([mk(1), mk(2), mk(3)]));
  const out = path.join(dir, 'out.json');
  const log = [];
  const result = await run(
    { cases, out, 'delay-ms': 0, 'retry-delay-ms': 0 },
    fakeDeps(log),
  );

  assert.equal(result.cases, 3);
  assert.equal(result.unavailable, 1);
  assert.deepEqual(result.meta.indexVersions, ['iv-1']);
  assert.equal(result.meta.embedding.model, 'bge-m3');
  // Retrieval: rr = 1/2 and 1 -> mean 0.75. The failed case is not a miss.
  assert.equal(result.stages.retrieval.overall.n, 2);
  assert.equal(result.stages.retrieval.overall.rr, 0.75);
  // The reranker fixes case 1, so rerank rr = 1 for both.
  assert.equal(result.stages.rerank.overall.rr, 1);
  assert.equal(result.stages.rerank.bySplit.dev.n, 2);
  assert.ok(result.stages.rerank.byTag.paraphrase);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).cases, 3);
  assert.ok(log.includes('reel_index_query:index.search_chunks'));

  const none = await run(
    { cases, out, 'no-rerank': true, 'delay-ms': 0, 'retry-delay-ms': 0 },
    fakeDeps([]),
  );
  assert.equal(none.stages.rerank, undefined);
});

test('run retries a transient failure and still reports a persistent one as unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semlive-'));
  const cases = path.join(dir, 'cases.jsonl');
  fs.writeFileSync(cases, lib.toJsonl([mk(1), mk(2), mk(3)]));
  const base = { cases, out: path.join(dir, 'o.json'), 'delay-ms': 0 };
  const result = await run(
    { ...base, 'retry-delay-ms': 0 },
    fakeDeps([], { rerankFailsFirst: true }),
  );
  // Both rerank calls fail once and then succeed; case 3's search keeps failing.
  assert.equal(result.stages.rerank.overall.n, 2);
  assert.equal(result.unavailable, 1);
  assert.equal(result.meta.retriedCalls, 2 + 3);
  const strict = await run(
    { ...base, retries: 0 },
    fakeDeps([], { rerankFailsFirst: true }),
  );
  assert.equal(
    strict.stages.rerank,
    undefined,
    'no retries: every rerank fails',
  );
  assert.equal(strict.meta.retriedCalls, 0);
});

test('run refuses to score when no reviewed case exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semlive-'));
  const cases = path.join(dir, 'cases.jsonl');
  fs.writeFileSync(
    cases,
    lib.toJsonl([mk(1, { status: 'CANDIDATE', review: undefined })]),
  );
  await assert.rejects(
    run({ cases, out: path.join(dir, 'o.json') }, fakeDeps([])),
    /no cases selected/,
  );
});

test('compareRuns pairs shared cases, warns on index drift and small n', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semlive-'));
  const cases = path.join(dir, 'cases.jsonl');
  fs.writeFileSync(cases, lib.toJsonl([mk(1), mk(2)]));
  const a = await run(
    {
      cases,
      out: path.join(dir, 'a.json'),
      'delay-ms': 0,
      'retry-delay-ms': 0,
    },
    fakeDeps([]),
  );
  const b = JSON.parse(JSON.stringify(a));
  b.meta.indexVersions = ['iv-2'];
  const retrieval = compareRuns(a, b, 'retrieval');
  assert.equal(retrieval.sharedCases, 2);
  assert.equal(retrieval.metrics.rr.meanDiff, 0);
  assert.ok(
    retrieval.warnings.some((w) => w.includes('index versions differ')),
  );
  assert.ok(retrieval.warnings.some((w) => w.includes('only 2 shared cases')));
  const gain = compareRuns(a, a, 'rerank');
  assert.equal(gain.metrics.rr.a, 1);
  // Retrieval vs rerank of the same run: rr 0.75 -> 1.
  const mixed = {
    ...a,
    perCase: a.perCase.map((c) => ({ ...c, rerank: c.retrieval })),
  };
  assert.equal(compareRuns(mixed, a, 'rerank').metrics.rr.meanDiff, 0.25);
  assert.throws(
    () => compareRuns(a, { ...a, perCase: [] }, 'rerank'),
    /fewer than 2/,
  );
});
