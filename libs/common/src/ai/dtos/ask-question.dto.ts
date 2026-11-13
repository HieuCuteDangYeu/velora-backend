import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

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

export const AskQuestionPayloadSchema = z.object({
  message: z.string().min(1),
  userId: z.string(),
  conversationId: z.string(),
  memory: AiChatMemoryContextSchema.optional(),
});

export class AskQuestionPayload extends createZodDto(
  AskQuestionPayloadSchema,
) {}
