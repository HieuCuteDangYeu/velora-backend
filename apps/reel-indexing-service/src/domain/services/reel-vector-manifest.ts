import { createHash } from 'node:crypto';
import type {
  ReelVectorPayload,
  ReelVectorPoint,
  VectorKind,
} from '../interfaces/reel-vector-store.interface';

export const VECTOR_TABLES: Record<VectorKind, string> = {
  REEL: 'ReelDocument',
  SECTION: 'ReelSection',
  CHUNK: 'ReelChunk',
  VISUAL_SCENE: 'ReelVisualScene',
};
export const VECTOR_TOLERANCE = 2e-5;
export function vectorHash(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
      ),
    )
    .digest('hex');
}
export function vectorPointId(
  kind: VectorKind,
  reelId: string,
  attempt: string,
  generation: string,
  stableId: string,
): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([kind, reelId, attempt, generation, stableId]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function validateVector(vector: number[]): void {
  if (
    vector.length !== 1024 ||
    vector.some((v) => !Number.isFinite(v)) ||
    !vector.some((v) => v !== 0)
  ) {
    throw new Error('Invalid semantic vector');
  }
}
export function normalizedVector(vector: number[]): number[] {
  validateVector(vector);
  const norm = Math.hypot(...vector);
  return vector.map((v) => v / norm);
}
export function pointManifest(points: ReelVectorPoint[]): string {
  return vectorHash(
    points
      .map((p): [string, Record<string, unknown>] => [
        p.id,
        { ...p.payload, manifestHash: '' },
      ])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}
export function makePoint(
  kind: VectorKind,
  generation: string,
  row: Record<string, unknown>,
): ReelVectorPoint {
  const vector =
    typeof row.embedding === 'string'
      ? (JSON.parse(row.embedding) as number[])
      : (row.embedding as number[]);
  validateVector(vector);
  const payload: ReelVectorPayload = {
    kind,
    stableId: String(row.id),
    reelId: String(row.reelId),
    indexAttemptId: String(row.indexAttemptId),
    projectionGeneration: generation,
    manifestHash: '',
    userId: String(row.userId),
    parentId: row.parentId as string | null,
    ordinal: Number(row.ordinal),
    tags: row.tags as string[],
    sourceLengthClass: String(row.sourceLengthClass),
    indexVersion: String(row.indexVersion),
    embeddingProvider: String(row.embeddingProvider),
    embeddingModel: String(row.embeddingModel),
    embeddingVersion: String(row.embeddingVersion),
    embeddingDimensions: Number(row.embeddingDimensions),
    embeddingInputHash: String(row.embeddingInputHash),
    retrievalHash: String(row.retrievalHash),
    evidenceHash: row.evidenceHash as string | null,
    vectorHash: vectorHash(vector.map(Math.fround)),
  };
  if (
    payload.embeddingDimensions !== 1024 ||
    !payload.embeddingInputHash ||
    !payload.retrievalHash
  )
    throw new Error('Invalid vector provenance');
  return {
    id: vectorPointId(
      kind,
      payload.reelId,
      payload.indexAttemptId,
      generation,
      payload.stableId,
    ),
    vector,
    payload,
  };
}
