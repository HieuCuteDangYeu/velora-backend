import type {
  AddReelToSeriesDto,
  CreateReelSeriesDto,
  ReorderReelSeriesDto,
  UpdateReelSeriesDto,
} from '@common/content/dtos/reel-series.dto';
import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import {
  ReelNotFoundError,
  ReelSeriesConflictError,
  ReelSeriesForbiddenError,
  ReelSeriesNotFoundError,
} from '@content/domain/errors/content.error';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ReelSeriesUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
    @Inject('IFriendContentAccessService')
    private readonly friendContentAccessService: IFriendContentAccessService,
  ) {}

  create(ownerId: string, payload: CreateReelSeriesDto): Promise<ReelSeries> {
    return this.repository.createReelSeries({
      ownerId,
      title: payload.title,
      description: payload.description,
      visibility: payload.visibility,
    });
  }

  listOwned(
    ownerId: string,
    query: {
      visibility?: 'public' | 'friends' | 'private';
      limit?: number;
      cursor?: { createdAt: Date; id: string };
    },
  ): Promise<{
    items: ReelSeries[];
    nextCursor: { createdAt: Date; id: string } | null;
  }> {
    return this.repository.listReelSeries({ ownerId, ...query });
  }

  async get(
    id: string,
    viewerId: string,
    isAdmin = false,
  ): Promise<ReelSeries> {
    const series = await this.getExisting(id);

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

  async update(
    id: string,
    ownerId: string,
    payload: UpdateReelSeriesDto,
  ): Promise<ReelSeries> {
    await this.getOwned(id, ownerId);
    const updated = await this.repository.updateReelSeries(
      id,
      ownerId,
      payload,
    );
    if (!updated) throw new ReelSeriesNotFoundError();
    return updated;
  }

  async delete(id: string, ownerId: string): Promise<void> {
    await this.getOwned(id, ownerId);
    if (!(await this.repository.deleteReelSeries(id, ownerId))) {
      throw new ReelSeriesNotFoundError();
    }
  }

  async addReel(
    id: string,
    ownerId: string,
    payload: AddReelToSeriesDto,
  ): Promise<ReelSeries> {
    const series = await this.getOwned(id, ownerId);
    const reel = await this.repository.findById(payload.reelId);

    if (!reel) throw new ReelNotFoundError();
    if (reel.userId !== ownerId) {
      throw new ReelSeriesForbiddenError(
        'Only reels owned by the series owner can be added.',
      );
    }
    if (reel.series && reel.series.id !== id) {
      throw new ReelSeriesConflictError(
        'Reel already belongs to another series.',
      );
    }
    if (reel.series?.id === id) {
      throw new ReelSeriesConflictError('Reel already belongs to this series.');
    }
    if (reel.visibility !== series.visibility) {
      throw new ReelSeriesConflictError(
        'Reel visibility must match the series visibility.',
      );
    }

    const episodeNumber =
      payload.episodeNumber ??
      series.reels.reduce(
        (max, item) => Math.max(max, item.series?.episodeNumber ?? 0),
        0,
      ) + 1;

    if (
      series.reels.some((item) => item.series?.episodeNumber === episodeNumber)
    ) {
      throw new ReelSeriesConflictError('Episode number is already in use.');
    }

    const added = await this.repository.addReelToSeries({
      seriesId: id,
      reelId: reel.id,
      ownerId,
      episodeNumber,
    });

    if (!added) {
      throw new ReelSeriesConflictError('Unable to add reel to series.');
    }

    return this.getExisting(id);
  }

  async removeReel(
    id: string,
    reelId: string,
    ownerId: string,
  ): Promise<ReelSeries> {
    const series = await this.getOwned(id, ownerId);
    if (!series.reels.some((reel) => reel.id === reelId)) {
      throw new ReelNotFoundError();
    }

    const removed = await this.repository.removeReelFromSeries({
      seriesId: id,
      reelId,
      ownerId,
    });
    if (!removed) throw new ReelNotFoundError();
    return this.getExisting(id);
  }

  async reorder(
    id: string,
    ownerId: string,
    payload: ReorderReelSeriesDto,
  ): Promise<ReelSeries> {
    const series = await this.getOwned(id, ownerId);
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

    return this.getExisting(id);
  }

  private async getExisting(id: string): Promise<ReelSeries> {
    const series = await this.repository.findReelSeriesById(id);
    if (!series) throw new ReelSeriesNotFoundError();
    return series;
  }

  private async getOwned(id: string, ownerId: string): Promise<ReelSeries> {
    const series = await this.getExisting(id);
    if (series.ownerId !== ownerId) throw new ReelSeriesForbiddenError();
    return series;
  }
}
