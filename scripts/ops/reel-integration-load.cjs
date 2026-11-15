#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw || raw === '--' || !raw.startsWith('--')) continue;
    const [name, inline] = raw.slice(2).split('=', 2);
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

function integer(value, fallback, name, min, max) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function boolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function datasetDirectory(args) {
  const dataset = String(args.dataset || 'pexels').toLowerCase();
  if (!['pexels', 'ami'].includes(dataset)) throw new Error('--dataset must be pexels or ami');
  return path.resolve(args['dataset-dir'] || (dataset === 'ami' ? 'test-data/reel-integration/ami' : 'test-data/reel-integration'));
}

function originBase(value) {
  const url = new URL(String(value));
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('--base-url must be an origin without a path; production gateway routes are rooted at /');
  return url.origin;
}

function apiUrl(baseUrl, route) { return new URL(route, `${baseUrl}/`).toString(); }

function runId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function csv(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[\",\n]/.test(text) ? `\"${text.replace(/\"/g, '\"\"')}\"` : text;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${url} failed (${response.status}): ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)}`);
  }
  return { response, body };
}

function choosePexelsMp4(video) {
  const files = Array.isArray(video.video_files) ? video.video_files : [];
  const mp4s = files
    .filter((item) => item.file_type === 'video/mp4' && item.link)
    .filter((item) => {
      const width = Number(item.width || 0);
      const height = Number(item.height || 0);
      return width > 0 && height > 0 && Math.max(width, height) <= 2160;
    })
    .sort((left, right) => Number(right.width || 0) * Number(right.height || 0) - Number(left.width || 0) * Number(left.height || 0));
  return mp4s[0] || files.find((item) => item.file_type === 'video/mp4' && item.link) || null;
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}): ${url}`);
  }
  ensureDir(path.dirname(destination));
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

async function prepareDataset(args) {
  if (String(args.dataset || 'pexels').toLowerCase() === 'ami') throw new Error('Prepare AMI fixtures with scripts/ops/prepare-ami-fixtures.cjs; this runner uploads the generated manifest.');
  const apiKey = process.env.PEXELS_API_KEY?.trim();
  if (!apiKey) throw new Error('PEXELS_API_KEY is required for prepare/all mode');

  const datasetDir = datasetDirectory(args);
  const videosDir = path.join(datasetDir, 'videos');
  ensureDir(videosDir);

  const count = integer(args.count, 12, '--count', 1, 80);
  const query = args.query || 'people talking';
  const orientation = args.orientation;
  if (orientation && !['portrait', 'landscape', 'square'].includes(orientation)) {
    throw new Error('--orientation must be portrait, landscape, or square');
  }

  const params = new URLSearchParams({ query, per_page: String(count), page: String(integer(args.page, 1, '--page', 1, 1000)) });
  if (orientation) params.set('orientation', orientation);

  const { body } = await fetchJson(`https://api.pexels.com/v1/videos/search?${params}`, {
    headers: { Authorization: apiKey },
  });

  const fixtures = [];
  for (const video of (Array.isArray(body?.videos) ? body.videos : []).slice(0, count)) {
    const selected = choosePexelsMp4(video);
    if (!selected) continue;

    const filename = `pexels-${video.id}.mp4`;
    const localFile = path.join(videosDir, filename);
    if (!fs.existsSync(localFile) || fs.statSync(localFile).size === 0) {
      console.log(`[prepare] downloading ${video.id}`);
      await download(selected.link, localFile);
    } else {
      console.log(`[prepare] cached ${filename}`);
    }

    fixtures.push({
      id: `pexels-${video.id}`,
      file: path.relative(datasetDir, localFile),
      mimeType: 'video/mp4',
      source: 'pexels',
      sourceUrl: video.url,
      creator: video.user?.name || null,
      creatorUrl: video.user?.url || null,
      durationSeconds: Number(video.duration || 0) || null,
      width: Number(selected.width || 0) || null,
      height: Number(selected.height || 0) || null,
      title: `Integration fixture: ${query} (${video.id})`,
      description: `Automated Velora integration fixture. Pexels source: ${video.url}`,
      tags: ['integration-test', 'pexels', query.toLowerCase().replace(/\s+/g, '-')],
      questions: [],
    });
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'Pexels API',
    fixtures,
  };
  fs.writeFileSync(path.join(datasetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[prepare] ${fixtures.length} fixtures ready in ${datasetDir}`);
  return manifest;
}

function authHeaders(auth) {
  if (auth.bearer) return { Authorization: `Bearer ${auth.bearer}` };
  return { Cookie: auth.cookie };
}

// Access tokens expire after about 15 minutes, shorter than a ramp. On a 401 log in again once
// (shared by all concurrent jobs) and retry; a fixed VELORA_TEST_ACCESS_TOKEN cannot be refreshed.
async function fetchAuthed(baseUrl, auth, url, options = {}) {
  const send = () => fetchJson(url, { ...options, headers: { ...(options.headers || {}), ...authHeaders(auth) } });
  try {
    return await send();
  } catch (error) {
    if (!/failed \(401\)/.test(String(error?.message)) || auth.bearer) throw error;
    auth.refreshing ||= authenticate(baseUrl)
      .then((fresh) => { auth.cookie = fresh.cookie; })
      .finally(() => { auth.refreshing = null; });
    await auth.refreshing;
    return send();
  }
}

async function authenticate(baseUrl) {
  const token = process.env.VELORA_TEST_ACCESS_TOKEN?.trim();
  if (token) return { bearer: token };

  const email = process.env.VELORA_TEST_EMAIL?.trim();
  const password = process.env.VELORA_TEST_PASSWORD;
  if (!email || !password) {
    throw new Error('Set VELORA_TEST_ACCESS_TOKEN or VELORA_TEST_EMAIL + VELORA_TEST_PASSWORD');
  }

  const { response } = await fetchJson(apiUrl(baseUrl, '/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookies.map((item) => item.split(';', 1)[0]).filter(Boolean).join('; ');
  if (!cookie) throw new Error('Login returned no auth cookie');
  return { cookie };
}

async function verifyAuthentication(baseUrl, auth) { await fetchAuthed(baseUrl, auth, apiUrl(baseUrl, '/auth/me')); }

async function getUploadUrl(baseUrl, auth, mimeType) {
  const started = Date.now();
  const { body } = await fetchAuthed(baseUrl, auth, apiUrl(baseUrl, '/media/upload-url'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileType: mimeType, purpose: 'reel' }),
  });
  return { ...body, latencyMs: Date.now() - started };
}

async function putObject(uploadUrl, filePath, mimeType) {
  const stat = fs.statSync(filePath);
  const started = Date.now();
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'Content-Length': String(stat.size) },
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`R2 PUT failed (${response.status}): ${raw.slice(0, 500)}`);
  const latencyMs = Date.now() - started;
  return {
    bytes: stat.size,
    latencyMs,
    mbps: latencyMs > 0 ? (stat.size * 8) / latencyMs / 1000 : null,
  };
}

async function createReel(baseUrl, auth, fixture, key, id, ordinal) {
  const started = Date.now();
  const payload = {
    mediaKey: key,
    title: `[IT:${id}] ${fixture.title || fixture.id} #${ordinal}`,
    description: fixture.description || `Velora integration run ${id}`,
    tags: [...new Set([...(fixture.tags || []), 'integration-test', `run-${id}`])].slice(0, 30),
    visibility: 'private',
    ...(fixture.durationSeconds ? { clientObservedDurationMs: Math.max(1, Math.round(fixture.durationSeconds * 1000)) } : {}),
  };
  const { body } = await fetchAuthed(baseUrl, auth, apiUrl(baseUrl, '/content/reels'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { reel: body, latencyMs: Date.now() - started };
}

async function status(baseUrl, auth, reelId) {
  const { body } = await fetchAuthed(baseUrl, auth, apiUrl(baseUrl, `/content/reels/${reelId}/status`));
  return body;
}

async function waitReady(baseUrl, auth, reelId, timeoutMs, pollMs) {
  const started = Date.now();
  let mediaAt = null;
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await status(baseUrl, auth, reelId);
    if (!mediaAt && last?.mediaStatus === 'COMPLETED') mediaAt = Date.now();

    if (last?.status === 'COMPLETED' && last?.mediaStatus === 'COMPLETED' && last?.indexStatus === 'COMPLETED') {
      const ended = Date.now();
      return {
        mediaReadyMs: mediaAt ? mediaAt - started : null,
        indexAfterMediaMs: mediaAt ? ended - mediaAt : null,
        processingMs: ended - started,
        stage: last.stage,
      };
    }
    if (last?.status === 'FAILED' || last?.mediaStatus === 'FAILED' || last?.indexStatus === 'FAILED') {
      throw new Error(`reel ${reelId} failed stage=${last?.stage || 'unknown'} message=${last?.message || 'unknown'}`);
    }
    await sleep(pollMs);
  }
  throw new Error(`timed out waiting for ${reelId}; last=${JSON.stringify(last)}`);
}

async function oneJob({ fixture, ordinal, datasetDir, baseUrl, auth, id, timeoutMs, pollMs }) {
  const row = { ordinal, fixtureId: fixture.id, source: fixture.source, sourceUrl: fixture.sourceUrl, success: false };
  try {
    const filePath = path.resolve(datasetDir, fixture.file);
    if (!fs.existsSync(filePath)) throw new Error(`missing fixture ${filePath}`);

    const presign = await getUploadUrl(baseUrl, auth, fixture.mimeType || 'video/mp4');
    row.presignMs = presign.latencyMs;
    row.mediaKey = presign.key;

    const upload = await putObject(presign.uploadUrl, filePath, fixture.mimeType || 'video/mp4');
    row.bytes = upload.bytes;
    row.uploadMs = upload.latencyMs;
    row.uploadMbps = upload.mbps;

    const created = await createReel(baseUrl, auth, fixture, presign.key, id, ordinal);
    row.createReelMs = created.latencyMs;
    row.reelId = created.reel.id;

    Object.assign(row, await waitReady(baseUrl, auth, row.reelId, timeoutMs, pollMs));
    row.success = true;
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  }
  return row;
}

async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

function summarize(rows, elapsedMs) {
  const successful = rows.filter((row) => row.success);
  const failed = rows.filter((row) => !row.success);
  const stats = (key) => {
    const values = successful.map((row) => Number(row[key])).filter(Number.isFinite);
    return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: values.length ? Math.max(...values) : null };
  };
  return {
    total: rows.length,
    succeeded: successful.length,
    failed: failed.length,
    successRate: rows.length ? successful.length / rows.length : 0,
    elapsedMs,
    throughputReelsPerMinute: elapsedMs > 0 ? successful.length * 60000 / elapsedMs : null,
    presignMs: stats('presignMs'),
    uploadMs: stats('uploadMs'),
    uploadMbps: stats('uploadMbps'),
    createReelMs: stats('createReelMs'),
    mediaReadyMs: stats('mediaReadyMs'),
    indexAfterMediaMs: stats('indexAfterMediaMs'),
    processingMs: stats('processingMs'),
    failures: failed.map((row) => ({ ordinal: row.ordinal, fixtureId: row.fixtureId, reelId: row.reelId || null, error: row.error })),
  };
}

