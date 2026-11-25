const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { encryptFile, decryptFile, pairPrefix } = require('./pair-backup.cjs');
const { pairBinding } = require('./qdrant-backup.cjs');
const {
  projectionSignature,
  parityReason,
  verifyParity,
} = require('./reel-qdrant.cjs');
const { staleReady, orphanReport } = require('./reel-qdrant-audit.cjs');
const {
  vectorPointId,
} = require('../../apps/reel-indexing-service/src/domain/services/reel-vector-manifest');

const row = (reelId, generation, extra = {}) => ({
  reelId,
  indexAttemptId: `attempt-${reelId}`,
  generation: BigInt(generation),
  manifestHash: `hash-${reelId}-${generation}`,
  pointCount: 2,
  readyAt: new Date('2026-11-25T00:00:00Z'),
  readyCollection: 'c',
  readyFingerprint: 'f',
  readyEpoch: 'e',
  ...extra,
});
const idsFor = (r) =>
  ['a', 'b'].map((suffix) =>
    vectorPointId(
      'CHUNK',
      r.reelId,
      r.indexAttemptId,
      r.generation.toString(),
      `${r.reelId}-${suffix}`,
    ),
  );
const identitiesFor = async (_prisma, r) =>
  ['a', 'b'].map((suffix) => ({ kind: 'CHUNK', id: `${r.reelId}-${suffix}` }));

