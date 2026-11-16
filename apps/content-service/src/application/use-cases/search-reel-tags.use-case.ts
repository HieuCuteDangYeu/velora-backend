import { SearchTagItem } from '@common/search/interfaces/search-tag.interface';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { TtlPromiseCache } from '@content/application/services/ttl-promise-cache';
import { Inject, Injectable } from '@nestjs/common';

// Tag search aggregates up to 20,000 reels per call and the client runs it on every
// keystroke, so identical queries within this window reuse one result.
export const TAG_SEARCH_CACHE_TTL_MS = 45_000;

@Injectable()
export class SearchReelTagsUseCase {
  private readonly cache = new TtlPromiseCache<SearchTagItem[]>(
    TAG_SEARCH_CACHE_TTL_MS,
    500,
  );

  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
  ) {}

  async execute(input: {
    query?: string;
    limit?: number;
  }): Promise<SearchTagItem[]> {
    const limit = Math.min(Math.max(input.limit ?? 12, 1), 30);
    const query = this.normalizeQuery(input.query);

    const tags = await this.cache.get(`${query ?? ''}|${limit}`, () =>
      this.contentRepository.searchReelTags(
        query === undefined ? { limit } : { query, limit },
      ),
    );
    return [...tags];
  }

  private normalizeQuery(raw: string | undefined): string | undefined {
    const rawQuery = raw?.trim() ?? '';
    if (rawQuery.length === 0) return undefined;

    // A single character is too broad to be useful; leading "#" is noise.
    const query = rawQuery
      .replace(/^#+/, '')
      .replace(/[\s_-]+/g, ' ')
      .trim()
      .toLowerCase();

    return query.length === 0 ? undefined : query;
  }
}
