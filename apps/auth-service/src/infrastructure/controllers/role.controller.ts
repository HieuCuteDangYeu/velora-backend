import { AssignRoleUseCase } from '@auth/application/use-cases/assign-role.use-case';
import { BanUserUseCase } from '@auth/application/use-cases/ban-user.use-case';
import { UnbanUserUseCase } from '@auth/application/use-cases/unban-user.use-case';
import { DeleteUserRolesUseCase } from '@auth/application/use-cases/delete-user-roles.use-case';
import { Controller } from '@nestjs/common';
import {
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
} from '@nestjs/microservices';

@Controller()
export class RoleController {
  constructor(
    private readonly assignRoleUseCase: AssignRoleUseCase,
    private readonly deleteUserRolesUseCase: DeleteUserRolesUseCase,
    private readonly banUserUseCase: BanUserUseCase,
    private readonly unbanUserUseCase: UnbanUserUseCase,
  ) {}

  @MessagePattern('auth.assign_role')
  async assignRole(
    @Payload() data: { userId: string; roleName: string },
  ): Promise<void> {
    try {
      await this.assignRoleUseCase.execute(data.userId, data.roleName);
    } catch (error) {
      console.error(error);
      throw new RpcException('Failed to assign role');
    }
  }

  @MessagePattern('auth.ban_user')
  async banUser(@Payload() data: { userId: string }): Promise<{ ok: true }> {
    await this.banUserUseCase.execute(data.userId);
    // A reply with no value makes the caller's lastValueFrom throw EmptyError.
    return { ok: true };
  }

  @MessagePattern('auth.unban_user')
  async unbanUser(@Payload() data: { userId: string }): Promise<{ ok: true }> {
    await this.unbanUserUseCase.execute(data.userId);
    return { ok: true };
  }

  @EventPattern('auth.delete_user_roles')
  async deleteUserRoles(@Payload() data: { userId: string }) {
    await this.deleteUserRolesUseCase.execute(data.userId);
  }
}
