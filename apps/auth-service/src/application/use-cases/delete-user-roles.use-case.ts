import { Inject, Injectable } from '@nestjs/common';
import type { IAuthRepository } from '../../domain/interfaces/auth.repository.interface';
import type { IUserService } from '../../domain/interfaces/user-service.interface';

@Injectable()
export class DeleteUserRolesUseCase {
  constructor(
    @Inject('IAuthRepository')
    private readonly authRepository: IAuthRepository,
    @Inject('IUserService') private readonly userService: IUserService,
  ) {}

  async execute(userId: string): Promise<void> {
    // The user is gone: stop serving its cached identity to socket authentication.
    await this.userService.invalidateCachedUser(userId);
    await this.authRepository.rollbackRoles(userId);
  }
}
