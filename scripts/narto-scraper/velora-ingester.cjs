const crypto = require('crypto');
const { PrismaClient } = require('@prisma/content-client');

function createIngester() {
  let prisma;

  return {
    connect() {
      if (!process.env.CONTENT_DATABASE_URL) {
        console.warn('CONTENT_DATABASE_URL environment variable is not set, Prisma might fail if not configured otherwise.');
      }
      prisma = new PrismaClient({
        ...(process.env.CONTENT_DATABASE_URL && {
          datasources: {
            db: {
              url: process.env.CONTENT_DATABASE_URL,
            },
          },
        }),
      });
      return prisma.$connect();
    },

    disconnect() {
      if (prisma) {
        return prisma.$disconnect();
      }
    },

    ensureBotUser() {
      return process.env.BOT_USER_ID || 'b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7';
    },

    async upsertSeries(botUserId, series) {
      if (!prisma) throw new Error('Not connected');

      try {
        const existing = await prisma.reelSeries.findFirst({
          where: { ownerId: botUserId, title: series.title },
          select: { id: true, description: true },
        });

        if (existing) {
          if (series.description && (!existing.description || series.description.length > existing.description.length)) {
            await prisma.reelSeries.update({
              where: { id: existing.id },
              data: { description: series.description },
            });
          }
          return existing.id;
        } else {
          const created = await prisma.reelSeries.create({
            data: {
              ownerId: botUserId,
              title: series.title,
              description: series.description || undefined,
            },
          });
          return created.id;
        }
      } catch (err) {
        console.error(`Failed to upsert series "${series.title}":`, err);
        return null;
      }
    },

    async upsertEpisodeReel(botUserId, seriesId, episode, seriesSlug) {
      if (!prisma) throw new Error('Not connected');

      try {
        const existing = await prisma.reel.findUnique({
          where: {
            seriesId_episodeNumber: {
              seriesId,
              episodeNumber: episode.episodeNumber,
            },
          },
        });

        const description = (episode.episodeDescription || '').substring(0, 2000);
        const tags = ['narto-drama', 'short-drama'];
        if (seriesSlug) tags.push(seriesSlug);

        if (existing) {
          const mediaAttemptId = existing.mediaAttemptId || crypto.randomUUID();
          await prisma.reel.update({
            where: { id: existing.id },
            data: {
              title: episode.episodeTitle || existing.title,
              description,
              thumbnailKey: episode.posterUrl || existing.thumbnailKey,
              mediaKey: episode.playerUrl || existing.mediaKey,
              tags,
              mediaAttemptId,
              sourceDurationMs: existing.sourceDurationMs || 60000,
              outputDurationMs: existing.outputDurationMs || 60000,
              sourceOrientation: existing.sourceOrientation || 'PORTRAIT',
              sourceLengthClass: existing.sourceLengthClass || 'SHORT',
              sourceHasAudio: false,
            },
          });
          return existing.id;
        } else {
          const mediaAttemptId = crypto.randomUUID();
          const processingAttemptId = crypto.randomUUID();
          const created = await prisma.reel.create({
            data: {
              userId: botUserId,
              mediaKey: episode.playerUrl || '',
              title: episode.episodeTitle || `Episode ${episode.episodeNumber}`,
              description,
              tags,
              status: 'COMPLETED',
              mediaStatus: 'COMPLETED',
              indexStatus: 'NOT_REQUESTED',
              visibility: 'public',
              thumbnailKey: episode.posterUrl || '',
              seriesId,
              episodeNumber: episode.episodeNumber,
              mediaAttemptId,
              processingAttemptId,
              sourceDurationMs: 60000,
              outputDurationMs: 60000,
              sourceOrientation: 'PORTRAIT',
              sourceLengthClass: 'SHORT',
              sourceHasAudio: false,
              createdAt: episode.publishedAt ? new Date(episode.publishedAt) : undefined,
            },
          });
          return created.id;
        }
      } catch (err) {
        console.error(`Failed to upsert episode ${episode.episodeNumber} for series ${seriesId}:`, err);
        return null;
      }
    },

    async queueIndexingForReel(reelId) {
      if (!prisma) throw new Error('Not connected');

      return prisma.$transaction(async (tx) => {
        const reel = await tx.reel.findUnique({
          where: { id: reelId },
        });
        if (!reel) return null;

        const mediaAttemptId = reel.mediaAttemptId || crypto.randomUUID();
        const indexAttemptId = crypto.randomUUID();
        const jobId = crypto.randomUUID();
        const now = new Date();

        await tx.reel.update({
          where: { id: reel.id },
          data: {
            mediaAttemptId,
            sourceDurationMs: reel.sourceDurationMs || 60000,
            outputDurationMs: reel.outputDurationMs || 60000,
            sourceOrientation: reel.sourceOrientation || 'PORTRAIT',
            sourceLengthClass: reel.sourceLengthClass || 'SHORT',
            sourceHasAudio: false,
            indexStatus: 'PENDING',
            indexAttemptId,
            processingStage: 'INDEX_QUEUED',
            processingMessage: 'Metadata indexing queued',
          },
        });

        const indexJob = {
          jobId,
          reelId: reel.id,
          userId: reel.userId,
          mediaAttemptId,
          indexAttemptId,
          indexVersion: process.env.INDEX_VERSION?.trim() || 'reel-index-v2',
          mediaKey: reel.mediaKey,
          sourceDurationMs: reel.sourceDurationMs || 60000,
          outputDurationMs: reel.outputDurationMs || 60000,
          sourceHasAudio: false,
          sourceOrientation: reel.sourceOrientation || 'PORTRAIT',
          sourceLengthClass: reel.sourceLengthClass || 'SHORT',
          title: reel.title || undefined,
          description: reel.description || undefined,
          tags: reel.tags,
          createdAt: now.toISOString(),
          schemaVersion: 1,
        };

        await tx.outboxEvent.create({
          data: {
            id: jobId,
            aggregateType: 'REEL',
            aggregateId: reel.id,
            eventType: 'reel.index.requested.v1',
            payload: indexJob,
            createdAt: now,
            nextAttemptAt: now,
          },
        });

        return { jobId, indexAttemptId };
      });
    },

    async queueIndexingForAll(botUserId, options = {}) {
      if (!prisma) throw new Error('Not connected');

      const where = {
        userId: botUserId,
        ...(options.onlyUnindexed
          ? { indexStatus: { in: ['NOT_REQUESTED', 'FAILED'] } }
          : {}),
      };

      const reels = await prisma.reel.findMany({
        where,
        select: { id: true, title: true, episodeNumber: true },
        orderBy: { createdAt: 'asc' },
      });

      console.log(`Found ${reels.length} reels to queue for metadata indexing`);
      let queued = 0;
      for (const reel of reels) {
        await this.queueIndexingForReel(reel.id);
        queued++;
        if (options.onProgress) {
          options.onProgress(queued, reels.length, reel.title);
        }
      }
      return queued;
    },

    async ingestSeriesEpisodes(botUserId, seriesId, series, queueIndexing = false) {
      if (!prisma) throw new Error('Not connected');

      const episodes = series.episodes || [];
      if (episodes.length === 0) return 0;

      const existingReels = await prisma.reel.findMany({
        where: { seriesId },
        select: { id: true, episodeNumber: true, indexStatus: true, mediaAttemptId: true },
      });
      const existingMap = new Map(existingReels.map((r) => [r.episodeNumber, r]));

      const now = new Date();
      const newReelRecords = [];
      const newOutboxRecords = [];

      for (const ep of episodes) {
        const epNum = ep.episodeNumber;
        const existing = existingMap.get(epNum);
        const description = (ep.episodeDescription || '').substring(0, 2000);
        const tags = ['narto-drama', 'short-drama', series.slug];

        if (existing) {
          if (queueIndexing && existing.indexStatus !== 'PENDING' && existing.indexStatus !== 'COMPLETED') {
            const indexAttemptId = crypto.randomUUID();
            const jobId = crypto.randomUUID();
            await prisma.reel.update({
              where: { id: existing.id },
              data: {
                indexStatus: 'PENDING',
                indexAttemptId,
                processingStage: 'INDEX_QUEUED',
                processingMessage: 'Metadata indexing queued',
              },
            });
            newOutboxRecords.push({
              id: jobId,
              aggregateType: 'REEL',
              aggregateId: existing.id,
              eventType: 'reel.index.requested.v1',
              payload: {
                jobId,
                reelId: existing.id,
                userId: botUserId,
                mediaAttemptId: existing.mediaAttemptId || crypto.randomUUID(),
                indexAttemptId,
                indexVersion: process.env.INDEX_VERSION?.trim() || 'reel-index-v2',
                mediaKey: ep.playerUrl || '',
                sourceDurationMs: 60000,
                outputDurationMs: 60000,
                sourceHasAudio: false,
                sourceOrientation: 'PORTRAIT',
                sourceLengthClass: 'SHORT',
                title: ep.episodeTitle || undefined,
                description: description || undefined,
                tags,
                createdAt: now.toISOString(),
                schemaVersion: 1,
              },
              createdAt: now,
              nextAttemptAt: now,
            });
          }
        } else {
          const reelId = crypto.randomUUID();
          const mediaAttemptId = crypto.randomUUID();
          const processingAttemptId = crypto.randomUUID();
          const indexAttemptId = crypto.randomUUID();
          const jobId = crypto.randomUUID();

          newReelRecords.push({
            id: reelId,
            userId: botUserId,
            mediaKey: ep.playerUrl || '',
            title: ep.episodeTitle || `Episode ${ep.episodeNumber}`,
            description,
            tags,
            status: 'COMPLETED',
            mediaStatus: 'COMPLETED',
            indexStatus: queueIndexing ? 'PENDING' : 'NOT_REQUESTED',
            visibility: 'public',
            thumbnailKey: ep.posterUrl || '',
            seriesId,
            episodeNumber: ep.episodeNumber,
            mediaAttemptId,
            processingAttemptId,
            indexAttemptId: queueIndexing ? indexAttemptId : null,
            processingStage: queueIndexing ? 'INDEX_QUEUED' : null,
            processingMessage: queueIndexing ? 'Metadata indexing queued' : null,
            sourceDurationMs: 60000,
            outputDurationMs: 60000,
            sourceOrientation: 'PORTRAIT',
            sourceLengthClass: 'SHORT',
            sourceHasAudio: false,
            createdAt: ep.publishedAt ? new Date(ep.publishedAt) : now,
          });

          if (queueIndexing) {
            newOutboxRecords.push({
              id: jobId,
              aggregateType: 'REEL',
              aggregateId: reelId,
              eventType: 'reel.index.requested.v1',
              payload: {
                jobId,
                reelId,
                userId: botUserId,
                mediaAttemptId,
                indexAttemptId,
                indexVersion: process.env.INDEX_VERSION?.trim() || 'reel-index-v2',
                mediaKey: ep.playerUrl || '',
                sourceDurationMs: 60000,
                outputDurationMs: 60000,
                sourceHasAudio: false,
                sourceOrientation: 'PORTRAIT',
                sourceLengthClass: 'SHORT',
                title: ep.episodeTitle || undefined,
                description: description || undefined,
                tags,
                createdAt: now.toISOString(),
                schemaVersion: 1,
              },
              createdAt: now,
              nextAttemptAt: now,
            });
          }
        }
      }

      if (newReelRecords.length > 0) {
        await prisma.reel.createMany({
          data: newReelRecords,
          skipDuplicates: true,
        });
      }

      if (newOutboxRecords.length > 0) {
        await prisma.outboxEvent.createMany({
          data: newOutboxRecords,
          skipDuplicates: true,
        });
      }

      return episodes.length;
    },

    async ingestAll(botUserId, seriesArray, options = {}) {
      const onProgress = options.onProgress || (() => {});
      const onReelProgress = options.onReelProgress || (() => {});
      const queueIndexing = Boolean(options.queueIndexing);

      let seriesDone = 0;
      let reelsDone = 0;

      for (const series of seriesArray) {
        const seriesId = await this.upsertSeries(botUserId, series);

        if (seriesId) {
          const count = await this.ingestSeriesEpisodes(
            botUserId,
            seriesId,
            series,
            queueIndexing,
          );
          reelsDone += count;
          onReelProgress(reelsDone);
        }

        seriesDone++;
        onProgress(seriesDone, seriesArray.length, series.title);
      }
    },

    async getStats(botUserId) {
      if (!prisma) throw new Error('Not connected');

      try {
        const where = botUserId ? { ownerId: botUserId } : {};
        const reelWhere = botUserId ? { userId: botUserId } : {};

        const seriesCount = await prisma.reelSeries.count({ where });
        const reelCount = await prisma.reel.count({ where: reelWhere });

        const indexingStats = await prisma.reel.groupBy({
          by: ['indexStatus'],
          where: reelWhere,
          _count: { id: true },
        });

        const pendingOutboxCount = await prisma.outboxEvent.count({
          where: {
            eventType: 'reel.index.requested.v1',
            publishedAt: null,
          },
        });

        return {
          seriesCount,
          reelCount,
          indexing: indexingStats.reduce((acc, curr) => {
            acc[curr.indexStatus] = curr._count.id;
            return acc;
          }, {}),
          pendingOutboxCount,
        };
      } catch (err) {
        console.error('Failed to get stats:', err);
        return {
          seriesCount: 0,
          reelCount: 0,
          indexing: {},
          pendingOutboxCount: 0,
        };
      }
    },
  };
}

module.exports = { createIngester };
