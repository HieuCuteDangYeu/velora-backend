import { RefreshToken } from '@auth/domain/entities/refresh-token.entity';
import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import { RefreshToken as PrismaRefreshToken } from '@prisma/auth-client';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'crypto';
import { Role } from '../../domain/entities/role.entity';
import { getRefreshRequestExpiresAt } from '../../domain/refresh-token.constants';
import {
  IAuthRepository,
  RefreshTokenRotationResult,
} from '../../domain/interfaces/auth.repository.interface';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthRepository implements IAuthRepository {
  private readonly tokenEncryptionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.tokenEncryptionKey = createHash('sha256')
      .update(
        `velora-refresh-token:${configService.getOrThrow<string>('JWT_SECRET')}`,
      )
      .digest();
  }

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
    absoluteExpiresAt: Date,
  ): Promise<RefreshToken> {
    const savedToken: PrismaRefreshToken =
      await this.prisma.refreshToken.create({
        data: {
          userId,
          token: this.hashToken(token),
          encryptedToken: this.encryptToken(token),
          expiresAt,
          absoluteExpiresAt,
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
    let found = await this.prisma.refreshToken.findUnique({
      where: { token: this.hashToken(token) },
    });

    if (!found) {
      found = await this.prisma.refreshToken.findUnique({ where: { token } });
    }

    if (!found) return null;

    if (found.token !== this.hashToken(token) || !found.encryptedToken) {
      found = await this.prisma.refreshToken.update({
        where: { id: found.id },
        data: {
          token: this.hashToken(token),
          encryptedToken: this.encryptToken(token),
          replacedByToken: null,
        },
      });
    }

    return this.toDomain(found);
  }

  async recoverRotatedRefreshToken(
    id: string,
    requestId: string,
  ): Promise<string | null> {
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { id },
    });

    if (
      !storedToken ||
      !storedToken.revoked ||
      storedToken.rotationRequestId !== requestId ||
      !storedToken.replacedByTokenId ||
      !storedToken.rotationRequestExpiresAt ||
      storedToken.rotationRequestExpiresAt <= new Date()
    ) {
      return null;
    }

    const replacement = await this.prisma.refreshToken.findUnique({
      where: { id: storedToken.replacedByTokenId },
    });

    if (
      !replacement ||
      replacement.revoked ||
      replacement.expiresAt <= new Date() ||
      !replacement.encryptedToken
    ) {
      return null;
    }

    return this.decryptToken(replacement.encryptedToken);
  }

  async rotateRefreshToken(
    id: string,
    token: string,
    expiresAt: Date,
    absoluteExpiresAt: Date,
    requestId?: string,
  ): Promise<RefreshTokenRotationResult | null> {
    const replacementId = randomUUID();
    const tokenHash = this.hashToken(token);
    const persistedToken = await this.prisma.$transaction(
      async (transaction) => {
        const rotatedAt = new Date();
        const consumed = await transaction.refreshToken.updateMany({
          where: { id, revoked: false },
          data: {
            revoked: true,
            replacedByTokenId: replacementId,
            rotationRequestId: requestId ?? null,
            rotationRequestExpiresAt: requestId
              ? getRefreshRequestExpiresAt(rotatedAt)
              : null,
            rotatedAt,
          },
        });

        if (consumed.count === 1) {
          const currentToken = await transaction.refreshToken.findUniqueOrThrow(
            {
              where: { id },
              select: { userId: true },
            },
          );

          return transaction.refreshToken.create({
            data: {
              id: replacementId,
              userId: currentToken.userId,
              token: tokenHash,
              encryptedToken: this.encryptToken(token),
              expiresAt,
              absoluteExpiresAt,
              revoked: false,
            },
          });
        }

        const currentToken = await transaction.refreshToken.findUnique({
          where: { id },
        });

        if (
          !requestId ||
          currentToken?.rotationRequestId !== requestId ||
          !currentToken.replacedByTokenId ||
          !currentToken.rotationRequestExpiresAt ||
          currentToken.rotationRequestExpiresAt <= new Date()
        ) {
          return null;
        }

        return transaction.refreshToken.findUniqueOrThrow({
          where: { id: currentToken.replacedByTokenId },
        });
      },
    );

    if (!persistedToken) return null;

    return {
      token: this.toDomain(persistedToken),
      refreshToken:
        persistedToken.token === tokenHash
          ? token
          : this.decryptToken(persistedToken.encryptedToken!),
    };
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
        expiresAt: { lt: new Date() },
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
      token.replacedByTokenId,
      token.rotationRequestId,
      token.rotatedAt,
      token.absoluteExpiresAt,
      token.rotationRequestExpiresAt,
    );
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private encryptToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.tokenEncryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);

    return [
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  private decryptToken(value: string): string {
    const [ivValue, authTagValue, encryptedValue] = value.split('.');
    if (!ivValue || !authTagValue || !encryptedValue) {
      throw new Error('Invalid encrypted refresh token');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.tokenEncryptionKey,
      Buffer.from(ivValue, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(authTagValue, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
