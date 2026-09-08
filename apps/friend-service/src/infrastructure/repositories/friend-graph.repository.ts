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
  ): Promise<TwoHopFriendCandidateEvidence[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        userId: string;
        mutualFriendCount: number;
        adamicAdarScore: number;
      }>
    >(Prisma.sql`
      WITH viewer_neighbors AS (
        SELECT "userTwoId" AS "mutualId"
        FROM "Friendship"
        WHERE "status" = 'ACCEPTED'
          AND "userOneId" = ${userId}
        UNION ALL
        SELECT "userOneId" AS "mutualId"
        FROM "Friendship"
        WHERE "status" = 'ACCEPTED'
          AND "userTwoId" = ${userId}
      ),
      mutual_edges AS (
        SELECT
          viewer_neighbors."mutualId",
          friendship."userTwoId" AS "candidateId"
        FROM viewer_neighbors
        INNER JOIN "Friendship" AS friendship
          ON friendship."status" = 'ACCEPTED'
          AND friendship."userOneId" = viewer_neighbors."mutualId"
        UNION ALL
        SELECT
          viewer_neighbors."mutualId",
          friendship."userOneId" AS "candidateId"
        FROM viewer_neighbors
        INNER JOIN "Friendship" AS friendship
          ON friendship."status" = 'ACCEPTED'
          AND friendship."userTwoId" = viewer_neighbors."mutualId"
      ),
      mutual_degrees AS (
        SELECT "mutualId", COUNT(*)::int AS degree
        FROM mutual_edges
        GROUP BY "mutualId"
      )
      SELECT
        mutual_edges."candidateId" AS "userId",
        COUNT(DISTINCT mutual_edges."mutualId")::int AS "mutualFriendCount",
        SUM(
          1.0 / LN(GREATEST(mutual_degrees.degree, 2))
        )::double precision AS "adamicAdarScore"
      FROM mutual_edges
      INNER JOIN mutual_degrees
        ON mutual_degrees."mutualId" = mutual_edges."mutualId"
      WHERE mutual_edges."candidateId" <> ${userId}
        AND NOT EXISTS (
          SELECT 1
          FROM "Friendship" AS existing
          WHERE existing."userOneId" = LEAST(${userId}, mutual_edges."candidateId")
            AND existing."userTwoId" = GREATEST(${userId}, mutual_edges."candidateId")
        )
      GROUP BY mutual_edges."candidateId"
      ORDER BY mutual_edges."candidateId" ASC
    `);

    return rows.map((row) => ({
      userId: row.userId,
      mutualFriendCount: Number(row.mutualFriendCount),
      adamicAdarScore: Number(row.adamicAdarScore),
    }));
  }
}
