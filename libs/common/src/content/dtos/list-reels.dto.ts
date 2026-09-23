import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const userIdSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'Invalid userId format',
  );

const booleanQuerySchema = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    return value.toLowerCase() === 'true';
  });

export const ListReelsQuerySchema = z.object({
  userId: userIdSchema.optional(),
  seriesId: userIdSchema.optional(),
  visibility: z.enum(['public', 'private']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  ranked: booleanQuerySchema,
  cursor: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return undefined;

      const [createdAt, id] = val.split('|');

      if (!createdAt || !id) return undefined;

      const date = new Date(createdAt);

      if (isNaN(date.getTime())) return undefined;

      return { createdAt: date, id };
    }),
});

export class ListReelsQueryDto extends createZodDto(ListReelsQuerySchema) {}
