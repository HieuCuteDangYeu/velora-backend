import type { ReelMediaOutput } from '@common/processing/interfaces/reel-media-output.interface';
import type { IOutboxDispatchTrigger } from '@content/domain/interfaces/outbox-dispatch-trigger.interface';
import { Inject, Injectable } from '@nestjs/common';
import type {
  IContentRepository,
  ReelProcessingMediaMetadata,
} from '../../domain/interfaces/content.repository.interface';

@Injectable()
export class CompleteReelMediaProcessingUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
    @Inject('IOutboxDispatchTrigger')
    private readonly outboxDispatchTrigger: IOutboxDispatchTrigger,
  ) {}

  async execute(input: {
    reelId: string;
    mediaAttemptId: string;
    mediaMetadata: ReelProcessingMediaMetadata;
    mediaOutput: ReelMediaOutput;
  }): Promise<boolean> {
    if (
      !input.reelId.trim() ||
      !input.mediaAttemptId.trim() ||
      !input.mediaOutput.thumbnailKey.trim() ||
      !input.mediaOutput.hlsMasterKey.trim() ||
      typeof input.mediaOutput.sourceHasAudio !== 'boolean' ||
      !input.mediaOutput.sourceLengthClass ||
      !input.mediaMetadata.sourceDurationMs ||
      !input.mediaMetadata.sourceOrientation
    ) {
      return false;
    }

    const completed =
      await this.contentRepository.completeMediaProcessing(input);

    if (completed) {
      this.outboxDispatchTrigger.trigger();
    }

    return completed;
  }
}
