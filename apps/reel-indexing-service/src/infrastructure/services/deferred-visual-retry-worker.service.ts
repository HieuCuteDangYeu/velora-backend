import { parseReelIndexWorkerLane } from '@common/processing/reel-media-queue.constants';
import { RetryDeferredVisualAnalysisUseCase } from '@indexing/application/use-cases/retry-deferred-visual-analysis.use-case';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const TICK_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Once a day, shortly after the visual provider's free allocation resets (00:00 UTC for Cloudflare Workers AI), re-analyses
 * reels that were indexed without visual scenes, for example because the allocation ran out during their upload.
 *
 * Runs in one process only: not in the LONG lane, and not twice when a process hosts several queue apps.
 * Settings: INDEX_DEFERRED_VISUAL_RETRY_ENABLED (default true), INDEX_DEFERRED_VISUAL_RETRY_MAX_REELS (default 4),
 * INDEX_DEFERRED_VISUAL_RETRY_START_UTC_MINUTE (default 15, minutes after 00:00 UTC),
 * INDEX_DEFERRED_VISUAL_RETRY_ATTEMPT_TIMEOUT_MS (default 900000).
 */
@Injectable()
export class DeferredVisualRetryWorker
  implements OnModuleInit, OnModuleDestroy
{
  private static started = false;
  private readonly logger = new Logger(DeferredVisualRetryWorker.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastRunDay?: string;
  private owner = false;

  constructor(
    private readonly config: ConfigService,
    private readonly retry: RetryDeferredVisualAnalysisUseCase,
  ) {}

  onModuleInit(): void {
    if (DeferredVisualRetryWorker.started || !this.enabled()) return;
    DeferredVisualRetryWorker.started = true;
    this.owner = true;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.owner) DeferredVisualRetryWorker.started = false;
  }

  /** One scheduling decision; exposed for tests. */
  async tick(now: Date = new Date()): Promise<boolean> {
    const day = now.toISOString().slice(0, 10);
    const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (
      this.busy ||
      this.lastRunDay === day ||
      minuteOfDay <
        this.integer(
          'INDEX_DEFERRED_VISUAL_RETRY_START_UTC_MINUTE',
          15,
          0,
          1439,
        )
    ) {
      return false;
    }
    this.busy = true;
    this.lastRunDay = day;
    try {
      await this.retry.execute({
        maxReels: this.integer(
          'INDEX_DEFERRED_VISUAL_RETRY_MAX_REELS',
          4,
          1,
          32,
        ),
        attemptTimeoutMs: this.integer(
          'INDEX_DEFERRED_VISUAL_RETRY_ATTEMPT_TIMEOUT_MS',
          15 * 60 * 1000,
          60_000,
          60 * 60 * 1000,
        ),
        pollIntervalMs: 15_000,
        maxRecentAttempts: 3,
        recentWindowMs: 7 * DAY_MS,
      });
    } catch (error: unknown) {
      this.logger.warn(
        `deferred_visual_run_failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy = false;
    }
    return true;
  }

  private enabled(): boolean {
    const flag = this.config
      .get<string>('INDEX_DEFERRED_VISUAL_RETRY_ENABLED')
      ?.trim()
      .toLowerCase();
    if (flag === 'false' || flag === '0') return false;
    return (
      parseReelIndexWorkerLane(this.config.get<string>('INDEX_WORKER_LANE')) !==
      'LONG'
    );
  }

  private integer(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(this.config.get<string>(key));
    return Number.isInteger(value) && value >= min && value <= max
      ? value
      : fallback;
  }
}
