import type { ReelMediaLengthClass } from './interfaces/reel-media-job.interface';

export type ReelMediaWorkerLane = 'SHORT' | 'LONG' | 'BOTH';

export const REEL_MEDIA_EXCHANGE = 'reel_media_jobs';
export const REEL_MEDIA_DEAD_LETTER_EXCHANGE = 'reel_media_dead_letter';

export const REEL_MEDIA_QUEUE_NAMES = {
  SHORT_JOBS: 'reel_media_short_jobs',
  LONG_JOBS: 'reel_media_long_jobs',
  SHORT_EVIDENCE_JOBS: 'reel_media_short_evidence_jobs',
  LONG_EVIDENCE_JOBS: 'reel_media_long_evidence_jobs',
  SHORT_RETRY_30S: 'reel_media_short_retry_30s',
  SHORT_RETRY_5M: 'reel_media_short_retry_5m',
  SHORT_DLQ: 'reel_media_short_dlq',
  LONG_RETRY_60S: 'reel_media_long_retry_60s',
  LONG_RETRY_10M: 'reel_media_long_retry_10m',
  LONG_DLQ: 'reel_media_long_dlq',
} as const;

export const REEL_INDEX_QUEUE_NAMES = {
  SHORT_JOBS: 'reel_index_short_jobs',
  LONG_JOBS: 'reel_index_long_jobs',
  SHORT_RETRY_30S: 'reel_index_short_retry_30s',
  SHORT_RETRY_5M: 'reel_index_short_retry_5m',
  SHORT_DLQ: 'reel_index_short_dlq',
  LONG_RETRY_60S: 'reel_index_long_retry_60s',
  LONG_RETRY_10M: 'reel_index_long_retry_10m',
  LONG_DLQ: 'reel_index_long_dlq',
} as const;

export const REEL_INDEX_EXCHANGE = 'reel_index_jobs';
export const REEL_INDEX_DEAD_LETTER_EXCHANGE = 'reel_index_dead_letter';

export const REEL_INDEX_ROUTING_KEYS = {
  SHORT: 'reel.index.short',
  LONG: 'reel.index.long',
  SHORT_DLQ: 'reel.index.short.dlq',
  LONG_DLQ: 'reel.index.long.dlq',
} as const;

export interface ReelIndexPrimaryQueueDefinition {
  lengthClass: 'SHORT' | 'LONG';
  queue: string;
  routingKey: string;
  deadLetterRoutingKey: string;
}

export interface ReelIndexRetryQueueDefinition {
  lengthClass: 'SHORT' | 'LONG';
  retryNumber: 1 | 2;
  queue: string;
  delayMs: number;
  returnRoutingKey: string;
}

export interface ReelIndexDeadLetterQueueDefinition {
  lengthClass: 'SHORT' | 'LONG';
  queue: string;
  routingKey: string;
}

export const REEL_INDEX_PRIMARY_QUEUES: readonly ReelIndexPrimaryQueueDefinition[] =
  [
    {
      lengthClass: 'SHORT' as const,
      queue: REEL_INDEX_QUEUE_NAMES.SHORT_JOBS,
      routingKey: REEL_INDEX_ROUTING_KEYS.SHORT,
      deadLetterRoutingKey: REEL_INDEX_ROUTING_KEYS.SHORT_DLQ,
    },
    {
      lengthClass: 'LONG' as const,
      queue: REEL_INDEX_QUEUE_NAMES.LONG_JOBS,
      routingKey: REEL_INDEX_ROUTING_KEYS.LONG,
      deadLetterRoutingKey: REEL_INDEX_ROUTING_KEYS.LONG_DLQ,
    },
  ] as const;

/** Header counting how often a quota-failed index job was put back behind the others. */
export const REEL_INDEX_QUOTA_ROTATION_HEADER = 'x-reel-index-quota-rotation';
/** Passes on the 30 s/60 s lane before a quota-failed job moves to the 5/10 minute lane. */
export const REEL_INDEX_QUOTA_ROTATIONS_ON_SHORT_LANE = 4;
/** A job that still cannot get visual quota after this long is recorded as failed. */
export const REEL_INDEX_QUOTA_ROTATION_MAX_AGE_MS = 6 * 60 * 60_000;

export const REEL_INDEX_RETRY_QUEUES: readonly ReelIndexRetryQueueDefinition[] =
  [
    {
      lengthClass: 'SHORT' as const,
      retryNumber: 1 as const,
      queue: REEL_INDEX_QUEUE_NAMES.SHORT_RETRY_30S,
      delayMs: 30_000,
      returnRoutingKey: REEL_INDEX_ROUTING_KEYS.SHORT,
    },
    {
      lengthClass: 'SHORT' as const,
      retryNumber: 2 as const,
      queue: REEL_INDEX_QUEUE_NAMES.SHORT_RETRY_5M,
      delayMs: 5 * 60_000,
      returnRoutingKey: REEL_INDEX_ROUTING_KEYS.SHORT,
    },
    {
      lengthClass: 'LONG' as const,
      retryNumber: 1 as const,
      queue: REEL_INDEX_QUEUE_NAMES.LONG_RETRY_60S,
      delayMs: 60_000,
      returnRoutingKey: REEL_INDEX_ROUTING_KEYS.LONG,
    },
    {
      lengthClass: 'LONG' as const,
      retryNumber: 2 as const,
      queue: REEL_INDEX_QUEUE_NAMES.LONG_RETRY_10M,
      delayMs: 10 * 60_000,
      returnRoutingKey: REEL_INDEX_ROUTING_KEYS.LONG,
    },
  ] as const;