function report(datasetDir, id, rows, summary) {
  const directory = path.join(datasetDir, 'reports');
  ensureDir(directory);
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ runId: id, generatedAt: new Date().toISOString(), summary, rows }, null, 2));

  const columns = ['ordinal', 'fixtureId', 'source', 'sourceUrl', 'reelId', 'mediaKey', 'bytes', 'presignMs', 'uploadMs', 'uploadMbps', 'createReelMs', 'mediaReadyMs', 'indexAfterMediaMs', 'processingMs', 'success', 'error'];
  const output = [columns.join(','), ...rows.map((row) => columns.map((key) => csv(row[key])).join(','))].join('\n');
  fs.writeFileSync(path.join(directory, `${id}.csv`), output);
  return directory;
}

async function runLoad(args, prepared) {
  const datasetDir = datasetDirectory(args);
  const manifest = prepared || JSON.parse(fs.readFileSync(path.join(datasetDir, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.fixtures) || !manifest.fixtures.length) throw new Error('dataset has no fixtures');
  const requestedFixtureIds = args['fixture-id']
    ? new Set(String(args['fixture-id']).split(',').map((value) => value.trim()).filter(Boolean))
    : null;
  const fixtures = requestedFixtureIds
    ? manifest.fixtures.filter((fixture) => requestedFixtureIds.has(fixture.id) || requestedFixtureIds.has(fixture.fixtureId))
    : manifest.fixtures;
  if (!fixtures.length) throw new Error(`no fixtures matched --fixture-id=${args['fixture-id']}`);

  const configuredBaseUrl = args['base-url'] || process.env.VELORA_TEST_BASE_URL || process.env.BACKEND_URL;
  if (!configuredBaseUrl) throw new Error('Set --base-url, VELORA_TEST_BASE_URL, or BACKEND_URL');
  const baseUrl = originBase(configuredBaseUrl);

  const concurrency = integer(args.concurrency, 2, '--concurrency', 1, 32);
  const count = integer(args.count, fixtures.length, '--count', 1, 10000);
  const timeoutMs = integer(args['timeout-ms'], 20 * 60 * 1000, '--timeout-ms', 10000, 8 * 60 * 60 * 1000);
  const pollMs = integer(args['poll-ms'], 2000, '--poll-ms', 250, 30000);
  const id = args['run-id'] || runId();
  const auth = await authenticate(baseUrl);
  await verifyAuthentication(baseUrl, auth);
  const jobs = Array.from({ length: count }, (_, index) => ({ fixture: fixtures[index % fixtures.length], ordinal: index + 1 }));

  console.log(`[run] base=${baseUrl} runId=${id} count=${count} concurrency=${concurrency}`);
  console.log('[run] all automated reels are created as PRIVATE');

  const started = Date.now();
  const rows = await pool(jobs, concurrency, async (job) => {
    console.log(`[run] #${job.ordinal} start ${job.fixture.id}`);
    const result = await oneJob({ ...job, datasetDir, baseUrl, auth, id, timeoutMs, pollMs });
    console.log(`[run] #${job.ordinal} ${result.success ? 'PASS' : 'FAIL'} ${result.reelId || ''} ${result.success ? `${result.processingMs}ms` : result.error}`);
    return result;
  });

  const summary = summarize(rows, Date.now() - started);
  const directory = report(datasetDir, id, rows, summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[run] reports: ${directory}`);
  if (summary.failed && boolean(args['fail-on-error'])) process.exitCode = 1;
}

function help() {
  console.log(`Velora reel integration/load runner\n\nPrepare Pexels fixtures:\n  node scripts/ops/reel-integration-load.cjs --mode=prepare --query=\"people talking\" --orientation=portrait --count=5\n\nRun against Velora:\n  node scripts/ops/reel-integration-load.cjs --mode=run --count=5 --concurrency=1 --fail-on-error=true\n\nRequired environment:\n  PEXELS_API_KEY=...                         # prepare/all only\n  VELORA_TEST_BASE_URL=https://velora-app.me\n  VELORA_TEST_ACCESS_TOKEN=...               # OR credentials below\n  VELORA_TEST_EMAIL=...\n  VELORA_TEST_PASSWORD=...\n\nModes: prepare | run | all\nConcurrency is capped at 32. Downloaded source videos are cached before load timing.\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true' || args.h === 'true') return help();
  const mode = args.mode || 'run';
  if (!['prepare', 'run', 'all'].includes(mode)) throw new Error('--mode must be prepare, run, or all');
  let prepared = null;
  if (mode === 'prepare' || mode === 'all') prepared = await prepareDataset(args);
  if (mode === 'run' || mode === 'all') await runLoad(args, prepared);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
