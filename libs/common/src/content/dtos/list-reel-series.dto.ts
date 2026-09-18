import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ListReelSeriesQuerySchema = z.object({
  visibility: z.enum(['public', 'friends', 'private']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const [createdAt, id] = value.split('|');
      if (!createdAt || !id) return undefined;

      const date = new Date(createdAt);
      if (Number.isNaN(date.getTime())) return undefined;

      return { createdAt: date, id };
    }),
});

export class ListReelSeriesQueryDto extends createZodDto(
  ListReelSeriesQuerySchema,
) {}
