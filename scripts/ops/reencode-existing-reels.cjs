'use strict';

// All writes to Content/storage stay inside the reviewed one-Reel operator.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const CACHE_EVENT = 'REEL_HLS_CACHE_INVALIDATION_V1';
const MODES = ['dry-run', 'inventory', 'prepare', 'stage', 'apply', 'reconcile'];
let ownershipHelpers;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])])) : value;
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const json = (value) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v));

function requireHoldReleased(options) {
  if (options.mode !== 'dry-run' && options['hold-released'] !== true)
    throw new Error('Benchmark owner must release the hold before any inventory, database, storage or media work');
}

function parseArgs(argv) {
  const options = { mode: 'dry-run' }, seen = new Set();
  for (const arg of argv) {
    const match = /^--([a-z0-9-]+)(?:=(.+))?$/.exec(arg);
    if (!match || seen.has(match[1])) throw new Error('Unknown, empty or duplicate option');
    const [, key, value] = match;
    seen.add(key);
    if (MODES.includes(key) && value === undefined) {
      if (options.explicit) throw new Error('Choose exactly one operation');
      options.mode = key; options.explicit = true;
    } else if (['run-dir', 'limit', 'media-origin', 'inventory-sha256', 'approval-file', 'reviewed-sha256'].includes(key) && value)
      options[key] = value;
    else if (['hold-released', 'help'].includes(key) && value === undefined) options[key] = true;
    else throw new Error('Unknown or invalid option');
  }
  delete options.explicit;
  if (options.help) return options;
  const allowed = {
    'dry-run': [], inventory: ['run-dir', 'hold-released'],
    prepare: ['run-dir', 'limit', 'media-origin', 'inventory-sha256', 'hold-released'],
    stage: ['run-dir', 'limit', 'approval-file', 'reviewed-sha256', 'hold-released'],
    apply: ['run-dir', 'limit', 'approval-file', 'reviewed-sha256', 'hold-released'],
    reconcile: ['run-dir', 'limit', 'hold-released'],
  }[options.mode];
  for (const key of Object.keys(options))
    if (key !== 'mode' && !allowed.includes(key)) throw new Error('Option does not belong to operation');
  requireHoldReleased(options);
  if (options.mode !== 'dry-run' && !options['run-dir']) throw new Error('Explicit run directory required');
  if (!['dry-run', 'inventory'].includes(options.mode)) {
    if (!/^[1-5]$/.test(options.limit || '')) throw new Error('Explicit sequential limit must be 1 to 5');
    options.limit = Number(options.limit);
  }
  if (options.mode === 'prepare' && (!/^[a-f0-9]{64}$/.test(options['inventory-sha256'] || '') || !options['media-origin']))
    throw new Error('Preparation requires reviewed inventory digest and media origin');
  if (['stage', 'apply'].includes(options.mode) && (!options['approval-file'] || !/^[a-f0-9]{64}$/.test(options['reviewed-sha256'] || '')))
    throw new Error('Mutation requires an approval file and its reviewed digest');
  return options;
}

