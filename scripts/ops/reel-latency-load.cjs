#!/usr/bin/env node
'use strict';

/**
 * Reel read-path latency load test.
 *
 * Covers what a viewer waits on while watching reels:
 *   feed     GET /content/reels/recommended (cold open and in-session paging),
 *            GET /content/reels (ranked public feed), GET /content/reels/friends
 *   detail   GET /content/reels/:id
 *   series   GET /content/series/:id/episodes, GET /content/series/:id
 *   search   GET /search, /search/tags/reels
 *   stream   HLS startup against the CDN: master -> variant -> first segment
 *   startup  recommended page + HLS startup chain, the "time to first frame" proxy
 *   (--feed-limit sets the page size, default 6 like the mobile app)
 *   rag      optional: Socket.IO bot chat, time to first bot_token and final reply
 *
 * Read-only by default: it never posts view events, so recommendation signals and
 * view counts are not polluted. RAG is opt-in because every turn spends the shared
 * AI budget (ai_turn_minute 10, ai_turn_day 300 per user) and the model host.
 *
 * Limits (p95), calibrated on 2026-11-18 after the databases moved (auth and content on the
 * homelab Postgres, about 2 ms away; user, friend and AI on Aiven Singapore, about 35 ms away;
 * before, everything was on Aiven Bangalore, about 70 ms away):
 *   350 ms (--slo-api-p95)        API calls on the swipe path: feeds, reel detail, tags, friends.
 *                                 Measured steady-state p95 at 1/3/6 viewers: 105-210 ms.
 *   500 ms (--slo-secondary-p95)  screens opened on purpose that pay a cold friend-access check or
 *                                 read a whole series: reel context, series detail, series episodes.
 *                                 Measured: 130-245 ms.
 * A p95 over fewer than --min-samples (default 30) requests is shown as SKIP, not FAIL; error rates
 * are always checked. The first request of a cold run can be far slower (one cold reel-context call took 1.3 s) and
 * the first HLS touches miss the CDN edge (stream_startup p95 1.5-1.7 s at 1-3 viewers, 0.26 s at 6),
 * so judge a run by its larger stages. A p95 over fewer than about 20 samples is one request: use
 * --stage-seconds 90 --think-ms 100 for 30-600 samples per scenario, and check the homelab load
 * (uptime) is under 2 first, because another stress test shows up as 1-40 s tails.
 *
 * Usage:
 *   VELORA_TEST_EMAIL=... VELORA_TEST_PASSWORD=... \
 *   node scripts/ops/reel-latency-load.cjs --base-url https://velora-app.me \
 *     --stages 1,5,10 --stage-seconds 20
 */

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

// ---------- pure helpers (exported for tests) ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw || raw === '--' || !raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const next = argv[i + 1];
    if (inline === undefined && next && !next.startsWith('--')) {
      args[name] = next;
      i += 1;
    } else {
      args[name] = inline ?? 'true';
    }
  }
  return args;
}

function intArg(value, fallback, name, min, max) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(samples) {
  const ok = samples.filter((s) => s.ok);
  const latencies = ok.map((s) => s.ms);
  const statuses = {};
  for (const s of samples) {
    if (!s.ok) statuses[s.status ?? s.error ?? 'error'] = (statuses[s.status ?? s.error ?? 'error'] || 0) + 1;
  }
  const round = (n) => (n === null ? null : Math.round(n * 10) / 10);
  return {
    count: samples.length,
    ok: ok.length,
    errorRate: samples.length ? (samples.length - ok.length) / samples.length : 0,
    errors: statuses,
    p50: round(percentile(latencies, 0.5)),
    p90: round(percentile(latencies, 0.9)),
    p95: round(percentile(latencies, 0.95)),
    p99: round(percentile(latencies, 0.99)),
    max: round(latencies.length ? latencies.reduce((m, v) => (v > m ? v : m), -Infinity) : null),
    kbMedian: round(percentile(ok.map((s) => (s.bytes || 0) / 1024), 0.5)),
    mean: round(latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null),
  };
}

/** Pick the first variant a player would start with (listed order) from a master playlist. */
function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
    const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(attrs)?.[1] ?? 0) || null;
    const resolution = /RESOLUTION=(\d+x\d+)/.exec(attrs)?.[1] ?? null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith('#')) continue;
      variants.push({ url: new URL(candidate, baseUrl).toString(), bandwidth, resolution });
      break;
    }
  }
  return variants;
}