test('chunked dump encryption round-trips and rejects tampering, truncation, wrong key', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'pair-crypto-'));
  try {
    const plain = join(directory, 'dump');
    // Three chunks (4 MiB each) plus a partial one.
    const data = Buffer.alloc(9 * 1024 * 1024 + 123, 7);
    data.write('PGDMP', 0);
    await fs.writeFile(plain, data);
    const key = Buffer.alloc(32, 5);
    const encrypted = join(directory, 'dump.vqd');
    await encryptFile(plain, encrypted, key);
    const expected = require('node:crypto')
      .createHash('sha256')
      .update(data)
      .digest('hex');
    assert.equal(await decryptFile(encrypted, key), expected);
    assert.equal(
      (await fs.readFile(encrypted)).includes(Buffer.from('PGDMP')),
      false,
    );
    await assert.rejects(decryptFile(encrypted, Buffer.alloc(32, 6)));
    const bytes = await fs.readFile(encrypted);
    const flipped = Buffer.from(bytes);
    flipped[200] ^= 1;
    await fs.writeFile(join(directory, 'flip.vqd'), flipped);
    await assert.rejects(decryptFile(join(directory, 'flip.vqd'), key));
    // Truncation at a chunk boundary must not authenticate as a complete file.
    const firstChunk = 24 + 4 + 12 + 4 * 1024 * 1024 + 16;
    await fs.writeFile(
      join(directory, 'cut.vqd'),
      bytes.subarray(0, firstChunk),
    );
    await assert.rejects(decryptFile(join(directory, 'cut.vqd'), key));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('R2 pair prefix rejects traversal and appends the pair ID', () => {
  assert.equal(
    pairPrefix('private/reel-indexing/pairs', 'abc'),
    'private/reel-indexing/pairs/abc/',
  );
  for (const bad of ['../x', 'a//b', '', '/abs', 'a/./b'])
    assert.throws(() => pairPrefix(bad, 'abc'));
});

const pairProof = (rows, overrides = {}) => ({
  pairId: '11111111-2222-3333-4444-555555555555',
  at: new Date().toISOString(),
  lsn: '0/1A2B3C4D',
  dumpSha256: 'a'.repeat(64),
  projectionFingerprint: projectionSignature(rows),
  tableCounts: { ReelDocument: 1 },
  ...overrides,
});
const prismaWith = (rows) => ({
  vectorProjection: { findMany: async () => rows },
});

test('pair proof binds the Qdrant snapshot to time, LSN, content hash and live SQL state', async () => {
  const rows = [row('r1', 1)];
  const bound = await pairBinding(prismaWith(rows), pairProof(rows), {});
  assert.equal(bound.lsn, '0/1A2B3C4D');
  assert.equal(bound.dumpSha256, 'a'.repeat(64));
  // Legacy proofs stay accepted unless a pair is required.
  assert.equal(
    await pairBinding(prismaWith(rows), { snapshot: {} }, {}),
    undefined,
  );
  await assert.rejects(
    pairBinding(prismaWith(rows), { snapshot: {} }, { 'require-pair': 'true' }),
    /paired SQL backup proof is required/,
  );
  // SQL moved after the dump: the fence rejects it.
  await assert.rejects(
    pairBinding(prismaWith([row('r1', 2)]), pairProof(rows), {}),
    /Pair fence changed/,
  );
  // Stale proof, bad LSN and bad hash are rejected.
  await assert.rejects(
    pairBinding(
      prismaWith(rows),
      pairProof(rows, { at: new Date(Date.now() - 3600e3).toISOString() }),
      {},
    ),
    /not fresh/,
  );
  for (const bad of [{ lsn: 'not-an-lsn' }, { dumpSha256: 'xyz' }])
    await assert.rejects(
      pairBinding(prismaWith(rows), pairProof(rows, bad), {}),
      /malformed/,
    );
});

const parityFixture = (overrides = {}) => {
  const rows = [row('ok', 1), row('missing', 1), row('drift', 1)];
  const prisma = {
    vectorCollectionState: {
      findUnique: async () => ({
        maintenance: false,
        fingerprint: 'f',
        epoch: 'e',
      }),
    },
    vectorProjection: { findMany: async () => rows },
    vectorProjectionTask: { count: async () => 0 },
    $queryRaw: async () => [{ count: 0 }],
  };
  const projection = {
    loadCandidatePoints: async (reelId) => {
      if (reelId === 'missing')
        throw new Error('Qdrant candidate point set is incomplete');
      if (reelId === 'drift') return { hash: 'other', points: [1, 2] };
      return { hash: `hash-ok-1`, points: [1, 2] };
    },
  };
  const store = {
    collection: 'c',
    identity: async () => ({ collection: 'c', fingerprint: 'f' }),
    request: async () => ({ count: 4 }),
  };
  return { prisma, projection, store, ...overrides };
};

test('parity stops at the first error by default and lists every mismatch in list-all mode', async () => {
  const { prisma, projection, store } = parityFixture();
  await assert.rejects(
    verifyParity(prisma, projection, store),
    /point set is incomplete/,
  );
  const all = await verifyParity(prisma, projection, store, { listAll: true });
  assert.equal(all.complete, false);
  assert.equal(all.failureCount, 2);
  assert.deepEqual(all.failuresByReason, {
    points_missing: 1,
    manifest_mismatch: 1,
  });
  assert.deepEqual(all.failures.map((f) => f.reelId).sort(), [
    'drift',
    'missing',
  ]);
  assert.equal(all.manifestsVerified, 1);
  assert.equal(all.expectedPoints, 6);
  assert.equal(all.verifiedPoints, 2);
  assert.equal(all.unaccountedQdrantPoints, 2);
  assert.equal(all.recordsConsistent, false);
  assert.equal(parityReason(new Error('nonsense')), 'verification_error');
});

test('list-all parity treats orphan points as informational for recordsConsistent', async () => {
  const { prisma, projection, store } = parityFixture();
  prisma.vectorProjection.findMany = async () => [row('ok', 1)];
  const result = await verifyParity(prisma, projection, store, {
    listAll: true,
  });
  assert.equal(result.complete, false);
  assert.equal(result.unaccountedQdrantPoints, 2);
  assert.equal(result.recordsConsistent, true);
});

test('list-all parity reports an unready record instead of throwing', async () => {
  const unready = row('late', 1, { readyAt: null });
  const { prisma, projection, store } = parityFixture();
  prisma.vectorProjection.findMany = async () => [unready];
  const result = await verifyParity(prisma, projection, store, {
    listAll: true,
  });
  assert.equal(result.failures[0].reason, 'not_ready');
  assert.equal(result.complete, false);
});

test('stale-ready detector lists ready records whose points are missing and never writes', async () => {
  const rows = [
    row('good', 1),
    row('lost', 1),
    row('short', 1),
    row('pending', 1, { readyAt: null }),
  ];
  const writes = [];
  const present = new Set([
    ...idsFor(rows[0]),
    ...idsFor(rows[1]).slice(0, 1),
    ...idsFor(rows[2]),
  ]);
  const prisma = prismaWith(rows);
  const store = {
    collection: 'c',
    request: async (path, method, body) => {
      if (method !== 'POST' || !path.endsWith('/points')) writes.push(path);
      return body.ids.filter((id) => present.has(id)).map((id) => ({ id }));
    },
  };
  const result = await staleReady(prisma, store, {
    identitiesFor: async (p, r) =>
      r.reelId === 'short'
        ? (await identitiesFor(p, r)).slice(0, 1)
        : identitiesFor(p, r),
  });
  assert.equal(result.readOnly, true);
  assert.equal(result.readyRecords, 3);
  assert.equal(result.unreadyRecords, 1);
  assert.equal(result.consistent, false);
  const byReel = Object.fromEntries(result.stale.map((s) => [s.reelId, s]));
  assert.equal(byReel.lost.missingInQdrant, 1);
  assert.equal(byReel.lost.reason, 'points_missing');
  assert.equal(byReel.good, undefined);
  assert.equal(byReel.short.reason, 'sql_rows_differ_from_record');
  assert.equal(byReel.short.missingInQdrant, 0);
  assert.deepEqual(writes, []);
});

test('orphan report classifies points no current ready record accounts for', async () => {
  const current = row('live', 3);
  const projections = [
    { ...current, revoked: false },
    { ...row('live', 2), revoked: true },
    { ...row('gone', 1), revoked: true },
  ];
  const prisma = {
    vectorProjection: { findMany: async () => projections },
    vectorReelState: {
      findMany: async () => [
        { reelId: 'gone', deleted: true },
        { reelId: 'live', deleted: false },
      ],
    },
  };
  const point = (id, reelId, attempt, generation, manifestHash) => ({
    id,
    payload: {
      reelId,
      indexAttemptId: attempt,
      projectionGeneration: generation,
      manifestHash,
    },
  });
  const pages = [
    {
      points: [
        point('p1', 'live', 'attempt-live', '3', 'hash-live-3'),
        point('p2', 'live', 'attempt-live', '3', 'hash-live-3'),
        point('p3', 'live', 'attempt-live', '2', 'hash-live-2'),
        point('p4', 'gone', 'attempt-gone', '1', 'hash-gone-1'),
        point('p5', 'live', 'attempt-live', '3', 'WRONG'),
      ],
      next_page_offset: 'next',
    },
    {
      points: [
        point('p6', 'mystery', 'x', '1', 'h'),
        point('p7', 'live', 'attempt-live', '9', 'h'),
      ],
      next_page_offset: null,
    },
  ];
  let call = 0;
  const calls = [];
  const store = {
    collection: 'c',
    request: async (path, method, body) => {
      calls.push([method, path, body.offset]);
      return pages[call++];
    },
  };
  const report = await orphanReport(prisma, store);
  assert.equal(report.qdrantPoints, 7);
  assert.equal(report.accountedPoints, 2);
  assert.equal(report.orphanPoints, 5);
  assert.deepEqual(report.orphansByReason, {
    revoked_generation: 1,
    deleted_reel: 1,
    manifest_mismatch: 1,
    unknown_reel: 1,
    unreferenced_generation: 1,
  });
  assert.equal(report.tupleCountMismatchTotal, 0);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['POST', 'POST'],
  );
  assert.equal(calls[1][2], 'next');
  // A current tuple missing a point shows up as a count mismatch too.
  call = 0;
  pages[0].points.splice(1, 1);
  const drifted = await orphanReport(prisma, store);
  assert.equal(drifted.tupleCountMismatchTotal, 1);
  assert.equal(drifted.tupleCountMismatch[0].foundInQdrant, 1);
});
