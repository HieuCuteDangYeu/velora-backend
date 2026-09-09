import { CreateMessageDto } from '@common/conversation/dtos/create-message.dto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Message } from '../../domain/entities/message.entity';
import {
  type CreateMessageResult,
  IChatRepository,
} from '../../domain/interfaces/chat.repository.interface';

@Injectable()
export class SendMessageUseCase {
  private readonly logger = new Logger(SendMessageUseCase.name);

  constructor(
    @Inject('IChatRepository') private readonly chatRepository: IChatRepository,
  ) {}

  async execute(
    dto: CreateMessageDto,
    senderId: string,
  ): Promise<CreateMessageResult> {
    const newMessage = new Message({
      id: '',
      conversationId: dto.conversationId,
      senderId,
      clientMessageId: dto.clientMessageId?.trim() || undefined,
      content: dto.content,
      media: dto.media,
      signalType: dto.signalType,
      type: dto.type,
      createdAt: new Date(),
      replyToId: dto.replyToId,
    });

    const result =
      await this.chatRepository.createMessageIdempotently(newMessage);

    this.logger.debug(
      result.created
        ? `Message ${result.message.id} saved to conversation ${dto.conversationId}`
        : `Message ${result.message.id} returned for idempotent retry in conversation ${dto.conversationId}`,
    );

    return result;
  }
}
