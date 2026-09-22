import { z } from 'zod';

export const RagTelemetryTokenUsageSchema = z
  .object({
    modelRole: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(128),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    reasoningTokens: z.number().int().min(0).optional(),
  })
  .strict();

export const RagTelemetryEventSchema = z
  .object({
    eventId: z.string().uuid(),
    outcome: z.enum(['SUCCEEDED', 'FAILED']),
    reelQuestionType: z.enum([
      'NONE',
      'TRANSCRIPT_CONTENT',
      'VISUAL_CONTENT',
      'GENERAL_REEL_SUMMARY',
      'REEL_METADATA',
      'AMBIGUOUS_REEL_REFERENCE',
    ]),
    latencyMs: z.number().int().min(0).max(600_000),
    retrievedChunks: z.number().int().min(0).max(10_000),
    contextSufficient: z.boolean().optional(),
    verifierPassed: z.boolean().optional(),
    fallbackUsed: z.boolean(),
    retryCount: z.number().int().min(0).max(100),
    retrievalRetryCount: z.number().int().min(0).max(100),
    citationRetryCount: z.number().int().min(0).max(100),
    finalFailureSource: z.enum([
      'NONE',
      'NO_CONTEXT',
      'VERIFIER',
      'CITATION',
      'PROVIDER_ERROR',
      'WORKFLOW',
      'UNKNOWN',
    ]),
    tokenUsage: z.array(RagTelemetryTokenUsageSchema).max(64),
    occurredAt: z.string().datetime(),
  })
  .strict();

export type RagTelemetryEvent = z.infer<typeof RagTelemetryEventSchema>;
export type RagTelemetryTokenUsage = z.infer<
  typeof RagTelemetryTokenUsageSchema
>;
