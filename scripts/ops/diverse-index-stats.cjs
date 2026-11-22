#!/usr/bin/env node
'use strict';
/**
 * Index statistics for the diversity videos: what the pipeline stored per video.
 *
 *   node scripts/ops/diverse-index-stats.cjs [--host velora-homelab] [--out .benchmarks/diverse-index-stats.json]
 *
 * Joins .benchmarks/diverse-reel-map.json and the fixture manifest with row counts
 * from the reel-indexing Postgres (ReelChunk, ReelSection, ReelVisualScene) over ssh.
 * Read-only. Prints a table and a per-duration-band summary:
 *   - chunks and sections per hour of video (how finely the transcript is indexed)
 *   - visual scenes per video, and the gap between analysed frames (the 24-frame cap)
 *   - wall-clock indexing time vs video length
 */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const host = args.host || 'velora-homelab';
const MAP = '.benchmarks/diverse-reel-map.json';
const MANIFEST = 'test-data/reel-integration/diverse/manifest.json';
const FRAME_CAP = 24;
const REMOTE = 'export PATH=$PATH:/usr/local/bin:/opt/homebrew/bin; C=microservices-boilerplate-reel-indexing-postgres-1; U=$(docker exec $C printenv POSTGRES_USER)';

const map = JSON.parse(fs.readFileSync(MAP, 'utf8')).entries;
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const fixtures = new Map(manifest.fixtures.map((f) => [f.id, f]));

// One reel per fixture: the newest successful upload.
const picks = [];
for (const [fixtureId, entries] of Object.entries(map)) {
  const ok = entries.filter((e) => e.success).pop();
  if (ok && fixtures.has(fixtureId)) picks.push({ fixtureId, reelId: ok.reelId, processingMs: ok.processingMs });
}
if (!picks.length) throw new Error('no indexed fixtures in the reel map');
if (!picks.every((p) => /^[0-9a-f-]{36}$/.test(p.reelId))) throw new Error('unexpected reel id shape');

const values = picks.map((p) => `('${p.reelId}')`).join(',');
const sql = `with m(reel) as (values ${values}) select m.reel,
 (select count(*) from "ReelChunk" c where c."reelId"=m.reel) chunks,
 (select count(*) from "ReelSection" s where s."reelId"=m.reel) sections,
 (select count(*) from "ReelVisualScene" v where v."reelId"=m.reel) scenes
from m;`;
fs.writeFileSync('/tmp/diverse-stats.sql', sql);
execFileSync('scp', ['-q', '/tmp/diverse-stats.sql', `${host}:/tmp/diverse-stats.sql`]);
const out = execFileSync('ssh', [host, `${REMOTE}; docker cp /tmp/diverse-stats.sql $C:/tmp/diverse-stats.sql; docker exec $C psql -v ON_ERROR_STOP=1 -U "$U" -d reel_indexing -At -F '|' -f /tmp/diverse-stats.sql`], { encoding: 'utf8' });
const counts = new Map(out.trim().split('\n').filter(Boolean).map((l) => {
  const [reel, c, s, v] = l.split('|');
  return [reel, { chunks: +c, sections: +s, scenes: +v }];
}));

const rows = picks.map((p) => {
  const f = fixtures.get(p.fixtureId);
  const n = counts.get(p.reelId);
  if (!n) throw new Error(`no counts returned for reel ${p.reelId}`);
  const hours = f.durationSec / 3600;
  return {
    fixtureId: p.fixtureId, reelId: p.reelId, band: f.stratum.durationBand, genre: f.stratum.genre,
    language: f.stratum.language, durationSec: Math.round(f.durationSec), ...n,
    chunksPerHour: Math.round(n.chunks / hours), sectionsPerHour: Number((n.sections / hours).toFixed(1)),
    frameGapSec: Math.round(f.durationSec / FRAME_CAP), visualCoverage: Number((n.scenes / FRAME_CAP).toFixed(2)),
    indexMinutes: p.processingMs ? Number((p.processingMs / 60000).toFixed(1)) : null,
    realtimeRatio: p.processingMs ? Number((p.processingMs / 1000 / f.durationSec).toFixed(2)) : null,
  };
}).sort((a, b) => a.durationSec - b.durationSec);

const byBand = {};
for (const r of rows) (byBand[r.band] ||= []).push(r);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const summary = Object.fromEntries(Object.entries(byBand).map(([band, rs]) => [band, {
  videos: rs.length,
  chunksPerHour: Math.round(mean(rs.map((r) => r.chunksPerHour))),
  sectionsPerVideo: Number(mean(rs.map((r) => r.sections)).toFixed(1)),
  scenesPerVideo: Number(mean(rs.map((r) => r.scenes)).toFixed(1)),
  visualCoverage: Number(mean(rs.map((r) => r.visualCoverage)).toFixed(2)),
  frameGapSec: Math.round(mean(rs.map((r) => r.frameGapSec))),
  indexMinutes: Number(mean(rs.filter((r) => r.indexMinutes != null).map((r) => r.indexMinutes)).toFixed(1)),
  realtimeRatio: Number(mean(rs.filter((r) => r.realtimeRatio != null).map((r) => r.realtimeRatio)).toFixed(2)),
}]));

console.table(rows.map((r) => ({ id: r.fixtureId.replace('diverse-', ''), band: r.band, min: Math.round(r.durationSec / 60), chunks: r.chunks, sections: r.sections, scenes: r.scenes, 'frame gap s': r.frameGapSec, 'index min': r.indexMinutes, 'x realtime': r.realtimeRatio })));
console.log(JSON.stringify(summary, null, 2));
if (args.out) fs.writeFileSync(args.out, JSON.stringify({ rows, summary }, null, 2));
