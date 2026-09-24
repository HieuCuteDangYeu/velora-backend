import { ReelMediaEditSchema } from '@common/content/schemas/reel-edit.schema';
import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import type {
  ReelSourceLengthClass,
  ReelSourceOrientation,
} from '@common/content/interfaces/reel-state.interface';

export type ReelMediaLengthClass = 'SHORT' | 'LONG' | 'UNKNOWN';

export interface ReelMediaJob {
  jobId: string;
  reelId: string;
  userId: string;
  mediaKey: string;
  mediaAttemptId: string;
  expectedLengthClass: ReelMediaLengthClass;
  title?: string;
  description?: string;
  tags: string[];
  edit?: ReelMediaEdit;
  sourceMode?: 'SOURCE_VIDEO' | 'EXISTING_HLS';
  hlsMasterKey?: string;
  existingSourceOrientation?: ReelSourceOrientation;
  existingSourceLengthClass?: ReelSourceLengthClass;
  preservedSourceDurationMs?: number;
  createdAt: string;
  schemaVersion: 1;
}

export const REEL_MEDIA_JOB_SCHEMA_VERSION = 1 as const;
export const REEL_MEDIA_JOB_EVENT_TYPE = 'reel.media.requested.v1' as const;
export const REEL_MEDIA_JOB_PATTERN = 'reel.media.process' as const;

export function isReelMediaJob(value: unknown): value is ReelMediaJob {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record['jobId'] === 'string' &&
    record['jobId'].trim().length > 0 &&
    typeof record['reelId'] === 'string' &&
    record['reelId'].trim().length > 0 &&
    typeof record['userId'] === 'string' &&
    record['userId'].trim().length > 0 &&
    typeof record['mediaKey'] === 'string' &&
    record['mediaKey'].trim().length > 0 &&
    typeof record['mediaAttemptId'] === 'string' &&
    record['mediaAttemptId'].trim().length > 0 &&
    ['SHORT', 'LONG', 'UNKNOWN'].includes(
      String(record['expectedLengthClass']),
    ) &&
    Array.isArray(record['tags']) &&
    record['tags'].every((tag) => typeof tag === 'string') &&
    (record['edit'] === undefined ||
      ReelMediaEditSchema.safeParse(record['edit']).success) &&
    (record['sourceMode'] === undefined ||
      record['sourceMode'] === 'SOURCE_VIDEO' ||
      record['sourceMode'] === 'EXISTING_HLS') &&
    (record['hlsMasterKey'] === undefined ||
      (typeof record['hlsMasterKey'] === 'string' &&
        record['hlsMasterKey'].trim().length > 0)) &&
    (record['sourceMode'] !== 'EXISTING_HLS' ||
      (typeof record['hlsMasterKey'] === 'string' &&
        record['hlsMasterKey'].trim().length > 0)) &&
    (record['existingSourceOrientation'] === undefined ||
      ['PORTRAIT', 'LANDSCAPE', 'SQUARE'].includes(
        String(record['existingSourceOrientation']),
      )) &&
    (record['existingSourceLengthClass'] === undefined ||
      ['SHORT', 'LONG'].includes(String(record['existingSourceLengthClass']))) &&
    (record['preservedSourceDurationMs'] === undefined ||
      (typeof record['preservedSourceDurationMs'] === 'number' &&
        Number.isFinite(record['preservedSourceDurationMs']) &&
        record['preservedSourceDurationMs'] > 0)) &&
    typeof record['createdAt'] === 'string' &&
    Number.isFinite(Date.parse(record['createdAt'])) &&
    record['schemaVersion'] === REEL_MEDIA_JOB_SCHEMA_VERSION
  );
}
