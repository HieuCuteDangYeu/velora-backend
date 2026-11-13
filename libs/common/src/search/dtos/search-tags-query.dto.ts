import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const SearchTagsQuerySchema = z.object({
  /** Omit for trending tags; provide for prefix/substring matches. */
  q: z.string().trim().max(96).optional(),
  limit: z.coerce.number().int().min(1).max(30).default(12),
});

export class SearchTagsQueryDto extends createZodDto(SearchTagsQuerySchema) {}
