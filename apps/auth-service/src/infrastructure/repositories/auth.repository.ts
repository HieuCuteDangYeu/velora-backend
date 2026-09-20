import { RefreshToken } from '@auth/domain/entities/refresh-token.entity';
import { Injectable } from '@nestjs/common';
import { RefreshToken as PrismaRefreshToken } from '@prisma/auth-client';
import { Role } from '../../domain/entities/role.entity';
import { IAuthRepository } from '../../domain/interfaces/auth.repository.interface';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthRepository implements IAuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async assignRole(userId: string, roleName: string): Promise<Role> {
    const role = await this.prisma.role.findUnique({
      where: { name: roleName },
    });

    if (!role) {
      throw new Error(`Role '${roleName}' not found in database.`);
    }

    await this.prisma.userRole.create({
      data: { userId, roleId: role.id },
    });

    return new Role(role.id, role.name);
  }

  async rollbackRoles(userId: string): Promise<void> {
    await this.prisma.userRole.deleteMany({
      where: { userId },
    });
  }

  async createRefreshToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<RefreshToken> {
    const savedToken: PrismaRefreshToken =
      await this.prisma.refreshToken.create({
        data: {
          userId,
          token,
          expiresAt,
          revoked: false,
        },
      });

    return this.toDomain(savedToken);
  }

  async getUserRole(userId: string): Promise<string[]> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId: userId },
      select: { role: true },
    });

    return roles.map((r) => r.role.name);
  }

  async findRefreshToken(token: string): Promise<RefreshToken | null> {
    const found = await this.prisma.refreshToken.findUnique({
      where: { token },
    });

    if (!found) return null;

    return this.toDomain(found);
  }

  async rotateRefreshToken(
    id: string,
    token: string,
    expiresAt: Date,
  ): Promise<RefreshToken> {
    const persistedToken = await this.prisma.$transaction(
      async (transaction) => {
        const rotatedAt = new Date();
        const consumed = await transaction.refreshToken.updateMany({
          where: { id, revoked: false },
          data: {
            revoked: true,
            replacedByToken: token,
            rotatedAt,
          },
        });

        if (consumed.count === 1) {
          return transaction.refreshToken.create({
            data: {
              userId: (
                await transaction.refreshToken.findUniqueOrThrow({
                  where: { id },
                  select: { userId: true },
                })
              ).userId,
              token,
              expiresAt,
              revoked: false,
            },
          });
        }

        const currentToken = await transaction.refreshToken.findUnique({
          where: { id },
        });

        if (!currentToken?.replacedByToken) {
          throw new Error('Refresh token was revoked before rotation');
        }

        return transaction.refreshToken.findUniqueOrThrow({
          where: { token: currentToken.replacedByToken },
        });
      },
    );

    return this.toDomain(persistedToken);
  }

  async updateRefreshToken(
    id: string,
    data: Partial<RefreshToken>,
  ): Promise<void> {
    await this.prisma.refreshToken.update({
      where: { id },
      data: {
        revoked: data.revoked,
      },
    });
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });
  }

  async deleteExpiredAndRevokedTokens(): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: {
        AND: [{ revoked: true }, { expiresAt: { lt: new Date() } }],
      },
    });

    return result.count;
  }

  private toDomain(token: PrismaRefreshToken): RefreshToken {
    return new RefreshToken(
      token.id,
      token.userId,
      token.token,
      token.expiresAt,
      token.revoked,
      token.createdAt,
      token.replacedByToken,
      token.rotatedAt,
    );
  }
}
