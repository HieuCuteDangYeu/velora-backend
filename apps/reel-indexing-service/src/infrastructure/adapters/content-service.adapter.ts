import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import type { IndexCheckpointStage } from '@indexing/domain/entities/index-checkpoint.entity';
import type { IIndexingContentService } from '@indexing/domain/interfaces/content-service.interface';
import { Inject, Injectable } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable()
export class ContentServiceAdapter implements IIndexingContentService {
  constructor(
    @Inject('CONTENT_SERVICE_RMQ') private readonly client: ClientProxy,
  ) {}

  async claimIndexingAttempt(input: {
    reelId: string;
    indexAttemptId: string;
    allowReclaim?: boolean;
  }): Promise<boolean> {
    return await firstValueFrom(
      this.client
        .send<boolean>('content.claim_reel_indexing_attempt', input)
        .pipe(timeout(30_000)),
    );
  }

  async isIndexingAttemptCurrent(input: {
    reelId: string;
    indexAttemptId: string;
  }): Promise<boolean> {
    return await firstValueFrom(
      this.client
        .send<boolean>('content.is_reel_indexing_attempt_current', input)
        .pipe(timeout(30_000)),
    );
  }

  async reportProgress(input: {
    reelId: string;
    indexAttemptId: string;
    stage: IndexCheckpointStage;
    progress: number;
  }): Promise<void> {
    await firstValueFrom(
      this.client
        .send('content.persist_reel_indexing_progress', input)
        .pipe(timeout(30_000)),
    );
  }

  async completeIndexing(input: CompleteReelIndexCommand): Promise<boolean> {
    const response = await firstValueFrom(
      this.client
        .send<{
          applied: boolean;
        }>('content.persist_reel_index_completed', input)
        .pipe(timeout(30_000)),
    );
    return response.applied;
  }

  async failIndexing(input: {
    reelId: string;
    indexAttemptId: string;
    errorDetail: string;
  }): Promise<void> {
    await firstValueFrom(
      this.client
        .send('content.persist_reel_index_failed', input)
        .pipe(timeout(30_000)),
    );
  }

  async reindexReel(
    reelId: string,
    options?: { requireVisualAnalysis?: boolean },
  ): Promise<{
    queued: boolean;
    indexAttemptId?: string;
  }> {
    const payload = {
      reelId,
      ...(options?.requireVisualAnalysis === undefined
        ? {}
        : { requireVisualAnalysis: options.requireVisualAnalysis }),
    };
    return await firstValueFrom(
      this.client
        .send<{
          queued: boolean;
          indexAttemptId?: string;
        }>('content.reindex_reel', payload)
        .pipe(timeout(30_000)),
    );
  }
}
