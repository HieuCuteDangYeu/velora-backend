import { ReelSeries } from '@content/domain/entities/reel-series.entity';
import type {
  ReelSeriesCreateData,
  ReelSeriesListQuery,
  ReelSeriesUpdateData,
} from '@content/domain/interfaces/content.repository.interface';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/content-client';
import { REEL_LIST_SELECT, toReelSeriesDomain } from './reel-record.mapper';

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

  async listReelSeries(query: ReelSeriesListQuery): Promise<{
    items: ReelSeries[];
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
      include: {
        reels: {
          orderBy: { episodeNumber: 'asc' },
          select: REEL_LIST_SELECT,
        },
      },
    });

    const hasMore = records.length > limit;
    const pageRecords = hasMore ? records.slice(0, limit) : records;
    const lastRecord = pageRecords.at(-1);

    return {
      items: pageRecords.map(toReelSeriesDomain),
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

  async addReelToSeries(input: {
    seriesId: string;
    reelId: string;
    ownerId: string;
    episodeNumber: number;
  }): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const series = await transaction.reelSeries.findFirst({
          where: { id: input.seriesId, ownerId: input.ownerId },
          select: { visibility: true },
        });
        if (!series) return false;

        const updated = await transaction.reel.updateMany({
          where: {
            id: input.reelId,
            userId: input.ownerId,
            seriesId: null,
            visibility: series.visibility,
          },
          data: {
            seriesId: input.seriesId,
            episodeNumber: input.episodeNumber,
          },
        });

        return updated.count === 1;
      });
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
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
    const updated = await this.prisma.reel.updateMany({
      where: {
        id: input.reelId,
        userId: input.ownerId,
        seriesId: input.seriesId,
      },
      data: { seriesId: null, episodeNumber: null },
    });

    return updated.count === 1;
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
