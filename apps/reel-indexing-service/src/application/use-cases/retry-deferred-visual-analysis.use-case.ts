import type { IIndexingContentService } from '@indexing/domain/interfaces/content-service.interface';
import type { IDeferredVisualAnalysisRepository } from '@indexing/domain/interfaces/deferred-visual-analysis.repository.interface';
import { isDeferredProviderQuotaFailure } from '@indexing/application/use-cases/process-reel-index-job.use-case';
import { Inject, Injectable, Logger } from '@nestjs/common';

export interface RetryDeferredVisualAnalysisOptions {
  maxReels: number;
  /** How long one re-index attempt may run before the run stops for the day. */
  attemptTimeoutMs: number;
  pollIntervalMs: number;
  /** A reel with this many attempts inside the window is left alone, so a reel that can never be analysed is not retried daily. */
  maxRecentAttempts: number;
  recentWindowMs: number;
}

export type RetryDeferredVisualAnalysisStop =
  | 'LIMIT'
  | 'NONE_LEFT'
  | 'QUOTA'
  | 'FAILURE'
  | 'TIMEOUT';

export interface RetryDeferredVisualAnalysisResult {
  completed: number;
  attempted: number;
  stoppedBecause: RetryDeferredVisualAnalysisStop;
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'DEGRADED', 'FAILED']);
const CONSECUTIVE_FAILURE_LIMIT = 2;

/**
 * Re-indexes reels that lack visual scenes, one at a time, with visual analysis required so a failed attempt leaves the
 * current index untouched. It stops as soon as the provider reports its allocation is spent, so the next run (after the
 * allocation resets) continues from the same list.
 */
@Injectable()
export class RetryDeferredVisualAnalysisUseCase {
  private readonly logger = new Logger(RetryDeferredVisualAnalysisUseCase.name);

  constructor(
    @Inject('IDeferredVisualAnalysisRepository')
    private readonly repository: IDeferredVisualAnalysisRepository,
    @Inject('IIndexingContentService')
    private readonly content: IIndexingContentService,
  ) {}

  async execute(
    options: RetryDeferredVisualAnalysisOptions,
    dependencies: {
      now?: () => number;
      sleep?: (milliseconds: number) => Promise<void>;
    } = {},
  ): Promise<RetryDeferredVisualAnalysisResult> {
    const now = dependencies.now ?? (() => Date.now());
    const sleep =
      dependencies.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const tried: string[] = [];
    let completed = 0;
    let consecutiveFailures = 0;

    while (tried.length < options.maxReels) {
      const [reelId] = await this.repository.findReelsAwaitingVisualAnalysis({
        limit: 1,
        excludeReelIds: tried,
        recentSince: new Date(now() - options.recentWindowMs),
        maxRecentAttempts: options.maxRecentAttempts,
      });
      if (!reelId) {
        return this.result(completed, tried.length, 'NONE_LEFT');
      }
      tried.push(reelId);

      const queued = await this.content.reindexReel(reelId, {
        requireVisualAnalysis: true,
      });
      if (!queued.queued || !queued.indexAttemptId) {
        this.logger.warn(`deferred_visual_not_queued reelId=${reelId}`);
        continue;
      }

      const outcome = await this.waitForOutcome(
        queued.indexAttemptId,
        options,
        now,
        sleep,
      );
      if (!outcome) return this.result(completed, tried.length, 'TIMEOUT');

      if (outcome.status !== 'FAILED') {
        completed += 1;
        consecutiveFailures = 0;
        continue;
      }
      if (isDeferredProviderQuotaFailure(outcome.lastError ?? '')) {
        this.logger.log(
          `deferred_visual_quota_spent reelId=${reelId}; stopping until the allocation resets`,
        );
        return this.result(completed, tried.length, 'QUOTA');
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        return this.result(completed, tried.length, 'FAILURE');
      }
    }
    return this.result(completed, tried.length, 'LIMIT');
  }

  private async waitForOutcome(
    indexAttemptId: string,
    options: RetryDeferredVisualAnalysisOptions,
    now: () => number,
    sleep: (milliseconds: number) => Promise<void>,
  ) {
    const deadline = now() + options.attemptTimeoutMs;
    for (;;) {
      await sleep(options.pollIntervalMs);
      const outcome = await this.repository.getAttemptOutcome(indexAttemptId);
      if (outcome && TERMINAL_STATUSES.has(outcome.status)) return outcome;
      if (now() >= deadline) return undefined;
    }
  }

  private result(
    completed: number,
    attempted: number,
    stoppedBecause: RetryDeferredVisualAnalysisStop,
  ): RetryDeferredVisualAnalysisResult {
    this.logger.log(
      `deferred_visual_run completed=${completed} attempted=${attempted} stopped=${stoppedBecause}`,
    );
    return { completed, attempted, stoppedBecause };
  }
}
