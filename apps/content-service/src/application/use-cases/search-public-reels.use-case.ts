import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  IContentRepository,
  ReelSearchResult,
} from '../../domain/interfaces/content.repository.interface';
import type { ISemanticReelSearchService } from '@content/domain/interfaces/semantic-reel-search.service.interface';

@Injectable()
export class SearchPublicReelsUseCase {
  private readonly logger = new Logger(SearchPublicReelsUseCase.name);

  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
    @Inject('ISemanticReelSearchService')
    private readonly semanticSearch: ISemanticReelSearchService,
  ) {}

  async execute(data: {
    query: string;
    viewerId?: string;
    limit?: number;
  }): Promise<ReelSearchResult[]> {
    const query = data.query.trim();

    if (query.length === 0) {
      return [];
    }

    const limit = Math.min(Math.max(data.limit ?? 12, 1), 30);
    const candidates = await this.semanticSearch.searchPublicReels({
      query,
      limit,
    });
    let reels: Awaited<
      ReturnType<IContentRepository['findSearchablePublicReels']>
    >;
    try {
      reels = await this.contentRepository.findSearchablePublicReels(
        candidates.map((candidate) => candidate.reelId),
      );
    } catch (error: unknown) {
      // A slow or exhausted database must not turn search into an HTTP 500.
      this.logger.warn(
        `Reel search hydration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    const reelById = new Map(reels.map((reel) => [reel.id, reel]));
    // The search over-fetches because private reels are dropped here; the caller still gets at most `limit`.
    return candidates
      .flatMap((candidate) => {
        const reel = reelById.get(candidate.reelId);
        return reel ? [{ reel, score: candidate.score }] : [];
      })
      .slice(0, limit);
  }
}
