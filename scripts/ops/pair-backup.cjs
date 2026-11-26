#!/usr/bin/env node
/* Paired PostgreSQL + Qdrant backup helper, run inside the isolated operator container
 * (see infra/qdrant/PAIR-BACKUP.md). It never signals services and never touches Qdrant
 * directly: `pair-backup.sh` drives the host side (drain, pg_dump, resume, off-site copy)
 * and `qdrant-backup.cjs backup` takes the snapshot. */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { PrismaClient } = require('@prisma/reel-indexing-client');
const {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { join, resolve } = require('node:path');
const {
  argumentsFor,
  currentProjections,
  projectionSignature,
  targetFingerprint,
} = require('./reel-qdrant.cjs');
const CHUNK = 4 * 1024 * 1024;
const MAX_DUMP = 512 * 1024 * 1024;
const MAGIC = Buffer.from('VQPGD001');
const TABLES = [
  'ReelDocument',
  'ReelSection',
  'ReelChunk',
  'ReelVisualScene',
  'VectorProjection',
];
const sha256 = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}
const aadFor = (index, final) => {
  const aad = Buffer.alloc(5);
  aad.writeUInt32BE(index, 0);
  aad[4] = final ? 1 : 0;
  return aad;
};

/* Chunked AES-256-GCM, scrypt key. Each chunk binds its index and a final flag, so
 * reordering, dropping a chunk or truncating the file fails authentication. */
async function encryptFile(input, output, password) {
  const stat = await fs.lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DUMP)
    throw new Error('Unbounded or linked dump file');
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  const source = await fs.open(input, 'r');
  const target = await fs.open(output, 'wx', 0o600);
  try {
    await target.write(Buffer.concat([MAGIC, salt]));
    const total = Math.max(1, Math.ceil(stat.size / CHUNK));
    for (let index = 0; index < total; index++) {
      const buffer = Buffer.alloc(CHUNK);
      const { bytesRead } = await source.read(buffer, 0, CHUNK, index * CHUNK);
      const final = index === total - 1;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aadFor(index, final));
      const body = Buffer.concat([
        cipher.update(buffer.subarray(0, bytesRead)),
        cipher.final(),
      ]);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      await target.write(
        Buffer.concat([header, iv, body, cipher.getAuthTag()]),
      );
    }
  } finally {
    await source.close();
    await target.close();
  }
}
// Returns the plaintext SHA-256 and optionally writes the plaintext (mode 600).
async function decryptFile(input, password, output) {
  const bytes = await fs.readFile(input);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(MAGIC))
    throw new Error('Invalid pair dump archive');
  const key = crypto.scryptSync(password, bytes.subarray(8, 24), 32);
  const hash = crypto.createHash('sha256');
  const target = output ? await fs.open(output, 'wx', 0o600) : undefined;
  try {
    let offset = 24;
    let index = 0;
    while (offset < bytes.length) {
      if (offset + 4 + 12 + 16 > bytes.length)
        throw new Error('Truncated pair dump archive');
      const length = bytes.readUInt32BE(offset);
      const end = offset + 4 + 12 + length + 16;
      if (length > CHUNK || end > bytes.length)
        throw new Error('Truncated pair dump archive');
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(offset + 4, offset + 16),
      );
      decipher.setAAD(aadFor(index, end === bytes.length));
      decipher.setAuthTag(bytes.subarray(end - 16, end));
      const plain = Buffer.concat([
        decipher.update(bytes.subarray(offset + 16, end - 16)),
        decipher.final(),
      ]);
      hash.update(plain);
      if (target) await target.write(plain);
      offset = end;
      index++;
    }
    return hash.digest('hex');
  } finally {
    await target?.close();
  }
}

function r2Client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey)
    throw new Error('Private R2 backup access is not configured');
  return {
    bucket,
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    }),
  };
}
function pairPrefix(value, pairId) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,180}$/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid off-host R2 prefix');
  return `${value.replace(/\/+$/, '')}/${pairId}/`;
}
async function putVerified(r2, key, bytes) {
  await r2.client.send(
    new PutObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      Body: bytes,
      ContentType: 'application/octet-stream',
      CacheControl: 'no-store',
      Metadata: { sha256: sha256(bytes) },
    }),
  );
  const readback = await getObject(r2, key);
  if (sha256(readback) !== sha256(bytes))
    throw new Error('Off-host R2 checksum failed');
  return sha256(readback);
}
async function getObject(r2, key) {
  const response = await r2.client.send(
    new GetObjectCommand({ Bucket: r2.bucket, Key: key }),
  );
  if (!response.Body) throw new Error('Off-host R2 readback failed');
  return Buffer.from(await response.Body.transformToByteArray());
}

