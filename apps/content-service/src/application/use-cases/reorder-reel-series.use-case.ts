import type { ReorderReelSeriesDto } from '@common/content/dtos/reel-series.dto';
import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import { ReelSeriesConflictError } from '@content/domain/errors/content.error';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
  getExistingReelSeries,
  getOwnedReelSeries,
} from '@content/application/services/reel-series-access.service';

@Injectable()
export class ReorderReelSeriesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
  ) {}

  async execute(
    id: string,
    ownerId: string,
    payload: ReorderReelSeriesDto,
  ): Promise<ReelSeries> {
    const series = await getOwnedReelSeries(this.repository, id, ownerId);
    const currentIds = new Set(series.reels.map((reel) => reel.id));

    if (
      payload.reelIds.length !== currentIds.size ||
      payload.reelIds.some((reelId) => !currentIds.has(reelId))
    ) {
      throw new ReelSeriesConflictError(
        'Reorder must include every reel in the series exactly once.',
      );
    }

    const reordered = await this.repository.reorderReelSeries({
      seriesId: id,
      ownerId,
      reelIds: payload.reelIds,
    });
    if (!reordered) {
      throw new ReelSeriesConflictError('Series changed while reordering.');
    }

    return getExistingReelSeries(this.repository, id);
  }
}
