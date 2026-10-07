import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';
import { getOwnedReelSeries } from '@content/application/services/reel-series-access.service';

@Injectable()
export class ListReelSeriesCandidatesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
  ) {}

  async execute(
    id: string,
    ownerId: string,
    query: {
      limit?: number;
      cursor?: { createdAt: Date; id: string };
    },
  ) {
    const series = await getOwnedReelSeries(this.repository, id, ownerId);
    return this.repository.listReelSeriesCandidates({
      ownerId,
      visibility: series.visibility,
      ...query,
    });
  }
}
