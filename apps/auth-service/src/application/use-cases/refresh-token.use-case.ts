import type { IUserRoleRepository } from '@auth/domain/interfaces/user-role.repository,interface';
import { JwtPayload } from '@common/auth/interfaces/jwt-payload.interface';
import { TokenResponse } from '@common/auth/interfaces/token.interface';
import type { ValidateUserResponse } from '@common/user/interfaces/validate-user-response.types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import {
  getRefreshTokenExpiresAt,
  getRefreshTokenExpiresInSeconds,
} from '../../domain/refresh-token.constants';
import { InvalidTokenError } from '../../domain/errors/invalid-token.error';
import type { IAuthRepository } from '../../domain/interfaces/auth.repository.interface';
import type { IUserService } from '../../domain/interfaces/user-service.interface';

@Injectable()
export class RefreshTokenUseCase {
  private readonly logger = new Logger(RefreshTokenUseCase.name);

  constructor(
    @Inject('IAuthRepository') private readonly authRepository: IAuthRepository,
    @Inject('IUserService') private readonly userService: IUserService,
    @Inject('IUserRoleRepository')
    private readonly roleCache: IUserRoleRepository,
    private readonly jwtService: JwtService,
  ) {}

  async execute(
    incomingRefreshToken: string,
    refreshRequestId?: string,
  ): Promise<TokenResponse> {
    try {
      const payload =
        await this.jwtService.verifyAsync<JwtPayload>(incomingRefreshToken);

      const storedToken =
        await this.authRepository.findRefreshToken(incomingRefreshToken);

      if (!storedToken) {
        await this.authRepository.revokeAllUserTokens(payload.sub);
        throw new InvalidTokenError();
      }

      if (storedToken.revoked) {
        if (!refreshRequestId) {
          await this.authRepository.revokeAllUserTokens(payload.sub);
          throw new InvalidTokenError();
        }

        const replacementToken =
          await this.authRepository.recoverRotatedRefreshToken(
            storedToken.id,
            refreshRequestId,
          );

        if (!replacementToken) {
          await this.authRepository.revokeAllUserTokens(payload.sub);
          throw new InvalidTokenError();
        }

        const user = await this.userService.findById(payload.sub);

        if (!user) {
          throw new InvalidTokenError();
        }

        const accessToken = await this.jwtService.signAsync(
          this.createJwtPayload(user),
          { expiresIn: '15m' },
        );

        return { accessToken, refreshToken: replacementToken };
      }

      if (
        !storedToken.isActive() ||
        (storedToken.absoluteExpiresAt !== null &&
          storedToken.absoluteExpiresAt <= new Date())
      ) {
        throw new InvalidTokenError();
      }

      const roles = await this.authRepository.getUserRole(payload.sub);

      try {
        await this.roleCache.setUserRoles(payload.sub, roles);
      } catch (error) {
        this.logger.warn(
          `Failed to cache roles for user ${payload.sub}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const user = await this.userService.findById(payload.sub);

      if (!user) {
        throw new InvalidTokenError();
      }

      const newPayload = this.createJwtPayload(user);

      const now = new Date();
      const absoluteExpiresAt =
        storedToken.absoluteExpiresAt ?? storedToken.expiresAt;
      const expiresAt = getRefreshTokenExpiresAt(now, absoluteExpiresAt);

      const accessToken = await this.jwtService.signAsync(newPayload, {
        expiresIn: '15m',
      });
      const refreshToken = await this.jwtService.signAsync(newPayload, {
        expiresIn: getRefreshTokenExpiresInSeconds(now, expiresAt),
        jwtid: randomUUID(),
      });

      const persistedRefreshToken =
        await this.authRepository.rotateRefreshToken(
          storedToken.id,
          refreshToken,
          expiresAt,
          absoluteExpiresAt,
          refreshRequestId,
        );

      if (!persistedRefreshToken) {
        await this.authRepository.revokeAllUserTokens(payload.sub);
        throw new InvalidTokenError();
      }

      return {
        accessToken,
        refreshToken: persistedRefreshToken.refreshToken,
      };
    } catch (error) {
      if (!(error instanceof InvalidTokenError)) {
        this.logger.error(
          'Failed to refresh token',
          error instanceof Error ? error.stack : undefined,
        );
      }

      throw new InvalidTokenError();
    }
  }

  private createJwtPayload(user: ValidateUserResponse): JwtPayload {
    return {
      sub: user.id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      picture: user.picture ?? undefined,
      isVerified: user.isVerified,
    };
  }
}