/** First init map and first media segment of a media playlist. */
function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let init = null;
  let segment = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!init && line.startsWith('#EXT-X-MAP:')) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri) init = new URL(uri, baseUrl).toString();
    }
    if (line && !line.startsWith('#')) {
      segment = new URL(line, baseUrl).toString();
      break;
    }
  }
  return { init, segment };
}

// Opened on purpose (profile reel, series screen) and cold on the first request, not part of
// the swipe loop: they get the looser secondary limit.
const SECONDARY_API_SCENARIOS = ['api_reel_context', 'api_series_detail', 'api_series_episodes'];

// A p95 over fewer than `slos.minSamples` requests is one or two requests, so such a check is
// reported as skipped (it passes the run) instead of failing it on noise. Error rates still count.
function evaluateSlos(report, slos) {
  const checks = [];
  const minSamples = slos.minSamples ?? 0;
  const add = (name, actual, limit, samples) => {
    if (limit === undefined || limit === null) return;
    if (samples !== undefined && samples < minSamples) {
      checks.push({ name, actual, limit, pass: true, skipped: true, samples });
      return;
    }
    checks.push({ name, actual, limit, pass: actual !== null && actual <= limit });
  };
  for (const [stage, rows] of Object.entries(report.stages)) {
    for (const [scenario, stats] of Object.entries(rows)) {
      const limit = slos[scenario]
        ?? (SECONDARY_API_SCENARIOS.includes(scenario) && slos.secondary !== undefined ? slos.secondary : undefined)
        ?? (scenario.startsWith('api_') ? slos.api : undefined);
      add(`${stage}/${scenario} p95`, stats.p95, limit, stats.count);
      if (stats.count) add(`${stage}/${scenario} errorRate`, stats.errorRate, slos.errorRate);
    }
  }
  return checks;
}

// ---------- runtime ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const originOf = (value) => new URL(String(value)).origin;

class Auth {
  constructor(baseUrl, session = null) {
    this.baseUrl = baseUrl;
    this.session = session; // { accessToken, refreshToken } minted by mint-viewer-tokens.cjs
    this.fixedToken = session ? null : process.env.VELORA_TEST_ACCESS_TOKEN?.trim() || null;
    this.token = session ? session.accessToken : this.fixedToken;
    this.cookie = null;
    this.inflight = null;
    this.logins = 0;
  }

  headers() {
    if (this.token) return { Authorization: `Bearer ${this.token}` };
    return this.cookie ? { Cookie: this.cookie } : {};
  }

