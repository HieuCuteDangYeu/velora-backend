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

const segments = (language: string): TranscriptSegment[] => [
  {
    start: 0,
    end: 4,
    text: 'The dog sent a message to the group.',
    textVi: 'Con chó đã gửi tin nhắn vào nhóm.',
    detectedLanguage: language,
    sourceSegmentId: 'transcription:0:0',
  },
  {
    start: 4,
    end: 8,
    text: 'Everyone laughed at the screenshot.',
    textVi: 'Mọi người cười trước ảnh chụp màn hình.',
    detectedLanguage: language,
    sourceSegmentId: 'transcription:0:1',
  },
];

const draftsFor = (source: TranscriptSegment[]) =>
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
    transcriptSegments: source,
  });

const toDocuments = (
  drafts: ReturnType<typeof draftsFor>,
): ReelEvidenceDocument[] =>
  drafts.map((draft) => ({
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

const validate = (documents: ReelEvidenceDocument[], source: unknown[]) =>
  new ValidateEvidenceIndexCandidateUseCase(config).execute({
    job,
    documents,
    transcriptSegments: source as TranscriptSegment[],
  });

describe('bilingual chunk evidence', () => {
  it('appends the Vietnamese translation to chunks of foreign-language audio', () => {
    const chunk = draftsFor(segments('zh')).find(
      (draft) => draft.kind === 'CHUNK',
    );
    expect(chunk?.evidenceText).toContain('The dog sent a message');
    expect(chunk?.evidenceText).toContain(
      ' Vietnamese: Con chó đã gửi tin nhắn vào nhóm. Mọi người cười',
    );
    expect(chunk?.retrievalText).toContain('Vietnamese:');
  });

  it.each(['en', 'vi'])('leaves %s audio chunks unchanged', (language) => {
    const chunk = draftsFor(segments(language)).find(
      (draft) => draft.kind === 'CHUNK',
    );
    expect(chunk?.evidenceText).not.toContain('Vietnamese:');
  });

  it('passes candidate validation with the Vietnamese line', () => {
    const source = segments('zh');
    expect(() =>
      validate(toDocuments(draftsFor(source)), source),
    ).not.toThrow();
  });

  it('rejects a Vietnamese line that the source segments do not support', () => {
    const source = segments('zh');
    const documents = toDocuments(draftsFor(source)).map((document) =>
      document.kind === 'CHUNK'
        ? {
            ...document,
            evidenceText: `${document.evidenceText} bịa đặt`,
            evidenceHash: hash(`${document.evidenceText} bịa đặt`),
          }
        : document,
    );
    expect(() => validate(documents, source)).toThrow(
      /unsupported Vietnamese evidence/,
    );
  });
});
