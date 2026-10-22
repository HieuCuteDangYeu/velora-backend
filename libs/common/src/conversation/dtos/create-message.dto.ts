import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MessageMediaSchema } from './message-media.schema';

export const ConversationMessageTypeSchema = z.enum([
  'text',
  'image',
  'video',
  'file',
  'call',
  'reel',
]);

export type ConversationMessageType = z.infer<
  typeof ConversationMessageTypeSchema
>;

export const CreateMessageSchema = z.object({
  conversationId: z.string().min(1, 'Conversation ID is required'),
  clientMessageId: z
    .string()
    .trim()
    .min(1, 'Client message ID cannot be empty')
    .max(200, 'Client message ID is too long'),
  type: ConversationMessageTypeSchema.optional().default('text'),
  content: z.string().min(1, 'Content cannot be empty'),
  media: MessageMediaSchema.optional(),
  replyToId: z.string().min(1, 'Reply message ID cannot be empty').optional(),
});

export class CreateMessageDto extends createZodDto(CreateMessageSchema) {}
