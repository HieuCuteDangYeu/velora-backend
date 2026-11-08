import { RerankRetrievedEvidenceUseCase } from './rerank-retrieved-evidence.use-case';

describe('RerankRetrievedEvidenceUseCase', () => {
  it('uses the exact transcript window and excludes overlapping outside text', async () => {
    const exactWindow = {
      chunkId: 'exact-window',
      reelId: 'reel-1',
      evidenceType: 'TRANSCRIPT',
      startTime: 8,
      endTime: 63.9,
    };
    const continuation = {
      chunkId: 'continuation',
      reelId: 'reel-1',
      evidenceType: 'TRANSCRIPT',
      startTime: 32.48,
      endTime: 91.34,
    };
    const outsideWindow = {
      chunkId: 'outside-window',
      reelId: 'reel-1',
      evidenceType: 'TRANSCRIPT',
      startTime: 70,
      endTime: 100,
    };
    const diagnostics = {};
    const useCase = new RerankRetrievedEvidenceUseCase({
      rerank: jest
        .fn()
        .mockResolvedValue([continuation, outsideWindow, exactWindow]),
    } as never);

    const result = await useCase.execute({
      userMessage:
        'Summarize what is said in the indexed transcript segment spanning 8–63.9 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'SHARED_REEL',
        needsRetrieval: true,
        needsUserMemory: false,
        needsConversationSummary: false,
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        transcriptRequestKind: 'NONE',
        requiredEvidence: ['TRANSCRIPT'],
        recommendationAction: { type: 'NONE', reason: 'No recommendation.' },
        reason: 'Transcript summary request.',
      },
      plan: {
        mode: 'REEL_HYBRID',
        sourceOrder: 'ASC',
        sourceTimestampSec: 8,
        sourceTimestampEndSec: 63.9,
        transcriptTimestampSec: 8,
        transcriptTimestampEndSec: 63.9,
        requiresReelCoverage: false,
        query: 'summarize transcript segment',
        queries: ['summarize transcript segment'],
        searchLimit: 4,
        rerankLimit: 4,
        shouldRerank: false,
        reason: 'Read the requested transcript window.',
      },
      retrievedChunks: [continuation, outsideWindow, exactWindow] as never,
      diagnostics: diagnostics as never,
    });

    expect(result.map((chunk) => chunk.chunkId)).toEqual([
      'exact-window',
    ]);
    expect(diagnostics).toMatchObject({ rerankedCount: 1 });
  });

  it('uses only fully contained transcript chunks when no exact window exists', async () => {
    const before = {
      chunkId: 'before',
      reelId: 'reel-1',
      evidenceType: 'TRANSCRIPT',
      startTime: 0,
      endTime: 15,
    };
    const inside = {
      chunkId: 'inside',
      reelId: 'reel-1',
      evidenceType: 'TRANSCRIPT',
      startTime: 12,
      endTime: 18,
    };
    const after = {
      chunkId: 'after',
      reelId: 'reel-1',
      evidenceType: 'TRANSCRIPT',
      startTime: 18,
      endTime: 30,
    };
    const metadata = {
      chunkId: 'metadata',
      reelId: 'reel-1',
      evidenceType: 'METADATA',
    };
    const useCase = new RerankRetrievedEvidenceUseCase({
      rerank: jest.fn().mockResolvedValue([before, inside, after, metadata]),
    } as never);

    const result = await useCase.execute({
      userMessage:
        'Summarize what is said in the indexed transcript segment spanning 10–20 seconds.',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'SHARED_REEL',
        needsRetrieval: true,
        needsUserMemory: false,
        needsConversationSummary: false,
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        transcriptRequestKind: 'NONE',
        requiredEvidence: ['TRANSCRIPT'],
        recommendationAction: { type: 'NONE', reason: 'No recommendation.' },
        reason: 'Transcript summary request.',
      },
      plan: {
        mode: 'REEL_HYBRID',
        sourceOrder: 'ASC',
        sourceTimestampSec: 10,
        sourceTimestampEndSec: 20,
        transcriptTimestampSec: 10,
        transcriptTimestampEndSec: 20,
        requiresReelCoverage: false,
        query: 'summarize transcript segment',
        queries: ['summarize transcript segment'],
        searchLimit: 2,
        rerankLimit: 2,
        shouldRerank: false,
        reason: 'Read the requested transcript window.',
      },
      retrievedChunks: [before, inside, after, metadata] as never,
    });

    expect(result.map((chunk) => chunk.chunkId)).toEqual(['inside', 'metadata']);
  });
});
