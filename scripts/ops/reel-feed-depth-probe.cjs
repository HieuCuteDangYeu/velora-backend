#!/usr/bin/env node
'use strict';
// Read-only probe of GET /content/reels/recommended paging depth. Opens --sessions feed sessions
// at once, pages each to --pages with --think-ms between pages (a viewer takes 20-60 s per page of
// 6; the default 4 s is a stress test) and reports per page: latency p50/p95, empty pages and the
// first page at which each session hit one. It logs in ONCE: /auth/login allows 5 per window, so
// do not run several probes back to back.
//
//   VELORA_TEST_EMAIL=... VELORA_TEST_PASSWORD=... BASE=https://velora-app.me \
//     node scripts/ops/reel-feed-depth-probe.cjs --sessions 12 --pages 7 --think-ms 4000 --limit 6
//
// Pairs with reel-latency-load.cjs; the refill timings it provokes are logged by content-service
// as 'Refill <session>: snapshot ..., gate wait ..., pipeline ...'.
const base = process.env.BASE || 'https://velora-app.me';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const C = arg('sessions', 12), PAGES = arg('pages', 7), THINK = arg('think-ms', 4000), LIMIT = arg('limit', 6);
async function login() {
  const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.VELORA_TEST_EMAIL, password: process.env.VELORA_TEST_PASSWORD }) });
  const jar = (r.headers.getSetCookie?.() || []).map((c) => c.split(';', 1)[0]).join('; ');
  const body = await r.json().catch(() => ({}));
  return { cookie: jar, token: body.accessToken || body.access_token || body.token };
}
const q = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(0.5 * (s.length - 1))] + '/' + s[Math.floor(0.95 * (s.length - 1))] : '-'; };
(async () => {
  const auth = await login();
  const headers = auth.token ? { Authorization: 'Bearer ' + auth.token } : { Cookie: auth.cookie };
  const perPage = Array.from({ length: PAGES }, () => ({ ms: [], empty: 0, short: 0, err: 0, n: 0 }));
  const walls = [];
  await Promise.all(Array.from({ length: C }, async (_, s) => {
    let cursor = null, sid = null, seen = new Set();
    for (let p = 0; p < PAGES; p += 1) {
      const qs = new URLSearchParams({ limit: String(LIMIT) });
      if (cursor) qs.set('cursor', cursor);
      if (sid) qs.set('feedSessionId', sid);
      const t = Date.now();
      let r, body = {};
      try { r = await fetch(base + '/content/reels/recommended?' + qs, { headers }); body = await r.json().catch(() => ({})); } catch { r = { status: 0 }; }
      const ms = Date.now() - t, st = perPage[p];
      st.n += 1; st.ms.push(ms);
      const items = body.items || [];
      if (r.status !== 200) st.err += 1;
      else if (items.length === 0) { st.empty += 1; if (!walls[s]) walls[s] = p + 1; }
      else if (items.length < LIMIT) st.short += 1;
      items.forEach((i) => seen.add(i.id));
      sid = body.feedSessionId || sid;
      if (body.nextCursor) cursor = body.nextCursor; else if (r.status === 200 && items.length === 0) { /* keep cursor to retry */ }
      await new Promise((res) => setTimeout(res, THINK));
    }
  }));
  console.log(`sessions=${C} think=${THINK}ms limit=${LIMIT}`);
  perPage.forEach((st, i) => console.log(`page ${i + 1}: n=${st.n} p50/p95 ms=${q(st.ms)} empty=${st.empty} short=${st.short} errors=${st.err}`));
  console.log('sessions that hit an empty page:', walls.filter(Boolean).length, 'first-empty pages:', JSON.stringify(walls.filter(Boolean)));
})();
