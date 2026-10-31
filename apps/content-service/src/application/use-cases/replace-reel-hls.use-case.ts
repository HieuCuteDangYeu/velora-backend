import type {
  ReelHlsReplacementCommand,
  ReelHlsReplacementResult,
} from '@common/content/reel-hls-replacement';
import { reelHlsPlanSha256 } from '@common/content/reel-hls-replacement';
import {
  isLegacyReelHlsKey,
  isUserOwnedReelMediaKey,
} from '@common/content/reel-media-key';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import type { IReelHlsArtifactValidator } from '@content/domain/interfaces/reel-hls-artifact-validator.interface';
import type { IOutboxDispatchTrigger } from '@content/domain/interfaces/outbox-dispatch-trigger.interface';
import type { IStorageService } from '@content/domain/interfaces/storage.service.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ReplaceReelHlsUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
    @Inject('IReelHlsArtifactValidator')
    private readonly validator: IReelHlsArtifactValidator,
    @Inject('IStorageService') private readonly storage: IStorageService,
    @Inject('IOutboxDispatchTrigger')
    private readonly outbox: IOutboxDispatchTrigger,
  ) {}

  async execute(
    command: ReelHlsReplacementCommand,
  ): Promise<ReelHlsReplacementResult | { reserved: true }> {
    const { plan } = command;
    if (reelHlsPlanSha256(plan) !== command.reviewedSha256)
      throw new Error('Reviewed artifact checksum mismatch');
    if (
      plan.previousHlsMasterKey ===
        `reels/${plan.reelId}/${plan.attemptId}/master.m3u8` ||
      plan.attemptId === plan.mediaAttemptId ||
      plan.attemptId === plan.indexAttemptId
    )
      throw new Error('Replacement requires a fresh immutable attempt');
    if (
      !isLegacyReelHlsKey(plan.previousHlsMasterKey, plan.reelId) &&
      !isUserOwnedReelMediaKey(plan.previousHlsMasterKey, plan.userId)
    )
      throw new Error('Previous HLS is outside this Reel ownership');
    if (command.action === 'RESERVE') {
      await this.repository.reserveReelHlsReplacement(plan);
      return { reserved: true };
    }
    if (command.action === 'APPLY') await this.validator.validate(plan);
    else if (!(await this.storage.checkFileExists(plan.previousHlsMasterKey)))
      throw new Error('Previous HLS is unavailable for rollback');
    try {
      return await this.repository.completeReelHlsReplacement(command);
    } finally {
      // A cache error can follow a committed pointer; its durable event must still dispatch.
      this.outbox.trigger();
    }
  }
}
