import { Friendship } from '@friend/domain/entities/friendship.entity';
import type {
  AcceptFriendRequestResult,
  CreateOrFindFriendshipResult,
  DeleteFriendRequestResult,
  FriendshipPaginationCursor,
  IFriendRepository,
  PaginatedFriendships,
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