function privateRead(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 64 * 1024 * 1024)
    throw new Error('Operator file must be a bounded private regular file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function persist(file, value, create = false) {
  if (create && fs.existsSync(file)) throw new Error('Operator file already exists');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function protectedFingerprint(row) {
  const copy = json(row);
  for (const key of ['updatedAt', 'hlsMasterKey', 'encodedVariantCount', 'encodedMaxHeight', 'encodedFps']) delete copy[key];
  if (copy.mediaOutput) {
    for (const key of ['hlsMasterKey', 'variants', 'hlsObjectCount', 'hlsTotalBytes']) delete copy.mediaOutput[key];
    if (copy.mediaOutput.checksums) delete copy.mediaOutput.checksums.hlsMasterSha256;
  }
  return digest(copy);
}

function snapshot(row) {
  return { reelId: row.id, userId: row.userId, expectedUpdatedAt: new Date(row.updatedAt).toISOString(),
    previousHlsMasterKey: row.hlsMasterKey, mediaKeySha256: createHash('sha256').update(row.mediaKey).digest('hex'),
    mediaAttemptId: row.mediaAttemptId ?? null, indexAttemptId: row.indexAttemptId ?? null };
}

function eligible(row, events, leases, now = Date.now(), ownAttempt) {
  if (!row.hlsMasterKey) return 'OUT_OF_SCOPE';
  if (row.mediaStatus !== 'COMPLETED' || ['PENDING', 'PROCESSING'].includes(row.indexStatus) ||
      events.some((e) => !e.publishedAt && e.eventType !== CACHE_EVENT)) return 'DEFERRED';
  const previousAttempt = row.hlsMasterKey.split('/').at(-2);
  if (leases.some((l) => !l.completedAt && new Date(l.expiresAt).getTime() > now &&
      ![ownAttempt, row.mediaAttemptId, previousAttempt].includes(l.attemptId))) return 'DEFERRED';
  const duration = row.outputDurationMs ?? row.sourceDurationMs;
  if (!Number.isInteger(duration) || duration <= 0 || duration > 600_000) return 'BLOCKED';
  if (!ownedMaster(row)) return 'BLOCKED';
  return 'PENDING';
}

function ownedMaster(row) {
  if (typeof row.hlsMasterKey !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(row.hlsMasterKey) ||
      row.hlsMasterKey.split('/').some((p) => !p || p === '.' || p === '..') ||
      !/\/(?:master|master-v[0-9]{8}T[0-9]{9}Z)\.m3u8$/i.test(row.hlsMasterKey))
    return false;
  if (!ownershipHelpers) {
    require('ts-node').register({ project: path.resolve(__dirname, '../../tsconfig.json'), transpileOnly: true });
    ownershipHelpers = require('../../libs/common/src/content/reel-media-key.ts');
  }
  return ownershipHelpers.isLegacyReelHlsKey(row.hlsMasterKey, row.id) ||
    ownershipHelpers.isUserOwnedReelMediaKey(row.hlsMasterKey, row.userId);
}

function inventoryEntry({ row, events, leases }) {
  return { reelId: row.id, snapshot: ownedMaster(row) ? snapshot(row) : null,
    protectedSha256: protectedFingerprint(row), expectedDurationMs: row.outputDurationMs ?? row.sourceDurationMs,
    status: eligible(row, events, leases) };
}

function reconcile(entry, live, artifact, now = Date.now()) {
  if (!live.row) throw new Error('Inventoried Reel no longer exists');
  const { row, events, leases } = live;
  if (protectedFingerprint(row) !== entry.protectedSha256) throw new Error('Protected Reel fields changed');
  const attempt = artifact?.plan.attemptId;
  if (eligible(row, events, leases, now, attempt) !== 'PENDING') throw new Error('Reel is not idle and eligible');
  const receipt = events.find((e) => e.id === attempt);
  const rollback = events.find((e) => e.id === `${attempt}:rollback`);
  if (rollback) throw new Error('Reel was rolled back; review a new inventory');
  if (receipt) {
    if (!artifact || receipt.eventType !== CACHE_EVENT || receipt.aggregateId !== entry.reelId ||
        receipt.payload?.reviewedSha256 !== artifact.reviewedSha256 ||
        row.hlsMasterKey !== `reels/${entry.reelId}/${attempt}/master.m3u8` ||
        new Date(row.updatedAt).toISOString() !== receipt.payload.appliedUpdatedAt ||
        receipt.payload.previous?.hlsMasterKey !== entry.snapshot.previousHlsMasterKey)
      throw new Error('Ambiguous replacement receipt or live pointer');
    return { status: receipt.publishedAt ? 'APPLIED' : 'APPLIED_CACHE_PENDING',
      receipt: { id: receipt.id, reviewedSha256: receipt.payload.reviewedSha256,
        appliedUpdatedAt: receipt.payload.appliedUpdatedAt, hlsMasterKey: row.hlsMasterKey,
        previousHlsMasterKey: receipt.payload.previous.hlsMasterKey, publishedAt: json(receipt.publishedAt ?? null),
        leaseExpiresAt: json(leases.find((l) => l.attemptId === attempt)?.expiresAt ?? null) } };
  }
  if (digest(snapshot(row)) !== digest(entry.snapshot)) throw new Error('Stale inventory snapshot or unreceipted pointer');
  const lease = leases.find((l) => l.attemptId === attempt);
  if (lease && (lease.reelId !== entry.reelId || lease.completedAt || new Date(lease.expiresAt).getTime() <= now))
    throw new Error('Replacement lease expired or changed; re-review required');
  return { status: lease ? 'RESERVED' : 'UNCHANGED' };
}

function databaseAdapter(client) {
  const read = (fn) => client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return fn(tx);
  }, { isolationLevel: 'RepeatableRead', timeout: 60_000, maxWait: 5000 });
  const inspect = async (tx, row, attempt) => ({ row,
    events: await tx.outboxEvent.findMany({ where: { aggregateId: row.id, aggregateType: 'REEL',
      OR: [{ publishedAt: null }, ...(attempt ? [{ id: { in: [attempt, `${attempt}:rollback`] } }] : [])] }, take: 1001 }),
    leases: await tx.reelMediaAttemptLease.findMany({ where: { reelId: row.id }, take: 1001 }) });
  const bounded = (live) => {
    if (live.events.length > 1000 || live.leases.length > 1000) throw new Error('Reel reconciliation exceeds record budget');
    return live;
  };
  return {
    inventory: () => read(async (tx) => {
      const entries = []; let cursor;
      for (;;) {
        const rows = await tx.reel.findMany({ orderBy: { id: 'asc' }, take: 100,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
        if (!rows.length) return entries;
        const ids = rows.map((row) => row.id);
        const events = await tx.outboxEvent.findMany({ where: { aggregateId: { in: ids }, aggregateType: 'REEL',
          publishedAt: null, eventType: { not: CACHE_EVENT } }, take: 10_001 });
        const leases = await tx.reelMediaAttemptLease.findMany({ where: { reelId: { in: ids },
          completedAt: null, expiresAt: { gt: new Date() } }, take: 10_001 });
        if (events.length > 10_000 || leases.length > 10_000) throw new Error('Inventory page exceeds work-record budget');
        for (const row of rows) entries.push(inventoryEntry({ row,
          events: events.filter((e) => e.aggregateId === row.id), leases: leases.filter((l) => l.reelId === row.id) }));
        if (entries.length > 100_000) throw new Error('Inventory exceeds record budget');
        cursor = rows.at(-1).id;
      }
    }),
    live: (id, attempt) => read(async (tx) => {
      const row = await tx.reel.findUnique({ where: { id } });
      return row ? bounded(await inspect(tx, row, attempt)) : { row: null };
    }),
    close: () => client.$disconnect(),
  };
}

function productionDependencies() {
  // Loaded only after argument validation and explicit selection of a remote mode.
  require('dotenv').config({ quiet: true });
  const { PrismaClient } = require('@prisma/content-client');
  const db = databaseAdapter(new PrismaClient({ log: [] }));
  const replacement = { ...require('./replace-reel-hls.cjs'),
    main: (args) => promisify(execFile)(process.execPath, [path.join(__dirname, 'replace-reel-hls.cjs'), ...args],
      { timeout: 900_000, maxBuffer: 2_097_152 }) };
  const hls = require('../narto-scraper/hls.cjs');
  return { db, replacement, hls, inspectObjects,
    verifyEncodedTimelines: require('../narto-scraper/materialize-existing-hls.cjs').verifyEncodedTimelines,
    materialize: require('../narto-scraper/materialize-existing-hls.cjs').materializeExistingHls };
}

async function inspectObjects(artifact) {
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({ region: 'auto', maxAttempts: 1,
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  let complete = true;
  const deadline = AbortSignal.timeout(900_000);
  try {
    for (const file of artifact.plan.files) {
      let object;
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(60_000)]);
      try {
        object = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME,
          Key: `reels/${artifact.plan.reelId}/${artifact.plan.attemptId}/${file.path}` }),
        { abortSignal: signal });
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404) { complete = false; continue; }
        throw new Error('Remote object state is unknown');
      }
      const abort = () => object.Body.destroy(new Error('Remote object read timed out'));
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) throw new Error('Remote object deadline exceeded');
        if (object.ContentLength !== file.bytes) throw new Error('Remote object size differs');
        let bytes = 0;
        const sha = createHash('sha256');
        for await (const chunk of object.Body) {
          bytes += chunk.length;
          if (bytes > file.bytes) throw new Error('Remote object exceeds reviewed size');
          sha.update(chunk);
        }
        if (bytes !== file.bytes || sha.digest('hex') !== file.sha256) throw new Error('Remote object hash differs');
      } finally { signal.removeEventListener('abort', abort); object.Body?.destroy(); }
    }
    return { complete };
  } finally { client.destroy(); }
}

