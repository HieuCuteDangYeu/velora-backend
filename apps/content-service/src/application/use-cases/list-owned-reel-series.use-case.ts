import type {
  IContentRepository,
  ReelSeriesListRecord,
} from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ListOwnedReelSeriesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
  ) {}

  execute(
    ownerId: string,
    query: {
      visibility?: 'public' | 'friends' | 'private';
      limit?: number;
      cursor?: { createdAt: Date; id: string };
    },
  ): Promise<{
    items: ReelSeriesListRecord[];
    nextCursor: { createdAt: Date; id: string } | null;
  }> {
    return this.repository.listReelSeries({ ownerId, ...query });
  }
}
