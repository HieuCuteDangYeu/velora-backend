import type { IAuthRepository } from '@auth/domain/interfaces/auth.repository.interface';
import type { IBanList } from '@auth/domain/interfaces/ban-list.interface';
import type { IUserService } from '@auth/domain/interfaces/user-service.interface';
import { Inject, Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

@Injectable()
export class BanUserUseCase {
  constructor(
    @Inject('IAuthRepository') private readonly authRepository: IAuthRepository,
    @Inject('IBanList') private readonly banList: IBanList,
    @Inject('IUserService') private readonly userService: IUserService,
  ) {}

  /** Idempotent. Admins cannot be banned; their sessions would otherwise outlive the ban. */
  async execute(userId: string): Promise<void> {
    const roles = await this.authRepository.getUserRole(userId);
    if (roles.includes('ADMIN')) {
      throw new RpcException({
        statusCode: 409,
        message: 'Admin accounts cannot be banned.',
      });
    }

    // Denylist first: from this moment every access token of the user is refused.
    await this.banList.ban(userId);
    await this.authRepository.revokeAllUserTokens(userId);
    await this.userService.invalidateCachedUser(userId);
  }
}
