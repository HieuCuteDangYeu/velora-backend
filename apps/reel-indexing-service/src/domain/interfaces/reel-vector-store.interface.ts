import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';

export const VECTOR_KINDS = [
  'REEL',
  'SECTION',
  'CHUNK',
  'VISUAL_SCENE',
] as const;
export type VectorKind = (typeof VECTOR_KINDS)[number];
export interface VectorTuple {
  reelId: string;
  indexAttemptId: string;
  projectionGeneration: string;
  manifestHash: string;
}
export interface ReelVectorPayload extends VectorTuple {
  kind: VectorKind;
  stableId: string;
  userId: string;
  parentId: string | null;
  tags: string[];
  sourceLengthClass: string;
  indexVersion: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingVersion: string;
  embeddingDimensions: number;
  ordinal: number;
  embeddingInputHash: string;
  retrievalHash: string;
  evidenceHash: string | null;
  vectorHash: string;
}
export interface ReelVectorPoint {
  id: string;
  vector: number[];
  payload: ReelVectorPayload;
}
export interface VectorTarget {
  collection: string;
  fingerprint: string;
}
export interface IReelVectorStore {
  readonly collection: string;
  identity(signal?: AbortSignal): Promise<VectorTarget>;
  upsert(points: ReelVectorPoint[]): Promise<void>;
  retrieve(
    pointIds: string[],
    signal?: AbortSignal,
  ): Promise<ReelVectorPoint[]>;
  verify(points: ReelVectorPoint[]): Promise<void>;
  remove(tuple: VectorTuple): Promise<void>;
  search(input: {
    vector: number[];
    kind: VectorKind;
    tuples: VectorTuple[];
    pointIds: string[];
    limit: number;
    signal: AbortSignal;
  }): Promise<{ id: string; score: number; payload: ReelVectorPayload }[]>;
}
export interface ISemanticPublication {
  defer(input: {
    job: ReelIndexJob;
    completion: CompleteReelIndexCommand;
    projectionGeneration?: string;
    publicationToken?: string;
  }): Promise<{
    pending: boolean;
    generation?: string;
    token?: string;
    recovering?: boolean;
  }>;
  complete(
    reelId: string,
    indexAttemptId: string,
    generation?: string,
    token?: string,
  ): Promise<void>;
  release?(
    reelId: string,
    indexAttemptId: string,
    generation: string,
    token: string,
  ): Promise<void>;
}
export class ProjectionPendingError extends Error {
  constructor() {
    super('Semantic vector projection is pending');
  }
}

export class ProjectionSupersededError extends Error {
  constructor() {
    super('Semantic projection was superseded');
  }
}
