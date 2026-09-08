import { z } from 'zod';

export const FriendGraphCandidateSourceSchema = z.enum([
  'MUTUAL_FRIENDS',
  'ADAMIC_ADAR',
]);

export const FriendGraphRecommendationCandidateSchema = z
  .object({
    userId: z.string().uuid(),
    mutualFriendCount: z.number().int().nonnegative(),
    adamicAdarScore: z.number().finite().nonnegative(),
    graphScore: z.number().finite().min(0).max(1),
    candidateSources: z
      .array(FriendGraphCandidateSourceSchema)
      .min(1)
      .refine(
        (sources) => new Set(sources).size === sources.length,
        'candidateSources must not contain duplicates',
      ),
  })
  .strict();

export const FriendGraphRecommendationResponseSchema = z
  .object({
    candidates: z.array(FriendGraphRecommendationCandidateSchema),
    excludedUserIds: z.array(z.string().uuid()),
  })
  .strict();
