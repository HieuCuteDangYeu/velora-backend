import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import type { IOutboxDispatchTrigger } from '@content/domain/interfaces/outbox-dispatch-trigger.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ReindexReelUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
    @Inject('IOutboxDispatchTrigger')
    private readonly outboxDispatchTrigger: IOutboxDispatchTrigger,
  ) {}

  async execute(
    reelId: string,
    options?: { requireVisualAnalysis?: boolean },
  ): Promise<{ queued: boolean; indexAttemptId?: string }> {
    if (!reelId?.trim()) return { queued: false };
    const indexAttemptId = await this.repository.queueReelIndexingAttempt(
      reelId.trim(),
      options,
    );

    if (!indexAttemptId) {
      return { queued: false };
    }

    this.outboxDispatchTrigger.trigger();
    return { queued: true, indexAttemptId };
  }
}
