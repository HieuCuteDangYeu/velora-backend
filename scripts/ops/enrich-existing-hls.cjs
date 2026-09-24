require('dotenv').config();

const { PrismaClient } = require('@prisma/content-client');
const { publishRmqMessage } = require('../send-rmq-message.cjs');

function parseArgs(argv) {
  const options = { apply: false, limit: 1, seriesId: undefined };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--resume') options.apply = true;
    else if (arg.startsWith('--limit=')) {
      options.limit = Number(arg.slice('--limit='.length));
    } else if (arg.startsWith('--series-id=')) {
      options.seriesId = arg.slice('--series-id='.length).trim();
    } else if (arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error('--limit must be an integer between 1 and 100');
  }
  if (options.seriesId !== undefined && !options.seriesId) {
    throw new Error('--series-id must not be empty');
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      'Enrich metadata-only Reels from their existing R2 HLS master playlists.',
      '',
      'Preview (default): pnpm ops:enrich:hls -- --dry-run [--series-id=<id>] [--limit=5]',
      'Queue/resume:      pnpm ops:enrich:hls -- --resume --limit=1 [--series-id=<id>]',
      '',
      'Each queued Reel uses the existing media outbox and indexing pipeline.',
    ].join('\n') + '\n',
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const prisma = new PrismaClient();
  try {
    const activeWork = await prisma.reel.findMany({
      where: {
        hlsMasterKey: { not: null },
        OR: [
          { mediaStatus: { in: ['PENDING', 'PROCESSING'] } },
          {
            mediaStatus: 'COMPLETED',
            indexStatus: { in: ['PENDING', 'PROCESSING'] },
          },
        ],
        ...(options.seriesId ? { seriesId: options.seriesId } : {}),
      },
      select: { id: true, mediaStatus: true, indexStatus: true },
    });
    const candidates = await prisma.reel.findMany({
      where: {
        mediaStatus: { in: ['COMPLETED', 'FAILED'] },
        hlsMasterKey: { not: null },
        OR: [
          { transcriptionAudioManifestKey: null },
          { visualFrameManifestKey: null },
        ],
        ...(options.seriesId ? { seriesId: options.seriesId } : {}),
      },
      orderBy: [{ seriesId: 'asc' }, { episodeNumber: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        seriesId: true,
        episodeNumber: true,
        title: true,
      },
    });
    const selected = candidates.slice(0, options.limit);
    const result = {
      mode: options.apply ? 'APPLY' : 'DRY_RUN',
      seriesId: options.seriesId ?? null,
      eligibleReels: candidates.length,
      selectedReels: selected.length,
      resumeSafe: true,
      activeHlsOrIndexJobs: activeWork.length,
      blockedByActiveWork: options.apply && activeWork.length > 0,
      reels: selected.map((reel) => ({
        reelId: reel.id,
        seriesId: reel.seriesId,
        episodeNumber: reel.episodeNumber,
        title: reel.title,
      })),
      queued: [],
    };

    if (options.apply && activeWork.length === 0) {
      for (const reel of selected) {
        const response = await publishRmqMessage({
          queue: 'content_queue',
          pattern: 'content.enrich_reel_from_hls',
          payload: { reelId: reel.id },
          timeoutMs: 30_000,
        });
        result.queued.push({
          reelId: reel.id,
          queued: response?.queued === true,
          reason: response?.reason,
          mediaAttemptId: response?.mediaAttemptId,
        });
      }
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (options.apply && result.queued.some((item) => !item.queued && !item.reason)) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `HLS enrichment failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
