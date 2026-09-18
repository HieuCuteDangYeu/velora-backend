import type { ReelViewEvent as DomainReelViewEvent } from '@content/domain/entities/reel-view-event.entity';
import type {
  IReelViewEventRepository,
  PersistReelViewEventsResult,
} from '@content/domain/interfaces/reel-view-event.repository.interface';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/content-client';

interface InsertedReelViewEventRow {
  eventId: string;
  reelId: string;
  userId: string;
  playbackSessionId: string;
  eventType: DomainReelViewEvent['eventType'];
  occurredAt: Date;
}

interface StartedReelViewSession {
  userId: string;
  playbackSessionId: string;
  startedAt: Date;
}

@Injectable()
export class ReelViewEventRepository implements IReelViewEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async persist(
    events: DomainReelViewEvent[],
  ): Promise<PersistReelViewEventsResult> {
    if (events.length === 0) {
      return {
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        countedViews: 0,
        rejectedEventIds: [],
      };
    }

    const userId = events[0].userId;

    const reelIds = [...new Set(events.map((event) => event.reelId))];

    const accessibleReels = await this.prisma.reel.findMany({
      where: {
        id: {
          in: reelIds,
        },
        mediaStatus: 'COMPLETED',
        OR: [
          {
            visibility: 'public',
          },
          {
            userId,
          },
        ],
      },
      select: {
        id: true,
      },
    });

    const accessibleReelIds = new Set(accessibleReels.map((reel) => reel.id));

    const acceptedCandidates = events.filter((event) =>
      accessibleReelIds.has(event.reelId),
    );

    const rejectedEvents = events.filter(
      (event) => !accessibleReelIds.has(event.reelId),
    );

    if (acceptedCandidates.length === 0) {
      return {
        accepted: 0,
        duplicates: 0,
        rejected: rejectedEvents.length,
        countedViews: 0,
        rejectedEventIds: rejectedEvents.map((event) => event.eventId),
      };
    }

    const persisted = await this.prisma.$transaction(async (transaction) => {
      const valueRows = acceptedCandidates.map((event) => {
        const recommendation = event.recommendation;

        return Prisma.sql`(
                ${event.eventId},
                ${event.reelId},
                ${event.userId},
                ${event.playbackSessionId},
                ${event.sequence},
                ${event.eventType}::"ReelViewEventType",
                ${event.source}::"ReelEventSource",
                ${event.watchMs},
                ${event.durationMs},
                ${event.percentageWatched},
                ${event.muted},
                ${event.completed},
                ${event.replayed},
                ${event.skipped},
                ${recommendation?.recommendationId ?? null},
                ${recommendation?.feedSessionId ?? null},
                ${recommendation?.algorithmVersion ?? null},
                ${recommendation?.candidateSource ?? null},
                ${recommendation?.rank ?? null},
                ${recommendation?.generatedAt ?? null},
                ${event.occurredAt}
              )`;
      });

      const insertedEvents = await transaction.$queryRaw<
        InsertedReelViewEventRow[]
      >(
        Prisma.sql`
              INSERT INTO "ReelViewEvent" (
                "eventId",
                "reelId",
                "userId",
                "playbackSessionId",
                "sequence",
                "eventType",
                "source",
                "watchMs",
                "durationMs",
                "percentageWatched",
                "muted",
                "completed",
                "replayed",
                "skipped",
                "recommendationId",
                "feedSessionId",
                "algorithmVersion",
                "candidateSource",
                "rank",
                "recommendationGeneratedAt",
                "occurredAt"
              )
              VALUES ${Prisma.join(valueRows)}
              ON CONFLICT DO NOTHING
              RETURNING
                "eventId",
                "reelId",
                "userId",
                "playbackSessionId",
                "eventType",
                "occurredAt"
            `,
      );

      const startedSessionsByReel = new Map<
        string,
        Map<string, StartedReelViewSession>
      >();

      for (const event of insertedEvents) {
        if (event.eventType !== 'WATCH_START') {
          continue;
        }

        const sessions =
          startedSessionsByReel.get(event.reelId) ??
          new Map<string, StartedReelViewSession>();

        const sessionKey = `${event.userId}:${event.playbackSessionId}`;

        const existing = sessions.get(sessionKey);

        if (!existing || event.occurredAt < existing.startedAt) {
          sessions.set(sessionKey, {
            userId: event.userId,
            playbackSessionId: event.playbackSessionId,
            startedAt: event.occurredAt,
          });
        }

        startedSessionsByReel.set(event.reelId, sessions);
      }

      let countedViews = 0;

      for (const [reelId, sessions] of startedSessionsByReel) {
        const createdSessions = await transaction.reelViewSession.createMany({
          data: [...sessions.values()].map((session) => ({
            reelId,
            userId: session.userId,
            playbackSessionId: session.playbackSessionId,
            startedAt: session.startedAt,
          })),
          skipDuplicates: true,
        });

        if (createdSessions.count === 0) {
          continue;
        }

        await transaction.reel.update({
          where: {
            id: reelId,
          },
          data: {
            viewCount: {
              increment: createdSessions.count,
            },
          },
        });

        countedViews += createdSessions.count;
      }

      return {
        inserted: insertedEvents.length,
        countedViews,
      };
    });

    return {
      accepted: persisted.inserted,
      duplicates: acceptedCandidates.length - persisted.inserted,
      rejected: rejectedEvents.length,
      countedViews: persisted.countedViews,
      rejectedEventIds: rejectedEvents.map((event) => event.eventId),
    };
  }
}
