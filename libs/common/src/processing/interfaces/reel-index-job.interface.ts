import type {
  ReelSourceLengthClass,
  ReelSourceOrientation,
} from '@common/content/interfaces/reel-state.interface';

export interface ReelIndexJob {
  jobId: string;
  reelId: string;
  userId: string;
  mediaAttemptId: string;
  indexAttemptId: string;
  indexVersion: string;
  mediaKey: string;
  transcriptionAudioManifestKey?: string;
  visualFrameManifestKey?: string;
  sourceDurationMs: number;
  outputDurationMs?: number;
  sourceHasAudio?: boolean;
  sourceOrientation: ReelSourceOrientation;
  sourceLengthClass: ReelSourceLengthClass;
  title?: string;
  description?: string;
  tags: string[];
  createdAt: string;
  schemaVersion: 1;
}

export const REEL_INDEX_JOB_SCHEMA_VERSION = 1 as const;
export const REEL_INDEX_JOB_EVENT_TYPE = 'reel.index.requested.v1' as const;
export const REEL_INDEX_JOB_PATTERN = 'reel.index.process' as const;

export function isReelIndexJob(value: unknown): value is ReelIndexJob {
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record['jobId'] === 'string' &&
    record['jobId'].trim().length > 0 &&
    typeof record['reelId'] === 'string' &&
    record['reelId'].trim().length > 0 &&
    typeof record['userId'] === 'string' &&
    record['userId'].trim().length > 0 &&
    typeof record['mediaAttemptId'] === 'string' &&
    record['mediaAttemptId'].trim().length > 0 &&
    typeof record['indexAttemptId'] === 'string' &&
    record['indexAttemptId'].trim().length > 0 &&
    typeof record['indexVersion'] === 'string' &&
    record['indexVersion'].trim().length > 0 &&
    typeof record['mediaKey'] === 'string' &&
    record['mediaKey'].trim().length > 0 &&
    (record['transcriptionAudioManifestKey'] === undefined ||
      (typeof record['transcriptionAudioManifestKey'] === 'string' &&
        record['transcriptionAudioManifestKey'].trim().length > 0)) &&
    (record['visualFrameManifestKey'] === undefined ||
      (typeof record['visualFrameManifestKey'] === 'string' &&
        record['visualFrameManifestKey'].trim().length > 0)) &&
    typeof record['sourceDurationMs'] === 'number' &&
    Number.isFinite(record['sourceDurationMs']) &&
    record['sourceDurationMs'] > 0 &&
    (record['outputDurationMs'] === undefined ||
      (typeof record['outputDurationMs'] === 'number' &&
        Number.isFinite(record['outputDurationMs']) &&
        record['outputDurationMs'] > 0 &&
        record['outputDurationMs'] <= record['sourceDurationMs'])) &&
    (record['sourceHasAudio'] === undefined ||
      typeof record['sourceHasAudio'] === 'boolean') &&
    ['PORTRAIT', 'LANDSCAPE', 'SQUARE'].includes(
      String(record['sourceOrientation']),
    ) &&
    ['SHORT', 'LONG'].includes(String(record['sourceLengthClass'])) &&
    (record['title'] === undefined || typeof record['title'] === 'string') &&
    (record['description'] === undefined ||
      typeof record['description'] === 'string') &&
    Array.isArray(record['tags']) &&
    record['tags'].every((tag) => typeof tag === 'string') &&
    typeof record['createdAt'] === 'string' &&
    Number.isFinite(Date.parse(record['createdAt'])) &&
    record['schemaVersion'] === REEL_INDEX_JOB_SCHEMA_VERSION
  );
}
