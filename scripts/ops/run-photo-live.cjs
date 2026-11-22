#!/usr/bin/env node
'use strict';
/**
 * Sends the photo rows of `rag-photo-v1.jsonl` to the Velora bot as real chat turns and scores the replies.
 * Each row: new bot conversation -> presign -> PUT to R2 -> finalize -> image message with the caption ->
 * wait for the bot's reply -> score (eval/rag/photo-live-lib.cjs).
 *
 *   BACKEND_URL=... VELORA_TEST_EMAIL=... VELORA_TEST_PASSWORD=... \
 *   node scripts/ops/run-photo-live.cjs run --out .benchmarks/photo-run-1.json \
 *     [--split dev|heldout|all] [--category frame,offtopic] [--limit 5] [--pause-ms 4000] [--dry-run]
 *
 * It spends vision (Groq / Cloudflare) quota on the live system, one turn at a time and with a pause between
 * rows. The output file is written after every row and `run` resumes from it, so a stop is cheap.
 * `--dry-run` lists the rows that would be sent and touches nothing. Credentials come from the environment and are never printed.
 * Frame rows need `.benchmarks/diverse-reel-map.json` (fixture -> production reel id).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const live = require('../../eval/rag/photo-live-lib.cjs');
const photo = require('../../eval/rag/photo-cases-lib.cjs');

const ROOT = 'test-data/reel-integration/diverse';
const CASES = 'eval/rag/datasets/rag-photo-v1.jsonl';
const MAP = '.benchmarks/diverse-reel-map.json';
const BOT_USER_ID = process.env.BOT_USER_ID || 'b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7';

/** The status code of an error thrown by the api client ("POST /x failed (400)"), or null. */
const statusOf = (error) => {
  const m = /failed \((\d{3})\)/.exec(String(error?.message || ''));
  return m ? Number(m[1]) : null;
};

function resolveReelId(map, fixtureId) {
  const ok = (map.entries?.[fixtureId] || []).filter((e) => e.success);
  return ok.length ? ok[ok.length - 1].reelId : null;
}

