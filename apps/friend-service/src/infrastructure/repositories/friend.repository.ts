import { Friendship } from '@friend/domain/entities/friendship.entity';
import type {
  AcceptFriendRequestResult,
  CreateOrFindFriendshipResult,
  DeleteFriendRequestResult,
  FriendshipPaginationCursor,
  IFriendRepository,
  PaginatedFriendships,
  TwoHopFriendCandidateEvidence,
} from '@friend/domain/interfaces/friend.repository.interface';
import { PrismaService } from '@friend/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { Prisma, Friendship as PrismaFriendship } from '@prisma/friend-client';

@Injectable()
export class FriendRepository implements IFriendRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createOrFindPending(
    friendship: Friendship,
  ): Promise<CreateOrFindFriendshipResult> {
    return this.createOrFindPendingAttempt(friendship, true);
  }

  async findById(id: string): Promise<Friendship | null> {
    const friendship = await this.prisma.friendship.findUnique({
      where: { id },
    });

    return friendship ? this.toDomain(friendship) : null;
  }

  async findByUsers(
    userId: string,
    otherUserId: string,
  ): Promise<Friendship | null> {
    const { userOneId, userTwoId } = Friendship.createPair(userId, otherUserId);

    const friendship = await this.prisma.friendship.findUnique({
      where: {
        userOneId_userTwoId: {
          userOneId,
          userTwoId,
        },
      },
    });

    return friendship ? this.toDomain(friendship) : null;
  }

  async acceptPendingRequest(
    requestId: string,
    recipientId: string,
    respondedAt: Date,
  ): Promise<AcceptFriendRequestResult> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.friendship.updateMany({
        where: {
          id: requestId,
          recipientId,
          status: 'PENDING',
        },
        data: {
          status: 'ACCEPTED',
          respondedAt,
        },
      });

      if (updated.count === 1) {
        const friendship = await transaction.friendship.findUnique({
          where: {
            id: requestId,
          },
        });

        if (!friendship) {
          return {
            outcome: 'not_found',
          };
        }

        return {
          outcome: 'accepted',
          friendship: this.toDomain(friendship),
        };
      }

      const current = await transaction.friendship.findUnique({
        where: {
          id: requestId,
        },
      });

      if (!current) {
        return {
          outcome: 'not_found',
        };
      }

      if (current.recipientId !== recipientId) {
        return {
          outcome: 'forbidden',
        };
      }

      if (current.status === 'ACCEPTED') {
        return {
          outcome: 'already_accepted',
          friendship: this.toDomain(current),
        };
      }

      return {
        outcome: 'not_pending',
      };
    });
  }

  async deletePendingIncomingRequest(
    requestId: string,
    recipientId: string,
  ): Promise<DeleteFriendRequestResult> {
    return this.prisma.$transaction(async (transaction) => {
      const deleted = await transaction.friendship.deleteMany({
        where: {
          id: requestId,
          recipientId,
          status: 'PENDING',
        },
      });

      if (deleted.count === 1) {
        return {
          outcome: 'deleted',
        };
      }

      const current = await transaction.friendship.findUnique({
        where: {
          id: requestId,
        },
      });

      if (!current) {
        return {
          outcome: 'not_found',
        };
      }

      if (current.recipientId !== recipientId) {
        return {
          outcome: 'forbidden',
        };
      }

      return {
        outcome: 'not_pending',
      };
    });
  }

  async deletePendingOutgoingRequest(
    requestId: string,
    requesterId: string,
  ): Promise<DeleteFriendRequestResult> {
    return this.prisma.$transaction(async (transaction) => {
      const deleted = await transaction.friendship.deleteMany({
        where: {
          id: requestId,
          requesterId,
          status: 'PENDING',
        },
      });

      if (deleted.count === 1) {
        return {
          outcome: 'deleted',
        };
      }

      const current = await transaction.friendship.findUnique({
        where: {
          id: requestId,
        },
      });

      if (!current) {
        return {
          outcome: 'not_found',
        };
      }

      if (current.requesterId !== requesterId) {
        return {
          outcome: 'forbidden',
        };
      }

      return {
        outcome: 'not_pending',
      };
    });
  }

  async deleteAcceptedByUsers(
    userId: string,
    otherUserId: string,
  ): Promise<boolean> {
    const { userOneId, userTwoId } = Friendship.createPair(userId, otherUserId);

    const result = await this.prisma.friendship.deleteMany({
      where: {
        userOneId,
        userTwoId,
        status: 'ACCEPTED',
      },
    });

    return result.count > 0;
  }

  async listIncomingPending(
    userId: string,
    limit: number,
    cursor?: FriendshipPaginationCursor,
  ): Promise<PaginatedFriendships> {
    const records = await this.prisma.friendship.findMany({
      where: {
        recipientId: userId,
        status: 'PENDING',
        ...this.buildCursorFilter('createdAt', cursor),
      },
      orderBy: [
        {
          createdAt: 'desc',
        },
        {
          id: 'asc',
        },
      ],
      take: limit + 1,
    });

    return this.buildPage(records, limit, 'createdAt');
  }

  async listOutgoingPending(
    userId: string,
    limit: number,
    cursor?: FriendshipPaginationCursor,
  ): Promise<PaginatedFriendships> {
    const records = await this.prisma.friendship.findMany({
      where: {
        requesterId: userId,
        status: 'PENDING',
        ...this.buildCursorFilter('createdAt', cursor),
      },
      orderBy: [
        {
          createdAt: 'desc',
        },
        {
          id: 'asc',
        },
      ],
      take: limit + 1,
    });

    return this.buildPage(records, limit, 'createdAt');
  }

  async listAccepted(
    userId: string,
    limit: number,
    cursor?: FriendshipPaginationCursor,
  ): Promise<PaginatedFriendships> {
    const records = await this.prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          {
            userOneId: userId,
          },
          {
            userTwoId: userId,
          },
        ],
        ...this.buildCursorFilter('updatedAt', cursor),
      },
      orderBy: [
        {
          updatedAt: 'desc',
        },
        {
          id: 'asc',
        },
      ],
      take: limit + 1,
    });

    return this.buildPage(records, limit, 'updatedAt');
  }

  private async createOrFindPendingAttempt(
    friendship: Friendship,
    allowRetry: boolean,
  ): Promise<CreateOrFindFriendshipResult> {
    try {
      const created = await this.prisma.friendship.create({
        data: {
          requesterId: friendship.requesterId,
          recipientId: friendship.recipientId,
          userOneId: friendship.userOneId,
          userTwoId: friendship.userTwoId,
          status: 'PENDING',
        },
      });

      return {
        friendship: this.toDomain(created),
        created: true,
      };
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await this.findByUsers(
        friendship.requesterId,
        friendship.recipientId,
      );

      if (existing) {
        return {
          friendship: existing,
          created: false,
        };
      }

      if (allowRetry) {
        return this.createOrFindPendingAttempt(friendship, false);
      }

      throw error;
    }
  }

  async listAcceptedUserIds(userId: string): Promise<string[]> {
    const friendships = await this.prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          {
            userOneId: userId,
          },
          {
            userTwoId: userId,
          },
        ],
      },
      select: {
        userOneId: true,
        userTwoId: true,
      },
    });

    return friendships.map((friendship) =>
      friendship.userOneId === userId
        ? friendship.userTwoId
        : friendship.userOneId,
    );
  }

  async listRelationshipUserIds(userId: string): Promise<string[]> {
    const friendships = await this.prisma.friendship.findMany({
      where: {
        OR: [
          {
            userOneId: userId,
          },
          {
            userTwoId: userId,
          },
        ],
      },
      select: {
        userOneId: true,
        userTwoId: true,
      },
    });

    return [
      ...new Set(
        friendships.map((friendship) =>
          friendship.userOneId === userId
            ? friendship.userTwoId
            : friendship.userOneId,
        ),
      ),
    ];
  }

  async findTwoHopCandidates(
    userId: string,
    limit: number,
  ): Promise<TwoHopFriendCandidateEvidence[]> {
    const take = Math.min(Math.max(limit, 1), 200);

    const rows = await this.prisma.$queryRaw<
      Array<{
        userId: string;
        mutualFriendCount: number;
        adamicAdarScore: number;
      }>
    >(Prisma.sql`
      WITH accepted_edges AS (
        SELECT "userOneId" AS "sourceId", "userTwoId" AS "targetId"
        FROM "Friendship"
        WHERE "status" = 'ACCEPTED'
        UNION ALL
        SELECT "userTwoId" AS "sourceId", "userOneId" AS "targetId"
        FROM "Friendship"
        WHERE "status" = 'ACCEPTED'
      ),
      degrees AS (
        SELECT "sourceId", COUNT(*)::int AS degree
        FROM accepted_edges
        GROUP BY "sourceId"
      ),
      viewer_neighbors AS (
        SELECT "targetId" AS "mutualId"
        FROM accepted_edges
        WHERE "sourceId" = ${userId}
      )
      SELECT
        second_hop."targetId" AS "userId",
        COUNT(DISTINCT second_hop."sourceId")::int AS "mutualFriendCount",
        SUM(
          1.0 / LN(GREATEST(degrees.degree, 2))
        )::double precision AS "adamicAdarScore"
      FROM viewer_neighbors
      INNER JOIN accepted_edges AS second_hop
        ON second_hop."sourceId" = viewer_neighbors."mutualId"
      INNER JOIN degrees
        ON degrees."sourceId" = viewer_neighbors."mutualId"
      WHERE second_hop."targetId" <> ${userId}
        AND NOT EXISTS (
          SELECT 1
          FROM "Friendship" AS existing
          WHERE existing."userOneId" = LEAST(${userId}, second_hop."targetId")
            AND existing."userTwoId" = GREATEST(${userId}, second_hop."targetId")
        )
      GROUP BY second_hop."targetId"
      ORDER BY
        "mutualFriendCount" DESC,
        "adamicAdarScore" DESC,
        "userId" ASC
      LIMIT ${take}
    `);

    return rows.map((row) => ({
      userId: row.userId,
      mutualFriendCount: Number(row.mutualFriendCount),
      adamicAdarScore: Number(row.adamicAdarScore),
    }));
  }

  private buildCursorFilter(
    field: 'createdAt' | 'updatedAt',
    cursor?: FriendshipPaginationCursor,
  ): Prisma.FriendshipWhereInput {
    if (!cursor) {
      return {};
    }

    if (field === 'createdAt') {
      return {
        OR: [
          {
            createdAt: {
              lt: cursor.timestamp,
            },
          },
          {
            createdAt: cursor.timestamp,
            id: {
              gt: cursor.id,
            },
          },
        ],
      };
    }

    return {
      OR: [
        {
          updatedAt: {
            lt: cursor.timestamp,
          },
        },
        {
          updatedAt: cursor.timestamp,
          id: {
            gt: cursor.id,
          },
        },
      ],
    };
  }

  private buildPage(
    records: PrismaFriendship[],
    limit: number,
    cursorField: 'createdAt' | 'updatedAt',
  ): PaginatedFriendships {
    const hasMore = records.length > limit;

    const items = records
      .slice(0, limit)
      .map((friendship) => this.toDomain(friendship));

    const lastItem = items[items.length - 1];

    return {
      items,
      nextCursor:
        hasMore && lastItem
          ? {
              timestamp: lastItem[cursorField]!,
              id: lastItem.id!,
            }
          : null,
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof PrismaClientKnownRequestError && error.code === 'P2002'
    );
  }

  private toDomain(friendship: PrismaFriendship): Friendship {
    return new Friendship(
      friendship.id,
      friendship.requesterId,
      friendship.recipientId,
      friendship.userOneId,
      friendship.userTwoId,
      friendship.status,
      friendship.createdAt,
      friendship.updatedAt,
      friendship.respondedAt,
    );
  }
}
