import {
  DeleteUserPayload,
  DeleteUserResponse,
} from '@common/user/interfaces/delete-user.types';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import type { IAuthService } from '@user/domain/interfaces/auth-service.interface';
import { UserNotFoundError } from '../../domain/errors/user-not-found.error';
import type { IUserRepository } from '../../domain/interfaces/user.repository.interface';

/** Internal only: undoes a registration whose role assignment failed. Accounts are banned, never deleted. */
@Injectable()
export class DeleteUserUseCase {
  constructor(
    @Inject('IUserRepository') private readonly userRepository: IUserRepository,
    @Inject('IAuthService') private readonly authService: IAuthService,
  ) {}

  async execute(command: DeleteUserPayload): Promise<DeleteUserResponse> {
    const { id } = command;

    try {
      const deletedUser = await this.userRepository.delete(id);

      this.authService.deleteUserRoles(id);

      return {
        id: deletedUser.id!,
        message: 'User deleted successfully',
      };
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new UserNotFoundError(id);
      }
      throw error;
    }
  }
}
