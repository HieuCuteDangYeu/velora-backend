import { z } from 'zod';

export const ReelPipelineTelemetryEventSchema = z
  .object({
    eventId: z.string().uuid(),
    pipeline: z.enum(['MEDIA', 'INDEX']),
    lane: z.enum(['SHORT', 'LONG', 'UNKNOWN']),
    stage: z.string().trim().min(1).max(96),
    outcome: z.enum(['SUCCEEDED', 'FAILED']),
    durationMs: z.number().int().min(0).max(3_600_000),
    retryNumber: z.number().int().min(0).max(10),
    itemCounts: z
      .object({
        reelDocuments: z.number().int().min(0).max(100_000),
        sections: z.number().int().min(0).max(100_000),
        chunks: z.number().int().min(0).max(1_000_000),
      })
      .strict()
      .optional(),
    occurredAt: z.string().datetime(),
  })
  .strict();

export type ReelPipelineTelemetryEvent = z.infer<
  typeof ReelPipelineTelemetryEventSchema
>;