  /** Single-flight login. auth_login_ip is 10/min, so concurrent 401s must share one login. */
  async login(staleToken) {
    if (this.fixedToken) throw new Error('VELORA_TEST_ACCESS_TOKEN expired; supply a fresh token');
    if (this.inflight) return this.inflight;
    if (this.token && this.token !== staleToken) return undefined;
    this.inflight = (async () => {
      if (this.session) {
        // A per-viewer session renews through its own refresh token; it never uses the shared login.
        const response = await fetch(new URL('/auth/mobile/refresh', this.baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.session.refreshToken }),
        });
        if (!response.ok) throw new Error(`viewer refresh failed: ${response.status}`);
        const tokens = await response.json();
        this.token = tokens.accessToken;
        if (tokens.refreshToken) this.session.refreshToken = tokens.refreshToken;
        this.logins += 1;
        return;
      }
      const email = process.env.VELORA_TEST_EMAIL?.trim();
      const password = process.env.VELORA_TEST_PASSWORD;
      if (!email || !password) throw new Error('Set VELORA_TEST_EMAIL and VELORA_TEST_PASSWORD (or VELORA_TEST_ACCESS_TOKEN)');
      const response = await fetch(new URL('/auth/login', this.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) throw new Error(`login failed: ${response.status}`);
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      const jar = setCookies.map((c) => c.split(';', 1)[0]).filter(Boolean);
      const access = jar.find((c) => c.startsWith('access_token='));
      this.cookie = jar.join('; ');
      this.token = access ? decodeURIComponent(access.slice('access_token='.length)) : null;
      this.logins += 1;
      await response.arrayBuffer();
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

/** One timed request. Returns a sample; never throws. */
async function timed(auth, baseUrl, name, route, init = {}, { parse = 'json', retryAuth = true } = {}) {
  const started = performance.now();
  const at = Date.now();
  try {
    const url = new URL(route, baseUrl);
    const send = () => fetch(url, { ...init, headers: { ...(init.headers || {}), ...auth.headers() } });
    const stale = auth.token;
    let response = await send();
    if (response.status === 401 && retryAuth) {
      await response.arrayBuffer();
      await auth.login(stale);
      response = await send();
    }
    const ttfbMs = performance.now() - started;
    const buffer = Buffer.from(await response.arrayBuffer());
    const ms = performance.now() - started;
    let body = null;
    if (response.ok && parse === 'json') {
      try { body = JSON.parse(buffer.toString('utf8')); } catch { body = null; }
    }
    return { name, ok: response.ok, status: response.status, ms, ttfbMs, bytes: buffer.length, body, at, ray: response.headers.get('cf-ray') };
  } catch (error) {
    return { name, ok: false, status: null, error: error?.cause?.code || error?.name || 'fetch_error', ms: performance.now() - started, ttfbMs: null, bytes: 0, body: null, at };
  }
}

/** Unauthenticated CDN fetch with TTFB, total time and cache header. */
async function cdnFetch(name, url, { text = false } = {}) {
  const started = performance.now();
  const at = Date.now();
  try {
    const response = await fetch(url);
    const ttfbMs = performance.now() - started;
    const buffer = Buffer.from(await response.arrayBuffer());
    const ms = performance.now() - started;
    return {
      name,
      ok: response.ok,
      status: response.status,
      ms,
      ttfbMs,
      bytes: buffer.length,
      at,
      ray: response.headers.get('cf-ray'),
      cache: response.headers.get('cf-cache-status') || response.headers.get('x-cache') || 'none',
      text: text && response.ok ? buffer.toString('utf8') : null,
    };
  } catch (error) {
    return { name, ok: false, status: null, error: error?.cause?.code || error?.name || 'fetch_error', ms: performance.now() - started, ttfbMs: null, bytes: 0, cache: 'none', text: null, at };
  }
}

/** HLS startup: master -> first variant -> init + first segment. Returns samples plus the total. */
async function hlsStartup(streamUrl) {
  const samples = [];
  const master = await cdnFetch('hls_master', streamUrl, { text: true });
  samples.push(master);
  if (!master.ok) return { samples, totalMs: null, ok: false };

  const variants = parseMasterPlaylist(master.text, streamUrl);
  if (!variants.length) {
    // Some replacement reels publish a media playlist directly.
    const direct = parseMediaPlaylist(master.text, streamUrl);
    if (!direct.segment) return { samples, totalMs: null, ok: false };
    const seg = await cdnFetch('hls_segment', direct.segment);
    samples.push(seg);
    return { samples, totalMs: master.ms + seg.ms, ok: seg.ok };
  }

  const variant = await cdnFetch('hls_variant', variants[0].url, { text: true });
  samples.push(variant);
  if (!variant.ok) return { samples, totalMs: null, ok: false };

  const { init, segment } = parseMediaPlaylist(variant.text, variants[0].url);
  if (!segment) return { samples, totalMs: null, ok: false };

  const [initSample, segSample] = await Promise.all([
    init ? cdnFetch('hls_init', init) : Promise.resolve(null),
    cdnFetch('hls_segment', segment),
  ]);
  if (initSample) samples.push(initSample);
  samples.push(segSample);
  const ok = segSample.ok && (!initSample || initSample.ok);
  const fetchTail = Math.max(segSample.ms, initSample ? initSample.ms : 0);
  return { samples, totalMs: ok ? master.ms + variant.ms + fetchTail : null, ok, variant: variants[0] };
}

async function discover(auth, baseUrl, seeds, { includeAi }) {
  const feed = includeAi
    ? await timed(auth, baseUrl, 'discover', '/content/reels/recommended?limit=50')
    : { status: 'skipped', body: null };
  const ranked = await timed(auth, baseUrl, 'discover', '/content/reels?limit=50&ranked=true');
  const items = [...(feed.body?.items || []), ...(ranked.body?.items || [])];
  const seen = new Set();
  const reels = items.filter((r) => r?.id && !seen.has(r.id) && seen.add(r.id));
  const playable = reels.filter((r) => r.streamUrl);
  const seriesIds = [...new Set(reels.map((r) => r.series?.id).filter(Boolean))];
  const tags = [...new Set(reels.flatMap((r) => r.tags || []))].slice(0, 20);
  if (!reels.length) throw new Error(`discovery found no reels (recommended ${feed.status}, ranked ${ranked.status})`);
  return { reels, playable, seriesIds, tags, queries: seeds.queries };
}

function pick(list, rand) {
  return list[Math.floor(rand() * list.length)];
}

function buildScenarios(ctx, enabled, rand) {
  const feedOpen = async (rec, auth) => {
    const s = await timed(auth, ctx.baseUrl, 'api_feed_cold', `/content/reels/recommended?limit=${ctx.feedLimit}`);
    rec(s);
    return s;
  };

  const firstFrame = async (rec, auth, name, route) => {
    const feed = await timed(auth, ctx.baseUrl, `${name}_feed`, route);
    rec(feed);
    const fail = (error, status) => rec({ name, ok: false, status, error, ms: 0, ttfbMs: null, bytes: 0 });
    if (!feed.ok) return fail('feed_failed', feed.status);
    const target = (feed.body?.items || []).find((r) => r.streamUrl);
    if (!target) return fail('no_playable_item', 200);
    const hls = await hlsStartup(target.streamUrl);
    for (const sample of hls.samples) rec(sample);
    if (hls.totalMs === null) return fail('hls_chain_failed', null);
    rec({ name, ok: true, status: 200, ms: feed.ms + hls.totalMs, ttfbMs: null, bytes: 0 });
  };

  const all = {
    api_feed_cold: { weight: 4, run: async (rec, auth) => { await feedOpen(rec, auth); } },
    // Swipe through a fresh session. Page 2 is the first request that can outrun the
    // global slate and wait for the personalized refill, so it is timed on its own.
    api_feed_page: {
      weight: 6,
      run: async (rec, auth) => {
        let page = await feedOpen(rec, auth);
        for (const name of ['api_feed_page2', 'api_feed_page3', 'api_feed_page4']) {
          if (!page.ok || !page.body?.nextCursor) return;
          const q = new URLSearchParams({ limit: String(ctx.feedLimit), cursor: page.body.nextCursor });
          if (page.body.feedSessionId) q.set('feedSessionId', page.body.feedSessionId);
          page = await timed(auth, ctx.baseUrl, name, `/content/reels/recommended?${q}`);
          rec(page);
        }
      },
    },
    api_feed_ranked: {
      weight: 2,
      run: async (rec, auth) => { rec(await timed(auth, ctx.baseUrl, 'api_feed_ranked', '/content/reels?limit=20&ranked=true')); },
    },
    api_feed_friends: {
      weight: 1,
      run: async (rec, auth) => { rec(await timed(auth, ctx.baseUrl, 'api_feed_friends', '/content/reels/friends?limit=20')); },
    },
    api_reel_detail: {
      weight: 4,
      run: async (rec, auth) => { rec(await timed(auth, ctx.baseUrl, 'api_reel_detail', `/content/reels/${pick(ctx.reels, rand).id}`)); },
    },
    api_reel_context: {
      weight: 2,
      run: async (rec, auth) => { rec(await timed(auth, ctx.baseUrl, 'api_reel_context', `/content/reels/${pick(ctx.reels, rand).id}/context?before=1&after=5`)); },
    },
    api_series_episodes: {
      weight: ctx.seriesIds.length ? 4 : 0,
      run: async (rec, auth) => {
        const id = pick(ctx.seriesIds, rand);
        const around = ctx.reels.find((r) => r.series?.id === id)?.id;
        const q = new URLSearchParams({ limit: '15' });
        if (around) q.set('aroundReelId', around);
        rec(await timed(auth, ctx.baseUrl, 'api_series_episodes', `/content/series/${id}/episodes?${q}`));
      },
    },
    api_series_detail: {
      weight: ctx.seriesIds.length ? 1 : 0,
      run: async (rec, auth) => { rec(await timed(auth, ctx.baseUrl, 'api_series_detail', `/content/series/${pick(ctx.seriesIds, rand)}`)); },
    },
    api_search: {
      weight: 2,
      run: async (rec, auth) => {
        const term = pick(ctx.queries, rand);
        rec(await timed(auth, ctx.baseUrl, 'api_search', `/search?${new URLSearchParams({ q: term, type: 'reels', limit: '12' })}`));
      },
    },
    api_search_tag: {
      weight: ctx.tags.length ? 1 : 0,
      run: async (rec, auth) => { rec(await timed(auth, ctx.baseUrl, 'api_search_tag', `/search/tags/reels?${new URLSearchParams({ tag: pick(ctx.tags, rand), limit: '20' })}`)); },
    },
    api_auth_me: {
      weight: 1,
      run: async (rec, auth) => { rec(await timed(auth, ctx.baseUrl, 'api_auth_me', '/auth/me')); },
    },
    stream_startup: {
      weight: ctx.playable.length ? 8 : 0,
      run: async (rec, auth) => {
        const result = await hlsStartup(pick(ctx.playable, rand).streamUrl);
        for (const s of result.samples) rec(s);
        if (result.totalMs !== null) rec({ name: 'stream_startup', ok: true, status: 200, ms: result.totalMs, ttfbMs: null, bytes: 0 });
        else rec({ name: 'stream_startup', ok: false, status: result.samples.at(-1)?.status ?? null, error: 'hls_chain_failed', ms: 0, ttfbMs: null, bytes: 0 });
      },
    },
    // The viewer's real wait when the next reel comes from a non-AI list: fetch the
    // list page, then start the first playable reel.
    first_frame_ranked: {
      weight: ctx.playable.length ? 6 : 0,
      run: async (rec, auth) => firstFrame(rec, auth, 'first_frame_ranked', `/content/reels?limit=${ctx.feedLimit}&ranked=true`),
    },
    // AI-dependent variant: the recommended feed (semantic pool + rerank refill).
    first_frame: {
      weight: ctx.playable.length ? 6 : 0,
      run: async (rec, auth) => firstFrame(rec, auth, 'first_frame', `/content/reels/recommended?limit=${ctx.feedLimit}`),
    },
  };

  const chosen = Object.entries(all).filter(([name, v]) => v.weight > 0 && enabled(name));
  const total = chosen.reduce((sum, [, v]) => sum + v.weight, 0);
  return {
    names: chosen.map(([name]) => name),
    next() {
      let r = rand() * total;
      for (const [name, v] of chosen) {
        r -= v.weight;
        if (r <= 0) return v;
      }
      return chosen[chosen.length - 1][1];
    },
  };
}

// AI_GROUPS depend on the AI host (embeddings, reranker, bot model) and run only when
// named. DEFAULT_GROUPS are DB/CDN only.
const GROUPS = {
  list: ['api_feed_ranked', 'api_feed_friends'],
  detail: ['api_reel_detail', 'api_reel_context'],
  series: ['api_series_episodes', 'api_series_detail'],
  tags: ['api_search_tag'],
  stream: ['stream_startup'],
  startup: ['first_frame_ranked'],
  baseline: ['api_auth_me'],
  // AI-dependent
  feed: ['api_feed_cold', 'api_feed_page'],
  search: ['api_search'],
  'startup-ai': ['first_frame'],
};
const AI_GROUPS = ['feed', 'search', 'startup-ai', 'rag'];
const DEFAULT_SCENARIOS = 'baseline,list,detail,series,tags,stream,startup';

function enabledFilter(list) {
  const names = new Set();
  for (const item of list) {
    if (GROUPS[item]) GROUPS[item].forEach((n) => names.add(n));
    else if (item !== 'rag') names.add(item);
  }
  return (name) => names.has(name);
}

async function runStage({ concurrency, seconds, thinkMs, scenarios, abort, viewers }) {
  const samples = [];
  const deadline = performance.now() + seconds * 1000;
  // Keep only the timing fields: a retained response body (a feed page is 13-40 KB of parsed JSON)
  // per sample ran the generator out of its 2 GB heap at 400 viewers.
  const record = (sample) => { const { body, text, ...slim } = sample; samples.push(slim); };
  const worker = async (_unused, index) => {
    const auth = viewers ? viewers[index] : undefined;
    while (performance.now() < deadline && !abort.tripped) {
      await scenarios.next().run(record, auth);
      if (thinkMs) await sleep(thinkMs * (0.5 + Math.random()));
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(_, index)));
  return { samples, wallSeconds: (performance.now() - started) / 1000 };
}

function groupByName(samples) {
  const rows = {};
  for (const s of samples) (rows[s.name] ||= []).push(s);
  return rows;
}

function cacheBreakdown(samples) {
  const out = {};
  for (const s of samples.filter((x) => x.cache !== undefined)) {
    out[s.name] ||= {};
    out[s.name][s.cache] = (out[s.name][s.cache] || 0) + 1;
  }
  return out;
}

// ---------- RAG (Socket.IO bot chat) ----------

async function runRag({ auth, baseUrl, wsUrl, botUserId, questions, turns, spacingMs, log }) {
  const { io } = require('socket.io-client');
  const results = [];

  const conv = await timed(auth, baseUrl, 'rag_conversation', '/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantIds: [botUserId], type: 'DIRECT' }),
  });
  const conversationId = conv.body?.id || conv.body?._id || conv.body?.conversation?.id;
  if (!conv.ok || !conversationId) {
    log(`[rag] could not open bot conversation: status ${conv.status}`);
    return [{ name: 'rag_final', ok: false, status: conv.status, error: 'no_conversation', ms: 0 }];
  }

  const socket = io(wsUrl, { transports: ['websocket'], path: '/socket.io', forceNew: true, auth: { token: auth.token } });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 15000);
  });

  const pending = new Map();
  socket.on('message_synced', (m) => { const p = pending.get(m.clientMessageId); if (p && !p.synced) p.synced = performance.now(); });
  socket.on('bot_token', (m) => {
    if (m.conversationId !== conversationId) return;
    for (const p of pending.values()) if (!p.firstToken) { p.firstToken = performance.now(); break; }
  });
  socket.on('new_message', (m) => {
    if (m.conversationId !== conversationId || m.senderId !== botUserId) return;
    for (const p of pending.values()) if (!p.final) { p.final = performance.now(); p.resolve('final'); break; }
  });
  socket.on('bot_reply_failed', (m) => {
    if (m.conversationId && m.conversationId !== conversationId) return;
    for (const p of pending.values()) if (!p.final) { p.final = performance.now(); p.failure = m; p.resolve('failed'); break; }
  });

  // The server only fans bot_token/new_message out to sockets in the conversation room.
  // join_conversation has no ack, so give the membership check a moment to finish.
  socket.emit('join_conversation', conversationId);
  await sleep(1500);

  for (let i = 0; i < turns; i += 1) {
    const question = questions[i % questions.length];
    const clientMessageId = `lt-${Date.now()}-${i}`;
    const entry = { sent: performance.now(), synced: 0, firstToken: 0, final: 0, failure: null };
    const done = new Promise((resolve) => { entry.resolve = resolve; });
    pending.set(clientMessageId, entry);
    socket.emit('send_message', { conversationId, clientMessageId, type: 'text', content: question });
    const outcome = await Promise.race([done, sleep(90000).then(() => 'timeout')]);
    pending.delete(clientMessageId);
    const base = { status: outcome === 'final' ? 200 : null };
    results.push({ name: 'rag_ack', ok: Boolean(entry.synced), ...base, ms: entry.synced ? entry.synced - entry.sent : 0 });
    results.push({ name: 'rag_first_token', ok: Boolean(entry.firstToken), ...base, ms: entry.firstToken ? entry.firstToken - entry.sent : 0 });
    results.push({ name: 'rag_final', ok: outcome === 'final', ...base, error: outcome === 'final' ? undefined : (entry.failure?.error?.code || outcome), ms: entry.final ? entry.final - entry.sent : 0 });
    log(`[rag] turn ${i + 1}/${turns} ${outcome} first_token=${entry.firstToken ? Math.round(entry.firstToken - entry.sent) : '-'}ms final=${entry.final ? Math.round(entry.final - entry.sent) : '-'}ms`);
    if (i < turns - 1) await sleep(spacingMs);
  }
  socket.close();
  return results;
}

