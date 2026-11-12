'use strict';
/**
 * Read-only snapshot of the ACTIVE transcript chunks in the live reel index,
 * the input of `build-semantic-live-cases.cjs` and of its `--check-stale` mode.
 *
 * It needs the indexing Prisma client, so run it inside the reel-indexing
 * service container and write the result to a restricted local path (the file
 * contains transcript text; never commit it):
 *
 *   docker cp scripts/ops/export-semantic-live-items.cjs <reel-indexing>:/usr/src/app/
 *   docker exec <reel-indexing> node export-semantic-live-items.cjs > .benchmarks/semantic-live-items.json
 *   docker exec -u root <reel-indexing> rm /usr/src/app/export-semantic-live-items.cjs
 *
 * Output: { exportedAt, items: [{ id, reelId, title, text, tags, startTime,
 * endTime, indexVersion, firstIndexedAt }] }. `text` is the raw evidence text,
 * not the embedded retrieval text (which prepends title and tags).
 */
const { PrismaClient } = require('@prisma/reel-indexing-client');

(async () => {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT c."id", c."reelId", d."title", c."evidenceText" AS "text", c."tags",
        c."startTime", c."endTime", c."indexVersion", d."createdAt" AS "firstIndexedAt"
      FROM "ReelChunk" c
      JOIN "ReelDocument" d ON d."reelId" = c."reelId" AND d."isActive" = true
      WHERE c."isActive" = true AND c."evidenceText" IS NOT NULL
      ORDER BY c."reelId", c."ordinal"`);
    const items = rows.map((r) => ({
      ...r,
      firstIndexedAt: new Date(r.firstIndexedAt).toISOString(),
    }));
    process.stdout.write(
      JSON.stringify({ exportedAt: new Date().toISOString(), items }) + '\n',
    );
  } finally {
    await prisma.$disconnect();
  }
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
