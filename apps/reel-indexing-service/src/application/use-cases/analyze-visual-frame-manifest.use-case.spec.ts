import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { IIndexingAiService } from '@indexing/domain/interfaces/ai-service.interface';
import type { IArtifactStorage } from '@indexing/domain/interfaces/artifact-storage.interface';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { AnalyzeVisualFrameManifestUseCase } from './analyze-visual-frame-manifest.use-case';

describe('AnalyzeVisualFrameManifestUseCase', () => {
  it('requests checksum-verified bytes and passes raw bytes to the AI domain port', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const configValues: Record<string, string> = {
      INDEX_VISUAL_ANALYSIS_ENABLED: 'true',
      INDEX_VISUAL_ANALYSIS_REQUIRED: 'false',
      INDEX_VISUAL_ANALYSIS_CONCURRENCY: '2',
    };
    const config: IIndexingApplicationConfig = {
      get: <T = string>(key: string) => configValues[key] as T | undefined,
      transcriptionIdentity: () => ({
        provider: 'cloudflare-workers-ai',
        model: 'transcription-model',
        version: 'v1',
      }),
      embeddingIdentity: () => ({
        model: '@cf/baai/bge-m3',
        dimensions: 1024,
        version: 'cf-bge-m3-v1',
      }),
    };
    const storage = {
      artifactExists: jest.fn().mockResolvedValue(true),
      getVisualFrameManifest: jest.fn().mockResolvedValue({
        reelId: 'reel-1',
        mediaAttemptId: 'media-attempt-1',
        totalDurationMs: 10_000,
        sampling: {
          periodicIntervalMs: 4_000,
          sceneThreshold: 0.35,
          dedupeWindowMs: 750,
          maxFrames: 24,
        },
        artifacts: [
          {
            key: 'reels/reel-1/visual/frame.jpg',
            timestampMs: 4_000,
            checksum: 'abc123',
            byteLength: 4,
            reason: 'PERIODIC',
          },
        ],
        version: 1,
      }),
      getVerifiedArtifactBytes: jest.fn().mockResolvedValue(bytes),
    } as unknown as jest.Mocked<IArtifactStorage>;
    const ai = {
      analyzeVisualFrame: jest.fn().mockResolvedValue({
        caption: 'A laptop screen',
        ocrText: 'VLR-9281',
        objects: ['laptop'],
        provider: 'cloudflare',
        model: 'vision-model',
        version: '1',
      }),
    } as unknown as jest.Mocked<IIndexingAiService>;
    const useCase = new AnalyzeVisualFrameManifestUseCase(config, storage, ai);
    const job = {
      reelId: 'reel-1',
      mediaAttemptId: 'media-attempt-1',
      mediaKey: 'reels/reel-1/source.mp4',
      visualFrameManifestKey: 'reels/reel-1/visual/manifest.json',
    } as ReelIndexJob;

    await expect(useCase.execute(job)).resolves.toEqual([
      expect.objectContaining({
        frameKey: 'reels/reel-1/visual/frame.jpg',
        timestampMs: 4_000,
        caption: 'A laptop screen',
        ocrText: 'VLR-9281',
      }),
    ]);

    expect(storage.getVerifiedArtifactBytes).toHaveBeenCalledWith({
      key: 'reels/reel-1/visual/frame.jpg',
      sha256: 'abc123',
    });
    expect(ai.analyzeVisualFrame).toHaveBeenCalledWith({
      imageBytes: bytes,
      mimeType: 'image/jpeg',
      timestampMs: 4_000,
    });
  });

  it('stops a required visual batch after a provider quota response', async () => {
    const configValues: Record<string, string> = {
      INDEX_VISUAL_ANALYSIS_ENABLED: 'true',
      INDEX_VISUAL_ANALYSIS_REQUIRED: 'true',
      INDEX_VISUAL_ANALYSIS_CONCURRENCY: '1',
    };
    const config: IIndexingApplicationConfig = {
      get: <T = string>(key: string) => configValues[key] as T | undefined,
      transcriptionIdentity: () => ({
        provider: 'cloudflare-workers-ai',
        model: 'transcription-model',
        version: 'v1',
      }),
      embeddingIdentity: () => ({
        model: '@cf/baai/bge-m3',
        dimensions: 1024,
        version: 'cf-bge-m3-v1',
      }),
    };
    const storage = {
      artifactExists: jest.fn().mockResolvedValue(true),
      getVisualFrameManifest: jest.fn().mockResolvedValue({
        reelId: 'reel-1',
        mediaAttemptId: 'media-attempt-1',
        totalDurationMs: 12_000,
        sampling: {
          periodicIntervalMs: 4_000,
          sceneThreshold: 0.35,
          dedupeWindowMs: 750,
          maxFrames: 24,
        },
        artifacts: [0, 4_000, 8_000].map((timestampMs) => ({
          key: `reels/reel-1/visual/${timestampMs}.jpg`,
          timestampMs,
          checksum: `checksum-${timestampMs}`,
          byteLength: 4,
          reason: 'PERIODIC',
        })),
        version: 1,
      }),
      getVerifiedArtifactBytes: jest
        .fn()
        .mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
    } as unknown as jest.Mocked<IArtifactStorage>;
    const ai = {
      analyzeVisualFrame: jest
        .fn()
        .mockRejectedValue(
          new Error(
            'Cloudflare Workers AI vision request failed with status 429: daily free allocation exhausted',
          ),
        ),
    } as unknown as jest.Mocked<IIndexingAiService>;
    const useCase = new AnalyzeVisualFrameManifestUseCase(config, storage, ai);

    await expect(
      useCase.execute({
        reelId: 'reel-1',
        mediaAttemptId: 'media-attempt-1',
        mediaKey: 'reels/reel-1/source.mp4',
        visualFrameManifestKey: 'reels/reel-1/visual/manifest.json',
        requireVisualAnalysis: true,
      } as ReelIndexJob),
    ).rejects.toThrow(/quota exhausted/);

    expect(ai.analyzeVisualFrame).toHaveBeenCalledTimes(1);
  });

  describe('analysis cache by frame content hash', () => {
    const SHA = 'a'.repeat(64);
    const cacheKey = `reel-indexing/visual-analysis-cache/v1/${SHA}.json`;
    const analysis = {
      caption: 'A laptop screen',
      ocrText: 'VLR-9281',
      objects: ['laptop'],
      provider: 'cloudflare',
      model: 'vision-model',
      version: '1',
    };
    const build = (
      cached: Uint8Array | 'missing' | 'throws',
      configOverrides: Record<string, string> = {},
    ) => {
      const configValues: Record<string, string> = {
        INDEX_VISUAL_ANALYSIS_ENABLED: 'true',
        INDEX_VISUAL_ANALYSIS_REQUIRED: 'false',
        INDEX_VISUAL_ANALYSIS_CONCURRENCY: '1',
        ...configOverrides,
      };
      const config = {
        get: <T = string>(key: string) => configValues[key] as T | undefined,
      } as unknown as IIndexingApplicationConfig;
      const storage = {
        artifactExists: jest.fn((key: string) =>
          Promise.resolve(key === cacheKey ? cached !== 'missing' : true),
        ),
        getVisualFrameManifest: jest.fn().mockResolvedValue({
          reelId: 'reel-1',
          mediaAttemptId: 'media-attempt-1',
          totalDurationMs: 10_000,
          sampling: {},
          artifacts: [
            {
              key: 'reels/reel-1/visual/frame.jpg',
              timestampMs: 4_000,
              checksum: SHA,
              byteLength: 4,
              reason: 'PERIODIC',
            },
          ],
          version: 1,
        }),
        getArtifactBytes: jest.fn(() =>
          cached === 'throws'
            ? Promise.reject(new Error('r2 down'))
            : Promise.resolve(cached as Uint8Array),
        ),
        getVerifiedArtifactBytes: jest
          .fn()
          .mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
        putVerifiedArtifact: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<IArtifactStorage>;
      const ai = {
        analyzeVisualFrame: jest.fn().mockResolvedValue(analysis),
      } as unknown as jest.Mocked<IIndexingAiService>;
      return {
        useCase: new AnalyzeVisualFrameManifestUseCase(config, storage, ai),
        storage,
        ai,
      };
    };
    const job = {
      reelId: 'reel-1',
      mediaAttemptId: 'media-attempt-1',
      mediaKey: 'reels/reel-1/source.mp4',
      visualFrameManifestKey: 'reels/reel-1/visual/manifest.json',
    } as ReelIndexJob;
    const encode = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value));

    it('reuses a stored analysis and neither downloads the frame nor calls the vision model', async () => {
      const { useCase, storage, ai } = build(encode(analysis));
      await expect(useCase.execute(job)).resolves.toEqual([
        expect.objectContaining({
          caption: 'A laptop screen',
          ocrText: 'VLR-9281',
        }),
      ]);
      expect(ai.analyzeVisualFrame).not.toHaveBeenCalled();
      expect(storage.getVerifiedArtifactBytes).not.toHaveBeenCalled();
      expect(storage.putVerifiedArtifact).not.toHaveBeenCalled();
    });

    it('analyses a new frame once and stores the result under its content hash', async () => {
      const { useCase, storage, ai } = build('missing');
      await useCase.execute(job);
      expect(ai.analyzeVisualFrame).toHaveBeenCalledTimes(1);
      expect(storage.putVerifiedArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ key: cacheKey }),
      );
    });

    it.each([
      ['a corrupt entry', new TextEncoder().encode('{not json')],
      ['an entry with no caption', encode({ ...analysis, caption: '' })],
    ])('treats %s as a miss', async (_label, bytes) => {
      const { useCase, ai } = build(bytes);
      await useCase.execute(job);
      expect(ai.analyzeVisualFrame).toHaveBeenCalledTimes(1);
    });

    it('never fails indexing because the cache cannot be read or written', async () => {
      const { useCase, storage, ai } = build('throws');
      storage.putVerifiedArtifact.mockRejectedValue(new Error('r2 down'));
      await expect(useCase.execute(job)).resolves.toHaveLength(1);
      expect(ai.analyzeVisualFrame).toHaveBeenCalledTimes(1);
    });

    it('can be switched off, and a changed cache version starts a new namespace', async () => {
      const off = build(encode(analysis), {
        INDEX_VISUAL_CACHE_ENABLED: 'false',
      });
      await off.useCase.execute(job);
      expect(off.ai.analyzeVisualFrame).toHaveBeenCalledTimes(1);
      expect(off.storage.putVerifiedArtifact).not.toHaveBeenCalled();

      const v2 = build('missing', { INDEX_VISUAL_CACHE_VERSION: 'v2' });
      await v2.useCase.execute(job);
      expect(v2.storage.putVerifiedArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          key: `reel-indexing/visual-analysis-cache/v2/${SHA}.json`,
        }),
      );
    });
  });
});
