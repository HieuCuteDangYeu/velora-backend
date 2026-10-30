import { RerankRetrievedEvidenceUseCase } from './rerank-retrieved-evidence.use-case';

describe('RerankRetrievedEvidenceUseCase', () => {
  it('keeps only each Reel’s earliest transcript chunk for first-segment comparisons', async () => {
    const episodeOneLater = {
      chunkId: 'episode-one-later',
      reelId: 'episode-one',
      evidenceType: 'TRANSCRIPT',
      startTime: 42,
    };
    const episodeTwoFirst = {
      chunkId: 'episode-two-first',
      reelId: 'episode-two',
      evidenceType: 'TRANSCRIPT',
      startTime: 0,
    };
    const episodeOneFirst = {
      chunkId: 'episode-one-first',
      reelId: 'episode-one',
      evidenceType: 'TRANSCRIPT',
      startTime: 0.5,
    };
    const retrievalEngine = {
      rerank: jest
        .fn()
        .mockResolvedValue([episodeOneLater, episodeTwoFirst, episodeOneFirst]),
    };
    const useCase = new RerankRetrievedEvidenceUseCase(
      retrievalEngine as never,
    );
    const diagnostics = {} as never;

    const result = await useCase.execute({
      userMessage:
        'Compare the first indexed transcript segments of Episode One and Episode Two. Attribute each statement to its own clip.',
      route: { requiredEvidence: ['TRANSCRIPT'] } as never,
      plan: { requiresReelCoverage: true } as never,
      retrievedChunks: [
        episodeOneLater,
        episodeTwoFirst,
        episodeOneFirst,
      ] as never,
      diagnostics,
    });

    expect(result).toEqual([episodeTwoFirst, episodeOneFirst]);
    expect(diagnostics).toEqual({ retrievedCount: 3, rerankedCount: 2 });
  });

  it('preserves adjacent transcript chunks for other Reel questions', async () => {
    const chunks = [
      {
        chunkId: 'episode-one-first',
        reelId: 'episode-one',
        evidenceType: 'TRANSCRIPT',
        startTime: 0,
      },
      {
        chunkId: 'episode-one-next',
        reelId: 'episode-one',
        evidenceType: 'TRANSCRIPT',
        startTime: 42,
      },
    ];
    const retrievalEngine = {
      rerank: jest.fn().mockResolvedValue(chunks),
    };
    const useCase = new RerankRetrievedEvidenceUseCase(
      retrievalEngine as never,
    );

    await expect(
      useCase.execute({
        userMessage: 'Summarize Episode One.',
        route: { requiredEvidence: ['TRANSCRIPT'] } as never,
        plan: { requiresReelCoverage: false } as never,
        retrievedChunks: chunks as never,
      }),
    ).resolves.toEqual(chunks);
  });

  it('drops adjacent transcript chunks outside an exact requested summary window', async () => {
    const outside = {
      chunkId: 'outside',
      reelId: 'reel-one',
      evidenceType: 'TRANSCRIPT',
      startTime: 0.1,
      endTime: 45.08,
    };
    const overlap = {
      chunkId: 'overlap',
      reelId: 'reel-one',
      evidenceType: 'TRANSCRIPT',
      startTime: 29.78,
      endTime: 74.66,
    };
    const exact = {
      chunkId: 'exact-window',
      reelId: 'reel-one',
      evidenceType: 'TRANSCRIPT',
      startTime: 58.44,
      endTime: 114.753,
    };
    const visual = {
      chunkId: 'sampled-frame',
      reelId: 'reel-one',
      evidenceType: 'VISUAL',
      startTime: 85.6,
      endTime: 85.6,
    };
    const retrievalEngine = {
      rerank: jest.fn().mockResolvedValue([outside, overlap, exact, visual]),
    };
    const useCase = new RerankRetrievedEvidenceUseCase(
      retrievalEngine as never,
    );

    await expect(
      useCase.execute({
        userMessage:
          'For Episode One, describe the sampled frame at 85.6 seconds and summarize the indexed speech segment at 58.44–114.753 seconds. Keep what is visible separate from what is said.',
        route: { requiredEvidence: ['TRANSCRIPT', 'VISUAL'] } as never,
        plan: {
          requiresReelCoverage: false,
          transcriptTimestampSec: 58.44,
          transcriptTimestampEndSec: 114.753,
        } as never,
        retrievedChunks: [outside, overlap, exact, visual] as never,
      }),
    ).resolves.toEqual([exact, visual]);
  });
});
