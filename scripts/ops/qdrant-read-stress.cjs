#!/usr/bin/env node
/* Closed-loop read stress generator for Reel Indexing Qdrant (Layout D read-scaling test).
 * Mirrors QdrantReelVectorStoreAdapter.search(): POST /collections/<c>/points/query with
 * params.exact=true, has_id, kind, and an OR (should) of tuple filters (reelId,
 * indexAttemptId, projectionGeneration, manifestHash), limit=100, with_payload=true.
 *
 * Usage:
 *   node scripts/ops/qdrant-read-stress.cjs \
 *     --targets=H1=https://qdrant:6333,L=https://100.104.227.44:6333 \
 *     --scope=wide \
 *     --concurrencies=1,2,4,8,16,32,64 \
 *     --warmup-seconds=10 \
 *     --duration-seconds=45 \
 *     [--collection=velora_reel_bge_m3_1024_v1] \
 *     [--api-key-file=/run/secrets/qdrant_api_key] \
 *     [--ca-file=/run/secrets/qdrant_tls_ca] \
 *     [--tuples-file=/work/active-tuples.json] \
 *     [--sample-url=https://qdrant:6333] \
 *     [--sample-size=500] \
 *     [--narrow-reels=8] \
 *     [--limit=100] \
 *     [--timeout-ms=5000] \
 *     [--label=C2]
 *
 * Keeps sampled query vectors in memory only; never prints API keys or vectors. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const DEFAULT_COLLECTION = 'velora_reel_bge_m3_1024_v1';
const ALL_KINDS = ['REEL', 'SECTION', 'CHUNK', 'VISUAL_SCENE'];

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      args.help = 'true';
      continue;
    }
    const match = /^--([a-z0-9-]+)=(.+)$/.exec(arg);
    if (!match || args[match[1]] !== undefined) {
      throw new Error(`Invalid or duplicate argument: ${arg}`);
    }
    args[match[1]] = match[2];
  }
  return args;
}

function validateUrl(rawUrl, allowLocalHttp) {
  const url = new URL(rawUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(`Invalid Qdrant base URL: ${rawUrl}`);
  }
  const isLocalHttp =
    allowLocalHttp &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error(`Qdrant requires verified TLS: ${rawUrl}`);
  }
  return url;
}

function loadTargets(rawTargets, allowLocalHttp) {
  if (!rawTargets) throw new Error('--targets is required');
  const targets = rawTargets.split(',').map((entry) => {
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq === entry.length - 1) {
      throw new Error(`Invalid target specification: ${entry}`);
    }
    const label = entry.slice(0, eq).trim();
    const rawUrl = entry.slice(eq + 1).trim();
    return { label, url: validateUrl(rawUrl, allowLocalHttp) };
  });
  if (!targets.length) throw new Error('At least one target is required');
  return targets;
}

function loadApiKey(filePath) {
  if (!filePath) throw new Error('Qdrant API key file is required');
  const key = fs.readFileSync(filePath, 'utf8').trim();
  if (!key || key.length > 4096 || /[\r\n]/.test(key)) {
    throw new Error('Invalid Qdrant API key file');
  }
  return key;
}

function createAgents(targets, caFile) {
  const needsHttps = targets.some((t) => t.url.protocol === 'https:');
  let httpsAgent = null;
  if (needsHttps) {
    if (!caFile) throw new Error('CA certificate file is required for HTTPS');
    const ca = fs.readFileSync(caFile);
    httpsAgent = new https.Agent({
      ca,
      keepAlive: true,
      maxSockets: 1024,
      rejectUnauthorized: true,
    });
  }
  const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 1024,
  });
  return { httpsAgent, httpAgent };
}

function requestRaw(
  agents,
  baseUrl,
  apiKey,
  path,
  method,
  bodyParts,
  timeoutMs,
) {
  return new Promise((resolve) => {
    const isHttps = baseUrl.protocol === 'https:';
    const mod = isHttps ? https : http;
    const agent = isHttps ? agents.httpsAgent : agents.httpAgent;
    const parts = Array.isArray(bodyParts)
      ? bodyParts
      : bodyParts
        ? [bodyParts]
        : [];
    const contentLength = parts.reduce((sum, buf) => sum + buf.length, 0);
    const headers = {
      'api-key': apiKey,
      ...(parts.length
        ? {
            'content-type': 'application/json',
            'content-length': String(contentLength),
          }
        : {}),
    };

    let done = false;
    let timer;
    const startedNs = process.hrtime.bigint();
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
      resolve({ ...outcome, ms: elapsedMs });
    };

    const req = mod.request(
      {
        protocol: baseUrl.protocol,
        hostname: baseUrl.hostname,
        port: baseUrl.port || (isHttps ? 443 : 80),
        path,
        method,
        headers,
        agent,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            finish({
              ok: false,
              status,
              reason: `HTTP_${status}:${raw.slice(0, 120).replace(/\s+/g, ' ')}`,
            });
            return;
          }
          finish({ ok: true, status, body: raw });
        });
        res.on('error', (err) => {
          finish({
            ok: false,
            status: res.statusCode || 0,
            reason: `RES_ERR:${err.code || err.message}`,
          });
        });
      },
    );

    timer = setTimeout(() => {
      req.destroy(new Error('REQUEST_TIMEOUT'));
      finish({ ok: false, status: 0, reason: `TIMEOUT_${timeoutMs}ms` });
    }, timeoutMs);

    req.on('error', (err) => {
      finish({
        ok: false,
        status: 0,
        reason: `REQ_ERR:${err.code || err.message}`,
      });
    });

    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) req.end(parts[i]);
      else req.write(parts[i]);
    }
    if (!parts.length) req.end();
  });
}

async function qdrantJson(
  agents,
  baseUrl,
  apiKey,
  path,
  method,
  body,
  timeoutMs = 10000,
) {
  const buf = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const res = await requestRaw(
    agents,
    baseUrl,
    apiKey,
    path,
    method,
    buf,
    timeoutMs,
  );
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.reason}`);
  const parsed = JSON.parse(res.body);
  if (parsed.status !== 'ok' || parsed.result === undefined) {
    throw new Error(`Invalid Qdrant response envelope on ${path}`);
  }
  return { result: parsed.result, ms: res.ms };
}

function tupleKey(t) {
  return `${t.reelId}\0${t.indexAttemptId}\0${String(t.projectionGeneration)}\0${t.manifestHash}`;
}

function tupleFilter(tuple) {
  return {
    must: [
      { key: 'reelId', match: { value: tuple.reelId } },
      { key: 'indexAttemptId', match: { value: tuple.indexAttemptId } },
      {
        key: 'projectionGeneration',
        match: { value: String(tuple.projectionGeneration) },
      },
      { key: 'manifestHash', match: { value: tuple.manifestHash } },
    ],
  };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

async function loadCorpusAndSample({
  agents,
  sampleUrl,
  apiKey,
  collection,
  tuplesFile,
  sampleSize,
}) {
  const allPoints = [];
  let offset;
  do {
    const { result } = await qdrantJson(
      agents,
      sampleUrl,
      apiKey,
      `/collections/${collection}/points/scroll`,
      'POST',
      {
        limit: 512,
        ...(offset === undefined ? {} : { offset }),
        with_payload: [
          'kind',
          'reelId',
          'indexAttemptId',
          'projectionGeneration',
          'manifestHash',
        ],
        with_vector: false,
      },
      15000,
    );
    for (const p of result.points || []) {
      allPoints.push({ id: String(p.id), payload: p.payload || {} });
    }
    offset = result.next_page_offset ?? undefined;
  } while (offset !== undefined && offset !== null);

  let activeTupleMap = new Map();
  if (tuplesFile) {
    const rawTuples = JSON.parse(fs.readFileSync(tuplesFile, 'utf8'));
    for (const t of rawTuples) {
      const normalized = {
        reelId: String(t.reelId),
        indexAttemptId: String(t.indexAttemptId),
        projectionGeneration: String(t.projectionGeneration ?? t.generation),
        manifestHash: String(t.manifestHash),
      };
      activeTupleMap.set(tupleKey(normalized), normalized);
    }
  } else {
    const bestByReel = new Map();
    for (const p of allPoints) {
      const pl = p.payload;
      if (
        !pl.reelId ||
        !pl.indexAttemptId ||
        !pl.projectionGeneration ||
        !pl.manifestHash
      ) {
        continue;
      }
      const gen = BigInt(String(pl.projectionGeneration));
      const cur = bestByReel.get(pl.reelId);
      if (!cur || gen > cur.gen) {
        bestByReel.set(pl.reelId, {
          gen,
          tuple: {
            reelId: String(pl.reelId),
            indexAttemptId: String(pl.indexAttemptId),
            projectionGeneration: String(pl.projectionGeneration),
            manifestHash: String(pl.manifestHash),
          },
        });
      }
    }
    for (const entry of bestByReel.values()) {
      activeTupleMap.set(tupleKey(entry.tuple), entry.tuple);
    }
  }

  const currentPoints = [];
  const currentPointIdSet = new Set();
  const seenTuples = new Map();
  const chunksByReel = new Map();

  for (const p of allPoints) {
    const pl = p.payload;
    const t = {
      reelId: String(pl.reelId || ''),
      indexAttemptId: String(pl.indexAttemptId || ''),
      projectionGeneration: String(pl.projectionGeneration || ''),
      manifestHash: String(pl.manifestHash || ''),
    };
    const tk = tupleKey(t);
    const activeTuple = activeTupleMap.get(tk);
    if (!activeTuple) continue;
    currentPoints.push({
      id: p.id,
      kind: pl.kind,
      reelId: t.reelId,
      tupleKey: tk,
    });
    currentPointIdSet.add(p.id);
    seenTuples.set(tk, activeTuple);
    if (pl.kind === 'CHUNK') {
      let bucket = chunksByReel.get(t.reelId);
      if (!bucket) {
        bucket = { tuple: activeTuple, pointIds: [] };
        chunksByReel.set(t.reelId, bucket);
      }
      bucket.pointIds.push(p.id);
    }
  }

  // Sample ~sampleSize vectors via scroll with random point-ID offsets (only a sample).
  const candidateOffsets = shuffleInPlace(currentPoints.map((p) => p.id));
  const sampled = [];
  const seenSampleIds = new Set();
  const batchSize = 20;
  let offsetCursor = 0;

  while (
    sampled.length < sampleSize &&
    offsetCursor < candidateOffsets.length
  ) {
    const startOffset =
      offsetCursor === 0 && candidateOffsets.length > sampleSize
        ? candidateOffsets[offsetCursor]
        : candidateOffsets[offsetCursor];
    offsetCursor += 1;
    const { result } = await qdrantJson(
      agents,
      sampleUrl,
      apiKey,
      `/collections/${collection}/points/scroll`,
      'POST',
      {
        limit: batchSize,
        offset: startOffset,
        with_payload: ['kind', 'reelId'],
        with_vector: true,
      },
      15000,
    );
    for (const p of result.points || []) {
      const id = String(p.id);
      if (!currentPointIdSet.has(id) || seenSampleIds.has(id)) continue;
      if (!Array.isArray(p.vector) || p.vector.length !== 1024) continue;
      seenSampleIds.add(id);
      sampled.push({
        id,
        kind: p.payload?.kind || 'CHUNK',
        reelId: p.payload?.reelId || '',
        vector: p.vector,
      });
      if (sampled.length >= sampleSize) break;
    }
  }

  if (!sampled.length) throw new Error('Failed to sample any vectors');

  return {
    totalPointsInQdrant: allPoints.length,
    currentPoints,
    currentTuples: Array.from(seenTuples.values()),
    chunksByReel,
    sampled,
  };
}

function buildWorkloads(corpus, { scopeMode, narrowReels, limit }) {
  const workloads = {};

  if (scopeMode === 'wide' || scopeMode === 'both') {
    const wideTemplate = {
      params: { exact: true },
      limit,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          { has_id: corpus.currentPoints.map((p) => p.id) },
          { key: 'kind', match: { any: ALL_KINDS } },
          { should: corpus.currentTuples.map(tupleFilter) },
        ],
      },
    };
    const suffixBuf = Buffer.from(`,${JSON.stringify(wideTemplate).slice(1)}`);
    const requests = corpus.sampled.map((s) => {
      const prefixBuf = Buffer.from(`{"query":${JSON.stringify(s.vector)}`);
      return [prefixBuf, suffixBuf];
    });
    workloads.wide = {
      scope: 'wide',
      admittedPoints: corpus.currentPoints.length,
      tupleCount: corpus.currentTuples.length,
      bodyBytes: requests[0][0].length + suffixBuf.length,
      requests,
    };
  }

  if (scopeMode === 'narrow' || scopeMode === 'both') {
    const reelList = Array.from(corpus.chunksByReel.keys());
    if (reelList.length < 1)
      throw new Error('No CHUNK reels found for narrow scope');
    const actualScopeReels = Math.min(narrowReels, reelList.length);
    const requests = corpus.sampled.map((s, idx) => {
      const primaryReel = corpus.chunksByReel.has(s.reelId)
        ? s.reelId
        : reelList[idx % reelList.length];
      const others = reelList.filter((r) => r !== primaryReel);
      const shift = idx % Math.max(1, others.length);
      const pickedOthers = [
        ...others.slice(shift),
        ...others.slice(0, shift),
      ].slice(0, actualScopeReels - 1);
      const scopeReels = [primaryReel, ...pickedOthers];
      const tuples = [];
      const pointIds = [];
      for (const r of scopeReels) {
        const entry = corpus.chunksByReel.get(r);
        tuples.push(entry.tuple);
        pointIds.push(...entry.pointIds);
      }
      const body = {
        query: s.vector,
        params: { exact: true },
        limit,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            { has_id: pointIds },
            { key: 'kind', match: { value: 'CHUNK' } },
            { should: tuples.map(tupleFilter) },
          ],
        },
      };
      return [Buffer.from(JSON.stringify(body))];
    });
    const avgBytes = Math.round(
      requests.reduce((sum, parts) => sum + parts[0].length, 0) /
        requests.length,
    );
    workloads.narrow = {
      scope: 'narrow',
      scopeReels: actualScopeReels,
      bodyBytes: avgBytes,
      requests,
    };
  }

  return workloads;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return Number(sorted[idx].toFixed(2));
}

function summarizeTimes(times) {
  if (!times.length) {
    return {
      min: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
      mean: null,
    };
  }
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: Number(sorted[0].toFixed(2)),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    mean: Number((sum / sorted.length).toFixed(2)),
  };
}

async function measureRtts(agents, targets, apiKey, probes = 20) {
  const out = {};
  for (const target of targets) {
    const times = [];
    let errors = 0;
    // One throwaway connection warmup first so TLS handshake isn't mixed with RTT floor.
    await requestRaw(agents, target.url, apiKey, '/readyz', 'GET', null, 5000);
    for (let i = 0; i < probes; i++) {
      const res = await requestRaw(
        agents,
        target.url,
        apiKey,
        '/readyz',
        'GET',
        null,
        5000,
      );
      if (res.ok) times.push(res.ms);
      else errors++;
    }
    out[target.label] = { probes, errors, rttMs: summarizeTimes(times) };
  }
  return out;
}

async function runStage({
  agents,
  targets,
  apiKey,
  collection,
  workload,
  concurrency,
  warmupSeconds,
  durationSeconds,
  timeoutMs,
}) {
  const queryPath = `/collections/${collection}/points/query`;
  const reqPool = workload.requests;
  const now = Date.now();
  const warmupEnd = now + warmupSeconds * 1000;
  const measureEnd = warmupEnd + durationSeconds * 1000;

  let rrIndex = 0;
  let reqSeed = 0;
  const stats = {
    requests: 0,
    successes: 0,
    errors: 0,
    over250ms: 0,
    errorsByReason: {},
    times: [],
    byTarget: Object.fromEntries(
      targets.map((t) => [
        t.label,
        { requests: 0, successes: 0, errors: 0, over250ms: 0, times: [] },
      ]),
    ),
  };

  let actualMeasureStart = null;

  async function worker() {
    while (Date.now() < measureEnd) {
      const reqStart = Date.now();
      const target = targets[rrIndex++ % targets.length];
      const bodyParts = reqPool[reqSeed++ % reqPool.length];
      const res = await requestRaw(
        agents,
        target.url,
        apiKey,
        queryPath,
        'POST',
        bodyParts,
        timeoutMs,
      );
      if (reqStart < warmupEnd) continue;
      if (actualMeasureStart === null) actualMeasureStart = reqStart;

      let validOk = res.ok;
      let reason = res.reason;
      if (validOk) {
        try {
          const parsed = JSON.parse(res.body);
          if (parsed.status !== 'ok' || !Array.isArray(parsed.result?.points)) {
            validOk = false;
            reason = 'INVALID_ENVELOPE';
          }
        } catch {
          validOk = false;
          reason = 'INVALID_JSON';
        }
      }

      const tgt = stats.byTarget[target.label];
      stats.requests++;
      tgt.requests++;
      if (res.ms > 250) {
        stats.over250ms++;
        tgt.over250ms++;
      }
      if (validOk) {
        stats.successes++;
        stats.times.push(res.ms);
        tgt.successes++;
        tgt.times.push(res.ms);
      } else {
        stats.errors++;
        tgt.errors++;
        stats.errorsByReason[reason] = (stats.errorsByReason[reason] || 0) + 1;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const actualMeasureEnd = Date.now();
  const actualDurationSec = Math.max(
    0.001,
    (actualMeasureEnd - (actualMeasureStart ?? warmupEnd)) / 1000,
  );

  const targetSummary = {};
  for (const [label, t] of Object.entries(stats.byTarget)) {
    targetSummary[label] = {
      requests: t.requests,
      successes: t.successes,
      errors: t.errors,
      over250ms: t.over250ms,
      share: stats.requests
        ? Number((t.requests / stats.requests).toFixed(3))
        : 0,
      latencyMs: summarizeTimes(t.times),
    };
  }

  return {
    scope: workload.scope,
    concurrency,
    warmupSeconds,
    durationSeconds,
    actualDurationSec: Number(actualDurationSec.toFixed(3)),
    requests: stats.requests,
    successes: stats.successes,
    errors: stats.errors,
    over250ms: stats.over250ms,
    over250msRate: stats.requests
      ? Number((stats.over250ms / stats.requests).toFixed(4))
      : 0,
    qps: Number((stats.successes / actualDurationSec).toFixed(2)),
    totalQps: Number((stats.requests / actualDurationSec).toFixed(2)),
    errorsByReason: stats.errorsByReason,
    latencyMs: summarizeTimes(stats.times),
    targetDistribution: targetSummary,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/ops/qdrant-read-stress.cjs --targets=H1=https://qdrant:6333 [--scope=wide|narrow|both] [--concurrencies=1,2,4,8,16,32,64] [--warmup-seconds=10] [--duration-seconds=45] [--api-key-file=...] [--ca-file=...] [--tuples-file=...] [--sample-url=...] [--sample-size=500] [--narrow-reels=8] [--limit=100] [--timeout-ms=5000] [--label=C1]\n',
    );
    return;
  }

  const allowLocalHttp = process.env.QDRANT_ALLOW_LOCAL_HTTP === 'true';
  const targets = loadTargets(args.targets, allowLocalHttp);
  const sampleUrl = args['sample-url']
    ? validateUrl(args['sample-url'], allowLocalHttp)
    : targets[0].url;
  const collection =
    args.collection || process.env.QDRANT_COLLECTION || DEFAULT_COLLECTION;
  const apiKey = loadApiKey(
    args['api-key-file'] || process.env.QDRANT_API_KEY_FILE,
  );
  const caFile = args['ca-file'] || process.env.NODE_EXTRA_CA_CERTS;
  const scopeMode = args.scope || 'wide';
  if (!['wide', 'narrow', 'both'].includes(scopeMode)) {
    throw new Error('--scope must be wide, narrow, or both');
  }
  const concurrencies = (args.concurrencies || '1,2,4,8,16,32,64')
    .split(',')
    .map((v) => Number(v.trim()));
  if (
    !concurrencies.length ||
    concurrencies.some((c) => !Number.isInteger(c) || c < 1 || c > 512)
  ) {
    throw new Error('Invalid --concurrencies');
  }
  const warmupSeconds = Number(args['warmup-seconds'] ?? 10);
  const durationSeconds = Number(args['duration-seconds'] ?? 45);
  const sampleSize = Number(args['sample-size'] ?? 500);
  const narrowReels = Number(args['narrow-reels'] ?? 8);
  const limit = Number(args.limit ?? 100);
  const timeoutMs = Number(args['timeout-ms'] ?? 5000);

  const agents = createAgents(targets, caFile);
  try {
    const rtt = await measureRtts(agents, targets, apiKey, 20);
    const corpus = await loadCorpusAndSample({
      agents,
      sampleUrl,
      apiKey,
      collection,
      tuplesFile: args['tuples-file'],
      sampleSize,
    });
    const workloads = buildWorkloads(corpus, {
      scopeMode,
      narrowReels,
      limit,
    });

    const meta = {
      label: args.label || targets.map((t) => t.label).join('+'),
      collection,
      targets: targets.map((t) => ({ label: t.label, url: t.url.origin })),
      totalPointsInQdrant: corpus.totalPointsInQdrant,
      currentPoints: corpus.currentPoints.length,
      currentTuples: corpus.currentTuples.length,
      sampledVectors: corpus.sampled.length,
      limit,
      timeoutMs,
      rtt,
      workloads: Object.fromEntries(
        Object.entries(workloads).map(([k, w]) => [
          k,
          {
            scope: w.scope,
            admittedPoints: w.admittedPoints ?? null,
            tupleCount: w.tupleCount ?? null,
            scopeReels: w.scopeReels ?? null,
            bodyBytes: w.bodyBytes,
          },
        ]),
      ),
    };
    process.stdout.write(`META ${JSON.stringify(meta)}\n`);

    for (const scopeKey of Object.keys(workloads)) {
      const workload = workloads[scopeKey];
      for (const concurrency of concurrencies) {
        const stage = await runStage({
          agents,
          targets,
          apiKey,
          collection,
          workload,
          concurrency,
          warmupSeconds,
          durationSeconds,
          timeoutMs,
        });
        process.stdout.write(
          `STAGE ${JSON.stringify({ label: meta.label, ...stage })}\n`,
        );
      }
    }
  } finally {
    agents.httpsAgent?.destroy();
    agents.httpAgent.destroy();
  }
}

module.exports = {
  parseArgs,
  tupleFilter,
  summarizeTimes,
  buildWorkloads,
  loadTargets,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(
      JSON.stringify({
        error: 'qdrant-read-stress failed',
        detail:
          err instanceof Error
            ? err.message.replace(/\S+:\/\/\S+/g, '[url]')
            : 'unknown',
      }),
    );
    process.exitCode = 1;
  });
}
