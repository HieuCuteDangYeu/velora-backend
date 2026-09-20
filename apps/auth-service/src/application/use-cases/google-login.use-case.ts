import type { IUserRoleRepository } from '@auth/domain/interfaces/user-role.repository,interface';
import { GoogleProfile } from '@common/auth/interfaces/google-profile.interface';
import { SagaCompensationError } from '@common/domain/errors/saga.error';
import { CreateSocialUserDto } from '@common/user/dtos/create-social-user.dto';
import { UpdateUserPayload } from '@common/user/interfaces/update-user.types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import {
  getRefreshSessionExpiresAt,
  getRefreshTokenExpiresAt,
  getRefreshTokenExpiresInSeconds,
} from '../../domain/refresh-token.constants';
import type { IAuthRepository } from '../../domain/interfaces/auth.repository.interface';
import type { IUserService } from '../../domain/interfaces/user-service.interface';

@Injectable()
export class GoogleLoginUseCase {
  private readonly logger = new Logger(GoogleLoginUseCase.name);

  constructor(
    @Inject('IUserService') private readonly userService: IUserService,
    @Inject('IAuthRepository') private readonly authRepository: IAuthRepository,
    @Inject('IUserRoleRepository')
    private readonly roleCache: IUserRoleRepository,
    private readonly jwtService: JwtService,
  ) {}

  async execute(profile: GoogleProfile) {
    let user = await this.userService.findByEmail(profile.email);

    let isNewUser = false;
    let userId: string | null = null;

    try {
      if (user) {
        userId = user.id;

        if (!user.providerId) {
          const payload: UpdateUserPayload = {
            id: user.id,
            data: {
              provider: 'google',
              providerId: profile.providerId,
              picture: user.picture ? undefined : profile.picture,
            },
          };

          await this.userService.updateUser(payload);

          user = await this.userService.findByEmail(profile.email);
        }
      } else {
        isNewUser = true;

        const createDto: CreateSocialUserDto = {
          email: profile.email,
          fullName: profile.fullName,
          picture: profile.picture,
          provider: 'google',
          providerId: profile.providerId,
          isVerified: true,
        };

        user = await this.userService.createSocialUser(createDto);
        userId = user.id;
      }

      if (isNewUser && userId) {
        await this.authRepository.assignRole(userId, 'USER');
      }

      if (!userId || !user) {
        throw new Error('User state invalid after login flow.');
      }

      const roles = await this.authRepository.getUserRole(userId);

      try {
        await this.roleCache.setUserRoles(userId, roles);
      } catch (error) {
        this.logger.warn(
          `Failed to cache roles for user ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const payload = {
        sub: userId,
        email: user.email,
        fullName: user.fullName,
        username: user.username,
        picture: user.picture,
        isVerified: user.isVerified,
      };

      const now = new Date();
      const absoluteExpiresAt = getRefreshSessionExpiresAt(now);
      const expiresAt = getRefreshTokenExpiresAt(now, absoluteExpiresAt);

      const accessToken = await this.jwtService.signAsync(payload, {
        expiresIn: '15m',
      });
      const refreshToken = await this.jwtService.signAsync(payload, {
        expiresIn: getRefreshTokenExpiresInSeconds(now, expiresAt),
        jwtid: randomUUID(),
      });

      await this.authRepository.createRefreshToken(
        userId,
        refreshToken,
        expiresAt,
        absoluteExpiresAt,
      );

      return { accessToken, refreshToken };
    } catch (error) {
      console.error('Google Login Saga Failed. Initiating Rollback...', error);

      if (isNewUser && userId) {
        this.userService.rollbackUser(userId);

        try {
          await this.authRepository.rollbackRoles(userId);
        } catch (e) {
          console.error('CRITICAL: Failed to rollback roles locally', e);
        }
      }

      throw new SagaCompensationError('Google Login failed. Please try again.');
    }
  }
}
