import { Inject, Injectable } from '@nestjs/common';
import { Conversation } from '../../domain/entities/conversation.entity';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';

@Injectable()
export class GetUserConversationsUseCase {
  constructor(
    @Inject('IChatRepository')
    private readonly chatRepository: IChatRepository,
  ) {}

  async execute(
    userId: string,
    limit: number = 20,
    cursor?: string,
    search?: string,
  ): Promise<Conversation[]> {
    return await this.chatRepository.findConversationsByUserId(
      userId,
      limit,
      cursor,
      search,
    );
  }
}
