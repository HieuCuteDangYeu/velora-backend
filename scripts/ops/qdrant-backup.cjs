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
async function backup(prisma, projection, store, args, password) {
  if (
    !args.directory ||
    !args['offhost-directory'] ||
    !args['sql-backup-proof']
  )
    throw new Error(
      'Explicit local/offhost directories and SQL backup proof required',
    );
  const directory = resolve(args.directory),
    offhost = resolve(args['offhost-directory']);
  if (directory === offhost)
    throw new Error('Offhost destination must be separate');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const offhostStat = await fs.stat(offhost),
    localStat = await fs.stat(directory);
  const localTest =
    args['local-test'] === 'true' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(
      new URL(process.env.QDRANT_URL).hostname,
    );
  if (
    !offhostStat.isDirectory() ||
    (!localTest &&
      (offhostStat.dev === localStat.dev ||
        args['offhost-proof'] !== 'VERIFIED_REMOTE_MOUNT_AND_ACCESS'))
  )
    throw new Error('Offhost mount/access proof missing');
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
  const manifest = {
    version: 1,
    identity,
    snapshot: {
      name: snapshot.name,
      sha256: digest(bytes),
      bytes: bytes.length,
    },
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
  const temporary = join(offhost, `.${name}.partial`);
  await fs.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
  if (digest(await boundedRead(temporary)) !== digest(encrypted))
    throw new Error('Offhost readback checksum failed');
  await fs.link(temporary, join(offhost, name));
  await fs.unlink(temporary);
  await rotate(directory, 3);
  await rotate(offhost, 7);
  await store.request(
    `/collections/${store.collection}/snapshots/${encodeURIComponent(snapshot.name)}?wait=true`,
    'DELETE',
  );
  return {
    name,
    encryptedSha256: digest(encrypted),
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
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argumentsFor(rest);
  if (
    !['backup', 'restore'].includes(command) ||
    !args['target-label'] ||
    args.confirm !== `QDRANT_${args['target-label']}`
  )
    throw new Error('Explicit backup|restore target and confirmation required');
  const password = await boundedRead(args['encryption-key-file'], 4096);
  if (password.length < 32)
    throw new Error('Encryption key must contain at least 32 random bytes');
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
    const result = await (command === 'backup'
      ? backup(prisma, projection, store, args, password)
      : restore(projection, store, args, password));
    console.log(
      JSON.stringify({ command, target: args['target-label'], result }),
    );
  } finally {
    password.fill(0);
    await prisma.$disconnect();
  }
}
module.exports = { encrypt, decrypt, backup, restore, rotate };
if (require.main === module)
  main().catch(() => {
    console.error(
      'Qdrant backup/recovery failed; maintenance and retained artifacts must be inspected (details redacted)',
    );
    process.exitCode = 1;
  });
