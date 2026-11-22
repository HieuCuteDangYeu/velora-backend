import {
  BanUserResponse,
  UnbanUserPayload,
} from '@common/user/interfaces/ban-user.types';
import { Inject, Injectable } from '@nestjs/common';
import type { IAuthService } from '@user/domain/interfaces/auth-service.interface';
import { UserNotFoundError } from '../../domain/errors/user-not-found.error';
import type { IUserRepository } from '../../domain/interfaces/user.repository.interface';

@Injectable()
export class UnbanUserUseCase {
  constructor(
    @Inject('IUserRepository') private readonly userRepository: IUserRepository,
    @Inject('IAuthService') private readonly authService: IAuthService,
  ) {}

  /** Database first, then lift the denylist; a failed second step leaves the user banned. */
  async execute(command: UnbanUserPayload): Promise<BanUserResponse> {
    const user = await this.userRepository.findById(command.id);
    if (!user) throw new UserNotFoundError(command.id);

    await this.userRepository.unban(command.id);
    await this.authService.unbanUser(command.id);

    return { id: command.id, status: 'ACTIVE', message: 'User unbanned' };
  }
}
