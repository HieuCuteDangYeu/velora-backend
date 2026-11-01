import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
export const CreateReelCommentSchema = z.object({
  text,
  clientRequestId: z.string().trim().min(1).max(128),
});
export const UpdateReelCommentSchema = z.object({ text });
export const ListReelCommentsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z
    .string()
    .regex(/^[^|]+\|[^|]+$/)
    .refine(
      (value) => !Number.isNaN(Date.parse(value.split('|')[0])),
      'Invalid cursor',
    )
    .optional(),
});
export class CreateReelCommentDto extends createZodDto(
  CreateReelCommentSchema,
) {}
export class UpdateReelCommentDto extends createZodDto(
  UpdateReelCommentSchema,
) {}
export class ListReelCommentsDto extends createZodDto(ListReelCommentsSchema) {}
