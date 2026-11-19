require('dotenv').config();

const { publishRmqMessage } = require('../send-rmq-message.cjs');

const PER_REEL_TIMEOUT_MS = 60 * 60 * 1000; // a long talk is many 100-line requests per language (see the subtitle adapter)

function parseArgs(argv) {
  const options = { apply: false, limit: 10, after: undefined, help: false };
  for (const arg of argv) {
    if (arg === '--apply' || arg === '--resume') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--after=')) options.after = arg.slice('--after='.length).trim();
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new Error('--limit must be an integer between 1 and 500');
  }
  if (options.after !== undefined && !options.after) {
    throw new Error('--after must not be empty');
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      'Translate the subtitles of Reels that were processed before translation ran on completion.',
      '',
      'Preview (default): pnpm ops:pretranslate:subtitles -- --dry-run [--limit=10] [--after=<reelId>]',
      'Run:               pnpm ops:pretranslate:subtitles -- --apply --limit=10 [--after=<reelId>]',
      '',
      'Reels are taken newest first and handled one at a time, so the AI service is never flooded and live',
      'reels interleave with the backlog. Reels that already have up-to-date translations are skipped quickly,',
      'so re-running is safe. Press Ctrl-C to stop after the current reel; the output prints the --after value',
      'to continue from. Needs the content database (CONTENT_DATABASE_URL) and RabbitMQ (RABBITMQ_URL).',
    ].join('\n') + '\n',
  );
}

/** One line per reel for the progress log. */
function describeResult(result) {
  if (result?.skipped) return `skipped (${result.skipped})`;
  const parts = [];
  for (const [label, languages] of [
    ['translated', result?.translated],
    ['stored', result?.alreadyStored],
    ['FAILED', result?.failed],
  ]) {
    if (Array.isArray(languages) && languages.length > 0) {
      parts.push(`${label} ${languages.join(',')}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : 'nothing to translate';
}

function summarize(results) {
  const total = { translated: 0, alreadyStored: 0, failed: 0, skipped: 0, reelsWithFailures: 0 };
  for (const { result } of results) {
    if (result?.skipped) total.skipped += 1;
    total.translated += result?.translated?.length ?? 0;
    total.alreadyStored += result?.alreadyStored?.length ?? 0;
    const failed = result?.failed?.length ?? 0;
    total.failed += failed;
    if (failed > 0 || result?.skipped === 'error') total.reelsWithFailures += 1;
  }
  return total;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const { PrismaClient } = require('@prisma/content-client');
  const prisma = new PrismaClient();
  let stopRequested = false;
  process.on('SIGINT', () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    process.stderr.write('\nStopping after the current reel (press Ctrl-C again to quit now)...\n');
  });

  try {
    // The transcript column is only set when the transcript passed the quality check; the service re-checks anyway.
    const where = { transcript: { not: null } };
    const eligibleReels = await prisma.reel.count({ where });
    const selected = await prisma.reel.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.limit,
      ...(options.after ? { cursor: { id: options.after }, skip: 1 } : {}),
      select: { id: true, title: true, createdAt: true },
    });

    const stored = await prisma.reelSubtitleTrack.groupBy({
      by: ['reelId'],
      where: { reelId: { in: selected.map((reel) => reel.id) } },
      _count: { _all: true },
    });
    const storedByReel = new Map(stored.map((row) => [row.reelId, row._count._all]));

    const report = {
      mode: options.apply ? 'APPLY' : 'DRY_RUN',
      eligibleReelsWithTranscript: eligibleReels,
      selectedReels: selected.length,
      selectedAlreadyHaveATranslation: selected.filter((reel) => storedByReel.has(reel.id)).length,
      after: options.after ?? null,
      results: [],
    };

    if (!options.apply) {
      report.reels = selected.map((reel) => ({
        reelId: reel.id,
        title: reel.title,
        storedTranslations: storedByReel.get(reel.id) ?? 0,
      }));
    } else {
      for (const [index, reel] of selected.entries()) {
        if (stopRequested) break;
        let result;
        try {
          result = await publishRmqMessage({
            queue: 'content_queue',
            pattern: 'content.pre_translate_reel_subtitles',
            payload: { reelId: reel.id },
            timeoutMs: PER_REEL_TIMEOUT_MS,
          });
        } catch (error) {
          result = { skipped: 'error', failed: [], translated: [], alreadyStored: [] };
          process.stderr.write(
            `  request failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
        report.results.push({ reelId: reel.id, result });
        process.stderr.write(
          `[${index + 1}/${selected.length}] ${reel.id} ${describeResult(result)}\n`,
        );
      }
      report.summary = summarize(report.results);
      const last = report.results.at(-1);
      report.resumeWith = last ? `--after=${last.reelId}` : null;
      report.finishedCatalogue = !stopRequested && selected.length < options.limit;
      if (report.summary.reelsWithFailures > 0) process.exitCode = 1;
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `Subtitle pre-translation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = { describeResult, parseArgs, summarize };
