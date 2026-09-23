import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import type {
  ReelSeriesCreateData,
  ReelSeriesCandidateQuery,
  ReelSeriesEpisodesQuery,
  ReelSeriesEpisodesRecord,
  ReelSeriesListRecord,
  ReelSeriesMetadataRecord,
  ReelSeriesListQuery,
  ReelSeriesUpdateData,
} from '@content/domain/interfaces/content.repository.interface';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/content-client';
import {
  REEL_LIST_SELECT,
  toReelDomain,
  toReelSeriesDomain,
} from './reel-record.mapper';

@Injectable()
export class ReelSeriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createReelSeries(data: ReelSeriesCreateData): Promise<ReelSeries> {
    const record = await this.prisma.reelSeries.create({
      data,
      include: {
        reels: {
          orderBy: { episodeNumber: 'asc' },
          select: REEL_LIST_SELECT,
        },
      },
    });

    return toReelSeriesDomain(record);
  }

  async findReelSeriesById(id: string): Promise<ReelSeries | null> {
    const record = await this.prisma.reelSeries.findUnique({
      where: { id },
      include: {
        reels: {
          orderBy: { episodeNumber: 'asc' },
          select: REEL_LIST_SELECT,
        },
      },
    });

    return record ? toReelSeriesDomain(record) : null;
  }

  async findReelSeriesMetadataById(
    id: string,
  ): Promise<ReelSeriesMetadataRecord | null> {
    const record = await this.prisma.reelSeries.findUnique({
      where: { id },
      select: {
        id: true,
        ownerId: true,
        title: true,
        description: true,
        visibility: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!record) return null;
    const { description, ...metadata } = record;

    return {
      ...metadata,
      visibility: metadata.visibility as ReelSeriesMetadataRecord['visibility'],
      ...(description ? { description } : {}),
    };
  }

  async listReelSeries(query: ReelSeriesListQuery): Promise<{
    items: ReelSeriesListRecord[];
    nextCursor: { createdAt: Date; id: string } | null;
  }> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const cursorFilter = query.cursor
      ? {
          OR: [
            { createdAt: { lt: query.cursor.createdAt } },
            { createdAt: query.cursor.createdAt, id: { lt: query.cursor.id } },
          ],
        }
      : {};

    const records = await this.prisma.reelSeries.findMany({
      where: {
        ownerId: query.ownerId,
        ...(query.visibility ? { visibility: query.visibility } : {}),
        ...cursorFilter,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        ownerId: true,
        title: true,
        description: true,
        visibility: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { reels: true } },
        reels: {
          take: 1,
          orderBy: { episodeNumber: 'asc' },
          select: { id: true, thumbnailKey: true },
        },
      },
    });

    const hasMore = records.length > limit;
    const pageRecords = hasMore ? records.slice(0, limit) : records;
    const lastRecord = pageRecords.at(-1);

    return {
      items: pageRecords.map((record) => ({
        id: record.id,
        ownerId: record.ownerId,
        title: record.title,
        ...(record.description ? { description: record.description } : {}),
        visibility: record.visibility as ReelSeriesListRecord['visibility'],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        episodeCount: record._count.reels,
        ...(record.reels[0]?.id ? { firstReelId: record.reels[0].id } : {}),
        ...(record.reels[0]?.thumbnailKey
          ? { coverThumbnailKey: record.reels[0].thumbnailKey }
          : {}),
      })),
      nextCursor:
        hasMore && lastRecord
          ? { createdAt: lastRecord.createdAt, id: lastRecord.id }
          : null,
    };
  }

  async listReelSeriesEpisodes(
    query: ReelSeriesEpisodesQuery,
  ): Promise<ReelSeriesEpisodesRecord> {
    const where: Prisma.ReelWhereInput = {
      seriesId: query.seriesId,
      episodeNumber: { not: null },
      ...(query.onlyCompleted ? { mediaStatus: 'COMPLETED' } : {}),
    };
    const episodeCount = await this.prisma.reel.count({ where });
    const orderByAscending: Prisma.ReelOrderByWithRelationInput[] = [
      { episodeNumber: 'asc' },
      { id: 'asc' },
    ];
    const orderByDescending: Prisma.ReelOrderByWithRelationInput[] = [
      { episodeNumber: 'desc' },
      { id: 'desc' },
    ];
    const serializeCursor = (record: { id: string; episodeNumber: number | null }) =>
      record.episodeNumber === null
        ? null
        : { id: record.id, episodeNumber: record.episodeNumber };
    const toEpisodes = <T extends { id: string; episodeNumber: number | null }>(
      records: T[],
    ) =>
      records.map((record) =>
        toReelDomain(record as unknown as Record<string, unknown>),
      );

    if (query.cursor && query.direction) {
      const positionFilter =
        query.direction === 'previous'
          ? {
              OR: [
                { episodeNumber: { lt: query.cursor.episodeNumber } },
                {
                  episodeNumber: query.cursor.episodeNumber,
                  id: { lt: query.cursor.id },
                },
              ],
            }
          : {
              OR: [
                { episodeNumber: { gt: query.cursor.episodeNumber } },
                {
                  episodeNumber: query.cursor.episodeNumber,
                  id: { gt: query.cursor.id },
                },
              ],
            };
      const records = await this.prisma.reel.findMany({
        where: { ...where, ...positionFilter },
        orderBy:
          query.direction === 'previous' ? orderByDescending : orderByAscending,
        take: query.limit + 1,
        select: REEL_LIST_SELECT,
      });
      const hasMoreInDirection = records.length > query.limit;
      const boundedRecords = records.slice(0, query.limit);
      const pageRecords =
        query.direction === 'previous'
          ? boundedRecords.reverse()
          : boundedRecords;
      const firstCursor = pageRecords[0] ? serializeCursor(pageRecords[0]) : null;
      const lastRecord = pageRecords[pageRecords.length - 1];
      const lastCursor = lastRecord ? serializeCursor(lastRecord) : null;

      return {
        items: toEpisodes(pageRecords),
        episodeCount,
        previousCursor:
          query.direction === 'previous'
            ? hasMoreInDirection
              ? firstCursor
              : null
            : firstCursor,
        nextCursor:
          query.direction === 'next'
            ? hasMoreInDirection
              ? lastCursor
              : null
            : lastCursor,
      };
    }

    const anchor = query.aroundReelId
      ? await this.prisma.reel.findFirst({
          where: { ...where, id: query.aroundReelId },
          select: { episodeNumber: true },
        })
      : null;

    if (!anchor?.episodeNumber) {
      const records = await this.prisma.reel.findMany({
        where,
        orderBy: orderByAscending,
        take: query.limit + 1,
        select: REEL_LIST_SELECT,
      });
      const hasNext = records.length > query.limit;
      const pageRecords = records.slice(0, query.limit);
      const lastRecord = pageRecords[pageRecords.length - 1];
      const lastCursor = lastRecord ? serializeCursor(lastRecord) : null;

      return {
        items: toEpisodes(pageRecords),
        episodeCount,
        previousCursor: null,
        nextCursor: hasNext ? lastCursor : null,
      };
    }

    const [olderRecords, newerRecords] = await Promise.all([
      this.prisma.reel.findMany({
        where: {
          ...where,
          episodeNumber: { lt: anchor.episodeNumber },
        },
        orderBy: orderByDescending,
        take: query.limit + 1,
        select: REEL_LIST_SELECT,
      }),
      this.prisma.reel.findMany({
        where: {
          ...where,
          episodeNumber: { gte: anchor.episodeNumber },
        },
        orderBy: orderByAscending,
        take: query.limit + 1,
        select: REEL_LIST_SELECT,
      }),
    ]);
    const hasMoreOlder = olderRecords.length > query.limit;
    const hasMoreNewer = newerRecords.length > query.limit;
    const candidates = [
      ...olderRecords.slice(0, query.limit).reverse(),
      ...newerRecords.slice(0, query.limit),
    ];
    const anchorIndex = Math.min(
      candidates.length,
      olderRecords.slice(0, query.limit).length,
    );
    const maxStart = Math.max(0, candidates.length - query.limit);
    const start = Math.max(
      0,
      Math.min(maxStart, anchorIndex - Math.floor(query.limit / 2)),
    );
    const pageRecords = candidates.slice(start, start + query.limit);
    const firstCursor = pageRecords[0] ? serializeCursor(pageRecords[0]) : null;
    const lastRecord = pageRecords[pageRecords.length - 1];
    const lastCursor = lastRecord ? serializeCursor(lastRecord) : null;

    return {
      items: toEpisodes(pageRecords),
      episodeCount,
      previousCursor: start > 0 || hasMoreOlder ? firstCursor : null,
      nextCursor:
        start + pageRecords.length < candidates.length || hasMoreNewer
          ? lastCursor
          : null,
    };
  }

  async listReelSeriesCandidates(query: ReelSeriesCandidateQuery) {
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 50);
    const cursorFilter = query.cursor
      ? {
          OR: [
            { createdAt: { lt: query.cursor.createdAt } },
            { createdAt: query.cursor.createdAt, id: { lt: query.cursor.id } },
          ],
        }
      : {};

    const records = await this.prisma.reel.findMany({
      where: {
        userId: query.ownerId,
        visibility: query.visibility,
        seriesId: null,
        mediaStatus: 'COMPLETED',
        ...cursorFilter,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: REEL_LIST_SELECT,
    });

    const hasMore = records.length > limit;
    const pageRecords = hasMore ? records.slice(0, limit) : records;
    const lastRecord = pageRecords.at(-1);

    return {
      items: pageRecords.map((record) =>
        toReelDomain(record as unknown as Record<string, unknown>),
      ),
      nextCursor:
        hasMore && lastRecord
          ? { createdAt: lastRecord.createdAt, id: lastRecord.id }
          : null,
    };
  }

  async updateReelSeries(
    id: string,
    ownerId: string,
    data: ReelSeriesUpdateData,
  ): Promise<ReelSeries | null> {
    const record = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.reelSeries.findFirst({
        where: { id, ownerId },
        select: { id: true },
      });
      if (!existing) return null;

      if (data.visibility !== undefined) {
        await transaction.reel.updateMany({
          where: { seriesId: id, userId: ownerId },
          data: { visibility: data.visibility },
        });
      }

      return transaction.reelSeries.update({
        where: { id },
        data: {
          title: data.title,
          description: data.description,
          visibility: data.visibility,
        },
        include: {
          reels: {
            orderBy: { episodeNumber: 'asc' },
            select: REEL_LIST_SELECT,
          },
        },
      });
    });

    return record ? toReelSeriesDomain(record) : null;
  }

  async deleteReelSeries(id: string, ownerId: string): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.reelSeries.findFirst({
        where: { id, ownerId },
        select: { id: true },
      });
      if (!existing) return false;

      await transaction.reel.updateMany({
        where: { seriesId: id, userId: ownerId },
        data: { seriesId: null, episodeNumber: null },
      });
      await transaction.reelSeries.delete({ where: { id } });
      return true;
    });
  }

  async addReelsToSeries(input: {
    seriesId: string;
    reelIds: string[];
    ownerId: string;
  }): Promise<boolean> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const series = await transaction.reelSeries.findFirst({
            where: { id: input.seriesId, ownerId: input.ownerId },
            select: { visibility: true },
          });
          if (!series) return false;

          const reels = await transaction.reel.findMany({
            where: {
              id: { in: input.reelIds },
              userId: input.ownerId,
            },
            select: {
              id: true,
              seriesId: true,
              visibility: true,
              mediaStatus: true,
            },
          });

          if (
            reels.length !== input.reelIds.length ||
            reels.some(
              (reel) =>
                reel.seriesId !== null ||
                reel.visibility !== series.visibility ||
                reel.mediaStatus !== 'COMPLETED',
            )
          ) {
            return false;
          }

          const currentLast = await transaction.reel.aggregate({
            where: { seriesId: input.seriesId, userId: input.ownerId },
            _max: { episodeNumber: true },
          });
          const firstEpisodeNumber = (currentLast._max.episodeNumber ?? 0) + 1;

          for (let index = 0; index < input.reelIds.length; index += 1) {
            const updated = await transaction.reel.updateMany({
              where: {
                id: input.reelIds[index],
                userId: input.ownerId,
                seriesId: null,
                visibility: series.visibility,
                mediaStatus: 'COMPLETED',
              },
              data: {
                seriesId: input.seriesId,
                episodeNumber: firstEpisodeNumber + index,
              },
            });

            if (updated.count !== 1) {
              throw new Error('Series membership changed while adding reels.');
            }
          }

          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['P2002', 'P2034'].includes((error as { code?: string }).code ?? '')
      ) {
        return false;
      }
      if (
        error instanceof Error &&
        error.message === 'Series membership changed while adding reels.'
      ) {
        return false;
      }
      throw error;
    }
  }

  async removeReelFromSeries(input: {
    seriesId: string;
    reelId: string;
    ownerId: string;
  }): Promise<boolean> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const reel = await transaction.reel.findFirst({
            where: {
              id: input.reelId,
              userId: input.ownerId,
              seriesId: input.seriesId,
            },
            select: { id: true },
          });
          if (!reel) return false;

          await transaction.reel.update({
            where: { id: input.reelId },
            data: { seriesId: null, episodeNumber: null },
          });
          await this.normalizeEpisodeNumbers(
            transaction,
            input.seriesId,
            input.ownerId,
          );
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'P2034'
      ) {
        return false;
      }
      throw error;
    }
  }

  private async normalizeEpisodeNumbers(
    transaction: Prisma.TransactionClient,
    seriesId: string,
    ownerId: string,
  ): Promise<void> {
    const reels = await transaction.reel.findMany({
      where: { seriesId, userId: ownerId },
      orderBy: [{ episodeNumber: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });

    await transaction.reel.updateMany({
      where: { seriesId, userId: ownerId },
      data: { episodeNumber: null },
    });

    for (let index = 0; index < reels.length; index += 1) {
      await transaction.reel.update({
        where: { id: reels[index].id },
        data: { episodeNumber: index + 1 },
      });
    }
  }

  async reorderReelSeries(input: {
    seriesId: string;
    ownerId: string;
    reelIds: string[];
  }): Promise<boolean> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const series = await transaction.reelSeries.findFirst({
            where: { id: input.seriesId, ownerId: input.ownerId },
            select: { id: true },
          });
          if (!series) return false;

          const current = await transaction.reel.findMany({
            where: { seriesId: input.seriesId, userId: input.ownerId },
            select: { id: true },
          });
          const requested = new Set(input.reelIds);
          if (
            current.length !== requested.size ||
            current.some((reel) => !requested.has(reel.id))
          ) {
            return false;
          }

          await transaction.reel.updateMany({
            where: { seriesId: input.seriesId, userId: input.ownerId },
            data: { episodeNumber: null },
          });

          for (let index = 0; index < input.reelIds.length; index += 1) {
            const updated = await transaction.reel.updateMany({
              where: {
                id: input.reelIds[index],
                seriesId: input.seriesId,
                userId: input.ownerId,
              },
              data: { episodeNumber: index + 1 },
            });
            if (updated.count !== 1) {
              throw new Error('Series membership changed while reordering.');
            }
          }

          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['P2002', 'P2034'].includes((error as { code?: string }).code ?? '')
      ) {
        return false;
      }
      throw error;
    }
  }
}
