#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { PrismaClient } = require('@prisma/reel-indexing-client');
const { ConfigService } = require('@nestjs/config');
const {
  QdrantReelVectorStoreAdapter,
} = require('../../apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter');
const {
  PrismaVectorProjectionRepository,
} = require('../../apps/reel-indexing-service/src/infrastructure/repositories/prisma-vector-projection.repository');
const { argumentsFor, targetFingerprint } = require('./reel-qdrant.cjs');
const {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { resolve, join, basename } = require('node:path');
const MAX_SNAPSHOT = 128 * 1024 * 1024;
const MAX_ARCHIVE = 180 * 1024 * 1024;
const digest = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
function encrypt(value, password) {
  const salt = crypto.randomBytes(16),
    iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    crypto.scryptSync(password, salt, 32),
    iv,
  );
  const plaintext = Buffer.from(JSON.stringify(value));
  if (plaintext.length > MAX_ARCHIVE)
    throw new Error('Backup exceeds archive byte bound');
  return Buffer.concat([
    Buffer.from('VQBACK01'),
    salt,
    iv,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
function decrypt(bytes, password) {
  if (
    bytes.length < 52 ||
    bytes.length > MAX_ARCHIVE + 52 ||
    bytes.subarray(0, 8).toString() !== 'VQBACK01'
  )
    throw new Error('Invalid bounded backup');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    crypto.scryptSync(password, bytes.subarray(8, 24), 32),
    bytes.subarray(24, 36),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(36, -16)),
      decipher.final(),
    ]).toString('utf8'),
  );
}
async function boundedRead(file, maximum = MAX_ARCHIVE + 52) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    throw new Error('Unbounded or linked backup file');
  return fs.readFile(file);
}
async function download(store, snapshot) {
  if (basename(snapshot) !== snapshot || !/^[a-zA-Z0-9_.-]+$/.test(snapshot))
    throw new Error('Invalid snapshot name');
  const response = await fetch(
    new URL(
      `/collections/${store.collection}/snapshots/${snapshot}`,
      process.env.QDRANT_URL,
    ),
    {
      headers: {
        'api-key': (
          await fs.readFile(process.env.QDRANT_API_KEY_FILE, 'utf8')
        ).trim(),
      },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    },
  );
  if (!response.ok || !response.body)
    throw new Error('Snapshot download failed');
  let length = 0;
  const chunks = [];
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_SNAPSHOT) throw new Error('Snapshot exceeds byte bound');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
async function rotate(directory, keep) {
  const names = (await fs.readdir(directory))
    .filter((name) => /^velora-qdrant-\d{13}-[a-f0-9-]+\.vqb$/.test(name))
    .sort()
    .reverse();
  for (const name of names.slice(keep)) await fs.unlink(join(directory, name));
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
function backupPrefix(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,180}$/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid off-host R2 prefix');
  return `${value.replace(/\/+$/, '')}/`;
}
async function publishOffhostR2(client, bucket, prefix, name, bytes) {
  const key = `${prefix}${name}`;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: 'application/octet-stream',
      CacheControl: 'no-store',
      Metadata: { sha256: digest(bytes) },
    }),
  );
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) throw new Error('Off-host R2 readback failed');
  const readback = Buffer.from(await response.Body.transformToByteArray());
  if (digest(readback) !== digest(bytes))
    throw new Error('Off-host R2 checksum failed');
  let continuationToken;
  const keys = [];
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    keys.push(
      ...(page.Contents ?? [])
        .map((item) => item.Key)
        .filter(
          (item) =>
            typeof item === 'string' &&
            /^velora-qdrant-\d{13}-[a-f0-9-]+\.vqb$/.test(basename(item)),
        ),
    );
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);
  keys.sort().reverse();
  for (const old of keys.slice(7))
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: old }));
  return { key, encryptedSha256: digest(readback) };
}
async function backup(prisma, projection, store, args, password) {
  const remotePrefix = args['offhost-r-prefix']
    ? backupPrefix(args['offhost-r-prefix'])
    : undefined;
  if (
    !args.directory ||
    (!remotePrefix && !args['offhost-directory']) ||
    !args['sql-backup-proof']
  )
    throw new Error(
      'Explicit local/offhost destination and SQL backup proof required',
    );
  const directory = resolve(args.directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const localTest =
    args['local-test'] === 'true' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(
      new URL(process.env.QDRANT_URL).hostname,
    );
  let offhost;
  let r2;
  if (remotePrefix) {
    if (args['offhost-proof'] !== 'VERIFIED_R2_BUCKET_ACCESS')
      throw new Error('Offhost R2 access proof missing');
    r2 = r2Client();
  } else {
    offhost = resolve(args['offhost-directory']);
    if (directory === offhost)
      throw new Error('Offhost destination must be separate');
    const offhostStat = await fs.stat(offhost);
    const localStat = await fs.stat(directory);
    if (
      !offhostStat.isDirectory() ||
      (!localTest &&
        (offhostStat.dev === localStat.dev ||
          args['offhost-proof'] !== 'VERIFIED_REMOTE_MOUNT_AND_ACCESS'))
    )
      throw new Error('Offhost mount/access proof missing');
  }
  const sqlProofBytes = await boundedRead(
    args['sql-backup-proof'],
    1024 * 1024,
  );
  const sqlProof = JSON.parse(sqlProofBytes);
  if (
    !sqlProof.snapshot ||
    sqlProof.source !==
      targetFingerprint(process.env.REEL_INDEXING_DATABASE_URL)
  )
    throw new Error('SQL backup provenance does not match');
  const identity = await store.identity();
  const existingSnapshots = await store.request(
    `/collections/${store.collection}/snapshots`,
    'GET',
  );
  if (!Array.isArray(existingSnapshots) || existingSnapshots.length >= 3)
    throw new Error(
      'Retained Qdrant snapshot bound reached; inspect failed backups before retry',
    );
  const snapshot = await store.request(
    `/collections/${store.collection}/snapshots?wait=true`,
    'POST',
  );
  const bytes = await download(store, snapshot.name);
  const pointCount = await store.request(
    '/collections/' + store.collection + '/points/count',
    'POST',
    { exact: true },
  );
  const manifest = {
    version: 1,
    identity,
    snapshot: {
      name: snapshot.name,
      sha256: digest(bytes),
      bytes: bytes.length,
    },
    pointCount: pointCount.count,
    aliases: await store.request('/aliases', 'GET'),
    configuration: await store.request(
      `/collections/${store.collection}`,
      'GET',
    ),
    sqlBackupProofHash: digest(sqlProofBytes),
    sqlSnapshot: sqlProof.snapshot,
    projectionWatermarks: await prisma.vectorCollectionState.findMany(),
    pendingProjectionTasks: await prisma.vectorProjectionTask.count({
      where: { completedAt: null },
    }),
    at: new Date().toISOString(),
    crossDatabaseConsistency: 'requires SQL replay and reconciliation',
  };
  const encrypted = encrypt(
    { manifest, snapshot: bytes.toString('base64') },
    password,
  );
  const name = `velora-qdrant-${Date.now()}-${crypto.randomUUID()}.vqb`;
  await fs.writeFile(join(directory, name), encrypted, {
    flag: 'wx',
    mode: 0o600,
  });
  // Publish only a complete encrypted archive; verify readback before rotation or snapshot deletion.
  let offhostResult;
  if (remotePrefix) {
    offhostResult = await publishOffhostR2(
      r2.client,
      r2.bucket,
      remotePrefix,
      name,
      encrypted,
    );
  } else {
    const temporary = join(offhost, `.${name}.partial`);
    await fs.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
    if (digest(await boundedRead(temporary)) !== digest(encrypted))
      throw new Error('Offhost readback checksum failed');
    await fs.link(temporary, join(offhost, name));
    await fs.unlink(temporary);
    offhostResult = {
      key: join(offhost, name),
      encryptedSha256: digest(encrypted),
    };
  }
  await rotate(directory, 3);
  if (!remotePrefix) await rotate(offhost, 7);
  await store.request(
    `/collections/${store.collection}/snapshots/${encodeURIComponent(snapshot.name)}?wait=true`,
    'DELETE',
  );
  return {
    name,
    encryptedSha256: digest(encrypted),
    offhostLocation: offhostResult.key,
    offhostVerified: !localTest,
    localSimulation: localTest,
  };
}
async function restore(projection, store, args, password) {
  if (
    args['recovery-proof'] !==
    'READERS_POSTGRES_WRITERS_DRAINED_PUBLICATION_DISABLED'
  )
    throw new Error('Ordered recovery/drain proof required');
  const archive = decrypt(await boundedRead(args.archive), password);
  if (
    archive.manifest?.version !== 1 ||
    archive.manifest.identity.collection !== store.collection
  )
    throw new Error('Backup physical collection mismatch');
  const bytes = Buffer.from(archive.snapshot, 'base64');
  if (
    bytes.length > MAX_SNAPSHOT ||
    bytes.length !== archive.manifest.snapshot.bytes ||
    digest(bytes) !== archive.manifest.snapshot.sha256
  )
    throw new Error('Snapshot integrity failure');
  // Maintenance remains durable on any failure; projector cannot certify while recovery is running.
  await projection.invalidate();
  await store.restoreSnapshot(bytes);
  const aliases = await store.request('/aliases', 'GET');
  const alias = aliases.aliases.find((item) => item.alias_name === store.alias);
  if (alias && alias.collection_name !== store.collection)
    throw new Error('Alias points to another physical collection');
  if (!alias)
    await store.request('/collections/aliases', 'POST', {
      actions: [
        {
          create_alias: {
            collection_name: store.collection,
            alias_name: store.alias,
          },
        },
      ],
    });
  await store.identity();
  return {
    restored: true,
    maintenance: true,
    remaining:
      'Resume recovery then replay/reconcile SQL before enabling publication or reads',
  };
}
async function verifyRestore(args, password) {
  const archive = decrypt(await boundedRead(args.archive), password);
  const bytes = Buffer.from(archive.snapshot, 'base64');
  if (
    archive.manifest?.version !== 1 ||
    !Number.isInteger(archive.manifest.pointCount) ||
    bytes.length > MAX_SNAPSHOT ||
    bytes.length !== archive.manifest.snapshot.bytes ||
    digest(bytes) !== archive.manifest.snapshot.sha256
  )
    throw new Error('Backup snapshot manifest or checksum is invalid');
  const collection = `restore_verify_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const config = new ConfigService({
    ...process.env,
    QDRANT_COLLECTION: collection,
  });
  const store = new QdrantReelVectorStoreAdapter(config);
  try {
    await store.restoreSnapshot(bytes);
    const count = await store.request(
      `/collections/${collection}/points/count`,
      'POST',
      { exact: true },
    );
    if (count.count !== archive.manifest.pointCount)
      throw new Error('Restored collection point count mismatch');
    const sample = await store.request(
      `/collections/${collection}/points/scroll`,
      'POST',
      {
        limit: Math.min(16, count.count),
        with_payload: true,
        with_vector: true,
      },
    );
    if (
      !Array.isArray(sample.points) ||
      sample.points.length !== Math.min(16, count.count) ||
      sample.points.some(
        (point) =>
          !point.payload ||
          !Array.isArray(point.vector) ||
          point.vector.length !== 1024 ||
          point.vector.some((value) => !Number.isFinite(value)),
      )
    )
      throw new Error('Restored collection sample validation failed');
    return {
      restoredCollection: collection,
      restoredPointCount: count.count,
      sampledPoints: sample.points.length,
      cleanup: 'temporary collection deleted',
    };
  } finally {
    const exists = await store
      .request(`/collections/${collection}/exists`, 'GET')
      .catch(() => ({ exists: false }));
    if (exists.exists) {
      await store.request(`/collections/${collection}`, 'DELETE');
      const remaining = await store.request(
        `/collections/${collection}/exists`,
        'GET',
      );
      if (remaining.exists)
        throw new Error('Temporary restore collection cleanup failed');
    }
  }
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argumentsFor(rest);
  if (
    !['backup', 'restore', 'verify-restore'].includes(command) ||
    !args['target-label'] ||
    args.confirm !== `QDRANT_${args['target-label']}`
  )
    throw new Error('Explicit backup|restore target and confirmation required');
  const password = await boundedRead(args['encryption-key-file'], 4096);
  if (password.length < 32)
    throw new Error('Encryption key must contain at least 32 random bytes');
  if (command === 'verify-restore') {
    const result = await verifyRestore(args, password);
    password.fill(0);
    console.log(
      JSON.stringify({ command, target: args['target-label'], result }),
    );
    return;
  }
  if (!process.env.REEL_INDEXING_DATABASE_URL)
    throw new Error('Owner-service SQL target required');
  const prisma = new PrismaClient();
  const config = new ConfigService();
  const store = new QdrantReelVectorStoreAdapter(config);
  const projection = new PrismaVectorProjectionRepository(
    prisma,
    config,
    store,
  );
  try {
    let result;
    if (command === 'backup')
      result = await backup(prisma, projection, store, args, password);
    else result = await restore(projection, store, args, password);
    console.log(
      JSON.stringify({ command, target: args['target-label'], result }),
    );
  } finally {
    password.fill(0);
    await prisma.$disconnect();
  }
}
module.exports = {
  encrypt,
  decrypt,
  backup,
  restore,
  verifyRestore,
  rotate,
  publishOffhostR2,
};
if (require.main === module)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: 'Qdrant backup/recovery failed',
        code:
          error && typeof error === 'object'
            ? (error.code ?? error.$metadata?.httpStatusCode ?? error.name)
            : 'unknown',
        detail:
          error instanceof Error
            ? error.message
                .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database URL]')
                .replace(/https?:\/\/\S+/giu, '[service URL]')
                .replace(process.env.R2_BUCKET_NAME || '\u0000', '[R2 bucket]')
            : 'unknown',
        maintenanceOrSnapshotMayRemain: true,
      }),
    );
    process.exitCode = 1;
  });
