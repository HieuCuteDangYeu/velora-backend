#!/usr/bin/env node
/* Read-only scoped search smoke through the real repository (SQL scope capture + Qdrant
 * exact search + RRF). Query vectors are existing chunk vectors, so each query must return
 * its own chunk at rank 1. Prints timings and booleans only, never text or vectors.
 * Same operator environment as reel-qdrant.cjs, plus AI_EMBEDDING_* and INDEX_VECTOR_*. */
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
const {
  PrismaSemanticIndexRepository,
} = require('../../apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository');
const { argumentsFor } = require('./reel-qdrant.cjs');

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const queries = Number(args.queries || 12);
  const scopeSize = Number(args['scope-reels'] || 6);
  if (!Number.isInteger(queries) || queries < 1 || queries > 200)
    throw new Error('Invalid --queries');
  if (!Number.isInteger(scopeSize) || scopeSize < 1 || scopeSize > 50)
    throw new Error('Invalid --scope-reels');
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.REEL_INDEXING_DATABASE_URL } },
  });
  const config = new ConfigService();
  const store = new QdrantReelVectorStoreAdapter(config);
  const projections = new PrismaVectorProjectionRepository(
    prisma,
    config,
    store,
  );
  const repository = new PrismaSemanticIndexRepository(
    prisma,
    config,
    projections,
    store,
  );
  try {
    // Sample chunk points across the collection (every k-th of one scroll pass).
    const sampled = [];
    let offset;
    do {
      const page = await store.request(
        `/collections/${store.collection}/points/scroll`,
        'POST',
        {
          limit: 256,
          ...(offset === undefined ? {} : { offset }),
          filter: { must: [{ key: 'kind', match: { value: 'CHUNK' } }] },
          with_payload: ['reelId'],
          with_vector: false,
        },
      );
      sampled.push(...page.points.map((p) => ({ id: p.id, reelId: p.payload.reelId })));
      offset = page.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);
    const reels = [...new Set(sampled.map((p) => p.reelId))];
    const stride = Math.max(1, Math.floor(sampled.length / queries));
    const picks = sampled.filter((_, i) => i % stride === 0).slice(0, queries);
    const results = [];
    for (const pick of picks) {
      const [point] = await store.retrieve([pick.id]);
      const rest = reels.filter((r) => r !== pick.reelId);
      const shift = picks.indexOf(pick) % Math.max(1, rest.length);
      const others = [...rest.slice(shift), ...rest.slice(0, shift)].slice(
        0,
        scopeSize - 1,
      );
      const scope = [pick.reelId, ...others];
      const started = Date.now();
      let ok = false;
      let error;
      let hits = 0;
      try {
        const found = await repository.searchChunks({
          queryEmbedding: point.vector,
          queryEmbeddingModel: point.payload.embeddingModel,
          queryEmbeddingVersion: point.payload.embeddingVersion,
          filters: { reelIds: scope },
          limit: 5,
        });
        hits = found.length;
        ok = found[0]?.id === point.payload.stableId;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : 'unknown';
      }
      results.push({ ms: Date.now() - started, ok, hits, scopeReels: scope.length, error });
    }
    const times = results.map((r) => r.ms).sort((a, b) => a - b);
    process.stdout.write(
      `${JSON.stringify({
        command: 'search-smoke',
        collectionPoints: sampled.length,
        queries: results.length,
        topHitIsOwnChunk: results.filter((r) => r.ok).length,
        failed: results.filter((r) => r.error).length,
        errors: [...new Set(results.map((r) => r.error).filter(Boolean))],
        ms: {
          min: times[0] ?? null,
          p50: percentile(times, 0.5),
          p95: percentile(times, 0.95),
          max: times[times.length - 1] ?? null,
          mean: times.length
            ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
            : null,
        },
      })}\n`,
    );
    if (results.some((r) => !r.ok)) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: 'Search smoke failed',
      detail: error instanceof Error ? error.message.replace(/\S+:\/\/\S+/g, '[url]') : 'unknown',
    }),
  );
  process.exitCode = 1;
});