// ---------- main ----------

function markdownReport(report) {
  const lines = [`# Reel latency load test`, ``, `- target: ${report.baseUrl}`, `- started: ${report.startedAt}`, `- logins: ${report.logins}`, `- aborted: ${report.aborted ? 'yes, ' + report.abortReason : 'no'}`, ``];
  for (const [stage, rows] of Object.entries(report.stages)) {
    lines.push(`## ${stage}`, ``, `| scenario | n | err% | p50 | p90 | p95 | p99 | max | KB |`, `|---|---|---|---|---|---|---|---|---|`);
    for (const [name, s] of Object.entries(rows).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`| ${name} | ${s.count} | ${(s.errorRate * 100).toFixed(1)} | ${s.p50 ?? '-'} | ${s.p90 ?? '-'} | ${s.p95 ?? '-'} | ${s.p99 ?? '-'} | ${s.max ?? '-'} | ${s.kbMedian ?? '-'} |`);
    }
    lines.push(``);
  }
  if (report.cdnCache && Object.keys(report.cdnCache).length) {
    lines.push(`## CDN cache status (all stages)`, ``);
    for (const [name, counts] of Object.entries(report.cdnCache)) lines.push(`- ${name}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    lines.push(``);
  }
  if (report.slo.length) {
    lines.push(`## SLO checks`, ``, `| check | actual | limit | result |`, `|---|---|---|---|`);
    for (const c of report.slo) lines.push(`| ${c.name} | ${c.actual ?? '-'} | ${c.limit} | ${c.skipped ? `SKIP (n=${c.samples})` : c.pass ? 'PASS' : 'FAIL'} |`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try { require('dotenv').config({ path: path.resolve(process.cwd(), '.env') }); } catch { /* optional */ }

  const baseUrl = originOf(args['base-url'] || process.env.VELORA_BASE_URL || 'https://velora-app.me');
  const stages = String(args.stages || '1,5,10').split(',').map((v) => intArg(v.trim(), 1, '--stages', 1, 2000));
  const stageSeconds = intArg(args['stage-seconds'], 20, '--stage-seconds', 5, 600);
  const thinkMs = intArg(args['think-ms'], 250, '--think-ms', 0, 10000);
  const maxErrorRate = Number(args['max-error-rate'] ?? 0.2);
  const abortP95Ms = intArg(args['abort-p95-ms'], 8000, '--abort-p95-ms', 500, 120000);
  const scenarioList = String(args.scenarios || DEFAULT_SCENARIOS).split(',').map((v) => v.trim()).filter(Boolean);
  const enabled = enabledFilter(scenarioList);
  const ragEnabled = scenarioList.includes('rag');
  const includeAi = scenarioList.some((item) => AI_GROUPS.includes(item) || GROUPS['feed'].includes(item) || GROUPS.search.includes(item) || GROUPS['startup-ai'].includes(item));
  const queries = String(args.queries || 'love,revenge,family,fight,pet').split(',').map((q) => q.trim()).filter(Boolean);
  const slos = {
    api: intArg(args['slo-api-p95'], 350, '--slo-api-p95', 1, 600000),
    secondary: intArg(args['slo-secondary-p95'], 500, '--slo-secondary-p95', 1, 600000),
    stream_startup: intArg(args['slo-stream-p95'], 1200, '--slo-stream-p95', 1, 600000),
    first_frame: intArg(args['slo-first-frame-p95'], 1800, '--slo-first-frame-p95', 1, 600000),
    first_frame_ranked: intArg(args['slo-first-frame-p95'], 1800, '--slo-first-frame-p95', 1, 600000),
    hls_segment: intArg(args['slo-segment-p95'], 800, '--slo-segment-p95', 1, 600000),
    rag_first_token: intArg(args['slo-rag-first-token-p95'], 6000, '--slo-rag-first-token-p95', 1, 600000),
    rag_final: intArg(args['slo-rag-final-p95'], 30000, '--slo-rag-final-p95', 1, 600000),
    errorRate: 0.01,
    minSamples: intArg(args['min-samples'], 30, '--min-samples', 0, 100000),
  };

  const outDir = path.resolve(args.out || path.join('test-data', 'reel-latency', new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(outDir, { recursive: true });
  const log = (line) => console.log(line);

  const auth = new Auth(baseUrl);
  if (!auth.token) await auth.login();
  const me = await timed(auth, baseUrl, 'auth_check', '/auth/me');
  if (!me.ok) throw new Error(`auth check failed: ${me.status}`);

  const found = await discover(auth, baseUrl, { queries }, { includeAi });
  log(`[discover] reels=${found.reels.length} playable=${found.playable.length} series=${found.seriesIds.length} tags=${found.tags.length}`);
  if (!found.playable.length) log('[discover] warning: no playable stream URLs, stream scenarios are skipped');

  let seed = intArg(args.seed, 1, '--seed', 1, 2 ** 31 - 1);
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  // --viewers-file: one session per virtual viewer (distinct accounts, distinct feed sessions).
  // Without it every viewer shares the single test login.
  let viewers = Array.from({ length: Math.max(...stages) }, () => auth);
  if (args['viewers-file']) {
    const sessions = JSON.parse(fs.readFileSync(path.resolve(args['viewers-file']), 'utf8'));
    const needed = Math.max(...stages);
    if (!Array.isArray(sessions) || !sessions.length) throw new Error('--viewers-file holds no sessions');
    // Beyond the number of accounts, viewers reuse them round-robin (two workers per account):
    // less realistic for per-user caches, but it adds no accounts to the production database.
    if (sessions.length < needed && args['reuse-sessions'] !== 'true') throw new Error(`--viewers-file needs at least ${needed} sessions (or pass --reuse-sessions)`);
    viewers = Array.from({ length: needed }, (_, i) => new Auth(baseUrl, { ...sessions[i % sessions.length] }));
  }
  const ctx = { auth, baseUrl, feedLimit: intArg(args['feed-limit'], 6, '--feed-limit', 1, 50), ...found };
  const scenarios = buildScenarios(ctx, enabled, rand);
  log(`[plan] scenarios=${scenarios.names.join(',')} stages=${stages.join('/')} x ${stageSeconds}s think=${thinkMs}ms`);

  const report = { baseUrl, startedAt: new Date().toISOString(), config: { stages, stageSeconds, thinkMs, slos }, stages: {}, cdnCache: {}, aborted: false, abortReason: '', logins: 0, slo: [] };
  const abort = { tripped: false };
  const rawRows = ['stage,scenario,ok,status,ms,ttfb_ms,bytes,cache,at,cf_ray'];
  const allSamples = [];

  for (let index = 0; index < stages.length && !abort.tripped; index += 1) {
    const concurrency = stages[index];
    const label = `stage${index + 1}_c${concurrency}`;
    log(`[${label}] running ${stageSeconds}s with ${concurrency} virtual viewers`);
    const isLast = index === stages.length - 1;
    const ragPromise = ragEnabled && isLast
      ? runRag({
          auth, baseUrl, wsUrl: originOf(args['ws-url'] || baseUrl),
          botUserId: args['bot-user-id'] || process.env.BOT_USER_ID,
          questions: args['rag-questions'] ? fs.readFileSync(path.resolve(args['rag-questions']), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : ['Which episode shows the pets talking about their owner?', 'Recommend a reel about family drama.', 'What happens in the first episode of the series?'],
          turns: intArg(args['rag-turns'], 5, '--rag-turns', 1, 9),
          spacingMs: intArg(args['rag-spacing-ms'], 7000, '--rag-spacing-ms', 1000, 600000),
          log,
        }).catch((error) => { log(`[rag] failed: ${error.message}`); return [{ name: 'rag_final', ok: false, status: null, error: 'rag_exception', ms: 0 }]; })
      : null;

    const { samples, wallSeconds } = await runStage({ concurrency, seconds: stageSeconds, thinkMs, scenarios, abort, viewers });
    if (ragPromise) samples.push(...(await ragPromise));

    const rows = {};
    for (const [name, group] of Object.entries(groupByName(samples))) rows[name] = { ...summarize(group), rps: Math.round((group.length / wallSeconds) * 10) / 10 };
    report.stages[label] = rows;
    for (const s of samples) allSamples.push(s);
    for (const s of samples) rawRows.push([label, s.name, s.ok, s.status ?? s.error ?? '', Math.round(s.ms), s.ttfbMs == null ? '' : Math.round(s.ttfbMs), s.bytes ?? '', s.cache ?? '', s.at ? new Date(s.at).toISOString() : '', s.ray ?? ''].join(','));

    const api = samples.filter((s) => s.name.startsWith('api_'));
    const apiSummary = summarize(api);
    log(`[${label}] api n=${apiSummary.count} err=${(apiSummary.errorRate * 100).toFixed(1)}% p50=${apiSummary.p50} p95=${apiSummary.p95} max=${apiSummary.max}`);
    if (apiSummary.errorRate > maxErrorRate || (apiSummary.p95 ?? 0) > abortP95Ms) {
      abort.tripped = true;
      report.aborted = true;
      report.abortReason = `${label}: errorRate ${(apiSummary.errorRate * 100).toFixed(1)}% or p95 ${apiSummary.p95}ms beyond brake`;
      log(`[brake] ${report.abortReason}; skipping remaining stages`);
    }
  }

  report.logins = new Set([auth, ...viewers]).size === 1 ? auth.logins : [auth, ...new Set(viewers)].reduce((n, a) => n + a.logins, 0);
  report.distinctViewers = new Set(viewers).size;
  report.cdnCache = cacheBreakdown(allSamples);
  report.slo = evaluateSlos(report, slos);
  fs.writeFileSync(path.join(outDir, 'samples.csv'), rawRows.join('\n'));
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const md = markdownReport(report);
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  console.log(`\n${md}\n\nartifacts: ${outDir}`);
  process.exitCode = report.slo.some((c) => !c.pass) || report.aborted ? 1 : 0;
}

module.exports = { parseArgs, percentile, summarize, parseMasterPlaylist, parseMediaPlaylist, evaluateSlos };

if (require.main === module) {
  main().catch((error) => { console.error(`[fatal] ${error.message}`); process.exitCode = 2; });
}
