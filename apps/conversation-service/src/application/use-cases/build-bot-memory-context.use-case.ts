import { extractChatImageCaption } from '@common/ai/chat-image';
import type {
  AiChatMemoryContext,
  AiChatMemoryRole,
} from '@common/ai/interfaces/chat-memory-context.interface';
import { BOT_USER_ID } from '@common/constants/seed.constants';
import { Inject, Injectable } from '@nestjs/common';
import type { Message } from '../../domain/entities/message.entity';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';

type MemoryMessage = AiChatMemoryContext['recentMessages'][number];

@Injectable()
export class BuildBotMemoryContextUseCase {
  /** Newest messages read from storage; the rest of the chat is out of reach for the AI. */
  private readonly historyLimit = 120;
  /** Messages the AI always reads as the live conversation. */
  private readonly finalLimit = 12;
  /** Earlier messages offered for recall, each cut short so the payload stays small. */
  private readonly olderLimit = 80;
  private readonly olderMessageChars = 300;

  constructor(
    @Inject('IChatRepository')
    private readonly chatRepository: IChatRepository,
  ) {}

  async execute(input: {
    conversationId: string;
    currentMessageId: string;
    requesterUserId?: string;
  }): Promise<AiChatMemoryContext> {
    const messages = await this.chatRepository.findMessagesByConversationId(
      input.conversationId,
      this.historyLimit,
    );

    const photoDescriptions = this.collectPhotoDescriptions(messages);

    const memoryMessages = messages
      .filter((message) => message.id !== input.currentMessageId)
      .filter((message) => this.isMemoryEligibleMessage(message))
      .filter((message) => !message.isRecalled)
      .map((message): MemoryMessage => {
        const role: AiChatMemoryRole =
          message.senderId === BOT_USER_ID ? 'assistant' : 'user';

        return {
          role,
          content: this.toMemoryContent(
            message,
            photoDescriptions.get(message.id),
          ),
          createdAt: message.createdAt.toISOString(),
          eventType:
            message.type === 'reel'
              ? ('REEL_SHARE' as const)
              : ('TEXT' as const),
          ...(role === 'user' && input.requesterUserId
            ? { authorIsRequester: message.senderId === input.requesterUserId }
            : {}),
        };
      })
      .filter((message) => message.content.length > 0);

    const recentMessages = memoryMessages.slice(-this.finalLimit);
    const older = memoryMessages
      .slice(0, Math.max(0, memoryMessages.length - this.finalLimit))
      .slice(-this.olderLimit)
      .map((message) => ({
        ...message,
        content: this.clip(message.content, this.olderMessageChars),
      }));

    return {
      recentMessages,
      ...(older.length > 0 ? { olderMessages: older } : {}),
    };
  }

  private isMemoryEligibleMessage(message: Message): boolean {
    return (
      message.type === 'text' ||
      message.type === 'reel' ||
      message.type === 'image'
    );
  }

  /** The bot's reply to a photo carries what the AI saw in it, keyed by the photo's message. */
  private collectPhotoDescriptions(messages: Message[]): Map<string, string> {
    const descriptions = new Map<string, string>();
    for (const message of messages) {
      const { photoOfMessageId, photoDescription } = message.metadata ?? {};
      if (
        message.senderId === BOT_USER_ID &&
        typeof photoOfMessageId === 'string' &&
        typeof photoDescription === 'string' &&
        photoDescription.trim()
      ) {
        descriptions.set(photoOfMessageId, photoDescription.trim());
      }
    }
    return descriptions;
  }

  private toMemoryContent(message: Message, photoDescription?: string): string {
    if (message.type === 'image') {
      // Only the caption and the AI's own description are text; the bytes never enter memory.
      const caption = extractChatImageCaption(message.content);
      const shows = photoDescription ? `shows: ${photoDescription}` : '';
      return ['[Photo]', caption, shows].filter(Boolean).join(' ');
    }

    if (message.type !== 'reel') {
      return message.content?.trim() ?? '';
    }

    const title =
      message.media?.reelTitle?.trim() || message.content?.trim() || 'Untitled';

    return `[Shared reel] ${title}`;
  }

  private clip(text: string, maxChars: number): string {
    return text.length <= maxChars
      ? text
      : `${text.slice(0, maxChars - 1).trimEnd()}…`;
  }
}
