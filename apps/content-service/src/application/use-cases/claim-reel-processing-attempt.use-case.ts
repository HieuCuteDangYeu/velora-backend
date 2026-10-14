import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IContentRepository } from '../../domain/interfaces/content.repository.interface';

@Injectable()
export class ClaimReelProcessingAttemptUseCase {
  private readonly logger = new Logger(ClaimReelProcessingAttemptUseCase.name);

  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
  ) {}

  async execute(data: {
    reelId: string;
    processingAttemptId: string;
    allowReclaim?: boolean;
    evidenceOnly?: boolean;
    userId?: string;
    hlsMasterKey?: string;
  }): Promise<boolean> {
    const reelId = data.reelId.trim();
    const processingAttemptId = data.processingAttemptId.trim();

    if (!reelId || !processingAttemptId) {
      return false;
    }

    const claimed = await this.contentRepository.claimProcessingAttempt({
      reelId,
      processingAttemptId,
      allowReclaim: data.allowReclaim,
      evidenceOnly: data.evidenceOnly,
      userId: data.userId,
      hlsMasterKey: data.hlsMasterKey,
    });

    if (!claimed) {
      this.logger.warn(
        `Ignored duplicate or stale reel processing attempt: reelId=${reelId}, processingAttemptId=${processingAttemptId}`,
      );
    }

    return claimed;
  }
}
