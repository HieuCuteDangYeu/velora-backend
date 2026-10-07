import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import { ReelNotFoundError } from '@content/domain/errors/content.error';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
  getExistingReelSeries,
  getOwnedReelSeries,
} from '@content/application/services/reel-series-access.service';

@Injectable()
export class RemoveReelFromSeriesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
  ) {}

  async execute(
    id: string,
    reelId: string,
    ownerId: string,
  ): Promise<ReelSeries> {
    const series = await getOwnedReelSeries(this.repository, id, ownerId);
    if (!series.reels.some((reel) => reel.id === reelId)) {
      throw new ReelNotFoundError();
    }

    const removed = await this.repository.removeReelFromSeries({
      seriesId: id,
      reelId,
      ownerId,
    });
    if (!removed) throw new ReelNotFoundError();
    return getExistingReelSeries(this.repository, id);
  }
}
