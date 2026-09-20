import { RefreshToken } from '@auth/domain/entities/refresh-token.entity';
import { Role } from '@auth/domain/entities/role.entity';

export interface RefreshTokenRotationResult {
  token: RefreshToken;
  refreshToken: string;
}

export interface IAuthRepository {
  assignRole(userId: string, roleName: string): Promise<Role>;
  rollbackRoles(userId: string): Promise<void>;
  createRefreshToken(
    userId: string,
    token: string,
    expiresAt: Date,
    absoluteExpiresAt: Date,
  ): Promise<RefreshToken>;
  getUserRole(userId: string): Promise<string[]>;
  findRefreshToken(token: string): Promise<RefreshToken | null>;
  recoverRotatedRefreshToken(
    id: string,
    requestId: string,
  ): Promise<string | null>;
  rotateRefreshToken(
    id: string,
    token: string,
    expiresAt: Date,
    absoluteExpiresAt: Date,
    requestId?: string,
  ): Promise<RefreshTokenRotationResult | null>;
  updateRefreshToken(id: string, data: Partial<RefreshToken>): Promise<void>;
  revokeAllUserTokens(userId: string): Promise<void>;
  deleteExpiredAndRevokedTokens(): Promise<number>;
}
