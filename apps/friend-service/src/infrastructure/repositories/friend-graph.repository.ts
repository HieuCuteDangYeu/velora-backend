import type {
  IFriendGraphRepository,
  TwoHopFriendCandidateEvidence,
} from '@friend/domain/interfaces/friend-graph.repository.interface';
import { PrismaService } from '@friend/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/friend-client';

@Injectable()
export class FriendGraphRepository implements IFriendGraphRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listRelationshipUserIds(userId: string): Promise<string[]> {
    const friendships = await this.prisma.friendship.findMany({
      where: {
        OR: [{ userOneId: userId }, { userTwoId: userId }],
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
}
