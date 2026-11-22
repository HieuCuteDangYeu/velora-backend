import {
  BanUserPayload,
  BanUserResponse,
} from '@common/user/interfaces/ban-user.types';
import { Inject, Injectable } from '@nestjs/common';
import type { IAuthService } from '@user/domain/interfaces/auth-service.interface';
import { UserNotFoundError } from '../../domain/errors/user-not-found.error';
import type { IUserRepository } from '../../domain/interfaces/user.repository.interface';

@Injectable()
export class BanUserUseCase {
  constructor(
    @Inject('IUserRepository') private readonly userRepository: IUserRepository,
    @Inject('IAuthService') private readonly authService: IAuthService,
  ) {}

  /**
   * Auth-service goes first: it refuses admins, then denylists the user and revokes the
   * sessions. If the database write fails afterwards the user is already locked out
   * (the safe direction) and the admin can repeat the call, which is idempotent.
   */
  async execute(command: BanUserPayload): Promise<BanUserResponse> {
    const user = await this.userRepository.findById(command.id);
    if (!user) throw new UserNotFoundError(command.id);

    await this.authService.banUser(command.id);
    await this.userRepository.ban(command.id, {
      reason: command.reason,
      bannedBy: command.bannedBy,
    });

    return { id: command.id, status: 'BANNED', message: 'User banned' };
  }
}
