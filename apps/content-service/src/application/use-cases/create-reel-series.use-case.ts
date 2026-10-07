import type { CreateReelSeriesDto } from '@common/content/dtos/reel-series.dto';
import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class CreateReelSeriesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
  ) {}

  execute(ownerId: string, payload: CreateReelSeriesDto): Promise<ReelSeries> {
    return this.repository.createReelSeries({
      ownerId,
      title: payload.title,
      description: payload.description,
      visibility: payload.visibility,
    });
  }
}
