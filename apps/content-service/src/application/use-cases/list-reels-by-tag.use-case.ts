import { Reel } from '@content/domain/entities/reel.entity';
import type {
  IContentRepository,
  ReelCursor,
} from '@content/domain/interfaces/content.repository.interface';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';
import { normalizeReelSearchTag } from '@content/domain/reel-search-tag';
import { Inject, Injectable } from '@nestjs/common';

export interface ListReelsByTagInput {
  viewerId: string;
  tag: string;
  limit?: number;
  cursor?: ReelCursor;
}

export interface ListReelsByTagResult {
  items: Reel[];
  nextCursor: ReelCursor | null;
}

@Injectable()
export class ListReelsByTagUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
    @Inject('IFriendContentAccessService')
    private readonly friendContentAccessService: IFriendContentAccessService,
  ) {}

  async execute(input: ListReelsByTagInput): Promise<ListReelsByTagResult> {
    const tag = normalizeReelSearchTag(input.tag);

    if (!tag) {
      return { items: [], nextCursor: null };
    }

    const limit = Math.min(Math.max(input.limit ?? 24, 1), 50);
    const audience = await this.friendContentAccessService.getFeedAudience(
      input.viewerId,
    );

    return this.contentRepository.listReelsByTag({
      tag,
      limit,
      cursor: input.cursor,
      excludedUserIds: audience.excludedUserIds,
    });
  }
}
