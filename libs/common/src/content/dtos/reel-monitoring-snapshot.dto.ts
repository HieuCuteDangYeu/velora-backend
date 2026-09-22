import { z } from 'zod';

const nonNegativeCount = z.number().int().min(0);

export const ReelMonitoringSnapshotSchema = z
  .object({
    generatedAt: z.string().datetime(),
    queued: nonNegativeCount,
    processing: nonNegativeCount,
    ready: nonNegativeCount,
    failed: nonNegativeCount,
    recentFailed: nonNegativeCount,
    degraded: nonNegativeCount,
    stalled: nonNegativeCount,
    readyLatencyP95Seconds: z.number().min(0).nullable(),
    media: z
      .object({
        PENDING: nonNegativeCount,
        PROBING: nonNegativeCount,
        PROCESSING: nonNegativeCount,
        COMPLETED: nonNegativeCount,
        FAILED: nonNegativeCount,
      })
      .strict(),
    index: z
      .object({
        NOT_REQUESTED: nonNegativeCount,
        PENDING: nonNegativeCount,
        PROCESSING: nonNegativeCount,
        COMPLETED: nonNegativeCount,
        DEGRADED: nonNegativeCount,
        FAILED: nonNegativeCount,
      })
      .strict(),
  })
  .strict();

export type ReelMonitoringSnapshot = z.infer<
  typeof ReelMonitoringSnapshotSchema
>;
