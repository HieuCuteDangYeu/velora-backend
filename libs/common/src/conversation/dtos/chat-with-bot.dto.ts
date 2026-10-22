import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ChatWithBotSchema = z.object({
  type: z
    .enum(['text', 'image', 'video', 'file', 'call'])
    .optional()
    .default('text'),
  content: z.string().min(1, 'Content cannot be empty'),
});

export class ChatWithBotDto extends createZodDto(ChatWithBotSchema) {}
