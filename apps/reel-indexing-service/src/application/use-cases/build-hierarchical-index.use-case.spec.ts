import type { ExtractedReelMetadata } from '@common/ai/interfaces/reel-metadata-extraction.interface';
import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { BuildHierarchicalIndexUseCase } from './build-hierarchical-index.use-case';

const job: ReelIndexJob = {
  jobId: 'job-1',
  reelId: 'reel-1',
  userId: 'user-1',
  mediaAttemptId: 'media-1',
  indexAttemptId: 'attempt-1',
  indexVersion: 'index-v1',
  mediaKey: 'reels/reel-1/source.mp4',
  sourceDurationMs: 30_000,
  sourceOrientation: 'PORTRAIT',
  sourceLengthClass: 'SHORT',
  tags: [],
  createdAt: new Date(0).toISOString(),
  schemaVersion: 1,
};

const metadata: ExtractedReelMetadata = {
  title: 'Embedding cache identity',
  tags: [],
};

const buildUseCase = (input: {
  provider: string;
  model: string;
  dimensions: number;
  version: string;
}) => {
  const config: IIndexingApplicationConfig = {
    get: <T = string>(key: string) =>
      (key === 'INDEX_EMBEDDING_PROVIDER' ? input.provider : undefined) as
        | T
        | undefined,
    transcriptionIdentity: () => ({
      provider: 'cloudflare-workers-ai',
      model: 'transcription-model',
      version: 'v1',
    }),
    embeddingIdentity: () => ({
      model: input.model,
      dimensions: input.dimensions,
      version: input.version,
    }),
  };
  return new BuildHierarchicalIndexUseCase(
    config,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
};

describe('BuildHierarchicalIndexUseCase embedding cache identity', () => {
  it('does not reuse a Gemini 384 cache key for BGE-M3 1024', () => {
    const bgeDraft = buildUseCase({
      provider: 'cloudflare-workers-ai',
      model: '@cf/baai/bge-m3',
      dimensions: 1024,
      version: 'cf-bge-m3-v1',
    }).buildDocumentDrafts({ job, metadata, sections: [] })[0];
    const legacyDraft = buildUseCase({
      provider: 'google',
      model: 'gemini-embedding-001',
      dimensions: 384,
      version: '1',
    }).buildDocumentDrafts({ job, metadata, sections: [] })[0];

    expect(bgeDraft).toMatchObject({
      embeddingProvider: 'cloudflare-workers-ai',
      embeddingModel: '@cf/baai/bge-m3',
      embeddingDimensions: 1024,
      embeddingVersion: 'cf-bge-m3-v1',
    });
    expect(bgeDraft.embeddingInputHash).toBe(legacyDraft.embeddingInputHash);
    expect(bgeDraft.cacheKey).not.toBe(legacyDraft.cacheKey);
  });

  it('indexes visual captions, OCR and objects as one typed sampled-frame source', () => {
    const drafts = buildUseCase({
      provider: 'cloudflare-workers-ai',
      model: '@cf/baai/bge-m3',
      dimensions: 1024,
      version: 'cf-bge-m3-v1',
    }).buildDocumentDrafts({
      job,
      metadata,
      sections: [],
      visualScenes: [
        {
          frameKey: 'frame.jpg',
          frameChecksum: 'checksum',
          timestampMs: 12_500,
          reason: 'PERIODIC',
          caption: 'A blue device is visible.',
          ocrText: 'VLR-9281',
          objects: ['device', 'screen'],
          provider: 'vision',
          model: 'vision-model',
          version: 'v1',
        },
      ],
    });
    expect(drafts).toContainEqual(
      expect.objectContaining({
        id: 'reel:reel-1:visual:0',
        evidenceText: expect.stringContaining('VLR-9281'),
        retrievalText: expect.stringContaining('blue device'),
        startTime: 12.5,
        endTime: 12.5,
      }),
    );
  });
});
