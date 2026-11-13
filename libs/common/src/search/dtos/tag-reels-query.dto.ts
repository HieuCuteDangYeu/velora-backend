import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const cursorSchema = z.string().transform((value, context) => {
  const [createdAt, id] = value.split('|');
  const parsedCreatedAt = createdAt ? new Date(createdAt) : null;

  if (!parsedCreatedAt || Number.isNaN(parsedCreatedAt.getTime()) || !id) {
    context.addIssue({ code: 'custom', message: 'Invalid cursor format' });
    return z.NEVER;
  }

  return { createdAt: parsedCreatedAt, id };
});

export const TagReelsQuerySchema = z.object({
  tag: z.string().trim().min(1).max(96),
  limit: z.coerce.number().int().min(1).max(50).default(24),
  cursor: cursorSchema.optional(),
});

export class TagReelsQueryDto extends createZodDto(TagReelsQuerySchema) {}
