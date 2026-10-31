import { z } from 'zod';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export const REEL_HLS_CACHE_EVENT_TYPE = 'REEL_HLS_CACHE_INVALIDATION_V1';
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const localPath = z
  .string()
  .regex(
    /^(?:master\.m3u8|thumbnail\.jpg|\d+\/(?:stream\.m3u8|segment_\d+\.ts))$/u,
  );

export const ReelHlsReplacementPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    reelId: z.uuid(),
    userId: z.string().min(1).max(200),
    attemptId: z.uuid(),
    expectedUpdatedAt: z.iso.datetime(),
    previousHlsMasterKey: z.string().min(1).max(1024),
    mediaKeySha256: digest,
    mediaAttemptId: z.string().nullable(),
    indexAttemptId: z.string().nullable(),
    sourceSha256: digest,
    sourceMode: z.literal('PUBLISHED_HLS'),
    outputDurationMs: z.number().int().positive(),
    segmentSeconds: z.number().int().min(1).max(20),
    outputFps: z.number().int().min(24).max(60),
    variants: z
      .array(
        z
          .object({
            name: z.enum(['360p', '540p', '720p', '1080p']),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    files: z
      .array(
        z
          .object({
            path: localPath,
            bytes: z
              .number()
              .int()
              .positive()
              .max(512 * 1024 * 1024),
            sha256: digest,
          })
          .strict(),
      )
      .min(4)
      .max(20_000),
  })
  .strict();

export type ReelHlsReplacementPlan = z.infer<
  typeof ReelHlsReplacementPlanSchema
>;
export interface ReelHlsReplacementCommand {
  action: 'RESERVE' | 'APPLY' | 'ROLLBACK';
  plan: ReelHlsReplacementPlan;
  reviewedSha256: string;
}
export interface ReelHlsReplacementResult {
  hlsMasterKey: string;
  updatedAt: string;
}

export function reelHlsPlanSha256(plan: ReelHlsReplacementPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export function validateHlsArtifactGraph(
  plan: ReelHlsReplacementPlan,
  playlists: Map<string, string>,
): void {
  const files = new Set(plan.files.map((file) => file.path));
  if (
    files.size !== plan.files.length ||
    !files.has('master.m3u8') ||
    !files.has('thumbnail.jpg')
  )
    throw new Error('Invalid HLS object inventory');
  const references = (name: string): string[] => {
    const text = playlists.get(name);
    if (!text?.startsWith('#EXTM3U') || /URI=|#EXT-X-BYTERANGE/u.test(text))
      throw new Error('Replacement requires self-contained unencrypted HLS');
    return text
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        if (
          !/^[\w./-]+$/u.test(line) ||
          line.split('/').includes('..') ||
          line.startsWith('/')
        )
          throw new Error('Unsafe HLS object reference');
        const resolved = path.posix.join(path.posix.dirname(name), line);
        if (!files.has(resolved))
          throw new Error('HLS reference missing from reviewed inventory');
        return resolved;
      });
  };
  const variants = references('master.m3u8');
  if (
    new Set(variants).size !== plan.variants.length ||
    variants.length !== plan.variants.length
  )
    throw new Error('HLS rendition count mismatch');
  const reachable = new Set(['master.m3u8', 'thumbnail.jpg']);
  for (const variant of variants) {
    if (!/^\d+\/stream\.m3u8$/u.test(variant))
      throw new Error('Invalid HLS variant reference');
    const segments = references(variant);
    const text = playlists.get(variant)!;
    const durations = [...text.matchAll(/#EXTINF:([\d.]+),/gu)].map((match) =>
      Number(match[1]),
    );
    if (
      !text.includes('#EXT-X-ENDLIST') ||
      !text.includes('#EXT-X-INDEPENDENT-SEGMENTS') ||
      !segments.length ||
      segments.some((name) => !name.endsWith('.ts')) ||
      durations.length !== segments.length ||
      durations.some(
        (duration) =>
          duration <= 0 ||
          duration > plan.segmentSeconds + 1 / plan.outputFps + 0.05,
      )
    )
      throw new Error('Invalid HLS VOD segments');
    if (
      Math.abs(
        durations.reduce((sum, duration) => sum + duration, 0) * 1000 -
          plan.outputDurationMs,
      ) > 250
    )
      throw new Error('HLS output duration mismatch');
    reachable.add(variant);
    segments.forEach((name) => reachable.add(name));
  }
  if (plan.files.some((file) => !reachable.has(file.path)))
    throw new Error('Unreferenced HLS object in artifact');
}
