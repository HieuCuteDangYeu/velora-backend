import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  CHAT_IMAGE_MIME_TYPES,
  MAX_CHAT_IMAGES_PER_AI_TURN,
} from '../chat-image';

export const AiChatMessageContextSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  createdAt: z.string(),
  eventType: z.enum(['TEXT', 'REEL_SHARE']).optional(),
  authorIsRequester: z.boolean().optional(),
});

export const AiChatMemoryContextSchema = z.object({
  recentMessages: z.array(AiChatMessageContextSchema).default([]),
});

export const AskQuestionImageSchema = z.object({
  /** R2 key of an image the requester uploaded to chat; ai-service re-checks ownership. */
  fileKey: z.string().min(1).max(512),
  mimeType: z.enum(CHAT_IMAGE_MIME_TYPES),
});

export const AskQuestionPayloadSchema = z.object({
  /** The user's words. May be empty only when `images` is present (a photo sent without a caption). */
  message: z.string(),
  userId: z.string(),
  conversationId: z.string(),
  memory: AiChatMemoryContextSchema.optional(),
  /** The Reel the user swipe-replied to, so "this reel" resolves to it. */
  replyToReelId: z.string().min(1).max(128).optional(),
  /** Images sent with this turn, read by the AI from storage. */
  images: z
    .array(AskQuestionImageSchema)
    .max(MAX_CHAT_IMAGES_PER_AI_TURN)
    .optional(),
});

export type AskQuestionImage = z.infer<typeof AskQuestionImageSchema>;

export class AskQuestionPayload extends createZodDto(
  AskQuestionPayloadSchema,
) {}
