import { ReelVisibilitySchema } from '@common/content/schemas/reel-visibility.schema';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateReelSeriesSchema = z.object({
  title: z.string().trim().min(1).max(220),
  description: z.string().trim().max(2000).optional(),
  visibility: ReelVisibilitySchema.default('public'),
});

export class CreateReelSeriesDto extends createZodDto(CreateReelSeriesSchema) {}

export const UpdateReelSeriesSchema = z
  .object({
    title: z.string().trim().min(1).max(220).optional(),
    description: z.string().trim().max(2000).optional(),
    visibility: ReelVisibilitySchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });

export class UpdateReelSeriesDto extends createZodDto(UpdateReelSeriesSchema) {}

export const AddReelToSeriesSchema = z.object({
  reelId: z.string().trim().min(1),
  episodeNumber: z.number().int().positive().optional(),
});

export class AddReelToSeriesDto extends createZodDto(AddReelToSeriesSchema) {}

export const ReorderReelSeriesSchema = z
  .object({
    reelIds: z.array(z.string().trim().min(1)).min(1),
  })
  .refine((data) => new Set(data.reelIds).size === data.reelIds.length, {
    message: 'reelIds must not contain duplicates',
  });

export class ReorderReelSeriesDto extends createZodDto(
  ReorderReelSeriesSchema,
) {}
