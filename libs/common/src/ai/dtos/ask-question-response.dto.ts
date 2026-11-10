import { z } from 'zod';

export const AiRecommendedReelAuthorSchema = z.object({
  id: z.string(),
  username: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  isVerified: z.boolean().nullable().optional(),
});

export const AiRecommendedReelSchema = z.object({
  id: z.string(),
  userId: z.string(),
  mediaKey: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']),
  visibility: z.enum(['public', 'private']),
  viewCount: z.number().default(0),
  thumbnailKey: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  streamUrl: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  sourceOrientation: z.enum(['PORTRAIT', 'LANDSCAPE', 'SQUARE']).optional(),
  sourceLengthClass: z.enum(['SHORT', 'LONG']).optional(),
  playbackPresentation: z
    .enum(['PORTRAIT_COVER', 'FIT_WITH_LETTERBOX'])
    .optional(),
  createdAt: z.string(),
  author: AiRecommendedReelAuthorSchema.optional(),
});

export const AiRagCitationSchema = z.object({
  sourceType: z.literal('REEL'),
  reelId: z.string().min(1),
  evidenceType: z.enum(['TRANSCRIPT', 'VISUAL', 'METADATA']),
  title: z.string().optional(),
  startTime: z.number().nonnegative().optional(),
  endTime: z.number().nonnegative().optional(),
  quote: z.string().min(1).optional(),
});

export const AskQuestionResponseSchema = z.object({
  answer: z.string().optional(),
  citations: z.array(AiRagCitationSchema).optional(),
  recommendedReels: z.array(AiRecommendedReelSchema).optional(),
  suggestedQueries: z.array(z.string()).optional(),
  error: z
    .object({
      code: z.enum(['AI_UNAVAILABLE', 'AI_BUSY', 'NO_CONTENT', 'UNKNOWN']),
      message: z.string(),
      /** AI_BUSY: seconds until a retry is likely to be admitted. */
      retryAfterSeconds: z.number().int().positive().optional(),
    })
    .optional(),
});

export type AskQuestionResponse = z.infer<typeof AskQuestionResponseSchema>;
export type AiRecommendedReel = z.infer<typeof AiRecommendedReelSchema>;
export type AiRagCitation = z.infer<typeof AiRagCitationSchema>;
