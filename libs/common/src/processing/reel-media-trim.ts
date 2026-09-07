import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';

export const REEL_TRIM_DURATION_TOLERANCE_MS = 50;
export const REEL_MIN_OUTPUT_DURATION_MS = 1000;

export interface ReelMediaTrim {
  sourceStartMs: number;
  sourceEndMs: number;
  outputDurationMs: number;
}

export function resolveReelMediaTrim(
  edit: ReelMediaEdit | null | undefined,
  sourceDurationMs: number,
): ReelMediaTrim {
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
    throw new Error('Source duration is missing or invalid');
  }

  const requestedTrim = edit?.trim;

  if (!requestedTrim) {
    return {
      sourceStartMs: 0,
      sourceEndMs: sourceDurationMs,
      outputDurationMs: sourceDurationMs,
    };
  }

  if (
    !Number.isFinite(requestedTrim.startMs) ||
    !Number.isFinite(requestedTrim.endMs) ||
    requestedTrim.startMs < 0 ||
    requestedTrim.endMs <= requestedTrim.startMs
  ) {
    throw new Error('Trim interval is invalid');
  }

  if (requestedTrim.startMs > sourceDurationMs) {
    throw new Error('Trim start is outside the source duration');
  }

  const endOverflowMs = requestedTrim.endMs - sourceDurationMs;

  if (endOverflowMs > REEL_TRIM_DURATION_TOLERANCE_MS) {
    throw new Error('Trim end is outside the source duration');
  }

  const sourceStartMs = Math.round(requestedTrim.startMs);
  const sourceEndMs = Math.min(
    sourceDurationMs,
    Math.round(requestedTrim.endMs),
  );
  const outputDurationMs = sourceEndMs - sourceStartMs;

  if (outputDurationMs < REEL_MIN_OUTPUT_DURATION_MS) {
    throw new Error('Trim interval is shorter than 1000ms');
  }

  return { sourceStartMs, sourceEndMs, outputDurationMs };
}
