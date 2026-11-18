#!/usr/bin/env node
// Sustained publish test: publishes reels at a steady rate below the gateway (synthetic users, so
// the gateway's 20 publishes/hour/user rule is not in play), records create latency and errors, then
// waits for the media backlog to finish and reports how long that took.
//
//   node scripts/ops/reel-publish-rate.cjs <ratePerMin> <durationSec> <runId> <clip.mp4> <clipDurationMs>
//
// Environment: RABBITMQ_URL (SSH tunnel), R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET_NAME, and REEL_INDEX_SKIP_TAG = the value set in the homelab .env, so the test reels
// never reach the indexer (otherwise every 96 s reel spends ~59k Groq vision tokens). Use a short
// clip (6 s) to measure acceptance and queue behaviour; the media backlog then drains at ~14 reels/min.
// Clean up afterwards: node scripts/ops/reel-create-burst.cjs cleanup --run-id=<runId>
// Measured 2026-11-19: 30, 60 and 120 publishes/min were all accepted with 0 errors (p95 < 0.8 s).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const [rateArg, durArg, runId, file, clipMsArg] = process.argv.slice(2);
const RATE = Number(rateArg),
  DUR = Number(durArg),
  clipMs = Number(clipMsArg);
const N = Math.round((RATE * DUR) / 60);
const skipTag = (process.env.REEL_INDEX_SKIP_TAG || '').trim();
if (!rateArg || !durArg || !runId || !file || !clipMsArg || !skipTag) {
  console.error(
    'usage: REEL_INDEX_SKIP_TAG=<tag> node reel-publish-rate.cjs <ratePerMin> <durationSec> <runId> <clip.mp4> <clipDurationMs>',
  );
  process.exit(2);
}
const stateFile = path.join(os.tmpdir(), `reel-create-burst-${runId}.json`);
const outFile = path.join(
  process.env.REEL_RATE_OUT_DIR || os.tmpdir(),
  `reel-publish-rate-${runId}.json`,
);
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { ClientProxyFactory, Transport } = require('@nestjs/microservices');
const { firstValueFrom, timeout } = require('rxjs');
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const content = ClientProxyFactory.create({
  transport: Transport.RMQ,
  options: {
    urls: [process.env.RABBITMQ_URL],
    queue: 'content_queue',
    queueOptions: { durable: true },
  },
});
const rpc = (p, d, ms = 30000) =>
  firstValueFrom(content.send(p, d).pipe(timeout(ms)));
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
(async () => {
  const body = fs.readFileSync(file);
  const entries = Array.from({ length: N }, () => {
    const userId = randomUUID();
    return { userId, mediaKey: `reels/${userId}/${randomUUID()}.mp4` };
  });
  for (let i = 0; i < entries.length; i += 8)
    await Promise.all(
      entries
        .slice(i, i + 8)
        .map((e) =>
          s3.send(
            new PutObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: e.mediaKey,
              Body: body,
              ContentType: 'video/mp4',
            }),
          ),
        ),
    );
  fs.writeFileSync(stateFile, JSON.stringify({ runId, entries }, null, 2));
  await content.connect();
  const lat = [],
    errs = [];
  const t0 = Date.now();
  const gap = 60000 / RATE;
  const inflight = [];
  for (let i = 0; i < N; i += 1) {
    const due = t0 + i * gap;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const e = entries[i];
    const begin = Date.now();
    inflight.push(
      rpc('content.create_reel', {
        userId: e.userId,
        payload: {
          mediaKey: e.mediaKey,
          title: `[IT:${runId}] rate #${i + 1}`,
          description: 'sustained publish test (private, to be purged)',
          tags: ['integration-test', `run-${runId}`, skipTag],
          visibility: 'private',
          clientObservedDurationMs: clipMs,
        },
      })
        .then((reel) => {
          e.reelId = reel.id;
          lat.push(Date.now() - begin);
        })
        .catch((err) => {
          errs.push(
            String(err.message || err.stack || JSON.stringify(err)).slice(
              0,
              100,
            ),
          );
        }),
    );
  }
  await Promise.all(inflight);
  const lastCreate = Date.now();
  fs.writeFileSync(stateFile, JSON.stringify({ runId, entries }, null, 2));
  const ids = entries.filter((e) => e.reelId);
  const ready = new Map();
  const deadline = Date.now() + 25 * 60000;
  while (ready.size < ids.length && Date.now() < deadline) {
    await Promise.all(
      ids
        .filter((e) => !ready.has(e.reelId))
        .map(async (e) => {
          try {
            const s = await rpc(
              'content.get_reel_status',
              { reelId: e.reelId },
              20000,
            );
            if (s.mediaStatus === 'COMPLETED' || s.mediaStatus === 'FAILED')
              ready.set(e.reelId, {
                at: Date.now(),
                failed: s.mediaStatus === 'FAILED',
              });
          } catch {}
        }),
    );
    await new Promise((r) => setTimeout(r, 3000));
  }
  const readyAt = [...ready.values()].map((v) => (v.at - t0) / 1000);
  const summary = {
    runId,
    targetRatePerMin: RATE,
    durationSec: DUR,
    requested: N,
    created: lat.length,
    createErrors: errs.length,
    firstErrors: [...new Set(errs)].slice(0, 3),
    createMs: {
      p50: pct(lat, 50),
      p95: pct(lat, 95),
      max: Math.max(0, ...lat),
    },
    actualCreateSeconds: (lastCreate - t0) / 1000,
    mediaReady: ready.size,
    mediaFailed: [...ready.values()].filter((v) => v.failed).length,
    stuck: ids.length - ready.size,
    backlogDrainSecondsAfterLastCreate: readyAt.length
      ? Math.max(...readyAt) - (lastCreate - t0) / 1000
      : null,
    readyFirstS: readyAt.length ? Math.min(...readyAt) : null,
    readyLastS: readyAt.length ? Math.max(...readyAt) : null,
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
