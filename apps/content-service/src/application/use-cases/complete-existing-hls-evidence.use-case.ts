import type { IOutboxDispatchTrigger } from '@content/domain/interfaces/outbox-dispatch-trigger.interface';
import type {
  CompleteExistingHlsEvidenceInput,
  IContentRepository,
} from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class CompleteExistingHlsEvidenceUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
    @Inject('IOutboxDispatchTrigger')
    private readonly outboxDispatchTrigger: IOutboxDispatchTrigger,
  ) {}

  async execute(input: CompleteExistingHlsEvidenceInput): Promise<boolean> {
    if (
      !input.reelId.trim() ||
      !input.mediaAttemptId.trim() ||
      !input.transcriptionAudioManifestKey.trim() ||
      !input.visualFrameManifestKey.trim() ||
      !input.mediaMetadata.sourceDurationMs ||
      input.mediaMetadata.sourceDurationMs <= 0 ||
      !input.mediaMetadata.sourceOrientation ||
      !input.mediaMetadata.sourceLengthClass ||
      typeof input.mediaMetadata.sourceHasAudio !== 'boolean'
    ) {
      return false;
    }

    const applied =
      await this.contentRepository.completeExistingHlsEvidence(input);
    if (applied) this.outboxDispatchTrigger.trigger();
    return applied;
  }
}
