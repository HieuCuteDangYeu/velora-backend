import type { ReelSeries } from '@content/domain/entities/reel-series.entity';
import {
  ReelSeriesForbiddenError,
  ReelSeriesNotFoundError,
} from '@content/domain/errors/content.error';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';

export async function getExistingReelSeries(
  repository: IContentRepository,
  id: string,
): Promise<ReelSeries> {
  const series = await repository.findReelSeriesById(id);
  if (!series) throw new ReelSeriesNotFoundError();
  return series;
}

export async function getOwnedReelSeries(
  repository: IContentRepository,
  id: string,
  ownerId: string,
): Promise<ReelSeries> {
  const series = await getExistingReelSeries(repository, id);
  if (series.ownerId !== ownerId) throw new ReelSeriesForbiddenError();
  return series;
}