async function facts(prisma) {
  const [wal] = await prisma.$queryRawUnsafe(
    `SELECT (CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()
       ELSE pg_current_wal_lsn() END)::text AS lsn, now()::text AS "dbTime"`,
  );
  const tableCounts = {};
  for (const table of TABLES) {
    const where = table === 'VectorProjection' ? ' WHERE NOT "revoked"' : '';
    const [row] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "${table}"${where}`,
    );
    tableCounts[table] = row.n;
  }
  const rows = await currentProjections(prisma);
  return {
    lsn: wal.lsn,
    dbTime: wal.dbTime,
    tableCounts,
    projectionCount: rows.length,
    pointSum: rows.reduce((sum, row) => sum + row.pointCount, 0),
    projectionFingerprint: projectionSignature(rows),
  };
}

// Writers are quiet when nothing is queued for Qdrant, no publication is mid-flight and
// no indexing attempt has touched its row recently. Old PROCESSING rows are stale, not busy.
async function quiesce(prisma, recentMinutes) {
  const [pending] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "VectorProjectionTask" WHERE "completedAt" IS NULL`,
  );
  const [publishing] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "VectorProjection"
     WHERE NOT "revoked" AND ("continuation" IS NOT NULL OR "continuationUntil" > now())`,
  );
  const [recent] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "IndexingAttempt"
     WHERE "status" = 'PROCESSING'
       AND "updatedAt" > now() - make_interval(mins => ${Number(recentMinutes)})`,
  );
  const result = {
    pendingProjectionTasks: pending.n,
    publicationsInFlight: publishing.n,
    recentProcessingAttempts: recent.n,
  };
  result.quiet =
    !result.pendingProjectionTasks &&
    !result.publicationsInFlight &&
    !result.recentProcessingAttempts;
  return result;
}

// reconcile() re-opens completed DELETE tasks of revoked generations every five minutes, so
// "pending" is briefly non-zero even when nothing is being indexed. Wait for it to settle.
async function settledQuiesce(prisma, recentMinutes, settleSeconds) {
  const until = Date.now() + settleSeconds * 1000;
  let state = await quiesce(prisma, recentMinutes);
  while (!state.quiet && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    state = await quiesce(prisma, recentMinutes);
  }
  return state;
}

