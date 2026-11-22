import { InvalidTokenError } from '@auth/domain/errors/invalid-token.error';
import type { IBanList } from '@auth/domain/interfaces/ban-list.interface';
import { AccessTokenService } from '@auth/infrastructure/security/access-token.service';
import { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import { JwtPayload } from '@common/auth/interfaces/jwt-payload.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { IAuthRepository } from '../../domain/interfaces/auth.repository.interface';
import type { IUserService } from '../../domain/interfaces/user-service.interface';

/**
 * The authoritative token check, used by sockets, admin routes and anything the gateway
 * cannot decide locally. The gateway verifies ES256 tokens itself for ordinary users, so
 * this runs for admins, for `/auth/me`, and on any doubt. A banned user fails here whether
 * the denylist or only the user record knows about the ban.
 */
@Injectable()
export class VerifyTokenUseCase {
  private readonly logger = new Logger(VerifyTokenUseCase.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly accessTokens: AccessTokenService,
    @Inject('IAuthRepository') private readonly authRepository: IAuthRepository,
    @Inject('IUserService') private readonly userService: IUserService,
    @Inject('IBanList') private readonly banList: IBanList,
  ) {}

  async execute(token: string): Promise<AuthUser> {
    const userId = await this.verifySignature(token);

    if (await this.isDenylisted(userId)) {
      throw new InvalidTokenError();
    }

    const roles = await this.authRepository.getUserRole(userId);
    const user = await this.userService.findByIdForAuth(userId);

    if (!user || user.status === 'BANNED') {
      throw new InvalidTokenError();
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      picture: user.picture ?? undefined,
      isVerified: user.isVerified,
      roles,
    };
  }

  private async verifySignature(token: string): Promise<string> {
    const local = this.accessTokens.verify(token);
    if (local.ok) return local.payload.sub;
    // Access tokens signed before the ES256 rollout (HS256) stay valid until they expire
    // (15 minutes). Remove this branch once that window has passed.
    if (local.reason !== 'algorithm' && local.reason !== 'format')
      throw new InvalidTokenError();

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        algorithms: ['HS256'],
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(
          error.name,
        )
      )
        throw new InvalidTokenError();
      throw error;
    }
    if (payload.tokenType !== 'access') throw new InvalidTokenError();
    return payload.sub;
  }

  private async isDenylisted(userId: string): Promise<boolean> {
    try {
      return await this.banList.isBanned(userId);
    } catch (error) {
      // Redis is down: the user record below still carries the ban status.
      this.logger.warn(
        `Ban list unavailable for user ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