export const REEL_INDEX_DEAD_LETTER_QUEUES: readonly ReelIndexDeadLetterQueueDefinition[] =
  [
    {
      lengthClass: 'SHORT' as const,
      queue: REEL_INDEX_QUEUE_NAMES.SHORT_DLQ,
      routingKey: REEL_INDEX_ROUTING_KEYS.SHORT_DLQ,
    },
    {
      lengthClass: 'LONG' as const,
      queue: REEL_INDEX_QUEUE_NAMES.LONG_DLQ,
      routingKey: REEL_INDEX_ROUTING_KEYS.LONG_DLQ,
    },
  ] as const;

export type ReelIndexWorkerLane = 'SHORT' | 'LONG' | 'BOTH';

export function parseReelIndexWorkerLane(value?: string): ReelIndexWorkerLane {
  const normalized = value?.trim().toUpperCase() || 'BOTH';

  if (
    normalized === 'SHORT' ||
    normalized === 'LONG' ||
    normalized === 'BOTH'
  ) {
    return normalized;
  }

  throw new Error(
    `INDEX_WORKER_LANE must be SHORT, LONG, or BOTH; received ${value}`,
  );
}

export function getIndexQueuesForWorkerLane(
  lane: ReelIndexWorkerLane,
): readonly ReelIndexPrimaryQueueDefinition[] {
  return lane === 'BOTH'
    ? REEL_INDEX_PRIMARY_QUEUES
    : REEL_INDEX_PRIMARY_QUEUES.filter(
        (definition) => definition.lengthClass === lane,
      );
}

export function getReelIndexPrimaryQueue(
  lengthClass: 'SHORT' | 'LONG',
): ReelIndexPrimaryQueueDefinition {
  return REEL_INDEX_PRIMARY_QUEUES.find(
    (definition) => definition.lengthClass === lengthClass,
  )!;
}

export function getReelIndexRetryQueue(
  lengthClass: 'SHORT' | 'LONG',
  retryNumber: 1 | 2,
): ReelIndexRetryQueueDefinition {
  return REEL_INDEX_RETRY_QUEUES.find(
    (definition) =>
      definition.lengthClass === lengthClass &&
      definition.retryNumber === retryNumber,
  )!;
}

export const REEL_MEDIA_ROUTING_KEYS = {
  SHORT: 'reel.media.short',
  LONG: 'reel.media.long',
  SHORT_EVIDENCE: 'reel.media.short.evidence',
  LONG_EVIDENCE: 'reel.media.long.evidence',
  SHORT_DLQ: 'reel.media.short.dlq',
  LONG_DLQ: 'reel.media.long.dlq',
} as const;

export interface ReelMediaPrimaryQueueDefinition {
  lengthClass: 'SHORT' | 'LONG';
  queue: string;
  routingKey: string;
  deadLetterRoutingKey: string;
}

export interface ReelMediaRetryQueueDefinition {
  lengthClass: 'SHORT' | 'LONG';
  retryNumber: 1 | 2;
  queue: string;
  delayMs: number;
  returnRoutingKey: string;
}

export interface ReelMediaDeadLetterQueueDefinition {
  lengthClass: 'SHORT' | 'LONG';
  queue: string;
  routingKey: string;
}

export const REEL_MEDIA_PRIMARY_QUEUES: readonly ReelMediaPrimaryQueueDefinition[] =
  [
    {
      lengthClass: 'SHORT',
      queue: REEL_MEDIA_QUEUE_NAMES.SHORT_JOBS,
      routingKey: REEL_MEDIA_ROUTING_KEYS.SHORT,
      deadLetterRoutingKey: REEL_MEDIA_ROUTING_KEYS.SHORT_DLQ,
    },
    {
      lengthClass: 'LONG',
      queue: REEL_MEDIA_QUEUE_NAMES.LONG_JOBS,
      routingKey: REEL_MEDIA_ROUTING_KEYS.LONG,
      deadLetterRoutingKey: REEL_MEDIA_ROUTING_KEYS.LONG_DLQ,
    },
  ];

/**
 * Evidence jobs (transcript audio and visual frames from an already encoded reel) go to their own
 * queues so a backlog of them, for example a backfill of old reels, never sits in front of the
 * encode of a new upload. The workers run encode jobs before evidence jobs when both are waiting.
 * They share the lane's dead-letter queue.
 */