/** Minimal JSON client with a session cookie. `login` runs on the first 401. */
function apiClient(baseUrl, credentials) {
  let cookies = '';
  const request = async (method, pathname, body) => {
    let response;
    // The homelab sits behind a tunnel that resets connections now and then: retry network errors only.
    for (let attempt = 1; ; attempt += 1) {
      try {
        response = await fetch(new URL(pathname, `${baseUrl}/`), {
          method,
          headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookies ? { cookie: cookies } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(45_000),
        });
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    const set = response.headers.get('set-cookie');
    if (set) cookies = set.split(/,(?=\s*[^;=]+=)/).map((v) => v.split(';')[0]).join('; ');
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { payload = raw; }
    if (response.status === 401 && pathname !== '/auth/login') {
      await request('POST', '/auth/login', credentials);
      return request(method, pathname, body);
    }
    if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status})`);
    return payload;
  };
  return request;
}

async function putObject(uploadUrl, filePath, mimeType) {
  const bytes = fs.readFileSync(filePath);
  let response;
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType, 'Content-Length': String(bytes.length) },
        body: bytes,
        signal: AbortSignal.timeout(120_000),
      });
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  if (!response.ok) throw new Error(`PUT upload failed (${response.status})`);
}

const messageRows = (payload) => (Array.isArray(payload) ? payload : Array.isArray(payload?.messages) ? payload.messages : []);

async function waitForBotReply(request, conversationId, since, { attempts = 60, intervalMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const threshold = new Date(since ?? 0).getTime();
  for (let i = 0; i < attempts; i += 1) {
    await sleep(intervalMs);
    try {
      const rows = messageRows(await request('GET', `/conversations/${conversationId}/messages?limit=50`));
      const bot = rows.find((m) => m?.senderId === BOT_USER_ID && new Date(m.createdAt ?? 0).getTime() >= threshold);
      if (bot) return bot;
    } catch { /* transient: poll again */ }
  }
  return null;
}

/** One row, one turn. `deps` is injectable so the flow can be tested without a backend. */
async function runRow(row, deps) {
  const { request, put = putObject, readPhoto, reelIdFor, wait = waitForBotReply } = deps;
  const image = row.images[0];
  const filePath = readPhoto(image);
  const out = { id: row.id, tags: row.tags, category: row.category, outcome: row.expect.outcome, startedAt: new Date().toISOString() };
  const conversation = await request('POST', '/conversations', { participantIds: [BOT_USER_ID], type: 'GROUP', isGroup: true, name: `Photo benchmark ${row.id}` });
  if (!conversation?.id) throw new Error(`conversation create returned no id for ${row.id}`);
  out.conversationId = conversation.id;

  let stage = 'presign';
  let media;
  try {
    const presign = await request('POST', '/media/upload-url', { fileType: image.mimeType, purpose: 'chat' });
    stage = 'upload';
    await put(presign.uploadUrl, filePath, image.mimeType);
    stage = 'finalize';
    media = await request('POST', '/media/finalize-upload', { key: presign.key, fileType: image.mimeType });
    stage = 'message';
    const sent = await request('POST', `/conversations/${conversation.id}/messages`, {
      clientMessageId: `photo-${row.id}-${crypto.randomUUID()}`,
      content: row.caption || photo.DEFAULT_CAPTION_PLACEHOLDER,
      type: 'image',
      media: { fileKey: media.fileKey, fileUrl: media.fileUrl, mimeType: media.mimeType || image.mimeType, width: media.width, height: media.height, status: media.status },
      signalType: 0,
    });
    stage = 'reply';
    const bot = await wait(request, conversation.id, sent?.createdAt);
    out.reply = bot ? { answer: typeof bot.content === 'string' ? bot.content : '', recommended: live.recommendedReelIds(bot), messageId: bot.id ?? null } : null;
  } catch (error) {
    const status = statusOf(error);
    // A refusal by the platform (4xx) before the bot saw the photo is data; anything else is a failed attempt.
    out.rejected = { stage, status, message: String(error.message).slice(0, 200) };
    if (status === null || status >= 500) out.error = true;
  }
  const reelId = row.expect.sourceFixtureId ? reelIdFor(row.expect.sourceFixtureId) : null;
  out.reelId = reelId;
  out.score = live.scoreRow(row, { reply: out.reply || null, rejected: out.rejected || null, reelId });
  out.finishedAt = new Date().toISOString();
  return out;
}

function selectRows(rows, { split = 'all', category = null, limit = null, ids = null } = {}) {
  const cats = category ? new Set(String(category).split(',')) : null;
  const wanted = ids ? new Set(String(ids).split(',').map((id) => id.trim())) : null;
  const picked = rows.filter((r) => (split === 'all' || r.split === split) && (!cats || cats.has(r.category)) && (!wanted || wanted.has(r.id)));
  return limit ? picked.slice(0, Number(limit)) : picked;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const [name, inline] = argv[i].slice(2).split('=', 2);
    if (inline !== undefined) args[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { args[name] = argv[i + 1]; i += 1; } else args[name] = true;
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command !== 'run' || !args.out) { console.error('usage: run-photo-live.cjs run --out FILE [--split] [--category] [--limit] [--pause-ms] [--dry-run]'); process.exit(2); }
  const rows = selectRows(fs.readFileSync(CASES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), args);
  const errors = photo.validateRows(rows);
  if (errors.length) throw new Error(`invalid rows:\n${errors.join('\n')}`);
  const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  if (args['dry-run']) {
    for (const r of rows) console.log(`${r.id} ${r.category} ${r.expect.outcome} ${r.images[0].file} caption=${JSON.stringify(r.caption.slice(0, 40))}`);
    console.log(`dry run: ${rows.length} rows, nothing sent`);
    return;
  }
  for (const key of ['BACKEND_URL', 'VELORA_TEST_EMAIL', 'VELORA_TEST_PASSWORD']) if (!process.env[key]) throw new Error(`${key} is not set`);
  const request = apiClient(process.env.BACKEND_URL, { email: process.env.VELORA_TEST_EMAIL, password: process.env.VELORA_TEST_PASSWORD });
  await request('POST', '/auth/login', { email: process.env.VELORA_TEST_EMAIL, password: process.env.VELORA_TEST_PASSWORD });

  const done = fs.existsSync(args.out) ? JSON.parse(fs.readFileSync(args.out, 'utf8')) : { meta: { startedAt: new Date().toISOString() }, items: [] };
  const finished = new Set(done.items.filter((i) => !i.error).map((i) => i.id));
  const deps = { request, readPhoto: (img) => path.join(ROOT, img.file), reelIdFor: (fixtureId) => resolveReelId(map, fixtureId) };
  const pauseMs = Number(args['pause-ms'] ?? 4000);
  for (const row of rows) {
    if (finished.has(row.id)) continue;
    const item = await runRow(row, deps);
    done.items = done.items.filter((i) => i.id !== row.id).concat(item);
    done.summary = live.summarize(done.items);
    const tmp = `${args.out}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(done, null, 2));
    fs.renameSync(tmp, args.out);
    console.log(`${row.id} ${row.category} pass=${item.score.pass} ${item.error ? 'ERROR ' + item.rejected?.stage : ''}`);
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  console.log(JSON.stringify(done.summary.overall));
}

module.exports = { apiClient, runRow, selectRows, resolveReelId, statusOf, waitForBotReply };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
