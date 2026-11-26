const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { tupleFilter, summarizeTimes } = require('./qdrant-read-stress.cjs');

test('tupleFilter mirrors QdrantReelVectorStoreAdapter structure', () => {
  assert.deepEqual(
    tupleFilter({
      reelId: 'r1',
      indexAttemptId: 'a1',
      projectionGeneration: '3',
      manifestHash: 'm1',
    }),
    {
      must: [
        { key: 'reelId', match: { value: 'r1' } },
        { key: 'indexAttemptId', match: { value: 'a1' } },
        { key: 'projectionGeneration', match: { value: '3' } },
        { key: 'manifestHash', match: { value: 'm1' } },
      ],
    },
  );
  assert.deepEqual(summarizeTimes([10, 20, 30, 40]), {
    min: 10,
    p50: 20,
    p95: 40,
    p99: 40,
    max: 40,
    mean: 25,
  });
});

test('qdrant-read-stress runs end-to-end against mock local HTTP Qdrant nodes', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'qdrant-stress-test-'));
  const keyFile = join(dir, 'api-key');
  const tuplesFile = join(dir, 'tuples.json');
  await fs.writeFile(keyFile, 'test-secret-key\n');

  const points = [];
  const tuples = [];
  const vec = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
  for (let r = 0; r < 10; r++) {
    const reelId = `reel-${r}`;
    const tuple = {
      reelId,
      indexAttemptId: `att-${r}`,
      projectionGeneration: '2',
      manifestHash: `mh-${r}`,
    };
    tuples.push(tuple);
    for (const kind of ['REEL', 'CHUNK']) {
      points.push({
        id: `00000000-0000-4000-8000-${String(r * 10 + (kind === 'CHUNK' ? 1 : 0)).padStart(12, '0')}`,
        vector: vec,
        payload: { kind, ...tuple },
      });
    }
    // Stale orphan point excluded by active tuples
    points.push({
      id: `00000000-0000-4000-8000-${String(r * 10 + 9).padStart(12, '0')}`,
      vector: vec,
      payload: {
        kind: 'CHUNK',
        reelId,
        indexAttemptId: `att-old-${r}`,
        projectionGeneration: '1',
        manifestHash: 'old',
      },
    });
  }
  await fs.writeFile(tuplesFile, JSON.stringify(tuples));

  const seenBodies = [];
  const hitsByPort = { a: 0, b: 0 };

  function makeServer(name) {
    return http.createServer((req, res) => {
      assert.equal(req.headers['api-key'], 'test-secret-key');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/readyz') {
          res.writeHead(200);
          res.end('all shards are ready');
          return;
        }
        const body = raw ? JSON.parse(raw) : {};
        if (req.url.endsWith('/points/scroll')) {
          const offset = body.offset;
          const idx = offset ? points.findIndex((p) => p.id >= offset) : 0;
          const slice =
            idx >= 0 ? points.slice(idx, idx + (body.limit || 10)) : [];
          const next =
            idx >= 0 && idx + (body.limit || 10) < points.length
              ? points[idx + (body.limit || 10)].id
              : null;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              result: {
                points: slice.map((p) => ({
                  id: p.id,
                  payload: p.payload,
                  ...(body.with_vector ? { vector: p.vector } : {}),
                })),
                next_page_offset: next,
              },
            }),
          );
          return;
        }
        if (req.url.endsWith('/points/query')) {
          hitsByPort[name]++;
          if (seenBodies.length < 4) seenBodies.push(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              result: {
                points: [
                  { id: points[1].id, score: 1, payload: points[1].payload },
                ],
              },
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });
    });
  }

  const sA = makeServer('a');
  const sB = makeServer('b');
  await new Promise((r) => sA.listen(0, '127.0.0.1', r));
  await new Promise((r) => sB.listen(0, '127.0.0.1', r));
  const portA = sA.address().port;
  const portB = sB.address().port;

  try {
    const run = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          join(__dirname, 'qdrant-read-stress.cjs'),
          `--targets=A=http://127.0.0.1:${portA},B=http://127.0.0.1:${portB}`,
          '--scope=both',
          '--concurrencies=2',
          '--warmup-seconds=0',
          '--duration-seconds=1',
          `--api-key-file=${keyFile}`,
          `--tuples-file=${tuplesFile}`,
          '--sample-size=10',
          '--narrow-reels=4',
          '--limit=100',
        ],
        { env: { ...process.env, QDRANT_ALLOW_LOCAL_HTTP: 'true' } },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n');
    const meta = JSON.parse(lines[0].replace(/^META /, ''));
    assert.equal(meta.totalPointsInQdrant, 30);
    assert.equal(meta.currentPoints, 20);
    assert.equal(meta.currentTuples, 10);
    assert.equal(meta.sampledVectors, 10);
    assert.equal(meta.workloads.wide.admittedPoints, 20);
    assert.equal(meta.workloads.narrow.scopeReels, 4);

    const stages = lines
      .slice(1)
      .map((l) => JSON.parse(l.replace(/^STAGE /, '')));
    assert.equal(stages.length, 2);
    assert.equal(stages[0].scope, 'wide');
    assert.equal(stages[1].scope, 'narrow');
    assert.ok(stages[0].successes > 0);
    assert.equal(stages[0].errors, 0);
    assert.ok(hitsByPort.a > 0 && hitsByPort.b > 0);

    const wideReq = seenBodies[0];
    assert.deepEqual(wideReq.params, { exact: true });
    assert.equal(wideReq.limit, 100);
    assert.equal(wideReq.with_payload, true);
    assert.equal(wideReq.with_vector, false);
    assert.equal(wideReq.filter.must[0].has_id.length, 20);
    assert.equal(wideReq.filter.must[2].should.length, 10);
  } finally {
    sA.close();
    sB.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('least-inflight routing sends more queries to the faster target', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'qdrant-stress-route-'));
  const keyFile = join(dir, 'api-key');
  const tuplesFile = join(dir, 'tuples.json');
  await fs.writeFile(keyFile, 'test-secret-key\n');
  const vec = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
  const tuples = [];
  const points = [];
  for (let r = 0; r < 4; r++) {
    const tuple = {
      reelId: `reel-${r}`,
      indexAttemptId: `att-${r}`,
      projectionGeneration: '1',
      manifestHash: `mh-${r}`,
    };
    tuples.push(tuple);
    points.push({
      id: `00000000-0000-4000-8000-${String(r).padStart(12, '0')}`,
      vector: vec,
      payload: { kind: 'CHUNK', ...tuple },
    });
  }
  await fs.writeFile(tuplesFile, JSON.stringify(tuples));
  const hits = { fast: 0, slow: 0 };
  const makeServer = (name, delayMs) =>
    http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.url === '/readyz') return send(200, {});
        if (req.url.endsWith('/points/scroll')) {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          return send(200, {
            status: 'ok',
            result: {
              points: points.map((p) => ({
                id: p.id,
                payload: p.payload,
                ...(body.with_vector ? { vector: p.vector } : {}),
              })),
              next_page_offset: null,
            },
          });
        }
        if (req.url.endsWith('/points/query')) {
          hits[name]++;
          return setTimeout(
            () => send(200, { status: 'ok', result: { points: [] } }),
            delayMs,
          );
        }
        return send(404, {});
      });
    });
  const sFast = makeServer('fast', 2);
  const sSlow = makeServer('slow', 40);
  await new Promise((r) => sFast.listen(0, '127.0.0.1', r));
  await new Promise((r) => sSlow.listen(0, '127.0.0.1', r));
  try {
    const run = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          join(__dirname, 'qdrant-read-stress.cjs'),
          `--targets=F=http://127.0.0.1:${sFast.address().port},S=http://127.0.0.1:${sSlow.address().port}`,
          '--scope=narrow',
          '--concurrencies=4',
          '--warmup-seconds=0',
          '--duration-seconds=1',
          `--api-key-file=${keyFile}`,
          `--tuples-file=${tuplesFile}`,
          '--sample-size=4',
          '--narrow-reels=2',
          '--routing=least-inflight',
        ],
        { env: { ...process.env, QDRANT_ALLOW_LOCAL_HTTP: 'true' } },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    const meta = JSON.parse(run.stdout.split('\n')[0].replace(/^META /, ''));
    assert.equal(meta.routing, 'least-inflight');
    assert.ok(hits.slow > 0, 'slow target still receives some queries');
    assert.ok(hits.fast > hits.slow * 3, `fast ${hits.fast} vs slow ${hits.slow}`);
  } finally {
    sFast.close();
    sSlow.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