export const REEL_MEDIA_EVIDENCE_QUEUES: readonly ReelMediaPrimaryQueueDefinition[] =
  [
    {
      lengthClass: 'SHORT',
      queue: REEL_MEDIA_QUEUE_NAMES.SHORT_EVIDENCE_JOBS,
      routingKey: REEL_MEDIA_ROUTING_KEYS.SHORT_EVIDENCE,
      deadLetterRoutingKey: REEL_MEDIA_ROUTING_KEYS.SHORT_DLQ,
    },
    {
      lengthClass: 'LONG',
      queue: REEL_MEDIA_QUEUE_NAMES.LONG_EVIDENCE_JOBS,
      routingKey: REEL_MEDIA_ROUTING_KEYS.LONG_EVIDENCE,
      deadLetterRoutingKey: REEL_MEDIA_ROUTING_KEYS.LONG_DLQ,
    },
  ];

export const REEL_MEDIA_RETRY_QUEUES: readonly ReelMediaRetryQueueDefinition[] =
  [
    {
      lengthClass: 'SHORT',
      retryNumber: 1,
      queue: REEL_MEDIA_QUEUE_NAMES.SHORT_RETRY_30S,
      delayMs: 30_000,
      returnRoutingKey: REEL_MEDIA_ROUTING_KEYS.SHORT,
    },
    {
      lengthClass: 'SHORT',
      retryNumber: 2,
      queue: REEL_MEDIA_QUEUE_NAMES.SHORT_RETRY_5M,
      delayMs: 5 * 60_000,
      returnRoutingKey: REEL_MEDIA_ROUTING_KEYS.SHORT,
    },
    {
      lengthClass: 'LONG',
      retryNumber: 1,
      queue: REEL_MEDIA_QUEUE_NAMES.LONG_RETRY_60S,
      delayMs: 60_000,
      returnRoutingKey: REEL_MEDIA_ROUTING_KEYS.LONG,
    },
    {
      lengthClass: 'LONG',
      retryNumber: 2,
      queue: REEL_MEDIA_QUEUE_NAMES.LONG_RETRY_10M,
      delayMs: 10 * 60_000,
      returnRoutingKey: REEL_MEDIA_ROUTING_KEYS.LONG,
    },
  ];

export const REEL_MEDIA_DEAD_LETTER_QUEUES: readonly ReelMediaDeadLetterQueueDefinition[] =
  [
    {
      lengthClass: 'SHORT',
      queue: REEL_MEDIA_QUEUE_NAMES.SHORT_DLQ,
      routingKey: REEL_MEDIA_ROUTING_KEYS.SHORT_DLQ,
    },
    {
      lengthClass: 'LONG',
      queue: REEL_MEDIA_QUEUE_NAMES.LONG_DLQ,
      routingKey: REEL_MEDIA_ROUTING_KEYS.LONG_DLQ,
    },
  ];

export function resolveReelMediaLengthClass(
  lengthClass: ReelMediaLengthClass,
): 'SHORT' | 'LONG' {
  return lengthClass === 'SHORT' ? 'SHORT' : 'LONG';
}

export function getReelMediaPrimaryQueue(
  lengthClass: ReelMediaLengthClass,
): ReelMediaPrimaryQueueDefinition {
  const resolved = resolveReelMediaLengthClass(lengthClass);

  return REEL_MEDIA_PRIMARY_QUEUES.find(
    (definition) => definition.lengthClass === resolved,
  )!;
}

export function getReelMediaEvidenceQueue(
  lengthClass: ReelMediaLengthClass,
): ReelMediaPrimaryQueueDefinition {
  const resolved = resolveReelMediaLengthClass(lengthClass);

  return REEL_MEDIA_EVIDENCE_QUEUES.find(
    (definition) => definition.lengthClass === resolved,
  )!;
}

export function getReelMediaRetryQueue(
  lengthClass: ReelMediaLengthClass,
  retryNumber: 1 | 2,
): ReelMediaRetryQueueDefinition {
  const resolved = resolveReelMediaLengthClass(lengthClass);

  return REEL_MEDIA_RETRY_QUEUES.find(
    (definition) =>
      definition.lengthClass === resolved &&
      definition.retryNumber === retryNumber,
  )!;
}

export function parseReelMediaWorkerLane(value?: string): ReelMediaWorkerLane {
  const normalized = value?.trim().toUpperCase() || 'BOTH';

  if (
    normalized === 'SHORT' ||
    normalized === 'LONG' ||
    normalized === 'BOTH'
  ) {
    return normalized;
  }

  throw new Error(
    `MEDIA_WORKER_LANE must be SHORT, LONG, or BOTH; received ${value}`,
  );
}

export function getEvidenceQueuesForWorkerLane(
  lane: ReelMediaWorkerLane,
): readonly ReelMediaPrimaryQueueDefinition[] {
  if (lane === 'BOTH') {
    return REEL_MEDIA_EVIDENCE_QUEUES;
  }

  return REEL_MEDIA_EVIDENCE_QUEUES.filter(
    (definition) => definition.lengthClass === lane,
  );
}

export function getPrimaryQueuesForWorkerLane(
  lane: ReelMediaWorkerLane,
): readonly ReelMediaPrimaryQueueDefinition[] {
  if (lane === 'BOTH') {
    return REEL_MEDIA_PRIMARY_QUEUES;
  }

  return REEL_MEDIA_PRIMARY_QUEUES.filter(
    (definition) => definition.lengthClass === lane,
  );
}
