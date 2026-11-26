/* Read-only SQL-to-Qdrant audits used after a PostgreSQL restore or promotion.
 * Nothing here writes to PostgreSQL or Qdrant. */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { Prisma } = require('@prisma/reel-indexing-client');
const {
  VECTOR_TABLES,
  vectorPointId,
} = require('../../apps/reel-indexing-service/src/domain/services/reel-vector-manifest');
const BATCH = 128;
const SCROLL = 256;
const SAMPLE = 20;
const PAYLOAD_FIELDS = [
  'kind',
  'reelId',
  'indexAttemptId',
  'projectionGeneration',
  'manifestHash',
];

async function currentRows(prisma) {
  return prisma.vectorProjection.findMany({
    where: { revoked: false },
    orderBy: [{ reelId: 'asc' }, { generation: 'asc' }],
    select: {
      reelId: true,
      indexAttemptId: true,
      generation: true,
      manifestHash: true,
      pointCount: true,
      readyAt: true,
    },
  });
}

// Candidate identities as SQL knows them: the same four tables the projector reads.
async function sqlIdentities(prisma, row) {
  const identities = [];
  for (const [kind, table] of Object.entries(VECTOR_TABLES)) {
    const records = await prisma.$queryRaw(Prisma.sql`
      SELECT "id" FROM ${Prisma.raw(`"${table}"`)}
      WHERE "reelId" = ${row.reelId} AND "indexAttemptId" = ${row.indexAttemptId}
      ORDER BY "id" LIMIT 20001
    `);
    for (const record of records) identities.push({ kind, id: record.id });
  }
  return identities;
}

// Point IDs Qdrant holds out of `ids`; no payload and no vectors are transferred.
async function presentPointIds(store, ids) {
  const present = new Set();
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const found = await store.request(
      `/collections/${store.collection}/points`,
      'POST',
      { ids: batch, with_payload: false, with_vector: false },
    );
    if (!Array.isArray(found)) throw new Error('Invalid Qdrant point lookup');
    for (const point of found) present.add(String(point.id));
  }
  return present;
}

/* Ready records whose points are not (all) in Qdrant. A record is stale when SQL says
 * the projection is ready but Qdrant lacks some of the points SQL says it should hold,
 * or SQL's own row count disagrees with the recorded point count. */
async function staleReady(prisma, store, dependencies = {}) {
  const identitiesFor = dependencies.identitiesFor ?? sqlIdentities;
  const rows = await currentRows(prisma);
  const stale = [];
  let ready = 0;
  let unready = 0;
  let expectedPoints = 0;
  for (const row of rows) {
    if (!row.readyAt) {
      unready++;
      continue;
    }
    ready++;
    const identities = await identitiesFor(prisma, row);
    const expected = identities.map((item) =>
      vectorPointId(
        item.kind,
        row.reelId,
        row.indexAttemptId,
        row.generation.toString(),
        item.id,
      ),
    );
    expectedPoints += expected.length;
    const present = await presentPointIds(store, expected);
    const missing = expected.filter((id) => !present.has(id)).length;
    if (missing || expected.length !== row.pointCount)
      stale.push({
        reelId: row.reelId,
        indexAttemptId: row.indexAttemptId,
        generation: row.generation.toString(),
        recordedPointCount: row.pointCount,
        sqlRows: expected.length,
        missingInQdrant: missing,
        reason: missing ? 'points_missing' : 'sql_rows_differ_from_record',
      });
  }
  return {
    readOnly: true,
    readyRecords: ready,
    unreadyRecords: unready,
    expectedPoints,
    staleCount: stale.length,
    stale,
    consistent: stale.length === 0,
  };
}

/* Qdrant points that no current ready record accounts for. Searches ignore them (the
 * has_id filter) but they inflate the point count that verify-parity compares. */
async function orphanReport(prisma, store) {
  const projections = await prisma.vectorProjection.findMany({
    select: {
      reelId: true,
      indexAttemptId: true,
      generation: true,
      manifestHash: true,
      pointCount: true,
      revoked: true,
    },
  });
  const reelStates = await prisma.vectorReelState.findMany({
    select: { reelId: true, deleted: true },
  });
  const deleted = new Set(
    reelStates.filter((state) => state.deleted).map((state) => state.reelId),
  );
  const reelsWithProjection = new Set(projections.map((row) => row.reelId));
  const tupleOf = (reelId, attempt, generation) =>
    `${reelId}|${attempt}|${generation}`;
  const current = new Map();
  const revoked = new Set();
  for (const row of projections) {
    const key = tupleOf(row.reelId, row.indexAttemptId, row.generation);
    if (row.revoked) revoked.add(key);
    else current.set(key, row);
  }
  const perTuple = new Map();
  const byReason = {};
  const samples = {};
  const orphanReels = new Map();
  let total = 0;
  let orphans = 0;
  let offset;
  do {
    const page = await store.request(
      `/collections/${store.collection}/points/scroll`,
      'POST',
      {
        limit: SCROLL,
        ...(offset === undefined ? {} : { offset }),
        with_payload: PAYLOAD_FIELDS,
        with_vector: false,
      },
    );
    if (!Array.isArray(page?.points)) throw new Error('Invalid Qdrant scroll');
    for (const point of page.points) {
      total++;
      const payload = point.payload ?? {};
      const key = tupleOf(
        payload.reelId,
        payload.indexAttemptId,
        payload.projectionGeneration,
      );
      const row = current.get(key);
      let reason;
      if (row && row.manifestHash === payload.manifestHash)
        perTuple.set(key, (perTuple.get(key) ?? 0) + 1);
      else if (row) reason = 'manifest_mismatch';
      else if (deleted.has(payload.reelId)) reason = 'deleted_reel';
      else if (revoked.has(key)) reason = 'revoked_generation';
      else if (reelsWithProjection.has(payload.reelId))
        reason = 'unreferenced_generation';
      else reason = 'unknown_reel';
      if (reason) {
        orphans++;
        byReason[reason] = (byReason[reason] ?? 0) + 1;
        (samples[reason] ??= []).length < SAMPLE &&
          samples[reason].push(String(point.id));
        orphanReels.set(
          String(payload.reelId),
          (orphanReels.get(String(payload.reelId)) ?? 0) + 1,
        );
      }
    }
    offset = page.next_page_offset ?? undefined;
  } while (offset !== undefined && offset !== null);
  // A current tuple holding a different number of points than its record is drift too.
  const tupleCountMismatch = [];
  for (const [key, row] of current) {
    const found = perTuple.get(key) ?? 0;
    if (found !== row.pointCount)
      tupleCountMismatch.push({
        reelId: row.reelId,
        generation: row.generation.toString(),
        recordedPointCount: row.pointCount,
        foundInQdrant: found,
      });
  }
  return {
    readOnly: true,
    qdrantPoints: total,
    accountedPoints: total - orphans,
    orphanPoints: orphans,
    orphansByReason: byReason,
    orphanSamplePointIds: samples,
    orphanReels: [...orphanReels]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([reelId, points]) => ({ reelId, points })),
    tupleCountMismatch: tupleCountMismatch.slice(0, 100),
    tupleCountMismatchTotal: tupleCountMismatch.length,
  };
}

module.exports = {
  staleReady,
  orphanReport,
  presentPointIds,
  sqlIdentities,
};
