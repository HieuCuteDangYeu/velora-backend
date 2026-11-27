import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const GlobalSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(96),
  type: z.enum(['all', 'users', 'reels', 'tags']).default('all'),
  limit: z.coerce.number().int().min(1).max(30).default(12),
  /** Username of the last account on the previous page; only honoured for type=users. */
  cursor: z.string().trim().min(1).max(64).optional(),
});

export class GlobalSearchQueryDto extends createZodDto(
  GlobalSearchQuerySchema,
) {}
