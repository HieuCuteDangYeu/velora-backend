import { SearchTagItem } from '@common/search/interfaces/search-tag.interface';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class SearchReelTagsUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
  ) {}

  async execute(input: {
    query?: string;
    limit?: number;
  }): Promise<SearchTagItem[]> {
    const limit = Math.min(Math.max(input.limit ?? 12, 1), 30);
    const rawQuery = input.query?.trim() ?? '';

    if (rawQuery.length === 0) {
      return this.contentRepository.searchReelTags({ limit });
    }

    // A single character is too broad to be useful; leading "#" is noise.
    const query = rawQuery
      .replace(/^#+/, '')
      .replace(/[\s_-]+/g, ' ')
      .trim()
      .toLowerCase();

    if (query.length === 0) {
      return this.contentRepository.searchReelTags({ limit });
    }

    return this.contentRepository.searchReelTags({ query, limit });
  }
}
