import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';
import { PreTranslateReelSubtitlesUseCase } from './pre-translate-reel-subtitles.use-case';

@Injectable()
export class CompleteReelIndexingUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
    private readonly subtitles: PreTranslateReelSubtitlesUseCase,
  ) {}

  async execute(input: CompleteReelIndexCommand): Promise<boolean> {
    if (!input.reelId?.trim() || !input.indexAttemptId?.trim()) return false;
    const completed = await this.repository.completeIndexing(input);
    if (completed && input.transcriptSegments?.length) {
      // Translation can take minutes, so it runs after the index result is acknowledged.
      void this.subtitles.execute(input.reelId);
    }
    return completed;
  }
}
