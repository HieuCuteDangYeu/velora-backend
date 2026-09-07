import { ConfigService } from '@nestjs/config';
import { SimpleRerankerAdapter } from './simple-reranker.adapter';

describe('SimpleRerankerAdapter', () => {
  it('provides deterministic fallback ranking while preserving provenance metadata', async () => {
    const adapter = new SimpleRerankerAdapter(new ConfigService());
    const result = await adapter.rerank({
      queryText: 'budget approval',
      candidates: [
        {
          id: 'budget',
          reelId: 'reel-1',
          chunkId: 'chunk-1',
          chunkText: 'The budget approval was recorded.',
          retrievalText: 'The budget approval was recorded.',
          evidenceText: 'The budget approval was recorded.',
          title: 'Budget',
          description: 'Approval',
          tags: ['finance'],
          score: 0.8,
          vectorScore: 0.8,
          keywordScore: 0.7,
          metadataScore: 0.6,
          accessMetadata: { visibility: 'private' },
        } as never,
        {
          id: 'unrelated',
          reelId: 'reel-2',
          chunkId: 'chunk-2',
          chunkText: 'The deployment completed successfully.',
          retrievalText: 'The deployment completed successfully.',
          evidenceText: 'The deployment completed successfully.',
          title: 'Deployment',
          description: 'Release',
          tags: ['ops'],
          score: 0.2,
          vectorScore: 0.2,
          keywordScore: 0.1,
          metadataScore: 0.1,
          accessMetadata: { visibility: 'private' },
        } as never,
      ],
      limit: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: 'budget',
        accessMetadata: { visibility: 'private' },
        rerankScore: expect.any(Number),
      }),
    );
  });
});
