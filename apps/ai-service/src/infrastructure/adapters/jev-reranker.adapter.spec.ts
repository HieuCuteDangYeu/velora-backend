import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EvidenceDiversitySelector } from './evidence-diversity-selector';
import { HybridRetrievalScorer } from './hybrid-retrieval-scorer';
import { JevRerankerAdapter } from './jev-reranker.adapter';
import { SimpleRerankerAdapter } from './simple-reranker.adapter';

describe('JevRerankerAdapter', () => {
  const candidate = (id: string) =>
    ({
      id,
      reelId: 'reel-1',
      chunkId: id,
      chunkText: `${id} evidence`,
      retrievalText: `${id} evidence`,
      evidenceText: `${id} evidence`,
      title: 'title',
      description: 'description',
      tags: [],
      score: 0.5,
      vectorScore: 0.5,
      keywordScore: 0,
      metadataScore: 0,
    }) as never;

  const config = (values: Record<string, string> = {}) =>
    new ConfigService({
      JEV_RERANKER_BASE_URL: 'http://jev:8765',
      AI_RAG_NEURAL_RERANK_ENABLED: 'true',
      ...values,
    });

  const fallback = () => {
    return new SimpleRerankerAdapter(new ConfigService());
  };

  afterEach(() => jest.restoreAllMocks());

  it('sends one local System One request and maps noul scores to candidates', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-local',
          answers: {
            candidate_0: { type: 'noul', noul: 0.2 },
            candidate_1: { type: 'noul', noul: 0.9 },
          },
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
        { status: 200 },
      ),
    );
    const adapter = new JevRerankerAdapter(
      config(),
      fallback(),
      new EvidenceDiversitySelector(new ConfigService()),
    );

    await expect(
      adapter.rerank({
        queryText: 'query',
        candidates: [candidate('a'), candidate('b')],
        limit: 2,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'b', rerankScore: 0.9 }),
      expect.objectContaining({ id: 'a', rerankScore: 0.2 }),
    ]);

    expect(fetch).toHaveBeenCalledWith(
      'http://jev:8765/v1/systemone',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(fetch.mock.calls[0][1]).not.toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.anything() }),
      }),
    );
  });

  it('falls back to the existing TEI adapter when the local service is unavailable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    const adapter = new JevRerankerAdapter(config(), fallback());

    await expect(
      adapter.rerank({
        queryText: 'query',
        candidates: [candidate('a'), candidate('b')],
        limit: 1,
      }),
    ).resolves.toHaveLength(1);
  });

  it('does not use the local service for a single candidate', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const adapter = new JevRerankerAdapter(config(), fallback());

    await adapter.rerank({
      queryText: 'query',
      candidates: [candidate('a')],
      limit: 1,
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('can be constructed through Nest dependency injection', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ConfigService,
        EvidenceDiversitySelector,
        HybridRetrievalScorer,
        SimpleRerankerAdapter,
        JevRerankerAdapter,
      ],
    }).compile();

    expect(module.get(JevRerankerAdapter)).toBeInstanceOf(JevRerankerAdapter);
    await module.close();
  });
});
