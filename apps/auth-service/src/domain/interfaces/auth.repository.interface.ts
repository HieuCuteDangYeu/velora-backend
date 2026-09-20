import { RefreshToken } from '@auth/domain/entities/refresh-token.entity';
import { Role } from '@auth/domain/entities/role.entity';

export interface IAuthRepository {
  assignRole(userId: string, roleName: string): Promise<Role>;
  rollbackRoles(userId: string): Promise<void>;
  createRefreshToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<RefreshToken>;
  getUserRole(userId: string): Promise<string[]>;
  findRefreshToken(token: string): Promise<RefreshToken | null>;
  rotateRefreshToken(
    id: string,
    token: string,
    expiresAt: Date,
  ): Promise<RefreshToken>;
  updateRefreshToken(id: string, data: Partial<RefreshToken>): Promise<void>;
  revokeAllUserTokens(userId: string): Promise<void>;
  deleteExpiredAndRevokedTokens(): Promise<number>;
}
