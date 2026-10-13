import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { GetGroupMembersUseCase } from '../../application/use-cases/get-group-members.use-case';
import { ManageGroupRoleUseCase } from '../../application/use-cases/manage-group-role.use-case';
import { ChatGateway } from '../gateways/chat.gateway';
import { toRpcException } from '../rpc/to-rpc-exception';

@Controller()
export class GroupMembersMicroserviceController {
  private readonly logger = new Logger(GroupMembersMicroserviceController.name);

  constructor(
    private readonly getGroupMembersUseCase: GetGroupMembersUseCase,
    private readonly manageGroupRoleUseCase: ManageGroupRoleUseCase,
    private readonly chatGateway: ChatGateway,
  ) {}

  @MessagePattern('get_group_member_projection')
  async handleGetGroupMemberProjection(
    @Payload() data: { conversationId: string; requesterUserId: string },
  ) {
    try {
      return await this.getGroupMembersUseCase.execute(
        data.conversationId,
        data.requesterUserId,
      );
    } catch (error) {
      const resolved = error as Error;
      this.logger.error(
        `❌ [GetGroupMemberProjection] Error: ${resolved.message}`,
      );
      throw toRpcException(error);
    }
  }

  @MessagePattern('update_group_member_role')
  async handleUpdateGroupMemberRole(
    @Payload()
    data: {
      conversationId: string;
      actorUserId: string;
      targetUserId: string;
      role: 'ADMIN' | 'MEMBER';
    },
  ) {
    try {
      const result = await this.manageGroupRoleUseCase.updateRole(data);
      if (result.changed) {
        this.chatGateway.emitConversationUpdated(result.conversation);
      }
      return result.member;
    } catch (error) {
      const resolved = error as Error;
      this.logger.error(
        `❌ [UpdateGroupMemberRole] Error: ${resolved.message}`,
      );
      throw toRpcException(error);
    }
  }
}
