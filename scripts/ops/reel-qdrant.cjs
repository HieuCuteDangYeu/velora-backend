#!/usr/bin/env node
/* No dotenv loading: use an explicit owner-service target and service-specific secret file. */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { PrismaClient, Prisma } = require('@prisma/reel-indexing-client');
const { ConfigService } = require('@nestjs/config');
const {
  QdrantReelVectorStoreAdapter,
} = require('../../apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter');
const {
  PrismaVectorProjectionRepository,
} = require('../../apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository');
const {
  R2ArtifactStorageAdapter,
} = require('../../apps/reel-indexing-service/src/infrastructure/adapters/r2-artifact-storage.adapter');
const {
  VECTOR_TABLES,
  makePoint,
  vectorHash,
} = require('../../apps/reel-indexing-service/src/domain/services/reel-vector-manifest');
const fs = require('node:fs/promises');
const { join, resolve, basename } = require('node:path');
const { createHash } = require('node:crypto');
const BATCH = 128;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (value) =>
  JSON.stringify(value, (_, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  ) + '\n';
async function immutable(file, value) {
  await fs.writeFile(file, typeof value === 'string' ? value : encode(value), {
    flag: 'wx',
    mode: 0o600,
  });
}
function argumentsFor(argv) {
  const args = {};
  for (const value of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(value);
    if (!match || args[match[1]])
      throw new Error('Use unique --name=value arguments');
    args[match[1]] = match[2];
  }
  return args;
}
function targetFingerprint(url) {
  const target = new URL(url);
  return sha(
    `${target.protocol}//${target.hostname}:${target.port}${target.pathname}`,
  );
}
async function verifiedArtifact(directory, entry) {
  if (
    basename(entry.file) !== entry.file ||
    !/^batch-\d{6}\.json$/.test(entry.file)
  )
    throw new Error('Invalid artifact path');
  const stat = await fs.lstat(join(directory, entry.file));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
    throw new Error('Unbounded or linked artifact');
  const bytes = await fs.readFile(join(directory, entry.file));
  if (sha(bytes) !== entry.sha256)
    throw new Error('Artifact checksum mismatch');
  const rows = JSON.parse(bytes);
  if (!Array.isArray(rows) || rows.length !== entry.rows || rows.length > BATCH)
    throw new Error('Artifact count mismatch');
  return rows;
}
async function exportSnapshot(prisma, projection, directory, fingerprint) {
  // A partial export is never resumed from another SQL snapshot.
  await fs.mkdir(directory, { mode: 0o700 });
  await immutable(join(directory, 'started.json'), {
    version: 1,
    source: fingerprint,
    startedAt: new Date().toISOString(),
  });
  const batches = [];
  const counts = {};
  const snapshot = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const provenance =
        await tx.$queryRaw`SELECT txid_current_snapshot()::text AS snapshot, now()::text AS at`;
      const candidatePoints = new Map();
      for (const [kind, table] of Object.entries(VECTOR_TABLES)) {
        counts[kind] = 0;
        let cursor = '';
        for (;;) {
          const rows = await tx.$queryRaw(Prisma.sql`
          SELECT to_jsonb(t) AS record,
            p."generation"::text, p."manifestHash"
          FROM ${Prisma.raw(`"${table}"`)} t LEFT JOIN "VectorProjection" p
            ON p."reelId" = t."reelId" AND p."indexAttemptId" = t."indexAttemptId" AND NOT p."revoked"
          WHERE t."rowId" > ${cursor} ORDER BY t."rowId" LIMIT ${BATCH}
        `);
          if (!rows.length) break;
          const records = [];
          for (const row of rows) {
            if (!row.generation || !row.manifestHash)
              throw new Error(
                'Source candidate not enrolled; export remains incomplete',
              );
            if (row.record.embedding == null) {
              const candidateKey = `${row.record.reelId}:${row.record.indexAttemptId}:${row.generation}`;
              if (!candidatePoints.has(candidateKey)) {
                const points = await projection.loadCandidatePoints(
                  row.record.reelId,
                  row.record.indexAttemptId,
                  BigInt(row.generation),
                );
                candidatePoints.set(
                  candidateKey,
                  new Map(
                    points.points.map((point) => [
                      `${point.payload.kind}:${point.payload.stableId}`,
                      point,
                    ]),
                  ),
                );
              }
              const point = candidatePoints
                .get(candidateKey)
                .get(`${kind}:${row.record.id}`);
              if (!point)
                throw new Error('Candidate staging bundle is incomplete');
              row.record.embedding = JSON.stringify(point.vector);
            }
            const point = makePoint(kind, row.generation, row.record);
            point.payload.manifestHash = row.manifestHash;
            records.push({ kind, record: row.record, point });
          }
          const bytes = encode(records),
            file = `batch-${String(batches.length).padStart(6, '0')}.json`;
          if (Buffer.byteLength(bytes) > 32 * 1024 * 1024)
            throw new Error('Export batch byte limit');
          await immutable(join(directory, file), bytes);
          batches.push({ file, rows: records.length, sha256: sha(bytes) });
          counts[kind] += records.length;
          cursor = rows[rows.length - 1].record.rowId;
        }
      }
      return provenance[0];
    },
    { isolationLevel: 'RepeatableRead', timeout: 120000 },
  );
  await immutable(join(directory, 'complete.json'), {
    version: 1,
    source: fingerprint,
    snapshot,
    counts,
    batches,
    completedAt: new Date().toISOString(),
  });
  return { counts, batches: batches.length };
}
async function importSnapshot(
  prisma,
  projection,
  store,
  directory,
  fingerprint,
  receiptDirectory,
  dryRun = false,
) {
  const manifestPath = join(directory, 'complete.json');
  const manifestStat = await fs.lstat(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > 1024 * 1024
  )
    throw new Error('Unbounded or linked completion manifest');
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.version !== 1 ||
    manifest.source !== fingerprint ||
    !Array.isArray(manifest.batches)
  )
    throw new Error('Wrong source or incomplete export');
  const manifestHash = sha(manifestBytes);
  if (!dryRun) {
    await fs.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    const receiptManifest = join(receiptDirectory, 'source.json');
    try {
      await immutable(receiptManifest, {
        manifestHash,
        target: await store.identity(),
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = JSON.parse(await fs.readFile(receiptManifest));
      if (
        prior.manifestHash !== manifestHash ||
        vectorHash(prior.target) !== vectorHash(await store.identity())
      )
        throw new Error('Resume target changed; use a new receipt directory');
    }
  }
  const isCurrent = async (point) => {
    const p = point.payload;
    const state = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${p.reelId}))`;
      return tx.vectorProjection.findUnique({
        where: {
          reelId_generation: {
            reelId: p.reelId,
            generation: BigInt(p.projectionGeneration),
          },
        },
      });
    });
    if (!state || state.revoked || state.manifestHash !== p.manifestHash)
      return false;
    const live = await projection.loadCandidatePoints(
      p.reelId,
      p.indexAttemptId,
      state.generation,
    );
    return (
      live.hash === p.manifestHash &&
      live.points.some(
        (item) =>
          item.id === point.id && vectorHash(item) === vectorHash(point),
      )
    );
  };
  let projected = 0,
    superseded = 0;
  for (const batch of manifest.batches) {
    const records = await verifiedArtifact(directory, batch);
    // Rechecking completed batches is idempotent and avoids trusting stale receipts after deletion/restore.
    for (const record of records) {
      const point = makePoint(
        record.kind,
        record.point.payload.projectionGeneration,
        record.record,
      );
      point.payload.manifestHash = record.point.payload.manifestHash;
      if (vectorHash(point) !== vectorHash(record.point))
        throw new Error('Export point provenance mismatch');
    }
    const valid = [];
    for (const record of records) {
      const current = await isCurrent(record.point);
      if (current) valid.push(record.point);
      else superseded++;
    }
    if (valid.length) {
      if (!dryRun) await store.upsert(valid);
      projected += valid.length;
      if (!dryRun)
        for (let i = valid.length - 1; i >= 0; i--) {
          if (!(await isCurrent(valid[i]))) {
            valid.splice(i, 1);
            projected--;
            superseded++;
          }
        }
    }
    if (!dryRun)
      try {
        await immutable(join(receiptDirectory, `${batch.file}.receipt`), {
          manifestHash,
          batch: batch.sha256,
          projected: valid.length,
          superseded: records.length - valid.length,
        });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
  }
  // Only the live leased projector can certify readiness after post-write generation checks.
  if (!dryRun) await projection.reconcile();
  return { projected, superseded, readiness: 'requires live reconciliation' };
}
async function reconcile(projection, prisma, maxTasks) {
  await projection.target();
  await projection.reconcile();
  let processed = 0;
  for (; processed < maxTasks; processed++) {
    const task = await projection.claim();
    if (!task) break;
    try {
      await projection.apply(task);
    } catch (error) {
      await projection.retry(task);
      throw error;
    }
  }
  const pending = await prisma.vectorProjectionTask.count({
    where: { completedAt: null },
  });
  const unready =
    await prisma.$queryRaw`SELECT count(*)::int AS count FROM "ReelDocument" d LEFT JOIN "VectorProjection" p
    ON p."reelId" = d."reelId" AND p."indexAttemptId" = d."indexAttemptId" AND NOT p."revoked"
    LEFT JOIN "VectorCollectionState" s ON s."collection" = p."readyCollection" AND s."epoch" = p."readyEpoch" AND s."fingerprint" = p."readyFingerprint" AND NOT s."maintenance"
    WHERE d."isActive" AND (p."readyAt" IS NULL OR s."epoch" IS NULL)`;
  return {
    processed,
    pending,
    unreadyActiveCandidates: unready[0].count,
    complete: pending === 0 && unready[0].count === 0,
  };
}
async function verifyParity(prisma, projection, store) {
  const target = await store.identity();
  const collection = await prisma.vectorCollectionState.findUnique({
    where: { collection: target.collection },
  });
  if (
    !collection ||
    collection.maintenance ||
    collection.fingerprint !== target.fingerprint
  )
    throw new Error('Qdrant target is not certified in PostgreSQL');
  const current = await prisma.vectorProjection.findMany({
    where: { revoked: false },
    orderBy: [{ reelId: 'asc' }, { generation: 'asc' }],
    select: {
      reelId: true,
      indexAttemptId: true,
      generation: true,
      manifestHash: true,
      pointCount: true,
      readyAt: true,
      readyCollection: true,
      readyFingerprint: true,
      readyEpoch: true,
    },
  });
  const signature = (rows) =>
    sha(
      JSON.stringify(
        rows.map((row) => ({
          reelId: row.reelId,
          attempt: row.indexAttemptId,
          generation: row.generation.toString(),
          manifestHash: row.manifestHash,
          pointCount: row.pointCount,
          readyAt: row.readyAt?.toISOString() ?? null,
          collection: row.readyCollection,
          fingerprint: row.readyFingerprint,
          epoch: row.readyEpoch,
        })),
      ),
    );
  const before = signature(current);
  let points = 0;
  for (const row of current) {
    if (
      !row.readyAt ||
      row.readyCollection !== target.collection ||
      row.readyFingerprint !== target.fingerprint ||
      row.readyEpoch !== collection.epoch
    )
      throw new Error('A current vector generation is not ready');
    const candidate = await projection.loadCandidatePoints(
      row.reelId,
      row.indexAttemptId,
      row.generation,
    );
    if (
      candidate.hash !== row.manifestHash ||
      candidate.points.length !== row.pointCount
    )
      throw new Error(
        'A current vector generation failed manifest verification',
      );
    points += candidate.points.length;
  }
  const pending = await prisma.vectorProjectionTask.count({
    where: { completedAt: null },
  });
  const unready = await prisma.$queryRaw`
    SELECT count(*)::int AS count FROM "ReelDocument" d
    LEFT JOIN "VectorProjection" p ON p."reelId"=d."reelId"
      AND p."indexAttemptId"=d."indexAttemptId" AND NOT p.revoked
    LEFT JOIN "VectorCollectionState" s ON s.collection=p."readyCollection"
      AND s.epoch=p."readyEpoch" AND s.fingerprint=p."readyFingerprint"
      AND NOT s.maintenance
    WHERE d."isActive" AND (p."readyAt" IS NULL OR s.epoch IS NULL)
  `;
  const qdrant = await store.request(
    `/collections/${store.collection}/points/count`,
    'POST',
    { exact: true },
  );
  const after = await prisma.vectorProjection.findMany({
    where: { revoked: false },
    orderBy: [{ reelId: 'asc' }, { generation: 'asc' }],
    select: {
      reelId: true,
      indexAttemptId: true,
      generation: true,
      manifestHash: true,
      pointCount: true,
      readyAt: true,
      readyCollection: true,
      readyFingerprint: true,
      readyEpoch: true,
    },
  });
  const complete =
    before === signature(after) &&
    pending === 0 &&
    unready[0].count === 0 &&
    points === qdrant.count;
  if (!complete) throw new Error('SQL and Qdrant vector parity is incomplete');
  return {
    complete,
    candidates: current.length,
    manifestsVerified: current.length,
    qdrantPoints: qdrant.count,
    vectorTasksPending: pending,
    unreadyActiveCandidates: unready[0].count,
    projectionFingerprint: before,
  };
}
async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = argumentsFor(rest);
  if (
    ![
      'probe',
      'initialize',
      'enroll',
      'export',
      'import',
      'reconcile',
      'invalidate',
      'resume',
      'status',
      'metrics',
      'verify-parity',
    ].includes(command)
  )
    throw new Error(
      'Command: probe|initialize|enroll|export|import|reconcile|invalidate|status|metrics|verify-parity',
    );
  if (
    !args['target-label'] ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(args['target-label'])
  )
    throw new Error('Explicit --target-label required');
  const url = process.env.REEL_INDEXING_DATABASE_URL;
  if (!url) throw new Error('Explicit owner-service database URL required');
  const fingerprint = targetFingerprint(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const config = new ConfigService();
  const store = new QdrantReelVectorStoreAdapter(config);
  const artifacts =
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_BUCKET_NAME &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
      ? new R2ArtifactStorageAdapter(config)
      : undefined;
  const projection = new PrismaVectorProjectionRepository(
    prisma,
    config,
    store,
    artifacts,
  );
  const maxTasks = Number(args['max-tasks'] || 100);
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 10000)
    throw new Error('Invalid task bound');
  const mutations = [
    'initialize',
    'enroll',
    'import',
    'reconcile',
    'invalidate',
    'resume',
  ];
  if (
    mutations.includes(command) &&
    !(command === 'import' && args['dry-run'] === 'true') &&
    args.confirm !== `QDRANT_${args['target-label']}`
  )
    throw new Error('Mutation requires --confirm=QDRANT_<target-label>');
  try {
    let result;
    if (command === 'initialize') {
      await store.initialize();
      result = await projection.target();
    }
    if (command === 'probe') {
      result = await store.identity();
      const ready = await fetch(new URL('/readyz', process.env.QDRANT_URL), {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      await ready.body?.cancel();
      if (!ready.ok) throw new Error('Qdrant not ready');
    }
    if (command === 'resume') {
      if (args['recovery-proof'] !== 'RESTORED_AND_ALIAS_VERIFIED')
        throw new Error('Recovery proof required');
      await projection.resumeAfterRestore();
      result = { reconciliationRequired: true };
    }
    if (command === 'invalidate') {
      await projection.invalidate();
      result = { readinessInvalidated: true };
    }
    if (command === 'enroll') {
      if (args['capture-proof'] !== 'ALL_WRITERS_DRAINED_OR_CAPTURE_ENABLED')
        throw new Error('Writer capture/drain proof required');
      const candidates =
        await prisma.$queryRaw(Prisma.sql`SELECT d."reelId", d."indexAttemptId" FROM "ReelDocument" d WHERE NOT EXISTS (
        SELECT 1 FROM "VectorProjection" p WHERE p."reelId" = d."reelId" AND p."indexAttemptId" = d."indexAttemptId" AND NOT p."revoked"
      ) ORDER BY d."reelId", d."indexAttemptId" LIMIT ${maxTasks}`);
      for (const row of candidates)
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${row.reelId}))`;
          if (await tx.reelDocument.count({ where: row }))
            await projection.enroll(tx, row.reelId, row.indexAttemptId);
        });
      result = {
        inspected: candidates.length,
        bounded: candidates.length === maxTasks,
      };
    }
    if (['export', 'import'].includes(command) && !args.directory)
      throw new Error('Explicit --directory required');
    if (command === 'export')
      result = await exportSnapshot(
        prisma,
        projection,
        resolve(args.directory),
        fingerprint,
      );
    if (command === 'import') {
      if (!args.receipts && args['dry-run'] !== 'true')
        throw new Error('Separate --receipts directory required');
      result = await importSnapshot(
        prisma,
        projection,
        store,
        resolve(args.directory),
        fingerprint,
        resolve(args.receipts || args.directory),
        args['dry-run'] === 'true',
      );
    }
    if (command === 'reconcile')
      result = await reconcile(projection, prisma, maxTasks);
    if (command === 'verify-parity')
      result = await verifyParity(prisma, projection, store);
    if (command === 'status' || command === 'metrics') {
      const pending = await prisma.vectorProjectionTask.count({
        where: { completedAt: null },
      });
      const oldest = await prisma.vectorProjectionTask.findFirst({
        where: { completedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      result = {
        pending,
        lagSeconds: oldest
          ? Math.max(0, (Date.now() - oldest.createdAt.getTime()) / 1000)
          : 0,
      };
      if (command === 'metrics') {
        let ready = 0;
        const extra = [];
        try {
          await store.identity();
          const metrics = await store.request(
            '/metrics',
            'GET',
            undefined,
            AbortSignal.timeout(5000),
            true,
          );
          for (const name of ['memory_resident_bytes', 'memory_active_bytes']) {
            const value = new RegExp(`^${name} ([0-9.e+]+)$`, 'm').exec(
              metrics,
            );
            if (value && Number.isFinite(Number(value[1])))
              extra.push(`velora_qdrant_${name} ${Number(value[1])}`);
          }
          let errors = 0;
          for (const line of metrics.split('\n'))
            if (/^rest_responses_total\{.*status="5[0-9][0-9]"/.test(line)) {
              const count = Number(line.slice(line.lastIndexOf(' ') + 1));
              if (Number.isFinite(count)) errors += count;
            }
          extra.push(`velora_qdrant_rest_errors_total ${errors}`);
          ready = 1;
        } catch {
          /* A failed authenticated probe is observed unavailability. */
        }
        if (args['storage-path']) {
          const storage = await fs.statfs(resolve(args['storage-path']));
          extra.push(
            `velora_qdrant_storage_available_bytes ${storage.bavail * storage.bsize}`,
          );
        }
        process.stdout.write(
          `velora_vector_projection_enabled ${projection.enabled ? 1 : 0}\nvelora_vector_metrics_timestamp_seconds ${Date.now() / 1000}\nvelora_qdrant_ready ${ready}\nvelora_vector_projection_pending ${pending}\nvelora_vector_projection_lag_seconds ${result.lagSeconds}\n${extra.join('\n')}\n`,
        );
        return;
      }
    }
    process.stdout.write(
      encode({ command, target: args['target-label'], result }),
    );
    if (command === 'reconcile' && !result.complete) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}
module.exports = {
  argumentsFor,
  verifiedArtifact,
  exportSnapshot,
  importSnapshot,
  reconcile,
  verifyParity,
  main,
  targetFingerprint,
};
if (require.main === module)
  main().catch(() => {
    console.error(
      'Qdrant operation failed; target, provenance, readiness or artifact gate rejected (details redacted)',
    );
    process.exitCode = 1;
  });
