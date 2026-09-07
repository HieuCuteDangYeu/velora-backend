import { ReelVisibilitySchema } from '@common/content/schemas/reel-visibility.schema';
import { ReelMediaEditSchema } from '@common/content/schemas/reel-edit.schema';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateReelSchema = z.object({
  mediaKey: z.string().trim().min(1),
  title: z.string().trim().max(220).optional(),
  description: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  visibility: ReelVisibilitySchema.default('public'),
  clientObservedDurationMs: z.number().finite().positive().optional(),
  edit: ReelMediaEditSchema.optional(),
});

export class CreateReelDto extends createZodDto(CreateReelSchema) {}
