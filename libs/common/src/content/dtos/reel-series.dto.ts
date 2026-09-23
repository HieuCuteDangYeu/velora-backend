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

export const AddReelToSeriesSchema = z
  .object({
    reelIds: z.array(z.string().trim().min(1)).min(1).max(50),
  })
  .refine((data) => new Set(data.reelIds).size === data.reelIds.length, {
    message: 'reelIds must not contain duplicates',
  });

export class AddReelToSeriesDto extends createZodDto(AddReelToSeriesSchema) {}

const ReelSeriesCursorSchema = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) return undefined;

    const [createdAt, id] = value.split('|');
    if (!createdAt || !id) return undefined;

    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return undefined;

    return { createdAt: date, id };
  });

export const ListReelSeriesCandidateReelsRpcQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z
    .object({
      createdAt: z.coerce.date(),
      id: z.string().trim().min(1),
    })
    .optional(),
});

export const ListReelSeriesCandidateReelsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: ReelSeriesCursorSchema,
});

export class ListReelSeriesCandidateReelsQueryDto extends createZodDto(
  ListReelSeriesCandidateReelsQuerySchema,
) {}

const ReelSeriesEpisodeCursorSchema = z.object({
  episodeNumber: z.number().int().min(1),
  id: z.string().trim().min(1),
});

const ReelSeriesEpisodeCursorQuerySchema = z
  .string()
  .regex(/^\d+\|[^|]+$/)
  .optional()
  .transform((value) => {
    if (!value) return undefined;
    const [episodeNumber, id] = value.split('|');
    return { episodeNumber: Number(episodeNumber), id };
  });

export const ListReelSeriesEpisodesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(30).default(15),
    aroundReelId: z.string().trim().min(1).optional(),
    cursor: ReelSeriesEpisodeCursorQuerySchema,
    direction: z.enum(['previous', 'next']).optional(),
  })
  .superRefine((query, context) => {
    if (Boolean(query.cursor) !== Boolean(query.direction)) {
      context.addIssue({
        code: 'custom',
        message: 'cursor and direction must be provided together',
        path: ['cursor'],
      });
    }
    if (query.cursor && query.aroundReelId) {
      context.addIssue({
        code: 'custom',
        message: 'aroundReelId can only be used for the first episode page',
        path: ['aroundReelId'],
      });
    }
  });

export class ListReelSeriesEpisodesQueryDto extends createZodDto(
  ListReelSeriesEpisodesQuerySchema,
) {}

export const ListReelSeriesEpisodesRpcQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(30),
    aroundReelId: z.string().trim().min(1).optional(),
    cursor: ReelSeriesEpisodeCursorSchema.optional(),
    direction: z.enum(['previous', 'next']).optional(),
  })
  .superRefine((query, context) => {
    if (Boolean(query.cursor) !== Boolean(query.direction)) {
      context.addIssue({
        code: 'custom',
        message: 'cursor and direction must be provided together',
        path: ['cursor'],
      });
    }
    if (query.cursor && query.aroundReelId) {
      context.addIssue({
        code: 'custom',
        message: 'aroundReelId can only be used for the first episode page',
        path: ['aroundReelId'],
      });
    }
  });

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
