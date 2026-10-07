import type { AddReelToSeriesDto } from '@common/content/dtos/reel-series.dto';
import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import { ReelSeriesConflictError } from '@content/domain/errors/content.error';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
  getExistingReelSeries,
  getOwnedReelSeries,
} from '@content/application/services/reel-series-access.service';

@Injectable()
export class AddReelsToSeriesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
  ) {}

  async execute(
    id: string,
    ownerId: string,
    payload: AddReelToSeriesDto,
  ): Promise<ReelSeries> {
    await getOwnedReelSeries(this.repository, id, ownerId);

    const added = await this.repository.addReelsToSeries({
      seriesId: id,
      reelIds: payload.reelIds,
      ownerId,
    });

    if (!added) {
      throw new ReelSeriesConflictError(
        'Every reel must be completed, standalone, owned by you, and match the series visibility.',
      );
    }

    return getExistingReelSeries(this.repository, id);
  }
}
