import { createHash } from 'node:crypto';
import type { CreateReelDto } from '@common/content/dtos/create-reel.dto';
import { normalizeReelMediaKey } from './reel-media-key';

function normalizeOptionalText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeEdit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeEdit(item));
  if (!value || typeof value !== 'object') return value ?? null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeEdit(item)]),
  );
}

export function normalizeCreateReelRequest(payload: CreateReelDto) {
  return {
    mediaKey: normalizeReelMediaKey(payload.mediaKey),
    title: normalizeOptionalText(payload.title),
    description: normalizeOptionalText(payload.description),
    tags: [
      ...new Set(
        (payload.tags ?? [])
          .map((tag) => tag.trim().replace(/^#/, '').toLowerCase())
          .filter(Boolean),
      ),
    ].sort(),
    visibility: payload.visibility ?? 'public',
    clientObservedDurationMs:
      payload.clientObservedDurationMs === undefined
        ? null
        : Number(payload.clientObservedDurationMs.toFixed(3)),
    edit: normalizeEdit(payload.edit),
  };
}

export function fingerprintCreateReelRequest(payload: CreateReelDto): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeCreateReelRequest(payload)))
    .digest('hex');
}
