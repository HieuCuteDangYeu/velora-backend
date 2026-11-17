import type { IAiEmbeddingService } from '@content/application/use-cases/ai-embedding.service.interface';
import type { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import { SemanticRecommendationServiceAdapter } from './semantic-recommendation-service.adapter';

describe('SemanticRecommendationServiceAdapter', () => {
  it('forwards embedding identity and caps the semantic result limit at 100', async () => {
    const generateEmbedding: jest.MockedFunction<
      IAiEmbeddingService['generateEmbedding']
    > = jest.fn().mockResolvedValue({
      values: [0.1, 0.2],
      model: 'BAAI/bge-m3',
      dimensions: 2,
      provider: 'test',
      version: 'bge-m3-tei-v1',
    });
    const embeddingService: IAiEmbeddingService = { generateEmbedding };
    const send = jest.fn().mockReturnValue(
      of([
        {
          id: 'doc-1',
          reelId: 'reel-1',
          ordinal: 0,
          userId: 'creator-1',
          text: 'typescript backend',
          retrievalText: 'typescript backend',
          evidenceType: 'METADATA',
          tags: ['typescript'],
          sourceDurationMs: 10_000,
          sourceOrientation: 'PORTRAIT',
          sourceLengthClass: 'SHORT',
          rrfScore: 0.2,
          vectorDistance: 0.1,
        },
      ]),
    );
    const indexClient = { send } as unknown as ClientProxy;
    const adapter = new SemanticRecommendationServiceAdapter(
      embeddingService,
      indexClient,
    );

    const result = await adapter.findCandidates({
      viewerId: 'viewer-1',
      interestTags: ['TypeScript', 'Backend'],
      limit: 300,
    });

    expect(send).toHaveBeenCalledWith(
      'index.search_reels',
      expect.objectContaining({
        queryText: 'typescript backend',
        queryEmbedding: [0.1, 0.2],
        queryEmbeddingModel: 'BAAI/bge-m3',
        queryEmbeddingVersion: 'bge-m3-tei-v1',
        limit: 100,
        candidateLimit: 400,
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        reelId: 'reel-1',
        source: 'SEMANTIC',
      }),
    ]);
  });

  it('falls back to keyword/tag hybrid retrieval if embedding identity is incomplete', async () => {
    const generateEmbedding: jest.MockedFunction<
      IAiEmbeddingService['generateEmbedding']
    > = jest.fn().mockResolvedValue({
      values: [0.1, 0.2],
      model: 'BAAI/bge-m3',
      dimensions: 2,
    });
    const embeddingService: IAiEmbeddingService = { generateEmbedding };
    const send = jest.fn().mockReturnValue(of([]));
    const indexClient = { send } as unknown as ClientProxy;
    const adapter = new SemanticRecommendationServiceAdapter(
      embeddingService,
      indexClient,
    );

    await adapter.findCandidates({
      viewerId: 'viewer-1',
      interestTags: ['typescript'],
      limit: 20,
    });

    expect(send).toHaveBeenCalledWith(
      'index.search_reels',
      expect.not.objectContaining({
        queryEmbedding: expect.anything(),
      }),
    );
  });
  describe('query embedding reuse', () => {
    const embedding = {
      values: [0.1, 0.2],
      model: 'BAAI/bge-m3',
      dimensions: 2,
      provider: 'test',
      version: 'bge-m3-tei-v1',
    };
    const build = (generateEmbedding: jest.Mock) =>
      new SemanticRecommendationServiceAdapter({ generateEmbedding }, {
        send: jest.fn().mockReturnValue(of([])),
      } as unknown as ClientProxy);
    const input = {
      viewerId: 'viewer-1',
      interestTags: ['cooking'],
      limit: 20,
    };

    afterEach(() => {
      jest.useRealTimers();
    });

    it('embeds the same interest tags once for a burst of sessions', async () => {
      const generateEmbedding = jest.fn().mockResolvedValue(embedding);
      const adapter = build(generateEmbedding);

      await Promise.all([
        adapter.findCandidates(input),
        adapter.findCandidates({ ...input, viewerId: 'viewer-2' }),
      ]);
      await adapter.findCandidates(input);

      expect(generateEmbedding).toHaveBeenCalledTimes(1);
    });

    it('does not remember a failed embedding', async () => {
      const generateEmbedding = jest
        .fn()
        .mockRejectedValueOnce(new Error('TEI overloaded'))
        .mockResolvedValue(embedding);
      const adapter = build(generateEmbedding);

      await expect(adapter.findCandidates(input)).resolves.toEqual([]);
      await adapter.findCandidates(input);

      expect(generateEmbedding).toHaveBeenCalledTimes(2);
    });

    it('stops waiting for a slow embedding after 2.5 s but keeps its result for the next session', async () => {
      jest.useFakeTimers();
      let finish!: (value: typeof embedding) => void;
      const generateEmbedding = jest.fn().mockReturnValue(
        new Promise<typeof embedding>((resolve) => {
          finish = resolve;
        }),
      );
      const adapter = build(generateEmbedding);

      const first = adapter.findCandidates(input);
      await jest.advanceTimersByTimeAsync(2_600);
      await expect(first).resolves.toEqual([]);

      finish(embedding);
      await jest.advanceTimersByTimeAsync(0);
      await adapter.findCandidates(input);

      expect(generateEmbedding).toHaveBeenCalledTimes(1);
    });
  });
});
