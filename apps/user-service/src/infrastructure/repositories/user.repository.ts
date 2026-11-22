import {
  BOT_USER_ID,
  DEFAULT_ADMIN_ID,
} from '@common/constants/seed.constants';
import { UserResponse } from '@common/user/interfaces/find-all-users.types';
import { Injectable } from '@nestjs/common';
import { Prisma, User as PrismaUser } from '@prisma/user-client';
import { User } from '@user/domain/entities/user.entity';
import type {
  FindAllParams,
  IUserRepository,
  RecommendedPublicUsersParams,
  SearchPublicUsersParams,
} from '@user/domain/interfaces/user.repository.interface';
import { PrismaService } from '@user/infrastructure/prisma/prisma.service';

@Injectable()
export class UserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toPicture(avatarKey: string | null): string | null {
    if (!avatarKey) {
      return null;
    }

    if (avatarKey.startsWith('http')) {
      return avatarKey;
    }

    const cdnDomain = process.env.R2_PUBLIC_DOMAIN || '';

    return `${cdnDomain}/${avatarKey}`;
  }

  async save(user: User): Promise<User> {
    const dbAvatarKey = user.picture
      ? user.picture.replace(`${process.env.R2_PUBLIC_DOMAIN}/`, '')
      : null;

    const saved = await this.prisma.user.create({
      data: {
        email: user.email,
        fullName: user.fullName,
        username: user.username,
        password: user.password,
        isVerified: user.isVerified,
        avatarKey: dbAvatarKey,
        provider: user.provider,
        providerId: user.providerId,
      },
    });

    return this.toDomain(saved);
  }

  async findByEmail(email: string): Promise<User | null> {
    const found = await this.prisma.user.findUnique({
      where: { email },
    });

    return found ? this.toDomain(found) : null;
  }

  async findById(id: string): Promise<User | null> {
    const found = await this.prisma.user.findUnique({
      where: { id },
    });

    return found ? this.toDomain(found) : null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const found = await this.prisma.user.findUnique({
      where: { username },
    });

    return found ? this.toDomain(found) : null;
  }

  private toDomain(prismaUser: PrismaUser): User {
    return new User(
      prismaUser.id,
      prismaUser.email,
      prismaUser.fullName,
      prismaUser.username,
      prismaUser.password,
      prismaUser.isVerified,
      prismaUser.createdAt,
      this.toPicture(prismaUser.avatarKey),
      prismaUser.provider,
      prismaUser.providerId,
      prismaUser.status,
      prismaUser.bannedAt,
      prismaUser.banReason,
    );
  }

  async findAll(params: FindAllParams): Promise<{
    users: UserResponse[];
    total: number;
  }> {
    const { skip, limit, search, sort } = params;

    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            {
              email: {
                contains: search,
                mode: 'insensitive',
              },
            },
            {
              username: {
                contains: search.toLowerCase(),
              },
            },
            {
              fullName: {
                contains: search,
                mode: 'insensitive',
              },
            },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: limit,
        where,
        orderBy: {
          createdAt: sort || 'desc',
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          username: true,
          avatarKey: true,
          createdAt: true,
          status: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        username: user.username,
        picture: this.toPicture(user.avatarKey),
        createdAt: user.createdAt,
        status: user.status,
      })),
      total,
    };
  }

  async searchPublicUsers(params: SearchPublicUsersParams): Promise<User[]> {
    const excludedUserIds = this.buildExcludedIds(params.excludedUserIds);

    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        id: {
          notIn: excludedUserIds,
        },
        username: {
          not: null,
        },
        OR: [
          {
            username: {
              contains: params.query.toLowerCase(),
            },
          },
          {
            fullName: {
              contains: params.query,
              mode: 'insensitive',
            },
          },
        ],
      },
      take: Math.min(Math.max(params.limit, 1), 30),
      orderBy: [{ username: 'asc' }, { fullName: 'asc' }],
    });

    return users.map((user) => this.toDomain(user));
  }

  async findRecommendedPublicUsers(
    params: RecommendedPublicUsersParams,
  ): Promise<User[]> {
    const excludedUserIds = this.buildExcludedIds(params.excludedUserIds);

    const limit = Math.min(Math.max(params.limit ?? 20, 1), 30);

    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        id: {
          notIn: excludedUserIds,
        },
        username: {
          not: null,
        },
      },
      take: limit,
      orderBy: [
        { isVerified: 'desc' },
        { createdAt: 'desc' },
        { username: 'asc' },
      ],
    });

    return users.map((user) => this.toDomain(user));
  }

  async isUsernameAvailable(
    username: string,
    excludeUserId?: string,
  ): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: {
        username,
        id: excludeUserId
          ? {
              not: excludeUserId,
            }
          : undefined,
      },
    });

    return count === 0;
  }

  async update(id: string, data: Partial<User>): Promise<User> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, createdAt: _date, picture, ...cleanData } = data;

    const updateData: Prisma.UserUpdateInput = {
      ...cleanData,
    };

    if (picture !== undefined) {
      updateData.avatarKey = picture
        ? picture.replace(`${process.env.R2_PUBLIC_DOMAIN}/`, '')
        : null;
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: updateData,
    });

    return this.toDomain(updated);
  }

  async delete(id: string): Promise<User> {
    const deleted = await this.prisma.user.delete({
      where: { id },
    });

    return this.toDomain(deleted);
  }

  async ban(
    id: string,
    data: { reason: string; bannedBy: string },
  ): Promise<User> {
    const banned = await this.prisma.user.update({
      where: { id },
      data: {
        status: 'BANNED',
        bannedAt: new Date(),
        banReason: data.reason,
        bannedBy: data.bannedBy,
      },
    });

    return this.toDomain(banned);
  }

  async unban(id: string): Promise<User> {
    const restored = await this.prisma.user.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        bannedAt: null,
        banReason: null,
        bannedBy: null,
      },
    });

    return this.toDomain(restored);
  }

  async findBannedIds(): Promise<string[]> {
    const banned = await this.prisma.user.findMany({
      where: { status: 'BANNED' },
      select: { id: true },
    });
    return banned.map((user) => user.id);
  }

  async findByIds(ids: string[]): Promise<User[]> {
    const users = await this.prisma.user.findMany({
      where: {
        id: {
          in: ids,
        },
      },
    });

    return users.map((user) => this.toDomain(user));
  }

  async countUsersByIds(ids: string[]): Promise<number> {
    return this.prisma.user.count({
      where: {
        id: {
          in: ids,
        },
      },
    });
  }

  private buildExcludedIds(excludedUserIds?: string[]): string[] {
    return [
      ...new Set([BOT_USER_ID, DEFAULT_ADMIN_ID, ...(excludedUserIds ?? [])]),
    ].filter(Boolean);
  }
}
