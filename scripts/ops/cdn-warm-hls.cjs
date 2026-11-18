#!/usr/bin/env node
'use strict';

/**
 * Warms Cloudflare's cache for the HLS files of every playable reel: the master playlist, the
 * variant playlists and the first segment of each variant. A reel nobody has watched recently is
 * not cached, and those three objects then cost 0.5-0.8 s each, one after the other, before the
 * first frame (hits take about 55 ms). The files are immutable, so one GET per object keeps it
 * warm; new reels are warmed by content-service itself right after their encode.
 *
 * Run it from the homelab (same Cloudflare location as the viewers, SIN) after a purge, a CDN
 * change, or on a schedule if objects turn out to be evicted. Segments are fetched with
 * Range: bytes=0-0: the CDN still caches the whole object, only one byte comes back.
 *
 *   VELORA_TEST_EMAIL=... VELORA_TEST_PASSWORD=... \
 *   node scripts/ops/cdn-warm-hls.cjs --base-url https://velora-app.me [--concurrency 8] [--max-reels 500]
 *
 * It logs in once (/auth/login allows 5 per window), lists reels read-only and prints the cache
 * status counts before warming, so the first run doubles as a measurement of how cold the catalog is.
 */

function firstUris(playlist, limit = Infinity) {
  return playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .slice(0, limit);
}

function initUri(playlist) {
  return /#EXT-X-MAP:[^\n]*URI="([^"]+)"/.exec(playlist)?.[1] ?? null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const [key, inline] = argv[i].slice(2).split('=');
    out[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true');
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = String(args['base-url'] || process.env.BASE_URL || 'https://velora-app.me').replace(/\/$/, '');
  const concurrency = Math.max(1, Number(args.concurrency || 8));
  const maxReels = Math.max(1, Number(args['max-reels'] || 1000));
  const email = process.env.VELORA_TEST_EMAIL;
  const password = process.env.VELORA_TEST_PASSWORD;
  if (!email || !password) throw new Error('Set VELORA_TEST_EMAIL and VELORA_TEST_PASSWORD');

  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';', 1)[0]).join('; ');
  const body = await login.json().catch(() => ({}));
  const headers = body.accessToken ? { Authorization: `Bearer ${body.accessToken}` } : { Cookie: cookie };

  const reels = [];
  let cursor = null;
  while (reels.length < maxReels) {
    const url = `${base}/content/reels?limit=50&ranked=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await (await fetch(url, { headers })).json();
    reels.push(...(page.items ?? []));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  const masters = [...new Set(reels.map((reel) => reel.streamUrl).filter(Boolean))].slice(0, maxReels);
  console.log(`reels with a stream: ${masters.length}`);

  const stats = { master: {}, variant: {}, segment: {} };
  const times = { master: [], variant: [], segment: [] };
  const get = async (url, kind, range) => {
    const started = Date.now();
    const response = await fetch(url, range ? { headers: { Range: 'bytes=0-0' } } : undefined);
    const text = range ? (await response.arrayBuffer(), '') : await response.text();
    const status = response.headers.get('cf-cache-status') ?? 'none';
    stats[kind][status] = (stats[kind][status] ?? 0) + 1;
    times[kind].push([status, Date.now() - started]);
    return text;
  };

  let next = 0;
  let failures = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < masters.length) {
        const masterUrl = masters[next++];
        try {
          const master = await get(masterUrl, 'master');
          for (const variant of firstUris(master, 6)) {
            const variantUrl = new URL(variant, masterUrl).toString();
            const playlist = await get(variantUrl, 'variant');
            const init = initUri(playlist);
            if (init) await get(new URL(init, variantUrl).toString(), 'segment', true);
            const [segment] = firstUris(playlist, 1);
            if (segment) await get(new URL(segment, variantUrl).toString(), 'segment', true);
          }
        } catch {
          failures += 1;
        }
      }
    }),
  );

  for (const kind of ['master', 'variant', 'segment']) {
    const hit = times[kind].filter(([status]) => status === 'HIT').map(([, ms]) => ms);
    const other = times[kind].filter(([status]) => status !== 'HIT').map(([, ms]) => ms);
    console.log(
      `${kind.padEnd(8)} ${JSON.stringify(stats[kind])} | hit p50 ${percentile(hit, 0.5)} ms | not cached before: n=${other.length} p50 ${percentile(other, 0.5)} p95 ${percentile(other, 0.95)} ms`,
    );
  }
  if (failures) console.log(`reels that failed to warm: ${failures}`);
  process.exitCode = failures ? 1 : 0;
}

module.exports = { firstUris, initUri, percentile, parseArgs };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fatal] ${error.message}`);
    process.exitCode = 2;
  });
}
