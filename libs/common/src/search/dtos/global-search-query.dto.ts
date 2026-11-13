import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const GlobalSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(96),
  type: z.enum(['all', 'users', 'reels', 'tags']).default('all'),
  limit: z.coerce.number().int().min(1).max(30).default(12),
});

export class GlobalSearchQueryDto extends createZodDto(
  GlobalSearchQuerySchema,
) {}
