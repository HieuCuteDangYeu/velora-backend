import { PreTranslateReelSubtitlesUseCase } from '@content/application/use-cases/pre-translate-reel-subtitles.use-case';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// Small batches: each reel is several local-model calls, and viewers' on-demand translations share that model.
const SWEEP_BATCH = 5;
const SWEEP_WINDOW_DAYS = 30;

/**
 * Translates subtitles for indexed reels that have none. Translation normally starts when indexing completes, but that
 * queue lives in memory: a restart or deploy drops it, and a failed language is not retried (12 of 226 reels with a transcript indexed
 * between 2026-11-06 and 2026-11-26 had no translation).
 */
@Injectable()
export class SubtitleTranslationSweepService {
  private readonly logger = new Logger(SubtitleTranslationSweepService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly preTranslate: PreTranslateReelSubtitlesUseCase,
  ) {}

  @Interval(SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const since = new Date(
        Date.now() - SWEEP_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT r.id
        FROM "Reel" r
        WHERE r."indexCompletedAt" > ${since}
          AND jsonb_typeof(r."transcriptSegments") = 'array'
          AND jsonb_array_length(r."transcriptSegments") > 0
          AND NOT EXISTS (SELECT 1 FROM "ReelSubtitleTrack" t WHERE t."reelId" = r.id)
        ORDER BY r."indexCompletedAt" DESC
        LIMIT ${SWEEP_BATCH}`;
      for (const { id } of rows) {
        const result = await this.preTranslate.execute(id);
        this.logger.log(
          `[SubtitleSweep] reel=${id} translated=${result.translated.join(',') || '-'} failed=${result.failed.join(',') || '-'}${result.skipped ? ` skipped=${result.skipped}` : ''}`,
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        `[SubtitleSweep] ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.sweeping = false;
    }
  }
}
