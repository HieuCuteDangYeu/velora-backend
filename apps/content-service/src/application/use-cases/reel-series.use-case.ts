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
import type {
  IContentRepository,
  ReelSeriesEpisodePageRecord,
  ReelSeriesEpisodesQuery,
  ReelSeriesListRecord,
} from '@content/domain/interfaces/content.repository.interface';
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
    items: ReelSeriesListRecord[];
    nextCursor: { createdAt: Date; id: string } | null;
  }> {
    return this.repository.listReelSeries({ ownerId, ...query });
  }

  async getEpisodePage(
    id: string,
    viewerId: string,
    isAdmin: boolean,
    query: Omit<ReelSeriesEpisodesQuery, 'seriesId' | 'onlyCompleted'>,
  ): Promise<ReelSeriesEpisodePageRecord> {
    const series = await this.repository.findReelSeriesMetadataById(id);
    if (!series) throw new ReelSeriesNotFoundError();

    const isOwner = series.ownerId === viewerId;
    if (!isAdmin && !isOwner) {
      const allowed = await this.friendContentAccessService.canView({
        viewerId,
        ownerId: series.ownerId,
        visibility: series.visibility,
      });
      if (!allowed) throw new ReelSeriesNotFoundError();
    }

    const page = await this.repository.listReelSeriesEpisodes({
      seriesId: id,
      onlyCompleted: !isAdmin && !isOwner,
      ...query,
    });

    return {
      ...page,
      series: { ...series, episodeCount: page.episodeCount },
    };
  }

  async listCandidates(
    id: string,
    ownerId: string,
    query: {
      limit?: number;
      cursor?: { createdAt: Date; id: string };
    },
  ) {
    const series = await this.getOwned(id, ownerId);
    return this.repository.listReelSeriesCandidates({
      ownerId,
      visibility: series.visibility,
      ...query,
    });
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

  async addReels(
    id: string,
    ownerId: string,
    payload: AddReelToSeriesDto,
  ): Promise<ReelSeries> {
    await this.getOwned(id, ownerId);

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
