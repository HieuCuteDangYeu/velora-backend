'use strict';
/**
 * Delete the stale and duplicate reels the diverse benchmark left in the production index.
 *
 *   set -a; . ./.env.test.local; set +a
 *   node scripts/ops/cleanup-diverse-reels.cjs            # dry run: lists targets and their live status
 *   node scripts/ops/cleanup-diverse-reels.cjs --apply    # DELETE /content/reels/:id for each, then rewrite the map
 *
 * Target = every map entry that is not the reel the benchmark resolves for its fixture (newest successful
 * upload): failed or never-indexed uploads, and older duplicates. The resolved reel is never touched.
 * The API delete removes the reel and its HLS files. The index rows need `index.delete_reel` on queue
 * `reel_index_query` afterwards (inside the reel-indexing container); the ids to send are printed.
 * Removed entries move to `map.deleted` so the history is kept and `resolveReelId` cannot pick them.
 */
const fs = require('node:fs');
const path = require('node:path');
const { apiClient } = require('./run-photo-live.cjs');

const MAP = '.benchmarks/diverse-reel-map.json';

/** Same rule as eval/rag/diverse-live-eval.cjs resolveReelId: newest successful entry. */
function keptEntry(entries) {
  const done = (entries ?? []).filter((e) => e.success);
  return done.length ? done[done.length - 1] : null;
}

/** [{ fixtureId, reelId, success, runId }] for every entry that should be deleted. */
function staleEntries(map) {
  const out = [];
  for (const [fixtureId, entries] of Object.entries(map.entries ?? {})) {
    const keep = keptEntry(entries);
    for (const e of entries) {
      if (keep && e.reelId === keep.reelId) continue;
      out.push({ fixtureId, reelId: e.reelId, success: Boolean(e.success), runId: e.runId });
    }
  }
  return out;
}

/** Map with the deleted reels moved from `entries` to `deleted`. */
function withoutDeleted(map, removedIds, when = new Date().toISOString()) {
  const gone = new Set(removedIds);
  const entries = {};
  const deleted = [...(map.deleted ?? [])];
  for (const [fixtureId, list] of Object.entries(map.entries ?? {})) {
    const kept = list.filter((e) => !gone.has(e.reelId));
    for (const e of list) if (gone.has(e.reelId)) deleted.push({ fixtureId, ...e, deletedAt: when });
    if (kept.length) entries[fixtureId] = kept; else entries[fixtureId] = [];
  }
  return { ...map, entries, deleted };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  const targets = staleEntries(map);
  const creds = { email: process.env.VELORA_TEST_EMAIL, password: process.env.VELORA_TEST_PASSWORD };
  if (!process.env.BACKEND_URL || !creds.email || !creds.password) throw new Error('Set BACKEND_URL, VELORA_TEST_EMAIL, VELORA_TEST_PASSWORD');
  const request = apiClient(process.env.BACKEND_URL, creds);
  await request('POST', '/auth/login', creds);

  const removed = [];
  for (const t of targets) {
    let st = null;
    try { st = await request('GET', `/content/reels/${t.reelId}/status`); } catch (e) { st = { error: e.message }; }
    const label = `${t.fixtureId} ${t.reelId.slice(0, 8)} ${t.success ? 'duplicate' : 'failed'} media=${st?.mediaStatus} index=${st?.indexStatus} ${st?.error || ''}`;
    if (!apply) { console.log(`[dry] ${label}`); continue; }
    try {
      await request('DELETE', `/content/reels/${t.reelId}`);
      removed.push(t.reelId);
      console.log(`[deleted] ${label}`);
    } catch (e) {
      // A reel that is already gone is a success for cleanup purposes.
      if (/\(404\)/.test(e.message)) { removed.push(t.reelId); console.log(`[gone] ${label}`); } else console.log(`[FAILED ${e.message}] ${label}`);
    }
  }
  if (apply) {
    const next = withoutDeleted(map, removed);
    const tmp = path.resolve(`${MAP}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, path.resolve(MAP));
    console.log(`index.delete_reel ids: ${removed.join(' ')}`);
  }
  console.log(`${targets.length} target(s), ${apply ? removed.length + ' removed' : 'dry run, nothing deleted'}`);
}

module.exports = { keptEntry, staleEntries, withoutDeleted };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
