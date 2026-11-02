#!/usr/bin/env node
'use strict';

require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { createHash, randomUUID } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { PrismaClient, Prisma } = require('@prisma/reel-indexing-client');
const {
  R2ArtifactStorageAdapter,
} = require('../../apps/reel-indexing-service/src/infrastructure/adapters/r2-artifact-storage.adapter');

const BATCH = 32;

async function main(argv = process.argv.slice(2)) {
  const options = Object.fromEntries(
    argv.map((arg) => {
      const match = /^--([a-z-]+)=(.+)$/.exec(arg);
      if (!match) throw new Error('Use --name=value arguments');
      return [match[1], match[2]];
    }),
  );
  if (
    !options['target-label'] ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(options['target-label']) ||
    options.confirm !== `EMBEDDING_CACHE_${options['target-label']}`
  )
    throw new Error(
      'Explicit target and embedding-cache confirmation required',
    );
  const databaseUrl = process.env.REEL_INDEXING_DATABASE_URL;
  if (!databaseUrl)
    throw new Error('Explicit Reel Indexing database target required');

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const artifacts = new R2ArtifactStorageAdapter(
    new ConfigService(process.env),
  );
  let cursor;
  let migrated = 0;
  try {
    for (;;) {
      const rows = await prisma.embeddingCacheEntry.findMany({
        where: {
          embedding: { not: Prisma.DbNull },
          ...(cursor ? { cacheKey: { gt: cursor } } : {}),
        },
        orderBy: { cacheKey: 'asc' },
        take: BATCH,
      });
      if (!rows.length) break;
      const entries = rows.map((row) => ({
        cacheKey: row.cacheKey,
        embedding: row.embedding,
      }));
      if (
        entries.some(
          (entry) =>
            !Array.isArray(entry.embedding) ||
            entry.embedding.length !== 1024 ||
            entry.embedding.some(
              (value) => typeof value !== 'number' || !Number.isFinite(value),
            ),
        )
      )
        throw new Error('Embedding cache contains an invalid vector');
      const bytes = Buffer.from(JSON.stringify(entries));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const storageKey = `reel-indexing/embedding-cache/${randomUUID()}/${sha256}.json`;
      await artifacts.putVerifiedArtifact({ key: storageKey, bytes, sha256 });
      await prisma.$transaction(
        rows.map((row, offset) =>
          prisma.embeddingCacheEntry.updateMany({
            where: {
              cacheKey: row.cacheKey,
              embedding: { not: Prisma.DbNull },
            },
            data: {
              embedding: Prisma.DbNull,
              storageKey,
              sha256,
              offset,
            },
          }),
        ),
      );
      migrated += rows.length;
      cursor = rows.at(-1).cacheKey;
    }
    const remaining = await prisma.embeddingCacheEntry.count({
      where: { embedding: { not: Prisma.DbNull } },
    });
    process.stdout.write(
      `${JSON.stringify({ target: options['target-label'], migrated, remaining })}\n`,
    );
    if (remaining) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
