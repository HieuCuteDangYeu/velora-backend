import { CreateMessageDto } from '@common/conversation/dtos/create-message.dto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Message } from '../../domain/entities/message.entity';
import {
  type CreateMessageResult,
  IChatRepository,
} from '../../domain/interfaces/chat.repository.interface';
import type { IConversationMetrics } from '../ports/conversation-metrics.port';

@Injectable()
export class SendMessageUseCase {
  private readonly logger = new Logger(SendMessageUseCase.name);

  constructor(
    @Inject('IChatRepository') private readonly chatRepository: IChatRepository,
    @Inject('IConversationMetrics')
    private readonly metrics: IConversationMetrics,
  ) {}

  async execute(
    dto: CreateMessageDto,
    senderId: string,
  ): Promise<CreateMessageResult> {
    const startedAt = process.hrtime.bigint();
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

    try {
      const result =
        await this.chatRepository.createMessageIdempotently(newMessage);

      this.metrics.recordSend(
        'success',
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
        result.created,
      );

      this.logger.debug(
        result.created
          ? `Message ${result.message.id} saved to conversation ${dto.conversationId}`
          : `Message ${result.message.id} returned for idempotent retry in conversation ${dto.conversationId}`,
      );

      return result;
    } catch (error) {
      this.metrics.recordSend(
        'error',
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
        false,
      );
      throw error;
    }
  }
}
