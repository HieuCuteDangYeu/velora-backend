import { AccountNotVerifiedError } from '@auth/domain/errors/account-not-verified.error';
import { InvalidCredentialsError } from '@auth/domain/errors/invalid-credentials.error';
import { AccountBannedError } from '@auth/domain/errors/account-banned.error';
import { AccessTokenService } from '@auth/infrastructure/security/access-token.service';
import { LoginDto } from '@common/auth/dtos/login.dto';
import { JwtPayload } from '@common/auth/interfaces/jwt-payload.interface';
import { TokenResponse } from '@common/auth/interfaces/token.interface';
import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  getRefreshTokenExpiresAt,
  getRefreshTokenExpiresInSeconds,
} from '../../domain/refresh-token.constants';
import type { IAuthRepository } from '../../domain/interfaces/auth.repository.interface';
import type { IUserService } from '../../domain/interfaces/user-service.interface';

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject('IUserService') private readonly userService: IUserService,
    @Inject('IAuthRepository') private readonly authRepository: IAuthRepository,
    private readonly accessTokens: AccessTokenService,
    private readonly jwtService: JwtService,
  ) {}

  async execute(dto: LoginDto): Promise<TokenResponse> {
    const user = await this.userService.validateUser(dto);
    if (!user) throw new InvalidCredentialsError();
    if (user.status === 'BANNED') throw new AccountBannedError();
    if (!user.isVerified) {
      throw new AccountNotVerifiedError();
    }

    const roles = await this.authRepository.getUserRole(user.id);

    const payload: JwtPayload = {
      sub: user.id,
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
      user.id,
      refreshToken,
      expiresAt,
    );

    return {
      accessToken,
      refreshToken,
    };
  }
}
