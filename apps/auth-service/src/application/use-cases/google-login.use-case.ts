import { AccountBannedError } from '@auth/domain/errors/account-banned.error';
import { AccessTokenService } from '@auth/infrastructure/security/access-token.service';
import { GoogleProfile } from '@common/auth/interfaces/google-profile.interface';
import { SagaCompensationError } from '@common/domain/errors/saga.error';
import { CreateSocialUserDto } from '@common/user/dtos/create-social-user.dto';
import { UpdateUserPayload } from '@common/user/interfaces/update-user.types';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import {
  getRefreshTokenExpiresAt,
  getRefreshTokenExpiresInSeconds,
} from '../../domain/refresh-token.constants';
import type { IAuthRepository } from '../../domain/interfaces/auth.repository.interface';
import type { IUserService } from '../../domain/interfaces/user-service.interface';

@Injectable()
export class GoogleLoginUseCase {
  constructor(
    @Inject('IUserService') private readonly userService: IUserService,
    @Inject('IAuthRepository') private readonly authRepository: IAuthRepository,
    private readonly accessTokens: AccessTokenService,
    private readonly jwtService: JwtService,
  ) {}

  async execute(profile: GoogleProfile) {
    let user = await this.userService.findByEmail(profile.email);
    if (user?.status === 'BANNED') throw new AccountBannedError();

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

      const payload = {
        sub: userId,
        email: user.email,
        fullName: user.fullName,
        username: user.username,
        picture: user.picture ?? undefined,
        isVerified: user.isVerified,
      };

      const now = new Date();
      const expiresAt = getRefreshTokenExpiresAt(now);

      const accessToken = this.accessTokens.sign({ ...payload, roles });
      const refreshToken = await this.jwtService.signAsync(
        { ...payload, tokenType: 'refresh' },
        {
          expiresIn: getRefreshTokenExpiresInSeconds(now, expiresAt),
          jwtid: randomUUID(),
        },
      );

      await this.authRepository.createRefreshToken(
        userId,
        refreshToken,
        expiresAt,
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
