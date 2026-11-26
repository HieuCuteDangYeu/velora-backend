import { Inject, Injectable } from '@nestjs/common';
import type { IAuthService } from '@user/domain/interfaces/auth-service.interface';
import { UserNotFoundError } from '../../domain/errors/user-not-found.error';
import type { IUserRepository } from '../../domain/interfaces/user.repository.interface';

export interface DeleteOwnAccountPayload {
  userId: string;
}

/**
 * Account deletion requested by the user (App Review guideline 5.1.1(v)).
 * Auth-service goes first, as for a ban: it ends every session and denylists
 * the id, so the account is locked out even if erasing the profile fails and
 * the user retries. Then name, e-mail, username, password, sign-in provider
 * and avatar are erased.
 */
@Injectable()
export class DeleteOwnAccountUseCase {
  constructor(
    @Inject('IUserRepository') private readonly userRepository: IUserRepository,
    @Inject('IAuthService') private readonly authService: IAuthService,
  ) {}

  async execute({ userId }: DeleteOwnAccountPayload) {
    const user = await this.userRepository.findById(userId);
    if (!user) throw new UserNotFoundError(userId);

    await this.authService.banUser(userId);
    await this.userRepository.eraseDeletedAccount(userId);

    return { id: userId, message: 'Account deleted' };
  }
}
