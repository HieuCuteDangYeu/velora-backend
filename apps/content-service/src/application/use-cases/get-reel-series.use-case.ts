import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import { ReelSeriesNotFoundError } from '@content/domain/errors/content.error';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';
import { getExistingReelSeries } from '@content/application/services/reel-series-access.service';

@Injectable()
export class GetReelSeriesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
    @Inject('IFriendContentAccessService')
    private readonly friendContentAccessService: IFriendContentAccessService,
  ) {}

  async execute(
    id: string,
    viewerId: string,
    isAdmin = false,
  ): Promise<ReelSeries> {
    const series = await getExistingReelSeries(this.repository, id);

    if (isAdmin || series.ownerId === viewerId) return series;

    const allowed = await this.friendContentAccessService.canView({
      viewerId,
      ownerId: series.ownerId,
      visibility: series.visibility,
    });

    if (!allowed) throw new ReelSeriesNotFoundError();
    return new ReelSeries({
      ...series,
      reels: series.reels.filter((reel) => reel.mediaStatus === 'COMPLETED'),
    });
  }
}
