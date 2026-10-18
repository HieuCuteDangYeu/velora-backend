#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_LIMIT = 8;
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STATE_FILE = path.join(
  os.homedir(),
  'Library/Application Support/Velora/visual-reindex/state.json',
);
const DEFAULT_LOCK_FILE = path.join(
  os.homedir(),
  'Library/Application Support/Velora/visual-reindex/run.lock',
);

const CONTENT_CONTAINER =
  process.env.VISUAL_REINDEX_CONTENT_CONTAINER ||
  'microservices-boilerplate-content-service-1';
const INDEX_CONTAINER =
  process.env.VISUAL_REINDEX_INDEX_CONTAINER ||
  'microservices-boilerplate-reel-indexing-service-1';

const CONTENT_QUERY = String.raw`
const { PrismaClient } = require('@prisma/content-client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.reel.findMany({
    where: {
      status: 'COMPLETED',
      mediaStatus: 'COMPLETED',
      indexStatus: { in: ['COMPLETED', 'DEGRADED', 'FAILED'] },
      visualFrameManifestKey: { not: null },
    },
    select: { id: true, title: true, createdAt: true, indexStatus: true, indexVersion: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  process.stdout.write(JSON.stringify(rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }))));
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
`;

const INDEX_QUERY = String.raw`
const { PrismaClient } = require('@prisma/reel-indexing-client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.reelVisualScene.groupBy({
    by: ['reelId'],
    where: { isActive: true },
    _count: { _all: true },
  });
  process.stdout.write(JSON.stringify(rows.map((row) => ({
    reelId: row.reelId,
    count: row._count._all,
  }))));
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
`;

const DISPATCH = String.raw`
const fs = require('node:fs');
const { ClientProxyFactory, Transport } = require('@nestjs/microservices');
const { firstValueFrom, timeout } = require('rxjs');
const input = JSON.parse(process.env.VISUAL_REINDEX_INPUT || '{}');
const client = ClientProxyFactory.create({
  transport: Transport.RMQ,
  options: {
    urls: [process.env.RABBITMQ_URL],
    queue: 'reel_index_query',
    queueOptions: { durable: true },
    heartbeat: Number(process.env.RABBITMQ_HEARTBEAT_SECONDS || 300),
  },
});
(async () => {
  await client.connect();
  const results = [];
  for (const reel of input.reels) {
    try {
      const result = await firstValueFrom(client.send('index.reindex_reel', {
        reelId: reel.id,
        expectedEmbeddingIdentity: input.identity,
        requireVisualAnalysis: true,
      }).pipe(timeout(Number(process.env.RMQ_TIMEOUT_MS || 300000))));
      results.push({ reelId: reel.id, ...result });
    } catch (error) {
      results.push({
        reelId: reel.id,
        queued: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  process.stdout.write(JSON.stringify({ results }));
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => client.close());
`;

function parseArgs(argv) {
  const args = { apply: false, limit: DEFAULT_LIMIT };
  for (const value of argv) {
    if (value === '--apply') args.apply = true;
    if (value === '--dry-run') args.apply = false;
    if (value.startsWith('--limit=')) args.limit = Number(value.slice('--limit='.length));
  }
  return args;
}

function positiveLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) {
    throw new Error('limit must be an integer between 1 and 32');
  }
  return limit;
}

function selectCandidates(reels, visualSceneCounts, limit) {
  const countByReelId = new Map(
    visualSceneCounts.map((row) => [row.reelId, Number(row.count)]),
  );
  return reels
    .filter((reel) => !countByReelId.has(reel.id))
    .slice(0, limit);
}

function executable(name, candidates) {
  const selected = candidates.find((candidate) => fs.existsSync(candidate));
  if (!selected) throw new Error(`Cannot find ${name}`);
  return selected;
}

function runContainerNode(container, source, environment = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(container)) {
    throw new Error(`Invalid container name: ${container}`);
  }
  const docker = process.env.DOCKER_BIN || executable('docker', [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    'docker',
  ]);
  const environmentArgs = Object.entries(environment).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ]);
  const result = spawnSync(docker, ['exec', '-i', ...environmentArgs, container, 'node', '-'], {
    input: source,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${container} command failed: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  const rawOutput = result.stdout.trim();
  const jsonCandidates = [
    rawOutput,
    ...rawOutput
      .split(/\r?\n/)
      .reverse()
      .map((line) => line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '').trim())
      .filter((line) => line.startsWith('{') || line.startsWith('[')),
  ];
  for (const candidate of jsonCandidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  {
    throw new Error(
      `${container} command returned invalid JSON (status=${result.status}): ${JSON.stringify((result.stderr || '').slice(0, 240))} stdout=${JSON.stringify(rawOutput.slice(0, 240))}`,
    );
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const handle = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return () => {
      try { fs.closeSync(handle); } catch {}
      try { fs.unlinkSync(file); } catch {}
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age <= STALE_LOCK_MS) throw new Error('another visual reindex run is active');
    // shortcut: a six-hour stale lock is treated as abandoned; shorten this if a batch can run longer.
    fs.unlinkSync(file);
    return acquireLock(file);
  }
}

function embeddingIdentity() {
  const model = process.env.AI_EMBEDDING_MODEL?.trim();
  const version = process.env.AI_EMBEDDING_VERSION?.trim();
  const dimensions = Number(process.env.AI_EMBEDDING_DIMENSIONS);
  if (!model || !version || !Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error('AI_EMBEDDING_MODEL, AI_EMBEDDING_VERSION, and AI_EMBEDDING_DIMENSIONS are required');
  }
  return { model, version, dimensions };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const limit = positiveLimit(args.limit);
  const stateFile = path.resolve(process.env.VISUAL_REINDEX_STATE_FILE || DEFAULT_STATE_FILE);
  const lockFile = path.resolve(process.env.VISUAL_REINDEX_LOCK_FILE || DEFAULT_LOCK_FILE);
  const release = acquireLock(lockFile);
  try {
    const reels = runContainerNode(CONTENT_CONTAINER, CONTENT_QUERY);
    const visualSceneCounts = runContainerNode(INDEX_CONTAINER, INDEX_QUERY);
    const candidates = selectCandidates(reels, visualSceneCounts, limit);
    const report = {
      runId: `visual-reindex-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      generatedAt: new Date().toISOString(),
      mode: args.apply ? 'apply' : 'dry-run',
      limit,
      eligibleReels: reels.length,
      activeVisualReelCount: visualSceneCounts.length,
      selected: candidates,
    };
    if (args.apply && candidates.length) {
      const dispatch = runContainerNode(
        CONTENT_CONTAINER,
        DISPATCH,
        {
          VISUAL_REINDEX_INPUT: JSON.stringify({
            reels: candidates,
            identity: embeddingIdentity(),
          }),
        },
      );
      report.dispatch = dispatch;
      report.queuedCount = dispatch.results.filter((result) => result.queued).length;
      report.failedCount = candidates.length - report.queuedCount;
    } else {
      report.dispatch = { results: [] };
      report.queuedCount = 0;
      report.failedCount = 0;
    }
    writeJsonAtomic(stateFile, report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (args.apply && report.failedCount > 0) process.exitCode = 1;
  } finally {
    release();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Visual reindex failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  positiveLimit,
  selectCandidates,
};
