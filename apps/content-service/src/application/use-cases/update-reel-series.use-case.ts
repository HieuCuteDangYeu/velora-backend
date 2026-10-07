import type { UpdateReelSeriesDto } from '@common/content/dtos/reel-series.dto';
import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import { ReelSeriesNotFoundError } from '@content/domain/errors/content.error';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';
import { getOwnedReelSeries } from '@content/application/services/reel-series-access.service';

@Injectable()
export class UpdateReelSeriesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
  ) {}

  async execute(
    id: string,
    ownerId: string,
    payload: UpdateReelSeriesDto,
  ): Promise<ReelSeries> {
    await getOwnedReelSeries(this.repository, id, ownerId);
    const updated = await this.repository.updateReelSeries(
      id,
      ownerId,
      payload,
    );
    if (!updated) throw new ReelSeriesNotFoundError();
    return updated;
  }
}
