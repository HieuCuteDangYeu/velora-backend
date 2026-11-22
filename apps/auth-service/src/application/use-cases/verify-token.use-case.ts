import { InvalidTokenError } from '@auth/domain/errors/invalid-token.error';
import type { IBanList } from '@auth/domain/interfaces/ban-list.interface';
import { AccessTokenService } from '@auth/infrastructure/security/access-token.service';
import { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
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
    private readonly accessTokens: AccessTokenService,
    @Inject('IAuthRepository') private readonly authRepository: IAuthRepository,
    @Inject('IUserService') private readonly userService: IUserService,
    @Inject('IBanList') private readonly banList: IBanList,
  ) {}

  async execute(token: string): Promise<AuthUser> {
    const userId = this.verifySignature(token);

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

  /** Only ES256 access tokens are accepted; refresh tokens and anything else are refused. */
  private verifySignature(token: string): string {
    const result = this.accessTokens.verify(token);
    if (!result.ok) throw new InvalidTokenError();
    return result.payload.sub;
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