async function readJson(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error('Unbounded or linked JSON file');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function writeOnce(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}
async function keyBytes(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
    throw new Error('Unbounded or linked key file');
  const key = await fs.readFile(file);
  if (key.length < 32)
    throw new Error('Encryption key must contain at least 32 random bytes');
  return key;
}

async function begin(prisma, args) {
  const directory = resolve(args.dir);
  const pairId = crypto.randomUUID();
  const state = await settledQuiesce(
    prisma,
    Number(args['recent-minutes'] || 10),
    Number(args['settle-seconds'] || 60),
  );
  const result = {
    version: 1,
    pairId,
    startedAt: new Date().toISOString(),
    quiesce: state,
    ...(await facts(prisma)),
  };
  if (args['require-quiet'] !== 'false' && !state.quiet)
    return { ...result, ok: false };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await writeOnce(join(directory, 'begin.json'), result);
  return { ...result, ok: true };
}

// Runs after pg_dump: binds the dump hash and WAL position to the unchanged SQL state.
async function proof(prisma, args) {
  const directory = resolve(args.dir);
  const start = await readJson(join(directory, 'begin.json'));
  const dumpFile = join(directory, 'reel-indexing.dump');
  const stat = await fs.lstat(dumpFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024)
    throw new Error('Dump file is missing or empty');
  const now = await facts(prisma);
  if (now.projectionFingerprint !== start.projectionFingerprint)
    throw new Error(
      'Pair fence changed: SQL projections moved during the dump',
    );
  const dumpSha256 = await fileSha256(dumpFile);
  const value = {
    version: 1,
    source: targetFingerprint(process.env.REEL_INDEXING_DATABASE_URL),
    snapshot: {
      file: 'reel-indexing.dump',
      sha256: dumpSha256,
      bytes: stat.size,
      createdAt: start.startedAt,
    },
    pairId: start.pairId,
    at: new Date().toISOString(),
    lsnBeforeDump: start.lsn,
    lsn: now.lsn,
    dumpSha256,
    projectionFingerprint: now.projectionFingerprint,
    projectionCount: now.projectionCount,
    pointSum: now.pointSum,
    tableCounts: now.tableCounts,
  };
  await writeOnce(join(directory, 'sql-proof.json'), value);
  return value;
}

// Encrypts the dump, publishes dump + pair manifest to R2 and verifies readback.
async function finish(args, password) {
  const directory = resolve(args.dir);
  const sqlProof = await readJson(join(directory, 'sql-proof.json'));
  const qdrantResult = await readJson(join(directory, 'qdrant-result.json'));
  const archive = qdrantResult.result;
  if (!archive?.name || !/^[a-f0-9]{64}$/.test(archive.encryptedSha256 ?? ''))
    throw new Error('Qdrant backup result is missing');
  const encrypted = join(directory, `reel-indexing-${sqlProof.pairId}.vqd`);
  await encryptFile(join(directory, 'reel-indexing.dump'), encrypted, password);
  const encryptedBytes = await fs.readFile(encrypted);
  const prefix = pairPrefix(args['offhost-r-prefix'], sqlProof.pairId);
  const r2 = r2Client();
  const dumpKey = `${prefix}reel-indexing-${sqlProof.pairId}.vqd`;
  const encryptedSha256 = await putVerified(r2, dumpKey, encryptedBytes);
  const manifest = {
    version: 1,
    pairId: sqlProof.pairId,
    createdAt: sqlProof.snapshot.createdAt,
    sql: {
      lsnBeforeDump: sqlProof.lsnBeforeDump,
      lsn: sqlProof.lsn,
      dumpSha256: sqlProof.dumpSha256,
      dumpBytes: sqlProof.snapshot.bytes,
      encryptedFile: `reel-indexing-${sqlProof.pairId}.vqd`,
      encryptedSha256,
      encryptedBytes: encryptedBytes.length,
      tableCounts: sqlProof.tableCounts,
      projectionCount: sqlProof.projectionCount,
      pointSum: sqlProof.pointSum,
      projectionFingerprint: sqlProof.projectionFingerprint,
    },
    qdrant: {
      archive: archive.name,
      encryptedSha256: archive.encryptedSha256,
      archiveLocation: archive.offhostLocation,
      pointCount: archive.pointCount ?? null,
    },
    r2Prefix: prefix,
  };
  await writeOnce(join(directory, 'pair-manifest.json'), manifest);
  await putVerified(
    r2,
    `${prefix}pair-manifest.json`,
    Buffer.from(JSON.stringify(manifest, null, 2)),
  );
  return {
    pairId: manifest.pairId,
    dumpKey,
    encryptedSha256,
    encryptedBytes: encryptedBytes.length,
  };
}

// Reads the pair back from R2 and proves it is decryptable and internally consistent.
async function fetchPair(args, password) {
  const r2 = r2Client();
  const prefix = pairPrefix(args['offhost-r-prefix'], args['pair-id']);
  const manifest = JSON.parse(
    (await getObject(r2, `${prefix}pair-manifest.json`)).toString('utf8'),
  );
  const dump = await getObject(r2, `${prefix}${manifest.sql.encryptedFile}`);
  if (sha256(dump) !== manifest.sql.encryptedSha256)
    throw new Error('Pair dump checksum mismatch');
  const directory = resolve(args.dir);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const encrypted = join(directory, manifest.sql.encryptedFile);
  await fs.writeFile(encrypted, dump, { flag: 'wx', mode: 0o600 });
  const plain = await decryptFile(
    encrypted,
    password,
    args.decrypt === 'true' ? join(directory, 'reel-indexing.dump') : undefined,
  );
  if (plain !== manifest.sql.dumpSha256)
    throw new Error('Pair dump content hash mismatch');
  const archive = await getObject(r2, manifest.qdrant.archiveLocation);
  if (sha256(archive) !== manifest.qdrant.encryptedSha256)
    throw new Error('Pair Qdrant archive checksum mismatch');
  await fs.writeFile(join(directory, manifest.qdrant.archive), archive, {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    pairId: manifest.pairId,
    dumpBytes: manifest.sql.dumpBytes,
    archive: manifest.qdrant.archive,
    archiveBytes: archive.length,
    dumpContentHashVerified: true,
    archiveChecksumVerified: true,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argumentsFor(rest);
  if (!['begin', 'proof', 'finish', 'fetch', 'quiesce'].includes(command))
    throw new Error('Command: begin|proof|finish|fetch|quiesce');
  if (command !== 'fetch' && command !== 'quiesce' && !args.dir)
    throw new Error('Explicit --dir required');
  let result;
  if (command === 'finish' || command === 'fetch') {
    if (!args['encryption-key-file'] || !args['offhost-r-prefix'])
      throw new Error('Key file and off-host prefix required');
    const password = await keyBytes(args['encryption-key-file']);
    try {
      result =
        command === 'finish'
          ? await finish(args, password)
          : await fetchPair(args, password);
    } finally {
      password.fill(0);
    }
  } else {
    const url = process.env.REEL_INDEXING_DATABASE_URL;
    if (!url) throw new Error('Owner-service SQL target required');
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      if (command === 'begin') result = await begin(prisma, args);
      else if (command === 'proof') result = await proof(prisma, args);
      else
        result = await settledQuiesce(
          prisma,
          Number(args['recent-minutes'] || 10),
          Number(args['settle-seconds'] || 60),
        );
    } finally {
      await prisma.$disconnect();
    }
  }
  process.stdout.write(`${JSON.stringify({ command, result })}\n`);
  if (result && (result.ok === false || result.quiet === false))
    process.exitCode = 2;
}

module.exports = { encryptFile, decryptFile, pairPrefix, facts, quiesce };
if (require.main === module)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: 'Pair backup step failed',
        detail:
          error instanceof Error
            ? error.message
                .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database URL]')
                .replace(/https?:\/\/\S+/giu, '[service URL]')
            : 'unknown',
      }),
    );
    process.exitCode = 1;
  });
