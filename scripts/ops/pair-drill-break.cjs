#!/usr/bin/env node
/* Negative test for the restore drill: deletes a few points from a DISPOSABLE Qdrant so the
 * stale-ready and parity detectors can be seen firing. Refuses to run unless the drill
 * environment sets PAIR_DRILL_DISPOSABLE=yes (pair-restore-drill.sh does; production never). */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { ConfigService } = require('@nestjs/config');
const {
  QdrantReelVectorStoreAdapter,
} = require('../../apps/reel-indexing-service/src/infrastructure/adapters/qdrant-reel-vector-store.adapter');

async function main() {
  if (process.env.PAIR_DRILL_DISPOSABLE !== 'yes')
    throw new Error('Refusing: not a disposable drill environment');
  const store = new QdrantReelVectorStoreAdapter(new ConfigService());
  const count = (await store.request(
    `/collections/${store.collection}/points/count`,
    'POST',
    { exact: true },
  )).count;
  const page = await store.request(
    `/collections/${store.collection}/points/scroll`,
    'POST',
    {
      limit: 5,
      filter: { must: [{ key: 'kind', match: { value: 'CHUNK' } }] },
      with_payload: false,
      with_vector: false,
    },
  );
  const ids = page.points.map((point) => point.id);
  await store.request(
    `/collections/${store.collection}/points/delete?wait=true`,
    'POST',
    { points: ids },
  );
  const after = (await store.request(
    `/collections/${store.collection}/points/count`,
    'POST',
    { exact: true },
  )).count;
  console.log(JSON.stringify({ removed: ids.length, before: count, after }));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'failed');
  process.exitCode = 1;
});
