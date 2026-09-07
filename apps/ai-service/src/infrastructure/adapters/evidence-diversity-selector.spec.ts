import { ConfigService } from '@nestjs/config';
import { EvidenceDiversitySelector } from './evidence-diversity-selector';
import type { ScoredRerankCandidate } from './hybrid-retrieval-scorer';

describe('EvidenceDiversitySelector', () => {
  const candidate = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'candidate-1',
      reelId: 'reel-1',
      chunkId: typeof overrides.id === 'string' ? overrides.id : 'candidate-1',
      chunkText: 'budget approval evidence',
      retrievalText: 'budget approval evidence',
      evidenceText: 'budget approval evidence',
      title: 'Budget meeting',
      description: 'Budget approval',
      tags: ['budget'],
      score: 0.8,
      vectorScore: 0.8,
      keywordScore: 0.7,
      metadataScore: 0.6,
      accessMetadata: { visibility: 'private' },
      ...overrides,
    }) as never;

  const scored = (
    item: ReturnType<typeof candidate>,
    relevanceScore: number,
  ): ScoredRerankCandidate => ({ candidate: item, relevanceScore });

  it('preserves neural relevance order when diversity does not justify a change', () => {
    const selector = new EvidenceDiversitySelector(
      new ConfigService({ AI_RAG_MMR_LAMBDA: '1' }),
    );
    const result = selector.select(
      [
        scored(candidate({ id: 'high' }), 0.9),
        scored(candidate({ id: 'low', reelId: 'reel-2' }), 0.2),
      ],
      2,
    );
    expect(result.map((item) => item.chunkId)).toEqual(['high', 'low']);
    expect(result[0].rerankScore).toBe(0.9);
  });

  it('uses same-reel penalty to diversify otherwise lower-scoring evidence', () => {
    const selector = new EvidenceDiversitySelector(
      new ConfigService({
        AI_RAG_MMR_LAMBDA: '0.5',
        AI_RAG_MMR_SAME_REEL_PENALTY: '0.9',
        AI_RAG_MMR_TEMPORAL_OVERLAP_PENALTY: '0',
      }),
    );
    const result = selector.select(
      [
        scored(candidate({ id: 'first' }), 0.95),
        scored(candidate({ id: 'same-reel', chunkId: 'chunk-2' }), 0.9),
        scored(
          candidate({
            id: 'other-reel',
            reelId: 'reel-2',
            chunkText: 'unrelated deployment evidence',
            retrievalText: 'unrelated deployment evidence',
            evidenceText: 'unrelated deployment evidence',
          }),
          0.8,
        ),
      ],
      2,
    );
    expect(result.map((item) => item.chunkId)).toEqual([
      'first',
      'other-reel',
    ]);
  });

  it('uses temporal-overlap penalty independently of same-reel penalty', () => {
    const selector = new EvidenceDiversitySelector(
      new ConfigService({
        AI_RAG_MMR_LAMBDA: '0.8',
        AI_RAG_MMR_SAME_REEL_PENALTY: '0',
        AI_RAG_MMR_TEMPORAL_OVERLAP_PENALTY: '1',
      }),
    );
    const result = selector.select(
      [
        scored(candidate({ id: 'first', startTime: 0, endTime: 10 }), 0.95),
        scored(
          candidate({
            id: 'overlap',
            chunkId: 'chunk-2',
            chunkText: 'overlap evidence',
            retrievalText: 'overlap evidence',
            evidenceText: 'overlap evidence',
            title: 'Overlap',
            description: 'Overlap',
            tags: ['overlap'],
            startTime: 5,
            endTime: 15,
          }),
          0.82,
        ),
        scored(
          candidate({
            id: 'separate',
            chunkId: 'chunk-3',
            chunkText: 'deployment notes',
            retrievalText: 'deployment notes',
            evidenceText: 'deployment notes',
            title: 'Unrelated',
            description: 'Deployment',
            tags: ['ops'],
            startTime: 20,
            endTime: 30,
          }),
          0.81,
        ),
      ],
      2,
    );
    expect(result.map((item) => item.chunkId)).toEqual([
      'first',
      'chunk-3',
    ]);
  });

  it('preserves metadata, access metadata, and neural score provenance', () => {
    const selector = new EvidenceDiversitySelector(new ConfigService());
    const result = selector.select(
      [scored(candidate({ id: 'preserved' }), 0.73)],
      1,
    );
    expect(result[0]).toEqual(
      expect.objectContaining({
        chunkId: 'preserved',
        accessMetadata: { visibility: 'private' },
        rerankScore: 0.73,
        vectorScore: 0.8,
        keywordScore: 0.7,
        metadataScore: 0.6,
      }),
    );
  });
});
