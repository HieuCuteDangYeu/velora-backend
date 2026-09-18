import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';

export interface CompleteReelIndexCommand {
  reelId: string;
  indexAttemptId: string;
  indexVersion: string;
  reelDocumentCount: number;
  sectionCount: number;
  chunkCount: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  indexedAt: string;
  transcript?: string;
  transcriptSegments?: TranscriptSegment[];
}
