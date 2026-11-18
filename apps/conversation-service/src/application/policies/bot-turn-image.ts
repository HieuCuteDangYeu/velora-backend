import type { AskQuestionImage } from '@common/ai/dtos/ask-question.dto';
import {
  type ChatImageMimeType,
  extractChatImageCaption,
  isChatImageKeyOwnedBy,
  isChatImageMimeType,
} from '@common/ai/chat-image';
import type { Message } from '../../domain/entities/message.entity';

const MIME_BY_EXTENSION: Record<string, ChatImageMimeType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * The photo an AI turn may read from an image message: only an upload that belongs to
 * the sender, so a client cannot point the AI at someone else's file. Empty for any
 * other message, which keeps image messages in non-bot flows untouched.
 */
export const resolveBotTurnImages = (message: Message): AskQuestionImage[] => {
  if (message.type !== 'image') return [];

  const fileKey = message.media?.fileKey?.trim();
  if (!fileKey || !isChatImageKeyOwnedBy(message.senderId, fileKey)) return [];

  const declared = message.media?.mimeType?.trim().toLowerCase();
  const mimeType = isChatImageMimeType(declared)
    ? declared
    : MIME_BY_EXTENSION[fileKey.split('.').pop() ?? ''];

  return mimeType ? [{ fileKey, mimeType }] : [];
};

/** What the user wrote to go with the message; '' for a bare photo. */
export const resolveBotTurnCaption = (message: Message): string =>
  message.type === 'image'
    ? extractChatImageCaption(message.content)
    : (message.content ?? '');
