import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { TranscriptionAudioArtifact } from '@common/processing/interfaces/transcription-audio-manifest.interface';
import type {
  CachedEmbedding,
  EmbeddingCacheIdentity,
} from '@common/processing/interfaces/reel-index-document.interface';
import type {
  AudioSegmentCheckpoint,
  IndexCheckpointStage,
  IndexJobCheckpoint,
} from '../entities/index-checkpoint.entity';

export interface IIndexCheckpointRepository {
  startOrResume(job: ReelIndexJob): Promise<IndexJobCheckpoint>;
  get(indexAttemptId: string): Promise<IndexJobCheckpoint | null>;
  setStage(
    indexAttemptId: string,
    stage: IndexCheckpointStage,
    data?: Partial<IndexJobCheckpoint>,
  ): Promise<void>;
  initializeAudioSegments(
    indexAttemptId: string,
    artifacts: TranscriptionAudioArtifact[],
    transcriptionIdentity: string,
  ): Promise<void>;
  // Copies the newest finished transcript of the same audio (matched by checksum)
  // from an earlier attempt of this reel into the pending segments of this
  // attempt, and returns how many segments were filled.
  reuseStoredAudioSegments(input: {
    reelId: string;
    indexAttemptId: string;
  }): Promise<number>;
  listAudioSegments(indexAttemptId: string): Promise<AudioSegmentCheckpoint[]>;
  markAudioSegmentProcessing(
    indexAttemptId: string,
    segmentNumber: number,
  ): Promise<void>;
  completeAudioSegment(segment: AudioSegmentCheckpoint): Promise<void>;
  failAudioSegment(input: {
    indexAttemptId: string;
    segmentNumber: number;
    error: string;
  }): Promise<void>;
  fail(indexAttemptId: string, error: string): Promise<void>;
  findReusableEmbeddings(
    identities: EmbeddingCacheIdentity[],
  ): Promise<CachedEmbedding[]>;
  saveEmbeddings(embeddings: CachedEmbedding[]): Promise<void>;
}
