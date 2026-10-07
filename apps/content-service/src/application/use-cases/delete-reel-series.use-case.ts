import { ReelSeriesNotFoundError } from '@content/domain/errors/content.error';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';
import { getOwnedReelSeries } from '@content/application/services/reel-series-access.service';

@Injectable()
export class DeleteReelSeriesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
  ) {}

  async execute(id: string, ownerId: string): Promise<void> {
    await getOwnedReelSeries(this.repository, id, ownerId);
    if (!(await this.repository.deleteReelSeries(id, ownerId))) {
      throw new ReelSeriesNotFoundError();
    }
  }
}
