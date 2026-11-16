#!/usr/bin/env node
/*
 * Concurrent reel-creation burst that goes BELOW the API gateway.
 *
 * The gateway rate-limits publishing per user (content_publish_user, 20/hour), so one
 * test account cannot reproduce many people publishing at the same moment. This script
 * uploads a small clip to R2 under N synthetic user ids and sends N `content.create_reel`
 * messages to content-service at once, exercising the code that serialises on the database
 * connection pool (advisory lock, R2 HEAD, inserts, outbox event) plus the media/index hand-off.
 * It does not cover JWT, the gateway or its rate limiter.
 *
 *   run:     node scripts/ops/reel-create-burst.cjs run --users=12 --file=clip.mp4 --run-id=burst1
 *   cleanup: node scripts/ops/reel-create-burst.cjs cleanup --run-id=burst1   (after the reels finished processing)
 *   plan:    add --dry-run to print what would happen without touching anything
 *
 * Environment: RABBITMQ_URL, R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
 * Run it from a checkout with node_modules (NODE_PATH=<repo>/node_modules works from elsewhere).
 * Reels are private and titled "[IT:<runId>] ...". Never run it while a benchmark is using production.
 *
 * The clip duration is sent as clientObservedDurationMs, read with ffprobe or given with
 * --duration-ms. Without it content-service cannot tell the clip is short and queues the job on
 * the LONG media lane, so a short-lane test would never touch the short workers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const runId = opt('run-id', 'burst');
const users = Number(opt('users', 12));
const file = opt('file');
const timeoutMs = Number(opt('timeout-ms', 60000));
const stateFile = opt(
  'state',
  path.join(os.tmpdir(), `reel-create-burst-${runId}.json`),
);
const dryRun = flag('dry-run');

function clipDurationMs() {
  if (opt('duration-ms')) return Number(opt('duration-ms'));
  try {
    const out = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        file,
      ],
      { encoding: 'utf8' },
    );
    const ms = Math.round(parseFloat(out) * 1000);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
}

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    'usage: reel-create-burst.cjs run --users=N --file=clip.mp4 [--run-id=ID] [--dry-run]',
  );
  console.error(
    '       reel-create-burst.cjs cleanup [--run-id=ID] [--dry-run]',
  );
  process.exit(2);
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) usage(`missing environment: ${missing.join(', ')}`);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

function s3() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

function rmq(queue) {
  const { ClientProxyFactory, Transport } = require('@nestjs/microservices');
  return ClientProxyFactory.create({
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL],
      queue,
      queueOptions: { durable: true },
    },
  });
}

async function send(client, pattern, payload) {
  const { firstValueFrom, timeout } = require('rxjs');
  return firstValueFrom(client.send(pattern, payload).pipe(timeout(timeoutMs)));
}

async function run() {
  if (!file || !fs.existsSync(file))
    usage('--file must point to an existing mp4');
  if (!Number.isInteger(users) || users < 1 || users > 50)
    usage('--users must be 1..50');
  const entries = Array.from({ length: users }, () => {
    const userId = randomUUID();
    return { userId, mediaKey: `reels/${userId}/${randomUUID()}.mp4` };
  });
  const durationMs = clipDurationMs();
  if (durationMs === undefined) {
    console.error(
      'warning: clip duration unknown (install ffprobe or pass --duration-ms); jobs will use the LONG media lane',
    );
  }
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: 'run',
          dryRun: true,
          runId,
          users,
          file,
          durationMs,
          sample: entries[0],
          stateFile,
        },
        null,
        2,
      ),
    );
    return;
  }
  requireEnv([
    'RABBITMQ_URL',
    'R2_ACCOUNT_ID',
    'R2_BUCKET_NAME',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ]);

  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const storage = s3();
  const body = fs.readFileSync(file);
  for (const entry of entries) {
    await storage.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: entry.mediaKey,
        Body: body,
        ContentType: 'video/mp4',
      }),
    );
  }
  console.log(`uploaded ${entries.length} source objects`);
  fs.writeFileSync(stateFile, JSON.stringify({ runId, entries }, null, 2));

  const content = rmq('content_queue');
  await content.connect();
  const started = Date.now();
  const results = await Promise.all(
    entries.map(async (entry, index) => {
      const begin = Date.now();
      try {
        const reel = await send(content, 'content.create_reel', {
          userId: entry.userId,
          payload: {
            mediaKey: entry.mediaKey,
            title: `[IT:${runId}] below-gateway burst #${index + 1}`,
            description: 'create burst test (private, to be purged)',
            tags: ['integration-test', `run-${runId}`],
            visibility: 'private',
            ...(durationMs ? { clientObservedDurationMs: durationMs } : {}),
          },
        });
        entry.reelId = reel.id;
        return { index: index + 1, ok: true, ms: Date.now() - begin };
      } catch (error) {
        return {
          index: index + 1,
          ok: false,
          ms: Date.now() - begin,
          error: String(error && (error.message || error)).slice(0, 160),
        };
      }
    }),
  );
  const totalMs = Date.now() - started;
  fs.writeFileSync(stateFile, JSON.stringify({ runId, entries }, null, 2));
  await content.close();

  const okMs = results.filter((r) => r.ok).map((r) => r.ms);
  console.log(
    JSON.stringify(
      {
        runId,
        users,
        totalMs,
        ok: okMs.length,
        failed: results.length - okMs.length,
        latencyMs: {
          p50: percentile(okMs, 50),
          p95: percentile(okMs, 95),
          max: okMs.length ? Math.max(...okMs) : null,
        },
        errors: [
          ...new Set(results.filter((r) => !r.ok).map((r) => r.error)),
        ].slice(0, 5),
        stateFile,
      },
      null,
      2,
    ),
  );
  console.log(
    'Wait for the reels to finish processing (about 2 minutes), then run: cleanup --run-id=' +
      runId,
  );
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

async function cleanup() {
  if (!fs.existsSync(stateFile)) usage(`no state file at ${stateFile}`);
  const { entries } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: 'cleanup',
          dryRun: true,
          reels: entries.filter((e) => e.reelId).length,
          sources: entries.length,
        },
        null,
        2,
      ),
    );
    return;
  }
  requireEnv([
    'RABBITMQ_URL',
    'R2_ACCOUNT_ID',
    'R2_BUCKET_NAME',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ]);

  const content = rmq('content_queue');
  const index = rmq('reel_index_query');
  await Promise.all([content.connect(), index.connect()]);
  let reelsDeleted = 0;
  let indexRowsDeleted = 0;
  for (const entry of entries.filter((e) => e.reelId)) {
    try {
      await send(content, 'content.delete_reel', {
        reelId: entry.reelId,
        userId: entry.userId,
      });
      reelsDeleted += 1;
    } catch (error) {
      console.error(
        `delete_reel ${entry.reelId}: ${String(error && (error.message || error)).slice(0, 120)}`,
      );
    }
    try {
      const result = await send(index, 'index.delete_reel', {
        reelId: entry.reelId,
      });
      if (result && result.deleted) indexRowsDeleted += 1;
    } catch (error) {
      console.error(
        `index.delete_reel ${entry.reelId}: ${String(error && (error.message || error)).slice(0, 120)}`,
      );
    }
  }
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const storage = s3();
  for (const entry of entries) {
    await storage.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: entry.mediaKey,
      }),
    );
  }
  await Promise.all([content.close(), index.close()]);
  console.log(
    JSON.stringify(
      { reelsDeleted, indexRowsDeleted, sourcesDeleted: entries.length },
      null,
      2,
    ),
  );
  fs.unlinkSync(stateFile);
}

(mode === 'run'
  ? run()
  : mode === 'cleanup'
    ? cleanup()
    : Promise.resolve(usage())
)
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    console.error('ERR', error && (error.stack || error.message || error));
    process.exit(1);
  });
