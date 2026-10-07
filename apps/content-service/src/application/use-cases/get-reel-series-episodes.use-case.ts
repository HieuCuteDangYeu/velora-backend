import { ReelSeriesNotFoundError } from '@content/domain/errors/content.error';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';
import type {
  IContentRepository,
  ReelSeriesEpisodePageRecord,
  ReelSeriesEpisodesQuery,
} from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class GetReelSeriesEpisodesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
    @Inject('IFriendContentAccessService')
    private readonly friendContentAccessService: IFriendContentAccessService,
  ) {}

  async execute(
    id: string,
    viewerId: string,
    isAdmin: boolean,
    query: Omit<ReelSeriesEpisodesQuery, 'seriesId' | 'onlyCompleted'>,
  ): Promise<ReelSeriesEpisodePageRecord> {
    const series = await this.repository.findReelSeriesMetadataById(id);
    if (!series) throw new ReelSeriesNotFoundError();

    const isOwner = series.ownerId === viewerId;
    if (!isAdmin && !isOwner) {
      const allowed = await this.friendContentAccessService.canView({
        viewerId,
        ownerId: series.ownerId,
        visibility: series.visibility,
      });
      if (!allowed) throw new ReelSeriesNotFoundError();
    }

    const page = await this.repository.listReelSeriesEpisodes({
      seriesId: id,
      onlyCompleted: !isAdmin && !isOwner,
      ...query,
    });

    return {
      ...page,
      series: { ...series, episodeCount: page.episodeCount },
    };
  }
}
