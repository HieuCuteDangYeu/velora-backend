import { AccountNotVerifiedError } from '@auth/domain/errors/account-not-verified.error';
import { InvalidCredentialsError } from '@auth/domain/errors/invalid-credentials.error';
import type { IUserRoleRepository } from '@auth/domain/interfaces/user-role.repository,interface';
import { LoginDto } from '@common/auth/dtos/login.dto';
import { JwtPayload } from '@common/auth/interfaces/jwt-payload.interface';
import { TokenResponse } from '@common/auth/interfaces/token.interface';
import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  getRefreshSessionExpiresAt,
  getRefreshTokenExpiresAt,
  getRefreshTokenExpiresInSeconds,
} from '../../domain/refresh-token.constants';
import type { IAuthRepository } from '../../domain/interfaces/auth.repository.interface';
import type { IUserService } from '../../domain/interfaces/user-service.interface';

@Injectable()
export class LoginUseCase {
  private readonly logger = new Logger(LoginUseCase.name);

  constructor(
    @Inject('IUserService') private readonly userService: IUserService,
    @Inject('IAuthRepository') private readonly authRepository: IAuthRepository,
    @Inject('IUserRoleRepository')
    private readonly userRoleRepository: IUserRoleRepository,
    private readonly jwtService: JwtService,
  ) {}

  async execute(dto: LoginDto): Promise<TokenResponse> {
    const user = await this.userService.validateUser(dto);
    if (!user) throw new InvalidCredentialsError();
    if (!user.isVerified) {
      throw new AccountNotVerifiedError();
    }

    const roles = await this.authRepository.getUserRole(user.id);

    try {
      await this.userRoleRepository.setUserRoles(user.id, roles);
    } catch (error) {
      this.logger.warn(
        `Failed to cache roles for user ${user.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      picture: user.picture ?? undefined,
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
      user.id,
      refreshToken,
      expiresAt,
      absoluteExpiresAt,
    );

    return {
      accessToken,
      refreshToken,
    };
  }
}
