'use strict';
/**
 * The bot recommends only PUBLIC reels, and benchmark reels are uploaded PRIVATE, so a photo
 * set scored against private reels can never pass. This flips just the reels the photo rows
 * point at, for the length of one run:
 *
 *   set -a; . ./.env.test.local; set +a
 *   node scripts/ops/set-photo-source-visibility.cjs public  [--dry-run]
 *   ... run scripts/ops/run-photo-live.cjs ...
 *   node scripts/ops/set-photo-source-visibility.cjs private
 *
 * Public reels show in the real feed, so keep the window short and always run `private` after.
 */
const fs = require('node:fs');
const { apiClient, resolveReelId } = require('./run-photo-live.cjs');

const CASES = 'eval/rag/datasets/rag-photo-v1.jsonl';
const MAP = '.benchmarks/diverse-reel-map.json';

/** Reel ids of the fixtures the photo rows expect to be recommended. */
function photoSourceReelIds(rows, map) {
  const ids = new Set();
  for (const row of rows) {
    const fixtureId = row.expect?.sourceFixtureId;
    const reelId = fixtureId ? resolveReelId(map, fixtureId) : null;
    if (reelId) ids.add(reelId);
  }
  return [...ids];
}

async function main() {
  const visibility = process.argv[2];
  if (!['public', 'private'].includes(visibility)) throw new Error('usage: set-photo-source-visibility.cjs public|private [--dry-run]');
  const rows = fs.readFileSync(CASES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ids = photoSourceReelIds(rows, JSON.parse(fs.readFileSync(MAP, 'utf8')));
  if (process.argv.includes('--dry-run')) return console.log(`${ids.length} reels would become ${visibility}`);
  const creds = { email: process.env.VELORA_TEST_EMAIL, password: process.env.VELORA_TEST_PASSWORD };
  const request = apiClient(process.env.BACKEND_URL, creds);
  await request('POST', '/auth/login', creds);
  let changed = 0;
  for (const id of ids) {
    try {
      const reel = await request('PATCH', `/content/reels/${id}`, { visibility });
      console.log(`${id.slice(0, 8)} -> ${reel?.visibility ?? '?'}`);
      changed += 1;
    } catch (e) {
      console.log(`${id.slice(0, 8)} FAILED ${e.message}`);
    }
  }
  console.log(`${changed}/${ids.length} set to ${visibility}`);
  if (changed !== ids.length) process.exitCode = 1;
}

module.exports = { photoSourceReelIds };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