async function coordinate(options, dependencies) {
  if (!MODES.includes(options.mode) || options.mode === 'dry-run') throw new Error('Coordinator requires an operational mode');
  requireHoldReleased(options);
  const directory = path.resolve(options['run-dir']);
  if (options.mode === 'inventory') fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.mode & 0o077) throw new Error('Run directory must be private and not a symlink');
  const lock = path.join(directory, 'operator.lock');
  const descriptor = fs.openSync(lock, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    fs.fsyncSync(descriptor);
    const { db, replacement, hls, materialize } = dependencies;
    const inventoryFile = path.join(directory, 'inventory.json'), stateFile = path.join(directory, 'progress.json');
    if (options.mode === 'inventory') {
      const inventory = { schemaVersion: 1, createdAt: new Date().toISOString(), entries: await db.inventory() };
      persist(inventoryFile, inventory, true);
      persist(stateFile, { inventorySha256: digest(inventory), entries: {} }, true);
      return { inventorySha256: digest(inventory), counts: counts(inventory.entries) };
    }
    const inventory = privateRead(inventoryFile), progress = privateRead(stateFile);
    const inventorySha256 = digest(inventory);
    if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.entries) || inventory.entries.length > 100_000 ||
        new Set(inventory.entries.map((e) => e.reelId)).size !== inventory.entries.length ||
        inventory.entries.some((e) => !/^[a-f0-9-]{36}$/i.test(e.reelId)) || progress.inventorySha256 !== inventorySha256)
      throw new Error('Invalid or changed inventory');
    if (options.mode === 'prepare' && options['inventory-sha256'] !== inventorySha256)
      throw new Error('Reviewed inventory digest differs');
    let approvals;
    if (['stage', 'apply'].includes(options.mode)) {
      approvals = privateRead(options['approval-file']);
      if (digest(approvals) !== options['reviewed-sha256'] || !Array.isArray(approvals) ||
          approvals.length > 5 || new Set(approvals.map((e) => e.reelId)).size !== approvals.length ||
          approvals.some((e) => !inventory.entries.some((i) => i.reelId === e.reelId) ||
            !/^[a-f0-9]{64}$/.test(e.reviewedSha256))) throw new Error('Invalid reviewed batch approval');
    }
    let origin;
    if (options.mode === 'prepare') {
      const { sourceUrl } = require('../narto-scraper/materialize-existing-hls.cjs');
      origin = sourceUrl(options['media-origin']);
      if (origin.search || origin.pathname !== '/') throw new Error('Media origin must have no path or query');
    }
    let processed = 0;
    for (const [entryIndex, entry] of inventory.entries.entries()) {
      if (options.mode === 'reconcile' && entryIndex < (progress.reconcileCursor || 0)) continue;
      if (!['PENDING', 'DEFERRED'].includes(entry.status)) continue;
      const current = progress.entries[entry.reelId] || { status: 'PENDING' };
      if (approvals && !approvals.some((a) => a.reelId === entry.reelId)) continue;
      if (options.mode === 'prepare' && current.status === 'PREPARED') continue;
      if (options.mode === 'stage' && current.status === 'STAGED') continue;
      if (options.mode !== 'reconcile' && ['APPLIED', 'APPLIED_CACHE_PENDING'].includes(current.status)) continue;
      if (processed >= options.limit) break;
      processed++;
      const reelDir = path.join(directory, entry.reelId);
      const artifactFile = path.join(reelDir, 'reviewed.json');
      let artifact;
      const save = (values) => {
        if (!values.reason) delete current.reason;
        Object.assign(current, values, { checkedAt: new Date().toISOString() });
        progress.entries[entry.reelId] = current;
        if (options.mode === 'reconcile' && !values.reason) progress.reconcileCursor = entryIndex + 1;
        persist(stateFile, progress);
      };
      try {
        if (fs.existsSync(artifactFile)) {
          privateRead(artifactFile);
          artifact = replacement.readArtifact(artifactFile);
          const totalBytes = artifact.plan.files?.reduce((sum, file) => sum + file.bytes, 0);
          if (totalBytes > 4 * 1024 ** 3) throw new Error('Prepared graph exceeds encoding byte budget');
          if (artifact.plan.reelId !== entry.reelId || digest(Object.fromEntries(Object.keys(entry.snapshot)
              .map((key) => [key, artifact.plan[key]]))) !== digest(entry.snapshot))
            throw new Error('Prepared plan differs from inventory');
          await replacement.verifyLocalFiles(artifact);
        }
        const live = await db.live(entry.reelId, artifact?.plan.attemptId);
        const remote = reconcile(entry, live, artifact);
        if (remote.status.startsWith('APPLIED')) {
          if (!(await dependencies.inspectObjects(artifact)).complete) throw new Error('Applied graph is incomplete');
          save(remote); continue;
        }
        if (options.mode === 'reconcile') {
          if (remote.status === 'RESERVED') {
            const staged = await dependencies.inspectObjects(artifact);
            save({ status: staged.complete ? 'STAGED' : 'RESERVED', remoteStatus: remote.status });
          } else if (['STAGING', 'APPLYING', 'UNKNOWN'].includes(current.status)) {
            throw new Error('Uncertain operation has no live receipt or lease');
          } else save({ remoteStatus: remote.status });
          continue;
        }
        if (options.mode === 'prepare') {
          if (remote.status !== 'UNCHANGED') throw new Error('Reservation exists; do not prepare another attempt');
          if (artifact) { save({ status: 'PREPARED', reviewedSha256: artifact.reviewedSha256 }); continue; }
          if (current.status === 'BLOCKED') throw new Error('Preparation blocked; review retained evidence');
          if (!fs.existsSync(reelDir)) fs.mkdirSync(reelDir, { mode: 0o700 });
          const space = fs.statfsSync(reelDir);
          if (Number(space.bavail) * Number(space.bsize) < 8 * 1024 ** 3) throw new Error('Insufficient encoding disk budget');
          save({ status: 'PREPARING' });
          const sourceDir = path.join(reelDir, 'source');
          let source;
          if (fs.existsSync(sourceDir)) {
            const provenance = privateRead(path.join(sourceDir, 'provenance.json'));
            source = path.join(sourceDir, 'source.mp4');
            if (provenance.sourceUrlSha256 !== createHash('sha256').update(new URL(entry.snapshot.previousHlsMasterKey, origin).href).digest('hex') ||
                await hls.sha256(source) !== provenance.sourceSha256) throw new Error('Saved source provenance differs');
          } else ({ source } = await materialize({ url: new URL(entry.snapshot.previousHlsMasterKey, origin).href,
            outputDir: sourceDir, expectedDurationMs: entry.expectedDurationMs }));
          const outputDir = path.join(reelDir, 'encoded');
          const preparationFile = path.join(reelDir, 'preparation.json');
          // The input is already published/cropped/trimmed. Never pass mediaEdit again.
          let media;
          if (fs.existsSync(preparationFile)) {
            const saved = privateRead(preparationFile);
            if (saved.reelId !== entry.reelId || saved.outputDir !== outputDir ||
                saved.media.sourceSha256 !== await hls.sha256(source)) throw new Error('Saved preparation differs from source');
            media = saved.media;
            await hls.validateLocalHls(outputDir, media.profile);
          } else {
            media = await hls.prepareHls({ source, outputDir });
            persist(preparationFile, { reelId: entry.reelId, outputDir, media }, true);
          }
          if (Math.abs(media.outputDurationMs - entry.expectedDurationMs) > 250)
            throw new Error('Prepared output duration differs from inventory');
          await dependencies.verifyEncodedTimelines(source, outputDir, media.profile);
          reconcile(entry, await db.live(entry.reelId), undefined);
          artifact = { outputDir, ...replacement.makePlan({ reelId: entry.reelId, media }, entry.snapshot) };
          await replacement.verifyLocalFiles(artifact);
          persist(artifactFile, artifact, true);
          save({ status: 'PREPARED', reviewedSha256: artifact.reviewedSha256 });
          continue;
        }
        if (!artifact || !approvals.some((a) => a.reelId === entry.reelId && a.reviewedSha256 === artifact.reviewedSha256))
          throw new Error('Prepared artifact lacks explicit approval');
        if (options.mode === 'stage') {
          if (current.status === 'STAGING' || current.status === 'UNKNOWN')
            throw new Error('Uncertain staging requires operator reconciliation; no automatic remote retry');
          if (current.status === 'STAGED' && remote.status === 'RESERVED') continue;
          save({ status: 'STAGING' });
          await replacement.main(['--stage', `--artifact=${artifactFile}`, `--reviewed-sha256=${artifact.reviewedSha256}`]);
          const after = reconcile(entry, await db.live(entry.reelId, artifact.plan.attemptId), artifact);
          if (after.status !== 'RESERVED') throw new Error('Staging lease was not confirmed');
          save({ status: 'STAGED', reviewedSha256: artifact.reviewedSha256 });
        } else {
          if (current.status !== 'STAGED' || remote.status !== 'RESERVED') throw new Error('Apply requires confirmed staging and live lease');
          if (!(await dependencies.inspectObjects(artifact)).complete) throw new Error('Staged object graph is incomplete');
          save({ status: 'APPLYING' });
          await replacement.main(['--apply', `--artifact=${artifactFile}`, `--reviewed-sha256=${artifact.reviewedSha256}`]);
          const after = reconcile(entry, await db.live(entry.reelId, artifact.plan.attemptId), artifact);
          if (!after.status.startsWith('APPLIED')) throw new Error('Apply receipt was not confirmed');
          save(after);
        }
      } catch {
        // Do not persist transport/SDK error text: it can contain signed URLs or credentials.
        save({ status: ['STAGING', 'APPLYING', 'UNKNOWN'].includes(current.status) ? 'UNKNOWN' : 'BLOCKED',
          reason: 'Stopped; reconcile live state and retained private evidence before proceeding' });
        throw new Error('Batch stopped safely; inspect private progress and reconcile before retrying');
      }
    }
    if (options.mode === 'reconcile' && (processed < options.limit || progress.reconcileCursor >= inventory.entries.length)) {
      progress.reconcileCursor = 0;
      persist(stateFile, progress);
    }
    return { processed, inventorySha256, counts: counts(inventory.entries.map((e) => progress.entries[e.reelId] || e)),
      complete: false, verification: 'Playback/device/quality acceptance and a final inventory sweep are still required' };
  } finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}

function counts(entries) {
  return entries.reduce((result, entry) => ({ ...result, [entry.status]: (result[entry.status] || 0) + 1 }), {});
}

async function main(argv = process.argv.slice(2), dependencies) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Existing Reel HLS rollout: --inventory|--prepare|--stage|--apply|--reconcile --run-dir=PRIVATE_DIRECTORY --hold-released. Default: offline dry-run. See REEL-HLS-REENCODE-ROLLOUT.md.');
    return;
  }
  if (options.mode === 'dry-run') { console.log(JSON.stringify({ mode: 'DRY_RUN', connections: false, writes: false })); return; }
  const deps = dependencies || productionDependencies();
  try { const result = await coordinate(options, deps); console.log(JSON.stringify(result)); return result; }
  finally { await deps.db.close(); }
}

if (require.main === module) main().catch(() => {
  console.error('Re-encoding stopped; inspect private progress and reconcile before retrying.');
  process.exitCode = 1;
});
module.exports = { parseArgs, privateRead, persist, digest, protectedFingerprint, snapshot, eligible,
  inventoryEntry, reconcile, databaseAdapter, inspectObjects, coordinate, main };
