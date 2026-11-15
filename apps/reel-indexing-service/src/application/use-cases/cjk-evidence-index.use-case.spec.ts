import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { ReelEvidenceDocument } from '@common/processing/interfaces/reel-index-document.interface';
import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { createHash } from 'crypto';
import { BuildHierarchicalIndexUseCase } from './build-hierarchical-index.use-case';
import { BuildLongEvidenceChunksUseCase } from './build-long-evidence-chunks.use-case';
import { BuildShortEvidenceChunksUseCase } from './build-short-evidence-chunks.use-case';
import { ValidateEvidenceIndexCandidateUseCase } from './validate-evidence-index-candidate.use-case';

const config: IIndexingApplicationConfig = {
  get: <T = string>(key: string) =>
    (
      ({
        INDEX_SHORT_CHUNK_MAX_TOKENS: '50',
        INDEX_SHORT_CHUNK_TARGET_TOKENS: '40',
        INDEX_SHORT_CHUNK_MIN_TOKENS: '3',
        INDEX_SHORT_CHUNK_OVERLAP_TOKENS: '0',
      }) as Record<string, string>
    )[key] as T | undefined,
  transcriptionIdentity: () => ({
    provider: 'groq',
    model: 'whisper',
    version: 'v1',
  }),
  embeddingIdentity: () => ({
    model: 'BAAI/bge-m3',
    dimensions: 1024,
    version: 'bge-m3-tei-v1',
  }),
};

const job = {
  reelId: 'reel-1',
  sourceLengthClass: 'SHORT',
  sourceDurationMs: 10_000,
} as ReelIndexJob;

const hash = (value: string) =>
  createHash('sha256').update(value.normalize('NFKC')).digest('hex');

// Whisper returns one token per word or character, so the chunker sees
// "我 走 叔 叔" and joins it with spaces.
const segments: TranscriptSegment[] = [
  '我',
  '走',
  '叔',
  '叔',
  '请',
  '不',
  '吝',
].map((text, index) => ({
  start: index,
  end: index + 1,
  text,
  sourceSegmentId: `transcription:0:${index}`,
}));

const drafts = () =>
  new BuildHierarchicalIndexUseCase(
    config,
    new BuildShortEvidenceChunksUseCase(config),
    new BuildLongEvidenceChunksUseCase(config),
    {} as never,
    {} as never,
  ).buildDocumentDrafts({
    job,
    metadata: { title: 'Pet Chat Group', tags: [] },
    sections: [],
    transcriptSegments: segments,
  });

const toDocuments = (): ReelEvidenceDocument[] =>
  drafts().map((draft) => ({
    ...draft,
    sectioningVersion: '1',
    chunkingVersion: '1',
    summaryVersion: '1',
    transcriptVersion: '1',
    indexVersion: '1',
    embeddingProvider: 'self-hosted-tei',
    embeddingModel: 'BAAI/bge-m3',
    embeddingDimensions: 1024,
    embeddingVersion: 'bge-m3-tei-v1',
    embeddingInputHash: 'input',
    embedding: Array(1024).fill(0.1),
    tokenCount: 1,
    evidenceHash: draft.evidenceText
      ? hash(draft.evidenceText)
      : draft.evidenceHash,
    retrievalHash: hash(draft.retrievalText),
  }));

describe('Chinese chunk evidence', () => {
  it('is stored without spaces between characters', () => {
    const chunk = drafts().find((draft) => draft.kind === 'CHUNK');
    expect(chunk?.evidenceText).toBe('我走叔叔请不吝');
    expect(chunk?.retrievalText).toContain('我走叔叔请不吝');
  });

  it('still validates against the spaced source segments', () => {
    expect(() =>
      new ValidateEvidenceIndexCandidateUseCase(config).execute({
        job,
        documents: toDocuments(),
        transcriptSegments: segments,
      }),
    ).not.toThrow();
  });
});
